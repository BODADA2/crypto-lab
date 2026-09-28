/**
 * SPRINT 2B — utilitaires statistiques locaux (complètent actors/statsx.ts).
 * Déterministe : RNG seedé, mêmes données → mêmes résultats.
 */
import { rng } from "./actors/statsx.ts";

/**
 * p-value bilatérale par permutation d'une statistique de différence
 * entre deux groupes (ex. médiane_A − médiane_B, taux_A − taux_B).
 * Distribution nulle = réassignation aléatoire des labels de groupe.
 */
export function permutationP2Groups(
  a: number[],
  b: number[],
  stat: (x: number[], y: number[]) => number | null,
  reps = 2000,
  seed = 42,
): { p: number | null; statObs: number | null } {
  const s0 = stat(a, b);
  if (s0 == null || a.length < 5 || b.length < 5)
    return { p: null, statObs: s0 };
  const rnd = rng(seed);
  const pooled = [...a, ...b];
  const na = a.length;
  let extreme = 0;
  for (let r = 0; r < reps; r++) {
    for (let i = pooled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = pooled[i]!;
      pooled[i] = pooled[j]!;
      pooled[j] = tmp;
    }
    const s = stat(pooled.slice(0, na), pooled.slice(na));
    if (s == null) continue;
    if (Math.abs(s) >= Math.abs(s0)) extreme++;
  }
  return { p: (extreme + 1) / (reps + 1), statObs: s0 };
}

/** Médiane locale (même définition que statsx). */
export function median(a: number[]): number | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * IC95 % bootstrap (percentiles) de la différence des médianes
 * de deux groupes indépendants. Seedé → reproductible.
 */
export function bootstrapMedianDiffCI(
  a: number[],
  b: number[],
  reps = 2000,
  seed = 7,
): [number, number] | null {
  if (a.length < 10 || b.length < 10) return null;
  const rnd = rng(seed);
  const diffs: number[] = [];
  for (let r = 0; r < reps; r++) {
    const ra: number[] = [];
    const rb: number[] = [];
    for (let i = 0; i < a.length; i++) ra.push(a[Math.floor(rnd() * a.length)]!);
    for (let i = 0; i < b.length; i++) rb.push(b[Math.floor(rnd() * b.length)]!);
    const ma = median(ra);
    const mb = median(rb);
    if (ma == null || mb == null) continue;
    diffs.push(ma - mb);
  }
  if (diffs.length < 100) return null;
  diffs.sort((x, y) => x - y);
  return [
    diffs[Math.floor(0.025 * diffs.length)]!,
    diffs[Math.floor(0.975 * diffs.length)]!,
  ];
}
