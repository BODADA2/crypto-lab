/**
 * DOMAINE 3/5 — LIQUIDITY STRUCTURE (phase DÉCOUVERTE).
 *
 * Variables X candidates à t0 (ou sur la fenêtre pré-t0 quand disponible),
 * Y = rendement futur sur 1h/6h/24h depuis t0 (prix nettoyés des ticks aberrants).
 *
 * Données : data/history/*.jsonl — biaisées vers les tokens chauds
 * (borne OPTIMISTE, déclarée dans chaque rapport).
 * Holdout data/track-unbiased/ : JAMAIS utilisé ici (gelé).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenSnapshot } from "../../types.ts";
import {
  HORIZONS_MS,
  HORIZON_LABELS,
  aberrantMask,
  findT0,
  futureReturns,
  splitUniverse,
  type Universe,
} from "../universe.ts";

/** Toutes les variables X testées (null = non calculable pour ce token). */
export interface LiquidityFeatures {
  mint: string;
  universe: Universe;
  t0Time: number;
  t0Dex: string;
  nSnaps: number;
  nPre: number;
  /** Profondeur : liquidité USD à t0. */
  liqT0: number | null;
  /** Turnover : volume m5 / liquidité à t0. */
  turnoverM5: number | null;
  /** Turnover : volume h1 / liquidité à t0. */
  turnoverH1: number | null;
  /** Liquidité par unité de volume h1 (profondeur relative) = 1 / turnoverH1. */
  liqPerVolH1: number | null;
  /** Ratio marketCap / liquidité à t0. */
  mcLiq: number | null;
  /** Croissance relative de la liquidité sur la fenêtre pré-t0 (nPre>=2). */
  preGrowthRel: number | null;
  /** Pente de log(liquidité) vs temps (par heure) sur la fenêtre pré-t0 (nPre>=3). */
  liqSlopePre: number | null;
  /** Coefficient de variation de la liquidité pré-t0 (nPre>=2). */
  liqCVPre: number | null;
  /** Nombre d'AJOUTS (saut >= +50 %) entre snapshots pré-t0 consécutifs (nPre>=2). */
  addsPre: number | null;
  /** Nombre de RETRAITS (saut <= -50 %) entre snapshots pré-t0 consécutifs (nPre>=2). */
  removesPre: number | null;
  y: Record<string, number | null>;
}

export function varNames(): string[] {
  return [
    "liqT0",
    "turnoverM5",
    "turnoverH1",
    "liqPerVolH1",
    "mcLiq",
    "preGrowthRel",
    "liqSlopePre",
    "liqCVPre",
    "addsPre",
    "removesPre",
  ];
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

/** Charge une série depuis un fichier .jsonl, triée par fetchedAt. */
export function loadSeries(file: string): TokenSnapshot[] {
  const out: TokenSnapshot[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const s = parseLine(line);
    if (s) out.push(s);
  }
  out.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  return out;
}

/** Pente des moindres carrés de ys sur xs (par unité de x). */
export function slope(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

function mean(a: number[]): number {
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function std(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
}

/** Calcule les features d'un token à partir de sa série. null si pas de t0. */
export function computeFeatures(series: TokenSnapshot[]): LiquidityFeatures | null {
  if (series.length === 0) return null;
  const mint = series[0]!.mint;
  const t0Idx = findT0(series);
  if (t0Idx < 0) return null;
  const t0 = series[t0Idx]!;
  const liqT0 = t0.liquidityUsd > 0 ? t0.liquidityUsd : null;

  const volM5 = t0.volume?.m5 ?? 0;
  const volH1 = t0.volume?.h1 ?? 0;

  // Fenêtre pré-t0 : snapshots avec prix>0 et liquidité>0 avant t0.
  const pre = series.slice(0, t0Idx).filter((s) => s.priceUsd > 0 && s.liquidityUsd > 0);
  const nPre = pre.length;

  let preGrowthRel: number | null = null;
  let liqSlopePre: number | null = null;
  let liqCVPre: number | null = null;
  let addsPre: number | null = null;
  let removesPre: number | null = null;
  if (nPre >= 2) {
    const liqs = pre.map((s) => s.liquidityUsd);
    const first = liqs[0]!;
    const last = liqs[liqs.length - 1]!;
    preGrowthRel = first > 0 ? last / first - 1 : null;
    const m = mean(liqs);
    liqCVPre = m > 0 ? std(liqs) / m : null;
    let adds = 0;
    let removes = 0;
    for (let i = 1; i < liqs.length; i++) {
      const prev = liqs[i - 1]!;
      const cur = liqs[i]!;
      if (prev > 0) {
        const r = cur / prev;
        if (r >= 1.5) adds++;
        else if (r <= 0.5) removes++;
      }
    }
    addsPre = adds;
    removesPre = removes;
    if (nPre >= 3) {
      const t0ms = Date.parse(pre[0]!.fetchedAt);
      const xs = pre.map((s) => (Date.parse(s.fetchedAt) - t0ms) / 3_600_000);
      const ys = liqs.map((l) => Math.log(Math.max(l, 1e-9)));
      liqSlopePre = slope(xs, ys);
    }
  }

  const fr = futureReturns(series, HORIZONS_MS);
  const y: Record<string, number | null> = {};
  HORIZON_LABELS.forEach((label, i) => {
    y[label] = fr[i]?.ret ?? null;
  });

  return {
    mint,
    universe: splitUniverse(mint),
    t0Time: Date.parse(t0.fetchedAt),
    t0Dex: String(t0.dexId ?? "unknown"),
    nSnaps: series.length,
    nPre,
    liqT0,
    turnoverM5: liqT0 != null ? volM5 / liqT0 : null,
    turnoverH1: liqT0 != null ? volH1 / liqT0 : null,
    liqPerVolH1: liqT0 != null && volH1 > 0 ? liqT0 / volH1 : null,
    mcLiq: liqT0 != null && t0.marketCapUsd != null && t0.marketCapUsd > 0
      ? t0.marketCapUsd / liqT0
      : null,
    preGrowthRel,
    liqSlopePre,
    liqCVPre,
    addsPre,
    removesPre,
    y,
  };
}

/** Charge tous les tokens d'un répertoire data/history. */
export function loadAllFeatures(historyDir: string): LiquidityFeatures[] {
  const out: LiquidityFeatures[] = [];
  for (const f of readdirSync(historyDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const series = loadSeries(join(historyDir, f));
    const feat = computeFeatures(series);
    if (feat) out.push(feat);
  }
  return out;
}

export { aberrantMask, findT0, futureReturns };
