import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeFetch, loadFixture, jsonResponse } from "./helpers/fakeFetch.ts";
import { startFakeWsServer, type FakeWsServer } from "./helpers/wsServer.ts";
import { createLimiter } from "../lab/collect/ratelimit.ts";
import { createDiskCache, createMemoryCache } from "../lab/collect/cache.ts";
import { createDexScreenerClient, snapshotsFromPairs, type DexPairsResponse, DexScreenerError } from "../lab/collect/dexscreener.ts";
import { createPumpPortalClient, parsePumpMessage, pumpFileName } from "../lab/collect/pumpportal.ts";
import { createHeliusClient, extractBuyers, tokenDeltas, type ParsedTransaction } from "../lab/collect/helius.ts";
import { createRedditClient, parseListing } from "../lab/collect/reddit.ts";
import { createGithubClient } from "../lab/collect/github.ts";
import { extractMints, extractTickers } from "../lab/collect/extract.ts";
import { runCollect } from "../lab/collect/run.ts";
import { toRiskSnapshot, UNKNOWN_AUTHORITY } from "../lab/collect/bridge.ts";
import { computeTop10, decodeMintAccountBase64, fetchMintInfo, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type JsonRpc } from "../lab/collect/mintinfo.ts";
import { encodeMintAccount } from "./helpers/mintAccount.ts";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "crypto-lab-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe("ratelimit", () => {
  it("laisse passer `max` appels puis impose une attente dans la fenêtre", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const lim = createLimiter({
      max: 3,
      windowMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < 4; i++) await lim.schedule(async () => i);
    expect(lim.count).toBe(4);
    expect(sleeps).toEqual([1000]);
    expect(lim.waitedMs).toBe(1000);
  });

  it("sérialise les appels concurrents (pas de rafale au-delà de max)", async () => {
    let clock = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const lim = createLimiter({ max: 2, windowMs: 100, now: () => clock, sleep: async (ms) => void (clock += ms) });
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        lim.schedule(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          inFlight--;
          return i;
        }),
      ),
    );
    expect(lim.count).toBe(5);
    expect(maxInFlight).toBe(1);
    expect(lim.waitedMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("cache disque", () => {
  it("stocke, relit et expire selon le TTL", () => {
    let clock = 1000;
    const dir = tmp();
    const cache = createDiskCache(dir, () => clock);
    cache.set("k", { a: 1 }, 500);
    expect(cache.get("k")).toEqual({ a: 1 });
    expect(existsSync(cache.path("k"))).toBe(true);
    clock += 600;
    expect(cache.get("k")).toBeUndefined();
    cache.delete("k");
    expect(existsSync(cache.path("k"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("dexscreener", () => {
  function client(now = () => 1790250000000) {
    const ff = createFakeFetch([
      { match: "/token-profiles/latest/v1", body: loadFixture("dexscreener/token-profiles.json") },
      { match: "/token-boosts/top/v1", body: loadFixture("dexscreener/token-boosts-top.json") },
      { match: "/latest/dex/tokens/", body: loadFixture("dexscreener/latest-dex-tokens.json") },
      { match: "/latest/dex/search", body: loadFixture("dexscreener/search.json") },
      { match: "/token-pairs/v1/solana/", body: loadFixture("dexscreener/token-pairs.json") },
    ]);
    const dex = createDexScreenerClient({ fetch: ff.fetch, cache: createMemoryCache(now), now, limiter: createLimiter({ max: 60, windowMs: 60_000, now }) });
    return { dex, ff };
  }

  it("filtre les profils sur solana et normalise les liens", async () => {
    const { dex } = client();
    const profiles = await dex.getLatestProfiles();
    expect(profiles.map((p) => p.chainId)).toEqual(["solana", "solana", "solana"]);
    expect(profiles[0]!.links.length).toBe(3);
    expect(profiles[0]!.description).toContain("POPCAT");
  });

  it("renvoie les boosts solana avec montants numériques", async () => {
    const { dex } = client();
    const boosts = await dex.getTopBoosts();
    expect(boosts.length).toBe(2);
    expect(boosts[0]!.totalAmount).toBe(530);
  });

  it("normalise `latest/dex/tokens` en TokenSnapshot : paire la plus liquide, volumes agrégés", async () => {
    const { dex } = client();
    const snaps = await dex.getSnapshots(["7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", "AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump"]);
    expect(snaps.length).toBe(2);
    const popcat = snaps.find((s) => s.symbol === "POPCAT")!;
    expect(popcat.pairAddress).toBe("FRhB8L7Y9Qq41qZXYLtC2nw8An1RJfLLxDw2usQd3uXu");
    expect(popcat.pairCount).toBe(2);
    expect(popcat.volume.h24).toBeCloseTo(4123456.78 + 512000.5, 2);
    expect(popcat.txns.m5).toEqual({ buys: 50, sells: 36 });
    expect(popcat.priceUsd).toBeCloseTo(0.2772);
    expect(popcat.pairCreatedAt).toBe(1702291200000);
    expect(popcat.boostsActive).toBe(130);
    expect(popcat.fetchedAt).toBe("2026-09-24T11:40:00.000Z");
    const agents = snaps.find((s) => s.symbol === "AGENTS")!;
    expect(agents.liquidityUsd).toBe(86000);
    expect(agents.holders).toBeNull();
  });

  it("utilise le cache : deux appels identiques = une seule requête", async () => {
    const { dex, ff } = client();
    await dex.getLatestProfiles();
    await dex.getLatestProfiles();
    expect(ff.calls.length).toBe(1);
    expect(dex.requestCount).toBe(1);
  });

  it("recherche et token-pairs ne renvoient que des paires ; erreur HTTP typée", async () => {
    const { dex } = client();
    const found = await dex.search("bonk");
    expect(found.length).toBe(2);
    const pairs = await dex.getTokenPairs("AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump");
    expect(pairs[0]!.dexId).toBe("pumpswap");
    const bad = createDexScreenerClient({ fetch: async () => new Response("rate limited", { status: 429 }), limiter: createLimiter({ max: 60, windowMs: 60_000 }) });
    await expect(bad.search("x")).rejects.toBeInstanceOf(DexScreenerError);
  });

  it("découpe les mints en lots de 30 par requête", async () => {
    const { dex, ff } = client();
    const mints = Array.from({ length: 61 }, (_, i) => `Mint${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`);
    await dex.getPairsByTokens(mints);
    expect(ff.calls.length).toBe(3);
  });

  it("snapshotsFromPairs ignore les chaînes autres que solana", () => {
    const resp = loadFixture<DexPairsResponse>("dexscreener/search.json");
    const snaps = snapshotsFromPairs(resp.pairs ?? [], "2026-09-24T00:00:00.000Z");
    expect(snaps.length).toBe(1);
    expect(snaps[0]!.mint).toBe("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
  });
});

// ---------------------------------------------------------------------------
describe("pumpportal", () => {
  let server: FakeWsServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("parsePumpMessage : création, migration, accusé de réception ignoré", () => {
    const create = parsePumpMessage(
      JSON.stringify({
        signature: "5abc",
        mint: "AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump",
        traderPublicKey: "DevWa11etCreat0rAbcDefGh1jKlMnOpQrStUvWxYz12",
        txType: "create",
        initialBuy: 60000000,
        solAmount: 1.5,
        bondingCurveKey: "CurveBond1ngPDA5xkq1vJ9v8v3F1uHk3QfTqYw8rY2ez",
        vTokensInBondingCurve: 1012000000,
        vSolInBondingCurve: 31.5,
        marketCapSol: 31.1,
        name: "AGENTS",
        symbol: "AGENTS",
        uri: "https://ipfs.io/ipfs/Qm",
        pool: "pump",
      }),
      1790244000000,
    )!;
    expect(create.kind).toBe("create");
    expect(create.symbol).toBe("AGENTS");
    expect(create.solAmount).toBe(1.5);
    expect(create.receivedAt).toBe("2026-09-24T10:00:00.000Z");
    const migrate = parsePumpMessage({ signature: "6def", mint: "AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump", txType: "migrate", pool: "pump-amm" }, 0)!;
    expect(migrate.kind).toBe("migrate");
    expect(parsePumpMessage(JSON.stringify({ message: "Successfully subscribed to token creation events." }), 0)).toBeNull();
    expect(parsePumpMessage("pas du json", 0)).toBeNull();
  });

  it("se connecte au faux serveur, souscrit aux deux flux gratuits et écrit le JSONL", async () => {
    server = await startFakeWsServer();
    const dir = tmp();
    const events: string[] = [];
    const client = createPumpPortalClient({
      url: server.url,
      outDir: dir,
      onEvent: (e) => events.push(e.kind),
      now: () => 1790244000000,
    });
    client.start();
    const conn = await server.waitForConnection(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.received.map((m) => JSON.parse(m).method).sort()).toEqual(["subscribeMigration", "subscribeNewToken"]);
    conn.send(JSON.stringify({ message: "Successfully subscribed to token creation events." }));
    conn.send(JSON.stringify({ signature: "s1", mint: "Mint1", txType: "create", name: "X", symbol: "X", solAmount: 0.5, pool: "pump" }));
    conn.send(JSON.stringify({ signature: "s2", mint: "Mint1", txType: "migrate", pool: "pump-amm" }));
    await new Promise((r) => setTimeout(r, 80));
    client.stop();
    expect(events).toEqual(["create", "migrate"]);
    expect(client.stats.ignored).toBe(1);
    expect(client.stats.connections).toBe(1);
    const file = join(dir, pumpFileName(1790244000000));
    expect(file.endsWith("pump-2026-09-24.jsonl")).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]!).kind).toBe("migrate");
  });

  it("se reconnecte après une fermeture serveur et resouscrit", async () => {
    server = await startFakeWsServer();
    const client = createPumpPortalClient({ url: server.url, outDir: null, reconnect: { baseMs: 20, maxMs: 50 } });
    client.start();
    const c1 = await server.waitForConnection(1);
    await new Promise((r) => setTimeout(r, 30));
    c1.close(1012);
    const c2 = await server.waitForConnection(2, 3000);
    await new Promise((r) => setTimeout(r, 50));
    expect(c2.received.length).toBe(2);
    expect(client.stats.connections).toBe(2);
    expect(client.stats.reconnects).toBeGreaterThanOrEqual(1);
    client.stop();
  });

  it("n'émet jamais de souscription payante (trades)", async () => {
    server = await startFakeWsServer();
    const client = createPumpPortalClient({ url: server.url, outDir: null });
    client.start();
    const c = await server.waitForConnection(1);
    await new Promise((r) => setTimeout(r, 40));
    client.stop();
    for (const m of c.received) expect(JSON.parse(m).method).not.toMatch(/Trade/);
  });
});

// ---------------------------------------------------------------------------
describe("helius", () => {
  const addr = loadFixture<{ MINT: string; CREATOR: string; A: string; B: string; C: string; sigs: string[] }>("helius/addresses.json");
  const txs = loadFixture<Record<string, { result: ParsedTransaction }>>("helius/transactions.json");

  function rpcFetch(pageSize?: number) {
    return createFakeFetch([
      {
        match: "helius-rpc.com",
        body: (_url, init) => {
          const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
          if (req.method === "getSignaturesForAddress") {
            const [address, o] = req.params as [string, { limit: number; before?: string }];
            const fixture = address === addr.A ? loadFixture<{ result: unknown[] }>("helius/signatures-wallet-A.json") : loadFixture<{ result: Array<{ signature: string }> }>("helius/signatures-mint.json");
            let list = fixture.result as Array<{ signature: string }>;
            if (o.before) {
              const idx = list.findIndex((s) => s.signature === o.before);
              list = idx >= 0 ? list.slice(idx + 1) : [];
            }
            return { jsonrpc: "2.0", id: req.id, result: list.slice(0, pageSize ?? o.limit) };
          }
          if (req.method === "getTransaction") {
            const [sig] = req.params as [string];
            return { jsonrpc: "2.0", id: req.id, result: txs[sig]?.result ?? null };
          }
          return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } };
        },
      },
    ]);
  }

  it("extractBuyers : signataire dont le solde augmente, pas la bonding curve", () => {
    const tx = txs[addr.sigs[1]!]!.result;
    expect(extractBuyers(tx, addr.MINT)).toEqual([{ wallet: addr.A, deltaRaw: "13100000000000" }]);
    const deltas = tokenDeltas(txs[addr.sigs[5]!]!.result);
    const a = deltas.find((d) => d.owner === addr.A)!;
    expect(a.delta).toBe(-18100000000000n);
  });

  it("getEarlyBuyers : ordre chronologique, wallets distincts, échecs ignorés, crédits comptés", async () => {
    const ff = rpcFetch();
    const helius = createHeliusClient({ fetch: ff.fetch, apiKey: "test", minIntervalMs: 0 });
    const res = await helius.getEarlyBuyers(addr.MINT, 50);
    expect(res.buyers.map((b) => b.wallet)).toEqual([addr.CREATOR, addr.A, addr.B, addr.C]);
    expect(res.buyers.map((b) => b.rank)).toEqual([0, 1, 2, 3]);
    expect(res.buyers[0]!.blockTime).toBe(1790244000);
    expect(res.truncated).toBe(false);
    expect(res.signaturesScanned).toBe(7);
    // 1 page de signatures + 6 transactions valides lues (la signature en échec est filtrée avant lecture)
    expect(res.transactionsRead).toBe(6);
    expect(res.credits).toBe(7);
    expect(helius.credits).toBe(7);
    const body = JSON.parse(String(ff.calls[1]!.init!.body)) as { params: unknown[] };
    expect(body.params[1]).toMatchObject({ encoding: "jsonParsed", maxSupportedTransactionVersion: 0 });
  });

  it("getEarlyBuyers : s'arrête à n acheteurs et signale la troncature quand l'historique dépasse maxPages", async () => {
    const helius = createHeliusClient({ fetch: rpcFetch(3).fetch, apiKey: "test", minIntervalMs: 0 });
    const res = await helius.getEarlyBuyers(addr.MINT, 2, { pageSize: 3, maxPages: 1 });
    expect(res.truncated).toBe(true);
    expect(res.buyers.length).toBeLessThanOrEqual(2);
  });

  it("getWalletTokenHistory : entrées/sorties du wallet, limité", async () => {
    const helius = createHeliusClient({ fetch: rpcFetch().fetch, apiKey: "test", minIntervalMs: 0, creditTable: { getTransaction: 2 } });
    const res = await helius.getWalletTokenHistory(addr.A, { limit: 3 });
    expect(res.events.map((e) => e.direction)).toEqual(["out", "in", "in"]);
    expect(res.events.every((e) => e.mint === addr.MINT)).toBe(true);
    expect(res.credits).toBe(1 + 3 * 2);
  });

  it("propage les erreurs JSON-RPC", async () => {
    const helius = createHeliusClient({ fetch: rpcFetch().fetch, apiKey: "test", minIntervalMs: 0 });
    await expect(helius.rpc("getNope", [])).rejects.toThrow(/Method not found/);
  });
});

// ---------------------------------------------------------------------------
describe("extraction tickers / mints", () => {
  it("extrait les mints base58 (32–44) et écarte hex/EVM", () => {
    const text = "CA AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump et 0x6982508145454ce325ddbe47a25d4ec3d2311933 et So11111111111111111111111111111111111111112";
    expect(extractMints(text)).toEqual(["AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump", "So11111111111111111111111111111111111111112"]);
  });
  it("extrait les $tickers et ignore les devises", () => {
    expect(extractTickers("$AGENTS $POPCAT $usd $USD $SOL $BONK $AGENTS")).toEqual(["AGENTS", "POPCAT", "BONK"]);
  });
});

// ---------------------------------------------------------------------------
describe("reddit", () => {
  it("parse new.json : posts t3 non épinglés, tickers et mints extraits", () => {
    const posts = parseListing(loadFixture("reddit/solana-new.json"));
    expect(posts.length).toBe(3);
    const ai = posts.find((p) => p.id === "1nq8x2a")!;
    expect(ai.tickers).toEqual(["AGENTS"]);
    expect(ai.mints).toEqual(["AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump"]);
    expect(ai.createdUtc).toBe(1790245800);
    expect(ai.score).toBe(14);
  });

  it("collecte plusieurs subreddits, envoie un User-Agent, tolère un 429", async () => {
    const ff = createFakeFetch([
      { match: "/r/solana/new.json", body: loadFixture("reddit/solana-new.json") },
      { match: "/r/CryptoMoonShots/new.json", body: loadFixture("reddit/cryptomoonshots-new.json") },
      { match: "/r/memecoins/new.json", body: { error: 429 }, status: 429 },
    ]);
    const reddit = createRedditClient({ fetch: ff.fetch, limiter: createLimiter({ max: 100, windowMs: 60_000 }) });
    const res = await reddit.collect();
    expect(res.posts.length).toBe(5);
    expect(res.posts[0]!.createdUtc).toBeGreaterThanOrEqual(res.posts[1]!.createdUtc);
    expect(res.errors).toEqual([{ source: "reddit:r/memecoins", message: "Reddit 429 sur r/memecoins" }]);
    expect(reddit.requestCount).toBe(3);
    const headers = ff.calls[0]!.init!.headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/crypto-lab/);
  });
});

// ---------------------------------------------------------------------------
describe("github", () => {
  it("recherche les dépôts solana récents, exclut les forks, dédoublonne, extrait les mints", async () => {
    const ff = createFakeFetch([{ match: "/search/repositories", body: loadFixture("github/search-repositories.json") }]);
    const gh = createGithubClient({ fetch: ff.fetch, now: () => Date.UTC(2026, 8, 24, 12), token: "ghp_test" });
    const res = await gh.collect();
    expect(ff.calls.length).toBe(2);
    expect(ff.calls[0]!.url).toContain("created%3A%3E2026-09-17");
    expect((ff.calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer ghp_test");
    expect(res.repos.map((r) => r.fullName)).toEqual(["sendaifun/solana-agent-kit", "anon-degen/pumpfun-sniper-rs"]);
    expect(res.repos[1]!.mints).toEqual(["AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump"]);
    expect(res.errors).toEqual([]);
  });

  it("remonte une erreur de quota sans planter", async () => {
    const gh = createGithubClient({ fetch: async () => jsonResponse({ message: "API rate limit exceeded" }, 403) });
    const res = await gh.collect();
    expect(res.repos).toEqual([]);
    expect(res.errors.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("run.ts (cycle complet hors ligne)", () => {
  it("écrit scans/tokens/history/signals/narratives/meta à partir des fixtures", async () => {
    const dataDir = tmp();
    const ff = createFakeFetch([
      { match: "/token-profiles/latest/v1", body: loadFixture("dexscreener/token-profiles.json") },
      { match: "/token-boosts/top/v1", body: loadFixture("dexscreener/token-boosts-top.json") },
      { match: "/latest/dex/tokens/", body: loadFixture("dexscreener/latest-dex-tokens.json") },
      { match: "/r/solana/new.json", body: loadFixture("reddit/solana-new.json") },
      { match: "/r/CryptoMoonShots/new.json", body: loadFixture("reddit/cryptomoonshots-new.json") },
      { match: "/r/memecoins/new.json", body: { kind: "Listing", data: { after: null, before: null, children: [] } } },
      { match: "/search/repositories", body: loadFixture("github/search-repositories.json") },
    ]);
    const now = () => Date.UTC(2026, 8, 24, 12, 0, 0);
    const res = await runCollect({ dataDir, fetch: ff.fetch, now });
    expect(res.scan.tokens.length).toBe(2); // POPCAT + AGENTS (BONK absent de la fixture pairs, RUG non demandé)
    expect(res.scan.reddit.length).toBe(5);
    expect(res.scan.github.length).toBe(2);
    expect(res.scan.errors).toEqual([]);
    expect(res.scan.requests.dexscreener).toBe(3);
    expect(existsSync(res.scanPath)).toBe(true);
    expect(readdirSync(join(dataDir, "tokens")).length).toBe(2);
    expect(readdirSync(join(dataDir, "history")).length).toBe(2);
    expect(readdirSync(join(dataDir, "signals")).length).toBe(1);
    const narr = JSON.parse(readFileSync(join(dataDir, "narratives", "2026-09-24.json"), "utf8")) as { terms: Array<{ term: string }> };
    expect(narr.terms.map((t) => t.term)).toContain("agents");
    const meta = JSON.parse(readFileSync(join(dataDir, "meta.json"), "utf8")) as { lastCollectAt: string };
    expect(meta.lastCollectAt).toBe("2026-09-24T12:00:00.000Z");
    // Second cycle : l'historique s'allonge, le cache disque évite les requêtes DexScreener.
    const before = ff.calls.length;
    await runCollect({ dataDir, fetch: ff.fetch, now });
    const hist = readFileSync(join(dataDir, "history", "AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump.jsonl"), "utf8").trim().split("\n");
    expect(hist.length).toBe(2);
    expect(ff.calls.slice(before).filter((c) => c.url.includes("dexscreener")).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("mintinfo (getAccountInfo / getTokenSupply / getTokenLargestAccounts)", () => {
  const POOL = "9GxTm3QMvWPkz4jCd5xnXf8RLz1jXp9Jz2J2t6vZb2Fq";
  const DEV = "DevWa11etCreatorAbcDefGhijKmNPQRSTUVWXYZ1234";
  const AUTH = "AuthKeyAbcDefGhijKmNPQRSTUVWXYZ123456789abcd";
  const SPL_B64 = encodeMintAccount({ mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000_000_000n, decimals: 6 });
  const T22_B64 = encodeMintAccount({ mintAuthority: AUTH, freezeAuthority: AUTH, supply: 1_000_000_000n, decimals: 9, extensions: [[18, 64], [1, 108], [12, 32]] });

  function rpcFor(b64: string, owner: string, largest: Array<[string, string]>, owners: Record<string, string>) {
    const calls: string[] = [];
    const rpc: JsonRpc = async <T,>(method: string, params: unknown[]): Promise<T> => {
      calls.push(method);
      switch (method) {
        case "getAccountInfo":
          return { context: { slot: 1 }, value: { data: [b64, "base64"], owner, lamports: 1461600, executable: false, rentEpoch: 0, space: 82 } } as T;
        case "getTokenSupply":
          return { context: { slot: 1 }, value: { amount: b64 === SPL_B64 ? "1000000000000000" : "1000000000", decimals: b64 === SPL_B64 ? 6 : 9, uiAmount: 1e9, uiAmountString: "1000000000" } } as T;
        case "getTokenLargestAccounts":
          return { context: { slot: 1 }, value: largest.map(([address, amount]) => ({ address, amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: "x" })) } as T;
        case "getMultipleAccounts": {
          const [addrs] = params as [string[]];
          return { context: { slot: 1 }, value: addrs.map((a) => ({ data: { program: "spl-token", parsed: { info: { owner: owners[a] ?? DEV, mint: "m", tokenAmount: {} }, type: "account" }, space: 165 }, owner, lamports: 2039280, executable: false })) } as T;
        }
        default:
          throw new Error(`méthode inattendue ${method}`);
      }
    };
    return { rpc, calls };
  }

  it("décode un mint SPL classique : autorités révoquées, decimals, supply, sans extension", () => {
    const d = decodeMintAccountBase64(SPL_B64, TOKEN_PROGRAM_ID);
    expect(d).toEqual({ program: "spl-token", mintAuthority: null, freezeAuthority: null, supplyRaw: "1000000000000000", decimals: 6, isInitialized: true, extensions: [] });
  });

  it("décode un mint Token-2022 : autorités présentes et extensions TLV (TransferFeeConfig détectée)", () => {
    const d = decodeMintAccountBase64(T22_B64, TOKEN_2022_PROGRAM_ID);
    expect(d.program).toBe("token-2022");
    expect(d.mintAuthority).toBe(AUTH);
    expect(d.freezeAuthority).toBe(AUTH);
    expect(d.decimals).toBe(9);
    expect(d.extensions).toEqual(["MetadataPointer", "TransferFeeConfig", "PermanentDelegate"]);
    expect(() => decodeMintAccountBase64(Buffer.alloc(10).toString("base64"), TOKEN_PROGRAM_ID)).toThrow(/trop court/);
  });

  it("computeTop10 : exclut vaults/pools, borne à 100, offre nulle → null", () => {
    const r = computeTop10(
      [
        { address: "vault", owner: POOL, amountRaw: "500" },
        { address: "a", owner: "wa", amountRaw: "200" },
        { address: "b", owner: "wb", amountRaw: "100" },
      ],
      "1000",
      { owners: new Set([POOL]) },
    );
    expect(r.top10Pct).toBe(30);
    expect(r.excludedCount).toBe(1);
    expect(r.topAccounts[0]).toMatchObject({ address: "vault", pct: 50, excluded: true });
    expect(computeTop10([{ address: "a", owner: null, amountRaw: "5" }], "0").top10Pct).toBeNull();
    expect(computeTop10([{ address: "a", owner: null, amountRaw: "1500" }], "1000").top10Pct).toBe(100);
  });

  it("fetchMintInfo SPL : 4 appels, top10 hors pool, holders inconnu", async () => {
    const { rpc, calls } = rpcFor(SPL_B64, TOKEN_PROGRAM_ID, [["vault1", "600000000000000"], ["acc2", "100000000000000"], ["acc3", "50000000000000"]], { vault1: POOL });
    const info = (await fetchMintInfo(rpc, "MintSpl", { excludeOwners: [POOL], now: () => 0 }))!;
    expect(calls).toEqual(["getAccountInfo", "getTokenSupply", "getTokenLargestAccounts", "getMultipleAccounts"]);
    expect(info.rpcCalls).toBe(4);
    expect(info.program).toBe("spl-token");
    expect(info.top10Pct).toBe(15);
    expect(info.excludedCount).toBe(1);
    expect(info.holders).toBeNull();
    expect(info.riskyExtensions).toEqual([]);
    expect(info.fetchedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("fetchMintInfo Token-2022 : sans exclusion → 3 appels, extensions risquées listées ; compte absent → null", async () => {
    const { rpc, calls } = rpcFor(T22_B64, TOKEN_2022_PROGRAM_ID, [["acc1", "400000000"]], {});
    const info = (await fetchMintInfo(rpc, "MintT22"))!;
    expect(calls.length).toBe(3);
    expect(info.top10Pct).toBe(40);
    expect(info.riskyExtensions).toEqual(["TransferFeeConfig", "PermanentDelegate"]);
    const none: JsonRpc = async <T,>() => ({ context: { slot: 1 }, value: null }) as T;
    expect(await fetchMintInfo(none, "Absent")).toBeNull();
  });

  it("pont : sans mintinfo → valeurs conservatrices ; avec mintinfo → autorités réelles, top10 et decimals", async () => {
    const pairs = loadFixture<DexPairsResponse>("dexscreener/latest-dex-tokens.json").pairs ?? [];
    const agents = snapshotsFromPairs(pairs, "2026-09-24T12:00:00.000Z").find((s) => s.symbol === "AGENTS")!;
    const g = toRiskSnapshot(agents);
    // Type unifié : aucun champ perdu (volumes, txns, paire…) ; inconnus explicites (holders null, top10 100, autorités UNKNOWN).
    expect(g).toMatchObject({ volume: { m5: 91000, h24: 1560000 }, liquidityUsd: 86000, holders: null, top10Pct: 100, mintAuthority: UNKNOWN_AUTHORITY, freezeAuthority: UNKNOWN_AUTHORITY, pairAddress: POOL });
    expect(g.txns.m5).toEqual(agents.txns.m5);
    expect(g.pairCreatedAt).toBe(agents.pairCreatedAt);
    expect(g.source).toBe("dexscreener");
    expect(g.createdAt).toBe(new Date(1790244000000).toISOString());
    const { rpc } = rpcFor(SPL_B64, TOKEN_PROGRAM_ID, [["vault1", "600000000000000"], ["acc2", "100000000000000"]], { vault1: POOL });
    const info = (await fetchMintInfo(rpc, agents.mint, { excludeOwners: [POOL] }))!;
    const real = toRiskSnapshot(agents, info);
    expect(real.mintAuthority).toBeNull();
    expect(real.freezeAuthority).toBeNull();
    expect(real.top10Pct).toBe(10);
    expect(real.decimals).toBe(6);
    expect(real.holders).toBeNull(); // mintinfo ne fournit pas les holders → reste inconnu
    expect(real.riskyExtensions).toEqual([]);
    expect(agents.mintAuthority).toBe(UNKNOWN_AUTHORITY); // l'original n'est pas modifié
    // top10 inconnu (offre nulle) → 100 conservé.
    expect(toRiskSnapshot(agents, { ...info, top10Pct: null }).top10Pct).toBe(100);
  });

  it("run.ts : pré-filtre (liquidité ≥ 20 k$, âge ≥ 10 min), cache mintinfo, tokens/<mint>.json au format Risk Engine", async () => {
    const dataDir = tmp();
    const ff = createFakeFetch([
      { match: "/token-profiles/latest/v1", body: loadFixture("dexscreener/token-profiles.json") },
      { match: "/token-boosts/top/v1", body: loadFixture("dexscreener/token-boosts-top.json") },
      { match: "/latest/dex/tokens/", body: loadFixture("dexscreener/latest-dex-tokens.json") },
      { match: "reddit.com", body: { kind: "Listing", data: { after: null, before: null, children: [] } } },
      { match: "/search/repositories", body: { total_count: 0, incomplete_results: false, items: [] } },
    ]);
    const asked: string[] = [];
    const { rpc: base } = rpcFor(SPL_B64, TOKEN_PROGRAM_ID, [["vault1", "600000000000000"], ["acc2", "100000000000000"]], { vault1: POOL });
    const rpc: JsonRpc = async <T,>(method: string, params: unknown[]): Promise<T> => {
      if (method === "getAccountInfo") asked.push(params[0] as string);
      return base<T>(method, params);
    };
    // AGENTS : liquidité 86 k$, créé à 1790244000000 → à now = +5 min il est trop jeune, à +30 min il passe.
    // POPCAT : 3,1 M$ de liquidité, créé en 2023 → enrichi dès le premier cycle.
    const young = () => 1790244000000 + 5 * 60_000;
    const r1 = await runCollect({ dataDir, fetch: ff.fetch, now: young, rpc });
    expect(r1.mintInfos).toBe(1);
    expect(asked).toEqual(["7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"]);
    const agentsPath = join(dataDir, "tokens", "AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump.json");
    let tok = JSON.parse(readFileSync(agentsPath, "utf8")) as { mintAuthority: string | null; top10Pct: number; volume: { m5: number } };
    expect(tok.mintAuthority).toBe(UNKNOWN_AUTHORITY);
    expect(tok.top10Pct).toBe(100);
    expect(tok.volume.m5).toBe(91000);
    expect(existsSync(join(dataDir, "mintinfo"))).toBe(true);

    const later = () => 1790244000000 + 30 * 60_000;
    const r2 = await runCollect({ dataDir, fetch: ff.fetch, now: later, rpc });
    // AGENTS passe maintenant ; POPCAT reste servi par le cache (TTL 1 h) → un seul nouvel enrichissement.
    expect(asked).toEqual(["7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", "AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump"]);
    expect(r2.mintInfos).toBe(2);
    expect(r2.rpcCalls).toBe(4);
    tok = JSON.parse(readFileSync(agentsPath, "utf8"));
    expect(tok.mintAuthority).toBeNull();
    expect(tok.top10Pct).toBe(10);
    expect(readdirSync(join(dataDir, "mintinfo")).length).toBe(2);
    const meta = JSON.parse(readFileSync(join(dataDir, "meta.json"), "utf8")) as { heliusCreditsMonth: number; heliusMonth: string };
    expect(meta.heliusCreditsMonth).toBe(8);
    expect(meta.heliusMonth).toBe("2026-09");

    // Troisième cycle dans le TTL : cache → aucun appel RPC, fichier token toujours enrichi.
    const before = asked.length;
    const r3 = await runCollect({ dataDir, fetch: ff.fetch, now: () => later() + 60_000, rpc });
    expect(asked.length).toBe(before);
    expect(r3.rpcCalls).toBe(0);
    expect(r3.mintInfos).toBe(2);
    expect(JSON.parse(readFileSync(agentsPath, "utf8")).freezeAuthority).toBeNull();
  });
});
