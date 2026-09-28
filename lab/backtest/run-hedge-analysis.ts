/**
 * ANALYSE HEDGE — part des stratégies ÉLIMINÉES et de leurs modes d'échec pour
 * chercher un hedge / mécanisme de réduction du risque.
 *
 * PHASE : DÉCOUVERTE UNIQUEMENT. Aucune conclusion ne peut être tirée pour le
 * live : les données `data/history/` sont biaisées vers les tokens chauds
 * (toute mesure P&L = BORNE OPTIMISTE, déclarée partout), et `data/track-unbiased/`
 * (holdout) n'est JAMAIS touché ici.
 *
 * Variantes analysées (même univers de tokens, data/history/*.jsonl) :
 *   V1 scalp        — H-EXIT scalp (TP+30/SL−20/time-stop 6), entrée 1re obs liq≥20k$ @t+1
 *   V2 runner       — H-EXIT runner (paliers +50/+150/+300, SL−25 %, time-stop 48)
 *   V3 chase-A      — H-CHASE baseline (1re barre candidate idx≥3, sorties scalp)
 *   V4 chase-B      — H-CHASE filtrée (1re barre candidate CALME chase<50 %, sorties scalp)
 *   V5 delayed      — V1 avec entrée retardée d'une barre (t+2) : hedge temporel
 *   V6 fast-inval   — V1 + sortie d'urgence : exit si ≤ −8 % dans les 6 premières barres
 *   V7 short-stop   — V1 avec time-stop 3 barres au lieu de 6 : hedge d'horizon
 *   V8 vert-half    — V3 avec exposition ÷2 sur les entrées verticales (ret ×0,5, approx.)
 *   V9 no-frenzy    — V1 en sautant les entrées les jours de régime « frénésie »
 *   V10 ref-mom     — H-REF-MOM : entrées verticales (chase ≥ 0,5) + filtre de régime
 *                       (exclut famine/frénésie du module chainregime) + sorties scalp
 *
 * Candidats hedge évalués : H-HEDGE-1..5 (voir docs/hedge-analysis-2026-09-28.md).
 * Règle n ≥ 30 pour toute lecture ; IC 95 % par bootstrap (seed fixe).
 *
 * Usage : `npx tsx lab/backtest/run-hedge-analysis.ts [racine]`
 * Sortie : JSON sur stdout (résultats complets) + résumé console.
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistoryDir, estimateSlippage, MIN_TRADES_FOR_CONCLUSION } from "./harness.ts";
import { simulateExit, SCALP_PARAMS, type ExitCosts, type PricePoint } from "../signals/exit.ts";
import { chaseAt } from "./run-chase-filter.ts";
import { loadDailyStatsFromScans, computeChainRegimes, type ChainRegimeName } from "../collect/chainregime.ts";
import type { TokenSnapshot } from "../types.ts";

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
}
export const median = (xs: number[]) => quantile(xs, 0.5);
export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    dx += ((xs[i] as number) - mx) ** 2;
    dy += ((ys[i] as number) - my) ** 2;
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy);
}
function rank(xs: number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => (xs[a] as number) - (xs[b] as number));
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; i++) r[idx[i] as number] = i + 1;
  return r;
}
export const spearman = (xs: number[], ys: number[]) => pearson(rank(xs), rank(ys));

/** PRNG seedé (mulberry32) — bootstrap reproductible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** IC 95 % bootstrap de la moyenne (B rééchantillonnages). */
export function bootstrapMeanCI(xs: number[], B = 2000, seed = 42): [number, number] {
  const rnd = mulberry32(seed);
  const n = xs.length;
  const ms: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rnd() * n)] as number;
    ms.push(s / n);
  }
  return [quantile(ms, 0.025), quantile(ms, 0.975)];
}

/** IC 95 % bootstrap de la DIFFÉRENCE de moyennes appariées (ys − xs). */
export function bootstrapPairedDiffCI(xs: number[], ys: number[], B = 2000, seed = 42): [number, number] {
  const rnd = mulberry32(seed);
  const n = xs.length;
  const ds: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rnd() * n);
      s += (ys[k] as number) - (xs[k] as number);
    }
    ds.push(s / n);
  }
  return [quantile(ds, 0.025), quantile(ds, 0.975)];
}

/** IC 95 % bootstrap d'une corrélation de Pearson. */
export function bootstrapCorrCI(xs: number[], ys: number[], B = 1000, seed = 7): [number, number] {
  const rnd = mulberry32(seed);
  const n = xs.length;
  const cs: number[] = [];
  for (let b = 0; b < B; b++) {
    const bx: number[] = [];
    const by: number[] = [];
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rnd() * n);
      bx.push(xs[k] as number);
      by.push(ys[k] as number);
    }
    const c = pearson(bx, by);
    if (Number.isFinite(c)) cs.push(c);
  }
  return [quantile(cs, 0.025), quantile(cs, 0.975)];
}

/** Moyenne tronquée à p (robustesse contre les ticks aberrants). */
export function trimmedMean(xs: number[], p = 0.05): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length * p);
  const t = s.slice(k, Math.max(s.length - k, k + 1));
  return mean(t);
}

/** Winsorisation bilatérale au seuil cap. */
export function winsorize(xs: number[], cap: number): number[] {
  return xs.map((x) => Math.max(-cap, Math.min(cap, x)));
}

/** IC 95 % bootstrap de la MÉDIANE. */
export function bootstrapMedianCI(xs: number[], B = 2000, seed = 42): [number, number] {
  const rnd = mulberry32(seed);
  const n = xs.length;
  const ms: number[] = [];
  for (let b = 0; b < B; b++) {
    const samp: number[] = [];
    for (let i = 0; i < n; i++) samp.push(xs[Math.floor(rnd() * n)] as number);
    ms.push(median(samp));
  }
  return [quantile(ms, 0.025), quantile(ms, 0.975)];
}

/** IC 95 % bootstrap de la différence de MÉDIANES appariées. */
export function bootstrapPairedMedianDiffCI(xs: number[], ys: number[], B = 2000, seed = 43): [number, number] {
  const rnd = mulberry32(seed);
  const n = xs.length;
  const ds: number[] = [];
  for (let b = 0; b < B; b++) {
    const bx: number[] = [];
    const by: number[] = [];
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rnd() * n);
      bx.push(xs[k] as number);
      by.push(ys[k] as number);
    }
    ds.push(median(by) - median(bx));
  }
  return [quantile(ds, 0.025), quantile(ds, 0.975)];
}

const fmtP = (v: number | null) => (v === null || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(2)} %`);
const fmt2 = (v: number | null) => (v === null || !Number.isFinite(v) ? "n/a" : v.toFixed(2));

// ---------------------------------------------------------------------------
// Chargement des données
// ---------------------------------------------------------------------------

export interface HTrade {
  mint: string;
  entryAt: string;
  /** Timestamp de sortie (barre de sortie) — renseigné par enrich(), utilisé par le disjoncteur d'exposition. */
  exitAt?: string;
  entryDay: string;
  /** Rendement net (frais + slippage déduits). */
  ret: number;
  grossRet: number;
  bars: number;
  exit: string;
  entryLiq: number;
  chase: number | null;
  vertical: boolean;
  regime: ChainRegimeName;
  /** Index du signal dans la série (proxy d'âge du token à l'entrée). */
  ageIdx: number;
  mfe: number;
  mae: number;
}

const MIN_LIQ = 20_000;
const COSTS: ExitCosts = { sizeUsd: 50, feesRoundTrip: 0.013, maxSlippage: 0.03 };

function toPricePoints(series: TokenSnapshot[]): PricePoint[] {
  return series.map((s) => ({ t: s.fetchedAt, price: s.priceUsd, liquidityUsd: s.liquidityUsd }));
}

function sortedSeries(raw: TokenSnapshot[]): TokenSnapshot[] {
  return [...raw].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
}

/** netRet — même modèle de coûts que lab/signals/exit.ts (formule dupliquée, pas le module). */
function netRet(entryPrice: number, exitPrice: number, costs: ExitCosts, liqIn: number, liqOut: number): number {
  const fees = costs.feesRoundTrip ?? 0.013;
  const cap = costs.maxSlippage ?? 0.03;
  const slipIn = estimateSlippage(costs.sizeUsd, liqIn, cap);
  const slipOut = estimateSlippage(costs.sizeUsd, liqOut, cap);
  const gross = exitPrice / entryPrice - 1;
  return (1 + gross) * (1 - slipIn) * (1 - slipOut) * (1 - fees) - 1;
}

/**
 * Sortie scalp paramétrable — miroir de simulateExit("scalp") avec :
 * - timeStopBars réglable,
 * - sortie d'urgence optionnelle : si le brut ≤ emergencyAt dans les
 *   emergencyWithin premières barres, sortie immédiate (avant TP/SL/time-stop).
 * Même modèle de coûts que le canonique (validé par corrélation ≈ 1 sur V1).
 */
export function simulateScalpCustom(
  path: PricePoint[],
  entryIdx: number,
  costs: ExitCosts,
  opts: { timeStopBars: number; emergencyAt?: number; emergencyWithin?: number },
): { ret: number; grossRet: number; bars: number; exit: string; exitAt: string } {
  const entry = path[entryIdx];
  if (!entry || entry.price <= 0) throw new Error("entryIdx invalide");
  const entryPrice = entry.price;
  const finish = (j: number, exit: string) => {
    const p = path[j] as PricePoint;
    return {
      ret: netRet(entryPrice, p.price, costs, entry.liquidityUsd, p.liquidityUsd),
      grossRet: p.price / entryPrice - 1,
      bars: j - entryIdx,
      exit,
      exitAt: p.t,
    };
  };
  for (let j = entryIdx + 1; j < path.length; j++) {
    const p = path[j] as PricePoint;
    if (p.price <= 0) continue;
    const gross = p.price / entryPrice - 1;
    const barsIn = j - entryIdx;
    if (opts.emergencyAt !== undefined && opts.emergencyWithin !== undefined && barsIn <= opts.emergencyWithin && gross <= opts.emergencyAt) {
      return finish(j, "emergency");
    }
    if (gross <= -SCALP_PARAMS.stopLoss) return finish(j, "stop-loss");
    if (gross >= SCALP_PARAMS.takeProfit) return finish(j, "take-profit");
    if (barsIn >= opts.timeStopBars) return finish(j, "time-stop");
  }
  for (let j = path.length - 1; j > entryIdx; j--) {
    const p = path[j] as PricePoint;
    if (p.price > 0) return finish(j, "end-of-data");
  }
  throw new Error("aucune observation de sortie possible");
}

function excursions(path: PricePoint[], entryIdx: number): { mfe: number; mae: number } {
  const entryPrice = (path[entryIdx] as PricePoint).price;
  let mfe = 0;
  let mae = 0;
  for (let j = entryIdx + 1; j < path.length; j++) {
    const p = (path[j] as PricePoint).price;
    if (p <= 0) continue;
    const g = p / entryPrice - 1;
    if (g > mfe) mfe = g;
    if (g < mae) mae = g;
  }
  return { mfe, mae };
}

interface EntrySpec {
  signalIdx: number;
  entryIdx: number;
  chase: number | null;
}

function findEntryV1(series: TokenSnapshot[]): EntrySpec | null {
  const i = series.findIndex((s) => s.priceUsd > 0 && s.liquidityUsd >= MIN_LIQ);
  if (i === -1 || i + 2 >= series.length) return null;
  return { signalIdx: i, entryIdx: i + 1, chase: chaseAt(series, i) };
}

function findEntryChase(series: TokenSnapshot[], onlyCalm: boolean): EntrySpec | null {
  for (let i = 3; i < series.length - 1; i++) {
    const s = series[i] as TokenSnapshot;
    if (!(s.priceUsd > 0 && s.liquidityUsd >= MIN_LIQ)) continue;
    const c = chaseAt(series, i);
    if (onlyCalm && (c === null || c >= 0.5)) continue;
    return { signalIdx: i, entryIdx: i + 1, chase: c };
  }
  return null;
}

/**
 * Entrée momentum pur (H-REF-MOM) : première barre idx≥3 avec chase ≥ 0.5
 * (entrée « verticale » — MFE médian x1,25 vs x1,20 d'après H-CHASE).
 */
export function findEntryVertical(series: TokenSnapshot[]): EntrySpec | null {
  for (let i = 3; i < series.length - 1; i++) {
    const s = series[i] as TokenSnapshot;
    if (!(s.priceUsd > 0 && s.liquidityUsd >= MIN_LIQ)) continue;
    const c = chaseAt(series, i);
    if (c !== null && c >= 0.5) return { signalIdx: i, entryIdx: i + 1, chase: c };
  }
  return null;
}

function enrich(
  mint: string,
  series: TokenSnapshot[],
  spec: EntrySpec,
  exit: { ret: number; grossRet: number; bars: number; exit: string; exitAt: string },
  regimeByDay: Map<string, ChainRegimeName>,
): HTrade {
  const entry = series[spec.entryIdx] as TokenSnapshot;
  const path = toPricePoints(series);
  const { mfe, mae } = excursions(path, spec.entryIdx);
  const day = entry.fetchedAt.slice(0, 10);
  return {
    mint,
    entryAt: entry.fetchedAt,
    exitAt: exit.exitAt,
    entryDay: day,
    ret: exit.ret,
    grossRet: exit.grossRet,
    bars: exit.bars,
    exit: exit.exit,
    entryLiq: entry.liquidityUsd,
    chase: spec.chase,
    vertical: spec.chase !== null && spec.chase >= 0.5,
    regime: regimeByDay.get(day) ?? "inconnu",
    ageIdx: spec.signalIdx,
    mfe,
    mae,
  };
}

function canonicalTrade(
  mint: string,
  series: TokenSnapshot[],
  spec: EntrySpec,
  regime: "scalp" | "runner",
  costs: ExitCosts,
  regimeByDay: Map<string, ChainRegimeName>,
): HTrade | null {
  const path = toPricePoints(series);
  try {
    const plan = simulateExit(path, spec.entryIdx, regime, costs);
    const last = plan.fills[plan.fills.length - 1]!;
    return enrich(mint, series, spec, { ret: plan.blendedRet, grossRet: plan.blendedGross, bars: last.bars, exit: last.exit, exitAt: last.exitAt }, regimeByDay);
  } catch {
    return null; // série inexploitable (aucune sortie possible) — comme le harnais canonique
  }
}

export type VariantId = "V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8" | "V9" | "V10";

export const VARIANT_LABELS: Record<VariantId, string> = {
  V1: "scalp (H-EXIT)",
  V2: "runner (H-EXIT)",
  V3: "chase-A baseline (H-CHASE)",
  V4: "chase-B filtrée (H-CHASE)",
  V5: "entrée retardée t+2",
  V6: "scalp + sortie d'urgence −8 %/6b",
  V7: "scalp time-stop 3 barres",
  V8: "chase-A, verticales à demi-taille",
  V9: "scalp hors jours « frénésie »",
  V10: "momentum vertical filtré par régime (H-REF-MOM)",
};

export function buildVariants(
  seriesByMint: Map<string, TokenSnapshot[]>,
  regimeByDay: Map<string, ChainRegimeName>,
  costs: ExitCosts = COSTS,
): Record<VariantId, HTrade[]> {
  const out: Record<VariantId, HTrade[]> = { V1: [], V2: [], V3: [], V4: [], V5: [], V6: [], V7: [], V8: [], V9: [], V10: [] };
  for (const [mint, raw] of seriesByMint) {
    const series = sortedSeries(raw);

    // --- Entrée V1 (commune à V1, V2, V5, V6, V7, V9) ---
    const e1 = findEntryV1(series);
    if (e1) {
      const path = toPricePoints(series);
      const t1 = canonicalTrade(mint, series, e1, "scalp", costs, regimeByDay);
      if (t1) {
        out.V1.push(t1);
        // V9 : saute les jours de frénésie
        if (t1.regime !== "frénésie") out.V9.push(t1);
      }
      const t2 = canonicalTrade(mint, series, e1, "runner", costs, regimeByDay);
      if (t2) out.V2.push(t2);
      // V5 : entrée retardée d'une barre
      if (e1.entryIdx + 2 < series.length && (series[e1.entryIdx + 1] as TokenSnapshot).priceUsd > 0) {
        const spec5 = { signalIdx: e1.signalIdx, entryIdx: e1.entryIdx + 1, chase: chaseAt(series, e1.signalIdx) };
        const t5 = canonicalTrade(mint, series, spec5, "scalp", costs, regimeByDay);
        if (t5) out.V5.push(t5);
      }
      // V6 : sortie d'urgence −8 % dans les 6 premières barres
      try {
        out.V6.push(enrich(mint, series, e1, simulateScalpCustom(path, e1.entryIdx, costs, { timeStopBars: SCALP_PARAMS.timeStopBars, emergencyAt: -0.08, emergencyWithin: 6 }), regimeByDay));
      } catch { /* série inexploitable */ }
      // V7 : time-stop court (3 barres)
      try {
        out.V7.push(enrich(mint, series, e1, simulateScalpCustom(path, e1.entryIdx, costs, { timeStopBars: 3 }), regimeByDay));
      } catch { /* série inexploitable */ }
    }

    // --- Entrées chase (V3, V4, V8) ---
    const eA = findEntryChase(series, false);
    if (eA) {
      const t3 = canonicalTrade(mint, series, eA, "scalp", costs, regimeByDay);
      if (t3) {
        out.V3.push(t3);
        // V8 : verticales à demi-taille (ret × 0,5 — approximation : frais fixes non re-scalés)
        out.V8.push(t3.vertical ? { ...t3, ret: t3.ret * 0.5, grossRet: t3.grossRet * 0.5 } : t3);
      }
    }
    const eB = findEntryChase(series, true);
    if (eB) {
      const t4 = canonicalTrade(mint, series, eB, "scalp", costs, regimeByDay);
      if (t4) out.V4.push(t4);
    }

    // --- V10 H-REF-MOM : momentum vertical + filtre de régime + sorties scalp ---
    // Règle de filtre PRÉ-HOC (sémantique du module chainregime, pas fittée aux données) :
    // on exclut les régimes extrêmes — "famine" (marché mort) et "frénésie"
    // (bruit maximal, sélectivité requise d'après Cupsey). "inconnu" est tradé
    // (données de régime trop minces pour l'exclure — documenté comme limite).
    const eV = findEntryVertical(series);
    if (eV) {
      const t10 = canonicalTrade(mint, series, eV, "scalp", costs, regimeByDay);
      if (t10 && t10.regime !== "famine" && t10.regime !== "frénésie") out.V10.push(t10);
    }
  }
  return out;
}

export function loadRegimeByDay(scansDir: string): Map<string, ChainRegimeName> {
  const stats = loadDailyStatsFromScans(scansDir, "solana");
  const regimes = computeChainRegimes(stats);
  const map = new Map<string, ChainRegimeName>();
  for (const r of regimes) map.set(r.date, r.regime);
  return map;
}

// ---------------------------------------------------------------------------
// Métriques par variante
// ---------------------------------------------------------------------------

export interface VariantStats {
  id: VariantId;
  label: string;
  n: number;
  winRate: number | null;
  /** Espérance brute (NON robuste — dominée par les ticks aberrants, cf. red-team §3.1). */
  expectancy: number | null;
  expectancyCI: [number, number] | null;
  /** Espérance winsorisée au cap p99 poolé — MESURE PRIMAIRE. */
  expectancyW: number | null;
  expectancyWCI: [number, number] | null;
  trimmedMean5: number | null;
  medianRet: number | null;
  medianCI: [number, number] | null;
  stdRet: number | null;
  profitFactor: number | null;
  /** Drawdown max en unités de mise (courbe additive à taille fixe). */
  maxDrawdownUnits: number | null;
  finalEquityAdd: number | null;
  exits: Record<string, number>;
  /** Les 3 plus gros rendements (transparence sur les outliers). */
  topOutliers: number[];
  conclusive: boolean;
}

export function summarizeVariant(id: VariantId, trades: HTrade[], winsorCap?: number): VariantStats {
  const n = trades.length;
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.exit] = (exits[t.exit] ?? 0) + 1;
  const empty = {
    id, label: VARIANT_LABELS[id], n, winRate: null, expectancy: null, expectancyCI: null,
    expectancyW: null, expectancyWCI: null, trimmedMean5: null, medianRet: null, medianCI: null,
    stdRet: null, profitFactor: null, maxDrawdownUnits: null, finalEquityAdd: null,
    exits, topOutliers: [], conclusive: false,
  };
  if (n === 0) return empty;
  const rets = trades.map((t) => t.ret);
  const cap = winsorCap ?? Infinity;
  const retsW = winsorize(rets, cap);
  const wins = rets.filter((r) => r > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rets.filter((r) => r <= 0).reduce((a, b) => a + b, 0));
  // Courbe additive à taille de position fixe (1 unité par trade).
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of [...trades].sort((a, b) => a.entryAt.localeCompare(b.entryAt))) {
    eq += Math.max(-cap, Math.min(cap, t.ret));
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return {
    id,
    label: VARIANT_LABELS[id],
    n,
    winRate: wins.length / n,
    expectancy: mean(rets),
    expectancyCI: n >= 30 ? bootstrapMeanCI(rets) : null,
    expectancyW: mean(retsW),
    expectancyWCI: n >= 30 ? bootstrapMeanCI(retsW) : null,
    trimmedMean5: trimmedMean(rets),
    medianRet: median(rets),
    medianCI: n >= 30 ? bootstrapMedianCI(rets) : null,
    stdRet: std(rets),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null,
    maxDrawdownUnits: maxDd,
    finalEquityAdd: eq,
    exits,
    topOutliers: [...rets].sort((a, b) => b - a).slice(0, 3),
    conclusive: n >= MIN_TRADES_FOR_CONCLUSION,
  };
}

// ---------------------------------------------------------------------------
// Corrélations inter-stratégies (mêmes tokens)
// ---------------------------------------------------------------------------

export interface PairCorr {
  a: VariantId;
  b: VariantId;
  n: number;
  pearson: number;
  pearsonCI: [number, number] | null;
  spearman: number;
}

export function correlationMatrix(variants: Record<VariantId, HTrade[]>): PairCorr[] {
  const byMint = new Map<VariantId, Map<string, number>>();
  for (const id of Object.keys(variants) as VariantId[]) {
    const m = new Map<string, number>();
    for (const t of variants[id]) m.set(t.mint, t.ret);
    byMint.set(id, m);
  }
  const ids = Object.keys(variants) as VariantId[];
  const out: PairCorr[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i] as VariantId;
      const b = ids[j] as VariantId;
      const ma = byMint.get(a) as Map<string, number>;
      const mb = byMint.get(b) as Map<string, number>;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [mint, ra] of ma) {
        const rb = mb.get(mint);
        if (rb !== undefined) {
          xs.push(ra);
          ys.push(rb);
        }
      }
      out.push({
        a,
        b,
        n: xs.length,
        pearson: pearson(xs, ys),
        pearsonCI: xs.length >= 30 ? bootstrapCorrCI(xs, ys) : null,
        spearman: spearman(xs, ys),
      });
    }
  }
  return out;
}

/** P&L quotidien (somme des rets, taille unitaire) par variante. */
export function dailyPnl(trades: HTrade[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of trades) m.set(t.entryDay, (m.get(t.entryDay) ?? 0) + t.ret);
  return m;
}

export interface DailyCorr {
  a: VariantId;
  b: VariantId;
  n: number;
  pearson: number;
}

/** Corrélation des P&L quotidiens entre variantes (jours communs). */
export function dailyCorrelation(variants: Record<VariantId, HTrade[]>): DailyCorr[] {
  const dailies = new Map<VariantId, Map<string, number>>();
  for (const id of Object.keys(variants) as VariantId[]) dailies.set(id, dailyPnl(variants[id]));
  const ids = Object.keys(variants) as VariantId[];
  const out: DailyCorr[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i] as VariantId;
      const b = ids[j] as VariantId;
      const da = dailies.get(a) as Map<string, number>;
      const db = dailies.get(b) as Map<string, number>;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [day, va] of da) {
        const vb = db.get(day);
        if (vb !== undefined) {
          xs.push(va);
          ys.push(vb);
        }
      }
      out.push({ a, b, n: xs.length, pearson: pearson(xs, ys) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// « Quand la principale souffre » — la variante X amortit-elle les pertes de V1 ?
// ---------------------------------------------------------------------------

export interface MainPainReport {
  other: VariantId;
  /** Jours où V1 perd : P&L quotidien moyen de X ces jours-là vs en moyenne. */
  v1LossDays: number;
  xMeanOnV1LossDays: number | null;
  xMeanOverallDaily: number | null;
  /** Quartile des pires jours V1 : P&L moyen de X. */
  v1WorstQuartileDays: number;
  xMeanOnV1WorstQuartile: number | null;
  /** Tokens où V1 perd : rendement moyen WINSORISÉ de X sur ces tokens (mêmes tokens). */
  commonLosingMints: number;
  xMeanWOnV1LosingMints: number | null;
  xMedianOnV1LosingMints: number | null;
  xMeanWOnCommonMints: number | null;
}

export function mainPainAnalysis(main: HTrade[], other: HTrade[], otherId: VariantId, winsorCap = Infinity): MainPainReport {
  const dm = dailyPnl(main);
  const dx = dailyPnl(other);
  const lossDays: string[] = [];
  for (const [day, v] of dm) if (v < 0 && dx.has(day)) lossDays.push(day);
  const xOnLoss = lossDays.map((d) => dx.get(d) as number);
  const allXDaily = [...dx.values()];
  const sorted = [...dm.entries()].filter(([d]) => dx.has(d)).sort((a, b) => a[1] - b[1]);
  const q = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 4)));
  const xOnWorst = q.map(([d]) => dx.get(d) as number);
  // Mêmes tokens : X sur les mints où V1 a perdu.
  const mMain = new Map(main.map((t) => [t.mint, t.ret]));
  const mOther = new Map(other.map((t) => [t.mint, t.ret]));
  const losingMints: string[] = [];
  const commonMints: string[] = [];
  for (const [mint, r] of mMain) {
    const ro = mOther.get(mint);
    if (ro === undefined) continue;
    commonMints.push(mint);
    if (r < 0) losingMints.push(mint);
  }
  const xOnLosing = winsorize(losingMints.map((m) => mOther.get(m) as number), winsorCap);
  const xOnLosingRaw = losingMints.map((m) => mOther.get(m) as number);
  const xOnCommon = winsorize(commonMints.map((m) => mOther.get(m) as number), winsorCap);
  return {
    other: otherId,
    v1LossDays: lossDays.length,
    xMeanOnV1LossDays: xOnLoss.length ? mean(xOnLoss) : null,
    xMeanOverallDaily: allXDaily.length ? mean(allXDaily) : null,
    v1WorstQuartileDays: q.length,
    xMeanOnV1WorstQuartile: xOnWorst.length ? mean(xOnWorst) : null,
    commonLosingMints: losingMints.length,
    xMeanWOnV1LosingMints: xOnLosing.length ? mean(xOnLosing) : null,
    xMedianOnV1LosingMints: xOnLosingRaw.length ? median(xOnLosingRaw) : null,
    xMeanWOnCommonMints: xOnCommon.length ? mean(xOnCommon) : null,
  };
}

// ---------------------------------------------------------------------------
// Carte des facteurs de risque — buckets où TOUTES les variantes perdent
// ---------------------------------------------------------------------------

export type BucketDim = "regime" | "liqQ" | "chaseB" | "ageB";

export function bucketOf(t: HTrade, dim: BucketDim, liqQuartiles: number[]): string {
  switch (dim) {
    case "regime":
      return t.regime;
    case "liqQ": {
      const q = liqQuartiles;
      if (t.entryLiq <= (q[0] as number)) return "liq-Q1";
      if (t.entryLiq <= (q[1] as number)) return "liq-Q2";
      if (t.entryLiq <= (q[2] as number)) return "liq-Q3";
      return "liq-Q4";
    }
    case "chaseB":
      if (t.chase === null) return "chase-inconnu";
      if (t.chase >= 0.5) return "chase-vertical";
      if (t.chase >= 0.2) return "chase-élevé";
      return "chase-calme";
    case "ageB":
      if (t.ageIdx <= 5) return "age-jeune";
      if (t.ageIdx <= 15) return "age-moyen";
      return "age-vieux";
  }
}

export interface BucketCell {
  variant: VariantId;
  bucket: string;
  n: number;
  meanRet: number | null;
  medianRet: number | null;
  winRate: number | null;
}

/** Pour chaque bucket : n, rendement moyen, win rate par variante. */
export function riskFactorMap(
  variants: Record<VariantId, HTrade[]>,
  dims: BucketDim[],
  variantIds: VariantId[],
): { cells: BucketCell[]; liqQuartiles: number[] } {
  const pooled = variantIds.flatMap((id) => variants[id]);
  const liqs = pooled.map((t) => t.entryLiq).sort((a, b) => a - b);
  const liqQuartiles = [quantile(liqs, 0.25), quantile(liqs, 0.5), quantile(liqs, 0.75)];
  const cells: BucketCell[] = [];
  for (const dim of dims) {
    const buckets = new Set<string>();
    for (const id of variantIds) for (const t of variants[id]) buckets.add(bucketOf(t, dim, liqQuartiles));
    for (const b of [...buckets].sort()) {
      for (const id of variantIds) {
        const ts = variants[id].filter((t) => bucketOf(t, dim, liqQuartiles) === b);
        cells.push({
          variant: id,
          bucket: b,
          n: ts.length,
          meanRet: ts.length ? mean(ts.map((t) => t.ret)) : null,
          medianRet: ts.length ? median(ts.map((t) => t.ret)) : null,
          winRate: ts.length ? ts.filter((t) => t.ret > 0).length / ts.length : null,
        });
      }
    }
  }
  return { cells, liqQuartiles };
}

/** Buckets où TOUTES les variantes (n≥30) ont une MÉDIANE < 0.
 * On utilise la médiane (robuste aux ticks aberrants), pas la moyenne brute :
 * ne jamais conclure à partir des moyennes brutes. */
export function commonLossBuckets(cells: BucketCell[], variantIds: VariantId[]): string[] {
  const byBucket = new Map<string, BucketCell[]>();
  for (const c of cells) {
    const arr = byBucket.get(c.bucket) ?? [];
    arr.push(c);
    byBucket.set(c.bucket, arr);
  }
  const out: string[] = [];
  for (const [bucket, arr] of byBucket) {
    const rel = variantIds.map((id) => arr.find((c) => c.variant === id)).filter((c) => c && c.n >= 30);
    if (rel.length === variantIds.length && rel.every((c) => (c as BucketCell).medianRet !== null && ((c as BucketCell).medianRet as number) < 0)) {
      out.push(bucket);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Évaluation des hedges candidats
// ---------------------------------------------------------------------------

export interface HedgeEval {
  id: string;
  label: string;
  base: VariantId;
  hedged: VariantId;
  paired: boolean;
  nBase: number;
  nHedged: number;
  /** Mesures PRIMAIRES (robustes) : espérance winsorisée + médiane. */
  expectancyWBase: number | null;
  expectancyWHedged: number | null;
  diffWCI: [number, number] | null;
  diffWPoint: number | null;
  medianBase: number | null;
  medianHedged: number | null;
  diffMedianCI: [number, number] | null;
  diffMedianPoint: number | null;
  winRateBase: number | null;
  winRateHedged: number | null;
  maxDdBase: number | null;
  maxDdHedged: number | null;
  /** Coût du hedge = espérance winsorisée sacrifiée (positif = le hedge coûte). */
  hedgeCostW: number | null;
  note: string;
}

function unpairedDiffCI(xs: number[], ys: number[], B = 2000, seed = 99): [number, number] {
  const rnd = mulberry32(seed);
  const ds: number[] = [];
  for (let b = 0; b < B; b++) {
    let sx = 0;
    for (let i = 0; i < xs.length; i++) sx += xs[Math.floor(rnd() * xs.length)] as number;
    let sy = 0;
    for (let i = 0; i < ys.length; i++) sy += ys[Math.floor(rnd() * ys.length)] as number;
    ds.push(sy / ys.length - sx / xs.length);
  }
  return [quantile(ds, 0.025), quantile(ds, 0.975)];
}

export function evalHedge(
  id: string,
  label: string,
  base: HTrade[],
  hedged: HTrade[],
  baseId: VariantId,
  hedgedId: VariantId,
  winsorCap: number,
  note: string,
): HedgeEval {
  const sb = summarizeVariant(baseId, base, winsorCap);
  const sh = summarizeVariant(hedgedId, hedged, winsorCap);
  // Appariement par mint quand les deux variantes partagent les mêmes entrées.
  const mb = new Map(base.map((t) => [t.mint, t.ret]));
  const mh = new Map(hedged.map((t) => [t.mint, t.ret]));
  const common = [...mb.keys()].filter((m) => mh.has(m));
  const paired = common.length >= 30 && common.length === base.length && common.length === hedged.length;
  let diffWCI: [number, number] | null = null;
  let diffWPoint: number | null = null;
  let diffMedianCI: [number, number] | null = null;
  let diffMedianPoint: number | null = null;
  if (sb.expectancyW !== null && sh.expectancyW !== null) {
    diffWPoint = sh.expectancyW - sb.expectancyW;
    if (paired) {
      const xb = winsorize(common.map((m) => mb.get(m) as number), winsorCap);
      const xh = winsorize(common.map((m) => mh.get(m) as number), winsorCap);
      diffWCI = bootstrapPairedDiffCI(xb, xh);
      diffMedianCI = bootstrapPairedMedianDiffCI(
        common.map((m) => mb.get(m) as number),
        common.map((m) => mh.get(m) as number),
      );
      diffMedianPoint = (sh.medianRet as number) - (sb.medianRet as number);
    } else if (base.length >= 30 && hedged.length >= 30) {
      diffWCI = unpairedDiffCI(
        winsorize(base.map((t) => t.ret), winsorCap),
        winsorize(hedged.map((t) => t.ret), winsorCap),
      );
    }
  }
  return {
    id,
    label,
    base: baseId,
    hedged: hedgedId,
    paired,
    nBase: base.length,
    nHedged: hedged.length,
    expectancyWBase: sb.expectancyW,
    expectancyWHedged: sh.expectancyW,
    diffWCI,
    diffWPoint,
    medianBase: sb.medianRet,
    medianHedged: sh.medianRet,
    diffMedianCI,
    diffMedianPoint,
    winRateBase: sb.winRate,
    winRateHedged: sh.winRate,
    maxDdBase: sb.maxDrawdownUnits,
    maxDdHedged: sh.maxDrawdownUnits,
    hedgeCostW: diffWPoint === null ? null : -diffWPoint,
    note,
  };
}

/** Portefeuille 50/50 de deux variantes sur leurs mints communs. */
export function blendPortfolio(a: HTrade[], b: HTrade[]): HTrade[] {
  const mb = new Map(a.map((t) => [t.mint, t]));
  const out: HTrade[] = [];
  for (const t of b) {
    const ta = mb.get(t.mint);
    if (!ta) continue;
    out.push({ ...t, ret: (ta.ret + t.ret) / 2, grossRet: (ta.grossRet + t.grossRet) / 2, exit: `${ta.exit}+${t.exit}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Programme principal
// ---------------------------------------------------------------------------

export interface HedgeAnalysisResult {
  computedAt: string;
  dataBiasNote: string;
  tokens: number;
  observations: number;
  regimeDays: Record<string, number>;
  variants: VariantStats[];
  corrMatrix: PairCorr[];
  dailyCorr: DailyCorr[];
  mainPain: MainPainReport[];
  riskCells: BucketCell[];
  commonLossBuckets: string[];
  hedges: HedgeEval[];
  /** % de gagnants V1 que la sortie d'urgence aurait coupés (mêmes mints). */
  emergencyCutWinnersPct: number | null;
  emergencyExitCount: number;
  /** Sensibilité aux frais : espérance V1 selon barème. */
  feeSensitivity: { fees: number; slipCap: number; n: number; expectancy: number | null; expectancyW: number | null; median: number | null }[];
  winsorCap: number;
  /** Validation : simu custom sans urgence vs canonique V1 (doit être ≈ 1). */
  customSimValidation: { pearson: number; meanAbsDiff: number; n: number };
  portfolio5050: VariantStats;
}

export function runHedgeAnalysis(rootDir: string): HedgeAnalysisResult {
  const seriesByMint = loadHistoryDir(join(rootDir, "data", "history"));
  const regimeByDay = loadRegimeByDay(join(rootDir, "data", "scans"));
  const variants = buildVariants(seriesByMint, regimeByDay);
  const ids = Object.keys(variants) as VariantId[];
  const regimeDays: Record<string, number> = {};
  for (const r of regimeByDay.values()) regimeDays[r] = (regimeDays[r] ?? 0) + 1;
  let observations = 0;
  for (const s of seriesByMint.values()) observations += s.length;

  // Validation de la simu custom : sans urgence, time-stop 6 = canonique ?
  const vCustomCheck: number[] = [];
  const vCanonCheck: number[] = [];
  for (const [mint, raw] of seriesByMint) {
    const series = sortedSeries(raw);
    const e1 = findEntryV1(series);
    if (!e1) continue;
    const path = toPricePoints(series);
    const custom = simulateScalpCustom(path, e1.entryIdx, COSTS, { timeStopBars: SCALP_PARAMS.timeStopBars });
    const canon = simulateExit(path, e1.entryIdx, "scalp", COSTS);
    vCustomCheck.push(custom.ret);
    vCanonCheck.push(canon.blendedRet);
    if (vCustomCheck.length >= 400) break;
  }
  const customSimValidation = {
    pearson: pearson(vCanonCheck, vCustomCheck),
    meanAbsDiff: mean(vCanonCheck.map((c, i) => Math.abs(c - (vCustomCheck[i] as number)))),
    n: vCustomCheck.length,
  };

  // Cap de winsorisation : p99 des rendements poolés (toutes variantes) — calculé UNE fois.
  const pooledRets = ids.flatMap((id) => variants[id].map((t) => t.ret)).sort((a, b) => a - b);
  const winsorCap = quantile(pooledRets, 0.99);
  const variantStats = ids.map((id) => summarizeVariant(id, variants[id], winsorCap));
  const corrMatrix = correlationMatrix(variants);
  const dailyCorr = dailyCorrelation(variants);
  const mainPain = (["V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10"] as VariantId[]).map((id) =>
    mainPainAnalysis(variants.V1, variants[id], id, winsorCap),
  );

  const { cells } = riskFactorMap(variants, ["regime", "liqQ", "chaseB", "ageB"], ["V1", "V2", "V3", "V4"]);
  const commonLoss = commonLossBuckets(cells, ["V1", "V2", "V3", "V4"]);

  const hedges: HedgeEval[] = [
    evalHedge("H-HEDGE-1", "Sortie d'urgence −8 % / 6 barres ajoutée au scalp", variants.V1, variants.V6, "V1", "V6", winsorCap,
      "Mécanisme : couper la queue gauche tôt. Risque : couper des gagnants qui dipent puis repartent."),
    evalHedge("H-HEDGE-2", "Time-stop court (3 barres) vs 6 barres", variants.V1, variants.V7, "V1", "V7", winsorCap,
      "Hedge d'horizon : rester moins longtemps en position réduit l'exposition au drift négatif."),
    evalHedge("H-HEDGE-3", "Entrées verticales à demi-taille (vs plein)", variants.V3, variants.V8, "V3", "V8", winsorCap,
      "Le twist H-CHASE : les verticales ont un meilleur MFE — la demi-taille garde l'exposition tout en bornant le risque."),
    evalHedge("H-HEDGE-5", "Sauter les entrées les jours de « frénésie »", variants.V1, variants.V9, "V1", "V9", winsorCap,
      "Hedge de régime : en frénésie le bruit est maximal (red-team §1.8). Coût = trades manqués."),
  ];

  // H-HEDGE-4 : portefeuille 50/50 scalp+runner — le test « une stratégie déguisée en deux ».
  const pf = blendPortfolio(variants.V1, variants.V2);
  const portfolio5050 = summarizeVariant("V1", pf, winsorCap);
  portfolio5050.label = "portefeuille 50/50 scalp+runner";
  portfolio5050.id = "V1";

  // % de gagnants V1 coupés par l'urgence.
  const mV1 = new Map(variants.V1.map((t) => [t.mint, t]));
  let cut = 0;
  let winners = 0;
  let emergCount = 0;
  for (const t6 of variants.V6) {
    if (t6.exit === "emergency") emergCount++;
    const t1 = mV1.get(t6.mint);
    if (!t1) continue;
    if (t1.ret > 0) {
      winners++;
      if (t6.exit === "emergency") cut++;
    }
  }
  const emergencyCutWinnersPct = winners ? cut / winners : null;

  // Sensibilité aux frais (V1 re-simulé).
  const feeSensitivity: HedgeAnalysisResult["feeSensitivity"] = [];
  for (const fees of [0.013, 0.03, 0.05]) {
    for (const slipCap of [0.03, 0.06]) {
      const v = buildVariants(seriesByMint, regimeByDay, { sizeUsd: 50, feesRoundTrip: fees, maxSlippage: slipCap });
      const s = summarizeVariant("V1", v.V1, winsorCap);
      feeSensitivity.push({ fees, slipCap, n: s.n, expectancy: s.expectancy, expectancyW: s.expectancyW, median: s.medianRet });
    }
  }

  return {
    computedAt: new Date().toISOString(),
    dataBiasNote:
      "DONNÉES data/history/ BIAISÉES vers les tokens chauds suivis : toute mesure P&L ci-dessous est une BORNE OPTIMISTE. " +
      "Phase DÉCOUVERTE uniquement — aucun seuil cherché ici ne sera utilisé sans validation sur données propres (holdout data/track-unbiased/, 30 j).",
    tokens: seriesByMint.size,
    observations,
    regimeDays,
    variants: variantStats,
    corrMatrix,
    dailyCorr,
    mainPain,
    riskCells: cells,
    commonLossBuckets: commonLoss,
    hedges,
    emergencyCutWinnersPct,
    emergencyExitCount: emergCount,
    feeSensitivity,
    customSimValidation,
    winsorCap,
    portfolio5050,
  };
}

function printSummary(r: HedgeAnalysisResult): void {
  console.log("=== ANALYSE HEDGE (DÉCOUVERTE — borne optimiste, données biaisées) ===");
  console.log(`Tokens : ${r.tokens}, observations : ${r.observations}`);
  console.log(`Validation simu custom vs canonique : r=${r.customSimValidation.pearson.toFixed(4)}, écart abs moyen=${(r.customSimValidation.meanAbsDiff * 100).toFixed(4)} % (n=${r.customSimValidation.n})`);
  console.log(`Cap de winsorisation (p99 poolé) : ${(r.winsorCap * 100).toFixed(1)} %`);
  console.log("\n--- Variantes (mesures PRIMAIRES = winsorisées / médianes) ---");
  for (const v of r.variants) {
    const ci = v.expectancyWCI ? ` IC95[${fmtP(v.expectancyWCI[0])}, ${fmtP(v.expectancyWCI[1])}]` : "";
    const mci = v.medianCI ? ` IC95[${fmtP(v.medianCI[0])}, ${fmtP(v.medianCI[1])}]` : "";
    console.log(`${v.id} ${v.label} : n=${v.n}${v.conclusive ? "" : " (NON CONCLUANT)"}`);
    console.log(`    esp. winsorisée ${fmtP(v.expectancyW)}${ci} | trim5 ${fmtP(v.trimmedMean5)} | médiane ${fmtP(v.medianRet)}${mci} | win ${fmtP(v.winRate)} | PF(brut) ${fmt2(v.profitFactor)} | DD ${v.maxDrawdownUnits === null ? "n/a" : v.maxDrawdownUnits.toFixed(2) + "×mise"}`);
    console.log(`    esp. BRUTE (biaisée par outliers) ${fmtP(v.expectancy)} | top outliers ${v.topOutliers.map((x) => (x * 100).toFixed(0) + "%").join(", ")}`);
  }
  console.log("\n--- Corrélations des rendements par trade (mêmes tokens) ---");
  for (const c of r.corrMatrix) {
    const ci = c.pearsonCI ? ` IC95[${c.pearsonCI[0].toFixed(2)}, ${c.pearsonCI[1].toFixed(2)}]` : "";
    console.log(`${c.a}×${c.b} : n=${c.n} r=${c.pearson.toFixed(3)}${ci} ρ=${c.spearman.toFixed(3)}`);
  }
  console.log("\n--- Hedges candidats (Δ hedé − base, mesures robustes) ---");
  for (const h of r.hedges) {
    const ci = h.diffWCI ? ` IC95[${fmtP(h.diffWCI[0])}, ${fmtP(h.diffWCI[1])}]` : " (n<30, pas d'IC)";
    const mci = h.diffMedianCI ? ` Δmédiane=${fmtP(h.diffMedianPoint)} IC95[${fmtP(h.diffMedianCI[0])}, ${fmtP(h.diffMedianCI[1])}]` : "";
    console.log(`${h.id} ${h.label} : Δesp.W=${fmtP(h.diffWPoint)}${ci}${mci} | coût=${fmtP(h.hedgeCostW)} | DD ${h.maxDdBase === null ? "n/a" : h.maxDdBase.toFixed(2)}→${h.maxDdHedged === null ? "n/a" : h.maxDdHedged.toFixed(2)}×mise | win ${fmtP(h.winRateBase)}→${fmtP(h.winRateHedged)} | n ${h.nBase}→${h.nHedged}${h.paired ? " (apparié)" : ""}`);
  }
  console.log(`\nSortie d'urgence : ${r.emergencyExitCount} déclenchements, ${r.emergencyCutWinnersPct === null ? "n/a" : (r.emergencyCutWinnersPct * 100).toFixed(1) + " %"} des gagnants V1 coupés`);
  console.log(`Portefeuille 50/50 : n=${r.portfolio5050.n} esp.W ${fmtP(r.portfolio5050.expectancyW)} médiane ${fmtP(r.portfolio5050.medianRet)} DD ${r.portfolio5050.maxDrawdownUnits === null ? "n/a" : r.portfolio5050.maxDrawdownUnits.toFixed(2) + "×mise"}`);
  console.log("\n--- Buckets où TOUTES les variantes perdent (n≥30) ---");
  console.log(r.commonLossBuckets.length ? r.commonLossBuckets.join(", ") : "(aucun)");
  console.log("\n--- Sensibilité aux frais (V1) ---");
  for (const f of r.feeSensitivity) {
    console.log(`frais ${(f.fees * 100).toFixed(1)} % / slipCap ${(f.slipCap * 100).toFixed(0)} % : esp.W ${fmtP(f.expectancyW)} médiane ${fmtP(f.median)} (brute ${fmtP(f.expectancy)}, n=${f.n})`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const result = runHedgeAnalysis(rootDir);
  printSummary(result);
  console.log("\n--- JSON complet ---");
  console.log(JSON.stringify(result, null, 2));
}
