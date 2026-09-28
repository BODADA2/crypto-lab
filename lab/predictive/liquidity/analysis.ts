/**
 * Analyse par variable : Spearman(X,Y), déciles, stabilité temporelle et par cohorte.
 * Métriques obligatoires : moyenne, médiane, IC95 %, distribution, drawdown,
 * taux de pertes extrêmes, stabilité temporelle/cohorte, avec/sans outliers, n.
 */
import {
  bootstrapCI,
  deciles,
  median,
  spearman,
  type Universe,
} from "../universe.ts";
import { varNames, type LiquidityFeatures } from "./features.ts";

export interface DecileGroup {
  n: number;
  meanY: number;
  medianY: number;
  ci95: [number, number] | null;
  extremeLossRate: number; // P(Y < -50 %)
  minY: number;
  maxY: number;
}

export interface VariableResult {
  variable: string;
  horizon: string;
  n: number;
  meanY: number;
  medianY: number;
  spearman: number | null;
  top: DecileGroup | null;
  bottom: DecileGroup | null;
  topMinusBottomMedian: number | null;
  ciOverlap: boolean | null;
  // Stabilité temporelle : deux moitiés de la fenêtre t0.
  tempEarly: { n: number; spearman: number | null };
  tempLate: { n: number; spearman: number | null };
  tempSignAgree: boolean | null;
  // Stabilité par cohorte (dexId à t0, top cohortes).
  cohorts: { dex: string; n: number; spearman: number | null }[];
  cohortSignAgree: boolean | null;
  /** Médiane de Y du top décile SANS les outliers (avec = médiane top). */
  topMedianNoOutlier: number | null;
}

function mean(a: number[]): number {
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function groupStats(ys: number[]): DecileGroup {
  const sorted = [...ys].sort((a, b) => a - b);
  return {
    n: ys.length,
    meanY: mean(ys),
    medianY: median(ys)!,
    ci95: bootstrapCI(ys),
    extremeLossRate: ys.filter((y) => y < -0.5).length / ys.length,
    minY: sorted[0]!,
    maxY: sorted[sorted.length - 1]!,
  };
}

function xOf(f: LiquidityFeatures, variable: string): number {
  return (f as unknown as Record<string, number>)[variable]!;
}

export function analyzeVariable(
  feats: LiquidityFeatures[],
  universe: Universe,
  variable: string,
  horizon: string,
): VariableResult | null {
  const rows = feats.filter(
    (f) =>
      f.universe === universe &&
      (f as unknown as Record<string, number | null>)[variable] != null &&
      f.y[horizon] != null,
  );
  if (rows.length < 10) return null;
  const xs = rows.map((r) => xOf(r, variable));
  const ys = rows.map((r) => r.y[horizon]!);

  const sp = spearman(xs, ys);

  // Déciles de X.
  const d = deciles(xs);
  const bins: number[][] = Array.from({ length: 10 }, () => []);
  rows.forEach((r, i) => bins[d.bin(xs[i]!)]!.push(ys[i]!));
  const topYs = bins[9]!;
  const bottomYs = bins[0]!;
  const top = topYs.length > 0 ? groupStats(topYs) : null;
  const bottom = bottomYs.length > 0 ? groupStats(bottomYs) : null;
  const topMinusBottomMedian =
    top && bottom ? top.medianY - bottom.medianY : null;
  const ciOverlap =
    top?.ci95 && bottom?.ci95
      ? !(top.ci95[1] < bottom.ci95[0] || bottom.ci95[1] < top.ci95[0])
      : null;

  // Stabilité temporelle : moitiés par t0Time médian.
  const times = rows.map((r) => r.t0Time).sort((a, b) => a - b);
  const tMed = median(times)!;
  const early = rows.filter((r) => r.t0Time <= tMed);
  const late = rows.filter((r) => r.t0Time > tMed);
  const spE = early.length >= 3
    ? spearman(
        early.map((r) => xOf(r, variable)),
        early.map((r) => r.y[horizon]!),
      )
    : null;
  const spL = late.length >= 3
    ? spearman(
        late.map((r) => xOf(r, variable)),
        late.map((r) => r.y[horizon]!),
      )
    : null;
  const tempSignAgree =
    spE != null && spL != null ? Math.sign(spE) === Math.sign(spL) : null;

  // Stabilité par cohorte (dexId à t0).
  const byDex = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const arr = byDex.get(r.t0Dex) ?? [];
    arr.push(i);
    byDex.set(r.t0Dex, arr);
  });
  const cohorts = [...byDex.entries()]
    .map(([dex, idx]) => ({
      dex,
      n: idx.length,
      spearman: idx.length >= 3
        ? spearman(
            idx.map((i) => xs[i] as number),
            idx.map((i) => ys[i] as number),
          )
        : null,
    }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  const spVals = cohorts.map((c) => c.spearman).filter((v) => v != null);
  const cohortSignAgree =
    spVals.length >= 2
      ? spVals.every((v) => Math.sign(v!) === Math.sign(spVals[0]!))
      : null;

  // Sans outliers : exclut |Y| > 10 (x10, retours absurdes type glitch décimal).
  const ysValid = topYs.filter((y) => Math.abs(y) <= 10);
  const topMedianNoOutlier = ysValid.length > 0 ? median(ysValid) : null;

  return {
    variable,
    horizon,
    n: rows.length,
    meanY: mean(ys),
    medianY: median(ys)!,
    spearman: sp,
    top,
    bottom,
    topMinusBottomMedian,
    ciOverlap,
    tempEarly: { n: early.length, spearman: spE },
    tempLate: { n: late.length, spearman: spL },
    tempSignAgree,
    cohorts,
    cohortSignAgree,
    topMedianNoOutlier,
  };
}

/** Analyse toutes les variables × horizons pour un univers. */
export function analyzeAll(
  feats: LiquidityFeatures[],
  universe: Universe,
  horizons: string[],
  variables: string[] = varNames(),
): VariableResult[] {
  const out: VariableResult[] = [];
  for (const v of variables)
    for (const h of horizons) {
      const r = analyzeVariable(feats, universe, v, h);
      if (r) out.push(r);
    }
  return out;
}
