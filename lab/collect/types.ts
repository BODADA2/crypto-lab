/**
 * Types du plan données (collecte + signaux + backtest + brief).
 *
 * Depuis le chantier 1 (docs/architecture-v2.md), `TokenSnapshot` est UNIQUE et vit dans `lab/types.ts` :
 * ce fichier le ré-exporte et fournit les helpers de construction / normalisation. Les autres types
 * (profils, boosts, événements PumpPortal, early buyers, Reddit, GitHub, ScanResult) restent locaux.
 */
import { UNKNOWN_AUTHORITY, type Authority, type SnapshotSource, type TokenSnapshot, type WindowedNumber, type WindowedTxns } from "../types.ts";

export { UNKNOWN_AUTHORITY };
export type { Authority, SnapshotSource, TokenSnapshot, Window, WindowedNumber, WindowedTxns } from "../types.ts";

/** Fonction fetch injectable (jamais d'appel réseau implicite). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function zeroWindows(): WindowedNumber {
  return { m5: 0, h1: 0, h6: 0, h24: 0 };
}

export function zeroTxns(): WindowedTxns {
  return { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } };
}

/** `createdAt` dérivé : ISO de `pairCreatedAt` si connu, sinon `fetchedAt` (âge 0 ⇒ refus AGE_MIN, jamais un âge inventé). */
export function derivedCreatedAt(pairCreatedAt: number | null | undefined, fetchedAt: string): string {
  return typeof pairCreatedAt === "number" && Number.isFinite(pairCreatedAt) && pairCreatedAt > 0 ? new Date(pairCreatedAt).toISOString() : fetchedAt;
}

/** Champs obligatoires pour construire un instantané ; tout le reste prend la valeur « inconnu » documentée dans lab/types.ts. */
export type SnapshotSeed = Pick<TokenSnapshot, "mint" | "fetchedAt"> & Partial<Omit<TokenSnapshot, "mint" | "fetchedAt">>;

/**
 * Construit un TokenSnapshot complet à partir d'un sous-ensemble de champs.
 * Défauts = inconnus explicites et conservateurs (holders null, top10 100, autorités "UNKNOWN", prix/liquidité 0).
 * `createdAt` est dérivé de `pairCreatedAt` sauf s'il est fourni explicitement.
 */
export function makeSnapshot(seed: SnapshotSeed): TokenSnapshot {
  const pairCreatedAt = seed.pairCreatedAt ?? null;
  const snap: TokenSnapshot = {
    mint: seed.mint,
    chain: "solana",
    symbol: seed.symbol ?? "",
    name: seed.name ?? "",
    createdAt: seed.createdAt ?? derivedCreatedAt(pairCreatedAt, seed.fetchedAt),
    pairCreatedAt,
    pairAddress: seed.pairAddress ?? null,
    dexId: seed.dexId ?? null,
    url: seed.url ?? null,
    priceUsd: seed.priceUsd ?? 0,
    liquidityUsd: seed.liquidityUsd ?? 0,
    fdvUsd: seed.fdvUsd ?? null,
    marketCapUsd: seed.marketCapUsd ?? null,
    volume: seed.volume ? { ...seed.volume } : zeroWindows(),
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    priceChange: seed.priceChange ? { ...seed.priceChange } : zeroWindows(),
    txns: seed.txns ? { m5: { ...seed.txns.m5 }, h1: { ...seed.txns.h1 }, h6: { ...seed.txns.h6 }, h24: { ...seed.txns.h24 } } : zeroTxns(),
    holders: seed.holders ?? null,
    top10Pct: seed.top10Pct ?? 100,
    mintAuthority: seed.mintAuthority === undefined ? UNKNOWN_AUTHORITY : seed.mintAuthority,
    freezeAuthority: seed.freezeAuthority === undefined ? UNKNOWN_AUTHORITY : seed.freezeAuthority,
    boostsActive: seed.boostsActive ?? 0,
    pairCount: seed.pairCount ?? 1,
    source: seed.source ?? "manual",
    fetchedAt: seed.fetchedAt,
  };
  if (seed.decimals !== undefined) snap.decimals = seed.decimals;
  if (seed.riskyExtensions !== undefined) snap.riskyExtensions = [...seed.riskyExtensions];
  return syncVolumeViews(snap);
}

/** Recopie `volume.{m5,h1,h24}` dans les vues plates `volume5m/1h/24h` (mutation, renvoie le même objet). */
export function syncVolumeViews<T extends Pick<TokenSnapshot, "volume" | "volume5m" | "volume1h" | "volume24h">>(snap: T): T {
  snap.volume5m = snap.volume.m5;
  snap.volume1h = snap.volume.h1;
  snap.volume24h = snap.volume.h24;
  return snap;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function windowsOf(v: unknown): WindowedNumber {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof WindowedNumber, unknown>>;
  return { m5: num(o.m5), h1: num(o.h1), h6: num(o.h6), h24: num(o.h24) };
}

function txnsOf(v: unknown): WindowedTxns {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof WindowedTxns, { buys?: unknown; sells?: unknown } | undefined>>;
  const w = (k: keyof WindowedTxns) => ({ buys: num(o[k]?.buys), sells: num(o[k]?.sells) });
  return { m5: w("m5"), h1: w("h1"), h6: w("h6"), h24: w("h24") };
}

/**
 * Lecture TOLÉRANTE d'un objet JSON (fichier `data/history`, `data/tokens`, fixture) vers le type unifié.
 * Accepte les deux anciens formats (collecte riche : `volume.{m5,…}`, `pairAddress` ; risque plat : `volume5m`,
 * `dexPair`) et remplit tout champ manquant avec sa valeur « inconnu ». Renvoie null si `mint` ou `fetchedAt`
 * manquent (ligne inutilisable). Jamais d'exception.
 */
export function normalizeSnapshot(raw: unknown): TokenSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.mint !== "string" || r.mint.length === 0) return null;
  if (typeof r.fetchedAt !== "string" || r.fetchedAt.length === 0) return null;
  const legacyVolume = "volume5m" in r || "volume1h" in r || "volume24h" in r;
  const volume = r.volume && typeof r.volume === "object" ? windowsOf(r.volume) : legacyVolume ? { m5: num(r.volume5m), h1: num(r.volume1h), h6: 0, h24: num(r.volume24h) } : zeroWindows();
  const pairCreatedAt = numOrNull(r.pairCreatedAt);
  const createdAt = typeof r.createdAt === "string" && r.createdAt.length > 0 ? r.createdAt : derivedCreatedAt(pairCreatedAt, r.fetchedAt);
  const authority = (v: unknown): Authority => (v === null ? null : typeof v === "string" && v.length > 0 ? v : UNKNOWN_AUTHORITY);
  const snap = makeSnapshot({
    mint: r.mint,
    fetchedAt: r.fetchedAt,
    symbol: typeof r.symbol === "string" ? r.symbol : "",
    name: typeof r.name === "string" ? r.name : "",
    createdAt,
    pairCreatedAt: pairCreatedAt ?? (createdAt !== r.fetchedAt && Number.isFinite(Date.parse(createdAt)) ? Date.parse(createdAt) : null),
    pairAddress: strOrNull(r.pairAddress) ?? strOrNull(r.dexPair),
    dexId: strOrNull(r.dexId),
    url: strOrNull(r.url),
    priceUsd: num(r.priceUsd),
    liquidityUsd: num(r.liquidityUsd),
    fdvUsd: numOrNull(r.fdvUsd),
    marketCapUsd: numOrNull(r.marketCapUsd),
    volume,
    priceChange: windowsOf(r.priceChange),
    txns: txnsOf(r.txns),
    holders: numOrNull(r.holders),
    top10Pct: typeof r.top10Pct === "number" && Number.isFinite(r.top10Pct) ? r.top10Pct : 100,
    mintAuthority: authority(r.mintAuthority),
    freezeAuthority: authority(r.freezeAuthority),
    boostsActive: num(r.boostsActive),
    pairCount: typeof r.pairCount === "number" && r.pairCount > 0 ? r.pairCount : 1,
    source: (typeof r.source === "string" && r.source.length > 0 ? r.source : "manual") as SnapshotSource,
  });
  if (typeof r.decimals === "number" && Number.isInteger(r.decimals) && r.decimals >= 0) snap.decimals = r.decimals;
  if (Array.isArray(r.riskyExtensions)) snap.riskyExtensions = r.riskyExtensions.filter((x): x is string => typeof x === "string");
  return snap;
}

/** Profil DexScreener (token-profiles/latest/v1) normalisé. */
export interface TokenProfile {
  chainId: string;
  tokenAddress: string;
  url: string;
  description: string | null;
  links: Array<{ type?: string; label?: string; url: string }>;
  icon: string | null;
}

/** Boost DexScreener (token-boosts/top/v1) normalisé. */
export interface TokenBoost extends TokenProfile {
  amount: number;
  totalAmount: number;
}

/** Événement PumpPortal (création ou migration). */
export interface PumpEvent {
  kind: "create" | "migrate";
  mint: string;
  signature: string | null;
  name: string | null;
  symbol: string | null;
  traderPublicKey: string | null;
  solAmount: number | null;
  marketCapSol: number | null;
  pool: string | null;
  receivedAt: string;
  raw: unknown;
}

/** Acheteur précoce détecté via Helius. */
export interface EarlyBuyer {
  wallet: string;
  signature: string;
  blockTime: number | null;
  slot: number;
  /** Rang d'apparition (0 = tout premier acheteur). */
  rank: number;
  /** Quantité reçue (unités brutes, chaîne pour éviter la perte de précision). */
  amountRaw: string;
}

/** Ligne d'historique d'un wallet (mint touché dans une transaction). */
export interface WalletTokenEvent {
  signature: string;
  blockTime: number | null;
  mint: string;
  /** Variation nette (unités brutes, signée, en chaîne). */
  deltaRaw: string;
  direction: "in" | "out";
}

/** Post Reddit normalisé. */
export interface RedditPost {
  id: string;
  subreddit: string;
  title: string;
  selftext: string;
  author: string;
  createdUtc: number;
  score: number;
  numComments: number;
  permalink: string;
  url: string;
  tickers: string[];
  mints: string[];
}

/** Dépôt GitHub normalisé. */
export interface GithubRepo {
  fullName: string;
  url: string;
  description: string | null;
  stars: number;
  language: string | null;
  topics: string[];
  createdAt: string;
  pushedAt: string;
  tickers: string[];
  mints: string[];
}

/** Sortie d'un cycle de collecte (`data/scans/<ISO>.json`). */
export interface ScanResult {
  startedAt: string;
  finishedAt: string;
  profiles: TokenProfile[];
  boosts: TokenBoost[];
  tokens: TokenSnapshot[];
  reddit: RedditPost[];
  github: GithubRepo[];
  errors: Array<{ source: string; message: string }>;
  requests: { dexscreener: number; reddit: number; github: number };
}
