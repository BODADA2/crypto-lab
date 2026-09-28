/**
 * Tests de la décomposition économique de l'espérance (run-expectancy-decomposition).
 * Fonctions pures uniquement ; aucune donnée réelle, aucun réseau.
 */
import { describe, it, expect } from "vitest";
import {
  isGlitchTick,
  rungFeesOnly,
  rungSlipOnly,
  rungNet,
  rungNetSqrt,
  sqrtSlip,
  winsorizedMean,
  rungStats,
  splitDisjointUniverses,
  edgeVerdict,
  DECOMP_FEES_RT,
  type DecompTrade,
  type LadderRow,
} from "../lab/backtest/run-expectancy-decomposition.ts";
import type { TokenSnapshot } from "../lab/types.ts";

function snap(price: number, t: string): TokenSnapshot {
  return {
    mint: "m",
    chain: "solana",
    symbol: "T",
    name: "T",
    createdAt: t,
    pairCreatedAt: null,
    pairAddress: null,
    dexId: null,
    url: null,
    priceUsd: price,
    liquidityUsd: 50_000,
    fdvUsd: null,
    marketCapUsd: null,
    volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
    fetchedAt: t,
  } as TokenSnapshot;
}

function trade(over: Partial<DecompTrade> = {}): DecompTrade {
  return {
    mint: "m",
    entryAt: "2026-09-28T00:00:00.000Z",
    grossReal: 0.1,
    grossIdeal: 0.12,
    slipIn: 0.0025,
    slipOut: 0.0025,
    entryLiq: 20_000,
    exitLiq: 20_000,
    exit: "take-profit",
    bars: 2,
    mfe: 0.35,
    mae: -0.05,
    glitchEntry: false,
    ...over,
  };
}

describe("isGlitchTick", () => {
  it("détecte le tick isolé (192 → 0,0038 → 192)", () => {
    const s = [snap(192, "t0"), snap(0.0038, "t1"), snap(192, "t2")];
    expect(isGlitchTick(s, 1)).toBe(true);
  });
  it("ne flag pas un effondrement permanent (mort réelle)", () => {
    const s = [snap(1.6e-3, "t0"), snap(2.3e-6, "t1"), snap(2.3e-6, "t2"), snap(2.2e-6, "t3")];
    expect(isGlitchTick(s, 1)).toBe(false);
  });
  it("ne flag pas une série normale", () => {
    const s = [snap(1, "t0"), snap(1.1, "t1"), snap(0.95, "t2")];
    expect(isGlitchTick(s, 1)).toBe(false);
  });
  it("ne flag pas sans les deux voisins", () => {
    const s = [snap(0.001, "t0"), snap(100, "t1")];
    expect(isGlitchTick(s, 1)).toBe(false);
    expect(isGlitchTick(s, 0)).toBe(false);
  });
  it("ne flag pas un prix nul", () => {
    const s = [snap(1, "t0"), snap(0, "t1"), snap(1, "t2")];
    expect(isGlitchTick(s, 1)).toBe(false);
  });
});

describe("échelons counterfactual", () => {
  const t = trade({ grossReal: 0.1, slipIn: 0.0025, slipOut: 0.0025 });
  it("frais seuls = brut × (1 − 1,3 %)", () => {
    expect(rungFeesOnly(t)).toBeCloseTo(1.1 * (1 - DECOMP_FEES_RT) - 1, 12);
  });
  it("slippage seul déduit les deux jambes", () => {
    expect(rungSlipOnly(t, 50)).toBeCloseTo(1.1 * 0.9975 * 0.9975 - 1, 12);
  });
  it("net ≤ chaque échelon partiel", () => {
    const net = rungNet(t, 50);
    expect(net).toBeLessThan(rungFeesOnly(t));
    expect(net).toBeLessThan(rungSlipOnly(t, 50));
    expect(net).toBeLessThan(t.grossReal);
  });
  it("le slippage croît avec la taille du ticket", () => {
    expect(rungNet(t, 500)).toBeLessThan(rungNet(t, 10));
  });
  it("un trade perdant reste perdant après coûts", () => {
    const loser = trade({ grossReal: -0.3 });
    expect(rungNet(loser, 50)).toBeLessThan(-0.3);
  });
});

describe("sqrtSlip (variante exploratoire)", () => {
  it("est ancrée au modèle linéaire à 50 $", () => {
    expect(sqrtSlip(0.0025, 50)).toBeCloseTo(0.0025, 12);
  });
  it("croît en racine carrée", () => {
    expect(sqrtSlip(0.0025, 200)).toBeCloseTo(0.0025 * 2, 12);
  });
  it("est plafonnée à 15 %", () => {
    expect(sqrtSlip(0.03, 10_000)).toBe(0.15);
  });
  it("rungNetSqrt coïncide avec rungNet à 50 $", () => {
    const t = trade();
    expect(rungNetSqrt(t, 50)).toBeCloseTo(rungNet(t, 50), 12);
  });
});

describe("winsorizedMean", () => {
  it("neutralise un outlier extrême", () => {
    // 199 valeurs normales + 1 outlier : le q99 tombe sur une valeur normale,
    // l'outlier est cappé et la moyenne reste proche de −5 %.
    const xs = [...Array(199).fill(-0.05), 50_000];
    const w = winsorizedMean(xs);
    expect(w).toBeGreaterThan(-0.06);
    expect(w).toBeLessThan(0);
  });
  it("vaut la moyenne sans outlier", () => {
    expect(winsorizedMean([0.1, 0.2, 0.3])).toBeCloseTo(0.2, 12);
  });
});

describe("rungStats", () => {
  it("calcule win rate et profit factor", () => {
    const s = rungStats([0.5, -0.25, 0.5, -0.25]);
    expect(s.n).toBe(4);
    expect(s.winRate).toBe(0.5);
    expect(s.profitFactor).toBeCloseTo(2, 10);
    expect(s.median).toBeCloseTo(0.5, 10); // quantile p50 du repo = valeur centrale supérieure
  });
});

describe("splitDisjointUniverses", () => {
  function fakeSeries(mint: string, first: string): [string, TokenSnapshot[]] {
    return [mint, [snap(1, first), snap(1.1, first + "x")]];
  }
  it("partitionne sans intersection et sans perte", () => {
    const m = new Map<string, TokenSnapshot[]>([
      fakeSeries("a", "2026-09-24T00:00:00Z"),
      fakeSeries("b", "2026-09-25T00:00:00Z"),
      fakeSeries("c", "2026-09-26T00:00:00Z"),
      fakeSeries("d", "2026-09-27T00:00:00Z"),
      fakeSeries("e", "2026-09-28T00:00:00Z"),
      fakeSeries("f", "2026-09-29T00:00:00Z"),
    ]);
    const split = splitDisjointUniverses(m);
    const all = [...split.decouverte, ...split.calibration, ...split.validation];
    expect(new Set(all).size).toBe(6); // aucune intersection
    expect(all.length).toBe(6); // aucune perte
    // ordre chronologique respecté : découverte = les plus anciens
    expect(split.decouverte).toContain("a");
    expect(split.validation).toContain("f");
  });
});

describe("edgeVerdict", () => {
  function ladder(idealMean: number, idealLo: number, realMean: number, netMean: number): LadderRow[] {
    const mk = (meanWins: number, lo: number) => ({
      n: 200,
      meanRaw: meanWins,
      meanWins,
      meanWinsCI: [lo, meanWins + 0.05] as [number, number],
      median: meanWins,
      medianCI: [lo, meanWins + 0.05] as [number, number],
      winRate: 0.5,
      profitFactor: 1,
    });
    return [
      { rung: "brutIdéal (entrée au signal, zéro coût)", stats: mk(idealMean, idealLo) },
      { rung: "brutRéel (entrée t+1, zéro coût)", stats: mk(realMean, -0.02) },
      { rung: "fraisSeuls (t+1, frais 1,3 %)", stats: mk(realMean - 0.01, -0.03) },
      { rung: "slipSeul (t+1, slippage linéaire)", stats: mk(realMean - 0.005, -0.03) },
      { rung: "net (t+1, frais + slippage)", stats: mk(netMean, -0.2) },
    ];
  }
  it("conclut EDGE_BRUT_DETRUIT_PAR_COUTS quand l'idéal est significativement positif", () => {
    const v = edgeVerdict(ladder(0.04, 0.01, 0.02, -0.03));
    expect(v.verdict).toBe("EDGE_BRUT_DETRUIT_PAR_COUTS");
  });
  it("conclut NO_EVIDENCE_OF_EDGE quand l'idéal n'est pas significatif", () => {
    const v = edgeVerdict(ladder(0.03, -0.04, -0.09, -0.11));
    expect(v.verdict).toBe("NO_EVIDENCE_OF_EDGE");
  });
  it("conclut NO_EVIDENCE_OF_EDGE quand tout est négatif", () => {
    const v = edgeVerdict(ladder(-0.05, -0.1, -0.09, -0.11));
    expect(v.verdict).toBe("NO_EVIDENCE_OF_EDGE");
  });
});
