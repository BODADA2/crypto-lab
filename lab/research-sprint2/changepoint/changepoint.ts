/**
 * SPRINT 2B — Famille N (CHANGE POINT) : détection simple de rupture d'état
 * sur les premières observations, pur TypeScript (aucune dépendance).
 *
 * Question : le changement d'état contient-il l'information ?
 * Événement CHANGE_POINT_EVENT = rupture de moyenne détectée sur les prix
 * (log) dans la fenêtre (t0, t0+W] → distribution future (Y@6h, ddMax24h,
 * survie_50_24h) des tokens avec rupture vs sans rupture.
 *
 * Contrainte de données (constatée) : cadence ~1 tick / 14 min → une
 * détection sur « les premières minutes » est impossible (0 token avec
 * ≥5 ticks dans (t0, t0+1h]). Fenêtre primaire W = 2h (m ≥ 5 ticks exigés),
 * robustesse W = 3h.
 *
 * Protocole anti-fuite : la rupture est déterminée à la fin de la fenêtre
 * de détection D = t0+W ; TOUS les labels sont mesurés DEPUIS D
 * (Y@6h depuis D, ddMax depuis D sur 24h, survie_50 depuis D sur 24h).
 *
 * RÈGLES ANTI-OVERFITTING : discovery uniquement, SKHY exclu, n<30 →
 * non conclusif, AUCUNE stratégie, lecture seule sur data/, borne
 * OPTIMISTE (tokens chauds), holdout JAMAIS lu.
 */
import type { TokenSnapshot } from "../../types.ts";
import { aberrantMask, findT0 } from "../../predictive/universe.ts";
import { mean } from "../actors/statsx.ts";
import {
  permutationP2Groups,
  median,
  bootstrapMedianDiffCI,
} from "../s2b-stats.ts";
import { firstValidAtOrAfter, returnFrom, survivalFrom, ddMaxFrom, SKHY_MINT } from "../wait/wait.ts";

export interface ChangePointResult {
  event: boolean;
  /** Indice de split (dans le vecteur log-prix) maximisant |Δ moyenne|. */
  kStar: number | null;
  /** Δ moyenne log-prix au meilleur split (signe = direction). */
  magnitude: number | null;
  m: number;
}

/**
 * Rupture de moyenne (two-sample mean shift) sur log-prix.
 * Pour chaque split k ∈ [minSeg, m−minSeg] : d_k = mean(x[k:]) − mean(x[:k]).
 * Événement si max_k |d_k| ≥ threshold.
 * Pur TypeScript, déterministe, sans paramètre caché.
 */
export function detectMeanShift(
  logPrices: number[],
  minSeg = 2,
  threshold = 0.35,
): ChangePointResult {
  const m = logPrices.length;
  if (m < 2 * minSeg) return { event: false, kStar: null, magnitude: null, m };
  let best = 0;
  let kStar: number | null = null;
  let mag: number | null = null;
  for (let k = minSeg; k <= m - minSeg; k++) {
    const before = logPrices.slice(0, k);
    const after = logPrices.slice(k);
    const mb = mean(before);
    const ma = mean(after);
    if (mb == null || ma == null) continue;
    const d = ma - mb;
    if (Math.abs(d) > Math.abs(best)) {
      best = d;
      kStar = k;
      mag = d;
    }
  }
  return { event: Math.abs(best) >= threshold, kStar, magnitude: mag, m };
}

export interface ChangePointRow {
  mint: string;
  dexId: string | null;
  t0day: string;
  m: number;
  event: boolean;
  magnitude: number | null;
  y6h: number | null;
  ddMax: number | null;
  survEvent: boolean | null;
}

/**
 * Ligne d'analyse : détection sur (t0, t0+W], labels depuis D = t0+W.
 * null si < minTicks ticks valides dans la fenêtre (non testable).
 */
export function changePointRow(
  mint: string,
  series: TokenSnapshot[],
  windowMs: number,
  threshold: number,
  minTicks = 5,
): ChangePointRow | null {
  const s = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0 = findT0(s);
  if (t0 < 0) return null;
  const mask = aberrantMask(s);
  const t0ms = Date.parse(s[t0]!.fetchedAt);
  const D = t0ms + windowMs;
  const logP: number[] = [];
  for (let i = t0 + 1; i < s.length; i++) {
    const t = Date.parse(s[i]!.fetchedAt);
    if (t <= t0ms || t > D) continue;
    if (mask[i]) continue;
    const p = s[i]!.priceUsd;
    if (!(p > 0)) continue;
    logP.push(Math.log(p));
  }
  if (logP.length < minTicks) return null;
  const cp = detectMeanShift(logP, 2, threshold);
  // Labels depuis D (anti-fuite : événement connu à D).
  const cs = { s, mask, t0, t0ms, t0price: s[t0]!.priceUsd };
  const y6 = returnFrom(cs, D, 6 * 3_600_000);
  const dd = ddMaxFrom(cs, D);
  const surv = survivalFrom(cs, D);
  const snap = s[t0]!;
  return {
    mint,
    dexId: (snap as { dexId?: string | null }).dexId ?? null,
    t0day: new Date(t0ms).toISOString().slice(0, 10),
    m: logP.length,
    event: cp.event,
    magnitude: cp.magnitude,
    y6h: y6?.ret ?? null,
    ddMax: dd,
    survEvent: surv?.event ?? null,
  };
}

export interface GroupDiff {
  nEvent: number;
  nNoEvent: number;
  medianEvent: number | null;
  medianNoEvent: number | null;
  diffMedian: number | null;
  ciDiff: [number, number] | null;
  /** p bilatérale par permutation des labels event/no-event. */
  pPerm: number | null;
}

function groupDiff(
  ev: number[],
  no: number[],
  stat: (x: number[], y: number[]) => number | null = (x, y) => {
    const mx = median(x);
    const my = median(y);
    return mx == null || my == null ? null : mx - my;
  },
): GroupDiff {
  const mx = median(ev);
  const my = median(no);
  const diff = mx == null || my == null ? null : mx - my;
  const { p } = permutationP2Groups(ev, no, stat, 2000, 555);
  return {
    nEvent: ev.length,
    nNoEvent: no.length,
    medianEvent: mx,
    medianNoEvent: my,
    diffMedian: diff,
    ciDiff: bootstrapMedianDiffCI(ev, no),
    pPerm: p,
  };
}

export interface SurvRateDiff {
  nEvent: number;
  nNoEvent: number;
  rateEvent: number | null;
  rateNoEvent: number | null;
  diff: number | null;
  pPerm: number | null;
}

function survRateDiff(ev: boolean[], no: boolean[]): SurvRateDiff {
  const r = (a: boolean[]) =>
    a.length ? a.filter(Boolean).length / a.length : null;
  const re = r(ev);
  const rn = r(no);
  const { p } = permutationP2Groups(
    ev.map((v) => (v ? 1 : 0)),
    no.map((v) => (v ? 1 : 0)),
    (x, y) =>
      x.length && y.length
        ? x.reduce((a, b) => a + b, 0) / x.length -
          y.reduce((a, b) => a + b, 0) / y.length
        : null,
    2000,
    777,
  );
  return {
    nEvent: ev.length,
    nNoEvent: no.length,
    rateEvent: re,
    rateNoEvent: rn,
    diff: re != null && rn != null ? re - rn : null,
    pPerm: p,
  };
}

export interface ChangePointStats {
  windowMs: number;
  threshold: number;
  nTestable: number;
  nEvent: number;
  nNoEvent: number;
  eventRate: number | null;
  y6h: GroupDiff;
  ddMax: GroupDiff;
  surv: SurvRateDiff;
  /** Second-order : |magnitude| prédit-il |Y@6h| ? (Spearman). */
  absMagAbsY: { n: number; rho: number | null };
  /** Robustesse : exclusion des outliers |Y|>10. */
  y6hWinsor: GroupDiff;
}

export function changePointStats(
  rows: ChangePointRow[],
  windowMs: number,
  threshold: number,
): ChangePointStats {
  const ev = rows.filter((r) => r.event);
  const no = rows.filter((r) => !r.event);
  const y6ev = ev.map((r) => r.y6h).filter((v): v is number => v != null);
  const y6no = no.map((r) => r.y6h).filter((v): v is number => v != null);
  const ddev = ev.map((r) => r.ddMax).filter((v): v is number => v != null);
  const ddno = no.map((r) => r.ddMax).filter((v): v is number => v != null);
  const sev = ev.map((r) => r.survEvent).filter((v): v is boolean => v != null);
  const sno = no.map((r) => r.survEvent).filter((v): v is boolean => v != null);

  // Second-order : |magnitude| vs |y6h| (Spearman, import dynamique évité : calcul local).
  const pairs = rows.filter(
    (r) => r.magnitude != null && r.y6h != null && Number.isFinite(r.y6h),
  );
  const rho = spearmanLocal(
    pairs.map((r) => Math.abs(r.magnitude!)),
    pairs.map((r) => Math.abs(r.y6h!)),
  );

  const y6evW = y6ev.filter((v) => Math.abs(v) <= 10);
  const y6noW = y6no.filter((v) => Math.abs(v) <= 10);

  return {
    windowMs,
    threshold,
    nTestable: rows.length,
    nEvent: ev.length,
    nNoEvent: no.length,
    eventRate: rows.length ? ev.length / rows.length : null,
    y6h: groupDiff(y6ev, y6no),
    ddMax: groupDiff(ddev, ddno),
    surv: survRateDiff(sev, sno),
    absMagAbsY: { n: pairs.length, rho },
    y6hWinsor: groupDiff(y6evW, y6noW),
  };
}

/** Spearman local (évite l'import circulaire). */
function spearmanLocal(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((_, i) => i).sort((a, b) => arr[a]! - arr[b]!);
    const r = new Array<number>(arr.length);
    idx.forEach((orig, pos) => (r[orig] = pos));
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export { SKHY_MINT, firstValidAtOrAfter };
