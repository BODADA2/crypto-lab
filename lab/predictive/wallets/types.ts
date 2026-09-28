/**
 * Domaine 1/5 — WALLET BEHAVIOR + EARLY BUYERS (programme prédictif).
 * Phase DÉCOUVERTE uniquement : chercher une relation prédictive stable
 * entre variables à t0 et rendement futur Y / survie future.
 *
 * Aucune stratégie n'est construite ici. AUCUNE conclusion avec n < 30.
 * Données data/history/ biaisées vers les tokens chauds => borne OPTIMISTE.
 */

import type { Universe } from "../universe.ts";

/** Un acheteur précoce tel que lu dans data/earlybuyers/<mint>.json. */
export interface EarlyBuyerRow {
  wallet: string;
  blockTime: number | null;
  slot: number | null;
  rank: number;
  /** Montant brut (lamports de tokens) — BigInt car > 2^53 possible. */
  amountRaw: bigint;
}

export interface EarlyBuyerMetrics {
  buyerCount: number;
  /** Part des top-5 PAR MONTANT (vérifié : tri décroissant des amountRaw). */
  top5_share: number | null;
  gini: number | null;
  same_slot_max: number | null;
  totalRaw: bigint;
  truncated: boolean;
}

export interface EarlyBuyerSells {
  windowSec: number;
  walletsChecked: number;
  walletsCovered: number;
  sellersOver50: number;
  /** soldFrac médian à définir côté features (détails couverts uniquement). */
  details: { wallet: string; soldFrac: number; covered: boolean }[];
}

export interface EarlyBuyersFile {
  mint: string;
  buyers: EarlyBuyerRow[];
  metrics: EarlyBuyerMetrics | null;
  sells: EarlyBuyerSells | null;
  truncated: boolean;
}

/**
 * Variables X à t0 / pré-t0 (toutes mesurables AVANT tout trade hypothétique).
 * null = non mesurable sur ce token (données manquantes), jamais inventé.
 */
export interface WalletFeatures {
  mint: string;
  /** Nombre de wallets acheteurs précoces (buyers[].length). */
  buyerCount: number;
  /** Part des top-5 par montant (metrics.top5_share, re-vérifié). */
  top5Share: number | null;
  /** Gini des montants d'achat (metrics.gini, re-vérifié). */
  gini: number | null;
  /** Part max de buyers dans le même slot (coordination snipe). */
  sameSlotMax: number | null;
  /** Vitesse d'arrivée : blockTime(rank N) - blockTime(rank 0), en secondes. */
  arrivalSpanSec: number | null;
  /** Médiane des écarts inter-arrivée (secondes), par rang croissant. */
  medianInterArrivalSec: number | null;
  /** Concentration : part du top-1 par montant / total. */
  top1AmountShare: number | null;
  /** Part des wallets vus sur >=2 tokens du dataset (overlap inter-tokens). */
  overlapFrac: number | null;
  /** Nombre de wallets ayant vendu >50% à +5 min (sells.sellersOver50). */
  sellersOver50: number | null;
  /** soldFrac médian des wallets couverts à +5 min (rétention). */
  medianSoldFrac: number | null;
  /** Historique dev wallet (one-shot vs répété) — NON DISPONIBLE pour l'instant. */
  devHistory: null;
  /** Fichier tronqué par le backfill (borne d'observation partielle). */
  truncated: boolean;
}

export type HorizonLabel = "1h" | "6h" | "24h";

/**
 * Résultats Y par horizon.
 * survival@H = prix > 0 ET liquidité >= seuil au snapshot couvrant H.
 */
export interface TokenOutcome {
  mint: string;
  universe: Universe;
  t0Index: number;
  t0Time: string;
  nTicks: number;
  aberrantTicks: number;
  /** Rendement futur continu depuis t0 (prix nettoyés) ; null si non couvert. */
  y: Record<HorizonLabel, number | null>;
  /** Survie binaire ; null si horizon non couvert. */
  survival: Record<HorizonLabel, boolean | null>;
}

export interface DiscoveryRow {
  mint: string;
  universe: Universe;
  features: WalletFeatures;
  outcome: TokenOutcome;
}

/** Seuil de liquidité pour la survie (identique au seuil t0 du protocole). */
export const SURVIVAL_LIQUIDITY_USD = 20_000;

/** Rangs utilisés pour la vitesse d'arrivée : rank 0 -> rank N. */
export const ARRIVAL_RANK_N = 9;
