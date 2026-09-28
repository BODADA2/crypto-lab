/**
 * Phase 2 — construction des snapshots early buyers STRICTEMENT pré-t0.
 *
 * Pipeline par mint :
 *  1. série data/history/<mint>.jsonl → t0 = findT0 (premier snapshot
 *     priceUsd>0 et liquidityUsd>=20000), converti en ms ;
 *  2. fichier data/earlybuyers/<mint>.json → EARLY_BUYER_SET(t0) = buyers avec
 *     blockTime != null ET blockTime*1000 <= t0ms, triés par rank ;
 *     < 5 buyers → snapshot exclu avec raison documentée ;
 *  3. historique on-chain par wallet via Helius (getSignaturesForAddress,
 *     limite 1000) → filtré blockTime*1000 <= t0ms AVANT tout calcul ;
 *  4. pour les top-10 par montant : jusqu'à 8 transactions pré-t0 les plus
 *     récentes (getTransaction) → deltas de tokens → tokensTouchedPreT0,
 *     buySellCountRatio.
 *
 * Cache : data/earlybuyers/wallet-histories/<wallet>.json — stocke les données
 * BRUTES (signatures + deltas par transaction), indépendantes du mint. Le
 * filtrage <= t0ms est refait à chaque lecture du cache : idempotent, on ne
 * re-paie l'API que si la donnée brute est absente. Un échec de récupération
 * (ex. transaction v1 non supportée par le client) est mémorisé pour ne pas
 * être re-payé, et les champs dérivés deviennent null (jamais inventés).
 *
 * CONTAMINATION Phase 1 : les features `sellersOver50` / `medianSoldFrac` de
 * lab/predictive/wallets/features.ts étaient calculées sur des ventes
 * POST-migration (+5 min) — fuite temporelle. Elles sont INTERDITES ici :
 * aucune lecture du champ `sells` des fichiers earlybuyers, aucune feature
 * dérivée de données post-t0.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TokenSnapshot } from "../../types.ts";
import { findT0, splitUniverse } from "../universe.ts";
import {
  createHeliusClient,
  type HeliusClient,
  type ParsedTransaction,
  type SignatureInfo,
} from "../../collect/helius.ts";
import { getHeliusRpcUrl } from "../../collect/helius-auth.ts";
import type {
  EarlyBuyerSnapshot,
  SnapshotBuyer,
  WalletHistory,
} from "./types.ts";

const EARLYBUYERS_DIR = "data/earlybuyers";
const HISTORY_DIR = "data/history";
const WALLET_CACHE_DIR = join(EARLYBUYERS_DIR, "wallet-histories");

const SIG_LIMIT = 1000;
const TOP_WALLETS_TX = 10;
const MAX_TX_PER_WALLET = 8;
const MIN_BUYERS = 5;

/* ------------------------------------------------------------------ */
/* Cache brut par wallet (indépendant du mint, filtrage t0 à la lecture) */
/* ------------------------------------------------------------------ */

interface CachedSignature {
  signature: string;
  slot: number;
  blockTime: number | null; // secondes unix, null si inconnu
}

interface CachedTx {
  slot: number;
  blockTime: number | null;
  deltas: { mint: string; delta: string; decimals: number }[];
  fetchError?: string;
}

interface WalletCache {
  wallet: string;
  fetchedAt: string;
  signatures: CachedSignature[] | null; // null = échec de récupération
  transactions: Record<string, CachedTx>;
}

function cachePath(wallet: string): string {
  return join(WALLET_CACHE_DIR, `${wallet}.json`);
}

function readWalletCache(wallet: string): WalletCache | null {
  try {
    const raw = readFileSync(cachePath(wallet), "utf-8");
    const d = JSON.parse(raw) as WalletCache;
    if (d.wallet !== wallet) return null;
    return d;
  } catch {
    return null;
  }
}

function writeWalletCache(c: WalletCache): void {
  mkdirSync(WALLET_CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(c.wallet), JSON.stringify(c));
}

/* ------------------------------------------------------------------ */
/* Lecture des sources */
/* ------------------------------------------------------------------ */

interface RawBuyer {
  wallet: string;
  blockTime: number | null;
  slot: number | null;
  rank: number;
  amountRaw: string;
}

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v));
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  return 0n;
}

function readEarlyBuyersRaw(mint: string): RawBuyer[] | null {
  let raw: string;
  try {
    raw = readFileSync(join(EARLYBUYERS_DIR, `${mint}.json`), "utf-8");
  } catch {
    return null;
  }
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const arr = d["buyers"];
  if (!Array.isArray(arr)) return null;
  const out: RawBuyer[] = [];
  for (const b of arr) {
    if (typeof b !== "object" || b === null) continue;
    const r = b as Record<string, unknown>;
    if (typeof r["wallet"] !== "string") continue;
    out.push({
      wallet: r["wallet"] as string,
      blockTime: typeof r["blockTime"] === "number" ? (r["blockTime"] as number) : null,
      slot: typeof r["slot"] === "number" ? (r["slot"] as number) : null,
      rank: typeof r["rank"] === "number" ? (r["rank"] as number) : 0,
      amountRaw: String(r["amountRaw"] ?? "0"),
    });
  }
  return out;
}

function readHistorySeries(mint: string): TokenSnapshot[] | null {
  let raw: string;
  try {
    raw = readFileSync(join(HISTORY_DIR, `${mint}.jsonl`), "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  try {
    return lines.map((l) => JSON.parse(l) as TokenSnapshot);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Deltas de tokens depuis une transaction parsée */
/* ------------------------------------------------------------------ */

interface TokenDelta {
  mint: string;
  delta: bigint;
  decimals: number;
}

/** Deltas de balances token du wallet entre pre et post (agrégés par mint). */
function tokenDeltasForWallet(tx: ParsedTransaction, wallet: string): TokenDelta[] {
  const meta = tx.meta;
  if (!meta) return [];
  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  const byKey = new Map<string, { pre: bigint; post: bigint; decimals: number; mint: string }>();
  const key = (owner: string | undefined, mint: string, accountIndex: number) =>
    `${owner ?? "?"}|${mint}|${accountIndex}`;
  for (const b of pre) {
    if (b.owner !== wallet) continue;
    const k = key(b.owner, b.mint, b.accountIndex);
    const e = byKey.get(k) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals, mint: b.mint };
    e.pre = toBigInt(b.uiTokenAmount.amount);
    byKey.set(k, e);
  }
  for (const b of post) {
    if (b.owner !== wallet) continue;
    const k = key(b.owner, b.mint, b.accountIndex);
    const e = byKey.get(k) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals, mint: b.mint };
    e.post = toBigInt(b.uiTokenAmount.amount);
    byKey.set(k, e);
  }
  const agg = new Map<string, { delta: bigint; decimals: number }>();
  for (const e of byKey.values()) {
    const d = e.post - e.pre;
    if (d === 0n) continue;
    const a = agg.get(e.mint) ?? { delta: 0n, decimals: e.decimals };
    a.delta += d;
    agg.set(e.mint, a);
  }
  return [...agg.entries()].map(([mint, a]) => ({ mint, delta: a.delta, decimals: a.decimals }));
}

/* ------------------------------------------------------------------ */
/* Construction du snapshot */
/* ------------------------------------------------------------------ */

export interface SnapshotOptions {
  /** Client Helius injecté (tests) ; sinon créé paresseusement via le skill. */
  helius?: HeliusClient;
  /** false = n'utiliser que le cache (aucun appel réseau). */
  fetchMissing?: boolean;
}

function lazyClient(opts: SnapshotOptions): HeliusClient | null {
  if (opts.helius) return opts.helius;
  if (opts.fetchMissing === false) return null;
  try {
    const url = getHeliusRpcUrl();
    return createHeliusClient({ fetch, rpcUrl: url });
  } catch {
    return null;
  }
}

/** Récupère (ou lit du cache) les données brutes d'un wallet. */
async function getRawWalletData(
  wallet: string,
  client: HeliusClient | null,
): Promise<WalletCache> {
  const cached = readWalletCache(wallet);
  if (cached) return cached;
  const c: WalletCache = {
    wallet,
    fetchedAt: new Date().toISOString(),
    signatures: null,
    transactions: {},
  };
  if (client) {
    try {
      const sigs: SignatureInfo[] = await client.getSignaturesForAddress(wallet, {
        limit: SIG_LIMIT,
      });
      c.signatures = sigs.map((s) => ({
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime,
      }));
    } catch {
      c.signatures = null; // échec mémorisé : champs dérivés -> null
    }
  }
  writeWalletCache(c);
  return c;
}

/** Assure la présence des deltas pour les signatures demandées (cache d'abord). */
async function ensureTxDeltas(
  cache: WalletCache,
  sigs: CachedSignature[],
  client: HeliusClient | null,
): Promise<void> {
  let dirty = false;
  for (const s of sigs) {
    if (cache.transactions[s.signature]) continue;
    if (!client) continue;
    try {
      const tx = await client.getTransaction(s.signature);
      if (!tx) {
        cache.transactions[s.signature] = {
          slot: s.slot,
          blockTime: s.blockTime,
          deltas: [],
          fetchError: "getTransaction-null",
        };
      } else {
        const deltas = tokenDeltasForWallet(tx, cache.wallet);
        cache.transactions[s.signature] = {
          slot: tx.slot,
          blockTime: tx.blockTime,
          deltas: deltas.map((d) => ({
            mint: d.mint,
            delta: d.delta.toString(),
            decimals: d.decimals,
          })),
        };
      }
    } catch (e) {
      // ex. "Transaction version (1) is not supported" — mémorisé, non re-payé.
      cache.transactions[s.signature] = {
        slot: s.slot,
        blockTime: s.blockTime,
        deltas: [],
        fetchError: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160),
      };
    }
    dirty = true;
  }
  if (dirty) writeWalletCache(cache);
}

function buildWalletHistory(
  wallet: string,
  cache: WalletCache,
  t0ms: number,
  currentMint: string,
  txSigs: CachedSignature[],
): WalletHistory {
  const base: WalletHistory = {
    wallet,
    txCountPreT0: null,
    walletAgeSec: null,
    recencySec: null,
    activeDaysPreT0: null,
    tokensTouchedPreT0: null,
    buySellCountRatio: null,
    histMaxTsMs: null,
    txMaxTsMs: null,
  };
  if (!cache.signatures) return base; // échec de récupération : tout null
  const pre = cache.signatures.filter(
    (s) => s.blockTime != null && s.blockTime * 1000 <= t0ms,
  );
  if (pre.length === 0) {
    base.txCountPreT0 = 0;
    base.activeDaysPreT0 = 0;
    return base;
  }
  const times = pre.map((s) => s.blockTime! * 1000);
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  base.txCountPreT0 = pre.length;
  base.walletAgeSec = (t0ms - oldest) / 1000;
  base.recencySec = (t0ms - newest) / 1000;
  const days = new Set(times.map((t) => new Date(t).toISOString().slice(0, 10)));
  base.activeDaysPreT0 = days.size;
  base.histMaxTsMs = newest;

  // Deltas des txs lues (top wallets uniquement ; txSigs déjà filtrées <= t0ms).
  let maxTx = 0;
  const touched = new Set<string>();
  let pos = 0;
  let neg = 0;
  let anyTx = false;
  for (const s of txSigs) {
    const tx = cache.transactions[s.signature];
    if (!tx || tx.fetchError) continue;
    if (tx.blockTime == null || tx.blockTime * 1000 > t0ms) continue; // re-vérification stricte
    anyTx = true;
    maxTx = Math.max(maxTx, tx.blockTime * 1000);
    for (const d of tx.deltas) {
      if (d.mint === currentMint) continue; // le buy courant n'est pas une "touche"
      const delta = toBigInt(d.delta);
      if (delta === 0n) continue;
      touched.add(d.mint);
      if (delta > 0n) pos++;
      else neg++;
    }
  }
  if (anyTx) {
    base.txMaxTsMs = maxTx;
    base.tokensTouchedPreT0 = touched.size;
    base.buySellCountRatio = neg > 0 ? pos / neg : null;
  }
  return base;
}

/**
 * Construit le snapshot d'un mint. Retourne un snapshot avec `excludedReason`
 * non-null si le mint ne peut pas être utilisé (fichier absent, pas de t0,
 * < 5 buyers pré-t0).
 */
export async function buildSnapshot(
  mint: string,
  opts: SnapshotOptions = {},
): Promise<EarlyBuyerSnapshot> {
  const universe = splitUniverse(mint);
  const fail = (reason: string): EarlyBuyerSnapshot => ({
    mint,
    universe,
    t0ms: 0,
    buyers: [],
    histories: {},
    excludedReason: reason,
  });

  const series = readHistorySeries(mint);
  if (!series) return fail("pas de série data/history");
  const t0idx = findT0(series);
  if (t0idx < 0) return fail("pas de t0 (priceUsd>0 & liquidityUsd>=20000)");
  const sorted = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0ms = Date.parse(sorted[t0idx]!.fetchedAt);

  const raw = readEarlyBuyersRaw(mint);
  if (!raw) return fail("pas de fichier data/earlybuyers");

  // EARLY_BUYER_SET(t0) : blockTime on-chain <= t0ms, triés par rank.
  const set: SnapshotBuyer[] = raw
    .filter((b) => b.blockTime != null && b.blockTime * 1000 <= t0ms)
    .map((b) => ({
      wallet: b.wallet,
      blockTimeMs: b.blockTime! * 1000,
      slot: b.slot,
      rank: b.rank,
      amountRaw: toBigInt(b.amountRaw),
    }))
    .sort((a, b) => a.rank - b.rank);
  if (set.length < MIN_BUYERS) {
    return fail(`set pré-t0 = ${set.length} buyers (< ${MIN_BUYERS})`);
  }

  // Historiques wallets (cache d'abord ; réseau seulement si absent).
  const client = lazyClient(opts);
  const histories: Record<string, WalletHistory> = {};
  const topByAmount = [...set]
    .sort((a, b) => (a.amountRaw > b.amountRaw ? -1 : a.amountRaw < b.amountRaw ? 1 : 0))
    .slice(0, TOP_WALLETS_TX)
    .map((b) => b.wallet);
  const topSet = new Set(topByAmount);

  for (const b of set) {
    const cache = await getRawWalletData(b.wallet, client);
    let txSigs: CachedSignature[] = [];
    if (topSet.has(b.wallet) && cache.signatures) {
      // 8 transactions pré-t0 les plus récentes.
      txSigs = cache.signatures
        .filter((s) => s.blockTime != null && s.blockTime * 1000 <= t0ms)
        .sort((a, b2) => b2.blockTime! - a.blockTime! || b2.slot - a.slot)
        .slice(0, MAX_TX_PER_WALLET);
      await ensureTxDeltas(cache, txSigs, client);
    }
    histories[b.wallet] = buildWalletHistory(b.wallet, cache, t0ms, mint, txSigs);
  }

  return { mint, universe, t0ms, buyers: set, histories, excludedReason: null };
}

/** Construit les snapshots pour une liste de mints (séquentiel, respect rate-limit). */
export async function buildSnapshots(
  mints: string[],
  opts: SnapshotOptions = {},
): Promise<EarlyBuyerSnapshot[]> {
  const out: EarlyBuyerSnapshot[] = [];
  for (const m of mints) out.push(await buildSnapshot(m, opts));
  return out;
}

export { WALLET_CACHE_DIR };
