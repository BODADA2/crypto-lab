/**
 * Rapport de cycle au format EXACT du §11 du cahier des charges.
 * En français. Les chiffres viennent du ledger, jamais d'impressions.
 */
import type { CycleSummary, PerformanceMetrics } from "./types.ts";

const pct = (x: number | null, d = 1): string =>
  x === null || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(d)} %`;
const num = (x: number | null, d = 2): string =>
  x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(d);
const pf = (x: number | null): string =>
  x === null ? "n/a" : !Number.isFinite(x) ? "∞ (aucune perte)" : x.toFixed(2);

function metricsBlock(m: PerformanceMetrics): string[] {
  const L: string[] = [];
  L.push(`Nombre de trades : ${m.trades}`);
  L.push(`Win rate : ${pct(m.winRate)}`);
  L.push(`Average win : ${m.averageWinPct === null ? "n/a" : m.averageWinPct.toFixed(2) + " %"}`);
  L.push(`Average loss : ${m.averageLossPct === null ? "n/a" : m.averageLossPct.toFixed(2) + " %"}`);
  L.push(`Profit factor : ${pf(m.profitFactor)}`);
  L.push(`Expectancy : ${m.expectancyPct === null ? "n/a" : m.expectancyPct.toFixed(2) + " %"}`);
  L.push(`Max drawdown : ${m.maxDrawdownPct.toFixed(2)} %`);
  L.push(`Average R : ${num(m.averageR)}`);
  L.push(`Median R : ${num(m.medianR)}`);
  const sec = (t: string, r: Record<string, { trades: number; winRate: number | null; averageR: number | null }>) => {
    const ks = Object.keys(r);
    if (!ks.length) return;
    L.push(`Par ${t} :`);
    for (const k of ks) {
      const b = r[k];
      if (!b) continue;
      L.push(`  - ${k} : ${b.trades} trades, win rate ${pct(b.winRate)}, R moyen ${num(b.averageR)}`);
    }
  };
  sec("setup", m.bySetup);
  sec("market cap", m.byMarketCap);
  sec("blockchain", m.byChain);
  sec("régime", m.byRegime);
  return L;
}

function elimReasons(s: CycleSummary): string[] {
  const counts = new Map<string, number>();
  for (const e of s.eliminated) {
    for (const r of e.reasons) {
      const key = (r.split(":")[0] ?? r).replace(
        /score \d+ < \d+ ou couverture \d+ % < \d+ %/,
        "score ou couverture < seuils",
      );
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- ${k} : ${v} tokens`);
}

export function renderCycleReport(s: CycleSummary): string {
  const L: string[] = [];
  L.push(`# Rapport de cycle — ${s.cycleId}`);
  L.push("");
  L.push(`DATE : ${s.date}`);
  L.push(`RÉGIME DU MARCHÉ : ${s.marketRegime}`);
  if (s.regimeNote) L.push(`Note régime : ${s.regimeNote}`);
  if (s.halted) L.push(`⚠️ CYCLE EN HALT — aucune nouvelle position (voir erreurs).`);
  L.push("");
  L.push(`TOKENS ANALYSÉS : ${s.tokensAnalyzed}`);
  L.push(`NOUVEAUX TOKENS : ${s.newTokens}`);
  L.push(`TOKENS ÉLIMINÉS : ${s.eliminated.length}`);
  L.push(`RAISONS D'ÉLIMINATION :`);
  const er = elimReasons(s);
  L.push(...(er.length ? er : ["- aucune"]));
  L.push("");
  L.push(`PAPER TRADES : ${s.paperTrades}`);
  L.push(`GAINS : ${s.wins}`);
  L.push(`PERTES : ${s.losses}`);
  L.push(`NO TRADE : ${s.noTrades} (dont ${s.noTradesPersisted} persistées au journal — plafond anti-bruit)`);
  L.push(`POSITIONS OUVERTES EN FIN DE CYCLE : ${s.open}`);
  L.push("");
  L.push(`PERFORMANCE (cumulée sur tout l'historique du moteur) :`);
  L.push(...metricsBlock(s.metrics).map((l) => `${l}`));
  // Renomme les clés du format §11 :
  L.push("");
  L.push(`ERREURS DÉTECTÉES :`);
  L.push(...(s.errors.length ? s.errors.map((e, i) => `${i + 1}. ${e}`) : ["1. aucune erreur bloquante ce cycle"]));
  L.push("");
  L.push(`AJUSTEMENTS :`);
  L.push(...(s.adjustments.length ? s.adjustments.map((a, i) => `${i + 1}. ${a}`) : ["1. aucun (preuve insuffisante — anti-sur-apprentissage)"]));
  L.push("");
  L.push(`HYPOTHÈSES À TESTER :`);
  L.push(...(s.hypothesesToTest.length ? s.hypothesesToTest.map((h, i) => `${i + 1}. ${h}`) : ["1. aucune"]));
  L.push("");
  L.push(`OPPORTUNITÉS ACTUELLES :`);
  if (!s.opportunities.length) {
    L.push("- aucune opportunité ouverte en fin de cycle (positions simulées clôturées en walk-forward)");
  } else {
    for (const o of s.opportunities) {
      L.push(`- Token : ${o.token}`);
      L.push(`  Setup : ${o.setup}`);
      L.push(`  Conditions nécessaires : ${o.requiredConditions}`);
      L.push(`  Invalidation : ${o.invalidation}`);
    }
  }
  if (s.notApplicable.length) {
    L.push("");
    L.push(`SECTIONS INAPPLICABLES (données absentes — INCONNU, rien d'inventé) :`);
    for (const n of s.notApplicable) L.push(`- ${n}`);
  }
  L.push("");
  L.push(`---`);
  L.push(`Rappel : ceci est du PAPER TRADING simulé sur données historiques. Aucune transaction réelle.`);
  L.push(`Le score interne est un classement relatif, jamais une garantie de rendement.`);
  return L.join("\n");
}
