/**
 * SPRINT 2D — Famille A (Avoidance / No-trade).
 *
 * AVOIDANCE_ENGINE — règle d'ÉVITEMENT PRÉ-ENREGISTRÉE.
 *
 * ⚠️ RÈGLE GELÉE AVANT MESURE (2026-09-28). Ne pas modifier après lecture
 * des résultats : toute modification = nouvelle version (AVOID-S2D-v2).
 *
 * Contexte : 3 filtres de risque candidats issus de la Phase 1 / Sprint 1.
 * AUCUNE stratégie construite ici : on mesure la valeur d'ÉVITEMENT
 * (baseline « tout prendre » vs « éviter les flagged »), pas un P&L.
 *
 * - F_FRENZY   : H-PRED-FLOW-01 — frénésie d'activité à t0 ⇒ Y@1h négatif
 *                (ρ=−0,220 OOS, p=0,0029). Variable verrouillée : sellsM5 à t0
 *                (colinéaire buysM5 ρ=0,83 et volume — un seul phénomène
 *                « activité », cf. docs/predictive-program-2026-09-28.md §2).
 * - F_TURNOVER : H-PRED-LIQ-01 — turnover élevé à t0 ⇒ Y@6h négatif
 *                (sp=−0,410 OOS, top décile médiane −83,7 %).
 *                Variable : turnoverM5 = volM5 / liqT0.
 * - F_LIQT0    : H-S1-E1 — liquidité basse à t0 ⇒ mauvaise survie
 *                (Cox PH, HR=0,691 par doublement, p≈3e-21).
 *                Variable : liqT0 (liquidityUsd au snapshot t0).
 *
 * Note : le mandat mentionnait « 4 filtres candidats » mais n'en
 * opérationnalise que 3 (la règle exemple : frenzy ≥ P75 OU turnoverM5 ≥ P90
 * OU liqT0 < P25). Le 4e signal proche (H-PRED-TEMP-LEVEL, niveau ⇒ Y@6h
 * « moins négatif », avec réserves — biais de survie) n'est pas une règle
 * d'évitement inversible propre : exclu du pré-enregistrement, reste OPEN
 * dans research/hypotheses.yaml.
 *
 * Seuils : percentiles INTRA-DISCOVERY (calculés sur l'échantillon discovery
 * uniquement — jamais de holdout, jamais de calibration).
 * Sensibilité : 3 points par filtre, PAS d'optimisation fine.
 */

export const AVOID_RULE_VERSION = "AVOID-S2D-v1";
export const FROZEN_DATE = "2026-09-28";

export type FilterId = "F_FRENZY" | "F_TURNOVER" | "F_LIQT0";

/** Une variable mesurée à t0 ; null = non calculable (token exclu du filtre). */
export type FilterVariable = "sellsM5" | "turnoverM5" | "liqT0";

export interface FilterSpec {
  id: FilterId;
  variable: FilterVariable;
  /** "high" : AVOID si valeur >= seuil ; "low" : AVOID si valeur < seuil. */
  side: "high" | "low";
  /** [point bas, point principal, point haut] — percentiles intra-discovery. */
  points: [number, number, number];
  hypothesis: string;
  horizon: "1h" | "6h" | "survie";
}

export const FILTERS: FilterSpec[] = [
  {
    id: "F_FRENZY",
    variable: "sellsM5",
    side: "high",
    points: [70, 75, 80],
    hypothesis:
      "H-PRED-FLOW-01 — frénésie d'activité à t0 ⇒ Y@1h négatif (ρ=−0,220 OOS)",
    horizon: "1h",
  },
  {
    id: "F_TURNOVER",
    variable: "turnoverM5",
    side: "high",
    points: [85, 90, 95],
    hypothesis:
      "H-PRED-LIQ-01 — turnover élevé à t0 ⇒ Y@6h négatif (sp=−0,410 OOS)",
    horizon: "6h",
  },
  {
    id: "F_LIQT0",
    variable: "liqT0",
    side: "low",
    points: [30, 25, 20],
    hypothesis:
      "H-S1-E1 — liquidité basse à t0 ⇒ mauvaise survie (HR=0,691/doublement)",
    horizon: "survie",
  },
];

/** Étiquettes des 3 points de sensibilité. */
export const POINT_LABELS = ["bas", "principal", "haut"] as const;

/** Mint exclu : glitch décimal DexScreener (+4 939 704 %, INCAPTURABLE). */
export const EXCLUDED_MINTS = new Set(["SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3"]);

export interface ThresholdSet {
  F_FRENZY: number;
  F_TURNOVER: number;
  F_LIQT0: number;
}

export type FilterFlags = Record<FilterId, boolean>;

/**
 * Évalue les 3 filtres pour un token. `feats` = variables à t0 (null exclu).
 * `thresholds` = seuils intra-discovery (un par filtre).
 */
export function evaluateFilters(
  feats: Record<FilterVariable, number | null>,
  thresholds: ThresholdSet,
): FilterFlags {
  const out = {} as FilterFlags;
  for (const spec of FILTERS) {
    const v = feats[spec.variable];
    const t = thresholds[spec.id];
    out[spec.id] =
      v !== null && v !== undefined
        ? spec.side === "high"
          ? v >= t
          : v < t
        : false; // variable manquante => jamais flaggé (pas d'imputation)
  }
  return out;
}

/** Règle combinée : AVOID si AU MOINS un filtre déclenche (OU logique). */
export function combinedAvoid(flags: FilterFlags): boolean {
  return flags.F_FRENZY || flags.F_TURNOVER || flags.F_LIQT0;
}

/**
 * Percentile intra-échantillon (interpolation linéaire, méthode « type 7 »
 * de R — la même pour tous les seuils, documentée une fois).
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p < 0 || p > 100) throw new RangeError(`percentile hors bornes : ${p}`);
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return s[lo]! + frac * (s[hi]! - s[lo]!);
}

/** Seuils intra-discovery pour un point de sensibilité (0=bas, 1=principal, 2=haut). */
export function thresholdsForPoint(
  discoveryValues: Record<FilterVariable, number[]>,
  point: 0 | 1 | 2,
): ThresholdSet {
  const t = {} as ThresholdSet;
  for (const spec of FILTERS) {
    const q = percentile(discoveryValues[spec.variable], spec.points[point]);
    if (q === null) throw new Error(`aucune valeur discovery pour ${spec.variable}`);
    t[spec.id] = q;
  }
  return t;
}
