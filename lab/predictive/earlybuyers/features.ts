/**
 * Phase 2 — features FIXES (aucun tuning autorisé).
 *
 * Les features de FIXED_FEATURES sont calculées ici, chacune avec un tsMs
 * = timestamp maximum de ses sources (vérifié par audit.ts : tsMs <= t0ms).
 * 15 d'origine + 7 gelées le 2026-09-28 (clustering wallet→entité, fenêtres).
 *
 * GARDE-FOU DE NON-RÉGRESSION : l'appel sans `opts` DOIT produire des
 * valeurs bit-identiques aux 15 features d'origine (testé dans
 * tests/earlybuyers-clusters.test.ts). Les 7 nouvelles features sont
 * calculées avec le même clustering interne déterministe ; un appelant
 * peut fournir son propre `clustering` via opts.
 *
 * ANTI-FUITE overlapFrac : la carte wallet -> tokens est construite UNIQUEMENT
 * sur les univers discovery+calibration (jamais le holdout — correction de la
 * fuite Phase 1 où des statistiques calculées sur tout l'univers, y compris
 * des tokens futurs, contaminaient les features). De plus, seules les
 * observations d'un autre token avec blockTime <= t0ms du token courant
 * comptent : une observation postérieure à t0 n'existe pas encore à t0.
 *
 * CONTAMINATION Phase 1 (rappel) : `sellersOver50` / `medianSoldFrac` de
 * lab/predictive/wallets/features.ts utilisaient des ventes POST-migration
 * (+5 min). INTERDITS en Phase 2 — absents de ce fichier par construction.
 */
import { giniOf, topNAmountShare } from "../wallets/features.ts";
import { median } from "../universe.ts";
import {
  buildPairOverlap,
  clusterWallets,
  entityAmountShares,
  entityAmounts,
  hhi,
} from "./clusters.ts";
import type { ClusteringResult } from "./clusters.ts";
import { applyWindow } from "./windows.ts";
import type {
  EarlyBuyerSnapshot,
  FeatureSet,
  FeatureValue,
  FixedFeature,
} from "./types.ts";
import { FIXED_FEATURES } from "./types.ts";

const DAY = 86_400;

function num(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function medianOf(vals: (number | null | undefined)[]): number | null {
  const a = vals.filter(num);
  return median(a);
}

function fracOf(vals: (number | null | undefined)[], pred: (v: number) => boolean): number | null {
  const a = vals.filter(num);
  if (a.length === 0) return null;
  return a.filter(pred).length / a.length;
}

/* ------------------------------------------------------------------ */
/* Index d'overlap : wallet -> observations (mint, blockTimeMs, t0ms)   */
/* Construit UNIQUEMENT sur discovery+calibration (jamais holdout).    */
/* ------------------------------------------------------------------ */

export interface WalletObservation {
  mint: string;
  blockTimeMs: number;
}

export type OverlapIndex = Map<string, WalletObservation[]>;

/** Construit l'index d'overlap depuis des snapshots (le run ne passe JAMAIS de holdout). */
export function buildOverlapIndex(snapshots: EarlyBuyerSnapshot[]): OverlapIndex {
  const idx: OverlapIndex = new Map();
  for (const s of snapshots) {
    if (s.excludedReason) continue;
    for (const b of s.buyers) {
      const arr = idx.get(b.wallet) ?? [];
      arr.push({ mint: s.mint, blockTimeMs: b.blockTimeMs });
      idx.set(b.wallet, arr);
    }
  }
  return idx;
}

/** Fraction des wallets du set vus early buyer d'≥1 AUTRE token à blockTime <= t0ms. */
function overlapFeature(
  snap: EarlyBuyerSnapshot,
  idx: OverlapIndex,
): { value: number | null; tsMs: number } {
  let overlapped = 0;
  let maxTs = 0;
  for (const b of snap.buyers) {
    maxTs = Math.max(maxTs, b.blockTimeMs);
    const obs = idx.get(b.wallet) ?? [];
    let seenOther = false;
    for (const o of obs) {
      if (o.mint === snap.mint) continue;
      if (o.blockTimeMs <= snap.t0ms) {
        seenOther = true;
        maxTs = Math.max(maxTs, o.blockTimeMs);
      }
    }
    if (seenOther) overlapped++;
  }
  return { value: snap.buyers.length ? overlapped / snap.buyers.length : null, tsMs: maxTs };
}

/* ------------------------------------------------------------------ */
/* Calcul des features (15 d'origine + 7 gelées le 2026-09-28)         */
/* ------------------------------------------------------------------ */

export interface ComputeFeatureSetOpts {
  /** Clustering wallet→entité ; si absent, calculé en interne (déterministe). */
  clustering?: ClusteringResult;
  /** Définition early buyer appliquée au set (windows.ts), tracée sur le FeatureSet. */
  windowLabel?: string;
}

/** Parts de montant (0..1) ; null si aucun montant ou total nul. */
function amountSharesOf(amounts: bigint[]): number[] | null {
  if (amounts.length === 0) return null;
  const total = amounts.reduce((a, b) => a + b, 0n);
  if (total === 0n) return null;
  return amounts.map((a) => Number(a) / Number(total));
}

export function computeFeatureSet(
  snap: EarlyBuyerSnapshot,
  overlapIdx: OverlapIndex,
  opts?: ComputeFeatureSetOpts,
): FeatureSet {
  const buyers = snap.buyers;
  const amounts = buyers.map((b) => b.amountRaw);
  const maxBuyerTs = buyers.reduce((m, b) => Math.max(m, b.blockTimeMs), 0);

  // Historiques : tsMs max des sources utilisées.
  let maxHistTs = maxBuyerTs;
  const ages: (number | null)[] = [];
  const txCounts: (number | null)[] = [];
  const recencies: (number | null)[] = [];
  const touched: (number | null)[] = [];
  const ratios: (number | null)[] = [];
  for (const b of buyers) {
    const h = snap.histories[b.wallet];
    if (!h) continue;
    if (h.histMaxTsMs != null) maxHistTs = Math.max(maxHistTs, h.histMaxTsMs);
    if (h.txMaxTsMs != null) maxHistTs = Math.max(maxHistTs, h.txMaxTsMs);
    ages.push(h.walletAgeSec);
    txCounts.push(h.txCountPreT0);
    recencies.push(h.recencySec);
    if (h.tokensTouchedPreT0 != null) touched.push(h.tokensTouchedPreT0);
    if (h.buySellCountRatio != null) ratios.push(h.buySellCountRatio);
  }

  // Inter-arrivées.
  const times = buyers.map((b) => b.blockTimeMs).sort((a, b) => a - b);
  const spanSec = times.length >= 2 ? (times[times.length - 1]! - times[0]!) / 1000 : 0;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i]! - times[i - 1]!) / 1000);
  const medGap = median(gaps);

  // Slots.
  const slotCounts = new Map<number, number>();
  for (const b of buyers) {
    if (b.slot == null) continue;
    slotCounts.set(b.slot, (slotCounts.get(b.slot) ?? 0) + 1);
  }
  const sameSlotMax = slotCounts.size ? Math.max(...slotCounts.values()) : null;

  const ov = overlapFeature(snap, overlapIdx);

  const F: Record<string, FeatureValue> = {
    nBuyers: { value: buyers.length, tsMs: maxBuyerTs },
    giniAmt: { value: giniOf(amounts), tsMs: maxBuyerTs },
    top1Share: { value: topNAmountShare(amounts, 1), tsMs: maxBuyerTs },
    top5Share: { value: topNAmountShare(amounts, 5), tsMs: maxBuyerTs },
    sameSlotMax: { value: sameSlotMax, tsMs: maxBuyerTs },
    arrivalSpanSec: { value: spanSec, tsMs: maxBuyerTs },
    medianInterArrivalSec: { value: medGap, tsMs: maxBuyerTs },
    medianWalletAgeSec: { value: medianOf(ages), tsMs: maxHistTs },
    medianTxCountPreT0: { value: medianOf(txCounts), tsMs: maxHistTs },
    newWalletFrac: { value: fracOf(ages, (v) => v < 7 * DAY), tsMs: maxHistTs },
    experiencedWalletFrac: { value: fracOf(ages, (v) => v > 90 * DAY), tsMs: maxHistTs },
    activeWalletFrac: { value: fracOf(recencies, (v) => v < DAY), tsMs: maxHistTs },
    overlapFrac: { value: ov.value, tsMs: ov.tsMs },
    medianTokensTouched: { value: medianOf(touched), tsMs: maxHistTs },
    medianBuySellRatio: { value: medianOf(ratios), tsMs: maxHistTs },
  };

  // --- 7 features gelées le 2026-09-28 (clustering wallet→entité, §4) ---
  // tsMs = maxBuyerTs pour toutes : les sources (slot, blockTimeMs,
  // observations d'overlap ≤ t0ms) sont toutes pré-t0 par construction.
  const clustering =
    opts?.clustering ??
    clusterWallets(
      buyers.map((b) => ({ wallet: b.wallet, slot: b.slot, blockTimeMs: b.blockTimeMs })),
      buildPairOverlap(overlapIdx, snap.t0ms, snap.mint),
    );
  const items = buyers.map((b) => ({ wallet: b.wallet, amount: b.amountRaw }));
  const entAmounts = entityAmounts(items, clustering);
  const entShares = entityAmountShares(items, clustering);
  const walletShares = amountSharesOf(amounts);

  const clusteredWallets = new Set<string>();
  for (const cl of clustering.clusters) for (const m of cl.members) clusteredWallets.add(m);
  const coordinatedCount = buyers.filter((b) => clusteredWallets.has(b.wallet)).length;

  const firstBlockCount = applyWindow(buyers, "first_block").length;

  F.entityCount = { value: clustering.entityCount, tsMs: maxBuyerTs };
  F.hhiWallet = { value: walletShares ? hhi(walletShares) : null, tsMs: maxBuyerTs };
  F.hhiEntity = { value: hhi(entShares), tsMs: maxBuyerTs };
  F.giniEntity = { value: giniOf(entAmounts), tsMs: maxBuyerTs };
  F.top1EntityShare = { value: topNAmountShare(entAmounts, 1), tsMs: maxBuyerTs };
  F.coordinatedSetFrac = {
    value: buyers.length ? coordinatedCount / buyers.length : null,
    tsMs: maxBuyerTs,
  };
  F.sniperShare = {
    value: buyers.length ? firstBlockCount / buyers.length : null,
    tsMs: maxBuyerTs,
  };

  // Garde-fou : toutes les features fixes doivent exister.
  for (const f of FIXED_FEATURES) {
    if (!F[f.key]) throw new Error(`feature manquante : ${f.key}`);
  }

  const fs: FeatureSet = {
    mint: snap.mint,
    universe: snap.universe,
    t0ms: snap.t0ms,
    features: F,
  };
  if (opts?.windowLabel !== undefined) fs.windowLabel = opts.windowLabel;
  return fs;
}

export function featureKeys(): string[] {
  return FIXED_FEATURES.map((f: FixedFeature) => f.key);
}

export type { FixedFeature };
