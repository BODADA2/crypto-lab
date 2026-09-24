// Routage de décision (chantier 5/8, codé avec le chantier 4) :
//   score + cross-check + red team + aperçu du Risk Engine (+ grille TRADE vs BUILD) → une des cinq routes.
//
// Hiérarchie respectée par construction : RISK ENGINE > TRADING > STRATEGY > CLAUDE. Le routeur ne peut que dire
// « NO_TRADE » plus souvent que le Risk Engine, jamais moins : un `riskPreview.allowed = false` est définitif ici, et
// un `allowed = true` ne vaut qu'aperçu — l'exécuteur ré-évalue sur la machine d'Hervé avec ses propres entrées.
//
// Seuils explicites (ROUTE_THRESHOLDS, surchargeables) :
//   - score ≥ minScore (60) ;
//   - conviction ≥ MOYENNE (FAIBLE = jamais de trade, quelle que soit la force des signaux) ;
//   - red team ≠ NO_TRADE ; un red team WARN exige un score ≥ minScoreWithWarnings (70) ;
//   - couverture du score ≥ minCoverage (0,5) : un score calculé sur moins de la moitié des poids n'est pas un score.

import type { CrossCheckResult } from "../signals/crosscheck.ts";
import type { ScoreResult } from "../signals/score.ts";
import type { RedteamResult } from "../redteam/checklist.ts";
import type { TradeVsBuildResult } from "./tradeVsBuild.ts";

export type RouteDecision = "MEMECOIN_TRADE" | "CRYPTO_TRADE" | "NO_TRADE" | "BUILD" | "TRADE_AND_BUILD";

export interface RouteThresholds {
  minScore: number;
  minScoreWithWarnings: number;
  minCoverage: number;
}

export const ROUTE_THRESHOLDS: RouteThresholds = { minScore: 60, minScoreWithWarnings: 70, minCoverage: 0.5 };

/** Aperçu du Risk Engine côté analyse (mêmes règles, entrées non vérifiées) — forme de RiskVerdict. */
export interface RiskPreview {
  allowed: boolean;
  reasons: string[];
}

export interface RouteInput {
  score: Pick<ScoreResult, "score" | "coverage" | "missing">;
  crossCheck: Pick<CrossCheckResult, "convergence" | "conviction" | "families">;
  redteam: Pick<RedteamResult, "verdict" | "vetoes" | "unknownHard" | "overridden">;
  riskPreview: RiskPreview;
  /** Classe d'actif de la thèse : memecoin (Solana, pump/migration) ou crypto (BTC/SOL/majors, dérivés). Défaut memecoin. */
  assetClass?: "memecoin" | "crypto";
  /** Grille TRADE vs BUILD si une option de construction existe pour cette thèse. */
  tradeVsBuild?: Pick<TradeVsBuildResult, "decision" | "tradeTotal" | "buildTotal"> | null;
  thresholds?: Partial<RouteThresholds>;
}

export interface RouteResult {
  decision: RouteDecision;
  /** Vrai si les conditions de trade sont toutes réunies (avant prise en compte de BUILD). */
  tradeAllowed: boolean;
  buildRecommended: boolean;
  reasons: string[];
  explanation: string;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Version expliquée du routage. Pure, ne lève jamais : toute entrée manquante = NO_TRADE motivé. */
export function explainRoute(input: RouteInput): RouteResult {
  const reasons: string[] = [];
  const t = { ...ROUTE_THRESHOLDS, ...(input?.thresholds ?? {}) };
  const i = input ?? ({} as RouteInput);

  // 1. Risk Engine (aperçu) : dernier mot, même en aperçu.
  if (!i.riskPreview || typeof i.riskPreview.allowed !== "boolean") reasons.push("RISQUE_INCONNU: aucun aperçu du Risk Engine");
  else if (!i.riskPreview.allowed) reasons.push(`RISQUE_REFUS: ${(i.riskPreview.reasons ?? []).join(" | ") || "refusé"}`);

  // 2. Red team.
  if (!i.redteam || typeof i.redteam.verdict !== "string") reasons.push("REDTEAM_ABSENT: checklist non exécutée");
  else if (i.redteam.verdict === "NO_TRADE") {
    reasons.push(`REDTEAM_VETO: ${[...(i.redteam.vetoes ?? []), ...(i.redteam.unknownHard ?? []).map((u) => `${u} inconnu`)].join(", ") || "NO_TRADE"}`);
  }

  // 3. Cross-check : 1 famille = FAIBLE = pas de trade.
  if (!i.crossCheck || typeof i.crossCheck.conviction !== "string") reasons.push("CROSSCHECK_ABSENT");
  else if (i.crossCheck.conviction === "FAIBLE") reasons.push(`CONVICTION_FAIBLE: ${i.crossCheck.convergence} famille(s) indépendante(s)`);

  // 4. Score et couverture.
  if (!i.score || !num(i.score.score)) reasons.push("SCORE_ABSENT");
  else {
    const needed = i.redteam?.verdict === "WARN" ? t.minScoreWithWarnings : t.minScore;
    if (i.score.score < needed) reasons.push(`SCORE_INSUFFISANT: ${i.score.score} < ${needed}${i.redteam?.verdict === "WARN" ? " (red team WARN)" : ""}`);
    if (num(i.score.coverage) && i.score.coverage < t.minCoverage) reasons.push(`COUVERTURE_INSUFFISANTE: ${Math.round(i.score.coverage * 100)} % des poids renseignés < ${Math.round(t.minCoverage * 100)} %`);
  }

  const tradeAllowed = reasons.length === 0;
  const tradeRoute: RouteDecision = i.assetClass === "crypto" ? "CRYPTO_TRADE" : "MEMECOIN_TRADE";

  // 5. BUILD : uniquement d'après la grille (jamais déduit d'un refus de trade).
  const tvb = i.tradeVsBuild ?? null;
  const buildRecommended = tvb !== null && (tvb.decision === "BUILD" || tvb.decision === "TRADE_AND_BUILD");

  let decision: RouteDecision;
  if (tradeAllowed && buildRecommended) decision = "TRADE_AND_BUILD";
  else if (tradeAllowed) decision = tradeRoute;
  else if (buildRecommended) decision = "BUILD";
  else decision = "NO_TRADE";

  const explanation =
    `${decision} — ` +
    (tradeAllowed
      ? `trade autorisé (score ${i.score.score}, conviction ${i.crossCheck.conviction}, red team ${i.redteam.verdict}${i.redteam.overridden ? " avec veto levé par un humain" : ""}, risque OK en aperçu — l'exécuteur ré-évaluera localement)`
      : `pas de trade : ${reasons.join(" ; ")}`) +
    (tvb ? ` ; grille TRADE vs BUILD : ${tvb.decision} (trade ${tvb.tradeTotal}, build ${tvb.buildTotal})` : " ; aucune grille TRADE vs BUILD fournie") +
    (buildRecommended ? " → construction recommandée" : "") +
    ".";
  return { decision, tradeAllowed, buildRecommended, reasons, explanation };
}

/** Routage : renvoie la seule décision. Voir explainRoute pour les raisons. */
export function route(input: RouteInput): RouteDecision {
  return explainRoute(input).decision;
}
