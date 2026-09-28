import { describe, expect, it } from "vitest";
import {
  analyzePair,
  buildT0Row,
  coverageByUniverse,
  removeValidOutliers,
  joinTokensTop10,
  parseEarlyBuyerMetrics,
  quantile,
  temporalHalves,
  UNKNOWN_TOP10,
  yBaseline,
  MIN_N_CONCLUSION,
} from "../lab/predictive/distribution/distribution.ts";
import { HORIZON_LABELS } from "../lab/predictive/universe.ts";
import type { TokenSnapshot } from "../lab/types.ts";

function snap(partial: Partial<TokenSnapshot> & { priceUsd: number; liquidityUsd: number; fetchedAt: string }): TokenSnapshot {
  return {
    mint: "m",
    chain: "solana",
    symbol: "T",
    name: "T",
    createdAt: partial.fetchedAt,
    pairCreatedAt: null,
    pairAddress: null,
    dexId: "pumpswap",
    url: "",
    fdvUsd: 0,
    marketCapUsd: 0,
    volume: {},
    priceChange: {},
    txns: { h1: { buys: 100, sells: 50 } },
    holders: null,
    top10Pct: UNKNOWN_TOP10,
    mintAuthority: null,
    freezeAuthority: null,
    boostsActive: 0,
    pairCount: 1,
    source: "test",
    ...partial,
  } as TokenSnapshot;
}

const H = 3_600_000;
const t = (ms: number) => new Date(ms).toISOString();

describe("buildT0Row", () => {
  it("détecte t0 et convertit top10Pct=100 (inconnu) en null", () => {
    const s = [
      snap({ priceUsd: 1, liquidityUsd: 100, fetchedAt: t(0), top10Pct: 100 }),
      snap({ priceUsd: 1, liquidityUsd: 25000, fetchedAt: t(H), top10Pct: 100 }),
      snap({ priceUsd: 2, liquidityUsd: 30000, fetchedAt: t(2 * H), top10Pct: 100 }),
    ];
    const row = buildT0Row("mintA", s)!;
    expect(row).not.toBeNull();
    expect(row.t0FetchedAt).toBe(t(H));
    expect(row.top10Pct).toBeNull();
    expect(row.top10PctPreT0).toBeNull();
    expect(row.holders).toBeNull();
    expect(row.y[0]).toBeCloseTo(1, 6); // 2/1 - 1 sur 1h
    expect(["discovery", "calibration", "holdout"]).toContain(row.universe);
  });

  it("conserve un top10Pct connu à t0 et capte l'évolution pré-t0", () => {
    const s = [
      snap({ priceUsd: 1, liquidityUsd: 100, fetchedAt: t(0), top10Pct: 30 }),
      snap({ priceUsd: 1, liquidityUsd: 25000, fetchedAt: t(H), top10Pct: 60 }),
      snap({ priceUsd: 1.5, liquidityUsd: 30000, fetchedAt: t(2 * H), top10Pct: 60 }),
    ];
    const row = buildT0Row("mintB", s)!;
    expect(row.top10Pct).toBe(60);
    expect(row.top10PctPreT0).toBe(30);
    expect(row.sellRatioT0).toBeCloseTo(50 / 150, 6);
  });

  it("exclut les ticks aberrants du calcul de Y", () => {
    const s = [
      snap({ priceUsd: 1, liquidityUsd: 25000, fetchedAt: t(0) }),
      snap({ priceUsd: 1000, liquidityUsd: 25000, fetchedAt: t(H) }), // glitch 1000x
      snap({ priceUsd: 2, liquidityUsd: 25000, fetchedAt: t(2 * H) }),
    ];
    const row = buildT0Row("mintC", s)!;
    expect(row.aberrantTicks).toBe(1);
    // Y 1h : le premier tick >= target non aberrant est à 2H (prix 2)
    expect(row.y[0]).toBeCloseTo(1, 6);
  });

  it("retourne null sans t0 valide", () => {
    const s = [snap({ priceUsd: 1, liquidityUsd: 100, fetchedAt: t(0) })];
    expect(buildT0Row("mintD", s)).toBeNull();
  });
});

describe("joinTokensTop10", () => {
  it("marque alignedT0 seulement quand les timestamps coïncident", () => {
    const ok = joinTokensTop10("m", { fetchedAt: t(H), top10Pct: 42 }, t(H));
    expect(ok.top10Pct).toBe(42);
    expect(ok.alignedT0).toBe(true);
    const ko = joinTokensTop10("m", { fetchedAt: t(2 * H), top10Pct: 42 }, t(H));
    expect(ko.alignedT0).toBe(false);
    const unk = joinTokensTop10("m", { fetchedAt: t(H), top10Pct: 100 }, t(H));
    expect(unk.top10Pct).toBeNull();
  });
});

describe("parseEarlyBuyerMetrics", () => {
  it("extrait les métriques et tolère les fichiers sans metrics", () => {
    const m = parseEarlyBuyerMetrics("mintX", {
      metrics: { top5_share: 0.5, gini: 0.4, same_slot_max: 0.1, truncated: true },
      sells: { sellersOver50: 1, coordinated_sells: null, walletsCovered: 3 },
      truncated: false,
    });
    expect(m.top5Share).toBe(0.5);
    expect(m.gini).toBe(0.4);
    expect(m.sameSlotMax).toBe(0.1);
    expect(m.sellersOver50).toBe(1);
    expect(m.coordinatedSells).toBeNull();
    expect(m.walletsCovered).toBe(3);
    expect(m.truncated).toBe(true);
    const empty = parseEarlyBuyerMetrics("mintY", { mint: "mintY" });
    expect(empty.top5Share).toBeNull();
    expect(empty.gini).toBeNull();
  });
});

describe("analyzePair", () => {
  it("détecte une corrélation parfaite positive / négative", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const pos = analyzePair(xs, xs.map((x) => x * 2));
    expect(pos.spearman).toBeCloseTo(1, 8);
    const neg = analyzePair(xs, xs.map((x) => -x));
    expect(neg.spearman).toBeCloseTo(-1, 8);
  });

  it("retourne null quand n < 3 et conclusive=false sous le seuil", () => {
    const a = analyzePair([1, 2], [3, 4]);
    expect(a.spearman).toBeNull();
    expect(a.conclusive).toBe(false);
    const b = analyzePair(Array.from({ length: MIN_N_CONCLUSION }, (_, i) => i), Array.from({ length: MIN_N_CONCLUSION }, (_, i) => i));
    expect(b.conclusive).toBe(true);
  });

  it("calcule les déciles top vs bottom sur données synthétiques", () => {
    const xs = Array.from({ length: 30 }, (_, i) => i); // 0..29
    const ys = xs.map((x) => (x < 15 ? 0.1 : -0.1)); // bas X => Y positif
    const a = analyzePair(xs, ys);
    expect(a.deciles).not.toBeNull();
    expect(a.deciles!.bottomMedian).toBeCloseTo(0.1, 6);
    expect(a.deciles!.topMedian).toBeCloseTo(-0.1, 6);
  });

  it("removeValidOutliers retire Y hors [P1, P99] (sensibilité)", () => {
    const xs = Array.from({ length: 200 }, (_, i) => i);
    const ys = Array.from({ length: 200 }, () => 0.01);
    ys[0] = 50; // outlier massif (> P99)
    ys[1] = -40; // outlier massif (< P1)
    const { ys: trimmed, removed } = removeValidOutliers(xs, ys);
    expect(removed).toBe(2);
    expect(trimmed).not.toContain(50);
    expect(trimmed).not.toContain(-40);
  });

  it("quantile suit la convention du domaine temporal", () => {
    const a = Array.from({ length: 100 }, (_, i) => i); // 0..99
    expect(quantile(a, 0.01)).toBe(1);
    expect(quantile(a, 0.99)).toBe(99);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("compte les pertes extrêmes", () => {
    const a = analyzePair([1, 2, 3, 4], [0.1, -0.6, 0.2, -0.9]);
    expect(a.fracExtremeLoss).toBeCloseTo(0.5, 6);
  });
});

describe("coverageByUniverse", () => {
  it("compte X et Y par univers et par horizon", () => {
    const rows = [
      { universe: "discovery" as const, x: 1, y: [0.1, null, null] as (number | null)[] },
      { universe: "discovery" as const, x: null, y: [0.1, 0.2, null] as (number | null)[] },
      { universe: "holdout" as const, x: 2, y: [null, 0.3, 0.4] as (number | null)[] },
    ];
    const c = coverageByUniverse(rows);
    expect(c.discovery.xTotal).toBe(1);
    expect(c.discovery.perHorizon).toEqual([1, 0, 0]);
    expect(c.holdout.xTotal).toBe(1);
    expect(c.holdout.perHorizon).toEqual([0, 1, 1]);
    expect(c.calibration.xTotal).toBe(0);
  });
});

describe("temporalHalves", () => {
  it("coupe en deux moitiés par t0 médian", () => {
    const rows = [3, 1, 4, 2].map((i) => ({ t0FetchedAt: t(i * H) }));
    const { first, second } = temporalHalves(rows);
    expect(first.map((r) => r.t0FetchedAt)).toEqual([t(H), t(2 * H)]);
    expect(second.map((r) => r.t0FetchedAt)).toEqual([t(3 * H), t(4 * H)]);
  });
});

describe("yBaseline", () => {
  it("retourne une entrée par horizon avec le bon label", () => {
    const b = yBaseline([{ y: [0.1, null, null] }, { y: [-0.2, 0.3, null] }]);
    expect(b.map((x) => x.horizon)).toEqual([...HORIZON_LABELS]);
    expect(b[0]!.n).toBe(2);
    expect(b[0]!.medianY).toBeCloseTo(-0.05, 6);
    expect(b[2]!.n).toBe(0);
  });
});
