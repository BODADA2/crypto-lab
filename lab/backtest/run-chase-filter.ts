/**
 * Backtest H-CHASE — filtre d'entrée anti-poursuite, données RÉELLES (data/history/*.jsonl).
 *
 * Origine : TikTok @sixpathsss — « do not put your bread in charts that go all the way up ».
 * Hypothèse : entrer sur un token en bougie verticale détruit l'espérance ; attendre
 * que le mouvement se calme (ou passer) améliore les résultats.
 *
 * Opérationnalisation (pré-enregistrée AVANT de voir les résultats) :
 * - Barre candidate : prix > 0, liquidité ≥ 20 000 $, index ≥ 3 (assez d'historique
 *   pour mesurer le mouvement — walk-forward strict, jamais de futur).
 * - Métrique chase(t) = prix(t) / min(prix(t-1), prix(t-2), prix(t-3)) − 1
 *   (≈ +50 % sur ~40 min vu l'espacement médian des observations).
 *   Le min sur 3 barres capte aussi les pics en V dans la fenêtre.
 * - Seuil PRIMAIRE : chase ≥ +50 % ⇒ « vertical » (rejet/report).
 *   Justification : +50 % en ~40 min sur un token déjà liquide = l'équivalent mesurable
 *   du « straight up » de la vidéo ; ≈ P94 de la distribution observée sur les barres
 *   candidates (sélectif sans vider les buckets). Seuil secondaire +100 % en sensibilité.
 * - Variante A « baseline » : signal = première barre candidate, entrée à t+1.
 * - Variante B « chase-filter » : signal = première barre candidate avec chase < 50 %,
 *   entrée à t+1 ; token écarté si aucune barre ne passe.
 * - Sorties IDENTIQUES : régime scalp via simulateExit (TP +30 %, SL −20 %, time-stop),
 *   coûts taille 50 $, frais 1,3 %, slippage plafonné 3 % — comme la variante scalp de H-EXIT.
 *
 * Règle n ≥ 30 par variante (MIN_TRADES_FOR_CONCLUSION). Sous le seuil ⇒ NO ACTION.
 *
 * Biais connus (documentés, pas corrigés en silence) :
 * - les tokens écartés par B (jamais calmes) n'apparaissent que dans A ;
 * - « calme » au signal n'empêche pas une verticale juste après l'entrée ;
 * - MFE médian rapporté sans censurer les ticks aberrants (cf. robustesse H-EXIT).
 *
 * Usage : `npx tsx lab/backtest/run-chase-filter.ts [racine]`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistoryDir, summarize, MIN_TRADES_FOR_CONCLUSION, type Trade } from "./harness.ts";
import { simulateExit, type ExitCosts, type PricePoint } from "../signals/exit.ts";
import type { TokenSnapshot } from "../types.ts";

export const CHASE_THRESHOLD = 0.5; // +50 % — seuil primaire pré-enregistré
export const CHASE_THRESHOLD_ALT = 1.0; // +100 % — sensibilité
const MIN_LIQ = 20_000;
const MIN_IDX = 3; // assez d'historique pour la métrique

/** chase(t) sur l'historique jusqu'à t inclus (jamais de futur). null si pas assez d'historique. */
export function chaseAt(series: TokenSnapshot[], t: number): number | null {
  if (t < MIN_IDX) return null;
  const refs = [series[t - 1]!.priceUsd, series[t - 2]!.priceUsd, series[t - 3]!.priceUsd];
  if (refs.some((p) => p <= 0) || series[t]!.priceUsd <= 0) return null;
  return series[t]!.priceUsd / Math.min(...refs) - 1;
}

function toPricePoints(series: TokenSnapshot[]): PricePoint[] {
  return series.map((s) => ({ t: s.fetchedAt, price: s.priceUsd, liquidityUsd: s.liquidityUsd }));
}

function isCandidate(s: TokenSnapshot, idx: number): boolean {
  return idx >= MIN_IDX && s.priceUsd > 0 && s.liquidityUsd >= MIN_LIQ;
}

interface Entry {
  signalIdx: number;
  entryIdx: number;
  chase: number;
  vertical: boolean;
}

function findEntry(series: TokenSnapshot[], threshold: number | null): Entry | null {
  for (let i = MIN_IDX; i < series.length - 1; i++) {
    const s = series[i]!;
    if (!isCandidate(s, i)) continue;
    const chase = chaseAt(series, i);
    if (chase === null) continue;
    // La verticalité est TOUJOURS mesurée au seuil primaire (bucket observationnel honnête) ;
    // `threshold` ne contrôle que le comportement d'entrée (null = baseline, entre tout).
    const vertical = chase >= CHASE_THRESHOLD;
    if (threshold === null || chase < threshold) {
      return { signalIdx: i, entryIdx: i + 1, chase, vertical };
    }
  }
  return null;
}

function planToTrade(mint: string, entry: TokenSnapshot, plan: ReturnType<typeof simulateExit>, chase: number): Trade {
  const last = plan.fills[plan.fills.length - 1]!;
  return {
    mint,
    entryAt: entry.fetchedAt,
    exitAt: last.exitAt,
    entryPrice: entry.priceUsd,
    exitPrice: last.exitPrice,
    ret: plan.blendedRet,
    grossRet: plan.blendedGross,
    bars: last.bars,
    exit: last.exit,
    score: chase,
    costs: 0,
    strategyId: "chase-filter",
  };
}

/** MFE = plus haut prix après l'entrée / prix d'entrée. */
function mfe(series: TokenSnapshot[], entryIdx: number): number | null {
  const entry = series[entryIdx]!;
  if (!entry || entry.priceUsd <= 0) return null;
  let m = 0;
  for (let j = entryIdx + 1; j < series.length; j++) {
    const p = series[j]!.priceUsd;
    if (p > 0) m = Math.max(m, p / entry.priceUsd);
  }
  return m > 0 ? m : null;
}

const q = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

export interface ChaseFilterReport {
  computedAt: string;
  threshold: number;
  tokens: number;
  baseline: ReturnType<typeof summarize>;
  filtered: ReturnType<typeof summarize>;
  /** MFE médian par variante + bucket observationnel (vertical vs calme dans A). */
  mfeMedianBaseline: number | null;
  mfeMedianFiltered: number | null;
  mfeMedianVerticalInA: number | null;
  mfeMedianCalmInA: number | null;
  nVerticalInA: number;
  nCalmInA: number;
  /** Stats robustes : la moyenne est dominée par les outliers (cf. H-EXIT). */
  robustBaseline: { medianRet: number | null; top5Share: number | null; maxTradeX: number | null };
  robustFiltered: { medianRet: number | null; top5Share: number | null; maxTradeX: number | null };
  /** Sensibilité au seuil +100 %. */
  sensitivity100: { n: number; expectancy: number | null; winRate: number | null };
  verdict: string;
}

function robust(rets: number[]) {
  if (!rets.length) return { medianRet: null, top5Share: null, maxTradeX: null };
  const s = [...rets].sort((a, b) => a - b);
  const medianRet = s[Math.floor(s.length / 2)]!;
  const sum = s.reduce((a, b) => a + b, 0);
  const top5 = [...s].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
  return {
    medianRet,
    top5Share: sum !== 0 ? top5 / sum : null,
    maxTradeX: 1 + Math.max(...s),
  };
}

export function runChaseFilterBacktest(rootDir: string, threshold = CHASE_THRESHOLD): ChaseFilterReport {
  const seriesByMint = loadHistoryDir(join(rootDir, "data", "history"));
  const costs: ExitCosts = { sizeUsd: 50, feesRoundTrip: 0.013, maxSlippage: 0.03 };

  const tradesA: Trade[] = [];
  const tradesB: Trade[] = [];
  const mfeA: number[] = [];
  const mfeB: number[] = [];
  const mfeVerticalA: number[] = [];
  const mfeCalmA: number[] = [];
  let observations = 0;

  for (const [mint, raw] of seriesByMint) {
    const series = [...raw].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    observations += series.length;
    const path = toPricePoints(series);

    const entryA = findEntry(series, null); // baseline : première candidate
    if (entryA) {
      try {
        const plan = simulateExit(path, entryA.entryIdx, "scalp", costs);
        tradesA.push(planToTrade(mint, series[entryA.entryIdx]!, plan, entryA.chase));
        const m = mfe(series, entryA.entryIdx);
        if (m !== null) {
          mfeA.push(m);
          (entryA.vertical ? mfeVerticalA : mfeCalmA).push(m);
        }
      } catch { /* série inexploitable */ }
    }
    const entryB = findEntry(series, threshold); // filtrée : première candidate calme
    if (entryB) {
      try {
        const plan = simulateExit(path, entryB.entryIdx, "scalp", costs);
        tradesB.push(planToTrade(mint, series[entryB.entryIdx]!, plan, entryB.chase));
        const m = mfe(series, entryB.entryIdx);
        if (m !== null) mfeB.push(m);
      } catch { /* série inexploitable */ }
    }
  }

  const base = summarize(tradesA, seriesByMint.size, observations);
  const filt = summarize(tradesB, seriesByMint.size, observations);
  const robustBaseline = robust(tradesA.map((t) => t.ret));
  const robustFiltered = robust(tradesB.map((t) => t.ret));

  // Sensibilité : même protocole au seuil +100 % (résumé simple, pas de double test caché).
  const tradesAlt: Trade[] = [];
  for (const [mint, raw] of seriesByMint) {
    const series = [...raw].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    const entry = findEntry(series, CHASE_THRESHOLD_ALT);
    if (!entry) continue;
    try {
      const plan = simulateExit(toPricePoints(series), entry.entryIdx, "scalp", costs);
      tradesAlt.push(planToTrade(mint, series[entry.entryIdx]!, plan, entry.chase));
    } catch { /* ignorée */ }
  }
  const alt = summarize(tradesAlt, seriesByMint.size, observations);

  const verdict = verdictFor(base, filt, robustBaseline, robustFiltered, threshold);

  return {
    computedAt: new Date().toISOString(),
    threshold,
    tokens: seriesByMint.size,
    baseline: base,
    filtered: filt,
    mfeMedianBaseline: q(mfeA, 0.5),
    mfeMedianFiltered: q(mfeB, 0.5),
    mfeMedianVerticalInA: q(mfeVerticalA, 0.5),
    mfeMedianCalmInA: q(mfeCalmA, 0.5),
    nVerticalInA: mfeVerticalA.length,
    nCalmInA: mfeCalmA.length,
    robustBaseline,
    robustFiltered,
    sensitivity100: { n: alt.n, expectancy: alt.expectancy, winRate: alt.winRate },
    verdict,
  };
}

function verdictFor(
  base: ReturnType<typeof summarize>,
  filt: ReturnType<typeof summarize>,
  rb: { medianRet: number | null },
  rf: { medianRet: number | null },
  threshold: number,
): string {
  if (!filt.conclusive)
    return `NO ACTION : variante filtrée n=${filt.n} < ${MIN_TRADES_FOR_CONCLUSION} — échantillon insuffisant, aucune conclusion sur H-CHASE.`;
  if (!base.conclusive)
    return `NO ACTION : variante baseline n=${base.n} < ${MIN_TRADES_FOR_CONCLUSION} — comparaison impossible.`;
  // La moyenne est dominée par les ticks aberrants (cf. H-EXIT) : le verdict repose
  // sur la MÉDIANE des rendements nets, pas sur la moyenne.
  const medB = rf.medianRet ?? 0;
  const medA = rb.medianRet ?? 0;
  const dMed = medB - medA;
  const medLine = `médiane ${(medB * 100).toFixed(1)} % vs ${(medA * 100).toFixed(1)} % baseline`;
  if (dMed > 0.01)
    return `Variante filtrée (seuil +${Math.round(threshold * 100)} %, n=${filt.n}) : ${medLine} (Δ +${(dMed * 100).toFixed(1)} pts) — H-CHASE améliore les résultats sur ces données. À confirmer en paper avant toute implémentation.`;
  if (dMed < -0.01)
    return `Variante filtrée (seuil +${Math.round(threshold * 100)} %, n=${filt.n}) : ${medLine} (Δ ${(dMed * 100).toFixed(1)} pts) — le filtre DÉGRADE les résultats ici : NO ACTION sur H-CHASE.`;
  return `Variante filtrée (seuil +${Math.round(threshold * 100)} %, n=${filt.n}) : ${medLine} — écart négligeable : H-CHASE non concluant sur ces données, NO ACTION.`;
}

export function formatChaseReport(r: ChaseFilterReport): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)} %`);
  const rob = (x: { medianRet: number | null; top5Share: number | null; maxTradeX: number | null }) =>
    `médiane ${pct(x.medianRet)} | top-5 = ${x.top5Share === null ? "n/a" : (x.top5Share * 100).toFixed(1) + " %"} de la somme | max 1 trade x${x.maxTradeX === null ? "n/a" : x.maxTradeX.toFixed(0)}`;
  const lines = [
    `Backtest H-CHASE — filtre anti-poursuite (seuil +${Math.round(r.threshold * 100)} %, données réelles)`,
    `Tokens : ${r.tokens} — sorties scalp identiques (TP +30 %, SL −20 %), coûts 1,3 % + slippage`,
    ``,
    `=== baseline (première barre candidate) ===`,
    `n=${r.baseline.n}${r.baseline.conclusive ? "" : " (NON CONCLUANT)"} | moyenne ${pct(r.baseline.expectancy)} / trade (dominée par outliers — voir robustesse) | win rate ${pct(r.baseline.winRate)} | MFE médian ${r.mfeMedianBaseline === null ? "n/a" : "x" + r.mfeMedianBaseline.toFixed(2)}`,
    `robustesse : ${rob(r.robustBaseline)}`,
    `  └─ bucket observationnel dans A : verticales n=${r.nVerticalInA} → MFE médian ${r.mfeMedianVerticalInA === null ? "n/a" : "x" + r.mfeMedianVerticalInA.toFixed(2)} | calmes n=${r.nCalmInA} → MFE médian ${r.mfeMedianCalmInA === null ? "n/a" : "x" + r.mfeMedianCalmInA.toFixed(2)}`,
    ``,
    `=== filtrée (première barre candidate CALME) ===`,
    `n=${r.filtered.n}${r.filtered.conclusive ? "" : " (NON CONCLUANT)"} | moyenne ${pct(r.filtered.expectancy)} / trade | win rate ${pct(r.filtered.winRate)} | MFE médian ${r.mfeMedianFiltered === null ? "n/a" : "x" + r.mfeMedianFiltered.toFixed(2)}`,
    `robustesse : ${rob(r.robustFiltered)}`,
    ``,
    `Sensibilité seuil +100 % : n=${r.sensitivity100.n} | moyenne ${pct(r.sensitivity100.expectancy)} | win rate ${pct(r.sensitivity100.winRate)}`,
    ``,
    r.verdict,
  ];
  return lines.join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const report = runChaseFilterBacktest(rootDir);
  const outDir = join(rootDir, "data", "backtests");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `chase-filter-${report.computedAt.slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(formatChaseReport(report));
  console.log(`\nRapport JSON : ${outPath}`);
}
