/**
 * Tests — DOMAINE 3/5 liquidity (phase découverte).
 * Fixtures synthétiques uniquement : jamais data/track-unbiased/ (holdout gelé).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenSnapshot } from "../lab/types.ts";
import { analyzeVariable } from "../lab/predictive/liquidity/analysis.ts";
import {
  computeFeatures,
  loadAllFeatures,
  slope,
  varNames,
} from "../lab/predictive/liquidity/features.ts";

function snap(
  priceUsd: number,
  liquidityUsd: number,
  fetchedAt: string,
  extra: Partial<TokenSnapshot> = {},
): TokenSnapshot {
  return {
    mint: "testmint",
    chain: "solana",
    symbol: "T",
    name: "T",
    createdAt: fetchedAt,
    pairCreatedAt: null,
    pairAddress: null,
    dexId: "pumpswap",
    url: "",
    priceUsd,
    liquidityUsd,
    fdvUsd: 100_000,
    marketCapUsd: 100_000,
    volume: { m5: 1000, h1: 5000, h6: 5000, h24: 5000 },
    priceChange: {},
    txns: {},
    holders: null,
    top10Pct: 100,
    mintAuthority: "UNKNOWN",
    freezeAuthority: "UNKNOWN",
    boostsActive: 0,
    pairCount: 1,
    source: "test",
    fetchedAt,
    ...extra,
  } as unknown as TokenSnapshot;
}

describe("slope", () => {
  it("retourne la pente des moindres carrés", () => {
    expect(slope([0, 1, 2], [0, 2, 4])).toBeCloseTo(2, 6);
    expect(slope([0, 1], [0, 1])).toBeNull(); // n < 3
    expect(slope([1, 1, 1], [0, 1, 2])).toBeNull(); // variance x nulle
  });
});

describe("varNames", () => {
  it("contient les 10 variables du protocole", () => {
    const v = varNames();
    for (const name of [
      "liqT0", "turnoverM5", "turnoverH1", "liqPerVolH1", "mcLiq",
      "preGrowthRel", "liqSlopePre", "liqCVPre", "addsPre", "removesPre",
    ]) {
      expect(v).toContain(name);
    }
    expect(new Set(v).size).toBe(v.length); // pas de doublon
  });
});

describe("computeFeatures", () => {
  it("retourne null sans t0 (liquidité < 20000)", () => {
    const s = [snap(1, 100, "2026-09-28T00:00:00Z"), snap(2, 500, "2026-09-28T01:00:00Z")];
    expect(computeFeatures(s)).toBeNull();
  });

  it("calcule turnover et mcLiq à t0", () => {
    const s = [
      snap(1, 10_000, "2026-09-28T00:00:00Z"),
      snap(1, 30_000, "2026-09-28T01:00:00Z", { volume: { m5: 3000, h1: 6000, h6: 0, h24: 0 } }),
      snap(1.5, 35_000, "2026-09-28T02:00:00Z"),
    ];
    const f = computeFeatures(s)!;
    expect(f.liqT0).toBe(30_000);
    expect(f.turnoverM5).toBeCloseTo(0.1, 6);
    expect(f.turnoverH1).toBeCloseTo(0.2, 6);
    expect(f.liqPerVolH1).toBeCloseTo(5, 6);
    expect(f.mcLiq).toBeCloseTo(100_000 / 30_000, 6);
    expect(f.nPre).toBe(1);
    expect(f.preGrowthRel).toBeNull(); // nPre < 2
    expect(f.y["1h"]).toBeCloseTo(0.5, 6);
  });

  it("calcule croissance, CV, pente, ajouts/retraits pré-t0", () => {
    const s = [
      snap(1, 5_000, "2026-09-28T00:00:00Z"),
      snap(1, 10_000, "2026-09-28T00:10:00Z"), // +100 % => ajout
      snap(1, 4_000, "2026-09-28T00:20:00Z"), // -60 % => retrait
      snap(1, 25_000, "2026-09-28T01:00:00Z"), // t0
      snap(2, 30_000, "2026-09-28T02:00:00Z"),
    ];
    const f = computeFeatures(s)!;
    expect(f.nPre).toBe(3);
    expect(f.preGrowthRel).toBeCloseTo(4000 / 5000 - 1, 6);
    expect(f.addsPre).toBe(1);
    expect(f.removesPre).toBe(1);
    expect(f.liqCVPre).toBeGreaterThan(0);
    expect(f.liqSlopePre).not.toBeNull();
    expect(f.y["1h"]).toBeCloseTo(1, 6);
  });

  it("Y = null quand l'horizon n'est pas couvert (pas d'extrapolation)", () => {
    const s = [
      snap(1, 25_000, "2026-09-28T00:00:00Z"),
      snap(2, 30_000, "2026-09-28T00:30:00Z"),
    ];
    const f = computeFeatures(s)!;
    expect(f.y["1h"]).toBeNull();
    expect(f.y["6h"]).toBeNull();
  });

  it("n'assigne jamais un token au holdout biaisé : univers via splitUniverse", () => {
    const s = [snap(1, 25_000, "2026-09-28T00:00:00Z"), snap(2, 30_000, "2026-09-28T02:00:00Z")];
    const f = computeFeatures([{ ...s[0]!, mint: "abc" }, { ...s[1]!, mint: "abc" }])!;
    expect(["discovery", "calibration", "holdout"]).toContain(f.universe);
  });
});

describe("analyzeVariable", () => {
  it("détecte une relation monotone parfaite (Spearman = ±1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "liq-"));
    // 40 tokens synthétiques : liqT0 croissante, Y croissant.
    const feats = Array.from({ length: 40 }, (_, i) => ({
      mint: `m${i}`,
      universe: "discovery" as const,
      t0Time: i,
      t0Dex: "pumpswap",
      nSnaps: 3,
      nPre: 0,
      liqT0: 20_000 + i * 1000,
      turnoverM5: 0.1,
      turnoverH1: 0.2,
      liqPerVolH1: 5,
      mcLiq: 3,
      preGrowthRel: null,
      liqSlopePre: null,
      liqCVPre: null,
      addsPre: null,
      removesPre: null,
      y: { "1h": -0.5 + i * 0.025, "6h": null, "24h": null },
    }));
    const r = analyzeVariable(feats, "discovery", "liqT0", "1h")!;
    expect(r.spearman).toBeCloseTo(1, 6);
    expect(r.n).toBe(40);
    expect(r.top!.medianY).toBeGreaterThan(r.bottom!.medianY);
    expect(r.topMinusBottomMedian).toBeGreaterThan(0);
    expect(r.tempSignAgree).toBe(true);
    void dir;
  });

  it("retourne null si n < 10", () => {
    const feats = Array.from({ length: 9 }, (_, i) => ({
      mint: `m${i}`,
      universe: "discovery" as const,
      t0Time: i,
      t0Dex: "pumpswap",
      nSnaps: 2,
      nPre: 0,
      liqT0: 20_000,
      turnoverM5: 0.1,
      turnoverH1: 0.2,
      liqPerVolH1: 5,
      mcLiq: 3,
      preGrowthRel: null,
      liqSlopePre: null,
      liqCVPre: null,
      addsPre: null,
      removesPre: null,
      y: { "1h": 0.1, "6h": null, "24h": null },
    }));
    expect(analyzeVariable(feats, "discovery", "liqT0", "1h")).toBeNull();
  });
});

describe("loadAllFeatures (pipeline)", () => {
  it("charge un répertoire .jsonl et ignore les fichiers non-jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "liq-pipe-"));
    const s = [
      snap(1, 25_000, "2026-09-28T00:00:00Z", { mint: "pipeA" }),
      snap(2, 30_000, "2026-09-28T02:00:00Z", { mint: "pipeA" }),
    ];
    writeFileSync(join(dir, "a.jsonl"), s.map((x) => JSON.stringify(x)).join("\n"));
    writeFileSync(join(dir, "ignore.txt"), "nope");
    const feats = loadAllFeatures(dir);
    expect(feats.length).toBe(1);
    expect(feats[0]!.mint).toBe("pipeA");
    expect(feats[0]!.y["1h"]).toBeCloseTo(1, 6);
  });
});
