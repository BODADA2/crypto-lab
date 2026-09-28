/**
 * Tests de la tolérance -32015 (« Transaction version (N) is not supported ») du client Helius.
 *
 * Stratégie testée : getTransactionLenient essaie maxSupportedTransactionVersion 0 puis 1 puis 2 ;
 * si -32015 persiste, la transaction est ignorée et comptée dans `skippedTx` au lieu de faire
 * échouer tout le mint. Les autres erreurs JSON-RPC sont propagées.
 *
 * Fetch entièrement mocké : aucun appel réel, aucune clé.
 */
import { describe, it, expect } from "vitest";
import {
  createHeliusClient,
  HeliusError,
  TX_VERSION_UNSUPPORTED_CODE,
  type ParsedTransaction,
  type SignatureInfo,
} from "../lab/collect/helius.ts";
import { createFakeFetch } from "./helpers/fakeFetch.ts";

const MINT = "M1nt1111111111111111111111111111111111111111";
const BUYER1 = "Buyer11111111111111111111111111111111111111";
const BUYER2 = "Buyer22222222222222222222222222222222222222";

/** Transaction minimale : `buyer` signe et son solde de `mint` augmente de `amount`. */
function makeBuyerTx(mint: string, buyer: string, amount: string): ParsedTransaction {
  return {
    slot: 42,
    blockTime: 1700000000,
    transaction: {
      signatures: ["sig"],
      message: {
        accountKeys: [{ pubkey: buyer, signer: true, writable: true }],
        instructions: [],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [0],
      postBalances: [0],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint,
          owner: buyer,
          uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
        },
      ],
    },
  };
}

function makeSig(signature: string, blockTime: number): SignatureInfo {
  return { signature, slot: 42, err: null, memo: null, blockTime };
}

const UNSUPPORTED = { code: TX_VERSION_UNSUPPORTED_CODE, message: "Transaction version (1) is not supported by the requesting client." };

/**
 * Fetch mocké : `behaviors[sig][version]` → "ok" | "unsupported" | "other-error".
 * Les versions réellement demandées sont enregistrées dans `attempts`.
 */
function mockVersionFetch(
  behaviors: Record<string, Record<number, "ok" | "unsupported" | "other-error">>,
  txBySig: Record<string, ParsedTransaction>,
  sigs: SignatureInfo[],
) {
  const attempts: Array<{ sig: string; version: number }> = [];
  const ff = createFakeFetch([
    {
      match: "helius-rpc.com",
      body: (_url, init) => {
        const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
        if (req.method === "getSignaturesForAddress") {
          return { jsonrpc: "2.0", id: req.id, result: sigs };
        }
        if (req.method === "getTransaction") {
          const [sig, o] = req.params as [string, { maxSupportedTransactionVersion: number }];
          const version = o.maxSupportedTransactionVersion;
          attempts.push({ sig, version });
          const behavior = behaviors[sig]?.[version] ?? "ok";
          if (behavior === "unsupported") {
            return { jsonrpc: "2.0", id: req.id, error: UNSUPPORTED };
          }
          if (behavior === "other-error") {
            return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "Invalid params" } };
          }
          return { jsonrpc: "2.0", id: req.id, result: txBySig[sig] ?? null };
        }
        return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } };
      },
    },
  ]);
  return { ff, attempts };
}

describe("getTransactionLenient", () => {
  it("échoue en -32015 à la version 0 mais réussit à la version 1 (transaction v1 récupérée)", async () => {
    const tx = makeBuyerTx(MINT, BUYER1, "1000");
    const { ff, attempts } = mockVersionFetch({ "sig-v1": { 0: "unsupported", 1: "ok" } }, { "sig-v1": tx }, []);
    const helius = createHeliusClient({ fetch: ff.fetch, apiKey: "test", minIntervalMs: 0 });
    const res = await helius.getTransactionLenient("sig-v1");
    expect(res.skipped).toBe(false);
    expect(res.tx).not.toBeNull();
    expect(attempts).toEqual([
      { sig: "sig-v1", version: 0 },
      { sig: "sig-v1", version: 1 },
    ]);
    // Chaque tentative est un appel RPC facturé : honnêteté du compteur de crédits.
    expect(helius.credits).toBe(2);
  });

  it("essaie 0, 1 puis 2 avant d'ignorer une transaction jamais lisible", async () => {
    const { ff, attempts } = mockVersionFetch(
      { "sig-skip": { 0: "unsupported", 1: "unsupported", 2: "unsupported" } },
      {},
      [],
    );
    const helius = createHeliusClient({ fetch: ff.fetch, apiKey: "test", minIntervalMs: 0 });
    const res = await helius.getTransactionLenient("sig-skip");
    expect(res.skipped).toBe(true);
    expect(res.tx).toBeNull();
    expect(attempts).toEqual([
      { sig: "sig-skip", version: 0 },
      { sig: "sig-skip", version: 1 },
      { sig: "sig-skip", version: 2 },
    ]);
    expect(helius.credits).toBe(3);
  });

  it("propage les autres erreurs JSON-RPC au lieu de les ignorer", async () => {
    const { ff } = mockVersionFetch({ "sig-bad": { 0: "other-error" } }, {}, []);
    const helius = createHeliusClient({ fetch: ff.fetch, apiKey: "test", minIntervalMs: 0 });
    await expect(helius.getTransactionLenient("sig-bad")).rejects.toThrow(HeliusError);
    await expect(helius.getTransactionLenient("sig-bad")).rejects.toThrow(/Invalid params/);
  });

  it("getTransaction (public) reste compatible et récupère via le retry", async () => {
    const tx = makeBuyerTx(MINT, BUYER1, "1000");
    const { ff } = mockVersionFetch({ "sig-v1": { 0: "unsupported", 1: "ok" } }, { "sig-v1": tx }, []);
    const helius = createHeliusClient({ fetch: ff.fetch, apiKey: "test", minIntervalMs: 0 });
    const got = await helius.getTransaction("sig-v1");
    expect(got).not.toBeNull();
  });
});

describe("rpc : tolérance 429", () => {
  /** Fetch mocké : renvoie les statuts HTTP donnés dans l'ordre (429 simulé, 200 = succès). */
  function mock429Fetch(statuses: number[]) {
    let i = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      const status = statuses[Math.min(i, statuses.length - 1)]!;
      i += 1;
      if (status === 429) return new Response("rate limited", { status: 429 });
      const req = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return fetch;
  }

  function client429(statuses: number[]) {
    const slept: number[] = [];
    const helius = createHeliusClient({
      fetch: mock429Fetch(statuses) as never,
      apiKey: "test",
      minIntervalMs: 0,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    });
    return { helius, slept };
  }

  it("réessaie sur 429 (backoff 1s, 2s) puis réussit ; chaque tentative compte en crédits", async () => {
    const { helius, slept } = client429([429, 429, 200]);
    const res = await helius.rpc<string>("getSlot", []);
    expect(res).toBe("ok");
    expect(slept).toEqual([1000, 2000]);
    expect(helius.credits).toBe(3); // 3 tentatives réelles = 3 crédits
    expect(helius.requestCount).toBe(3);
  });

  it("propage HeliusError 429 après 3 réessais épuisés", async () => {
    const { helius, slept } = client429([429, 429, 429, 429, 429]);
    await expect(helius.rpc("getSlot", [])).rejects.toThrow(/Helius HTTP 429/);
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(helius.credits).toBe(4); // 1 tentative initiale + 3 réessais
  });

  it("chaque appel porte un AbortSignal (timeout anti-blocage 30 s)", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      seen.push(init);
      const req = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const helius = createHeliusClient({ fetch: fetch as never, apiKey: "test", minIntervalMs: 0 });
    await helius.rpc("getSlot", []);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("getEarlyBuyers : tolérance -32015", () => {
  it("extrait les acheteurs des tx v1/v2, compte les ignorées, ne fait pas échouer le mint", async () => {
    // Ordre renvoyé par l'API : du plus récent au plus ancien.
    const sigs = [makeSig("sig-v1", 1700000020), makeSig("sig-skip", 1700000010), makeSig("sig-v2", 1700000000)];
    const txBySig = {
      "sig-v1": makeBuyerTx(MINT, BUYER1, "1000"),
      "sig-v2": makeBuyerTx(MINT, BUYER2, "2000"),
    };
    const behaviors = {
      "sig-v1": { 0: "unsupported", 1: "ok" } as Record<number, "ok" | "unsupported" | "other-error">,
      "sig-skip": { 0: "unsupported", 1: "unsupported", 2: "unsupported" } as Record<number, "ok" | "unsupported" | "other-error">,
      "sig-v2": { 0: "unsupported", 1: "unsupported", 2: "ok" } as Record<number, "ok" | "unsupported" | "other-error">,
    };
    const { ff } = mockVersionFetch(behaviors, txBySig, sigs);
    const helius = createHeliusClient({ fetch: ff.fetch, apiKey: "test", minIntervalMs: 0 });
    const res = await helius.getEarlyBuyers(MINT, 50);
    // Ordre chronologique : sig-v2 d'abord, puis sig-skip (ignorée), puis sig-v1.
    expect(res.buyers.map((b) => b.wallet)).toEqual([BUYER2, BUYER1]);
    expect(res.skippedTx).toBe(1);
    expect(res.transactionsRead).toBe(3);
    expect(res.truncated).toBe(false);
  });
});

describe("getWalletTokenHistory : tolérance -32015", () => {
  it("compte skippedTx pour les transactions illisibles", async () => {
    const sigs = [makeSig("sig-v1", 1700000020), makeSig("sig-skip", 1700000010)];
    const txBySig = { "sig-v1": makeBuyerTx(MINT, BUYER1, "1000") };
    const behaviors = {
      "sig-v1": { 0: "unsupported", 1: "ok" } as Record<number, "ok" | "unsupported" | "other-error">,
      "sig-skip": { 0: "unsupported", 1: "unsupported", 2: "unsupported" } as Record<number, "ok" | "unsupported" | "other-error">,
    };
    const { ff } = mockVersionFetch(behaviors, txBySig, sigs);
    const helius = createHeliusClient({ fetch: ff.fetch, apiKey: "test", minIntervalMs: 0 });
    const res = await helius.getWalletTokenHistory(BUYER1, { limit: 2 });
    expect(res.events.map((e) => e.direction)).toEqual(["in"]);
    expect(res.skippedTx).toBe(1);
    expect(res.transactionsRead).toBe(2);
  });
});
