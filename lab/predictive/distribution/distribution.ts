/**
 * Domaine 4/5 — DISTRIBUTION (concentration des holders).
 * Programme prédictif, phase DÉCOUVERTE.
 *
 * Ce module construit les lignes d'analyse X(t0) → Y(horizons) pour les
 * variables de distribution, SANS construire de stratégie :
 *  - top10Pct à t0 (part du top 10 ; 100 = inconnu dans data/history)
 *  - holders à t0 (souvent null)
 *  - évolution de top10Pct entre pré-t0 et t0
 *  - jointure data/tokens (top10Pct mesuré au dernier tick ; flag alignedT0)
 *  - métriques early buyers (top5_share, gini, same_slot_max) via data/earlybuyers/
 *
 * Règles du protocole (lab/predictive/universe.ts) :
 *  - univers DISJOINTS par hash FNV : discovery / calibration / holdout gelé.
 *  - t0 = premier snapshot avec liquidityUsd >= 20 000 et priceUsd > 0.
 *  - ticks aberrants (glitch ≥100×) exclus du calcul de Y.
 *  - n ≥ 30 pour toute conclusion. Résultat principal AVEC les outliers valides ;
 *    analyse de sensibilité SANS outliers valides (Y hors [P1, P99], convention
 *    partagée avec le domaine temporal).
 *  - data/history/ biaisée vers les tokens chauds ⇒ toute mesure = borne OPTIMISTE.
 */
import {
  aberrantMask,
  bootstrapCI,
  deciles,
  findT0,
  futureReturns,
  HORIZONS_MS,
  HORIZON_LABELS,
  median,
  spearman,
  splitUniverse,
  type Universe,
} from "../universe.ts";
import type { TokenSnapshot } from "../../types.ts";

/** Codage explicite de « concentration inconnue » dans les snapshots. */
export const UNKNOWN_TOP10 = 100;

/** Seuils de conclusion. */
export const MIN_N_CONCLUSION = 30;
export const MIN_N_DECILE = 20;

/** Labels des horizons, alignés sur HORIZONS_MS. */
export const HORIZON_LABELS_EXPORT = HORIZON_LABELS;

/** Ligne d'analyse d'un mint : X à t0, Y par horizon. */
export interface T0Row {
  mint: string;
  universe: Universe;
  t0FetchedAt: string;
  /** top10Pct à t0 ; null si inconnu (100) ou absent. */
  top10Pct: number | null;
  /** top10Pct au dernier tick avant t0 avec valeur connue ; null si aucun. */
  top10PctPreT0: number | null;
  /** Nombre de holders à t0 ; null si non collecté. */
  holders: number | null;
  /** Ratio sells/(buys+sells) à t0 (fenêtre h1, repli h24 puis m5) ; proxy auxiliaire de pression vendeuse. */
  sellRatioT0: number | null;
  buysT0: number | null;
  sellsT0: number | null;
  /** Rendements futurs nettoyés (ticks aberrants exclus), null si horizon non couvert. */
  y: (number | null)[];
  aberrantTicks: number;
  seriesTicks: number;
}

function knownTop10(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v < UNKNOWN_TOP10 ? v : null;
}

function sellRatio(snap: TokenSnapshot): { ratio: number | null; buys: number | null; sells: number | null } {
  const tx = (snap as unknown as { txns?: Record<string, { buys?: number; sells?: number }> }).txns ?? {};
  for (const w of ["h1", "h24", "m5"]) {
    const win = tx[w];
    const b = win?.buys ?? 0;
    const s = win?.sells ?? 0;
    if (b + s > 0) return { ratio: s / (b + s), buys: b, sells: s };
  }
  return { ratio: null, buys: null, sells: null };
}

/** Construit la ligne T0Row d'une série. null si aucun t0 valide. */
export function buildT0Row(mint: string, series: TokenSnapshot[]): T0Row | null {
  const s = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0 = findT0(s);
  if (t0 < 0) return null;
  const snap = s[t0]!;
  let preTop10: number | null = null;
  for (let i = t0 - 1; i >= 0; i--) {
    const v = knownTop10(s[i]!.top10Pct);
    if (v !== null) { preTop10 = v; break; }
  }
  const { ratio, buys, sells } = sellRatio(snap);
  const fr = futureReturns(s, HORIZONS_MS);
  const y = HORIZONS_MS.map((h) => fr.find((f) => f.horizonMs === h)?.ret ?? null);
  const mask = aberrantMask(s);
  return {
    mint,
    universe: splitUniverse(mint),
    t0FetchedAt: snap.fetchedAt,
    top10Pct: knownTop10(snap.top10Pct),
    top10PctPreT0: preTop10,
    holders: typeof snap.holders === "number" && Number.isFinite(snap.holders) ? snap.holders : null,
    sellRatioT0: ratio,
    buysT0: buys,
    sellsT0: sells,
    y,
    aberrantTicks: mask.filter(Boolean).length,
    seriesTicks: s.length,
  };
}

/** Entrée data/tokens/<mint>.json : top10Pct mesuré au DERNIER tick (pas à t0). */
export interface TokensTop10Entry {
  mint: string;
  fetchedAt: string;
  top10Pct: number | null;
  /** Vrai si le dernier tick (où top10Pct est mesuré) EST le tick t0. */
  alignedT0: boolean;
}

export function joinTokensTop10(
  mint: string,
  tokensEntry: { fetchedAt: string; top10Pct: unknown } | null,
  t0FetchedAt: string | null,
): TokensTop10Entry {
  return {
    mint,
    fetchedAt: tokensEntry?.fetchedAt ?? "",
    top10Pct: knownTop10(tokensEntry?.top10Pct),
    alignedT0: !!tokensEntry && !!t0FetchedAt && tokensEntry.fetchedAt === t0FetchedAt,
  };
}

/** Métriques early buyers (mesurées au lancement/migration, donc AVANT t0 en général). */
export interface EarlyBuyerMetrics {
  mint: string;
  universe: Universe;
  top5Share: number | null;
  gini: number | null;
  sameSlotMax: number | null;
  sellersOver50: number | null;
  coordinatedSells: number | null;
  walletsCovered: number | null;
  truncated: boolean;
}

export function parseEarlyBuyerMetrics(mint: string, raw: unknown): EarlyBuyerMetrics {
  const j = (raw ?? {}) as Record<string, unknown>;
  const m = (j.metrics ?? {}) as Record<string, unknown>;
  const sells = (j.sells ?? null) as Record<string, unknown> | null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    mint,
    universe: splitUniverse(mint),
    top5Share: num(m.top5_share),
    gini: num(m.gini),
    sameSlotMax: num(m.same_slot_max),
    sellersOver50: sells ? num(sells.sellersOver50) : null,
    coordinatedSells: sells ? num(sells.coordinated_sells) : null,
    walletsCovered: sells ? num(sells.walletsCovered) : null,
    truncated: j.truncated === true || (m.truncated as boolean) === true,
  };
}

/** Quantile (même convention que le domaine temporal). */
export function quantile(a: number[], q: number): number | null {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

/**
 * Retire les outliers valides : Y hors [P1, P99] de l'échantillon.
 * Sensibilité uniquement — le résultat principal garde TOUS les outliers valides.
 */
export function removeValidOutliers(xs: number[], ys: number[]): { xs: number[]; ys: number[]; removed: number } {
  const lo = quantile(ys, 0.01);
  const hi = quantile(ys, 0.99);
  if (lo === null || hi === null) return { xs, ys, removed: 0 };
  const xs2: number[] = [];
  const ys2: number[] = [];
  let removed = 0;
  for (let i = 0; i < ys.length; i++) {
    if (ys[i]! >= lo && ys[i]! <= hi) { xs2.push(xs[i]!); ys2.push(ys[i]!); }
    else removed++;
  }
  return { xs: xs2, ys: ys2, removed };
}

export interface DecileSummary {
  /** Médiane/moyenne de Y dans le décile BAS de X vs décile HAUT de X. */
  bottomN: number;
  bottomMedian: number | null;
  bottomMean: number | null;
  topN: number;
  topMedian: number | null;
  topMean: number | null;
  topCI: [number, number] | null;
  bottomCI: [number, number] | null;
}

export interface PairAnalysis {
  n: number;
  /** Corrélation de rang de Spearman (robuste aux outliers). */
  spearman: number | null;
  mean: number | null;
  medianY: number | null;
  ci: [number, number] | null;
  min: number | null;
  max: number | null;
  /** Part de Y <= -50 % (pertes extrêmes). */
  fracExtremeLoss: number | null;
  deciles: DecileSummary | null;
  /** Sensibilité sans outliers IQR. */
  trimmed: { n: number; removed: number; spearman: number | null; medianY: number | null } | null;
  conclusive: boolean;
}

const mean = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * Analyse X→Y : Spearman, déciles de X (top vs bottom), stats de Y.
 * conclusive = n >= MIN_N_CONCLUSION. Résultat principal AVEC outliers.
 */
export function analyzePair(xs: number[], ys: number[]): PairAnalysis {
  const n = xs.length;
  let dec: DecileSummary | null = null;
  if (n >= MIN_N_DECILE) {
    const d = deciles(xs);
    const bottom: number[] = [];
    const top: number[] = [];
    for (let i = 0; i < n; i++) {
      const b = d.bin(xs[i]!);
      if (b === 0) bottom.push(ys[i]!);
      if (b === 9) top.push(ys[i]!);
    }
    dec = {
      bottomN: bottom.length,
      bottomMedian: median(bottom),
      bottomMean: mean(bottom),
      topN: top.length,
      topMedian: median(top),
      topMean: mean(top),
      topCI: bootstrapCI(top),
      bottomCI: bootstrapCI(bottom),
    };
  }
  const trimmed = removeValidOutliers(xs, ys);
  return {
    n,
    spearman: spearman(xs, ys),
    mean: mean(ys),
    medianY: median(ys),
    ci: bootstrapCI(ys),
    min: n ? Math.min(...ys) : null,
    max: n ? Math.max(...ys) : null,
    fracExtremeLoss: n ? ys.filter((v) => v <= -0.5).length / n : null,
    deciles: dec,
    trimmed:
      trimmed.removed > 0
        ? {
            n: trimmed.ys.length,
            removed: trimmed.removed,
            spearman: spearman(trimmed.xs, trimmed.ys),
            medianY: median(trimmed.ys),
          }
        : null,
    conclusive: n >= MIN_N_CONCLUSION,
  };
}

/** Couverture d'une variable par univers : combien de lignes ont X ET Y(horizon) non nuls. */
export function coverageByUniverse(
  rows: { universe: Universe; x: number | null; y: (number | null)[] }[],
): Record<Universe, { xTotal: number; perHorizon: number[] }> {
  const out: Record<Universe, { xTotal: number; perHorizon: number[] }> = {
    discovery: { xTotal: 0, perHorizon: HORIZONS_MS.map(() => 0) },
    calibration: { xTotal: 0, perHorizon: HORIZONS_MS.map(() => 0) },
    holdout: { xTotal: 0, perHorizon: HORIZONS_MS.map(() => 0) },
  };
  for (const r of rows) {
    if (r.x === null) continue;
    const u = out[r.universe];
    u.xTotal++;
    r.y.forEach((v, i) => { if (v !== null) u.perHorizon[i] = (u.perHorizon[i] ?? 0) + 1; });
  }
  return out;
}

/** Split temporel en deux moitiés par t0 médian (stabilité temporelle). */
export function temporalHalves<T extends { t0FetchedAt: string }>(rows: T[]): { first: T[]; second: T[] } {
  const sorted = [...rows].sort((a, b) => a.t0FetchedAt.localeCompare(b.t0FetchedAt));
  const mid = Math.floor(sorted.length / 2);
  return { first: sorted.slice(0, mid), second: sorted.slice(mid) };
}

/** Baseline de Y : stats par horizon sur un ensemble de lignes (contexte). */
export function yBaseline(rows: { y: (number | null)[] }[]): {
  horizon: string;
  n: number;
  mean: number | null;
  medianY: number | null;
  ci: [number, number] | null;
  fracExtremeLoss: number | null;
}[] {
  return HORIZONS_MS.map((_, i) => {
    const ys = rows.map((r) => r.y[i]).filter((v): v is number => v !== null);
    return {
      horizon: HORIZON_LABELS[i]!,
      n: ys.length,
      mean: mean(ys),
      medianY: median(ys),
      ci: bootstrapCI(ys),
      fracExtremeLoss: ys.length ? ys.filter((v) => v <= -0.5).length / ys.length : null,
    };
  });
}
