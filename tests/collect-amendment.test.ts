import { describe, it, expect } from "vitest";

describe("amendement 1 — liste des tokens observés", async () => {
  const { selectMintsToPoll, loadRecentMigrations, DEAD_LIQUIDITY_USD } = await import("../lab/collect/run.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const now = Date.parse("2026-10-01T12:00:00Z");

  it("nouveaux, puis migrés, puis suivis vivants du plus liquide au moins liquide, sans doublon, plafonné", () => {
    const tracked = [
      { mint: "LOW", liquidityUsd: 8_000, lastSeen: now },
      { mint: "DEAD", liquidityUsd: DEAD_LIQUIDITY_USD - 1, lastSeen: now },
      { mint: "HIGH", liquidityUsd: 90_000, lastSeen: now },
      { mint: "OLD", liquidityUsd: 90_000, lastSeen: now - 8 * 86_400_000 },
      { mint: "NEW", liquidityUsd: 50_000, lastSeen: now },
    ];
    expect(selectMintsToPoll({ fresh: ["NEW"], migrated: ["MIG", "DEAD"], tracked, now, cap: 10 })).toEqual(["NEW", "MIG", "HIGH", "LOW"]);
    expect(selectMintsToPoll({ fresh: ["NEW"], migrated: ["MIG"], tracked, now, cap: 2 })).toEqual(["NEW", "MIG"]);
  });

  it("lit les migrations des 48 dernières heures seulement", () => {
    const dir = mkdtempSync(join(tmpdir(), "scans-"));
    const ev = (mint: string, iso: string, kind = "migrate") => JSON.stringify({ kind, mint, receivedAt: iso });
    writeFileSync(join(dir, "pump-2026-09-28.jsonl"), ev("TOO_OLD", "2026-09-28T10:00:00Z") + "\n");
    writeFileSync(join(dir, "pump-2026-09-30.jsonl"), [ev("A", "2026-09-30T13:00:00Z"), ev("C", "2026-09-30T13:05:00Z", "create")].join("\n") + "\n");
    writeFileSync(join(dir, "pump-2026-10-01.jsonl"), ev("B", "2026-10-01T11:00:00Z") + "\n");
    expect(loadRecentMigrations(dir, now)).toEqual(["B", "A"]);
  });
});

describe("hypothèse 2 — Robinhood Chain", async () => {
  const { snapshotsFromPairs } = await import("../lab/collect/dexscreener.ts");
  const pair = (chainId: string, address: string, liq: number) =>
    ({ chainId, dexId: "uniswap", pairAddress: `P-${chainId}-${liq}`, baseToken: { address, symbol: "CAT", name: "Cat" }, priceUsd: "1", liquidity: { usd: liq }, volume: { m5: 1, h1: 2, h6: 3, h24: 4 }, txns: {}, pairCreatedAt: 1_780_000_000_000 }) as never;

  it("ne garde que la chaîne demandée et étiquette le snapshot", () => {
    const pairs = [pair("robinhood", "0xAbC", 60_000), pair("solana", "SoLMint", 50_000), pair("robinhood", "0xAbC", 8_000)];
    const rh = snapshotsFromPairs(pairs, "2026-09-26T00:00:00Z", "robinhood");
    expect(rh.map((s) => [s.mint, s.chain, s.liquidityUsd])).toEqual([["0xAbC", "robinhood", 60_000]]);
    const sol = snapshotsFromPairs(pairs, "2026-09-26T00:00:00Z");
    expect(sol.map((s) => [s.mint, s.chain])).toEqual([["SoLMint", "solana"]]);
  });
});
