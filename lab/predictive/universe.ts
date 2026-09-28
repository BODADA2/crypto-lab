/**
 * Protocole partagé du programme prédictif (2026-09-28).
 *
 * Règles anti-overfitting :
 * - Univers DISJOINTS par hash du mint : discovery (<50), calibration (50-74),
 *   holdout gelé (>=75). Le holdout ne sert qu'à la mesure OOS FINALE, une fois
 *   la calibration verrouillée. Ne jamais re-calibrer après avoir vu le holdout.
 * - t0 = premier snapshot avec liquidityUsd >= 20 000 et priceUsd > 0.
 * - Filtre anti-tick-aberrant : un tick dont le prix est >=100x ET <=1/100 du
 *   prix des deux voisins est marqué corrompu (cf. glitch SKHY +4 939 704 %).
 * - Y_H = rendement futur (prix nettoyé) sur horizon H ; null si l'horizon
 *   n'est pas couvert par la série (pas d'extrapolation).
 * - Données data/history/ et data/scans/ biaisées vers les tokens chauds :
 *   toute mesure = borne OPTIMISTE, à déclarer.
 */
import type { TokenSnapshot } from "../types.ts";

export type Universe = "discovery" | "calibration" | "holdout";

/** FNV-1a 32 bits, déterministe. */
export function hashMint(mint: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < mint.length; i++) {
    h ^= mint.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Répartition déterministe 50 / 25 / 25. */
export function splitUniverse(mint: string): Universe {
  const b = hashMint(mint) % 100;
  if (b < 50) return "discovery";
  if (b < 75) return "calibration";
  return "holdout";
}

export const MIN_LIQUIDITY_USD = 20_000;

/** Indice t0 : premier snapshot avec liquidité >= seuil et prix > 0. -1 si absent. */
export function findT0(series: TokenSnapshot[]): number {
  const s = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  return s.findIndex((x) => x.priceUsd > 0 && x.liquidityUsd >= MIN_LIQUIDITY_USD);
}

/**
 * Marque les ticks aberrants : prix >=100x le max des deux voisins
 * ou <=1/100 du min des deux voisins (et voisins > 0).
 */
export function aberrantMask(series: TokenSnapshot[]): boolean[] {
  const s = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const mask = new Array<boolean>(s.length).fill(false);
  for (let i = 1; i < s.length - 1; i++) {
    const p = s[i]!.priceUsd;
    const pl = s[i - 1]!.priceUsd;
    const pr = s[i + 1]!.priceUsd;
    if (p > 0 && pl > 0 && pr > 0) {
      if (p >= 100 * Math.max(pl, pr) || p <= Math.min(pl, pr) / 100) mask[i] = true;
    }
  }
  return mask;
}

export interface FutureReturn {
  horizonMs: number;
  ret: number;
  entryPrice: number;
  exitPrice: number;
}

/**
 * Rendements futurs depuis t0 sur les horizons donnés (prix nettoyés des
 * ticks aberrants). Horizons non couverts => absents du résultat.
 */
export function futureReturns(
  series: TokenSnapshot[],
  horizonsMs: number[],
): FutureReturn[] {
  const s = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0 = findT0(s);
  if (t0 < 0) return [];
  const mask = aberrantMask(s);
  const t0Time = Date.parse(s[t0]!.fetchedAt);
  const entryPrice = s[t0]!.priceUsd;
  const out: FutureReturn[] = [];
  for (const h of horizonsMs) {
    const target = t0Time + h;
    // Premier snapshot >= target avec prix valide et non aberrant.
    const idx = s.findIndex(
      (x, i) => i > t0 && !mask[i] && x.priceUsd > 0 && Date.parse(x.fetchedAt) >= target,
    );
    if (idx < 0) continue;
    const exitPrice = s[idx]!.priceUsd;
    out.push({ horizonMs: h, ret: exitPrice / entryPrice - 1, entryPrice, exitPrice });
  }
  return out;
}

/** Horizons standards (ms). Les séries courtes (~12 ticks/mint) limiteront la couverture. */
export const HORIZONS_MS = [3_600_000, 6 * 3_600_000, 24 * 3_600_000];
export const HORIZON_LABELS = ["1h", "6h", "24h"];

/** Déciles d'une variable : seuils + assignation. */
export function deciles(values: number[]): { thresholds: number[]; bin: (v: number) => number } {
  const sorted = [...values].sort((a, b) => a - b);
  const thresholds: number[] = [];
  for (let d = 1; d < 10; d++) {
    thresholds.push(sorted[Math.min(sorted.length - 1, Math.floor((d / 10) * sorted.length))]!);
  }
  return {
    thresholds,
    bin: (v: number) => {
      let b = 0;
      for (const t of thresholds) if (v > t) b++;
      return Math.min(b, 9);
    },
  };
}

/** Corrélation de rang de Spearman (robuste aux outliers). */
export function spearman(xs: number[], ys: number[]): number | null {
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
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** Médiane. */
export function median(a: number[]): number | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** IC95 % bootstrap (percentiles) de la moyenne. */
export function bootstrapCI(
  a: number[],
  reps = 2000,
  seed = 42,
): [number, number] | null {
  if (a.length < 10) return null;
  let s = seed;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const means: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[Math.floor(rnd() * a.length)]!;
    means.push(sum / a.length);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(0.025 * reps)]!, means[Math.floor(0.975 * reps)]!];
}
