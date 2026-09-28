/**
 * Statistiques complémentaires au protocole partagé (lab/predictive/universe.ts).
 * Tout ce qui est déjà dans universe.ts (spearman, deciles, median, bootstrapCI)
 * n'est PAS redéfini ici.
 */
import { median, spearman } from "../universe.ts";

/**
 * p-value bilatérale du Spearman via approximation t (n-2 ddl).
 * rho*sqrt((n-2)/(1-rho^2)) ~ t(n-2).
 */
export function spearmanP(rho: number, n: number): number | null {
  if (n < 4 || !isFinite(rho)) return null;
  if (Math.abs(rho) >= 1) return 0;
  const t = (rho * Math.sqrt(n - 2)) / Math.sqrt(1 - rho * rho);
  return 2 * (1 - studentTCdf(Math.abs(t), n - 2));
}

/** CDF de Student via la fonction bêta incomplète régularisée. */
function studentTCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const ib = regularizedBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Fraction continue (betacf, cf. Numerical Recipes).
  const fpmin = 1e-300;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  const logBeta =
    logGamma(a) + logGamma(b) - logGamma(qab);
  return h * Math.exp(-logBeta) * Math.pow(x, a) * Math.pow(1 - x, b) / a;
}

/** Log-gamma (approximation de Lanczos). */
function logGamma(z: number): number {
  const g = 7;
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = C[0]!;
  for (let i = 1; i < g + 2; i++) x += C[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Générateur pseudo-aléatoire déterministe (LCG). */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** IC95 % bootstrap du Spearman (rééchantillonnage par paires). */
export function spearmanBootstrapCI(
  xs: number[],
  ys: number[],
  reps = 2000,
  seed = 7,
): [number, number] | null {
  if (xs.length !== ys.length || xs.length < 10) return null;
  const rnd = makeRng(seed);
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const sx: number[] = [];
    const sy: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const j = Math.floor(rnd() * xs.length);
      sx.push(xs[j]!);
      sy.push(ys[j]!);
    }
    const rho = spearman(sx, sy);
    if (rho !== null) vals.push(rho);
  }
  if (vals.length < reps / 2) return null;
  vals.sort((a, b) => a - b);
  return [
    vals[Math.floor(0.025 * vals.length)]!,
    vals[Math.floor(0.975 * vals.length)]!,
  ];
}

/** IC95 % bootstrap de la médiane. */
export function medianBootstrapCI(
  a: number[],
  reps = 2000,
  seed = 11,
): [number, number] | null {
  if (a.length < 10) return null;
  const rnd = makeRng(seed);
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const s: number[] = [];
    for (let i = 0; i < a.length; i++) s.push(a[Math.floor(rnd() * a.length)]!);
    const m = median(s);
    if (m !== null) vals.push(m);
  }
  vals.sort((x, y) => x - y);
  return [
    vals[Math.floor(0.025 * vals.length)]!,
    vals[Math.floor(0.975 * vals.length)]!,
  ];
}

/** IC95 % bootstrap de (médiane(A) − médiane(B)). */
export function medianDiffBootstrapCI(
  a: number[],
  b: number[],
  reps = 2000,
  seed = 13,
): [number, number] | null {
  if (a.length < 10 || b.length < 10) return null;
  const rnd = makeRng(seed);
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const sa: number[] = [];
    const sb: number[] = [];
    for (let i = 0; i < a.length; i++) sa.push(a[Math.floor(rnd() * a.length)]!);
    for (let i = 0; i < b.length; i++) sb.push(b[Math.floor(rnd() * b.length)]!);
    const ma = median(sa);
    const mb = median(sb);
    if (ma !== null && mb !== null) vals.push(ma - mb);
  }
  vals.sort((x, y) => x - y);
  return [
    vals[Math.floor(0.025 * vals.length)]!,
    vals[Math.floor(0.975 * vals.length)]!,
  ];
}

export interface Summary {
  n: number;
  mean: number;
  sd: number;
  median: number | null;
  q05: number;
  q25: number;
  q75: number;
  q95: number;
  min: number;
  max: number;
  /** Fraction des Y <= -50 % (pertes extrêmes). */
  extremeLossRate: number;
  medianCI: [number, number] | null;
  meanCI: [number, number] | null;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Résumé complet d'une distribution (Y). */
export function summarize(a: number[]): Summary | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  const mean = s.reduce((x, y) => x + y, 0) / n;
  const sd =
    n > 1
      ? Math.sqrt(s.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1))
      : 0;
  return {
    n,
    mean,
    sd,
    median: median(a),
    q05: quantile(s, 0.05),
    q25: quantile(s, 0.25),
    q75: quantile(s, 0.75),
    q95: quantile(s, 0.95),
    min: s[0]!,
    max: s[n - 1]!,
    extremeLossRate: s.filter((v) => v <= -0.5).length / n,
    medianCI: medianBootstrapCI(a),
    meanCI: meanBootstrapCI(a),
  };
}

function meanBootstrapCI(
  a: number[],
  reps = 2000,
  seed = 17,
): [number, number] | null {
  if (a.length < 10) return null;
  const rnd = makeRng(seed);
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[Math.floor(rnd() * a.length)]!;
    vals.push(sum / a.length);
  }
  vals.sort((x, y) => x - y);
  return [
    vals[Math.floor(0.025 * vals.length)]!,
    vals[Math.floor(0.975 * vals.length)]!,
  ];
}

/**
 * Winsorisation aux quantiles p1/p99 (analyse de sensibilité "sans outliers").
 * Le résultat principal reste AVEC les outliers valides (post-aberrantMask).
 */
export function winsorize(a: number[], p1 = 0.01, p99 = 0.99): number[] {
  if (a.length < 10) return [...a];
  const s = [...a].sort((x, y) => x - y);
  const lo = quantile(s, p1);
  const hi = quantile(s, p99);
  return a.map((v) => Math.min(hi, Math.max(lo, v)));
}
