// Journal d'hypothèses et rapport hebdomadaire. Le rapport est une fonction pure → markdown.

import type { HypothesisEntry, LedgerEntry } from "../types.ts";
import { appendJsonl, readJsonl, writeFileAtomic } from "../ledger/ledger.ts";
import { isoWeekKey, parseIso } from "../time.ts";

export function readJournal(filePath: string): HypothesisEntry[] {
  return readJsonl<HypothesisEntry>(filePath);
}

export function appendHypothesis(filePath: string, entry: HypothesisEntry): void {
  if (!entry.id || !entry.signal || !entry.createdAt) throw new Error("journal : id, signal et createdAt requis");
  appendJsonl(filePath, entry);
}

export type HypothesisResultPatch = Partial<Pick<HypothesisEntry, "result" | "error" | "return" | "drawdown" | "decision">>;

/** Met à jour le résultat d'une hypothèse (réécriture atomique du fichier). Renvoie faux si l'id est inconnu. */
export function updateHypothesisResult(filePath: string, id: string, patch: HypothesisResultPatch, now: Date): boolean {
  const entries = readJournal(filePath);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  const updated: HypothesisEntry = { ...entries[idx]!, ...patch, resolvedAt: now.toISOString() };
  entries[idx] = updated;
  writeFileAtomic(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return true;
}

// ---------------------------------------------------------------------------
// Rapport hebdomadaire
// ---------------------------------------------------------------------------

export interface WeeklyReportInput {
  ledger: readonly LedgerEntry[];
  hypotheses: readonly HypothesisEntry[];
  /** Semaine ISO ciblée, ex. "2026-W39". */
  weekKey: string;
  timeZone: string;
  /** Observations minimales sur un signal avant de proposer un changement (défaut 10). */
  minObservations?: number;
}

interface SignalStats {
  signal: string;
  n: number;
  wins: number;
  losses: number;
  avgReturn: number;
}

const FILLS = new Set(["PAPER", "EXECUTED"]);
const fmt = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
const pct = (n: number): string => `${(Math.round(n * 1000) / 10).toFixed(1)} %`;

function statsBySignal(hyps: readonly HypothesisEntry[]): Map<string, SignalStats> {
  const m = new Map<string, SignalStats>();
  for (const h of hyps) {
    if (!h.signal || typeof h.return !== "number" || !Number.isFinite(h.return)) continue;
    const s = m.get(h.signal) ?? { signal: h.signal, n: 0, wins: 0, losses: 0, avgReturn: 0 };
    s.avgReturn = (s.avgReturn * s.n + h.return) / (s.n + 1);
    s.n += 1;
    if (h.return > 0) s.wins += 1;
    else if (h.return < 0) s.losses += 1;
    m.set(h.signal, s);
  }
  return m;
}

function reasonCode(r: string): string {
  const i = r.indexOf(":");
  return i > 0 ? r.slice(0, i) : r;
}

/** Génère le rapport WHAT WORKED / WHAT FAILED / WHAT WE MISSED / WHAT TO CHANGE. Pure. */
export function weeklyReport(input: WeeklyReportInput): string {
  const minObs = input.minObservations ?? 10;
  const inWeek = (iso: string | undefined): boolean => {
    const d = parseIso(iso);
    return d !== null && isoWeekKey(d, input.timeZone) === input.weekKey;
  };

  const ledgerWeek = input.ledger.filter((e) => e && inWeek(e.ts));
  const fills = ledgerWeek.filter((e) => FILLS.has(e.decision));
  const sells = fills.filter((e) => e.kind === "SELL" && typeof e.pnlCad === "number");
  const rejected = ledgerWeek.filter((e) => e.decision === "REJECTED");
  const failed = ledgerWeek.filter((e) => e.decision === "FAILED");
  const hypsWeek = input.hypotheses.filter((h) => h && (inWeek(h.resolvedAt) || inWeek(h.createdAt)));
  const weekStats = statsBySignal(hypsWeek.filter((h) => inWeek(h.resolvedAt) || (h.return !== undefined && inWeek(h.createdAt))));
  const allStats = statsBySignal(input.hypotheses);

  const lines: string[] = [];
  lines.push(`# Rapport hebdomadaire — ${input.weekKey}`, "");
  const pnlWeek = sells.reduce((s, e) => s + (e.pnlCad as number), 0);
  const feesWeek = fills.reduce((s, e) => s + (e.fees?.totalCad ?? 0), 0);
  lines.push(
    `Ordres remplis : ${fills.length} (achats ${fills.filter((e) => e.kind === "BUY").length}, ventes ${sells.length}) · rejetés : ${rejected.length} · échoués : ${failed.length}`,
    `PnL réalisé : ${fmt(pnlWeek)} CAD · frais : ${fmt(feesWeek)} CAD · hypothèses touchées : ${hypsWeek.length}`,
    "",
  );

  // WHAT WORKED
  lines.push("## WHAT WORKED", "");
  const worked: string[] = [];
  for (const s of weekStats.values()) if (s.avgReturn > 0) worked.push(`- Signal \`${s.signal}\` : ${s.wins}/${s.n} gagnants, rendement moyen ${pct(s.avgReturn)} (n total = ${allStats.get(s.signal)?.n ?? s.n})`);
  for (const e of sells) if ((e.pnlCad as number) > 0) worked.push(`- Vente ${e.intentId} sur ${e.mint} : +${fmt(e.pnlCad as number)} CAD`);
  lines.push(...(worked.length ? worked : ["- Rien de concluant cette semaine."]), "");

  // WHAT FAILED
  lines.push("## WHAT FAILED", "");
  const failedLines: string[] = [];
  for (const s of weekStats.values()) if (s.avgReturn < 0) failedLines.push(`- Signal \`${s.signal}\` : ${s.losses}/${s.n} perdants, rendement moyen ${pct(s.avgReturn)} (n total = ${allStats.get(s.signal)?.n ?? s.n})`);
  for (const e of sells) if ((e.pnlCad as number) < 0) failedLines.push(`- Vente ${e.intentId} sur ${e.mint} : ${fmt(e.pnlCad as number)} CAD`);
  for (const e of failed) failedLines.push(`- Exécution échouée ${e.intentId} : ${e.reasons.join(" | ")}`);
  for (const h of hypsWeek) if (h.error) failedLines.push(`- Hypothèse ${h.id} (\`${h.signal}\`) en erreur : ${h.error}`);
  const codes = new Map<string, number>();
  for (const e of rejected) for (const r of e.reasons) codes.set(reasonCode(r), (codes.get(reasonCode(r)) ?? 0) + 1);
  if (codes.size > 0) {
    const top = [...codes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    failedLines.push(`- Motifs de rejet les plus fréquents : ${top.map(([c, n]) => `${c} ×${n}`).join(", ")}`);
  }
  lines.push(...(failedLines.length ? failedLines : ["- Aucun échec enregistré."]), "");

  // WHAT WE MISSED
  lines.push("## WHAT WE MISSED", "");
  const missed = hypsWeek.filter(
    (h) => (h.decision === "NO_ACTION" || h.decision === "REJECTED") && (h.result === "MISSED" || (typeof h.return === "number" && h.return > 0)),
  );
  lines.push(
    ...(missed.length
      ? missed.map((h) => `- ${h.id} (\`${h.signal}\`, décision ${h.decision}) : ${h.hypothesis}${typeof h.return === "number" ? ` — mouvement observé ${pct(h.return)}` : ""}`)
      : ["- Aucune occasion manquée identifiée (ou pas encore résolue)."]),
    "",
  );

  // WHAT TO CHANGE — jamais de changement de stratégie sous le seuil d'observations.
  lines.push("## WHAT TO CHANGE", "");
  const changes: string[] = [];
  const signals = new Set<string>([...weekStats.keys(), ...allStats.keys()]);
  for (const sig of [...signals].sort()) {
    const s = allStats.get(sig);
    if (!s || s.n < minObs) {
      changes.push(`- \`${sig}\` : n insuffisant (${s?.n ?? 0}/${minObs}) — aucun changement de stratégie proposé ; continuer à collecter.`);
      continue;
    }
    const winRate = s.wins / s.n;
    if (winRate < 0.4 || s.avgReturn < 0) changes.push(`- \`${sig}\` : ${pct(winRate)} de gagnants sur ${s.n}, rendement moyen ${pct(s.avgReturn)} → réduire le poids ou retirer le signal.`);
    else if (winRate > 0.6 && s.avgReturn > 0) changes.push(`- \`${sig}\` : ${pct(winRate)} de gagnants sur ${s.n}, rendement moyen ${pct(s.avgReturn)} → candidat à une pondération accrue (dans les limites de la politique).`);
    else changes.push(`- \`${sig}\` : ${pct(winRate)} de gagnants sur ${s.n} — neutre, garder tel quel.`);
  }
  const rejectTop = [...codes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (rejectTop && rejectTop[1] >= 3) {
    changes.push(`- Opérationnel : ${rejectTop[1]} rejets \`${rejectTop[0]}\` — ajuster la production d'intents (pas la politique de risque).`);
  }
  lines.push(...(changes.length ? changes : ["- Rien à changer : pas de signal observé."]), "");

  return lines.join("\n");
}
