/**
 * Phase 2 — Early Buyers + Survival Model : types.
 *
 * Question scientifique : « La composition des early buyers à t0 contient-elle
 * une information statistiquement stable sur la distribution future du token ? »
 *
 * AUCUNE stratégie n'est construite ici. Aucun wallet n'est qualifié de
 * « smart money » : les features décrivent des comportements observables
 * pré-t0, jamais une qualité de trader.
 *
 * Règle temporelle ABSOLUE : toute feature porte un tsMs = timestamp maximum
 * de ses sources de données. L'audit (audit.ts) exige tsMs <= t0ms pour chaque
 * feature de chaque token ; une seule violation fait échouer le run.
 *
 * CONTAMINATION Phase 1 CORRIGÉE : lab/predictive/wallets/features.ts utilisait
 * `sellersOver50` / `medianSoldFrac` calculés sur des ventes POST-migration
 * (+5 min) — fuite temporelle (l'information n'existe pas à t0). Ces features
 * sont INTERDITES en Phase 2 : elles n'apparaissent dans aucune liste,
 * aucun calcul, aucun modèle de ce dossier.
 */
import type { Universe } from "../universe.ts";

/** Un acheteur pré-t0 du token (source : data/earlybuyers/<mint>.json, on-chain). */
export interface SnapshotBuyer {
  wallet: string;
  /** blockTime on-chain en ms (null exclu du set). */
  blockTimeMs: number;
  slot: number | null;
  rank: number;
  amountRaw: bigint;
}

/** Historique on-chain d'un wallet, STRICTEMENT pré-t0 (blockTime*1000 <= t0ms). */
export interface WalletHistory {
  wallet: string;
  /** Nombre de signatures pré-t0 (null si la récupération a échoué). */
  txCountPreT0: number | null;
  /** t0ms - blockTime le plus ancien (s), null si aucune signature pré-t0. */
  walletAgeSec: number | null;
  /** t0ms - blockTime le plus récent (s), null si aucune signature pré-t0. */
  recencySec: number | null;
  /** Jours civils UTC distincts avec activité pré-t0 (null si échec de récupération). */
  activeDaysPreT0: number | null;
  /** Mints distincts touchés (delta != 0, hors mint courant), top-10 wallets, null si indisponible. */
  tokensTouchedPreT0: number | null;
  /** (# deltas > 0) / (# deltas < 0) sur les txs lues, null si aucun delta < 0 ou indisponible. */
  buySellCountRatio: number | null;
  /** tsMs max des signatures utilisées (<= t0ms par construction). */
  histMaxTsMs: number | null;
  /** tsMs max des transactions lues (<= t0ms par construction). */
  txMaxTsMs: number | null;
}

/** Valeur d'une feature + timestamp max de ses sources (audit anti-fuite). */
export interface FeatureValue {
  value: number | null;
  /** Timestamp max des sources, en ms. DOIT être <= t0ms (vérifié par audit.ts). */
  tsMs: number;
}

/** Jeu de features d'un token. */
export interface FeatureSet {
  mint: string;
  universe: Universe;
  t0ms: number;
  /** Définition early buyer appliquée (windows.ts) — jamais mélangée silencieusement. */
  windowLabel?: string;
  features: Record<string, FeatureValue>;
}

/** Labels futurs d'un token (prix nettoyés des ticks aberrants). */
export interface Labels {
  mint: string;
  universe: Universe;
  t0ms: number;
  y1h: number | null;
  y6h: number | null;
  y24h: number | null;
  /** Pire rendement (t0, t0+24h] sur prix nettoyés ; null si < 3 ticks. */
  ddMax24h: number | null;
  dd30_24h: boolean | null;
  dd50_24h: boolean | null;
  dd80_24h: boolean | null;
  survival_30_24h: boolean | null;
  survival_50_24h: boolean | null;
  survival_80_24h: boolean | null;
  /** true si le mint est un glitch de données connu (labels neutralisés). */
  dataError: boolean;
}

/** Snapshot complet d'un token : set d'early buyers + historiques wallets. */
export interface EarlyBuyerSnapshot {
  mint: string;
  universe: Universe;
  t0ms: number;
  buyers: SnapshotBuyer[];
  histories: Record<string, WalletHistory>;
  /** Raison d'exclusion si le snapshot est invalide (ex. < 5 buyers). */
  excludedReason: string | null;
}

/** Feature fixe (aucun tuning autorisé). */
export interface FixedFeature {
  key: string;
  desc: string;
}

/** Les features FIXES de Phase 2 : 15 d'origine + 7 gelées le 2026-09-28. */
export const FIXED_FEATURES: FixedFeature[] = [
  { key: "nBuyers", desc: "nombre de buyers dans le set pré-t0" },
  { key: "giniAmt", desc: "Gini des montants du set (0 = égalité)" },
  { key: "top1Share", desc: "part du top-1 par montant" },
  { key: "top5Share", desc: "part du top-5 par montant" },
  { key: "sameSlotMax", desc: "nombre max de buyers dans le même slot" },
  { key: "arrivalSpanSec", desc: "dernier - premier blockTime du set (s)" },
  { key: "medianInterArrivalSec", desc: "médiane des écarts inter-arrivées (s)" },
  { key: "medianWalletAgeSec", desc: "médiane walletAgeSec du set" },
  { key: "medianTxCountPreT0", desc: "médiane txCountPreT0 du set" },
  { key: "newWalletFrac", desc: "fraction wallets avec walletAgeSec < 7j" },
  { key: "experiencedWalletFrac", desc: "fraction wallets avec walletAgeSec > 90j" },
  { key: "activeWalletFrac", desc: "fraction wallets avec recencySec < 24h" },
  {
    key: "overlapFrac",
    desc: "fraction des wallets vus early buyer d'≥1 AUTRE token (obs. ≤ t0ms, univers discovery+calibration uniquement, JAMAIS holdout)",
  },
  { key: "medianTokensTouched", desc: "médiane tokensTouchedPreT0 (top-10 par montant)" },
  { key: "medianBuySellRatio", desc: "médiane buySellCountRatio (top-10 par montant)" },
  // --- Gelées le 2026-09-28 (clustering wallet→entité + fenêtres, §3-§4 spec) ---
  { key: "entityCount", desc: "nombre d'entités apparentes (clusters + singletons) — gelée le 2026-09-28" },
  { key: "hhiWallet", desc: "HHI des parts de montant par wallet — gelée le 2026-09-28" },
  { key: "hhiEntity", desc: "HHI des parts de montant par entité apparente — gelée le 2026-09-28" },
  { key: "giniEntity", desc: "Gini des montants par entité apparente — gelée le 2026-09-28" },
  { key: "top1EntityShare", desc: "part de la top-1 entité apparente par montant — gelée le 2026-09-28" },
  {
    key: "coordinatedSetFrac",
    desc: "fraction des buyers membres d'un coordinated set (cluster ≥2 wallets) — gelée le 2026-09-28",
  },
  {
    key: "sniperShare",
    desc: "fraction des buyers dans la fenêtre first_block — gelée le 2026-09-28",
  },
];

export const LABEL_KEYS = [
  "y1h",
  "y6h",
  "y24h",
  "ddMax24h",
] as const;
export type LabelKey = (typeof LABEL_KEYS)[number];
