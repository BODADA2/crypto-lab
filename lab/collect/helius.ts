/**
 * Client Helius RPC (plan gratuit : 1M crédits/mois, 10 req/s — helius.dev/pricing, 24/09/2026).
 *
 * Méthodes JSON-RPC standard utilisées (1 crédit chacune par défaut ; table ajustable) :
 *   getSignaturesForAddress(mint, { limit, before })  → signatures les plus récentes d'abord
 *   getTransaction(sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 })
 *
 * `getEarlyBuyers(mint, n)` : remonte l'historique du mint jusqu'aux plus anciennes signatures
 * (pagination `before`, plafonnée par `maxPages`), puis lit les transactions dans l'ordre
 * chronologique et retient les `n` premiers wallets DISTINCTS dont le solde du token augmente
 * et qui ont signé la transaction (exclut les PDA de bonding curve / pools, qui ne signent pas).
 *
 * Le compteur `credits` est indicatif : Helius facture 1 crédit par appel RPC standard.
 */
import type { EarlyBuyer, FetchLike, WalletTokenEvent } from "./types.ts";

export interface HeliusOptions {
  fetch: FetchLike;
  apiKey?: string;
  /** URL complète (prioritaire sur apiKey). */
  rpcUrl?: string;
  /** Coût en crédits par méthode (défaut 1). */
  creditTable?: Record<string, number>;
  /** Pause entre requêtes (ms) ; 0 dans les tests. Défaut 110 ms (≈ 9 req/s). */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown | null;
  memo: string | null;
  blockTime: number | null;
  confirmationStatus?: string;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null; uiAmountString: string };
}

export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean; source?: string }>;
      instructions: unknown[];
      recentBlockhash?: string;
    };
  };
  meta: {
    err: unknown | null;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    logMessages?: string[];
  } | null;
}

export interface EarlyBuyersResult {
  mint: string;
  buyers: EarlyBuyer[];
  /** Nombre de signatures parcourues. */
  signaturesScanned: number;
  transactionsRead: number;
  /** `true` si l'historique dépassait `maxPages` pages : les "premiers" acheteurs ne sont pas garantis. */
  truncated: boolean;
  credits: number;
}

export interface WalletHistoryResult {
  address: string;
  events: WalletTokenEvent[];
  signaturesScanned: number;
  transactionsRead: number;
  credits: number;
}

export interface HeliusClient {
  rpc<T>(method: string, params: unknown[]): Promise<T>;
  getSignaturesForAddress(address: string, opts?: { limit?: number; before?: string; until?: string }): Promise<SignatureInfo[]>;
  getTransaction(signature: string): Promise<ParsedTransaction | null>;
  getEarlyBuyers(mint: string, n?: number, opts?: { maxPages?: number; pageSize?: number; maxTransactions?: number }): Promise<EarlyBuyersResult>;
  getWalletTokenHistory(address: string, opts?: { limit?: number }): Promise<WalletHistoryResult>;
  /** Crédits consommés depuis la création du client. */
  readonly credits: number;
  readonly requestCount: number;
}

export class HeliusError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "HeliusError";
  }
}

export function createHeliusClient(opts: HeliusOptions): HeliusClient {
  const url = opts.rpcUrl ?? `https://mainnet.helius-rpc.com/?api-key=${opts.apiKey ?? ""}`;
  const table = opts.creditTable ?? {};
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minInterval = opts.minIntervalMs ?? 110;
  let credits = 0;
  let requestCount = 0;
  let id = 0;
  let lastAt = 0;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (minInterval > 0) {
      const wait = lastAt + minInterval - Date.now();
      if (wait > 0) await sleep(wait);
    }
    lastAt = Date.now();
    id += 1;
    const res = await opts.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    requestCount += 1;
    credits += table[method] ?? 1;
    if (!res.ok) throw new HeliusError(`Helius HTTP ${res.status} (${method})`, res.status);
    const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (json.error) throw new HeliusError(`Helius RPC ${json.error.code}: ${json.error.message}`, json.error.code);
    return json.result as T;
  }

  const client: HeliusClient = {
    get credits() {
      return credits;
    },
    get requestCount() {
      return requestCount;
    },
    rpc,
    getSignaturesForAddress(address, o = {}) {
      const params: Record<string, unknown> = { limit: o.limit ?? 1000 };
      if (o.before) params.before = o.before;
      if (o.until) params.until = o.until;
      return rpc<SignatureInfo[]>("getSignaturesForAddress", [address, params]);
    },
    getTransaction(signature) {
      return rpc<ParsedTransaction | null>("getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ]);
    },
    async getEarlyBuyers(mint, n = 50, o = {}) {
      const pageSize = o.pageSize ?? 1000;
      const maxPages = o.maxPages ?? 10;
      const maxTx = o.maxTransactions ?? n * 4;
      const before0 = credits;
      // 1) Remonter jusqu'aux signatures les plus anciennes (l'API renvoie du plus récent au plus ancien).
      let before: string | undefined;
      let pages = 0;
      let scanned = 0;
      let lastPage: SignatureInfo[] = [];
      let prevPage: SignatureInfo[] = [];
      let truncated = false;
      for (;;) {
        const page = await client.getSignaturesForAddress(mint, { limit: pageSize, before });
        pages += 1;
        scanned += page.length;
        if (page.length === 0) break;
        prevPage = lastPage;
        lastPage = page;
        if (page.length < pageSize) break;
        before = (page[page.length - 1] as SignatureInfo).signature;
        if (pages >= maxPages) {
          truncated = true;
          break;
        }
      }
      // 2) Les plus anciennes = fin de la dernière page (et de l'avant-dernière si besoin), en ordre chronologique.
      const oldestFirst = [...prevPage, ...lastPage].filter((s) => s.err === null || s.err === undefined).reverse();
      const candidates = oldestFirst.slice(0, maxTx);
      // 3) Lire les transactions et extraire les acheteurs distincts.
      const buyers: EarlyBuyer[] = [];
      const seen = new Set<string>();
      let read = 0;
      for (const sig of candidates) {
        if (buyers.length >= n) break;
        const tx = await client.getTransaction(sig.signature);
        read += 1;
        if (!tx || !tx.meta || tx.meta.err) continue;
        for (const b of extractBuyers(tx, mint)) {
          if (seen.has(b.wallet)) continue;
          seen.add(b.wallet);
          buyers.push({
            wallet: b.wallet,
            signature: sig.signature,
            blockTime: tx.blockTime ?? sig.blockTime ?? null,
            slot: tx.slot ?? sig.slot,
            rank: buyers.length,
            amountRaw: b.deltaRaw,
          });
          if (buyers.length >= n) break;
        }
      }
      return { mint, buyers, signaturesScanned: scanned, transactionsRead: read, truncated, credits: credits - before0 };
    },
    async getWalletTokenHistory(address, o = {}) {
      const limit = Math.min(o.limit ?? 20, 100);
      const before0 = credits;
      const sigs = await client.getSignaturesForAddress(address, { limit });
      const events: WalletTokenEvent[] = [];
      let read = 0;
      for (const s of sigs) {
        if (s.err) continue;
        const tx = await client.getTransaction(s.signature);
        read += 1;
        if (!tx || !tx.meta || tx.meta.err) continue;
        for (const d of tokenDeltas(tx)) {
          if (d.owner !== address || d.delta === 0n) continue;
          events.push({
            signature: s.signature,
            blockTime: tx.blockTime ?? s.blockTime ?? null,
            mint: d.mint,
            deltaRaw: d.delta.toString(),
            direction: d.delta > 0n ? "in" : "out",
          });
        }
      }
      return { address, events, signaturesScanned: sigs.length, transactionsRead: read, credits: credits - before0 };
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// Fonctions pures d'extraction
// ---------------------------------------------------------------------------

export interface TokenDelta {
  owner: string;
  mint: string;
  delta: bigint;
  signer: boolean;
}

/** Variation de solde par (owner, mint) entre pre/postTokenBalances. */
export function tokenDeltas(tx: ParsedTransaction): TokenDelta[] {
  const meta = tx.meta;
  if (!meta) return [];
  const signers = new Set(tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey));
  const key = (b: TokenBalance) => `${b.owner ?? "?"}|${b.mint}`;
  const pre = new Map<string, bigint>();
  for (const b of meta.preTokenBalances ?? []) pre.set(key(b), (pre.get(key(b)) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  const post = new Map<string, bigint>();
  for (const b of meta.postTokenBalances ?? []) post.set(key(b), (post.get(key(b)) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  const keys = new Set([...pre.keys(), ...post.keys()]);
  const out: TokenDelta[] = [];
  for (const k of keys) {
    const [owner, mint] = k.split("|") as [string, string];
    if (owner === "?") continue;
    out.push({ owner, mint, delta: (post.get(k) ?? 0n) - (pre.get(k) ?? 0n), signer: signers.has(owner) });
  }
  return out;
}

/** Acheteurs d'un mint dans une transaction : signataires dont le solde du mint augmente. */
export function extractBuyers(tx: ParsedTransaction, mint: string): Array<{ wallet: string; deltaRaw: string }> {
  return tokenDeltas(tx)
    .filter((d) => d.mint === mint && d.delta > 0n && d.signer)
    .map((d) => ({ wallet: d.owner, deltaRaw: d.delta.toString() }));
}
