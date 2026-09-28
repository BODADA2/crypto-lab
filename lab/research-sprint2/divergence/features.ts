/**
 * SPRINT 2A — Famille K : DIVERGENCE_FEATURES.
 *
 * Construit des incohérences (inconsistencies) entre prix, liquidité,
 * volume et transactions — mesurées sans lookahead :
 *  - K1 mismatchPre  : signe(Δprix) vs signe(Δliquidité), snapshot pré-t0 → t0
 *                      (100 % pré-t0 : aucun leakage possible).
 *  - K2 mismatchPost : signe(Δprix) vs signe(Δliquidité), t0 → premier tick
 *                      post-t0 (~14 min : la cadence des snapshots, ~13–14 min,
 *                      rend les fenêtres « 60 s / 5 min » post-t0 impossibles —
 *                      couverture 0/94 mesurée). Labels recalculés à partir du
 *                      tick d'observation (aucun chevauchement feature/label).
 *  - K3 logMcapLiq   : log2(mcap/liquidité) à t0 (ratio anormal).
 *  - K4 frictionH1   : turnover élevé sans mouvement de prix
 *                      (turnoverH1 / (|chgH1| + 1pp)).
 *  - K5 logVolPerTrade : log(volM5 / nb trades m5) — spike de volume sans
 *                        nouvelles transactions.
 *
 * AUCUNE stratégie construite. Données discovery uniquement (hash < 50),
 * lecture seule, SKHY exclu (glitch DexScreener connu).
 */
import type { TokenSnapshot } from "../../types.ts";
import {
  aberrantMask,
  findT0,
  splitUniverse,
  HORIZONS_MS,
} from "../../predictive/universe.ts";
import { listHistoryMints, readSeries } from "../../research-sprint1/common.ts";

export const SKHY_MINT = "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3";

/** +1 = incohérent (signes opposés), -1 = cohérent, null = incalculable. */
export type Mismatch = 1 | -1 | null;

function signMove(a: number, b: number): number | null {
  if (!(a > 0) || !(b > 0)) return null;
  const r = b / a - 1;
  if (Math.abs(r) < 1e-9) return 0;
  return r > 0 ? 1 : -1;
}

export function mismatchOf(a: TokenSnapshot, b: TokenSnapshot): Mismatch {
  const sp = signMove(a.priceUsd, b.priceUsd);
  const sl = signMove(a.liquidityUsd, b.liquidityUsd);
  if (sp == null || sl == null || sp === 0 || sl === 0) return null;
  return sp * sl < 0 ? 1 : -1;
}

export interface DivergenceRow {
  mint: string;
  t0ms: number;
  t0day: string;
  dexId: string | null;
  liqT0: number;
  mcapT0: number | null;
  /** K1 : incohérence prix/liq sur le leg pré-t0 → t0. */
  mismatchPre: Mismatch;
  /** K2 : incohérence prix/liq sur t0 → 1er tick post-t0. */
  mismatchPost: Mismatch;
  /** ms du tick d'observation de K2 (t0 si aucun tick post-t0). */
  featMs: number;
  /** Prix au tick d'observation de K2. */
  featPrice: number;
  /** Délai t0 → tick d'observation K2, minutes ; null si aucun. */
  lagMinPost: number | null;
  /** K3 : log2(mcap/liq) à t0 ; null si mcap inconnue. */
  logMcapLiq: number | null;
  /** K4 : turnoverH1 / (|chgH1|/100 + 0.01). */
  frictionH1: number | null;
  /** K5 : log(volM5 / (buys+sells m5)). */
  logVolPerTrade: number | null;
  /* ---- entrées brutes pour la famille O (anomalie au régime) ---- */
  logLiqT0: number;
  logTurnoverH1: number | null;
  logVelo: number;
}

function rowFromSeries(mint: string, s: TokenSnapshot[]): DivergenceRow | null {
  const t0 = findT0(s);
  if (t0 < 0) return null;
  const snap = s[t0]!;
  const t0ms = Date.parse(snap.fetchedAt);
  const mask = aberrantMask(s);
  if (mask[t0]) return null; // t0 aberrant : feature d'entrée corrompue

  // K1 : leg pré-t0 → t0 (dernier snapshot avant t0, non aberrant).
  let mismatchPre: Mismatch = null;
  for (let i = t0 - 1; i >= 0; i--) {
    if (mask[i] || s[i]!.priceUsd <= 0 || s[i]!.liquidityUsd <= 0) continue;
    mismatchPre = mismatchOf(s[i]!, snap);
    break;
  }

  // K2 : t0 → premier tick post-t0 non aberrant.
  let mismatchPost: Mismatch = null;
  let featMs = t0ms;
  let featPrice = snap.priceUsd;
  let lagMinPost: number | null = null;
  for (let i = t0 + 1; i < s.length; i++) {
    if (mask[i] || s[i]!.priceUsd <= 0 || s[i]!.liquidityUsd <= 0) continue;
    mismatchPost = mismatchOf(snap, s[i]!);
    featMs = Date.parse(s[i]!.fetchedAt);
    featPrice = s[i]!.priceUsd;
    lagMinPost = (featMs - t0ms) / 60000;
    break;
  }

  const liq = snap.liquidityUsd;
  const mcap = snap.marketCapUsd;
  const logMcapLiq = mcap != null && mcap > 0 && liq > 0 ? Math.log2(mcap / liq) : null;

  const volH1 = snap.volume?.h1;
  const chgH1 = snap.priceChange?.h1;
  const turnoverH1 = volH1 != null && liq > 0 ? volH1 / liq : null;
  const frictionH1 =
    turnoverH1 != null && chgH1 != null
      ? turnoverH1 / (Math.abs(chgH1) / 100 + 0.01)
      : null;

  const volM5 = snap.volume?.m5 ?? 0;
  const nTrades = (snap.txns?.m5?.buys ?? 0) + (snap.txns?.m5?.sells ?? 0);
  const logVolPerTrade = volM5 > 0 && nTrades > 0 ? Math.log(volM5 / nTrades) : null;

  const logTurnoverH1 = turnoverH1 != null && turnoverH1 > 0 ? Math.log(turnoverH1) : null;

  return {
    mint,
    t0ms,
    t0day: new Date(t0ms).toISOString().slice(0, 10),
    dexId: snap.dexId ?? null,
    liqT0: liq,
    mcapT0: mcap,
    mismatchPre,
    mismatchPost,
    featMs,
    featPrice,
    lagMinPost,
    logMcapLiq,
    frictionH1,
    logVolPerTrade,
    logLiqT0: Math.log(liq),
    logTurnoverH1,
    logVelo: Math.log((snap.txns?.m5?.buys ?? 0) + (snap.txns?.m5?.sells ?? 0) + 1),
  };
}

/** Charge les lignes K de l'univers discovery (SKHY exclu). */
export function loadDivergenceRows(): DivergenceRow[] {
  const out: DivergenceRow[] = [];
  for (const mint of listHistoryMints()) {
    if (mint === SKHY_MINT) continue;
    if (splitUniverse(mint) !== "discovery") continue;
    const s = readSeries(mint);
    if (!s) continue;
    const r = rowFromSeries(mint, s);
    if (r) out.push(r);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Labels recalculés depuis un point d'observation (anti-chevauchement) */
/* ------------------------------------------------------------------ */

export interface ObsLabels {
  y1h: number | null;
  y6h: number | null;
  y24h: number | null;
  ddMax24h: number | null;
  dd50_24h: boolean | null;
}

/**
 * Labels calculés sur les ticks STRICTEMENT postérieurs à `fromMs`
 * (prix d'entrée = `entryPrice`), ticks aberrants ignorés.
 * Utilisé pour K2 : aucun tick du label ne participe à la feature.
 */
export function labelsFrom(
  s: TokenSnapshot[],
  fromMs: number,
  entryPrice: number,
): ObsLabels {
  const mask = aberrantMask(s);
  const rets = new Map<number, number>();
  for (const h of HORIZONS_MS) {
    const target = fromMs + h;
    for (let i = 0; i < s.length; i++) {
      const t = Date.parse(s[i]!.fetchedAt);
      if (t <= fromMs || t < target) continue;
      if (mask[i] || s[i]!.priceUsd <= 0) continue;
      rets.set(h, s[i]!.priceUsd / entryPrice - 1);
      break;
    }
  }
  const inWindow: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const t = Date.parse(s[i]!.fetchedAt);
    if (t <= fromMs || t > fromMs + 24 * 3_600_000) continue;
    if (mask[i] || s[i]!.priceUsd <= 0) continue;
    inWindow.push(s[i]!.priceUsd / entryPrice - 1);
  }
  const ddMax24h = inWindow.length >= 3 ? Math.min(...inWindow) : null;
  return {
    y1h: rets.get(HORIZONS_MS[0]!) ?? null,
    y6h: rets.get(HORIZONS_MS[1]!) ?? null,
    y24h: rets.get(HORIZONS_MS[2]!) ?? null,
    ddMax24h,
    dd50_24h: ddMax24h == null ? null : ddMax24h <= -0.5,
  };
}
