/**
 * Tests DOMAINE 5/5 — TEMPORAL STRUCTURE (features + analyse).
 * Séries synthétiques à cadence irrégulière ; aucun accès réseau.
 */
import { describe, expect, it } from "vitest";
import type { TokenSnapshot } from "../lab/types.ts";
import { hourCyclic, temporalFeatures } from "../lab/predictive/temporal/features.ts";
import {
  analyzeVariable,
  bootstrapStat,
  coverage,
  hashParity,
  maxDrawdown,
  removeValidOutliers,
  type Row,
} from "../lab/predictive/temporal/analyze.ts";

const T0 = Date.parse("2026-09-26T06:30:00.000Z");

function snap(
  fetchedAt: string,
  priceUsd: number,
  liquidityUsd: number,
  pairCreatedAt: number | null = T0 - 7_200_000,
): TokenSnapshot {
  return {
    mint: "mint-test",
    chain: "solana",
    symbol: "T",
    name: "T",
    createdAt: new Date(T0 - 7_200_000).toISOString(),
    pairCreatedAt,
    pairAddress: null,
    dexId: "pumpswap",
    url: null,
    priceUsd,
    liquidityUsd,
    fdvUsd: null,
    marketCapUsd: null,
    volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
    txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
    holders: null,
    top10Pct: 100,
    mintAuthority: "UNKNOWN",
    freezeAuthority: "UNKNOWN",
    boostsActive: 0,
    pairCount: 1,
    source: "test",
    fetchedAt,
  } as unknown as TokenSnapshot;
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe("temporalFeatures", () => {
  it("retourne null sans t0 (liquidité < 20k partout)", () => {
    const s = [snap(iso(T0 - 3600e3), 1, 5000), snap(iso(T0), 1.2, 15000)];
    expect(temporalFeatures(s)).toBeNull();
  });

  it("mesure croissance, âge, heure et activité sur série irrégulière", () => {
    const s = [
      snap(iso(T0 - 90 * 60e3), 1, 5000), // t-90min
      snap(iso(T0 - 60 * 60e3), 2, 8000), // t-60min (pas régulier)
      snap(iso(T0 - 30 * 60e3), 2.5, 12000), // t-30min
      snap(iso(T0), 4, 25000), // t0
    ];
    const f = temporalFeatures(s)!;
    expect(f).not.toBeNull();
    expect(f.nPreT0).toBe(3);
    // croissance : ln(4/1) sur 1.5h
    expect(f.growthPreT0PerH).toBeCloseTo(Math.log(4) / 1.5, 6);
    // âge paire : 2h
    expect(f.agePairMs).toBe(7_200_000);
    expect(f.ageTokenMs).toBe(7_200_000);
    // heure UTC : 6h30
    expect(f.hourUTC).toBeCloseTo(6.5, 6);
    // inter-snapshots : 30min en moyenne
    expect(f.interSnapMeanMs).toBeCloseTo(30 * 60e3, 0);
    expect(f.priceAtT0).toBe(4);
    expect(f.liqAtT0).toBe(25000);
  });

  it("agePairMs null quand pairCreatedAt null", () => {
    const s = [snap(iso(T0 - 3600e3), 1, 5000, null), snap(iso(T0), 2, 25000, null)];
    const f = temporalFeatures(s)!;
    expect(f.agePairMs).toBeNull();
    expect(f.ageTokenMs).not.toBeNull();
  });

  it("détecte l'accélération (signe +) et la décélération (signe −)", () => {
    // ln p : 0, 0.5, 2 → accélère
    const acc = [
      snap(iso(T0 - 2 * 3600e3), 1, 5000),
      snap(iso(T0 - 3600e3), Math.exp(0.5), 8000),
      snap(iso(T0), Math.exp(2), 25000),
    ];
    const fa = temporalFeatures(acc)!;
    expect(fa.accelSign).toBe(1);
    expect(fa.accelPerH2).toBeCloseTo(1.0, 6);
    // ln p : 0, 1.5, 2 → décélère
    const dec = [
      snap(iso(T0 - 2 * 3600e3), 1, 5000),
      snap(iso(T0 - 3600e3), Math.exp(1.5), 8000),
      snap(iso(T0), Math.exp(2), 25000),
    ];
    const fd = temporalFeatures(dec)!;
    expect(fd.accelSign).toBe(-1);
    expect(fd.accelPerH2).toBeCloseTo(-1.0, 6);
  });

  it("retourne null si le tick t0 est aberrant", () => {
    const s = [
      snap(iso(T0 - 2 * 3600e3), 1, 5000),
      snap(iso(T0 - 3600e3), 1.1, 8000),
      snap(iso(T0), 100000, 25000), // ≥100x des voisins → t0 corrompu
      snap(iso(T0 + 3600e3), 1.05, 26000),
    ];
    expect(temporalFeatures(s)).toBeNull();
  });

  it("variables pré-t0 nulles quand t0 est au premier snapshot", () => {
    const s = [snap(iso(T0), 2, 25000), snap(iso(T0 + 3600e3), 2.2, 26000)];
    const f = temporalFeatures(s)!;
    expect(f.nPreT0).toBe(0);
    expect(f.growthPreT0PerH).toBeNull();
    expect(f.accelSign).toBeNull();
    expect(f.interSnapMeanMs).toBeNull();
    expect(f.agePairMs).toBe(7_200_000);
  });
});

describe("hourCyclic", () => {
  it("encode 0h et 6h correctement", () => {
    expect(hourCyclic(0).sin).toBeCloseTo(0, 9);
    expect(hourCyclic(0).cos).toBeCloseTo(1, 9);
    expect(hourCyclic(6).sin).toBeCloseTo(1, 9);
    expect(hourCyclic(6).cos).toBeCloseTo(0, 9);
  });
});

function mkRows(n: number, xfn: (i: number) => number, yfn: (i: number) => number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    mint: `mint${i}`,
    t0Time: T0 + i * 60_000,
    x: { v: xfn(i) },
    y: { "1h": yfn(i), "6h": null, "24h": null },
  }));
}

describe("analyzeVariable", () => {
  it("Spearman ≈ 1 sur relation monotone parfaite", () => {
    const a = analyzeVariable(mkRows(50, (i) => i, (i) => i * 0.1), "v", "1h");
    expect(a.n).toBe(50);
    expect(a.spearman).toBeCloseTo(1, 9);
    expect(a.spearmanCI![0]).toBeGreaterThan(0.9);
    expect(a.median).toBeCloseTo(2.45, 6);
  });

  it("déciles top/bottom ordonnés et n<30 → déciles null", () => {
    const a = analyzeVariable(mkRows(50, (i) => i, (i) => i), "v", "1h");
    expect(a.deciles).not.toBeNull();
    expect(a.deciles!.topMedian!).toBeGreaterThan(a.deciles!.botMedian!);
    expect(a.deciles!.topN + a.deciles!.botN).toBeLessThanOrEqual(50);
    const small = analyzeVariable(mkRows(20, (i) => i, (i) => i), "v", "1h");
    expect(small.deciles).toBeNull();
    expect(small.n).toBe(20);
  });

  it("stabilité : moitiés et cohortes couvrent tout l'échantillon", () => {
    const a = analyzeVariable(mkRows(50, (i) => i, (i) => i), "v", "1h");
    expect(a.nTimeA + a.nTimeB).toBe(50);
    expect(a.nCohA + a.nCohB).toBe(50);
    expect(a.stabTimeA).toBeCloseTo(1, 6);
    expect(a.stabCohA).not.toBeNull();
  });

  it("métriques de perte et drawdown cohérents", () => {
    const a = analyzeVariable(mkRows(10, (i) => i, (i) => (i % 2 === 0 ? -0.6 : 0.2)), "v", "1h");
    expect(a.pLoss).toBeCloseTo(0.5, 9);
    expect(a.pExtremeLoss).toBeCloseTo(0.5, 9);
    expect(a.drawdown).toBeGreaterThan(0);
    expect(a.min).toBe(-0.6);
    expect(a.max).toBe(0.2);
  });

  it("sans outliers : un extrême valide est retiré", () => {
    const rows = mkRows(200, (i) => i, (i) => (i === 199 ? 50 : i * 0.01));
    const a = analyzeVariable(rows, "v", "1h");
    expect(a.nNoOut).toBeLessThan(a.n);
    expect(a.meanNoOut!).toBeLessThan(a.mean!);
    expect(Math.abs(a.medianNoOut! - a.median!)).toBeLessThan(0.05); // médiane robuste
  });

  it("retourne n=0 proprement sans données", () => {
    const a = analyzeVariable([], "v", "1h");
    expect(a.n).toBe(0);
    expect(a.spearman).toBeNull();
    expect(a.median).toBeNull();
  });
});

describe("utilitaires", () => {
  it("maxDrawdown sur séquence connue", () => {
    expect(maxDrawdown([0.1, 0.1, -0.5, 0.1])).toBeCloseTo(0.5, 9);
    expect(maxDrawdown([0.1, 0.2])).toBe(0);
    expect(maxDrawdown([])).toBeNull();
  });

  it("bootstrapStat : IC contient la statistique", () => {
    const xs = Array.from({ length: 40 }, (_, i) => i);
    const ys = xs.map((x) => 2 * x);
    const ci = bootstrapStat(xs, ys, (a, b) => {
      const n = a.length;
      const m = a.reduce((s, v) => s + v, 0) / n;
      return b.reduce((s, v, i) => s + (a[i]! - m) * (v - m), 0);
    });
    expect(ci).not.toBeNull();
    expect(ci![0]).toBeLessThanOrEqual(ci![1]);
  });

  it("removeValidOutliers retire les extrêmes hors [P1, P99]", () => {
    const xs = Array.from({ length: 200 }, (_, i) => i);
    const ys = xs.map((i) => (i === 0 ? -100 : i === 199 ? 100 : i * 0.01));
    const t = removeValidOutliers(xs, ys);
    expect(t.ys.length).toBeLessThan(200);
    expect(t.ys).not.toContain(100);
    expect(t.ys).not.toContain(-100);
    expect(t.xs.length).toBe(t.ys.length);
  });

  it("coverage compte les Y non nulls par horizon", () => {
    const rows = mkRows(10, (i) => i, (i) => (i < 6 ? i * 0.01 : 0));
    rows.forEach((r, i) => {
      if (i >= 6) r.y["1h"] = null;
    });
    const c = coverage(rows, ["1h", "6h"]);
    expect(c["1h"]!.n).toBe(6);
    expect(c["1h"]!.pct).toBeCloseTo(60, 9);
    expect(c["6h"]!.n).toBe(0);
  });

  it("hashParity retourne 0 ou 1, déterministe", () => {
    expect([0, 1]).toContain(hashParity("abc"));
    expect(hashParity("abc")).toBe(hashParity("abc"));
  });
});
