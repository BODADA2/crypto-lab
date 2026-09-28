/**
 * Analyses par variable X : Spearman(X, Y) par horizon, déciles top vs bottom,
 * stabilité temporelle (deux moitiés) et par cohorte, avec/sans outliers Y.
 *
 * Métriques obligatoires par groupe : n, moyenne, médiane, IC95% (bootstrap de
 * la moyenne), distribution (min/p10/p25/p75/p90/max), taux de pertes extrêmes
 * (Y <= -90%), taux de survie, drawdown max de la P&L cumulée (triée par t0).
 *
 * Règle outliers : résultat PRINCIPAL avec les outliers valides ; secondaire
 * sans les |Y| >= 10 (candidats glitch de données, cf. SKHY +4 939 704 %).
 */
import {
  bootstrapCI,
  deciles,
  median,
  spearman,
} from "../universe.ts";
import type { DiscoveryRow, HorizonLabel, WalletFeatures } from "./types.ts";

/** Seuil |Y| au-delà duquel un rendement est traité comme outlier de données. */
export const Y_OUTLIER_ABS = 10;

/** Clés des variables X testées (ordre des tableaux du rapport). */
export const X_VARS = [
  "buyerCount",
  "top5Share",
  "top1AmountShare",
  "gini",
  "sameSlotMax",
  "arrivalSpanSec",
  "medianInterArrivalSec",
  "overlapFrac",
  "sellersOver50",
  "medianSoldFrac",
] as const;
export type XVar = (typeof X_VARS)[number];

/**
 * Spearman protégé : le protocole partagé ne gère pas les ex-aequo — avec un
 * vecteur constant, les rangs restent arbitraires et rho serait fallacieux.
 * Ici : vecteur constant (X ou Y) => null (dégénéré, jamais interprété).
 */
export function safeSpearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const constant = (a: number[]): boolean => a.every((v) => v === a[0]);
  if (constant(xs) || constant(ys)) return null;
  return spearman(xs, ys);
}

export function xValue(f: WalletFeatures, v: XVar): number | null {
  return f[v] as number | null;
}

/** Paires (X, Y) exploitables pour une variable et un horizon. */
export function xyPairs(
  rows: DiscoveryRow[],
  v: XVar,
  horizon: HorizonLabel,
  useContinuousY: boolean,
  excludeOutliers: boolean,
): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of rows) {
    const x = xValue(r.features, v);
    const y = useContinuousY
      ? r.outcome.y[horizon]
      : r.outcome.survival[horizon] == null
        ? null
        : r.outcome.survival[horizon]
          ? 1
          : 0;
    if (x == null || y == null) continue;
    if (excludeOutliers && useContinuousY && Math.abs(y) >= Y_OUTLIER_ABS) continue;
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

export interface SpearmanResult {
  variable: XVar;
  horizon: HorizonLabel;
  target: "y" | "survival";
  rho: number | null;
  n: number;
  excludeOutliers: boolean;
}

/** Spearman(X, Y) et Spearman(X, survie) par horizon. */
export function spearmanByHorizon(
  rows: DiscoveryRow[],
  horizons: HorizonLabel[],
  excludeOutliers: boolean,
): SpearmanResult[] {
  const out: SpearmanResult[] = [];
  for (const v of X_VARS)
    for (const h of horizons)
      for (const target of ["y", "survival"] as const) {
        const { xs, ys } = xyPairs(rows, v, h, target === "y", excludeOutliers);
        out.push({
          variable: v,
          horizon: h,
          target,
          rho: safeSpearman(xs, ys),
          n: xs.length,
          excludeOutliers,
        });
      }
  return out;
}

export interface GroupStats {
  n: number;
  mean: number | null;
  median: number | null;
  ci95: [number, number] | null;
  min: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
  /** Part des Y <= -0.9 (pertes extrêmes). */
  extremeLossRate: number | null;
  /** Part des survie=true (null si survie non mesurable). */
  survivalRate: number | null;
  /** Drawdown max de la P&L cumulée (trades triés par t0). */
  maxDrawdown: number | null;
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Statistiques complètes d'un groupe de rendements Y (+ survie alignée). */
export function groupStats(
  ys: number[],
  survivals: (boolean | null)[],
): GroupStats {
  const n = ys.length;
  if (n === 0)
    return {
      n, mean: null, median: null, ci95: null, min: null, p10: null,
      p25: null, p75: null, p90: null, max: null, extremeLossRate: null,
      survivalRate: null, maxDrawdown: null,
    };
  const sorted = [...ys].sort((a, b) => a - b);
  const survKnown = survivals.filter((s): s is boolean => s != null);
  // Drawdown max de la P&L cumulée (capital 1, triée par t0 en amont).
  let peak = 1;
  let eq = 1;
  let dd = 0;
  for (const y of ys) {
    eq *= 1 + y;
    if (eq > peak) peak = eq;
    if (peak > 0) dd = Math.min(dd, eq / peak - 1);
  }
  return {
    n,
    mean: ys.reduce((a, b) => a + b, 0) / n,
    median: median(ys),
    ci95: bootstrapCI(ys),
    min: sorted[0]!,
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1]!,
    extremeLossRate: ys.filter((y) => y <= -0.9).length / n,
    survivalRate: survKnown.length > 0 ? survKnown.filter(Boolean).length / survKnown.length : null,
    maxDrawdown: dd,
  };
}

export interface DecileResult {
  variable: XVar;
  horizon: HorizonLabel;
  n: number;
  /** Décile 0 (X le plus bas) vs décile 9 (X le plus haut). */
  bottom: GroupStats;
  top: GroupStats;
  topMinusBottomMedian: number | null;
  excludeOutliers: boolean;
}

/**
 * Déciles de X -> Y du décile top vs bottom.
 * Triés par t0 pour le drawdown ; déciles calculés sur X uniquement.
 */
export function decileTopBottom(
  rows: DiscoveryRow[],
  horizons: HorizonLabel[],
  excludeOutliers: boolean,
): DecileResult[] {
  const out: DecileResult[] = [];
  for (const v of X_VARS) {
    const usable = rows.filter((r) => xValue(r.features, v) != null);
    if (usable.length === 0) continue;
    const dz = deciles(usable.map((r) => xValue(r.features, v) as number));
    const bins = usable.map((r) => dz.bin(xValue(r.features, v) as number));
    for (const h of horizons) {
      const rowsTop: DiscoveryRow[] = [];
      const rowsBottom: DiscoveryRow[] = [];
      usable.forEach((r, i) => {
        const y = r.outcome.y[h];
        if (y == null) return;
        if (excludeOutliers && Math.abs(y) >= Y_OUTLIER_ABS) return;
        if (bins[i] === 9) rowsTop.push(r);
        else if (bins[i] === 0) rowsBottom.push(r);
      });
      const toStats = (rs: DiscoveryRow[]): GroupStats => {
        const byT0 = [...rs].sort((a, b) => a.outcome.t0Time.localeCompare(b.outcome.t0Time));
        return groupStats(
          byT0.map((r) => r.outcome.y[h] as number),
          byT0.map((r) => r.outcome.survival[h]),
        );
      };
      const top = toStats(rowsTop);
      const bottom = toStats(rowsBottom);
      out.push({
        variable: v,
        horizon: h,
        n: rowsTop.length + rowsBottom.length,
        bottom,
        top,
        topMinusBottomMedian:
          top.median != null && bottom.median != null ? top.median - bottom.median : null,
        excludeOutliers,
      });
    }
  }
  return out;
}

export interface StabilityResult {
  variable: XVar;
  horizon: HorizonLabel;
  target: "y" | "survival";
  firstHalf: { rho: number | null; n: number };
  secondHalf: { rho: number | null; n: number };
  /** |rho1 - rho2| : instabilité si grand devant les n. */
  rhoGap: number | null;
}

/** Stabilité temporelle : deux moitiés de la fenêtre (tri par t0). */
export function temporalStability(
  rows: DiscoveryRow[],
  horizons: HorizonLabel[],
): StabilityResult[] {
  const out: StabilityResult[] = [];
  const byT0 = [...rows].sort((a, b) => a.outcome.t0Time.localeCompare(b.outcome.t0Time));
  const mid = Math.floor(byT0.length / 2);
  const halves = [byT0.slice(0, mid), byT0.slice(mid)] as const;
  for (const v of X_VARS)
    for (const h of horizons)
      for (const target of ["y", "survival"] as const) {
        const rhos = halves.map((half) => {
          const { xs, ys } = xyPairs(half, v, h, target === "y", false);
          return { rho: safeSpearman(xs, ys), n: xs.length };
        });
        const [a, b] = rhos;
        out.push({
          variable: v,
          horizon: h,
          target,
          firstHalf: a!,
          secondHalf: b!,
          rhoGap: a!.rho != null && b!.rho != null ? Math.abs(a!.rho - b!.rho) : null,
        });
      }
  return out;
}

export interface CohortResult {
  variable: XVar;
  horizon: HorizonLabel;
  target: "y" | "survival";
  cohorts: { label: string; rho: number | null; n: number }[];
}

/**
 * Stabilité par cohorte (univers discovery/calibration/holdout).
 * GRILLE : n'appeler que sur les univers débloqués par la phase en cours.
 * En phase DÉCOUVERTE : discovery uniquement => cohortes vides, documenté.
 */
export function cohortStability(
  rows: DiscoveryRow[],
  horizons: HorizonLabel[],
  allowedUniverses: ("discovery" | "calibration" | "holdout")[],
): CohortResult[] {
  const out: CohortResult[] = [];
  for (const v of X_VARS)
    for (const h of horizons)
      for (const target of ["y", "survival"] as const) {
        const cohorts = allowedUniverses.map((u) => {
          const sub = rows.filter((r) => r.universe === u);
          const { xs, ys } = xyPairs(sub, v, h, target === "y", false);
          return { label: u, rho: safeSpearman(xs, ys), n: xs.length };
        });
        out.push({ variable: v, horizon: h, target, cohorts });
      }
  return out;
}
