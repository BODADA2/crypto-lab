import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createSnipeTracker, inSample, pickSolPair, startPrice, type SnipeRecord } from "../lab/collect/snipe.ts";
import { evaluateSnipes, snipeReturn, SNIPE_COST } from "../lab/backtest/preregistered-snipe.ts";
import type { PumpEvent } from "../lab/collect/types.ts";

const T0 = Date.parse("2026-09-28T12:00:00Z");
const sampled = (() => { const out: string[] = []; for (let i = 0; out.length < 3; i++) { const m = `Mint${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxpump`; if (inSample(m)) out.push(m); } return out; })();
const create = (mint: string, atMs: number): PumpEvent => ({ kind: "create", mint, signature: null, name: "X", symbol: "X", traderPublicKey: null, solAmount: 1, marketCapSol: 30, pool: "pump", receivedAt: new Date(atMs).toISOString(), raw: { vSolInBondingCurve: 30, vTokensInBondingCurve: 1e9 }, lateDiscovery: false });
const pair = (mint: string, price: string) => ({ chainId: "solana", dexId: "pumpfun", url: "", pairAddress: "P" + mint, baseToken: { address: mint, name: "X", symbol: "X" }, quoteToken: { address: "So1", name: "Wrapped SOL", symbol: "SOL" }, priceNative: price, liquidity: { usd: 5000 }, txns: { m5: { buys: 3, sells: 1 } } });

describe("hypothèse 5 — suivi des snipes", () => {
  it("échantillon déterministe, prix de départ tiré de la courbe, paire pump.fun cotée en SOL", () => {
    expect(inSample(sampled[0] as string)).toBe(true);
    expect(startPrice(create("M", T0))).toBeCloseTo(3e-8);
    expect(pickSolPair([pair("A", "1"), pair("B", "2")] as never, "B")?.priceNative).toBe("2");
    expect(pickSolPair([pair("A", "1")] as never, "Z")).toBeNull();
  });

  it("relève +60 s et +300 s, ignore les tokens trop tardifs dans la fenêtre, écrit seulement les suivis complets", async () => {
    let t = T0;
    const prices: Record<string, string> = {};
    const dex = { getPairsByTokens: async (mints: string[]) => mints.filter((m) => prices[m]).map((m) => pair(m, prices[m] as string)) } as never;
    const dir = mkdtempSync(join(tmpdir(), "snipe-"));
    const tr = createSnipeTracker({ dex, dataDir: dir, windowEndMs: T0 + 600_000, now: () => t });
    const [a, b, late] = sampled as [string, string, string];
    tr.onCreate(create(a, T0));
    tr.onCreate(create(b, T0));
    tr.onCreate(create(late, T0 + 300_000)); // +300 s dépasserait la fenêtre
    expect(tr.size).toBe(2);
    prices[a] = "0.00000006";
    t = T0 + 61_000; await tr.tick();
    prices[a] = "0.00000009"; // b jamais indexé
    t = T0 + 301_000; await tr.tick();
    const res = await tr.finish();
    expect(res).toEqual({ written: 2, tracked: 2 });
    const recs = readFileSync(join(dir, "snipes-2026-09-28.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as SnipeRecord);
    const ra = recs.find((r) => r.mint === a)!;
    expect(ra.checks.map((c) => [c.target, c.p])).toEqual([[60, 6e-8], [300, 9e-8]]);
    expect(recs.find((r) => r.mint === b)!.checks.map((c) => c.p)).toEqual([null, null]);
  });
});

describe("hypothèse 5 — verdict", () => {
  const rec = (at: string, p60: number | null, p300: number | null): SnipeRecord => ({ mint: "M", symbol: null, createdAt: at, p0: 1, devBuySol: 1, checks: [{ target: 60, age: 61, p: p60, liqUsd: null, buysM5: null, sellsM5: null }, { target: 300, age: 301, p: p300, liqUsd: null, buysM5: null, sellsM5: null }] });
  it("parfait = achat à p0 ; réaliste = achat à +1 min ; prix absent = inchangé ; 5 % de coûts", () => {
    const r = rec("2026-09-30T00:00:00Z", 2, 3);
    expect(snipeReturn(r, "a")).toBeCloseTo(3 * (1 - SNIPE_COST) - 1);
    expect(snipeReturn(r, "b")).toBeCloseTo(1.5 * (1 - SNIPE_COST) - 1);
    expect(snipeReturn(rec("2026-09-30T00:00:00Z", null, null), "a")).toBeCloseTo(-SNIPE_COST);
  });
  it("trop de tokens sans prix → NON CONCLUANT ; pertes régulières → REJETÉE", () => {
    const missing = Array.from({ length: 40 }, () => rec("2026-09-30T00:00:00Z", null, null));
    expect(evaluateSnipes(missing).verdict).toBe("NON CONCLUANT");
    const losers = [...Array.from({ length: 40 }, () => rec("2026-09-30T00:00:00Z", 0.9, 0.5)), ...Array.from({ length: 40 }, () => rec("2026-10-08T00:00:00Z", 0.9, 0.5))];
    const v = evaluateSnipes(losers);
    expect(v.verdict).toBe("REJETÉE");
    expect(v.upAt5min).toBe(0);
  });
});
