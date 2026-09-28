/**
 * SPRINT 1 (2026-09-28) — utilitaires partagés des 4 expériences de triage rapide.
 *
 * RÈGLES ANTI-OVERFITTING (non négociables) :
 * - DISCOVERY uniquement (splitUniverse : hash < 50). Le holdout (>=75)
 *   n'est JAMAIS lu — même en lecture diagnostique.
 * - Données data/history/ + data/scans/ biaisées vers les tokens chauds :
 *   toute mesure = borne OPTIMISTE, déclarée dans chaque rapport.
 * - n < 30 → NON_CONCLUSIF, jamais interprété.
 * - AUCUNE stratégie construite : mesures statistiques uniquement.
 * - Lecture seule sur data/ (aucune écriture dans data/).
 */
import { readdirSync, readFileSync } from "node:fs";
import type { TokenSnapshot } from "../types.ts";
import {
  aberrantMask,
  findT0,
  futureReturns,
  HORIZONS_MS,
  splitUniverse,
  type Universe,
} from "../predictive/universe.ts";

export { spearman, bootstrapCI, median, deciles } from "../predictive/universe.ts";

/* ------------------------------------------------------------------ */
/* Ligne t0 : features pré-t0 + labels (lecture seule)                 */
/* ------------------------------------------------------------------ */

/** Une ligne = un token, features mesurées à t0 (≤ t0ms), labels futurs. */
export interface T0Row {
  mint: string;
  universe: Universe;
  /** t0 en ms (premier snapshot liquidityUsd>=20000, priceUsd>0). */
  t0ms: number;
  /** Jour calendaire UTC du t0 (YYYY-MM-DD). */
  t0day: string;
  dexId: string | null;
  /** Liquidité USD à t0. */
  liqT0: number;
  /** Turnover = volume / liquidité à t0 (m5 et h1), null si non calculable. */
  turnoverM5: number | null;
  turnoverH1: number | null;
  /** Activité m5 à t0 (signal « frénésie » de H-PRED-FLOW-01 = sellsM5). */
  sellsM5: number;
  buysM5: number;
  volM5: number;
  priceChgM5: number;
  y1h: number | null;
  y6h: number | null;
  y24h: number | null;
  ddMax24h: number | null;
  dd50_24h: boolean | null;
}

/** Série triée par fetchedAt croissant (tolérant aux lignes invalides). */
export function readSeries(mint: string): TokenSnapshot[] | null {
  let raw: string;
  try {
    raw = readFileSync(`data/history/${mint}.jsonl`, "utf-8");
  } catch {
    return null;
  }
  const out: TokenSnapshot[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const s = JSON.parse(t) as TokenSnapshot;
      if (s && typeof s.fetchedAt === "string") out.push(s);
    } catch {
      /* ligne corrompue ignorée */
    }
  }
  if (out.length === 0) return null;
  out.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  return out;
}

export function listHistoryMints(): string[] {
  return readdirSync("data/history")
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}

function t0RowFromSeries(
  mint: string,
  universe: Universe,
  s: TokenSnapshot[],
): T0Row | null {
  const t0 = findT0(s);
  if (t0 < 0) return null;
  const snap = s[t0]!;
  const t0ms = Date.parse(snap.fetchedAt);
  const liq = snap.liquidityUsd;
  const vol = snap.volume;
  const tx = snap.txns;
  const turnover = (v: number | undefined): number | null =>
    v != null && liq > 0 ? v / liq : null;
  const fr = futureReturns(s, HORIZONS_MS);
  const y = new Map<number, number>(fr.map((r) => [r.horizonMs, r.ret]));
  const y1h = y.get(HORIZONS_MS[0]!) ?? null;
  const y6h = y.get(HORIZONS_MS[1]!) ?? null;
  const y24h = y.get(HORIZONS_MS[2]!) ?? null;

  // Drawdown max sur (t0, t0+24h], ticks aberrants ignorés (même règle que labels.ts).
  const mask = aberrantMask(s);
  const inWindow: number[] = [];
  for (let i = t0 + 1; i < s.length; i++) {
    const t = Date.parse(s[i]!.fetchedAt);
    if (t <= t0ms || t > t0ms + 24 * 3_600_000) continue;
    if (mask[i]) continue;
    const p = s[i]!.priceUsd;
    if (p <= 0) continue;
    inWindow.push(p / snap.priceUsd - 1);
  }
  const ddMax24h = inWindow.length >= 3 ? Math.min(...inWindow) : null;
  const dd50_24h = ddMax24h == null ? null : ddMax24h <= -0.5;

  return {
    mint,
    universe,
    t0ms,
    t0day: new Date(t0ms).toISOString().slice(0, 10),
    dexId: (snap as { dexId?: string | null }).dexId ?? null,
    liqT0: liq,
    turnoverM5: turnover(vol?.m5),
    turnoverH1: turnover(vol?.h1),
    sellsM5: tx?.m5?.sells ?? 0,
    buysM5: tx?.m5?.buys ?? 0,
    volM5: vol?.m5 ?? 0,
    priceChgM5: snap.priceChange?.m5 ?? 0,
    y1h,
    y6h,
    y24h,
    ddMax24h,
    dd50_24h,
  };
}

/**
 * Charge toutes les lignes t0 de l'univers demandé (défaut : discovery).
 * Mint SKHY (glitch DexScreener connu) exclu — cf. labels.ts DATA_ERROR_MINTS.
 */
export function loadT0Rows(universe: Universe = "discovery"): T0Row[] {
  const out: T0Row[] = [];
  for (const mint of listHistoryMints()) {
    if (mint === "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3") continue;
    if (splitUniverse(mint) !== universe) continue;
    const s = readSeries(mint);
    if (!s) continue;
    const row = t0RowFromSeries(mint, universe, s);
    if (row) out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Survie : temps jusqu'au premier passage sous -50 % (événement)      */
/* ------------------------------------------------------------------ */

export interface SurvivalPoint {
  /** Durée en heures jusqu'à l'événement ou la censure (> 0). */
  durationH: number;
  /** true = passage sous -50 % observé ; false = censuré. */
  event: boolean;
}

/**
 * Temps de survie d'une série : premier tick post-t0 (non aberrant) avec
 * prix/t0price - 1 <= -0.5 → événement ; sinon censure au min(24h, dernier
 * tick). Exige ≥ 3 ticks post-t0 dans la fenêtre 24h (même garde que
 * labels.ts ddMax24h) : null sinon (pas d'info de survie fiable).
 */
export function survivalTimes(s: TokenSnapshot[]): SurvivalPoint | null {
  const t0 = findT0(s);
  if (t0 < 0) return null;
  const t0ms = Date.parse(s[t0]!.fetchedAt);
  const t0price = s[t0]!.priceUsd;
  if (t0price <= 0) return null;
  const mask = aberrantMask(s);
  let nTicks = 0;
  let lastH = 0;
  for (let i = t0 + 1; i < s.length; i++) {
    const t = Date.parse(s[i]!.fetchedAt);
    if (t <= t0ms || t > t0ms + 24 * 3_600_000) continue;
    if (mask[i]) continue;
    const p = s[i]!.priceUsd;
    if (p <= 0) continue;
    nTicks++;
    const h = (t - t0ms) / 3_600_000;
    lastH = Math.max(lastH, h);
    if (p / t0price - 1 <= -0.5) return { durationH: h, event: true };
  }
  if (nTicks < 3 || lastH <= 0) return null;
  return { durationH: Math.min(lastH, 24), event: false };
}

/* ------------------------------------------------------------------ */
/* Statistiques utilitaires                                            */
/* ------------------------------------------------------------------ */

/** Jaccard entre deux sets de wallets (0 si les deux vides). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Test d'égalité de deux corrélations via la transformée z de Fisher.
 * Retourne z et p bilatérale. n < 4 → p = NaN (non testable).
 */
export function fisherZDiff(
  r1: number,
  n1: number,
  r2: number,
  n2: number,
): { z: number; p: number } {
  if (n1 < 4 || n2 < 4) return { z: NaN, p: NaN };
  const clamp = (r: number) => Math.max(-0.999999, Math.min(0.999999, r));
  const z1 = 0.5 * Math.log((1 + clamp(r1)) / (1 - clamp(r1)));
  const z2 = 0.5 * Math.log((1 + clamp(r2)) / (1 - clamp(r2)));
  const se = Math.sqrt(1 / (n1 - 3) + 1 / (n2 - 3));
  const z = (z1 - z2) / se;
  // Φ via erf (Abramowitz & Stegun 7.1.26).
  const erf = (x: number): number => {
    const s = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y =
      1 -
      (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
        t +
        0.254829592) *
        t) *
        Math.exp(-ax * ax);
    return s * y;
  };
  const phi = (v: number) => 0.5 * (1 + erf(v / Math.SQRT2));
  const p = 2 * (1 - phi(Math.abs(z)));
  return { z, p };
}

/** Z-scores d'une série (écart-type population). NaN si variance nulle. */
export function zscore(xs: number[]): number[] {
  const n = xs.length;
  if (n === 0) return [];
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / n;
  if (v <= 0) return xs.map(() => NaN);
  const sd = Math.sqrt(v);
  return xs.map((x) => (x - m) / sd);
}

/** Tercile d'un score : 1 = bas, 3 = haut (seuils = 33e/66e percentiles). */
export function assignTercile(
  score: number,
  t1: number,
  t2: number,
): 1 | 2 | 3 {
  if (score <= t1) return 1;
  if (score <= t2) return 2;
  return 3;
}

/** Percentile (interpolation linéaire) d'un tableau trié. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** p-value bilatérale approximative d'un Spearman (approximation t). */
export function spearmanP(r: number, n: number): number {
  if (n < 3) return NaN;
  const rc = Math.max(-0.9999999, Math.min(0.9999999, r));
  const t = (rc * Math.sqrt(n - 2)) / Math.sqrt(1 - rc * rc);
  // Approximation normale de la loi t (n≥30 : erreur négligeable).
  const erf = (x: number): number => {
    const s = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const tt = 1 / (1 + 0.3275911 * ax);
    const y =
      1 -
      (((((1.061405429 * tt - 1.453152027) * tt + 1.421413741) * tt -
        0.284496736) *
        tt +
        0.254829592) *
        tt) *
        Math.exp(-ax * ax);
    return s * y;
  };
  const phi = (v: number) => 0.5 * (1 + erf(v / Math.SQRT2));
  return 2 * (1 - phi(Math.abs(t)));
}
