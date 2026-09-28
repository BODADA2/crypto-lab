/**
 * FLIP ENGINE — Branch B, Sprint 1. Petites statistiques inférentielles.
 * Aucune dépendance externe ; bootstrap déterministe (LCG seedé).
 */

export function mean(xs: number[]): number {
  const f = xs.filter(Number.isFinite);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
}

export function median(xs: number[]): number {
  const f = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!f.length) return NaN;
  const m = Math.floor(f.length / 2);
  return f.length % 2 ? f[m]! : (f[m - 1]! + f[m]!) / 2;
}

/** Intervalle de Wilson pour une proportion (k/n), z=1.96 par défaut. */
export function wilsonCI(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)];
}

function phi(x: number): number {
  // CDF normale standard (approximation Abramowitz-Stegun)
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export interface TwoPropResult {
  p1: number; p2: number; diff: number;
  z: number; pValue: number; // bilatéral, approximation normale
  ci1: [number, number]; ci2: [number, number]; ciDiff: [number, number];
}

/** Test z deux proportions (bilatéral). Retourne p=NaN si n insuffisant. */
export function twoPropZ(k1: number, n1: number, k2: number, n2: number): TwoPropResult {
  const p1 = n1 ? k1 / n1 : NaN;
  const p2 = n2 ? k2 / n2 : NaN;
  if (!n1 || !n2) return { p1, p2, diff: NaN, z: NaN, pValue: NaN, ci1: [NaN, NaN], ci2: [NaN, NaN], ciDiff: [NaN, NaN] };
  const pp = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  const diff = p1 - p2;
  const z = se > 0 ? diff / se : 0;
  const pValue = 2 * (1 - phi(Math.abs(z)));
  const seD = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return {
    p1, p2, diff, z, pValue,
    ci1: wilsonCI(k1, n1), ci2: wilsonCI(k2, n2),
    ciDiff: [diff - 1.96 * seD, diff + 1.96 * seD],
  };
}

/** LCG déterministe pour le bootstrap reproductible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** IC bootstrap (percentile) de la médiane. B=2000 par défaut. */
export function bootstrapMedianCI(xs: number[], B = 2000, seed = 42): [number, number] {
  const f = xs.filter(Number.isFinite);
  if (f.length < 2) return [NaN, NaN];
  const rnd = lcg(seed);
  const n = f.length;
  const meds: number[] = [];
  for (let b = 0; b < B; b++) {
    const samp = new Array<number>(n);
    for (let i = 0; i < n; i++) samp[i] = f[Math.floor(rnd() * n)]!;
    meds.push(median(samp));
  }
  meds.sort((a, b) => a - b);
  return [meds[Math.floor(0.025 * B)]!, meds[Math.min(B - 1, Math.ceil(0.975 * B) - 1)]!];
}

/** Test des signes bilatéral (H0: médiane = 0), approximation normale. */
export function signTest(xs: number[]): { n: number; pos: number; pValue: number } {
  const f = xs.filter((x) => Number.isFinite(x) && x !== 0);
  const pos = f.filter((x) => x > 0).length;
  const n = f.length;
  if (!n) return { n: 0, pos: 0, pValue: NaN };
  const z = (pos - n / 2) / Math.sqrt(n / 4);
  return { n, pos, pValue: 2 * (1 - phi(Math.abs(z))) };
}
