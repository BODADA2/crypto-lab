import { describe, expect, it } from "vitest";
import {
  aberrantMask,
  bootstrapCI,
  deciles,
  findT0,
  futureReturns,
  hashMint,
  median,
  spearman,
  splitUniverse,
} from "../lab/predictive/universe.ts";
import type { TokenSnapshot } from "../lab/types.ts";

function snap(priceUsd: number, liquidityUsd: number, fetchedAt: string): TokenSnapshot {
  return {
    mint: "m",
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
    fdvUsd: 0,
    marketCapUsd: 0,
    volume: {},
    priceChange: {},
    txns: {},
    holders: null,
    top10Pct: null,
    mintAuthority: null,
    freezeAuthority: null,
    boostsActive: 0,
    pairCount: 1,
    source: "test",
    fetchedAt,
  } as unknown as TokenSnapshot;
}

describe("splitUniverse", () => {
  it("est déterministe et couvre les 3 univers", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(splitUniverse(`mint${i}`));
    expect(seen.has("discovery") && seen.has("calibration") && seen.has("holdout")).toBe(true);
    expect(splitUniverse("abc")).toBe(splitUniverse("abc"));
    expect(hashMint("abc")).toBe(hashMint("abc"));
  });
});

describe("findT0", () => {
  it("retourne le premier snapshot avec liquidité >= 20000", () => {
    const s = [
      snap(1, 100, "2026-09-28T00:00:00Z"),
      snap(1, 25000, "2026-09-28T00:05:00Z"),
      snap(1, 30000, "2026-09-28T00:10:00Z"),
    ];
    expect(findT0(s)).toBe(1);
    expect(findT0([snap(1, 100, "2026-09-28T00:00:00Z")])).toBe(-1);
  });
});

describe("aberrantMask", () => {
  it("marque un tick >=100x les deux voisins", () => {
    const s = [
      snap(1, 25000, "2026-09-28T00:00:00Z"),
      snap(192, 25000, "2026-09-28T00:05:00Z"),
      snap(1.01, 25000, "2026-09-28T00:10:00Z"),
    ];
    expect(aberrantMask(s)).toEqual([false, true, false]);
  });
  it("ne marque pas une vraie croissance 50x", () => {
    const s = [
      snap(1, 25000, "2026-09-28T00:00:00Z"),
      snap(50, 25000, "2026-09-28T00:05:00Z"),
      snap(55, 25000, "2026-09-28T00:10:00Z"),
    ];
    expect(aberrantMask(s)).toEqual([false, false, false]);
  });
});

describe("futureReturns", () => {
  it("calcule Y sur horizon couvert, null sinon", () => {
    const s = [
      snap(1, 25000, "2026-09-28T00:00:00Z"),
      snap(2, 25000, "2026-09-28T01:00:00Z"),
      snap(3, 25000, "2026-09-28T06:00:00Z"),
    ];
    const r = futureReturns(s, [3_600_000, 6 * 3_600_000, 24 * 3_600_000]);
    expect(r.map((x) => x.ret)).toEqual([1, 2]);
  });
  it("ignore les ticks aberrants dans Y", () => {
    const s = [
      snap(1, 25000, "2026-09-28T00:00:00Z"),
      snap(250, 25000, "2026-09-28T01:00:00Z"),
      snap(2, 25000, "2026-09-28T01:05:00Z"),
    ];
    const r = futureReturns(s, [3_600_000]);
    expect(r[0]!.ret).toBeCloseTo(1, 6);
  });
});

describe("stats", () => {
  it("spearman parfait sur relation monotone", () => {
    expect(spearman([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
  });
  it("median et deciles", () => {
    expect(median([3, 1, 2])).toBe(2);
    const d = deciles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(d.bin(1)).toBe(0);
    expect(d.bin(10)).toBe(8); // seuils [2..10], 10 > 8 seuils stricts
  });
  it("bootstrapCI encadre la moyenne", () => {
    const ci = bootstrapCI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(ci).not.toBeNull();
    expect(ci![0]! < 6.5 && ci![1]! > 6.5).toBe(true);
  });
});
