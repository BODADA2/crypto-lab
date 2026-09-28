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
import type { EarlyBuyer, WalletTokenEvent } from "../collect/types.ts";

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

// ---------------------------------------------------------------------------
// Métriques de bundling (H-BUNDLE) — fonctions pures, sans I/O.
// Utilisées par lab/signals/run-earlybuyers.ts ; testées dans tests/earlybuyers-bundle.test.ts.
// Rappel : aucune de ces métriques ne constitue un signal d'achat — T-BUNDLE est
// pré-enregistré (docs/preregistered-addendum-2026-09-28.md) et tournera sur données propres.
// ---------------------------------------------------------------------------

export interface BundleBuyer {
  wallet: string;
  slot: number;
  amountRaw: string;
}

export interface BundleMetrics {
  buyerCount: number;
  /** Part des achats captée par les 5 plus gros wallets (0–1). */
  top5_share: number;
  /** Coefficient de Gini des montants (0 = égalité parfaite, →1 = concentration). */
  gini: number;
  /** Part max d'achats partageant le même slot (0–1) — proxy de coordination temporelle. */
  same_slot_max: number;
  /** Somme des montants d'achat (unités brutes). */
  totalRaw: string;
  /** true si la liste d'acheteurs est possiblement incomplète (historique tronqué). */
  truncated: boolean;
  computedAt: string;
}

function toBigIntSafe(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Métriques de concentration sur les premiers acheteurs d'un token. */
export function computeBundleMetrics(
  buyers: BundleBuyer[],
  opts: { truncated?: boolean; now?: () => number } = {},
): BundleMetrics {
  const now = opts.now ?? (() => Date.now());
  const amounts = buyers.map((b) => toBigIntSafe(b.amountRaw));
  const n = amounts.length;
  const total = amounts.reduce((a, b) => a + b, 0n);
  const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const top5 = sorted.slice(-5).reduce((a, b) => a + b, 0n);
  const top5_share = total > 0n ? Number(top5) / Number(total) : 0;
  // Gini = ΣᵢΣⱼ|xi−xj| / (2n²μ) = ΣᵢΣⱼ|xi−xj| / (2n·total)
  let gini = 0;
  if (n > 1 && total > 0n) {
    let num = 0n;
    for (const xi of amounts) {
      for (const xj of amounts) {
        num += xi > xj ? xi - xj : xj - xi;
      }
    }
    gini = Number(num) / (2 * n * Number(total));
  }
  const perSlot = new Map<number, number>();
  for (const b of buyers) perSlot.set(b.slot, (perSlot.get(b.slot) ?? 0) + 1);
  const same_slot_max = n > 0 ? Math.max(...perSlot.values()) / n : 0;
  return {
    buyerCount: n,
    top5_share,
    gini,
    same_slot_max,
    totalRaw: total.toString(),
    truncated: opts.truncated ?? false,
    computedAt: new Date(now()).toISOString(),
  };
}

export interface CoordinatedSellsOptions {
  /** Fenêtre post-migration analysée, en secondes (défaut 300). */
  windowSec?: number;
  /** Couverture minimale (wallets avec historique suffisant) pour un résultat non null. */
  minCovered?: number;
  now?: () => number;
}

export interface WalletSellInfo {
  wallet: string;
  boughtRaw: string;
  soldRaw: string;
  /** soldRaw / boughtRaw dans la fenêtre (peut dépasser 1 si le wallet a racheté). */
  soldFrac: number;
  /** true si l'historique du wallet remonte au moins jusqu'à la migration. */
  covered: boolean;
}

export interface CoordinatedSells {
  windowSec: number;
  walletsChecked: number;
  walletsCovered: number;
  /** Nombre de wallets couverts ayant vendu > 50 % de leur position dans la fenêtre. */
  sellersOver50: number;
  /** sellersOver50 / walletsCovered ; null si couverture < minCovered. */
  coordinated_sells: number | null;
  details: WalletSellInfo[];
  computedAt: string;
}

/**
 * Ventes coordonnées post-migration, à partir d'historiques wallet déjà récupérés.
 * `histories` : wallet → événements (tous mints ; filtrés ici sur `mint`).
 * Un wallet est « couvert » seulement si son historique remonte jusqu'à la migration ;
 * sinon il est exclu du ratio (pas compté comme non-vendeur).
 */
export function computeCoordinatedSells(
  buyers: Array<{ wallet: string; amountRaw: string }>,
  histories: Map<string, WalletTokenEvent[]>,
  mint: string,
  migratedAtMs: number,
  opts: CoordinatedSellsOptions = {},
): CoordinatedSells {
  const windowSec = opts.windowSec ?? 300;
  const minCovered = opts.minCovered ?? 5;
  const now = opts.now ?? (() => Date.now());
  const details: WalletSellInfo[] = [];
  for (const b of buyers) {
    const bought = toBigIntSafe(b.amountRaw);
    let sold = 0n;
    let oldest: number | null = null;
    for (const e of histories.get(b.wallet) ?? []) {
      if (e.mint !== mint || e.blockTime == null) continue;
      const tMs = e.blockTime * 1000;
      if (oldest == null || tMs < oldest) oldest = tMs;
      if (e.direction === "out" && tMs >= migratedAtMs && tMs <= migratedAtMs + windowSec * 1000) {
        sold += toBigIntSafe(e.deltaRaw.startsWith("-") ? e.deltaRaw.slice(1) : e.deltaRaw);
      }
    }
    const covered = oldest != null && oldest <= migratedAtMs;
    details.push({
      wallet: b.wallet,
      boughtRaw: bought.toString(),
      soldRaw: sold.toString(),
      soldFrac: bought > 0n ? Number(sold) / Number(bought) : 0,
      covered,
    });
  }
  const coveredWallets = details.filter((d) => d.covered);
  const sellersOver50 = coveredWallets.filter((d) => d.soldFrac > 0.5).length;
  return {
    windowSec,
    walletsChecked: details.length,
    walletsCovered: coveredWallets.length,
    sellersOver50,
    coordinated_sells: coveredWallets.length >= minCovered ? sellersOver50 / coveredWallets.length : null,
    details,
    computedAt: new Date(now()).toISOString(),
  };
}
