/**
 * Phase 2 — statistiques par couple (feature, label).
 *
 * Pour chaque couple :
 *  - corrélation de rang de Spearman + p-value par permutation
 *    (1000 permutations, seed fixe → reproductible) ;
 *  - différence de médianes (moitié haute vs moitié basse de la feature)
 *    avec IC95 % bootstrap ;
 *  - déciles top vs bottom : n, moyenne, médiane, IC95 % (bootstrap, moyenne).
 *
 * Règle d'honnêteté : n < 30 par test → marqué NON_CONCLUSIF, jamais
 * interprété comme un signal (ni positif, ni négatif).
 */
import { bootstrapCI, median, spearman } from "../universe.ts";

/** Ré-export pour les consommateurs (tests) : corrélation de rang de Spearman. */
export { spearman };

export const MIN_N_CONCLUSIVE = 30;
const PERM_REPS = 1000;
const PERM_SEED = 42;

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(a: T[], rnd: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
}

/**
 * p-value bilatérale par permutation : proportion des |spearman| permutés
 * >= |spearman| observé. Seed fixe → reproductible.
 */
export function permutationPValue(
  xs: number[],
  ys: number[],
  reps = PERM_REPS,
  seed = PERM_SEED,
): number | null {
  const obs = spearman(xs, ys);
  if (obs == null) return null;
  const rnd = mulberry32(seed);
  const perm = [...ys];
  let ge = 0;
  for (let r = 0; r < reps; r++) {
    shuffleInPlace(perm, rnd);
    const s = spearman(xs, perm);
    if (s != null && Math.abs(s) >= Math.abs(obs)) ge++;
  }
  return (ge + 1) / (reps + 1);
}

/** IC95 % bootstrap (percentiles) de la différence des médianes (hi - lo). */
export function bootstrapMedianDiffCI(
  lo: number[],
  hi: number[],
  reps = 2000,
  seed = 1234,
): [number, number] | null {
  if (lo.length < 10 || hi.length < 10) return null;
  const rnd = mulberry32(seed);
  const diffs: number[] = [];
  for (let r = 0; r < reps; r++) {
    const slo = Array.from({ length: lo.length }, () => lo[Math.floor(rnd() * lo.length)]!);
    const shi = Array.from({ length: hi.length }, () => hi[Math.floor(rnd() * hi.length)]!);
    const mlo = median(slo);
    const mhi = median(shi);
    if (mlo == null || mhi == null) continue;
    diffs.push(mhi - mlo);
  }
  if (diffs.length === 0) return null;
  diffs.sort((a, b) => a - b);
  return [
    diffs[Math.floor(0.025 * diffs.length)]!,
    diffs[Math.floor(0.975 * diffs.length)]!,
  ];
}

export interface DecileSummary {
  n: number;
  mean: number | null;
  median: number | null;
  ci95: [number, number] | null;
}

export interface PairAnalysis {
  feature: string;
  label: string;
  n: number;
  conclusive: boolean;
  spearman: number | null;
  pValuePerm: number | null;
  medianLow: number | null;
  medianHigh: number | null;
  medianDiff: number | null;
  medianDiffCI95: [number, number] | null;
  bottomDecile: DecileSummary;
  topDecile: DecileSummary;
}

function summarize(a: number[]): DecileSummary {
  if (a.length === 0) return { n: 0, mean: null, median: null, ci95: null };
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return { n: a.length, mean, median: median(a), ci95: bootstrapCI(a) };
}

/**
 * Analyse d'un couple (feature, label) sur des paires déjà appariées
 * (valeurs non-null des deux côtés).
 */
export function analyzePair(
  feature: string,
  label: string,
  xs: number[],
  ys: number[],
): PairAnalysis {
  const n = xs.length;
  const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const half = Math.floor(n / 2);
  const loY = order.slice(0, half).map((i) => ys[i]!);
  const hiY = order.slice(n - half).map((i) => ys[i]!);
  const d = Math.max(1, Math.floor(n / 10));
  const botY = order.slice(0, d).map((i) => ys[i]!);
  const topY = order.slice(n - d).map((i) => ys[i]!);
  const mlo = median(loY);
  const mhi = median(hiY);
  return {
    feature,
    label,
    n,
    conclusive: n >= MIN_N_CONCLUSIVE,
    spearman: spearman(xs, ys),
    pValuePerm: permutationPValue(xs, ys),
    medianLow: mlo,
    medianHigh: mhi,
    medianDiff: mlo != null && mhi != null ? mhi - mlo : null,
    medianDiffCI95: bootstrapMedianDiffCI(loY, hiY),
    bottomDecile: summarize(botY),
    topDecile: summarize(topY),
  };
}
