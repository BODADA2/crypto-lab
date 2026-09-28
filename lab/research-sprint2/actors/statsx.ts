/**
 * SPRINT 2C — utilitaires statistiques partagés (RNG seedé + permutation).
 * Déterministe : mêmes données → mêmes résultats.
 */

/** mulberry32 : RNG seedé. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Test de permutation unilatéral : p = P(stat_perm <= stat_obs) ou >=.
 * @param stat  fonction de statistique sur les vecteurs (xs, ys).
 */
export function permutationP(
  xs: number[],
  ys: number[],
  stat: (x: number[], y: number[]) => number | null,
  opts: { reps?: number; seed?: number; side?: "le" | "ge" } = {},
): { p: number | null; statObs: number | null } {
  const reps = opts.reps ?? 2000;
  const side = opts.side ?? "le";
  const s0 = stat(xs, ys);
  if (s0 == null || xs.length < 5) return { p: null, statObs: s0 };
  const rnd = rng(opts.seed ?? 42);
  let extreme = 0;
  const yp = [...ys];
  for (let r = 0; r < reps; r++) {
    for (let i = yp.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [yp[i], yp[j]] = [yp[j]!, yp[i]!];
    }
    const s = stat(xs, yp);
    if (s == null) continue;
    if (side === "le" ? s <= s0 : s >= s0) extreme++;
  }
  return { p: (extreme + 1) / (reps + 1), statObs: s0 };
}

/** Médiane locale (évite l'import circulaire avec universe). */
export function median(a: number[]): number | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Moyenne. */
export function mean(a: number[]): number | null {
  if (a.length === 0) return null;
  return a.reduce((x, y) => x + y, 0) / a.length;
}
