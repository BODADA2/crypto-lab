/**
 * Phase 2 — logique de décision (§17 spec) : les 3 états.
 *
 *  - État 1 : NO EVIDENCE OF EARLY-BUYER SIGNAL ;
 *  - État 2 : EARLY-BUYER RISK FILTER (filtre d'exclusion, jamais un edge) ;
 *  - État 3 : « candidate predictive relation » — JAMAIS « guaranteed edge ».
 *
 * Checklist de promotion (11 critères §17) :
 *  oos_holdout, time_split, unbiased_universe, multi_horizons,
 *  multi_cohorts, multi_definitions, simple_tests, competing_models,
 *  cost_sensitivity, outliers, stability.
 *
 * Règles :
 *  - état 3 SSI les 11 checks sont présents ET pass === true pour chacun ;
 *  - état 2 SSI lossSignal === true (signal de perte validé OOS) ET aucun
 *    check évalué ne le contredit (aucun pass === false) — interprétation
 *    documentée : un filtre de risque n'est utilisable que si rien de
 *    mesuré ne s'y oppose ;
 *  - sinon état 1.
 * Un check non évaluable porte pass === null (honnête) : il bloque l'état 3
 * mais ne bloque pas l'état 2 (il ne contredit rien).
 */
export type DecisionState = 1 | 2 | 3;

export interface ChecklistItem {
  id: string;
  desc: string;
  /** true = critère rempli ; false = critère échoué ; null = non évaluable. */
  pass: boolean | null;
  detail: string;
}

/** Les 11 critères §17, dans l'ordre. */
export const DECISION_CHECKLIST_IDS = [
  "oos_holdout",
  "time_split",
  "unbiased_universe",
  "multi_horizons",
  "multi_cohorts",
  "multi_definitions",
  "simple_tests",
  "competing_models",
  "cost_sensitivity",
  "outliers",
  "stability",
] as const;

export type DecisionCheckId = (typeof DECISION_CHECKLIST_IDS)[number];

export interface DecisionResult {
  state: DecisionState;
  checklist: ChecklistItem[];
  summary: string;
}

/**
 * Évalue l'état de décision.
 * @param checks items de checklist (ids §17 ; pass=null = non évaluable).
 * @param lossSignal true si un signal de PERTE est validé OOS
 *   (filtre de risque candidat — pas un edge).
 */
export function evaluateDecisionState(
  checks: ChecklistItem[],
  lossSignal: boolean,
): DecisionResult {
  const byId = new Map(checks.map((c) => [c.id, c]));

  const allPass = DECISION_CHECKLIST_IDS.every(
    (id) => byId.get(id)?.pass === true,
  );
  if (allPass) {
    return {
      state: 3,
      checklist: checks,
      summary:
        "État 3 — candidate predictive relation : les 11 critères §17 sont remplis " +
        "(OOS holdout, splits temporels/cohortes, définitions multiples, modèles " +
        "concurrents, coûts, outliers, stabilité). Ce n'est JAMAIS un « guaranteed " +
        "edge » : la relation reste candidate, à re-mesurer en continu.",
    };
  }

  const noContradiction =
    checks.length > 0 && checks.every((c) => c.pass !== false);
  if (lossSignal && noContradiction) {
    return {
      state: 2,
      checklist: checks,
      summary:
        "État 2 — EARLY-BUYER RISK FILTER : un signal de perte est validé OOS et " +
        "aucun critère évalué ne le contredit. Utilisable UNIQUEMENT comme filtre " +
        "d'exclusion (jamais comme signal d'achat).",
    };
  }

  const failed = checks.filter((c) => c.pass === false).map((c) => c.id);
  const unevaluated = checks.filter((c) => c.pass !== true).map((c) => c.id);
  return {
    state: 1,
    checklist: checks,
    summary:
      "État 1 — NO EVIDENCE OF EARLY-BUYER SIGNAL : " +
      (failed.length > 0
        ? `critères échoués : ${failed.join(", ")}. `
        : "") +
      (unevaluated.length > 0 && failed.length === 0
        ? `critères non évalués ou non remplis : ${unevaluated.join(", ")}. `
        : "") +
      "Aucune relation prédictive n'est établie ; on continue de mesurer.",
  };
}
