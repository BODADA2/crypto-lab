/**
 * SPRINT 2D — Famille A (Avoidance / No-trade) : métriques de valeur d'évitement.
 *
 * Protocole (non négociable) :
 * - Univers DISCOVERY uniquement (splitUniverse hash < 50). Le holdout (>=75)
 *   n'est JAMAIS lu — même en lecture diagnostique. La calibration (50-74)
 *   n'est pas utilisée non plus (« DISCOVERY uniquement »).
 * - SKHY exclu (glitch décimal, cf. rule.ts).
 * - Données data/history/ biaisées vers les tokens chauds : toute mesure =
 *   borne OPTIMISTE, déclarée dans chaque rapport.
 * - Lecture seule sur data/ (aucune écriture).
 * - t0 = findT0 (protocole partagé) ; ticks aberrants masqués pour Y et le
 *   drawdown (aberrantMask du protocole).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenSnapshot } from "../../types.ts";
import {
  aberrantMask,
  findT0,
  futureReturns,
  HORIZONS_MS,
  median,
  splitUniverse,
} from "../../predictive/universe.ts";
import {
  combinedAvoid,
  evaluateFilters,
  EXCLUDED_MINTS,
  FILTERS,
  POINT_LABELS,
  thresholdsForPoint,
  type FilterFlags,
  type FilterId,
  type FilterVariable,
  type ThresholdSet,
} from "./rule.ts";

const HOUR_MS = 3_600_000;
const RUNNER_THRESHOLD = 1.0; // Y >= +100 % = « runner »

/** Une ligne = un token discovery, variables à t0 (≤ t0ms), labels futurs. */
export interface AvoidanceRow {
  mint: string;
  dexId: string;
  t0Date: string;
  t0Time: number;
  sellsM5: number | null;
  turnoverM5: number | null;
  liqT0: number | null;
  y1h: number | null;
  y6h: number | null;
  ddMax24h: number | null;
}

function parseLine(line: string): TokenSnapshot | null {
  try {
    const d = JSON.parse(line) as TokenSnapshot;
    if (!d || typeof d.priceUsd !== "number") return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Drawdown maximal (excursion adverse max) depuis t0 sur 24 h :
 * min(p_i / p_t0 − 1) sur les snapshots post-t0 ≤ 24 h, prix nettoyés.
 * null si aucun snapshot post-t0 valide dans la fenêtre.
 */
export function drawdownMax24h(
  sorted: TokenSnapshot[],
  t0Idx: number,
  mask: boolean[],
): number | null {
  const entry = sorted[t0Idx]!.priceUsd;
  const t0ms = Date.parse(sorted[t0Idx]!.fetchedAt);
  if (!(entry > 0)) return null;
  let worst = 0;
  let found = false;
  for (let i = t0Idx + 1; i < sorted.length; i++) {
    const dt = Date.parse(sorted[i]!.fetchedAt) - t0ms;
    if (dt > 24 * HOUR_MS) break;
    if (mask[i] || sorted[i]!.priceUsd <= 0) continue;
    worst = Math.min(worst, sorted[i]!.priceUsd / entry - 1);
    found = true;
  }
  return found ? worst : null;
}

function featuresAtT0(sorted: TokenSnapshot[], t0: number): {
  sellsM5: number | null;
  turnoverM5: number | null;
  liqT0: number | null;
} {
  const snap = sorted[t0]!;
  const sellsM5 = snap.txns?.m5?.sells ?? null;
  const volM5 = snap.volume?.m5 ?? null;
  const liqRaw = snap.liquidityUsd;
  const liqT0 = liqRaw > 0 ? liqRaw : null;
  const turnoverM5 = liqT0 !== null && volM5 !== null ? volM5 / liqT0 : null;
  return { sellsM5, turnoverM5, liqT0 };
}

/**
 * Charge les lignes discovery depuis data/history (lecture seule).
 * Le holdout et la calibration ne sont jamais ouverts.
 */
export function loadDiscoveryRows(historyDir: string): AvoidanceRow[] {
  const rows: AvoidanceRow[] = [];
  for (const f of readdirSync(historyDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const mint = f.replace(/\.jsonl$/, "");
    if (EXCLUDED_MINTS.has(mint)) continue;
    if (splitUniverse(mint) !== "discovery") continue; // holdout/calibration : jamais lus
    const series: TokenSnapshot[] = [];
    for (const line of readFileSync(join(historyDir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const s = parseLine(line);
      if (s) series.push(s);
    }
    if (series.length === 0) continue;
    const sorted = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    const t0 = findT0(sorted);
    if (t0 < 0) continue;
    const mask = aberrantMask(sorted);
    const feats = featuresAtT0(sorted, t0);
    const fr = futureReturns(sorted, [...HORIZONS_MS]);
    const yOf = (h: number): number | null => fr.find((r) => r.horizonMs === h)?.ret ?? null;
    rows.push({
      mint,
      dexId: String(sorted[t0]!.dexId ?? "unknown"),
      t0Date: sorted[t0]!.fetchedAt,
      t0Time: Date.parse(sorted[t0]!.fetchedAt),
      sellsM5: feats.sellsM5,
      turnoverM5: feats.turnoverM5,
      liqT0: feats.liqT0,
      y1h: yOf(HORIZONS_MS[0]!),
      y6h: yOf(HORIZONS_MS[1]!),
      ddMax24h: drawdownMax24h(sorted, t0, mask),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Statistiques                                                        */
/* ------------------------------------------------------------------ */

/**
 * Test de Mann-Whitney U (approximation normale avec correction des ex-aequo),
 * bilatéral. Retourne { U, p }. p = null si n < 8 dans un groupe.
 */
export function mannWhitney(a: number[], b: number[]): { U: number; p: number | null } {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 8 || n2 < 8) return { U: NaN, p: null };
  const all = [...a.map((v) => ({ v, g: 1 })), ...b.map((v) => ({ v, g: 2 }))].sort(
    (x, y) => x.v - y.v,
  );
  const ranks = new Array<number>(all.length);
  let i = 0;
  let tieCorr = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    const t = j - i + 1;
    if (t > 1) tieCorr += t * t * t - t;
    i = j + 1;
  }
  let r1 = 0;
  for (let k = 0; k < all.length; k++) if (all[k]!.g === 1) r1 += ranks[k]!;
  const U1 = r1 - (n1 * (n1 + 1)) / 2;
  const U = Math.min(U1, n1 * n2 - U1);
  const N = n1 + n2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (N + 1)) / 12 - (n1 * n2 * tieCorr) / (12 * N * (N - 1)));
  if (sigma === 0) return { U, p: null };
  const z = (U - mu + 0.5 * Math.sign(U - mu)) / sigma; // correction de continuité
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { U, p };
}

/** CDF normale standard (approximation d'Abramowitz-Stegun). */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - p;
}

/** IC95 % bootstrap (percentiles) d'une statistique sur l'échantillon complet. */
export function bootstrapStatCI(
  sample: number[],
  stat: (s: number[]) => number,
  reps = 1000,
  seed = 20260928,
): [number, number] | null {
  if (sample.length < 10) return null;
  let s = seed;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const boot: number[] = [];
    for (let k = 0; k < sample.length; k++) boot.push(sample[Math.floor(rnd() * sample.length)]!);
    vals.push(stat(boot));
  }
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(0.025 * reps)]!, vals[Math.floor(0.975 * reps)]!];
}

/* ------------------------------------------------------------------ */
/* Mesure d'évitement                                                  */
/* ------------------------------------------------------------------ */

export type Horizon = "1h" | "6h";

/** Identifiant d'une « expérience filtre » : un filtre seul ou la règle combinée. */
export type FilterScope = FilterId | "COMBINED";

export interface CohortSlice {
  name: string;
  n: number;
  lossAvoidedMed: number | null;
}

export interface AvoidanceMetrics {
  scope: FilterScope;
  horizon: Horizon;
  point: (typeof POINT_LABELS)[number];
  thresholds: Partial<ThresholdSet>;
  nAll: number;
  nFlag: number;
  nKeep: number;
  pctAvoided: number | null;
  medianYAll: number | null;
  medianYKeep: number | null;
  medianYFlag: number | null;
  /** Perte médiane évitée (points) = médiane(keep) − médiane(all). >0 = utile. */
  lossAvoidedMed: number | null;
  meanYAll: number | null;
  meanYKeep: number | null;
  lossAvoidedMean: number | null;
  p10All: number | null;
  p10Keep: number | null;
  /** Perte de queue évitée (P10) = P10(keep) − P10(all). >0 = utile. */
  tailLossAvoided: number | null;
  ddMedAll: number | null;
  ddMedKeep: number | null;
  /** Drawdown évité = médiane dd(keep) − médiane dd(all). >0 = moins creusé. */
  ddAvoided: number | null;
  nWinners: number;
  fpWinners: number;
  /** % de gagnants (Y>0) filtrés par erreur — le coût du filtre. */
  fpWinnersPct: number | null;
  nRunners: number;
  fpRunners: number;
  /** % de runners (Y≥+100 %) filtrés par erreur. */
  fpRunnersPct: number | null;
  mwU: number;
  mwP: number | null;
  ciLo: number | null;
  ciHi: number | null;
  cohortStability: CohortSlice[];
  timeStability: CohortSlice[];
}

function p10(a: number[]): number | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(0.1 * s.length))]!;
}

function mean(a: number[]): number | null {
  if (a.length === 0) return null;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function flaggedSet(
  scope: FilterScope,
  feats: Record<FilterVariable, number | null>,
  thresholds: ThresholdSet,
): boolean {
  const flags = evaluateFilters(feats, thresholds);
  return scope === "COMBINED" ? combinedAvoid(flags) : flags[scope];
}

/**
 * Mesure la valeur d'évitement d'un filtre (ou de la règle combinée) sur un
 * horizon. Les seuils sont pré-calculés intra-discovery (thresholdsForPoint).
 */
export function measureAvoidance(
  rows: AvoidanceRow[],
  scope: FilterScope,
  horizon: Horizon,
  point: (typeof POINT_LABELS)[number],
  thresholds: ThresholdSet,
): AvoidanceMetrics {
  const yKey = horizon === "1h" ? "y1h" : "y6h";
  // Seuls les tokens avec variable du filtre (si filtre seul) + Y disponibles.
  const neededVar: FilterVariable | null =
    scope === "COMBINED" ? null : FILTERS.find((f) => f.id === scope)!.variable;
  const eligible = rows.filter(
    (r) => r[yKey] !== null && (neededVar === null || r[neededVar] !== null),
  );
  const flagOf = (r: AvoidanceRow): boolean =>
    flaggedSet(
      scope,
      { sellsM5: r.sellsM5, turnoverM5: r.turnoverM5, liqT0: r.liqT0 },
      thresholds,
    );
  const flaggedRows = eligible.filter(flagOf);
  const keptRows = eligible.filter((r) => !flagOf(r));
  const yAll = eligible.map((r) => r[yKey]!);
  const yKeep = keptRows.map((r) => r[yKey]!);
  const yFlag = flaggedRows.map((r) => r[yKey]!);

  const medAll = median(yAll);
  const medKeep = median(yKeep);
  const medFlag = median(yFlag);
  const p10All = p10(yAll);
  const p10Keep = p10(yKeep);
  const ddAll = eligible.map((r) => r.ddMax24h).filter((v): v is number => v !== null);
  const ddKeep = keptRows.map((r) => r.ddMax24h).filter((v): v is number => v !== null);
  const ddMedAll = median(ddAll);
  const ddMedKeep = median(ddKeep);

  const winners = eligible.filter((r) => r[yKey]! > 0);
  const fpW = winners.filter(flagOf);
  const runners = eligible.filter((r) => r[yKey]! >= RUNNER_THRESHOLD);
  const fpR = runners.filter(flagOf);

  const { U, p } = mannWhitney(yFlag, yKeep);

  // IC95 % bootstrap de la perte médiane évitée : rééchantillonne les paires
  // (flag, y) pour garder le lien flag↔rendement, recalcule médiane(keep) −
  // médiane(all) à chaque réplique.
  const pairs = eligible.map((r) => ({ f: flagOf(r), y: r[yKey]! }));
  const ci = bootstrapStatCI(
    pairs.map((_, i) => i),
    (idx) => {
      const ys = idx.map((k) => pairs[k]!.y);
      const ks = idx.map((k) => (pairs[k]!.f ? null : pairs[k]!.y)).filter((v): v is number => v !== null);
      const mAll = median(ys);
      const mKeep = median(ks);
      return mAll !== null && mKeep !== null ? mKeep - mAll : NaN;
    },
  );

  // Stabilité par cohorte (dex) et par temps (moitiés de t0).
  const cohortStability = cohortSlices(eligible, yKey, flagOf, (r) =>
    r.dexId === "pumpswap" ? "pumpswap" : r.dexId === "raydium" ? "raydium" : "autre",
  );
  const times = eligible.map((r) => r.t0Time).sort((a, b) => a - b);
  const tMid = times.length ? times[Math.floor(times.length / 2)]! : 0;
  const timeStability = cohortSlices(eligible, yKey, flagOf, (r) =>
    r.t0Time <= tMid ? "1re moitié" : "2e moitié",
  );

  const thrShown: Partial<ThresholdSet> =
    scope === "COMBINED" ? { ...thresholds } : { [scope]: thresholds[scope] } as Partial<ThresholdSet>;

  return {
    scope,
    horizon,
    point,
    thresholds: thrShown,
    nAll: eligible.length,
    nFlag: flaggedRows.length,
    nKeep: keptRows.length,
    pctAvoided: eligible.length ? flaggedRows.length / eligible.length : null,
    medianYAll: medAll,
    medianYKeep: medKeep,
    medianYFlag: medFlag,
    lossAvoidedMed: medAll !== null && medKeep !== null ? medKeep - medAll : null,
    meanYAll: mean(yAll),
    meanYKeep: mean(yKeep),
    lossAvoidedMean:
      mean(yAll) !== null && mean(yKeep) !== null ? mean(yKeep)! - mean(yAll)! : null,
    p10All,
    p10Keep,
    tailLossAvoided: p10All !== null && p10Keep !== null ? p10Keep - p10All : null,
    ddMedAll,
    ddMedKeep,
    ddAvoided: ddMedAll !== null && ddMedKeep !== null ? ddMedKeep - ddMedAll : null,
    nWinners: winners.length,
    fpWinners: fpW.length,
    fpWinnersPct: winners.length ? fpW.length / winners.length : null,
    nRunners: runners.length,
    fpRunners: fpR.length,
    fpRunnersPct: runners.length ? fpR.length / runners.length : null,
    mwU: U,
    mwP: p,
    ciLo: ci ? ci[0] : null,
    ciHi: ci ? ci[1] : null,
    cohortStability,
    timeStability,
  };
}

function cohortSlices(
  eligible: AvoidanceRow[],
  yKey: "y1h" | "y6h",
  flagOf: (r: AvoidanceRow) => boolean,
  groupOf: (r: AvoidanceRow) => string,
): CohortSlice[] {
  const groups = new Map<string, AvoidanceRow[]>();
  for (const r of eligible) {
    const g = groupOf(r);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(r);
  }
  return [...groups.entries()].map(([name, rs]) => {
    const ys = rs.map((r) => r[yKey]!);
    const ks = rs.filter((r) => !flagOf(r)).map((r) => r[yKey]!);
    const mAll = median(ys);
    const mKeep = median(ks);
    return {
      name,
      n: rs.length,
      lossAvoidedMed: mAll !== null && mKeep !== null ? mKeep - mAll : null,
    };
  });
}

/** Seuils intra-discovery pour un point de sensibilité donné. */
export function discoveryThresholds(rows: AvoidanceRow[], point: 0 | 1 | 2): ThresholdSet {
  const vals: Record<FilterVariable, number[]> = {
    sellsM5: rows.map((r) => r.sellsM5).filter((v): v is number => v !== null),
    turnoverM5: rows.map((r) => r.turnoverM5).filter((v): v is number => v !== null),
    liqT0: rows.map((r) => r.liqT0).filter((v): v is number => v !== null),
  };
  return thresholdsForPoint(vals, point);
}
