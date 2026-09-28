/**
 * Tests de l'analyse exposure — fonctions pures uniquement (aucune donnée réelle).
 *
 * Couvre : score composite (formule, vetos, pénalité walk-forward), drawdown
 * additif winsorisé, épisodes de drawdown, disjoncteur d'exposition
 * (déclenchement, délai de détection, faux positifs, mode halve),
 * corrélations roulantes.
 */
import { describe, it, expect } from "vitest";
import {
  maxDDUnitsW,
  profitFactorW,
  chronoRets,
  compositeScore,
  compositeScoreFromRets,
  drawdownEpisodes,
  runCircuitBreaker,
  rollingCorrelation,
  commonMintSeries,
  BREAKER_PRIMARY,
  LAMBDA_DD,
  LAMBDA_SIGMA,
  type HTrade,
} from "../lab/backtest/run-hedge-exposure.ts";

function mkTrade(over: Partial<HTrade> = {}): HTrade {
  return {
    mint: "m" + Math.random().toString(36).slice(2),
    entryAt: "2026-09-27T12:00:00.000Z",
    exitAt: "2026-09-27T13:00:00.000Z",
    entryDay: "2026-09-27",
    ret: 0,
    grossRet: 0,
    bars: 3,
    exit: "time-stop",
    entryLiq: 50_000,
    chase: null,
    vertical: false,
    regime: "normal",
    ageIdx: 4,
    mfe: 0.1,
    mae: -0.05,
    ...over,
  };
}

function seqTrades(rets: number[], startHour = 0): HTrade[] {
  return rets.map((ret, i) =>
    mkTrade({
      mint: `t${i}`,
      entryAt: `2026-09-27T${String(startHour + i).padStart(2, "0")}:00:00.000Z`,
      exitAt: `2026-09-27T${String(startHour + i).padStart(2, "0")}:30:00.000Z`,
      ret,
    }),
  );
}

describe("maxDDUnitsW", () => {
  it("calcule le drawdown additif sur rendements winsorisés", () => {
    // eq: 0.1 → -0.2 → -0.5 ; peak 0.1 ; DD = 0.6
    expect(maxDDUnitsW([0.1, -0.3, -0.3])).toBeCloseTo(0.6, 10);
    expect(maxDDUnitsW([0.1, 0.2, 0.3])).toBe(0);
  });
});

describe("profitFactorW", () => {
  it("gains / pertes sur winsorisés", () => {
    expect(profitFactorW([0.1, 0.2, -0.1, -0.05])).toBeCloseTo(0.3 / 0.15, 10);
    expect(profitFactorW([0.1, 0.2])).toBe(Infinity);
    expect(profitFactorW([])).toBe(null);
  });
});

describe("chronoRets", () => {
  it("trie par entryAt", () => {
    const ts = seqTrades([0.3, 0.1, 0.2]);
    // seqTrades génère déjà en ordre chronologique ; on mélange
    const mixed = [ts[2]!, ts[0]!, ts[1]!];
    expect(chronoRets(mixed)).toEqual([0.3, 0.1, 0.2]);
  });
});

describe("compositeScore", () => {
  it("formule additive : le risque dégrade toujours le score", () => {
    // Même moyenne (0,005), DD différents → plus petit DD = meilleur score
    const low = compositeScoreFromRets("A", [0.02, -0.01, 0.02, -0.01, 0.02, -0.01], 10);
    const high = compositeScoreFromRets("B", [0.1, -0.09, 0.1, -0.09, 0.1, -0.09], 10);
    expect(low.Ew).toBeCloseTo(high.Ew as number, 10); // même moyenne
    expect((low.DD as number)).toBeLessThan(high.DD as number);
    expect((low.score as number)).toBeGreaterThan(high.score as number);
  });
  it("vetos : PF_w < 1 ou médiane < 0 → non actionnable", () => {
    const s = compositeScore("X", seqTrades([0.05, -0.06, 0.05, -0.06, 0.05, -0.06]), 10);
    expect(s.actionable).toBe(false);
    expect(s.vetoPF || s.vetoMedian).toBe(true);
  });
  it("série gagnante stable → actionnable", () => {
    const rets = Array.from({ length: 40 }, (_, i) => (i % 4 === 3 ? -0.01 : 0.03));
    const s = compositeScore("Y", seqTrades(rets), 10);
    expect(s.actionable).toBe(true);
    expect(s.score as number).toBeGreaterThan(0);
  });
  it("pénalité walk-forward : instabilité → P_oos < 1", () => {
    // Première moitié gagnante, seconde perdante → instabilité élevée
    const rets = [...Array(30).fill(0.05), ...Array(30).fill(-0.06)];
    const s = compositeScore("Z", seqTrades(rets), 10);
    expect(s.instability as number).toBeGreaterThan(0.5);
    expect(s.pOos as number).toBeLessThan(1);
  });
  it("n < 30 → non concluant", () => {
    const s = compositeScore("W", seqTrades([0.01, 0.02]), 10);
    expect(s.conclusive).toBe(false);
  });
});

describe("drawdownEpisodes", () => {
  it("détecte les épisodes pic → creux → nouveau pic", () => {
    const eps = drawdownEpisodes([0, 1, 0.5, 0.2, 1.5, 1.2, 2]);
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({ startIdx: 1, troughIdx: 3, endIdx: 4 });
    expect(eps[0]!.depth).toBeCloseTo(0.8, 10);
    expect(eps[1]).toMatchObject({ startIdx: 4, troughIdx: 5, endIdx: 6 });
  });
  it("épisode en cours à la fin de série", () => {
    const eps = drawdownEpisodes([0, 1, 0.5]);
    expect(eps).toHaveLength(1);
    expect(eps[0]!.endIdx).toBe(2);
  });
});

describe("runCircuitBreaker", () => {
  it("suspend quand la fenêtre se dégrade (paramètres primaires)", () => {
    // 40 gagnants puis 40 perdants : le disjoncteur doit se déclencher
    const rets = [...Array(40).fill(0.05), ...Array(40).fill(-0.08)];
    const r = runCircuitBreaker(seqTrades(rets), BREAKER_PRIMARY, "halt", 10, "T");
    expect(r.haltEpisodes).toBeGreaterThanOrEqual(1);
    expect(r.nSkipped).toBeGreaterThan(0);
    expect(r.nTraded + r.nSkipped).toBe(80);
  });
  it("ne suspend jamais une série saine", () => {
    const rets = Array.from({ length: 60 }, (_, i) => (i % 3 === 2 ? -0.02 : 0.05));
    const r = runCircuitBreaker(seqTrades(rets), BREAKER_PRIMARY, "halt", 10, "T");
    expect(r.haltEpisodes).toBe(0);
    expect(r.nSkipped).toBe(0);
  });
  it("mode halve : rien n'est skippé, rendements ×0,5 en suspension", () => {
    const rets = [...Array(40).fill(0.05), ...Array(40).fill(-0.08)];
    const r = runCircuitBreaker(seqTrades(rets), BREAKER_PRIMARY, "halve", 10, "T");
    expect(r.nSkipped).toBe(0);
    expect(r.nTraded).toBe(80);
    expect(r.haltEpisodes).toBeGreaterThanOrEqual(1);
    // Les trades en suspension sont à demi-taille : la somme protégée < somme brute
    const rawSum = rets.reduce((a, b) => a + b, 0);
    const protSum = r.protectedRets.reduce((a, b) => a + b, 0);
    expect(protSum).toBeGreaterThan(rawSum); // pertes réduites de moitié
  });
  it("comptabilise faux positifs et pertes évitées", () => {
    // Dégradation puis reprise avec des gagnants pendant la suspension
    const rets = [...Array(40).fill(-0.08), ...Array(20).fill(0.10)];
    const r = runCircuitBreaker(seqTrades(rets), BREAKER_PRIMARY, "halt", 10, "T");
    if (r.nSkipped > 0) {
      expect(r.missedWinners + r.avoidedLosers).toBe(r.nSkipped);
      expect(r.missedPnL).toBeGreaterThanOrEqual(0);
      expect(r.avoidedLoss).toBeGreaterThanOrEqual(0);
    }
  });
  it("délai de détection mesuré contre les épisodes de DD", () => {
    const rets = [...Array(40).fill(0.05), ...Array(40).fill(-0.08)];
    const r = runCircuitBreaker(seqTrades(rets), BREAKER_PRIMARY, "halt", 10, "T");
    expect(r.ddEpisodes.length).toBeGreaterThan(0);
    expect(r.detectionDelays.length).toBe(r.ddEpisodes.length);
    // Au moins un épisode détecté (délai fini) ou déjà suspendu
    const detected = r.detectionDelays.filter((d) => d !== null);
    expect(detected.length).toBeGreaterThan(0);
  });
  it("fenêtre tradable : n'utilise que les trades complétés", () => {
    // Tous les exitAt sont APRÈS toutes les entryAt → fenêtre toujours vide → jamais de suspension
    const ts = seqTrades([...Array(40).fill(0.05), ...Array(40).fill(-0.08)]).map((t) => ({
      ...t,
      exitAt: "2026-09-30T00:00:00.000Z", // après tout
    }));
    const r = runCircuitBreaker(ts, BREAKER_PRIMARY, "halt", 10, "T");
    expect(r.haltEpisodes).toBe(0);
  });
});

describe("commonMintSeries / rollingCorrelation", () => {
  it("commonMintSeries : intersection triée par entryAt", () => {
    const a = [mkTrade({ mint: "x", ret: 0.1 }), mkTrade({ mint: "y", ret: -0.2 })];
    const b = [mkTrade({ mint: "y", ret: 0.3 }), mkTrade({ mint: "z", ret: 0.9 })];
    const ps = commonMintSeries(a, b);
    expect(ps.n).toBe(1);
    expect(ps.xs[0]).toBe(-0.2);
    expect(ps.ys[0]).toBe(0.3);
  });
  it("séries parfaitement corrélées → ρ ≈ 1", () => {
    const mk = (id: string, rets: number[]) =>
      rets.map((ret, i) => mkTrade({ mint: `${id}${i}`, entryAt: `2026-09-27T${String(i).padStart(2, "0")}:00:00.000Z`, ret }));
    const xs = Array.from({ length: 70 }, (_, i) => Math.sin(i / 5) * 0.1);
    const a = mk("a", xs);
    const b = mk("b", xs.map((x) => x * 2));
    // forcer les mêmes mints
    const b2 = b.map((t, i) => ({ ...t, mint: (a[i] as HTrade).mint }));
    const c = rollingCorrelation(a, b2, "A", "B", 50, 10);
    expect(c.pnlMean as number).toBeGreaterThan(0.95);
  });
  it("séries anti-corrélées → ρ < 0", () => {
    const mk = (id: string, rets: number[]) =>
      rets.map((ret, i) => mkTrade({ mint: `${id}${i}`, entryAt: `2026-09-27T${String(i).padStart(2, "0")}:00:00.000Z`, ret }));
    const xs = Array.from({ length: 70 }, (_, i) => Math.sin(i / 5) * 0.1);
    const a = mk("a", xs);
    const b2 = mk("b", xs.map((x) => -x)).map((t, i) => ({ ...t, mint: (a[i] as HTrade).mint }));
    const c = rollingCorrelation(a, b2, "A", "B", 50, 10);
    expect(c.pnlMean as number).toBeLessThan(-0.9);
  });
  it("n insuffisant → résultat vide mais valide", () => {
    const a = [mkTrade({ mint: "x", ret: 0.1 })];
    const b = [mkTrade({ mint: "x", ret: 0.2 })];
    const c = rollingCorrelation(a, b, "A", "B");
    expect(c.nWindows).toBe(0);
    expect(c.pnlMean).toBe(null);
  });
});

describe("LAMBDA constants", () => {
  it("constantes documentées positives", () => {
    expect(LAMBDA_DD).toBeGreaterThan(0);
    expect(LAMBDA_SIGMA).toBeGreaterThan(0);
  });
});
