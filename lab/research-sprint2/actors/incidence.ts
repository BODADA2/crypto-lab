/**
 * SPRINT 2C — incidence wallet → mints (famille E : Actors/Entity).
 *
 * Construit, depuis les caches early buyers (lecture seule), l'incidence
 * wallet → mints sur les sets STRICTEMENT pré-t0 (même règle que
 * snapshot.ts : blockTime != null && blockTime*1000 <= t0ms).
 *
 * Règles point-in-time :
 *  - t0 = premier snapshot data/history avec liquidityUsd >= 20 000 ;
 *  - univers DISCOVERY uniquement (holdout jamais lu) ;
 *  - mint SKHY (glitch) exclu ;
 *  - un wallet n'est « récurrent » pour un mint m que s'il apparaît dans
 *    ≥1 AUTRE mint avec t0' < t0(m) — jamais le futur.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TokenSnapshot } from "../../types.ts";
import { findT0, splitUniverse, type Universe } from "../../predictive/universe.ts";
import { DATA_ERROR_MINTS } from "../../predictive/earlybuyers/labels.ts";

const EARLYBUYERS_DIR = "data/earlybuyers";
const HISTORY_DIR = "data/history";

export interface PreT0Buyer {
  wallet: string;
  slot: number | null;
  blockTimeMs: number;
  amountRaw: string;
}

export interface MintSet {
  mint: string;
  t0ms: number;
  universe: Universe;
  buyers: PreT0Buyer[];
}

interface CacheBuyer {
  wallet: string;
  signature: string;
  blockTime: number | null;
  slot: number | null;
  rank: number;
  amountRaw: string;
}

function readSeries(mint: string): TokenSnapshot[] | null {
  try {
    const raw = readFileSync(join(HISTORY_DIR, `${mint}.jsonl`), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;
    return lines.map((l) => JSON.parse(l) as TokenSnapshot);
  } catch {
    return null;
  }
}

/**
 * Charge les sets pré-t0 des mints DISCOVERY avec historique + t0.
 * SKHY exclu. Les fichiers backfill sont lus en l'état (lecture seule).
 */
export function loadMintSets(opts: { maxMints?: number } = {}): MintSet[] {
  const files = readdirSync(EARLYBUYERS_DIR).filter((f) => f.endsWith(".json"));
  const out: MintSet[] = [];
  for (const f of files) {
    const mint = f.slice(0, -".json".length);
    if (DATA_ERROR_MINTS.has(mint)) continue;
    if (splitUniverse(mint) !== "discovery") continue;
    const series = readSeries(mint);
    if (!series) continue;
    const sorted = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    const t0idx = findT0(sorted);
    if (t0idx < 0) continue;
    const t0ms = Date.parse(sorted[t0idx]!.fetchedAt);
    const raw = JSON.parse(readFileSync(join(EARLYBUYERS_DIR, f), "utf-8")) as {
      buyers: CacheBuyer[];
    };
    const buyers: PreT0Buyer[] = [];
    for (const b of raw.buyers ?? []) {
      if (b.blockTime == null) continue;
      const bms = b.blockTime * 1000;
      if (bms > t0ms) continue;
      buyers.push({
        wallet: b.wallet,
        slot: b.slot ?? null,
        blockTimeMs: bms,
        amountRaw: b.amountRaw ?? "0",
      });
    }
    out.push({ mint, t0ms, universe: "discovery", buyers });
    if (opts.maxMints && out.length >= opts.maxMints) break;
  }
  out.sort((a, b) => a.t0ms - b.t0ms);
  return out;
}

export interface WalletObservation {
  mint: string;
  blockTimeMs: number;
}

/** Incidence : wallet → observations {mint, blockTimeMs} (toutes pré-t0). */
export function buildIncidence(sets: MintSet[]): Map<string, WalletObservation[]> {
  const inc = new Map<string, WalletObservation[]>();
  for (const s of sets) {
    for (const b of s.buyers) {
      const arr = inc.get(b.wallet) ?? [];
      arr.push({ mint: s.mint, blockTimeMs: b.blockTimeMs });
      inc.set(b.wallet, arr);
    }
  }
  return inc;
}

/** t0ms par mint. */
export function t0ByMint(sets: MintSet[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sets) m.set(s.mint, s.t0ms);
  return m;
}

/**
 * Wallets récurrents pour le mint `mint` (t0ms) : présents dans ≥
 * `minOtherMints` AUTRES mints avec t0' < t0ms. Point-in-time strict :
 * seules les observations antérieures à t0ms comptent.
 */
export function recurrentWalletsAsOf(
  inc: Map<string, WalletObservation[]>,
  t0: Map<string, number>,
  mint: string,
  t0ms: number,
  minOtherMints = 1,
): Set<string> {
  const out = new Set<string>();
  for (const [wallet, obs] of inc) {
    let past = 0;
    let inCurrent = false;
    for (const o of obs) {
      if (o.mint === mint) {
        inCurrent = true;
        continue;
      }
      const ot0 = t0.get(o.mint);
      if (ot0 != null && ot0 < t0ms) past++;
    }
    if (inCurrent && past >= minOtherMints) out.add(wallet);
  }
  return out;
}

/** Wallets apparaissant dans ≥2 mints (tout l'univers discovery, sans filtre temporel — data-quality uniquement). */
export function recurrentWalletsOverall(
  inc: Map<string, WalletObservation[]>,
): string[] {
  const out: string[] = [];
  for (const [wallet, obs] of inc) {
    const mints = new Set(obs.map((o) => o.mint));
    if (mints.size >= 2) out.push(wallet);
  }
  return out.sort();
}
