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
 * Tolérance des versions de transaction : Solana sert désormais des transactions versionnées
 * (v1/v2) qu'Helius refuse avec le code -32015 si `maxSupportedTransactionVersion` est trop bas.
 * `getTransaction` essaie 0 puis 1 puis 2 ; si -32015 persiste, la transaction est IGNORÉE et
 * comptée dans `skippedTx` (jamais d'échec silencieux : le compteur est dans le résultat et le cache).
 *
 * Tolérance du rate limiting : `rpc` réessaie jusqu'à 3 fois sur HTTP 429 (backoff 1s → 2s → 4s)
 * avant de propager l'erreur ; chaque tentative est comptée en crédits.
 *
 * Garde-fou anti-blocage : chaque appel porte `AbortSignal.timeout(30000)` — une connexion
 * pendue ne bloque jamais le job plus de 30 s (l'erreur est propagée, le token est réessayé au run suivant).
 *
 * Le compteur `credits` est indicatif : Helius facture 1 crédit par appel RPC standard
 * (chaque tentative de version compte comme un appel).
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
  /**
   * Transactions ignorées parce que leur version n'est pas lisible par le client
   * (-32015 persistant après essais 0/1/2). Compteur jamais silencieux : écrit en cache.
   */
  skippedTx: number;
  credits: number;
}

export interface WalletHistoryResult {
  address: string;
  events: WalletTokenEvent[];
  signaturesScanned: number;
  transactionsRead: number;
  /**
   * Transactions ignorées parce que leur version n'est pas lisible par le client
   * (-32015 persistant après essais 0/1/2). Compteur jamais silencieux.
   */
  skippedTx: number;
  credits: number;
}

export interface HeliusClient {
  rpc<T>(method: string, params: unknown[]): Promise<T>;
  getSignaturesForAddress(address: string, opts?: { limit?: number; before?: string; until?: string }): Promise<SignatureInfo[]>;
  getTransaction(signature: string): Promise<ParsedTransaction | null>;
  /**
   * Variante tolérante : essaie maxSupportedTransactionVersion 0 puis 1 puis 2.
   * Si -32015 persiste, renvoie `{ tx: null, skipped: true }` (autres erreurs : propagées).
   */
  getTransactionLenient(signature: string): Promise<{ tx: ParsedTransaction | null; skipped: boolean }>;
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

/** Code JSON-RPC Helius : la version de transaction demandée n'est pas supportée par le client. */
export const TX_VERSION_UNSUPPORTED_CODE = -32015;
/** Versions de transaction essayées dans l'ordre par `getTransactionLenient` (0 = legacy, 1/2 = versionnées). */
export const TX_VERSION_ATTEMPTS = [0, 1, 2] as const;

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
    // 429 (rate limit) : backoff borné 1s → 2s → 4s puis propagation. Chaque tentative est
    // un appel réel : elle est comptée en crédits (compteur honnête).
    const maxRetries429 = 3;
    let attempt429 = 0;
    for (;;) {
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
        signal: AbortSignal.timeout(30000),
      });
      requestCount += 1;
      credits += table[method] ?? 1;
      if (res.status === 429 && attempt429 < maxRetries429) {
        attempt429 += 1;
        await sleep(1000 * 2 ** (attempt429 - 1));
        continue;
      }
      if (!res.ok) throw new HeliusError(`Helius HTTP ${res.status} (${method})`, res.status);
      const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (json.error) throw new HeliusError(`Helius RPC ${json.error.code}: ${json.error.message}`, json.error.code);
      return json.result as T;
    }
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
      return client.getTransactionLenient(signature).then((r) => r.tx);
    },
    async getTransactionLenient(signature) {
      let unsupported = false;
      for (const version of TX_VERSION_ATTEMPTS) {
        try {
          const tx = await rpc<ParsedTransaction | null>("getTransaction", [
            signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: version, commitment: "confirmed" },
          ]);
          return { tx, skipped: false };
        } catch (e) {
          if (e instanceof HeliusError && e.code === TX_VERSION_UNSUPPORTED_CODE) {
            unsupported = true;
            continue; // essayer la version suivante
          }
          throw e; // toute autre erreur reste une erreur
        }
      }
      // -32015 persistant : ignorer cette transaction, sans jamais la faire échouer silencieusement.
      if (unsupported) return { tx: null, skipped: true };
      return { tx: null, skipped: false }; // inatteignable : la boucle lève ou réussit
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
      let skippedTx = 0;
      for (const sig of candidates) {
        if (buyers.length >= n) break;
        const { tx, skipped } = await client.getTransactionLenient(sig.signature);
        read += 1;
        if (skipped) skippedTx += 1;
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
      return { mint, buyers, signaturesScanned: scanned, transactionsRead: read, truncated, skippedTx, credits: credits - before0 };
    },
    async getWalletTokenHistory(address, o = {}) {
      const limit = Math.min(o.limit ?? 20, 100);
      const before0 = credits;
      const sigs = await client.getSignaturesForAddress(address, { limit });
      const events: WalletTokenEvent[] = [];
      let read = 0;
      let skippedTx = 0;
      for (const s of sigs) {
        if (s.err) continue;
        const { tx, skipped } = await client.getTransactionLenient(s.signature);
        read += 1;
        if (skipped) skippedTx += 1;
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
      return { address, events, signaturesScanned: sigs.length, transactionsRead: read, skippedTx, credits: credits - before0 };
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
