/**
 * Tests de l'analyse hedge — fonctions pures uniquement (aucune donnée réelle).
 *
 * Couvre : winsorisation, moyennes tronquées, IC bootstrap (y compris le SENS
 * des différences appariées : hedged − base), bucketisation des facteurs de
 * risque, blend de portefeuille, sortie d'urgence, et cohérence de la simu
 * custom avec le canonique.
 */
import { describe, it, expect } from "vitest";
import {
  winsorize,
  trimmedMean,
  bootstrapMeanCI,
  bootstrapMedianCI,
  bootstrapPairedDiffCI,
  bootstrapPairedMedianDiffCI,
  summarizeVariant,
  bucketOf,
  commonLossBuckets,
  blendPortfolio,
  simulateScalpCustom,
  evalHedge,
  type HTrade,
  type VariantId,
} from "../lab/backtest/run-hedge-analysis.ts";
import { simulateExit, type PricePoint } from "../lab/signals/exit.ts";

function mkTrade(over: Partial<HTrade> = {}): HTrade {
  return {
    mint: "mint" + Math.random().toString(36).slice(2),
    entryAt: "2026-09-27T12:00:00.000Z",
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

function path(prices: number[]): PricePoint[] {
  return prices.map((price, i) => ({
    t: `2026-09-27T12:${String(i).padStart(2, "0")}:00.000Z`,
    price,
    liquidityUsd: 100_000,
  }));
}

describe("winsorize", () => {
  it("plafonne des deux côtés", () => {
    expect(winsorize([0.5, -0.5, 10, -10, 0], 1)).toEqual([0.5, -0.5, 1, -1, 0]);
  });
  it("ne touche pas les valeurs sous le cap", () => {
    expect(winsorize([0.1, -0.2], 5)).toEqual([0.1, -0.2]);
  });
});

describe("trimmedMean", () => {
  it("ignore les queues (tick aberrant neutralisé)", () => {
    const xs = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 100];
    // p=0.1 : retire min (0.01) et max (100) → moyenne de 0.02..0.09 = 0.055
    expect(trimmedMean(xs, 0.1)).toBeCloseTo(0.055, 10);
    expect(trimmedMean(xs, 0)).toBeGreaterThan(9); // sans trim, l'outlier domine
  });
});

describe("bootstrap CIs", () => {
  it("bootstrapMeanCI contient la moyenne", () => {
    const xs = [0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.015, -0.005];
    const [lo, hi] = bootstrapMeanCI(xs, 500, 1);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(lo).toBeLessThanOrEqual(m);
    expect(hi).toBeGreaterThanOrEqual(m);
    expect(hi - lo).toBeGreaterThan(0);
  });
  it("bootstrapMedianCI contient la médiane", () => {
    const xs = [0.05, -0.02, 0.03, 0.01, -0.04, 0.02, 0.0, -0.01, 0.04, -0.03];
    const [lo, hi] = bootstrapMedianCI(xs, 500, 2);
    expect(lo).toBeLessThanOrEqual(0.005);
    expect(hi).toBeGreaterThanOrEqual(0.005);
  });
  it("bootstrapPairedDiffCI estime ys − xs (SENS hedged − base)", () => {
    const xs = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08];
    const ys = xs.map((x) => x + 0.1); // hedged = base + 10pp partout
    const [lo, hi] = bootstrapPairedDiffCI(xs, ys, 500, 3);
    expect(lo).toBeGreaterThan(0.05);
    expect(hi).toBeLessThan(0.15);
  });
  it("bootstrapPairedMedianDiffCI estime médiane(ys) − médiane(xs)", () => {
    const xs = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08];
    const ys = xs.map((x) => x - 0.05);
    const [lo, hi] = bootstrapPairedMedianDiffCI(xs, ys, 500, 4);
    expect(hi).toBeLessThan(0);
    expect(lo).toBeGreaterThan(-0.1);
  });
});

describe("summarizeVariant", () => {
  it("médiane et winsorisée résistent à un tick aberrant", () => {
    const trades = [
      mkTrade({ ret: 0.02 }),
      mkTrade({ ret: -0.03 }),
      mkTrade({ ret: 0.01 }),
      mkTrade({ ret: -0.05 }),
      mkTrade({ ret: 50 }), // ×50 : tick aberrant
    ];
    const s = summarizeVariant("V1", trades, 2);
    expect(s.n).toBe(5);
    expect(s.medianRet).toBeCloseTo(0.01, 10);
    expect(s.expectancy).toBeGreaterThan(9); // brute dominée
    expect(s.expectancyW).toBeCloseTo((0.02 - 0.03 + 0.01 - 0.05 + 2) / 5, 10);
    expect(s.topOutliers[0]).toBe(50);
    expect(s.conclusive).toBe(false); // n < 30
  });
  it("drawdown additif en unités de mise", () => {
    const trades = [mkTrade({ ret: 0.1 }), mkTrade({ ret: -0.3 }), mkTrade({ ret: -0.3 })];
    const s = summarizeVariant("V1", trades);
    // eq: 0.1 → -0.2 → -0.5 ; peak 0.1 ; DD = 0.1 - (-0.5) = 0.6
    expect(s.maxDrawdownUnits).toBeCloseTo(0.6, 10);
  });
});

describe("bucketOf", () => {
  const liqQ = [30_000, 60_000, 120_000];
  it("chase buckets", () => {
    expect(bucketOf(mkTrade({ chase: 0.8 }), "chaseB", liqQ)).toBe("chase-vertical");
    expect(bucketOf(mkTrade({ chase: 0.3 }), "chaseB", liqQ)).toBe("chase-élevé");
    expect(bucketOf(mkTrade({ chase: 0.05 }), "chaseB", liqQ)).toBe("chase-calme");
    expect(bucketOf(mkTrade({ chase: null }), "chaseB", liqQ)).toBe("chase-inconnu");
  });
  it("quartiles de liquidité", () => {
    expect(bucketOf(mkTrade({ entryLiq: 10_000 }), "liqQ", liqQ)).toBe("liq-Q1");
    expect(bucketOf(mkTrade({ entryLiq: 200_000 }), "liqQ", liqQ)).toBe("liq-Q4");
  });
  it("âge", () => {
    expect(bucketOf(mkTrade({ ageIdx: 2 }), "ageB", liqQ)).toBe("age-jeune");
    expect(bucketOf(mkTrade({ ageIdx: 20 }), "ageB", liqQ)).toBe("age-vieux");
  });
});

describe("commonLossBuckets", () => {
  it("détecte les buckets où toutes les variantes perdent en médiane", () => {
    const cells = [
      { variant: "V1" as VariantId, bucket: "liq-Q2", n: 40, meanRet: -0.05, medianRet: -0.04, winRate: 0.4 },
      { variant: "V2" as VariantId, bucket: "liq-Q2", n: 40, meanRet: -0.1, medianRet: -0.08, winRate: 0.3 },
      { variant: "V1" as VariantId, bucket: "liq-Q4", n: 40, meanRet: -0.05, medianRet: 0.03, winRate: 0.6 },
      { variant: "V2" as VariantId, bucket: "liq-Q4", n: 40, meanRet: -0.02, medianRet: -0.01, winRate: 0.45 },
      // moyenne brute positive mais médiane négative : ne doit PAS exclure le bucket
      { variant: "V1" as VariantId, bucket: "petit", n: 5, meanRet: -0.5, medianRet: -0.4, winRate: 0.1 },
      { variant: "V2" as VariantId, bucket: "petit", n: 5, meanRet: -0.5, medianRet: -0.4, winRate: 0.1 },
    ];
    expect(commonLossBuckets(cells, ["V1", "V2"])).toEqual(["liq-Q2"]);
  });
});

describe("blendPortfolio", () => {
  it("moyenne les rendements sur les mints communs", () => {
    const a = [mkTrade({ mint: "m1", ret: 0.1 }), mkTrade({ mint: "m2", ret: -0.2 })];
    const b = [mkTrade({ mint: "m1", ret: 0.3 }), mkTrade({ mint: "m3", ret: 0.5 })];
    const pf = blendPortfolio(a, b);
    expect(pf).toHaveLength(1);
    expect(pf[0]!.ret).toBeCloseTo(0.2, 10);
  });
});

describe("simulateScalpCustom", () => {
  const costs = { sizeUsd: 50, feesRoundTrip: 0.013, maxSlippage: 0.03 };
  it("sans urgence = canonique (validation du modèle de coûts)", () => {
    const p = path([1, 1.05, 0.97, 1.12, 1.35, 1.1, 1.02, 0.99]);
    const custom = simulateScalpCustom(p, 0, costs, { timeStopBars: 6 });
    const canon = simulateExit(p, 0, "scalp", costs);
    expect(custom.ret).toBeCloseTo(canon.blendedRet, 12);
    expect(custom.exit).toBe(canon.fills[canon.fills.length - 1]!.exit);
  });
  it("l'urgence se déclenche à −8 % dans les 6 barres", () => {
    const p = path([1, 1.02, 0.99, 0.9, 1.5]); // −10 % à la barre 3
    const r = simulateScalpCustom(p, 0, costs, { timeStopBars: 6, emergencyAt: -0.08, emergencyWithin: 6 });
    expect(r.exit).toBe("emergency");
    expect(r.bars).toBe(3);
  });
  it("l'urgence ne se déclenche pas après la fenêtre", () => {
    const p = path([1, 1.02, 1.01, 1.0, 1.02, 1.01, 1.0, 0.9, 1.5]); // −10 % à la barre 7
    const r = simulateScalpCustom(p, 0, costs, { timeStopBars: 6, emergencyAt: -0.08, emergencyWithin: 6 });
    expect(r.exit).not.toBe("emergency");
  });
  it("time-stop court paramétrable", () => {
    const p = path([1, 1.01, 1.02, 1.01, 1.0, 1.01, 1.02]);
    const r = simulateScalpCustom(p, 0, costs, { timeStopBars: 3 });
    expect(r.exit).toBe("time-stop");
    expect(r.bars).toBe(3);
  });
});

describe("evalHedge", () => {
  it("apparié quand mêmes mints, signe hedged − base", () => {
    const base = [mkTrade({ mint: "m1", ret: 0.02 }), mkTrade({ mint: "m2", ret: -0.04 })];
    // +30 trades pour la conclusivité de l'appariement
    for (let i = 0; i < 30; i++) {
      base.push(mkTrade({ mint: `b${i}`, ret: i % 2 ? 0.01 : -0.02 }));
    }
    const hedged = base.map((t) => ({ ...t, ret: t.ret + 0.005 }));
    const h = evalHedge("H-T", "test", base, hedged, "V1", "V6", 10, "note");
    expect(h.paired).toBe(true);
    expect(h.diffWPoint).toBeCloseTo(0.005, 10);
    expect(h.diffWCI?.[0]).toBeGreaterThan(0); // amélioration significative
    expect(h.hedgeCostW).toBeCloseTo(-0.005, 10); // coût négatif = gain
  });
  it("non apparié quand univers différents", () => {
    const base = Array.from({ length: 40 }, (_, i) => mkTrade({ mint: `a${i}`, ret: 0.01 }));
    const hedged = Array.from({ length: 40 }, (_, i) => mkTrade({ mint: `z${i}`, ret: 0.02 }));
    const h = evalHedge("H-T", "test", base, hedged, "V1", "V9", 10, "note");
    expect(h.paired).toBe(false);
    expect(h.diffWPoint).toBeCloseTo(0.01, 10);
  });
});
