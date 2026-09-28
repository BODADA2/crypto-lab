/**
 * SPRINT 2C — famille E : corrélation des outcomes entre mints partageant
 * un early buyer récurrent (hypothèse H-S2C-E1).
 *
 * Question : deux mints qui partagent un early buyer récurrent ont-ils des
 * outcomes plus proches que deux mints tirés au hasard ?
 *
 * Méthode : paires ordonnées (a, b) avec t0a < t0b partageant ≥1 wallet w
 * tel que w était récurrent-as-of-t0b (≥1 autre mint avec t0 < t0b).
 * Statistique = moyenne de |y1h_a − y1h_b| (et part de paires avec même
 * survival_50). Distribution nulle = permutation des labels sur les mints
 * (paires fixes, outcomes mélangés, 2000 reps).
 *
 * Réflexe SUSPICION : si une petite cohorte montre une corrélation parfaite,
 * la documenter comme anomalie (mystery queue), pas comme un signal.
 */
import type { MintSet } from "./incidence.ts";
import { rng, mean } from "./statsx.ts";

export interface SharedPair {
  a: string;
  b: string;
  sharedWallets: string[];
  t0a: number;
  t0b: number;
}

export interface CorrResult {
  nPairs: number;
  nMintsInvolved: number;
  /** Paires avec y1h des deux côtés. */
  nPairsY1h: number;
  meanAbsDiffY1h: number | null;
  permP_Y1h: number | null;
  /** Paires avec survival_50 des deux côtés. */
  nPairsSurv: number;
  fracSameSurv: number | null;
  permP_surv: number | null;
  /** Cohortes suspectes : wallet partagé par ≥3 mints (déjà-vu). */
  cohorts: Array<{ wallet: string; mints: string[]; surv: Array<boolean | null> }>;
}

/**
 * Construit les paires (a,b) partageant un wallet récurrent-as-of-t0b.
 * `buyerMints` : wallet → mints (pré-t0, discovery).
 */
export function buildSharedPairs(
  sets: MintSet[],
  buyerMints: Map<string, string[]>,
  t0: Map<string, number>,
  recurrentByMint: Map<string, Set<string>>,
): SharedPair[] {
  const pairs: SharedPair[] = [];
  const sorted = [...sets].sort((x, y) => x.t0ms - y.t0ms);
  void sorted;
  for (const [wallet, mints] of buyerMints) {
    const chron = [...new Set(mints)].sort((x, y) => t0.get(x)! - t0.get(y)!);
    for (let i = 0; i < chron.length; i++) {
      for (let j = i + 1; j < chron.length; j++) {
        const a = chron[i]!;
        const b = chron[j]!;
        const recB = recurrentByMint.get(b);
        if (!recB?.has(wallet)) continue; // pas récurrent-as-of-t0b → ignoré
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        let p = pairs.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
        if (!p) {
          p = { a, b, sharedWallets: [], t0a: t0.get(a)!, t0b: t0.get(b)! };
          pairs.push(p);
        }
        if (!p.sharedWallets.includes(wallet)) p.sharedWallets.push(wallet);
      }
    }
  }
  return pairs;
}

/**
 * Permutation au niveau des mints : mélange les outcomes entre les mints
 * impliqués (paires fixes), recalcule la statistique à chaque rep.
 * Unilatéral "le" (stat petite = effet) ou "ge".
 */
function permuteMints<T>(
  pairs: SharedPair[],
  getOutcome: (mint: string) => T | null,
  stat: (pp: SharedPair[], get: (mint: string) => T | null) => number | null,
  reps: number,
  seed: number,
  side: "le" | "ge",
): number | null {
  const mints = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const obs = stat(pairs, getOutcome);
  if (obs == null || mints.length < 5) return null;
  const values = mints.map(getOutcome);
  const rnd = rng(seed);
  let extreme = 0;
  for (let r = 0; r < reps; r++) {
    const perm = [...values];
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [perm[i], perm[j]] = [perm[j]!, perm[i]!];
    }
    const get = (m: string): T | null => perm[mints.indexOf(m)] ?? null;
    const s = stat(pairs, get);
    if (s == null) continue;
    if (side === "le" ? s <= obs : s >= obs) extreme++;
  }
  return (extreme + 1) / (reps + 1);
}

export function outcomeCorrelation(
  pairs: SharedPair[],
  y1hOf: Map<string, number | null>,
  survivalOf: Map<string, boolean | null>,
  buyerMints: Map<string, string[]>,
): CorrResult {
  const y = (m: string) => y1hOf.get(m) ?? null;
  const s = (m: string) => survivalOf.get(m);

  const yPairs = pairs.filter((p) => y(p.a) != null && y(p.b) != null);
  const diffs = yPairs.map((p) => Math.abs(y(p.a)! - y(p.b)!));
  const meanAbsDiffY1h = mean(diffs);
  // Permutation au niveau des mints : on mélange les outcomes entre mints
  // (paires fixes), puis on recalcule la statistique. Unilatéral : plus petit
  // = outcomes plus proches dans les paires partagées.
  const permP_Y1h = permuteMints(
    yPairs,
    (m) => y(m),
    (pp, get) => mean(pp.map((x) => Math.abs(get(x.a)! - get(x.b)!))),
    2000,
    7,
    "le",
  );

  const sPairs = pairs.filter((p) => s(p.a) != null && s(p.b) != null);
  const same = sPairs.map((p) => (s(p.a) === s(p.b) ? 1 : 0));
  const fracSameSurv = mean(same);
  const permP_surv = permuteMints(
    sPairs,
    (m) => s(m),
    (pp, get) => mean(pp.map((x) => (get(x.a) === get(x.b) ? 1 : 0))),
    2000,
    11,
    "ge",
  );

  const mintsInvolved = new Set<string>();
  for (const p of pairs) {
    mintsInvolved.add(p.a);
    mintsInvolved.add(p.b);
  }

  // Cohortes déjà-vu : wallet partagé par ≥3 mints.
  const cohorts: CorrResult["cohorts"] = [];
  for (const [wallet, mints] of buyerMints) {
    const u = [...new Set(mints)];
    if (u.length >= 3) {
      cohorts.push({
        wallet,
        mints: u.sort(),
        surv: u.map((m) => survivalOf.get(m) ?? null),
      });
    }
  }
  cohorts.sort((a, b) => b.mints.length - a.mints.length);

  return {
    nPairs: pairs.length,
    nMintsInvolved: mintsInvolved.size,
    nPairsY1h: yPairs.length,
    meanAbsDiffY1h,
    permP_Y1h,
    nPairsSurv: sPairs.length,
    fracSameSurv,
    permP_surv,
    cohorts: cohorts.slice(0, 15),
  };
}
