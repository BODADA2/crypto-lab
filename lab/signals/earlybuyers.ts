/**
 * Signal « early-buyer overlap » : wallets présents parmi les 50 premiers acheteurs
 * d'au moins K tokens ayant migré (graduation pump.fun → DEX).
 *
 * Hypothèse testée : certains wallets apparaissent AVANT les mouvements de façon récurrente
 * (bots d'initiés, snipers efficaces, wallets liés aux deployers). La récurrence seule ne prouve
 * pas la rentabilité (voir docs/research-2026-09-24.md §D — piste non documentée) : ce module
 * produit des candidats à suivre, pas des signaux d'achat.
 *
 * Sortie : `data/wallets/<address>.json` = WalletProfile.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EarlyBuyer } from "../collect/types.ts";

export interface EarlyBuyerSet {
  mint: string;
  /** Acheteurs triés par rang (0 = premier). */
  buyers: Array<Pick<EarlyBuyer, "wallet" | "rank"> & Partial<EarlyBuyer>>;
  /** Horodatage de la migration si connu. */
  migratedAt?: string | null;
}

export interface WalletProfile {
  address: string;
  /** Nombre de tokens (parmi N) où le wallet est dans les premiers acheteurs. */
  recurrence: number;
  /** N = nombre de tokens analysés. */
  universe: number;
  /** Score 0–100 : récurrence pondérée par la précocité (rang 0 pèse plus que rang 49). */
  score: number;
  /** Rang moyen d'entrée. */
  avgRank: number;
  appearances: Array<{ mint: string; rank: number; signature?: string; blockTime?: number | null }>;
  computedAt: string;
}

export interface OverlapOptions {
  /** Seuil de récurrence minimale (défaut 3). */
  minRecurrence?: number;
  /** Nombre de premiers acheteurs considérés par token (défaut 50). */
  topN?: number;
  /** Wallets à ignorer (routeurs, programmes connus...). */
  ignore?: Set<string>;
  now?: () => number;
}

/** Poids décroissant selon le rang : 1 au rang 0, ~0.5 au rang topN/2, ≥ 0.25 au rang topN-1. */
export function rankWeight(rank: number, topN: number): number {
  return Math.max(0.25, 1 - (0.75 * rank) / Math.max(1, topN - 1));
}

export function computeEarlyBuyerOverlap(sets: EarlyBuyerSet[], opts: OverlapOptions = {}): WalletProfile[] {
  const minRec = opts.minRecurrence ?? 3;
  const topN = opts.topN ?? 50;
  const ignore = opts.ignore ?? new Set<string>();
  const now = opts.now ?? (() => Date.now());
  const universe = sets.length;
  const byWallet = new Map<string, WalletProfile["appearances"]>();

  for (const set of sets) {
    const seenInToken = new Set<string>();
    for (const b of set.buyers) {
      if (b.rank >= topN) continue;
      if (ignore.has(b.wallet)) continue;
      if (seenInToken.has(b.wallet)) continue; // un wallet compte une fois par token
      seenInToken.add(b.wallet);
      const list = byWallet.get(b.wallet) ?? [];
      list.push({ mint: set.mint, rank: b.rank, signature: b.signature, blockTime: b.blockTime ?? null });
      byWallet.set(b.wallet, list);
    }
  }

  const computedAt = new Date(now()).toISOString();
  const profiles: WalletProfile[] = [];
  for (const [address, appearances] of byWallet) {
    if (appearances.length < minRec) continue;
    const weighted = appearances.reduce((s, a) => s + rankWeight(a.rank, topN), 0);
    const score = universe > 0 ? Math.round((100 * weighted) / universe) : 0;
    profiles.push({
      address,
      recurrence: appearances.length,
      universe,
      score: Math.min(100, score),
      avgRank: appearances.reduce((s, a) => s + a.rank, 0) / appearances.length,
      appearances: [...appearances].sort((a, b) => a.rank - b.rank),
      computedAt,
    });
  }
  return profiles.sort((a, b) => b.score - a.score || b.recurrence - a.recurrence || a.avgRank - b.avgRank);
}

/** Écrit un fichier par wallet dans `data/wallets/` et renvoie les chemins écrits. */
export function writeWalletProfiles(profiles: WalletProfile[], walletsDir: string): string[] {
  mkdirSync(walletsDir, { recursive: true });
  const paths: string[] = [];
  for (const p of profiles) {
    const path = join(walletsDir, `${p.address}.json`);
    writeFileSync(path, JSON.stringify(p, null, 2) + "\n");
    paths.push(path);
  }
  return paths;
}
