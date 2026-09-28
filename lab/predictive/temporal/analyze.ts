/**
 * DOMAINE 5/5 — TEMPORAL STRUCTURE : analyse par variable (phase DÉCOUVERTE).
 *
 * Pour chaque couple (variable X, horizon H) :
 * - Spearman(X, Y_H) + IC95 bootstrap
 * - déciles de X : Y médian/moyen décile top vs bottom + IC
 * - stabilité temporelle (2 moitiés de fenêtre) et par cohorte (hash pair/impair)
 * - avec / sans outliers valides (outliers = Y hors [P1, P99] ; résultat
 *   principal = AVEC les outliers valides ; ticks aberrants toujours exclus)
 * - métriques obligatoires : moyenne, médiane, IC95, distribution, drawdown
 *   (diagnostic descriptif sur la courbe cumulative — pas une stratégie),
 *   taux de pertes extrêmes, n
 */
import { bootstrapCI, deciles, median, spearman } from "../universe.ts";

export interface Row {
  mint: string;
  t0Time: number;
  x: Record<string, number | null>;
  y: Record<string, number | null>; // "1h" | "6h" | "24h"
}

export interface DecileComp {
  topN: number;
  botN: number;
  topMedian: number | null;
  botMedian: number | null;
  topMean: number | null;
  botMean: number | null;
  topMeanCI: [number, number] | null;
  botMeanCI: [number, number] | null;
  diffMean: number | null; // top − bottom
  diffMeanCI: [number, number] | null;
}

export interface VarAnalysis {
  variable: string;
  horizon: string;
  n: number;
  spearman: number | null;
  spearmanCI: [number, number] | null;
  mean: number | null;
  median: number | null;
  meanCI: [number, number] | null;
  sd: number | null;
  min: number | null;
  max: number | null;
  pLoss: number | null; // P(Y < 0)
  pExtremeLoss: number | null; // P(Y <= −50 %)
  drawdown: number | null; // diagnostic : max peak-to-trough de la courbe cumulative
  deciles: DecileComp | null;
  // stabilité : Spearman sur chaque moitié / cohorte
  stabTimeA: number | null;
  stabTimeB: number | null;
  stabCohA: number | null;
  stabCohB: number | null;
  nTimeA: number;
  nTimeB: number;
  nCohA: number;
  nCohB: number;
  // sans outliers valides (Y hors P1–P99)
  nNoOut: number;
  spearmanNoOut: number | null;
  medianNoOut: number | null;
  meanNoOut: number | null;
}

let seedState = 123456789;
function rnd(): number {
  seedState = (Math.imul(seedState, 1103515245) + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}

/** IC95 bootstrap d'une statistique arbitraire sur paires (xs, ys). */
export function bootstrapStat(
  xs: number[],
  ys: number[],
  stat: (x: number[], y: number[]) => number | null,
  reps = 2000,
): [number, number] | null {
  if (xs.length < 10) return null;
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const bx: number[] = [];
    const by: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const j = Math.floor(rnd() * xs.length);
      bx.push(xs[j]!);
      by.push(ys[j]!);
    }
    const v = stat(bx, by);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < reps / 2) return null;
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)]!, vals[Math.floor(0.975 * vals.length)]!];
}

function quantile(a: number[], q: number): number | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

/** Max drawdown de la courbe cumulative (diagnostic descriptif). */
export function maxDrawdown(ys: number[]): number | null {
  if (ys.length === 0) return null;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const y of ys) {
    cum += y;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

/** Découpe les outliers valides : Y hors [P1, P99] de l'échantillon. */
export function removeValidOutliers(xs: number[], ys: number[]): { xs: number[]; ys: number[] } {
  const lo = quantile(ys, 0.01);
  const hi = quantile(ys, 0.99);
  if (lo === null || hi === null) return { xs, ys };
  const kxs: number[] = [];
  const kys: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    if (ys[i]! >= lo && ys[i]! <= hi) {
      kxs.push(xs[i]!);
      kys.push(ys[i]!);
    }
  }
  return { xs: kxs, ys: kys };
}

export function hashParity(mint: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < mint.length; i++) {
    h ^= mint.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2;
}

/** Analyse complète d'une variable sur un horizon, pour un sous-ensemble de lignes. */
export function analyzeVariable(rows: Row[], variable: string, horizon: string): VarAnalysis {
  const pairs = rows
    .map((r) => ({ mint: r.mint, t0: r.t0Time, x: r.x[variable] ?? null, y: r.y[horizon] ?? null }))
    .filter((p) => p.x !== null && p.y !== null && Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pairs.length;
  const xs = pairs.map((p) => p.x as number);
  const ys = pairs.map((p) => p.y as number);

  const rho = n >= 3 ? spearman(xs, ys) : null;
  const rhoCI = n >= 10 ? bootstrapStat(xs, ys, (a, b) => spearman(a, b)) : null;

  const mean = n > 0 ? ys.reduce((a, b) => a + b, 0) / n : null;
  const med = median(ys);
  const meanCI = bootstrapCI(ys);
  const sd =
    n > 1 && mean !== null
      ? Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
      : null;
  const sorted = [...ys].sort((a, b) => a - b);

  // Déciles de X : top vs bottom.
  let dec: DecileComp | null = null;
  if (n >= 30) {
    const dz = deciles(xs);
    const topY: number[] = [];
    const botY: number[] = [];
    pairs.forEach((p) => {
      const b = dz.bin(p.x as number);
      if (b === 9) topY.push(p.y as number);
      if (b === 0) botY.push(p.y as number);
    });
    const topMean = topY.length > 0 ? topY.reduce((a, b) => a + b, 0) / topY.length : null;
    const botMean = botY.length > 0 ? botY.reduce((a, b) => a + b, 0) / botY.length : null;
    const diffs: number[] = [];
    // IC de la différence des moyennes : bootstrap apparié par tirage conjoint.
    let diffCI: [number, number] | null = null;
    if (topY.length >= 10 && botY.length >= 10) {
      for (let r = 0; r < 2000; r++) {
        let st = 0;
        for (let i = 0; i < topY.length; i++) st += topY[Math.floor(rnd() * topY.length)]!;
        let sb = 0;
        for (let i = 0; i < botY.length; i++) sb += botY[Math.floor(rnd() * botY.length)]!;
        diffs.push(st / topY.length - sb / botY.length);
      }
      diffs.sort((a, b) => a - b);
      diffCI = [diffs[50]!, diffs[1949]!];
    }
    dec = {
      topN: topY.length,
      botN: botY.length,
      topMedian: median(topY),
      botMedian: median(botY),
      topMean,
      botMean,
      topMeanCI: bootstrapCI(topY),
      botMeanCI: bootstrapCI(botY),
      diffMean: topMean !== null && botMean !== null ? topMean - botMean : null,
      diffMeanCI: diffCI,
    };
  }

  // Stabilité temporelle : deux moitiés par date médiane de t0.
  const tMed = median(pairs.map((p) => p.t0));
  const gA = pairs.filter((p) => (p.t0 as number) <= (tMed as number));
  const gB = pairs.filter((p) => (p.t0 as number) > (tMed as number));
  // Stabilité par cohorte : parité du hash du mint (disjointes, aléatoires).
  const cA = pairs.filter((p) => hashParity(p.mint) === 0);
  const cB = pairs.filter((p) => hashParity(p.mint) === 1);

  const rhoOf = (g: typeof pairs): number | null =>
    g.length >= 10 ? spearman(g.map((p) => p.x as number), g.map((p) => p.y as number)) : null;

  // Sans outliers valides.
  const trimmed = removeValidOutliers(xs, ys);

  return {
    variable,
    horizon,
    n,
    spearman: rho,
    spearmanCI: rhoCI,
    mean,
    median: med,
    meanCI,
    sd,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    pLoss: n > 0 ? ys.filter((y) => y < 0).length / n : null,
    pExtremeLoss: n > 0 ? ys.filter((y) => y <= -0.5).length / n : null,
    drawdown: maxDrawdown(ys),
    deciles: dec,
    stabTimeA: rhoOf(gA),
    stabTimeB: rhoOf(gB),
    stabCohA: rhoOf(cA),
    stabCohB: rhoOf(cB),
    nTimeA: gA.length,
    nTimeB: gB.length,
    nCohA: cA.length,
    nCohB: cB.length,
    nNoOut: trimmed.ys.length,
    spearmanNoOut: trimmed.ys.length >= 3 ? spearman(trimmed.xs, trimmed.ys) : null,
    medianNoOut: median(trimmed.ys),
    meanNoOut:
      trimmed.ys.length > 0 ? trimmed.ys.reduce((a, b) => a + b, 0) / trimmed.ys.length : null,
  };
}

/** Couverture Y par horizon (part des lignes avec Y non null). */
export function coverage(rows: Row[], horizons: string[]): Record<string, { n: number; pct: number }> {
  const out: Record<string, { n: number; pct: number }> = {};
  for (const h of horizons) {
    const n = rows.filter((r) => r.y[h] !== null && r.y[h] !== undefined).length;
    out[h] = { n, pct: rows.length > 0 ? (100 * n) / rows.length : 0 };
  }
  return out;
}
