/**
 * Client DexScreener (API publique, sans clé, 60 req/min par endpoint — docs.dexscreener.com/api/reference).
 *
 * Endpoints utilisés :
 *   GET /token-profiles/latest/v1          → derniers profils (tableau)
 *   GET /token-boosts/top/v1               → tokens les plus boostés (tableau)
 *   GET /latest/dex/tokens/{addr,addr,...} → { schemaVersion, pairs[] } (jusqu'à 30 adresses)
 *   GET /token-pairs/v1/{chainId}/{addr}   → pairs[] (tableau nu)
 *   GET /latest/dex/search?q=...           → { schemaVersion, pairs[] }
 *
 * Tout appel réseau passe par `fetch` injecté, le limiteur et le cache.
 */
import type { DiskCache } from "./cache.ts";
import { createMemoryCache } from "./cache.ts";
import { createLimiter, type Limiter } from "./ratelimit.ts";
import { derivedCreatedAt, syncVolumeViews, UNKNOWN_AUTHORITY, type FetchLike, type TokenBoost, type TokenProfile, type TokenSnapshot, type WindowedNumber, type WindowedTxns } from "./types.ts";

export const DEXSCREENER_BASE = "https://api.dexscreener.com";

/** Schéma brut d'une paire DexScreener (champs réellement observés). */
export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Partial<Record<keyof WindowedTxns, { buys: number; sells: number }>>;
  volume?: Partial<WindowedNumber>;
  priceChange?: Partial<WindowedNumber>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    header?: string;
    openGraph?: string;
    websites?: Array<{ label?: string; url: string }>;
    socials?: Array<{ type?: string; url: string }>;
  };
  boosts?: { active?: number };
}

export interface DexPairsResponse {
  schemaVersion: string;
  pairs: DexPair[] | null;
}

export interface DexProfileRaw {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  openGraph?: string;
  description?: string;
  links?: Array<{ type?: string; label?: string; url: string }>;
}

export interface DexBoostRaw extends DexProfileRaw {
  amount: number;
  totalAmount: number;
}

export interface DexScreenerClientOptions {
  fetch: FetchLike;
  cache?: DiskCache;
  limiter?: Limiter;
  now?: () => number;
  baseUrl?: string;
  /** TTL du cache pour les listes (profils/boosts), défaut 60 s. */
  listTtlMs?: number;
  /** TTL du cache pour les paires, défaut 30 s. */
  pairTtlMs?: number;
}

export interface DexScreenerClient {
  getLatestProfiles(chainId?: string): Promise<TokenProfile[]>;
  getTopBoosts(chainId?: string): Promise<TokenBoost[]>;
  getPairsByTokens(mints: string[]): Promise<DexPair[]>;
  getTokenPairs(mint: string, chainId?: string): Promise<DexPair[]>;
  search(query: string): Promise<DexPair[]>;
  /** Snapshots normalisés (une entrée par mint, paire la plus liquide). */
  getSnapshots(mints: string[]): Promise<TokenSnapshot[]>;
  /** Nombre de requêtes réellement envoyées (hors cache). */
  readonly requestCount: number;
}

export class DexScreenerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "DexScreenerError";
  }
}

export function createDexScreenerClient(opts: DexScreenerClientOptions): DexScreenerClient {
  const now = opts.now ?? (() => Date.now());
  const cache = opts.cache ?? createMemoryCache(now);
  const limiter = opts.limiter ?? createLimiter({ max: 60, windowMs: 60_000, now });
  const base = opts.baseUrl ?? DEXSCREENER_BASE;
  const listTtl = opts.listTtlMs ?? 60_000;
  const pairTtl = opts.pairTtlMs ?? 30_000;
  let requestCount = 0;

  async function getJson<T>(path: string, ttlMs: number): Promise<T> {
    const url = base + path;
    const cached = cache.get<T>(url);
    if (cached !== undefined) return cached;
    const res = await limiter.schedule(() => opts.fetch(url, { headers: { accept: "application/json" } }));
    requestCount += 1;
    if (!res.ok) throw new DexScreenerError(`DexScreener ${res.status} sur ${path}`, res.status, url);
    const json = (await res.json()) as T;
    cache.set(url, json, ttlMs);
    return json;
  }

  function pairsOf(resp: DexPairsResponse | DexPair[] | null | undefined): DexPair[] {
    if (!resp) return [];
    if (Array.isArray(resp)) return resp;
    return Array.isArray(resp.pairs) ? resp.pairs : [];
  }

  return {
    get requestCount() {
      return requestCount;
    },
    async getLatestProfiles(chainId = "solana") {
      const raw = await getJson<DexProfileRaw[]>("/token-profiles/latest/v1", listTtl);
      return (Array.isArray(raw) ? raw : []).filter((p) => p.chainId === chainId).map(normalizeProfile);
    },
    async getTopBoosts(chainId = "solana") {
      const raw = await getJson<DexBoostRaw[]>("/token-boosts/top/v1", listTtl);
      return (Array.isArray(raw) ? raw : [])
        .filter((p) => p.chainId === chainId)
        .map((b) => ({ ...normalizeProfile(b), amount: num(b.amount), totalAmount: num(b.totalAmount) }));
    },
    async getPairsByTokens(mints) {
      const out: DexPair[] = [];
      for (const chunk of chunks(uniq(mints), 30)) {
        const resp = await getJson<DexPairsResponse>(`/latest/dex/tokens/${chunk.join(",")}`, pairTtl);
        out.push(...pairsOf(resp));
      }
      return out;
    },
    async getTokenPairs(mint, chainId = "solana") {
      const resp = await getJson<DexPair[]>(`/token-pairs/v1/${chainId}/${mint}`, pairTtl);
      return pairsOf(resp);
    },
    async search(query) {
      const resp = await getJson<DexPairsResponse>(`/latest/dex/search?q=${encodeURIComponent(query)}`, pairTtl);
      return pairsOf(resp);
    },
    async getSnapshots(mints) {
      const pairs = await this.getPairsByTokens(mints);
      const fetchedAt = new Date(now()).toISOString();
      return snapshotsFromPairs(pairs, fetchedAt).filter((s) => mints.includes(s.mint));
    },
  };
}

// ---------------------------------------------------------------------------
// Normalisation (fonctions pures)
// ---------------------------------------------------------------------------

export function normalizeProfile(p: DexProfileRaw): TokenProfile {
  return {
    chainId: p.chainId,
    tokenAddress: p.tokenAddress,
    url: p.url,
    description: p.description ?? null,
    links: Array.isArray(p.links) ? p.links.filter((l) => typeof l?.url === "string") : [],
    icon: p.icon ?? null,
  };
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function windowed(v: Partial<WindowedNumber> | undefined): WindowedNumber {
  return { m5: num(v?.m5), h1: num(v?.h1), h6: num(v?.h6), h24: num(v?.h24) };
}

function windowedTxns(v: DexPair["txns"]): WindowedTxns {
  const w = (k: keyof WindowedTxns) => ({ buys: num(v?.[k]?.buys), sells: num(v?.[k]?.sells) });
  return { m5: w("m5"), h1: w("h1"), h6: w("h6"), h24: w("h24") };
}

/**
 * Convertit une paire DexScreener en TokenSnapshot (du point de vue du baseToken).
 * Ce que DexScreener ne fournit pas reste un inconnu explicite : holders null, top10 100, autorités "UNKNOWN",
 * prix/liquidité 0 (voir lab/types.ts).
 */
export function pairToSnapshot(pair: DexPair, fetchedAt: string, pairCount = 1): TokenSnapshot {
  const pairCreatedAt = numOrNull(pair.pairCreatedAt);
  return syncVolumeViews({
    mint: pair.baseToken.address,
    chain: "solana",
    symbol: pair.baseToken.symbol ?? "",
    name: pair.baseToken.name ?? "",
    createdAt: derivedCreatedAt(pairCreatedAt, fetchedAt),
    pairCreatedAt,
    pairAddress: pair.pairAddress ?? null,
    dexId: pair.dexId ?? null,
    url: pair.url ?? null,
    priceUsd: num(pair.priceUsd),
    liquidityUsd: num(pair.liquidity?.usd),
    fdvUsd: numOrNull(pair.fdv),
    marketCapUsd: numOrNull(pair.marketCap),
    volume: windowed(pair.volume),
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    priceChange: windowed(pair.priceChange),
    txns: windowedTxns(pair.txns),
    holders: null,
    top10Pct: 100,
    mintAuthority: UNKNOWN_AUTHORITY,
    freezeAuthority: UNKNOWN_AUTHORITY,
    boostsActive: num(pair.boosts?.active),
    pairCount,
    source: "dexscreener",
    fetchedAt,
  });
}

/**
 * Regroupe les paires par mint (baseToken) et garde la plus liquide ;
 * les volumes sont agrégés sur toutes les paires du token (chaîne solana uniquement).
 */
export function snapshotsFromPairs(pairs: DexPair[], fetchedAt: string): TokenSnapshot[] {
  const byMint = new Map<string, DexPair[]>();
  for (const p of pairs) {
    if (p.chainId !== "solana") continue;
    if (!p.baseToken?.address) continue;
    const list = byMint.get(p.baseToken.address) ?? [];
    list.push(p);
    byMint.set(p.baseToken.address, list);
  }
  const out: TokenSnapshot[] = [];
  for (const [, list] of byMint) {
    list.sort((a, b) => num(b.liquidity?.usd) - num(a.liquidity?.usd));
    const main = list[0] as DexPair;
    const snap = pairToSnapshot(main, fetchedAt, list.length);
    if (list.length > 1) {
      const keys: Array<keyof WindowedNumber> = ["m5", "h1", "h6", "h24"];
      for (const k of keys) {
        snap.volume[k] = list.reduce((s, p) => s + num(p.volume?.[k]), 0);
        snap.txns[k] = {
          buys: list.reduce((s, p) => s + num(p.txns?.[k]?.buys), 0),
          sells: list.reduce((s, p) => s + num(p.txns?.[k]?.sells), 0),
        };
      }
      // Date de création = la plus ancienne des paires connues.
      const created = list.map((p) => numOrNull(p.pairCreatedAt)).filter((v): v is number => v !== null);
      snap.pairCreatedAt = created.length ? Math.min(...created) : null;
      snap.createdAt = derivedCreatedAt(snap.pairCreatedAt, fetchedAt);
      syncVolumeViews(snap);
    }
    out.push(snap);
  }
  return out;
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
