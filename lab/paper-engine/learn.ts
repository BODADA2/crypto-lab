/**
 * Apprentissage du moteur paper (§5 du cahier des charges).
 *
 * Après chaque bloc de 20 décisions clôturées :
 * 1. analyse des erreurs ;
 * 2. configurations qui échouent régulièrement ;
 * 3. caractéristiques communes aux trades réussis ;
 * 4-8. réévaluation des critères/seuils — MAIS :
 *
 * GARDE-FOUS ANTI-SUR-APPRENTISSAGE (§5) :
 * - aucun ajustement sur une petite série de trades négative ;
 * - tout ajustement exige une preuve n≥30 (ENGINE.minTradesForAdjustment) ;
 * - tout ajustement est validé sur des données SÉPARÉES (walk-forward : on ajuste
 *   sur le bloc N, on valide sur le bloc N+1 avant d'adopter) ;
 * - chaque modification est tracée dans data/paper-engine/CHANGELOG.md avec
 *   date, avant/après, preuve et validation.
 *
 * En pratique : analyzeBlock() produit l'analyse et des hypothèses ; les
 * ajustements effectifs passent par proposeAdjustment() qui VÉRIFIE les
 * conditions avant d'écrire quoi que ce soit.
 */
import { ENGINE } from "./config.ts";
import { logAdjustment } from "./ledger.ts";
import type { ClosedPaperDecision } from "./types.ts";

export interface BlockAnalysis {
  blockSize: number;
  notes: string[];
  hypotheses: string[];
  /** Traits communs aux gagnants / perdants (descriptif, pas prescriptif). */
  winnerTraits: string[];
  loserTraits: string[];
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)} %`);

export function analyzeBlock(block: ClosedPaperDecision[]): BlockAnalysis {
  const notes: string[] = [];
  const hypotheses: string[] = [];
  const winnerTraits: string[] = [];
  const loserTraits: string[] = [];
  const wins = block.filter((d) => d.close.resultR > 0);
  const losses = block.filter((d) => d.close.resultR <= 0);
  const wr = block.length ? wins.length / block.length : null;
  notes.push(
    `bloc de ${block.length} clôtures : ${wins.length} gains, ${losses.length} pertes (win rate ${pct(wr)})`,
  );

  // Erreurs déclarées.
  const errCount = new Map<string, number>();
  for (const d of block) {
    const e = d.close.error || "aucune";
    errCount.set(e, (errCount.get(e) ?? 0) + 1);
  }
  const topErrs = [...errCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [e, n] of topErrs) notes.push(`erreur "${e}" : ${n}/${block.length}`);

  // Par setup.
  const bySetup = new Map<string, { w: number; n: number }>();
  for (const d of block) {
    const s = bySetup.get(d.setup) ?? { w: 0, n: 0 };
    s.n++;
    if (d.close.resultR > 0) s.w++;
    bySetup.set(d.setup, s);
  }
  for (const [s, v] of bySetup) {
    notes.push(`setup ${s} : ${v.w}/${v.n} gagnants (${pct(v.n ? v.w / v.n : null)})`);
  }

  // Par raison de sortie.
  const byExit = new Map<string, number>();
  for (const d of block) byExit.set(d.close.exitReason, (byExit.get(d.close.exitReason) ?? 0) + 1);
  notes.push(
    `sorties : ${[...byExit.entries()].map(([k, v]) => `${k}×${v}`).join(", ")}`,
  );

  // Traits communs (seuils simples, descriptifs).
  const avgScoreWin = wins.length
    ? wins.reduce((a, d) => a + (d.score?.composite ?? 0), 0) / wins.length
    : null;
  const avgScoreLoss = losses.length
    ? losses.reduce((a, d) => a + (d.score?.composite ?? 0), 0) / losses.length
    : null;
  if (avgScoreWin !== null && avgScoreLoss !== null) {
    notes.push(`score moyen : gagnants ${avgScoreWin.toFixed(0)}, perdants ${avgScoreLoss.toFixed(0)}`);
    if (avgScoreWin > avgScoreLoss + 5) winnerTraits.push("score composite plus élevé");
    else if (avgScoreLoss > avgScoreWin + 5) loserTraits.push("les perdants avaient pourtant un meilleur score — le score ne prédit pas");
  }
  const stopOut = byExit.get("stop") ?? 0;
  if (stopOut > block.length * 0.6) {
    loserTraits.push("majorité de sorties sur stop — stops trop serrés ou entrées tardives ?");
    hypotheses.push("H-LEARN-1 : élargir le stop de 20 % à 25 % — à valider n≥30 sur données séparées");
  }
  const tps = (byExit.get("tp1") ?? 0) + (byExit.get("tp2") ?? 0) + (byExit.get("tp3") ?? 0);
  if (tps > block.length * 0.6) winnerTraits.push("majorité de sorties sur objectifs — le plan de sortie est respecté");

  if (block.length < ENGINE.minTradesForAdjustment) {
    notes.push(
      `bloc < ${ENGINE.minTradesForAdjustment} trades : AUCUN ajustement de seuil (anti-sur-apprentissage)`,
    );
  }
  return { blockSize: block.length, notes, hypotheses, winnerTraits, loserTraits };
}

export interface AdjustmentProposal {
  parameter: string;
  before: string;
  after: string;
  evidence: string;
  /** Résultat de la validation sur données séparées (walk-forward). */
  validation: string;
  valid: boolean;
  rejectionReason: string | null;
}

/**
 * Valide une proposition d'ajustement AVANT de l'appliquer. En v1, la validation
 * sur données séparées est une vérification explicite fournie par l'appelant
 * (résultat d'un backtest walk-forward) — jamais une simple impression.
 */
export function proposeAdjustment(
  rootDir: string,
  p: Omit<AdjustmentProposal, "valid" | "rejectionReason"> & {
    evidenceTrades: number;
    validationTrades: number;
    validationPositive: boolean;
  },
): AdjustmentProposal {
  if (p.evidenceTrades < ENGINE.minTradesForAdjustment) {
    return {
      ...p,
      valid: false,
      rejectionReason: `preuve insuffisante : n=${p.evidenceTrades} < ${ENGINE.minTradesForAdjustment} — aucun ajustement sur petite série`,
    };
  }
  if (p.validationTrades < ENGINE.minTradesForAdjustment || !p.validationPositive) {
    return {
      ...p,
      valid: false,
      rejectionReason: `validation sur données séparées insuffisante ou négative (n=${p.validationTrades})`,
    };
  }
  logAdjustment(rootDir, {
    date: new Date().toISOString().slice(0, 10),
    parameter: p.parameter,
    before: p.before,
    after: p.after,
    evidence: p.evidence,
    validation: p.validation,
  });
  return { ...p, valid: true, rejectionReason: null };
}
