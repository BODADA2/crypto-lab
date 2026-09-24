import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthSeries } from "../lab/backtest/synth.ts";
import { computeVolumeSignal, rankVolumeSignals, mean, std } from "../lab/signals/volume.ts";
import { computeEarlyBuyerOverlap, rankWeight, writeWalletProfiles, type EarlyBuyerSet } from "../lab/signals/earlybuyers.ts";
import { computeNarratives, tokenize, type NarrativeDoc } from "../lab/signals/narrative.ts";
import type { TokenSnapshot } from "../lab/types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Série plate de 13 fenêtres (12 de référence + 1 courante) avec volume constant. */
function flat(overrides: Partial<TokenSnapshot> = {}, bars = 13): TokenSnapshot[] {
  const base = synthSeries({ mint: "FlatMint1111111111111111111111111111111111111", bars, seed: 3, liquidity0: 50_000 });
  return base.map((s, i) => ({
    ...s,
    volume: { ...s.volume, m5: 1000 },
    holders: 100 + i * 2,
    liquidityUsd: 50_000,
    txns: { ...s.txns, m5: { buys: 5, sells: 5 } },
    ...overrides,
  }));
}

describe("signal volume", () => {
  it("mean/std", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(std([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(std([1])).toBe(0);
  });

  it("volume constant → z≈0, score faible, éligible", () => {
    const sig = computeVolumeSignal(flat());
    expect(sig.eligible).toBe(true);
    expect(sig.components.zScore).toBeCloseTo(0, 5);
    expect(sig.score).toBeLessThan(20);
    expect(sig.reasons.join(" ")).toMatch(/z=0\.00/);
  });

  it("pic de volume x10 avec holders accélérant → score élevé et explication", () => {
    const series = flat();
    const last = series[series.length - 1]!;
    last.volume.m5 = 10_000;
    last.holders = 160; // saut vs +2/fenêtre
    last.txns.m5 = { buys: 40, sells: 8 };
    const sig = computeVolumeSignal(series);
    expect(sig.eligible).toBe(true);
    expect(sig.components.zScore).toBeGreaterThan(4);
    expect(sig.components.holderAcceleration).toBeGreaterThan(3);
    expect(sig.components.volumeToLiquidity).toBeCloseTo(0.2);
    expect(sig.score).toBeGreaterThanOrEqual(80);
    expect(sig.reasons.some((r) => r.includes("volume 5 min 10000 $"))).toBe(true);
    expect(sig.reasons.some((r) => r.startsWith("holders +"))).toBe(true);
  });

  it("token trop jeune → inéligible, score 0, raison explicite", () => {
    const series = flat();
    const last = series[series.length - 1]!;
    last.pairCreatedAt = Date.parse(last.fetchedAt) - 5 * 60_000;
    last.volume.m5 = 50_000;
    const sig = computeVolumeSignal(series, { minAgeMin: 10 });
    expect(sig.eligible).toBe(false);
    expect(sig.score).toBe(0);
    expect(sig.reasons[0]).toMatch(/âge 5\.0 min < 10 min/);
  });

  it("liquidité sous le minimum ou inconnue → inéligible", () => {
    expect(computeVolumeSignal(flat({ liquidityUsd: 5_000 })).reasons[0]).toMatch(/liquidité 5000 \$ < 20000/);
    expect(computeVolumeSignal(flat({ liquidityUsd: 0 })).reasons[0]).toMatch(/liquidité inconnue/); // 0 = inconnue
  });

  it("historique insuffisant (< 6 fenêtres) → inéligible ; série vide → score 0", () => {
    const sig = computeVolumeSignal(flat({}, 4));
    expect(sig.eligible).toBe(false);
    expect(sig.reasons.join(" ")).toMatch(/historique insuffisant/);
    expect(computeVolumeSignal([]).score).toBe(0);
  });

  it("rankVolumeSignals trie par score décroissant", () => {
    const hot = flat({ mint: "HotMint11111111111111111111111111111111111111" });
    hot[hot.length - 1]!.volume.m5 = 20_000;
    const map = new Map<string, TokenSnapshot[]>([["cold", flat()], ["hot", hot]]);
    const ranked = rankVolumeSignals(map);
    expect(ranked[0]!.mint).toBe("HotMint11111111111111111111111111111111111111");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("détecte les pumps d'une série synthétique et reste calme ailleurs", () => {
    const series = synthSeries({ mint: "SynMint1111111111111111111111111111111111111", bars: 60, pumpsAt: [40], seed: 7, liquidity0: 60_000 });
    const before = computeVolumeSignal(series.slice(0, 39));
    const during = computeVolumeSignal(series.slice(0, 41));
    expect(during.score).toBeGreaterThan(before.score + 30);
  });
});

describe("early-buyer overlap", () => {
  const W = (n: number) => `Wallet${n}`.padEnd(44, "x");
  function sets(): EarlyBuyerSet[] {
    // W1 : premier acheteur de 4 tokens ; W2 : rang tardif dans 3 tokens ; W3 : 2 tokens ; W4 : 1 token.
    const mk = (mint: string, buyers: Array<[string, number]>): EarlyBuyerSet => ({ mint, buyers: buyers.map(([wallet, rank]) => ({ wallet, rank })) });
    return [
      mk("T1", [[W(1), 0], [W(2), 45], [W(3), 3], [W(4), 10]]),
      mk("T2", [[W(1), 1], [W(2), 48], [W(3), 7]]),
      mk("T3", [[W(1), 0], [W(2), 40], [W(9), 2], [W(9), 5]]),
      mk("T4", [[W(1), 2], [W(5), 60]]),
    ];
  }

  it("rankWeight décroît avec le rang", () => {
    expect(rankWeight(0, 50)).toBe(1);
    expect(rankWeight(49, 50)).toBeCloseTo(0.25);
    expect(rankWeight(200, 50)).toBe(0.25);
  });

  it("ne garde que les wallets présents dans ≥ K tokens, triés par score", () => {
    const profiles = computeEarlyBuyerOverlap(sets(), { minRecurrence: 3, now: () => 0 });
    expect(profiles.map((p) => p.address)).toEqual([W(1), W(2)]);
    expect(profiles[0]!.recurrence).toBe(4);
    expect(profiles[0]!.universe).toBe(4);
    expect(profiles[0]!.score).toBeGreaterThan(profiles[1]!.score);
    expect(profiles[0]!.avgRank).toBeCloseTo(0.75);
    expect(profiles[0]!.computedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("un wallet compte une seule fois par token, rangs ≥ topN ignorés, liste d'exclusion", () => {
    const profiles = computeEarlyBuyerOverlap(sets(), { minRecurrence: 2 });
    const w9 = profiles.find((p) => p.address === W(9));
    expect(w9).toBeUndefined(); // 2 rangs dans T3 mais un seul token
    const w5 = profiles.find((p) => p.address === W(5));
    expect(w5).toBeUndefined(); // rang 60 ≥ topN
    const excluded = computeEarlyBuyerOverlap(sets(), { minRecurrence: 2, ignore: new Set([W(1)]) });
    expect(excluded.some((p) => p.address === W(1))).toBe(false);
  });

  it("écrit data/wallets/<address>.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "wallets-"));
    tmpDirs.push(dir);
    const profiles = computeEarlyBuyerOverlap(sets(), { minRecurrence: 3 });
    const paths = writeWalletProfiles(profiles, dir);
    expect(paths.length).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([`${W(1)}.json`, `${W(2)}.json`].sort());
    const j = JSON.parse(readFileSync(paths[0]!, "utf8")) as { address: string; appearances: unknown[] };
    expect(j.address).toBe(W(1));
    expect(j.appearances.length).toBe(4);
  });
});

describe("narratifs", () => {
  const NOW = Date.UTC(2026, 8, 24, 12);
  const H = 3_600_000;
  const D = 24 * H;
  function docs(): NarrativeDoc[] {
    const out: NarrativeDoc[] = [];
    // Terme « agents » : 6 mentions sur 24 h dans 4 docs, 2 mentions sur les 7 jours avant.
    out.push({ at: NOW - 1 * H, text: "ai agents launchpad agents", source: "reddit" });
    out.push({ at: NOW - 2 * H, text: "agents framework token", source: "github" });
    out.push({ at: NOW - 5 * H, text: "AGENTS agents", source: "token" });
    out.push({ at: NOW - 20 * H, text: "agents everywhere", source: "reddit" });
    out.push({ at: NOW - 3 * D, text: "agents", source: "reddit" });
    out.push({ at: NOW - 5 * D, text: "agents", source: "reddit" });
    // Terme « validator » : stable (3/24 h, 21 sur 7 j).
    for (let i = 0; i < 3; i++) out.push({ at: NOW - (i + 1) * H, text: "validator update", source: "reddit" });
    for (let i = 0; i < 21; i++) out.push({ at: NOW - D - H - i * 7 * H, text: "validator", source: "reddit" });
    // Spam : un seul document répète 10 fois « giveaway ».
    out.push({ at: NOW - 1 * H, text: Array(10).fill("giveaway").join(" "), source: "reddit" });
    // Trop vieux : ignoré.
    out.push({ at: NOW - 30 * D, text: "agents agents agents", source: "reddit" });
    // Stopwords.
    out.push({ at: NOW - 1 * H, text: "the solana token pump moon", source: "reddit" });
    return out;
  }

  it("tokenize : minuscules, $TICKER conservé, hex écarté", () => {
    expect(tokenize("Hello $AGENTS world 0123abcdef0123abcdef ab")).toEqual(["hello", "$AGENTS", "world"]);
  });

  it("classe « agents » devant « validator » (accélération vs base 7 j)", () => {
    const terms = computeNarratives(docs(), { now: () => NOW });
    expect(terms[0]!.term).toBe("agents");
    expect(terms[0]!.count24h).toBe(6);
    expect(terms[0]!.docs24h).toBe(4);
    expect(terms[0]!.count7d).toBe(2);
    expect(terms[0]!.growth).toBeGreaterThan(4);
    const validator = terms.find((t) => t.term === "validator")!;
    expect(validator.baselinePerDay).toBe(3);
    expect(validator.growth).toBeCloseTo(1, 5);
    expect(terms[0]!.sources).toEqual({ reddit: 3, github: 1, token: 2 });
  });

  it("filtre spam (1 doc), stopwords, hors fenêtre ; limite top N", () => {
    const terms = computeNarratives(docs(), { now: () => NOW });
    const names = terms.map((t) => t.term);
    expect(names).not.toContain("giveaway");
    expect(names).not.toContain("solana");
    expect(names).not.toContain("the");
    expect(computeNarratives(docs(), { now: () => NOW, top: 1 }).length).toBe(1);
    expect(computeNarratives([], { now: () => NOW })).toEqual([]);
  });
});

describe("job early-buyers (Helius hors ligne)", () => {
  it("lit les migrations, interroge Helius, met en cache, écrit les wallets et les crédits", async () => {
    const { createFakeFetch, loadFixture } = await import("./helpers/fakeFetch.ts");
    const { createHeliusClient } = await import("../lab/collect/helius.ts");
    const { runEarlyBuyersJob, readMigrations } = await import("../lab/signals/run-earlybuyers.ts");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const addr = loadFixture<{ MINT: string; CREATOR: string }>("helius/addresses.json");
    const txs = loadFixture<Record<string, { result: unknown }>>("helius/transactions.json");
    const ff = createFakeFetch([
      {
        match: "helius-rpc.com",
        body: (_u, init) => {
          const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: [string] };
          if (req.method === "getSignaturesForAddress") return { jsonrpc: "2.0", id: req.id, result: loadFixture<{ result: unknown }>("helius/signatures-mint.json").result };
          return { jsonrpc: "2.0", id: req.id, result: txs[req.params[0]]?.result ?? null };
        },
      },
    ]);
    const dataDir = mkdtempSync(join(tmpdir(), "eb-"));
    tmpDirs.push(dataDir);
    mkdirSync(join(dataDir, "scans"), { recursive: true });
    writeFileSync(
      join(dataDir, "scans", "pump-2026-09-24.jsonl"),
      [
        { kind: "create", mint: addr.MINT, receivedAt: "2026-09-24T08:00:00.000Z" },
        { kind: "migrate", mint: addr.MINT, receivedAt: "2026-09-24T09:00:00.000Z" },
        { kind: "migrate", mint: addr.MINT, receivedAt: "2026-09-24T09:01:00.000Z" },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    expect(readMigrations(join(dataDir, "scans")).length).toBe(1);
    const helius = createHeliusClient({ fetch: ff.fetch, apiKey: "t", minIntervalMs: 0 });
    const now = () => Date.UTC(2026, 8, 24, 12);
    const res = await runEarlyBuyersJob({ dataDir, helius, minRecurrence: 1, now });
    expect(res.tokens).toBe(1);
    expect(res.wallets).toBe(4);
    expect(res.credits).toBe(7);
    expect(readdirSync(join(dataDir, "wallets"))).toContain(`${addr.CREATOR}.json`);
    const meta = JSON.parse(readFileSync(join(dataDir, "meta.json"), "utf8")) as { heliusCreditsMonth: number };
    expect(meta.heliusCreditsMonth).toBe(7);
    // Second passage : cache → aucun crédit supplémentaire.
    const calls = ff.calls.length;
    const again = await runEarlyBuyersJob({ dataDir, helius, minRecurrence: 1, now });
    expect(again.credits).toBe(0);
    expect(ff.calls.length).toBe(calls);
  });
});
