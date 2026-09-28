/**
 * Phase 2 — règles d'exclusion PRÉ-ENREGISTRÉES (§7 + §10 spec).
 *
 * GELÉES le 2026-09-28. Ces règles remplacent le placeholder historique
 * « top tercile giniAmt » (seuil = quantile 2/3 calculé sur discovery :
 * arbitraire, non pré-enregistré, biais d'optimisme) dans la comparaison
 * ALL vs EXCLUS vs RETENUS.
 *
 * Règles (ordre d'évaluation = ordre du tableau) :
 *  - DATA_ERROR      : mint dans DATA_ERROR_MINTS (glitch de données connu) ;
 *  - TRUNCATED       : fichier cache tronqué (backfill incomplet, buyers
 *                      post-t0 présentés comme « first ») ;
 *  - SMALL_SET       : nBuyers < 5 (set trop petit pour une statistique) ;
 *  - SNIPE_DOMINATED : sameSlotMax >= nBuyers/2 (le set est dominé par une
 *                      arrivée synchronisée — coordination snipe).
 *
 * Une règle déclenchée produit une RAISON (string) ; un token est EXCLU si
 * ≥1 raison. Aucune règle n'est jamais re-calibrée sur les données.
 */
import { DATA_ERROR_MINTS } from "./labels.ts";

/** Contexte minimal pour évaluer les règles sur un token. */
export interface ExclusionCtx {
  mint: string;
  /** true si le mint est un glitch de données connu. */
  dataError: boolean;
  /** true si le fichier cache earlybuyers est tronqué. */
  truncated: boolean;
  /** Nombre de buyers dans le set pré-t0. */
  nBuyers: number;
  /** Nombre max de buyers dans le même slot (null si incalculable). */
  sameSlotMax: number | null;
}

/** Une règle d'exclusion : id + description + test retournant la raison ou null. */
export interface ExclusionRule {
  id: string;
  desc: string;
  reason: (ctx: ExclusionCtx) => string | null;
}

/** Les 4 règles PRÉ-ENREGISTRÉES (gelées 2026-09-28 — ne pas modifier). */
export const PREREGISTERED_EXCLUSIONS: ExclusionRule[] = [
  {
    id: "DATA_ERROR",
    desc: "Mint listé dans DATA_ERROR_MINTS (glitch de données connu, ex. SKHY).",
    reason: (ctx) =>
      ctx.dataError || DATA_ERROR_MINTS.has(ctx.mint)
        ? `DATA_ERROR : ${ctx.mint} est un glitch de données connu`
        : null,
  },
  {
    id: "TRUNCATED",
    desc: "Fichier cache tronqué : le backfill est incomplet, des buyers post-t0 peuvent être présentés comme « first ».",
    reason: (ctx) =>
      ctx.truncated
        ? `TRUNCATED : cache earlybuyers incomplet pour ${ctx.mint}`
        : null,
  },
  {
    id: "SMALL_SET",
    desc: "Set trop petit : nBuyers < 5, aucune statistique de composition n'est fiable.",
    reason: (ctx) =>
      ctx.nBuyers < 5
        ? `SMALL_SET : nBuyers=${ctx.nBuyers} < 5 pour ${ctx.mint}`
        : null,
  },
  {
    id: "SNIPE_DOMINATED",
    desc: "Set dominé par une arrivée synchronisée : sameSlotMax >= nBuyers/2.",
    reason: (ctx) =>
      ctx.sameSlotMax != null &&
      ctx.nBuyers > 0 &&
      ctx.sameSlotMax >= ctx.nBuyers / 2
        ? `SNIPE_DOMINATED : sameSlotMax=${ctx.sameSlotMax} >= nBuyers/2=${ctx.nBuyers / 2} pour ${ctx.mint}`
        : null,
  },
];

/** Applique les règles pré-enregistrées : exclu si ≥1 raison. */
export function applyExclusions(ctx: ExclusionCtx): {
  excluded: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  for (const rule of PREREGISTERED_EXCLUSIONS) {
    const r = rule.reason(ctx);
    if (r != null) reasons.push(r);
  }
  return { excluded: reasons.length > 0, reasons };
}
