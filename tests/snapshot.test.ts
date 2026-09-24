// Chantier 1 — TokenSnapshot unifié : aucun champ perdu, inconnus explicites, lecture des anciens formats.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSnapshot, normalizeSnapshot, syncVolumeViews } from "../lab/collect/types.ts";
import { enrichSnapshot, toRiskSnapshot, UNKNOWN_AUTHORITY } from "../lab/collect/bridge.ts";
import { snapshotsFromPairs, type DexPairsResponse } from "../lab/collect/dexscreener.ts";
import { readHistoryFile } from "../lab/backtest/harness.ts";
import { evaluate } from "../lab/risk/engine.ts";
import { intent, policy, portfolio, snapshot, NOW, MINT_A } from "./execFixtures.ts";
import type { TokenSnapshot } from "../lab/types.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("TokenSnapshot unifié", () => {
  it("makeSnapshot : défauts = inconnus explicites et conservateurs, createdAt dérivé, vues plates synchronisées", () => {
    const s = makeSnapshot({ mint: MINT_A, fetchedAt: "2026-09-24T12:00:00.000Z" });
    expect(s).toMatchObject({
      chain: "solana",
      createdAt: "2026-09-24T12:00:00.000Z",
      pairCreatedAt: null,
      pairAddress: null,
      priceUsd: 0,
      liquidityUsd: 0,
      holders: null,
      top10Pct: 100,
      mintAuthority: UNKNOWN_AUTHORITY,
      freezeAuthority: UNKNOWN_AUTHORITY,
      volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
      volume5m: 0,
      source: "manual",
    });
    expect("decimals" in s).toBe(false);
    const t = makeSnapshot({ mint: MINT_A, fetchedAt: "2026-09-24T12:00:00.000Z", pairCreatedAt: Date.UTC(2026, 8, 24, 10), volume: { m5: 1, h1: 2, h6: 3, h24: 4 }, mintAuthority: null, decimals: 9 });
    expect(t.createdAt).toBe("2026-09-24T10:00:00.000Z");
    expect([t.volume5m, t.volume1h, t.volume24h]).toEqual([1, 2, 4]);
    expect(t.mintAuthority).toBeNull();
    expect(t.decimals).toBe(9);
    t.volume.m5 = 42;
    expect(syncVolumeViews(t).volume5m).toBe(42);
  });

  it("normalizeSnapshot : ancien format plat (volume5m, dexPair) et ancien format riche → même type, rien d'inventé", () => {
    const flat = normalizeSnapshot({ mint: MINT_A, symbol: "T", createdAt: "2026-09-24T10:00:00.000Z", priceUsd: 0.5, liquidityUsd: 30_000, volume5m: 10, volume1h: 100, volume24h: 1000, holders: 12, top10Pct: 25, mintAuthority: null, freezeAuthority: null, dexPair: "PAIR", source: "fixture", fetchedAt: "2026-09-24T12:00:00.000Z", decimals: 6 })!;
    expect(flat).toMatchObject({ volume: { m5: 10, h1: 100, h6: 0, h24: 1000 }, volume5m: 10, pairAddress: "PAIR", holders: 12, top10Pct: 25, mintAuthority: null, decimals: 6, pairCreatedAt: Date.parse("2026-09-24T10:00:00.000Z") });
    const rich = normalizeSnapshot(JSON.parse(readFileSync(join(FIXTURES, "history", "Fix1AaBbCcDdEeFfGgHhJjKkMmNnPpQqRrSsTtUuVvWw.jsonl"), "utf8").split("\n")[0]!))!;
    expect(rich.createdAt).toBe(new Date(rich.pairCreatedAt!).toISOString());
    expect(rich.top10Pct).toBe(100);
    expect(rich.mintAuthority).toBe(UNKNOWN_AUTHORITY);
    expect(rich.holders).toBe(202);
    expect(rich.volume24h).toBe(rich.volume.h24);
    // Ligne inutilisable ou champs absurdes.
    expect(normalizeSnapshot({ mint: MINT_A })).toBeNull();
    expect(normalizeSnapshot("x")).toBeNull();
    expect(normalizeSnapshot({ mint: MINT_A, fetchedAt: "2026-09-24T12:00:00.000Z", priceUsd: "abc", holders: "12", mintAuthority: 5 })).toMatchObject({ priceUsd: 0, holders: null, mintAuthority: UNKNOWN_AUTHORITY });
    // readHistoryFile normalise chaque ligne.
    const series = readHistoryFile(join(FIXTURES, "history", "Fix2AaBbCcDdEeFfGgHhJjKkMmNnPpQqRrSsTtUuVvWw.jsonl"));
    expect(series.every((s) => s.top10Pct === 100 && s.volume5m === s.volume.m5 && typeof s.createdAt === "string")).toBe(true);
  });

  it("fixture DexScreener réelle → snapshot : chaque champ de la paire est conservé, le Risk Engine refuse tant que rien n'est vérifié", () => {
    const pairs = (JSON.parse(readFileSync(join(FIXTURES, "dexscreener", "latest-dex-tokens.json"), "utf8")) as DexPairsResponse).pairs ?? [];
    const snaps = snapshotsFromPairs(pairs, NOW.toISOString());
    expect(snaps.length).toBeGreaterThan(0);
    for (const s of snaps) {
      const p = pairs.find((x) => x.baseToken.address === s.mint)!;
      expect(s.pairAddress).toBeTruthy();
      expect(s.txns.h24.buys).toBeGreaterThanOrEqual(0);
      expect(s.fdvUsd === null || typeof s.fdvUsd === "number").toBe(true);
      expect(s.symbol).toBe(p.baseToken.symbol);
      expect([s.volume5m, s.volume1h, s.volume24h]).toEqual([s.volume.m5, s.volume.h1, s.volume.h24]);
      expect(s.holders).toBeNull();
      expect(s.mintAuthority).toBe(UNKNOWN_AUTHORITY);
      expect(s.createdAt).toBe(s.pairCreatedAt ? new Date(s.pairCreatedAt).toISOString() : s.fetchedAt);
    }
    const one = snaps[0]!;
    const verdict = evaluate(intent({ mint: one.mint }), portfolio(), one, policy(), NOW);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join()).toMatch(/MINT_AUTHORITY|TOP10_MAX/);
  });

  it("enrichSnapshot (= toRiskSnapshot) : applique autorités, top10, decimals, extensions ; copie profonde ; top10 null reste 100", () => {
    const base = makeSnapshot({ mint: MINT_A, fetchedAt: NOW.toISOString(), volume: { m5: 5, h1: 6, h6: 7, h24: 8 } });
    const e = enrichSnapshot(base, { mintAuthority: null, freezeAuthority: "FRZ", top10Pct: 12, decimals: 6, riskyExtensions: ["TransferFeeConfig"], holders: 300 });
    expect(e).toMatchObject({ mintAuthority: null, freezeAuthority: "FRZ", top10Pct: 12, decimals: 6, riskyExtensions: ["TransferFeeConfig"], holders: 300, volume5m: 5 });
    expect(base.mintAuthority).toBe(UNKNOWN_AUTHORITY);
    e.volume.m5 = 99;
    expect(base.volume.m5).toBe(5);
    expect(toRiskSnapshot(base, { top10Pct: null }).top10Pct).toBe(100);
    expect(toRiskSnapshot(base).holders).toBeNull();
  });

  it("le snapshot de test des plans risque/exécution est un TokenSnapshot complet accepté par le Risk Engine", () => {
    const s: TokenSnapshot = snapshot();
    expect(evaluate(intent(), portfolio(), s, policy(), NOW).allowed).toBe(true);
    expect(s.volume5m).toBe(s.volume.m5);
  });
});
