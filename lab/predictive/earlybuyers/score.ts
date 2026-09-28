/**
 * Phase 2 — objet score standardisé par token (§16 spec).
 *
 * Un TokenScore porte EXACTEMENT les champs listés ci-dessous, dans cet
 * ordre, pour chaque token valide. Règles d'honnêteté :
 *  - champ indisponible (donnée non collectée ou non câblée) = null ET
 *    raison explicite dans UNAVAILABLE — JAMAIS une valeur inventée ;
 *  - PRED_* = null à ce stade : AUCUN modèle n'est validé (verdicts
 *    NON_CONCLUSIF / AUCUN_SIGNAL) — la raison est explicite ;
 *  - MODEL_VERSION est bumpé à chaque changement de features.
 */

import { splitUniverse } from "../universe.ts";
import type {
  EarlyBuyerSnapshot,
  FeatureSet,
  Labels,
} from "./types.ts";

/** Version du modèle/score — à bumper à chaque changement de features. */
export const MODEL_VERSION = "earlybuyers-phase2.2.0";

/** Raison standard : aucune prédiction validée à ce stade. */
export const NO_VALIDATED_MODEL_REASON =
  "aucun modèle validé à ce stade (verdict NON_CONCLUSIF ou AUCUN_SIGNAL — aucun PRED_* n'est renseigné)";

/** Les champs du score, dans l'ordre §16. */
export const SCORE_FIELDS = [
  "TOKEN_ID",
  "T0",
  "DATA_QUALITY",
  "EARLY_BUYERS_N",
  "EARLY_ENTITY_N",
  "COORDINATION_SCORE",
  "CONCENTRATION_WALLET",
  "CONCENTRATION_ENTITY",
  "HHI",
  "GINI",
  "SNIPER_SHARE",
  "BUNDLE_SHARE",
  "DEPLOYER_LINK",
  "WALLET_AGE_STATS",
  "HISTORICAL_PNL_STATS",
  "TURNOVER_T0",
  "FRENZY_SCORE",
  "LIQUIDITY_T0",
  "BONDING_STATE",
  "ORGANIC_BUYER_RATIO",
  "PRED_Y_1H",
  "PRED_Y_6H",
  "PRED_Y_24H",
  "PRED_DD30",
  "PRED_DD50",
  "PRED_DD80",
  "PRED_SURVIVAL",
  "MODEL_VERSION",
  "FEATURE_CUTOFF",
  "DATA_TIMESTAMP_AUDIT",
  "LEAKAGE_STATUS",
  "COHORT",
  "SPLIT",
  "CONFIDENCE_INTERVAL",
  "EXCLUSION_REASON",
] as const;

export type ScoreField = (typeof SCORE_FIELDS)[number];

/** Score standardisé d'un token (§16). Champs indisponibles = null. */
export interface TokenScore {
  TOKEN_ID: string;
  T0: string | null;
  DATA_QUALITY: string;
  EARLY_BUYERS_N: number | null;
  EARLY_ENTITY_N: number | null;
  COORDINATION_SCORE: number | null;
  CONCENTRATION_WALLET: {
    gini: number | null;
    top1Share: number | null;
    top5Share: number | null;
  } | null;
  CONCENTRATION_ENTITY: unknown | null;
  HHI: number | null;
  GINI: number | null;
  /** Proxy documenté = sameSlotMax / nBuyers ; PAS une qualification de sniper. */
  SNIPER_SHARE: number | null;
  BUNDLE_SHARE: number | null;
  DEPLOYER_LINK: unknown | null;
  WALLET_AGE_STATS: {
    medianWalletAgeSec: number | null;
    newWalletFrac: number | null;
    experiencedWalletFrac: number | null;
    activeWalletFrac: number | null;
  } | null;
  HISTORICAL_PNL_STATS: unknown | null;
  TURNOVER_T0: number | null;
  FRENZY_SCORE: number | null;
  LIQUIDITY_T0: number | null;
  BONDING_STATE: unknown | null;
  ORGANIC_BUYER_RATIO: number | null;
  PRED_Y_1H: number | null;
  PRED_Y_6H: number | null;
  PRED_Y_24H: number | null;
  PRED_DD30: number | null;
  PRED_DD50: number | null;
  PRED_DD80: number | null;
  PRED_SURVIVAL: number | null;
  MODEL_VERSION: string;
  /** Définition de fenêtre des early buyers (défaut : "pre_t0_set"). */
  FEATURE_CUTOFF: string;
  DATA_TIMESTAMP_AUDIT: {
    maxFeatureTsMs: number | null;
    t0ms: number;
    pass: boolean;
  };
  LEAKAGE_STATUS: "PASS" | "FAIL" | "UNKNOWN";
  COHORT: string;
  SPLIT: string;
  CONFIDENCE_INTERVAL: [number, number] | null;
  EXCLUSION_REASON: string | null;
  /** Raisons d'indisponibilité des champs null (clé = nom du champ). */
  UNAVAILABLE: Record<string, string>;
}

export interface BuildTokenScoreArgs {
  snapshot: EarlyBuyerSnapshot;
  featureSet: FeatureSet;
  labels: Labels;
  /** Résultat de l'audit anti-fuite pour ce run. */
  auditPass: boolean;
  /** tsMs maximum observé sur les features de ce token. */
  auditMaxTsMs: number | null;
  /** Raisons d'exclusion pré-enregistrées (applyExclusions). */
  exclusionReasons: string[];
  /** true si le cache earlybuyers du token est tronqué. */
  truncated?: boolean;
  /** Définition de fenêtre (défaut "pre_t0_set"). */
  featureCutoff?: string;
}

function unavailable(): Record<string, string> {
  return {
    EARLY_ENTITY_N:
      "clustering wallet→entité non livré (clusters.ts, §4 spec)",
    COORDINATION_SCORE:
      "coordinatedSetFrac non calculé (extension features en cours)",
    CONCENTRATION_ENTITY:
      "concentration par entité non calculée (clusters.ts, §4 spec)",
    HHI: "HHI non calculé dans cette version (extension features en cours)",
    BUNDLE_SHARE:
      "computeBundleMetrics (lab/signals/earlybuyers.ts) non câblé au FeatureSet Phase 2",
    DEPLOYER_LINK:
      "CreateEvent non parsé pour le deployer (hors scope honnête, état des lieux §8)",
    HISTORICAL_PNL_STATS:
      "pas de prix historiques wallets pré-t0 (hors scope honnête)",
    TURNOVER_T0: "flows Phase 1 (turnover) non câblés en Phase 2",
    FRENZY_SCORE: "flows Phase 1 (frénésie) non câblés en Phase 2",
    LIQUIDITY_T0: "liquidité à t0 non extraite en Phase 2",
    BONDING_STATE: "état de la bonding curve non câblé en Phase 2",
    ORGANIC_BUYER_RATIO:
      "définition non gelée (aucun proxy retenu — ne pas dériver de newWalletFrac sans validation)",
    PRED_Y_1H: NO_VALIDATED_MODEL_REASON,
    PRED_Y_6H: NO_VALIDATED_MODEL_REASON,
    PRED_Y_24H: NO_VALIDATED_MODEL_REASON,
    PRED_DD30: NO_VALIDATED_MODEL_REASON,
    PRED_DD50: NO_VALIDATED_MODEL_REASON,
    PRED_DD80: NO_VALIDATED_MODEL_REASON,
    PRED_SURVIVAL: NO_VALIDATED_MODEL_REASON,
    CONFIDENCE_INTERVAL:
      "aucune prédiction validée — pas d'intervalle de confiance",
  };
}

/** Construit le TokenScore — ne renseigne que des valeurs observées. */
export function buildTokenScore(args: BuildTokenScoreArgs): TokenScore {
  const { snapshot, featureSet, labels } = args;
  const fv = (k: string): number | null => {
    const v = featureSet.features[k]?.value ?? null;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const UNAVAILABLE = unavailable();

  const nBuyers = fv("nBuyers");
  const gini = fv("giniAmt");
  const top1Share = fv("top1Share");
  const top5Share = fv("top5Share");
  const sameSlotMax = fv("sameSlotMax");

  const concentrationWallet =
    gini == null && top1Share == null && top5Share == null
      ? null
      : { gini, top1Share, top5Share };

  const medianWalletAgeSec = fv("medianWalletAgeSec");
  const newWalletFrac = fv("newWalletFrac");
  const experiencedWalletFrac = fv("experiencedWalletFrac");
  const activeWalletFrac = fv("activeWalletFrac");
  const walletAgeStats =
    medianWalletAgeSec == null &&
    newWalletFrac == null &&
    experiencedWalletFrac == null &&
    activeWalletFrac == null
      ? null
      : {
          medianWalletAgeSec,
          newWalletFrac,
          experiencedWalletFrac,
          activeWalletFrac,
        };

  const sniperShare =
    sameSlotMax != null && nBuyers != null && nBuyers > 0
      ? sameSlotMax / nBuyers
      : null;

  const dataQuality = labels.dataError
    ? "DATA_ERROR"
    : args.truncated
      ? "TRUNCATED"
      : snapshot.excludedReason
        ? "EXCLUDED"
        : "OK";

  const maxTs = args.auditMaxTsMs;
  const t0ms = snapshot.t0ms;

  return {
    TOKEN_ID: snapshot.mint,
    T0: t0ms > 0 ? new Date(t0ms).toISOString() : null,
    DATA_QUALITY: dataQuality,
    EARLY_BUYERS_N: nBuyers,
    EARLY_ENTITY_N: null,
    COORDINATION_SCORE: null,
    CONCENTRATION_WALLET: concentrationWallet,
    CONCENTRATION_ENTITY: null,
    HHI: null,
    GINI: gini,
    SNIPER_SHARE: sniperShare,
    BUNDLE_SHARE: null,
    DEPLOYER_LINK: null,
    WALLET_AGE_STATS: walletAgeStats,
    HISTORICAL_PNL_STATS: null,
    TURNOVER_T0: null,
    FRENZY_SCORE: null,
    LIQUIDITY_T0: null,
    BONDING_STATE: null,
    ORGANIC_BUYER_RATIO: null,
    PRED_Y_1H: null,
    PRED_Y_6H: null,
    PRED_Y_24H: null,
    PRED_DD30: null,
    PRED_DD50: null,
    PRED_DD80: null,
    PRED_SURVIVAL: null,
    MODEL_VERSION,
    FEATURE_CUTOFF: args.featureCutoff ?? "pre_t0_set",
    DATA_TIMESTAMP_AUDIT: {
      maxFeatureTsMs: maxTs,
      t0ms,
      pass: maxTs != null && t0ms > 0 ? maxTs <= t0ms : false,
    },
    LEAKAGE_STATUS: args.auditPass ? "PASS" : "FAIL",
    COHORT: snapshot.universe,
    SPLIT: splitUniverse(snapshot.mint),
    CONFIDENCE_INTERVAL: null,
    EXCLUSION_REASON:
      args.exclusionReasons.length > 0
        ? args.exclusionReasons.join(" ; ")
        : null,
    UNAVAILABLE,
  };
}
