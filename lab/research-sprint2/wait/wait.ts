/**
 * SPRINT 2B — Famille L (WAIT) : ne pas supposer que t0 est optimal.
 *
 * Question : existe-t-il un délai d'attente Δ après t0 tel que
 * INFORMATION_GAIN(Δ) > ENTRY_DELAY_COST(Δ) ?
 *
 * - INFORMATION_GAIN(Δ) : pouvoir prédictif des features observables
 *   pendant la fenêtre d'attente (t0, t0+Δ] — direction du prix (log),
 *   Δ liquidité (log) — sur les rendements futurs mesurés DEPUIS l'entrée
 *   (pas de chevauchement feature/label). Mesuré en unités de rendement
 *   (spread top−bottom tercile de dirPrice sur Y@1h depuis l'entrée) et
 *   en corrélation de rang (Spearman).
 * - ENTRY_DELAY_COST(Δ) : rendement « perdu » en attendant =
 *   ret(t0 → t0+H) − ret(entrée → entrée+H), médiane sur les tokens.
 *
 * Contrainte de données (constatée, pas supposée) : le collecteur
 * DexScreener émet ~1 tick / 14 min (médiane). Δ ∈ {30s, 60s, 120s} →
 * couverture 0 : AUCUNE information observable. On mesure donc aussi
 * Δ ∈ {15, 30, 60, 120 min} (cadence supportée par les données).
 *
 * RÈGLES ANTI-OVERFITTING :
 * - DISCOVERY uniquement (hash < 50). Holdout JAMAIS lu.
 * - Mint SKHY (glitch DexScreener) exclu.
 * - features : feature_timestamp ≤ t0+Δ strict (ticks t ≤ t0+Δ uniquement).
 *   Le prix d'entrée = premier tick ≥ t0+Δ (prix réellement payé en
 *   attendant) — observé possiblement APRÈS t0+Δ (données clairsemées) :
 *   utilisé UNIQUEMENT pour le coût réalisé, documenté.
 * - Labels mesurés depuis l'entrée (t0+Δ) : aucun chevauchement avec
 *   la fenêtre de features.
 * - Données biaisées tokens chauds → borne OPTIMISTE, déclarée.
 * - AUCUNE stratégie construite : mesure d'information uniquement.
 * - Lecture seule sur data/.
 */
import type { TokenSnapshot } from "../../types.ts";
import {
  aberrantMask,
  findT0,
  bootstrapCI,
  spearman,
} from "../../predictive/universe.ts";
import { spearmanP } from "../../research-sprint1/common.ts";
import { permutationP } from "../actors/statsx.ts";
import { permutationP2Groups, median, bootstrapMedianDiffCI } from "../s2b-stats.ts";

export const SKHY_MINT = "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3";

export interface CleanSeries {
  s: TokenSnapshot[];
  mask: boolean[];
  t0: number;
  t0ms: number;
  t0price: number;
}

/** Série triée + masque aberrant + t0. null si pas de t0. */
export function cleanSeries(series: TokenSnapshot[]): CleanSeries | null {
  const s = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0 = findT0(s);
  if (t0 < 0) return null;
  const t0ms = Date.parse(s[t0]!.fetchedAt);
  const t0price = s[t0]!.priceUsd;
  if (!(t0price > 0)) return null;
  return { s, mask: aberrantMask(s), t0, t0ms, t0price };
}

/** Premier tick valide (prix > 0, non aberrant) à t >= atMs. */
export function firstValidAtOrAfter(
  cs: CleanSeries,
  atMs: number,
): { idx: number; ms: number; price: number } | null {
  for (let i = 0; i < cs.s.length; i++) {
    if (cs.mask[i]) continue;
    const p = cs.s[i]!.priceUsd;
    if (!(p > 0)) continue;
    const t = Date.parse(cs.s[i]!.fetchedAt);
    if (t >= atMs) return { idx: i, ms: t, price: p };
  }
  return null;
}

export interface WaitFeatures {
  mint: string;
  t0ms: number;
  deltaMs: number;
  /** Ticks valides strictement dans (t0, t0+Δ]. */
  nTicksWindow: number;
  /** log(p_dernier_≤D / p_t0), null si aucun tick dans la fenêtre. */
  dirPrice: number | null;
  /** log(liq_dernière_≤D / liq_t0), null si non calculable. */
  dLiq: number | null;
  /** Entrée = premier tick valide ≥ t0+Δ (prix réellement payé). */
  entryMs: number | null;
  entryPrice: number | null;
}

/**
 * Features d'attente. Seuls des ticks de timestamp ≤ t0+Δ sont utilisés
 * (feature_timestamp ≤ t0+Δ). Le prix d'entrée (≥ t0+Δ) sert au coût réalisé.
 */
export function waitFeatures(
  mint: string,
  cs: CleanSeries,
  deltaMs: number,
): WaitFeatures {
  const D = cs.t0ms + deltaMs;
  let last: TokenSnapshot | null = null;
  let n = 0;
  for (let i = cs.t0 + 1; i < cs.s.length; i++) {
    const t = Date.parse(cs.s[i]!.fetchedAt);
    if (t <= cs.t0ms || t > D) continue;
    if (cs.mask[i]) continue;
    if (!(cs.s[i]!.priceUsd > 0)) continue;
    n++;
    last = cs.s[i]!;
  }
  const entry = firstValidAtOrAfter(cs, D);
  const liq0 = cs.s[cs.t0]!.liquidityUsd;
  return {
    mint,
    t0ms: cs.t0ms,
    deltaMs,
    nTicksWindow: n,
    dirPrice:
      last != null && last.priceUsd > 0
        ? Math.log(last.priceUsd / cs.t0price)
        : null,
    dLiq:
      last != null && last.liquidityUsd > 0 && liq0 > 0
        ? Math.log(last.liquidityUsd / liq0)
        : null,
    entryMs: entry?.ms ?? null,
    entryPrice: entry?.price ?? null,
  };
}

export interface ReturnFrom {
  ret: number;
  entryPrice: number;
  exitPrice: number;
}

/**
 * Rendement depuis entryMs sur horizonMs : entrée = premier tick valide
 * ≥ entryMs, sortie = premier tick valide ≥ entryMs + horizonMs.
 * null si l'horizon n'est pas couvert (pas d'extrapolation).
 */
export function returnFrom(
  cs: CleanSeries,
  entryMs: number,
  horizonMs: number,
): ReturnFrom | null {
  const entry = firstValidAtOrAfter(cs, entryMs);
  if (!entry) return null;
  const exit = firstValidAtOrAfter(cs, entryMs + horizonMs);
  if (!exit) return null;
  return {
    ret: exit.price / entry.price - 1,
    entryPrice: entry.price,
    exitPrice: exit.price,
  };
}

export interface SurvivalFrom {
  durationH: number;
  event: boolean;
}

/**
 * Survie depuis entryMs : premier tick valide avec prix/entryPrice − 1 ≤ −0.5
 * → événement ; sinon censure au min(24h, dernier tick). ≥ 3 ticks post-entrée
 * exigés (même garde que labels.ts) : null sinon.
 */
export function survivalFrom(
  cs: CleanSeries,
  entryMs: number,
  horizonMs = 24 * 3_600_000,
): SurvivalFrom | null {
  const entry = firstValidAtOrAfter(cs, entryMs);
  if (!entry) return null;
  let nTicks = 0;
  let lastH = 0;
  for (let i = 0; i < cs.s.length; i++) {
    const t = Date.parse(cs.s[i]!.fetchedAt);
    if (t <= entryMs || t > entryMs + horizonMs) continue;
    if (cs.mask[i]) continue;
    const p = cs.s[i]!.priceUsd;
    if (!(p > 0)) continue;
    nTicks++;
    const h = (t - entryMs) / 3_600_000;
    lastH = Math.max(lastH, h);
    if (p / entry.price - 1 <= -0.5) return { durationH: h, event: true };
  }
  if (nTicks < 3 || lastH <= 0) return null;
  return { durationH: Math.min(lastH, horizonMs / 3_600_000), event: false };
}

/**
 * Drawdown max depuis entryMs sur horizonMs (ticks valides, non aberrants).
 * null si < 3 ticks (même garde que labels.ts).
 */
export function ddMaxFrom(
  cs: CleanSeries,
  entryMs: number,
  horizonMs = 24 * 3_600_000,
): number | null {
  const entry = firstValidAtOrAfter(cs, entryMs);
  if (!entry) return null;
  const rets: number[] = [];
  for (let i = 0; i < cs.s.length; i++) {
    const t = Date.parse(cs.s[i]!.fetchedAt);
    if (t <= entryMs || t > entryMs + horizonMs) continue;
    if (cs.mask[i]) continue;
    const p = cs.s[i]!.priceUsd;
    if (!(p > 0)) continue;
    rets.push(p / entry.price - 1);
  }
  return rets.length >= 3 ? Math.min(...rets) : null;
}

export interface WaitRow {
  mint: string;
  dexId: string | null;
  t0day: string;
  dirPrice: number;
  dLiq: number | null;
  entryMs: number;
  y1hEntry: number | null;
  y6hEntry: number | null;
  survEvent: boolean | null;
  ddMaxEntry: number | null;
  /** ret(t0 → t0+1h) − ret(entrée → entrée+1h) : le coût du délai. */
  cost1h: number | null;
  cost6h: number | null;
}

/** Construit une ligne d'analyse pour un token et un Δ (null si inutilisable). */
export function waitRow(
  mint: string,
  series: TokenSnapshot[],
  deltaMs: number,
): WaitRow | null {
  const cs = cleanSeries(series);
  if (!cs) return null;
  const wf = waitFeatures(mint, cs, deltaMs);
  if (wf.dirPrice == null || wf.entryMs == null || wf.entryPrice == null)
    return null;
  const y1 = returnFrom(cs, wf.entryMs, 3_600_000);
  const y6 = returnFrom(cs, wf.entryMs, 6 * 3_600_000);
  const surv = survivalFrom(cs, wf.entryMs);
  const dd = ddMaxFrom(cs, wf.entryMs);
  // Coût du délai : même horizon H, entrée t0 vs entrée t0+Δ.
  const r0_1h = returnFrom(cs, cs.t0ms, 3_600_000);
  const rD_1h = returnFrom(cs, wf.entryMs, 3_600_000);
  const r0_6h = returnFrom(cs, cs.t0ms, 6 * 3_600_000);
  const rD_6h = returnFrom(cs, wf.entryMs, 6 * 3_600_000);
  const snap = cs.s[cs.t0]!;
  return {
    mint,
    dexId: (snap as { dexId?: string | null }).dexId ?? null,
    t0day: new Date(cs.t0ms).toISOString().slice(0, 10),
    dirPrice: wf.dirPrice,
    dLiq: wf.dLiq,
    entryMs: wf.entryMs,
    y1hEntry: y1?.ret ?? null,
    y6hEntry: y6?.ret ?? null,
    survEvent: surv?.event ?? null,
    ddMaxEntry: dd,
    cost1h: r0_1h && rD_1h ? r0_1h.ret - rD_1h.ret : null,
    cost6h: r0_6h && rD_6h ? r0_6h.ret - rD_6h.ret : null,
  };
}

/* ------------------------------------------------------------------ */
/* Agrégats par Δ                                                      */
/* ------------------------------------------------------------------ */

export interface TercileSpread {
  n: number;
  meanBottom: number | null;
  meanTop: number | null;
  spread: number | null;
  /** p bilatérale par permutation (H0 : le spread est du bruit). */
  pPerm: number | null;
}

function tercileSpread(
  xs: number[],
  ys: number[],
  reps = 2000,
): TercileSpread {
  const n = xs.length;
  if (n < 30) return { n, meanBottom: null, meanTop: null, spread: null, pPerm: null };
  const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const t1 = Math.floor(n / 3);
  const t2 = Math.floor((2 * n) / 3);
  const bottom = order.slice(0, t1).map((i) => ys[i]!);
  const top = order.slice(t2).map((i) => ys[i]!);
  const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const mb = m(bottom);
  const mt = m(top);
  const spread = mt - mb;
  const { p } = permutationP2Groups(
    bottom,
    top,
    (x, y) => m(x) - m(y),
    reps,
    1234,
  );
  return { n, meanBottom: mb, meanTop: mt, spread, pPerm: p };
}

export interface WaitDeltaStats {
  deltaMs: number;
  nWindow: number;
  nRows: number;
  nY1: number;
  nY6: number;
  nSurv: number;
  cost1h: { n: number; median: number | null; mean: number | null; ci: [number, number] | null };
  cost6h: { n: number; median: number | null; mean: number | null; ci: [number, number] | null };
  spearmanDirY1: { n: number; rho: number | null; p: number };
  spearmanDirY6: { n: number; rho: number | null; p: number };
  spearmanLiqY1: { n: number; rho: number | null; p: number };
  spreadY1: TercileSpread;
  spreadY1Winsor: TercileSpread;
  survRateByTercile: { n: number; bottom: number | null; top: number | null; diff: number | null; pPerm: number | null };
  /** Comparaison gain vs coût (unités de rendement). */
  gainVsCost: { gainSpread: number | null; costMedianAbs: number | null; ratio: number | null };
}

function costStats(costs: number[]) {
  const med = median(costs);
  const mn = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
  return { n: costs.length, median: med, mean: mn, ci: bootstrapCI(costs) };
}

function spear(points: [number, number | null][]): { n: number; rho: number | null; p: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of points) if (y != null && Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
  const rho = spearman(xs, ys);
  return { n: xs.length, rho, p: rho == null ? NaN : spearmanP(rho, xs.length) };
}

/** Winsorisation douce : exclut |y| > 10 (outliers de rendement). */
const WINSOR = 10;

export function waitDeltaStats(rows: WaitRow[], deltaMs: number): WaitDeltaStats {
  const y1 = rows.filter((r) => r.y1hEntry != null);
  const y6 = rows.filter((r) => r.y6hEntry != null);
  const surv = rows.filter((r) => r.survEvent != null);
  const c1 = rows.map((r) => r.cost1h).filter((v): v is number => v != null);
  const c6 = rows.map((r) => r.cost6h).filter((v): v is number => v != null);

  const spreadY1 = tercileSpread(
    y1.map((r) => r.dirPrice),
    y1.map((r) => r.y1hEntry!),
  );
  const y1w = y1.filter((r) => Math.abs(r.y1hEntry!) <= WINSOR);
  const spreadY1Winsor = tercileSpread(
    y1w.map((r) => r.dirPrice),
    y1w.map((r) => r.y1hEntry!),
  );

  // Taux d'événement de survie par tercile de dirPrice.
  let survRate: WaitDeltaStats["survRateByTercile"] = { n: surv.length, bottom: null, top: null, diff: null, pPerm: null };
  if (surv.length >= 30) {
    const order = surv.map((_, i) => i).sort((a, b) => surv[a]!.dirPrice - surv[b]!.dirPrice);
    const t1 = Math.floor(surv.length / 3);
    const t2 = Math.floor((2 * surv.length) / 3);
    const btm: number[] = order.slice(0, t1).map((i) => (surv[i]!.survEvent ? 1 : 0));
    const tp: number[] = order.slice(t2).map((i) => (surv[i]!.survEvent ? 1 : 0));
    const rb = btm.reduce((a, b2) => a + b2, 0) / btm.length;
    const rt = tp.reduce((a, b2) => a + b2, 0) / tp.length;
    const { p } = permutationP2Groups(btm, tp, (x, y) =>
      x.length && y.length ? x.reduce((a, b2) => a + b2, 0) / x.length - y.reduce((a, b2) => a + b2, 0) / y.length : null,
    );
    survRate = { n: surv.length, bottom: rb, top: rt, diff: rt - rb, pPerm: p };
  }

  const cs1 = costStats(c1);
  const gainSpread = spreadY1.spread;
  const costMedianAbs = cs1.median == null ? null : Math.abs(cs1.median);

  return {
    deltaMs,
    nWindow: rows.length,
    nRows: rows.length,
    nY1: y1.length,
    nY6: y6.length,
    nSurv: surv.length,
    cost1h: cs1,
    cost6h: costStats(c6),
    spearmanDirY1: spear(y1.map((r) => [r.dirPrice, r.y1hEntry])),
    spearmanDirY6: spear(y6.map((r) => [r.dirPrice, r.y6hEntry])),
    spearmanLiqY1: spear(rows.filter((r) => r.dLiq != null && r.y1hEntry != null).map((r) => [r.dLiq!, r.y1hEntry])),
    spreadY1,
    spreadY1Winsor,
    survRateByTercile: survRate,
    gainVsCost: {
      gainSpread,
      costMedianAbs,
      ratio: gainSpread != null && costMedianAbs != null && costMedianAbs > 0 ? gainSpread / costMedianAbs : null,
    },
  };
}

/** p-value de permutation du Spearman (adversarial : le rang est-il réel ?). */
export function spearmanPermP(xs: number[], ys: number[], reps = 2000): number | null {
  const { p } = permutationP(xs, ys, (x, y) => {
    const r = spearman(x, y);
    return r == null ? null : Math.abs(r);
  }, { reps, seed: 99, side: "ge" });
  return p;
}

export { bootstrapMedianDiffCI };
