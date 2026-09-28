import { describe, expect, it } from "vitest";
import type { TokenSnapshot } from "../lab/types.ts";
import {
  FEATURE_LABELS,
  FEATURE_NAMES,
  flowFeaturesAtT0,
} from "../lab/predictive/flows/features.ts";
import {
  medianDiffBootstrapCI,
  spearmanBootstrapCI,
  spearmanP,
  summarize,
  winsorize,
} from "../lab/predictive/flows/stats.ts";

function snap(partial: Partial<TokenSnapshot>): TokenSnapshot {
  return {
    mint: "m",
    chain: "solana",
    symbol: "T",
    name: "T",
    createdAt: "2026-09-26T00:00:00.000Z",
    pairCreatedAt: null,
    pairAddress: null,
    dexId: "pumpswap",
    url: "",
    priceUsd: 0.001,
    liquidityUsd: 30000,
    fdvUsd: 0,
    marketCapUsd: 0,
    volume: { m5: 1000, h1: 5000, h6: 5000, h24: 5000 },
    volume5m: 1000,
    volume1h: 5000,
    volume24h: 5000,
    priceChange: { m5: 5, h1: 10, h6: 10, h24: 10 },
    txns: {
      m5: { buys: 120, sells: 80 },
      h1: { buys: 300, sells: 200 },
      h6: { buys: 300, sells: 200 },
      h24: { buys: 300, sells: 200 },
    },
    holders: null,
    top10Pct: 100,
    mintAuthority: "UNKNOWN",
    freezeAuthority: "UNKNOWN",
    boostsActive: 0,
    pairCount: 1,
    source: "dexscreener",
    fetchedAt: "2026-09-26T01:00:00.000Z",
    ...partial,
  } as TokenSnapshot;
}

describe("flowFeaturesAtT0", () => {
  it("calcule les agrégats de base", () => {
    const s = [snap({})];
    const f = flowFeaturesAtT0(s, 0);
    expect(f.buysM5).toBe(120);
    expect(f.sellsM5).toBe(80);
    expect(f.netM5).toBe(40);
    expect(f.dominanceM5).toBeCloseTo(0.6, 10);
    // ratio lissé : (120.5)/(80.5)
    expect(f.ratioM5).toBeCloseTo(120.5 / 80.5, 10);
    // accélération : 12 * 120 / 300 = 4.8
    expect(f.accelBuys).toBeCloseTo(4.8, 10);
    expect(f.volM5).toBe(1000);
    expect(f.avgSizeM5).toBeCloseTo(1000 / 200, 10);
    // structChgPre null : t0 est le premier snapshot
    expect(f.structChgPre).toBeNull();
    // structM5vsH1 : log(120.5/80.5) - log(300.5/200.5)
    expect(f.structM5vsH1).toBeCloseTo(
      Math.log(120.5 / 80.5) - Math.log(300.5 / 200.5),
      10,
    );
  });

  it("divergence prix/dominance : prix monte + sells dominent => positif", () => {
    const s = [
      snap({
        priceChange: { m5: 10, h1: 10, h6: 10, h24: 10 },
        txns: {
          m5: { buys: 30, sells: 70 },
          h1: { buys: 30, sells: 70 },
          h6: { buys: 30, sells: 70 },
          h24: { buys: 30, sells: 70 },
        },
      }),
    ];
    const f = flowFeaturesAtT0(s, 0);
    // -sign(+10) * (0.3 - 0.5) = +0.2
    expect(f.divPriceDominance).toBeCloseTo(0.2, 10);
  });

  it("divergence prix/dominance : prix monte + buys dominent => négatif", () => {
    const s = [snap({})];
    const f = flowFeaturesAtT0(s, 0);
    // -sign(+5) * (0.6 - 0.5) = -0.1
    expect(f.divPriceDominance).toBeCloseTo(-0.1, 10);
  });

  it("structChgPre compare t0 au snapshot précédent", () => {
    const prev = snap({
      fetchedAt: "2026-09-26T00:50:00.000Z",
      txns: {
        m5: { buys: 50, sells: 50 },
        h1: { buys: 50, sells: 50 },
        h6: { buys: 50, sells: 50 },
        h24: { buys: 50, sells: 50 },
      },
    });
    const cur = snap({ fetchedAt: "2026-09-26T01:00:00.000Z" });
    const f = flowFeaturesAtT0([prev, cur], 1);
    expect(f.structChgPre).toBeCloseTo(
      Math.log(120.5 / 80.5) - Math.log(50.5 / 50.5),
      10,
    );
  });

  it("gère les zéros sans division par zéro", () => {
    const s = [
      snap({
        txns: {
          m5: { buys: 0, sells: 0 },
          h1: { buys: 0, sells: 0 },
          h6: { buys: 0, sells: 0 },
          h24: { buys: 0, sells: 0 },
        },
        volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
      }),
    ];
    const f = flowFeaturesAtT0(s, 0);
    expect(f.dominanceM5).toBeNull();
    expect(f.accelBuys).toBeNull();
    expect(f.avgSizeM5).toBeNull();
    expect(f.divPriceDominance).toBeNull();
    expect(f.ratioM5).toBeCloseTo(1, 10); // (0.5)/(0.5)
    expect(Number.isFinite(f.structM5vsH1)).toBe(true);
  });

  it("FEATURE_NAMES et FEATURE_LABELS sont cohérents", () => {
    expect(FEATURE_NAMES.length).toBeGreaterThanOrEqual(10);
    for (const n of FEATURE_NAMES) expect(FEATURE_LABELS[n]).toBeTruthy();
  });
});

describe("stats complémentaires", () => {
  it("spearmanP : corrélation parfaite => p très petite", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const p = spearmanP(1, xs.length);
    expect(p).toBe(0);
    const p0 = spearmanP(0, 10);
    expect(p0).toBeCloseTo(1, 6);
  });

  it("spearmanP : corrélation modérée n=50", () => {
    // rho=0.3, n=50 : t = 0.3*sqrt(48/0.91) ≈ 2.18 => p ≈ 0.034
    const p = spearmanP(0.3, 50);
    expect(p).not.toBeNull();
    expect(p!).toBeGreaterThan(0.02);
    expect(p!).toBeLessThan(0.05);
  });

  it("spearmanP : n < 4 => null", () => {
    expect(spearmanP(0.5, 3)).toBeNull();
  });

  it("medianDiffBootstrapCI : échantillons séparés => IC exclut 0", () => {
    const a = Array.from({ length: 30 }, (_, i) => 10 + i * 0.1);
    const b = Array.from({ length: 30 }, (_, i) => i * 0.1);
    const ci = medianDiffBootstrapCI(a, b, 500);
    expect(ci).not.toBeNull();
    expect(ci![0]).toBeGreaterThan(0);
  });

  it("spearmanBootstrapCI : corrélation forte => IC positif", () => {
    const xs = Array.from({ length: 40 }, (_, i) => i);
    const ys = xs.map((v) => v * 2 + 1);
    const ci = spearmanBootstrapCI(xs, ys, 500);
    expect(ci).not.toBeNull();
    expect(ci![0]).toBeGreaterThan(0.9);
  });

  it("summarize : quantiles et taux de pertes extrêmes", () => {
    const s = summarize([-0.9, -0.6, -0.2, 0, 0.1, 0.5, 2.0]);
    expect(s).not.toBeNull();
    expect(s!.n).toBe(7);
    expect(s!.median).toBe(0);
    expect(s!.extremeLossRate).toBeCloseTo(2 / 7, 10);
    expect(s!.min).toBe(-0.9);
    expect(s!.max).toBe(2.0);
    expect(s!.q05).toBeLessThanOrEqual(s!.q25!);
    expect(s!.q75).toBeLessThanOrEqual(s!.q95!);
  });

  it("summarize : vide => null", () => {
    expect(summarize([])).toBeNull();
  });

  it("winsorize : plafonne aux quantiles", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000];
    const w = winsorize(a, 0, 0.9);
    expect(Math.max(...w)).toBeLessThan(1000);
    expect(w.length).toBe(a.length);
  });
});
