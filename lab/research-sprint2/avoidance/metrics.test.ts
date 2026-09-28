/** Tests AVOIDANCE_ENGINE — métriques (données synthétiques, jamais data/). */
import { describe, expect, it } from "vitest";
import type { TokenSnapshot } from "../../types.ts";
import {
  bootstrapStatCI,
  drawdownMax24h,
  mannWhitney,
  measureAvoidance,
  type AvoidanceRow,
} from "./metrics.ts";
import { aberrantMask, findT0 } from "../../predictive/universe.ts";

function snap(mint: string, at: string, price: number, extra: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    mint,
    fetchedAt: at,
    dexId: "pumpswap",
    priceUsd: price,
    liquidityUsd: 100_000,
    volume: { m5: 1000, h1: 5000, h24: 20000 },
    volume5m: 1000,
    volume1h: 5000,
    volume24h: 20000,
    priceChange: { m5: 0, h1: 0, h24: 0 },
    txns: { m5: { buys: 10, sells: 8 }, h1: { buys: 50, sells: 40 }, h24: { buys: 200, sells: 180 } },
    ...extra,
  } as TokenSnapshot;
}

describe("drawdownMax24h", () => {
  it("pire excursion adverse sur 24 h", () => {
    const s = [
      snap("A", "2026-09-28T00:00:00Z", 1),
      snap("A", "2026-09-28T01:00:00Z", 0.8),
      snap("A", "2026-09-28T02:00:00Z", 0.5),
      snap("A", "2026-09-28T03:00:00Z", 0.9),
    ];
    const mask = aberrantMask(s);
    expect(drawdownMax24h(s, 0, mask)).toBeCloseTo(-0.5, 10);
  });

  it("ignore les snapshots au-delà de 24 h", () => {
    const s = [
      snap("A", "2026-09-28T00:00:00Z", 1),
      snap("A", "2026-09-29T01:00:00Z", 0.1), // +25 h : hors fenêtre
    ];
    expect(drawdownMax24h(s, 0, aberrantMask(s))).toBeNull();
  });

  it("ignore les ticks aberrants", () => {
    const s = [
      snap("A", "2026-09-28T00:00:00Z", 1),
      snap("A", "2026-09-28T01:00:00Z", 0.001), // <= min(voisins)/100 = 0.009 => masqué
      snap("A", "2026-09-28T02:00:00Z", 0.9),
    ];
    // 0.001 masqué ; pire excursion = -0.1
    expect(drawdownMax24h(s, 0, aberrantMask(s))).toBeCloseTo(-0.1, 10);
  });
});

describe("mannWhitney", () => {
  it("sépare deux groupes disjoints", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
    const { p } = mannWhitney(a, b);
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(0.001);
  });

  it("groupes identiques => p élevé", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const { p } = mannWhitney(a, [...a]);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0.5);
  });

  it("groupes trop petits => p null", () => {
    expect(mannWhitney([1, 2], [3, 4, 5, 6, 7, 8, 9, 10]).p).toBeNull();
  });
});

describe("bootstrapStatCI", () => {
  it("IC contient la vraie moyenne", () => {
    const sample = Array.from({ length: 200 }, (_, i) => i + 1);
    const ci = bootstrapStatCI(sample, (s) => s.reduce((a, b) => a + b, 0) / s.length, 200, 7);
    expect(ci).not.toBeNull();
    expect(ci![0]).toBeLessThan(100.5);
    expect(ci![1]).toBeGreaterThan(100.5);
  });

  it("n < 10 => null", () => {
    expect(bootstrapStatCI([1, 2, 3], (s) => s[0]!)).toBeNull();
  });
});

function row(o: Partial<AvoidanceRow> & { mint: string }): AvoidanceRow {
  return {
    dexId: "pumpswap",
    t0Date: "2026-09-28T00:00:00Z",
    t0Time: 0,
    sellsM5: 10,
    turnoverM5: 0.01,
    liqT0: 100_000,
    y1h: -0.1,
    y6h: -0.2,
    ddMax24h: -0.3,
    ...o,
  };
}

describe("measureAvoidance", () => {
  // 40 tokens : 10 en frénésie (sellsM5=200, tous perdants à -50 %),
  // 30 calmes (sellsM5=10, médiane +10 %).
  const rows: AvoidanceRow[] = [
    ...Array.from({ length: 10 }, (_, i) =>
      row({ mint: `F${i}`, sellsM5: 200, y1h: -0.5, y6h: -0.6, ddMax24h: -0.7 }),
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      row({
        mint: `K${i}`,
        sellsM5: 10,
        y1h: i < 15 ? 0.1 : -0.05,
        y6h: 0.05,
        ddMax24h: -0.2,
      }),
    ),
  ];
  const thresholds = { F_FRENZY: 100, F_TURNOVER: 99, F_LIQT0: 1 };

  it("mesure la perte médiane évitée et les faux positifs", () => {
    const m = measureAvoidance(rows, "F_FRENZY", "1h", "principal", thresholds);
    expect(m.nAll).toBe(40);
    expect(m.nFlag).toBe(10);
    expect(m.pctAvoided).toBeCloseTo(0.25, 10);
    // médiane all = ? triés : 10×(-0.5), 15×(-0.05), 15×(0.1) → médiane (20e,21e)/2 = -0.05
    // médiane keep (30 calmes) = (-0.05+0.1)/2 = 0.025 → évité = 0.075
    expect(m.lossAvoidedMed).toBeCloseTo(0.075, 10);
    // gagnants : 15 calmes à +10 % ; aucun flaggé → 0 % de faux positifs
    expect(m.nWinners).toBe(15);
    expect(m.fpWinnersPct).toBe(0);
    // séparation significative
    expect(m.mwP).not.toBeNull();
    expect(m.mwP!).toBeLessThan(0.05);
    // IC bootstrap contient l'effet
    expect(m.ciLo).not.toBeNull();
    expect(m.ciLo!).toBeLessThanOrEqual(m.lossAvoidedMed!);
    expect(m.ciHi!).toBeGreaterThanOrEqual(m.lossAvoidedMed!);
  });

  it("drawdown et queue : évitement utile", () => {
    // 20 flaggés (dd -0.7) / 20 gardés (dd -0.2) : la médiane « all » est
    // tirée vers le bas par les flaggés, l'évitement l'améliore.
    const ddRows: AvoidanceRow[] = [
      ...Array.from({ length: 20 }, (_, i) =>
        row({ mint: `D${i}`, sellsM5: 200, y1h: -0.5, ddMax24h: -0.7 }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        row({ mint: `E${i}`, sellsM5: 10, y1h: 0.1, ddMax24h: -0.2 }),
      ),
    ];
    const m = measureAvoidance(ddRows, "F_FRENZY", "1h", "principal", thresholds);
    expect(m.ddMedAll).toBeLessThan(m.ddMedKeep!);
    expect(m.ddAvoided).toBeGreaterThan(0); // keep moins creusé
    expect(m.tailLossAvoided).toBeGreaterThan(0); // P10 amélioré
  });

  it("filtre seul : ignore les tokens sans variable", () => {
    const withNull = [...rows, row({ mint: "N", sellsM5: null, y1h: 5.0 })];
    const m = measureAvoidance(withNull, "F_FRENZY", "1h", "principal", thresholds);
    expect(m.nAll).toBe(40); // le token sans sellsM5 est exclu du filtre
  });

  it("combiné : OU logique des 3 filtres", () => {
    const m = measureAvoidance(rows, "COMBINED", "1h", "principal", {
      F_FRENZY: 100,
      F_TURNOVER: 99,
      F_LIQT0: 1,
    });
    expect(m.nFlag).toBe(10); // seuls les frénétiques (turnover bas, liq haute)
  });

  it("findT0 non utilisé ici mais le protocole est importé sans erreur", () => {
    const s = [snap("X", "2026-09-28T00:00:00Z", 1, { liquidityUsd: 10 })];
    expect(findT0(s)).toBe(-1); // liquidité < 20000 => pas de t0
  });
});
