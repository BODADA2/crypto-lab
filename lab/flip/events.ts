/**
 * FLIP ENGINE — Branch B (SOL-PERP). Détecteurs d'événements §66.
 *
 * Fonctions pures, aucun accès réseau, aucun lookahead : les percentiles glissants
 * sont calculés sur fenêtre causale (données ≤ t uniquement).
 *
 * Tous les seuils sont des GUESSES INITIAUX (spec docs/flip-engine-spec-2026-09-28.md §4).
 * Tuning éventuel sur discovery uniquement, jamais sur holdout.
 */

export interface Kline1m {
  t: number; // open time ms
  o: number; h: number; l: number; c: number;
  v: number; // base volume
  buyVol: number; // taker buy base volume
  n: number; // trade count
}

export interface Bar5m {
  t: number;
  o: number; h: number; l: number; c: number;
  v: number;
  buyRatio: number; // taker buy / total volume (0..1)
  ret: number; // log return vs previous 5m close
}

export interface HourRow {
  t: number; // hour open ms
  ret1h: number; // log return 1h
  oi: number | null; // sum open interest (contracts)
  oiChg1h: number | null; // pct change OI over 1h
  premium: number | null; // premium index
  funding: number | null; // hourly funding rate
}

export type EventType =
  | "E1" | "E2" | "E3" | "E4" | "E5" | "E6"
  | "E7" | "E8" | "E9" | "E10" | "E11" | "E12";

export interface FlipEvent {
  type: EventType;
  t: number; // event time ms
  price: number; // reference price at event
  amplitude: number; // signed excursion that triggered (log pts, signed by direction)
  durationMin: number | null; // min until reversion threshold, null if not reverted within cap
  meta: Record<string, number | string>;
}

export interface DetectConfig {
  pctWindow: number; // rolling percentile window (bars for 5m, hours for 1h)
  cascadeRetP: number; // percentile for cascade return (E1: low, E2: high)
  imbP: number; // percentile for taker imbalance
  volP: number; // percentile for volume confirmation
  debounceMin: number; // merge triggers closer than this
  reversionTol: number; // |log ret| under which price counts as reverted
  reversionCapMin: number; // max duration tracked
  absorptionWindowMin: number; // E12 look-forward window after E1/E2
  fundAbsFloor: number; // E3/E4: absolute |funding| floor (dual condition with percentile)
}

export const DEFAULT_CFG: DetectConfig = {
  pctWindow: 7 * 24 * 12, // 7d of 5m bars
  cascadeRetP: 1,
  imbP: 10,
  volP: 90,
  debounceMin: 30,
  reversionTol: 0.003,
  reversionCapMin: 240,
  absorptionWindowMin: 15,
  fundAbsFloor: 0, // inutilisé sur grille 5m ; défini dans HOUR_CFG
};

export const HOUR_CFG: DetectConfig = { ...DEFAULT_CFG, pctWindow: 7 * 24, fundAbsFloor: 1e-4 };

/** Percentile (linear interpolation), p in 0..100. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const first = sortedAsc[0] as number;
  if (sortedAsc.length === 1) return first;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = sortedAsc[Math.floor(rank)] as number;
  const hi = sortedAsc[Math.ceil(rank)] as number;
  return lo + (hi - lo) * (rank - Math.floor(rank));
}

/** Causal rolling percentile of series[i] within series[max(0,i-w+1)..i]. */
export function rollingPctRank(series: number[], i: number, w: number): number {
  const from = Math.max(0, i - w + 1);
  const win = series.slice(from, i + 1).filter((x) => Number.isFinite(x));
  if (win.length < 2) return 50;
  const v = series[i];
  if (v === undefined || !Number.isFinite(v)) return 50;
  const sorted = [...win].sort((a, b) => a - b);
  if (sorted[sorted.length - 1] === sorted[0]) return 50; // fenêtre dégénérée : aucune info
  // rank of v: fraction of window <= v
  let le = 0;
  for (const x of sorted) { if (x <= v) le++; else break; }
  return (le / sorted.length) * 100;
}

/** Aggregate 1m klines into 5m bars (causal, no lookahead). */
export function toBars5m(klines: Kline1m[]): Bar5m[] {
  const bars: Bar5m[] = [];
  for (let i = 0; i < klines.length; i += 5) {
    const chunk = klines.slice(i, i + 5);
    if (chunk.length < 5) break;
    if (!chunk.every((k) => Number.isFinite(k.c) && k.c > 0)) continue;
    const first = chunk[0]!; // chunk.length >= 5 garanti par le garde ci-dessus
    const lastK = chunk[chunk.length - 1]!;
    const v = chunk.reduce((s, k) => s + k.v, 0);
    const bv = chunk.reduce((s, k) => s + k.buyVol, 0);
    bars.push({
      t: first.t,
      o: first.o,
      h: Math.max(...chunk.map((k) => k.h)),
      l: Math.min(...chunk.map((k) => k.l)),
      c: lastK.c,
      v,
      buyRatio: v > 0 ? bv / v : 0.5,
      ret: 0, // filled below
    });
  }
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const p = bars[i - 1]!;
    b.ret = Math.log(b.c / p.c);
  }
  return bars;
}

function debounce<T extends { t: number }>(items: T[], windowMin: number): T[] {
  const out: T[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && it.t - last.t < windowMin * 60_000) continue;
    out.push(it);
  }
  return out;
}

/**
 * E1 (cascade long) / E2 (cascade short) sur barres 5m.
 * amplitude = excursion adverse max (log pts, signée) ; durationMin = retour sous reversionTol.
 */
export function detectCascades(bars: Bar5m[], cfg: DetectConfig = DEFAULT_CFG): FlipEvent[] {
  const rets = bars.map((b) => b.ret);
  const imbs = bars.map((b) => b.buyRatio);
  const vols = bars.map((b) => b.v);
  const raw: FlipEvent[] = [];

  for (let i = 1; i < bars.length; i++) {
    const retRank = rollingPctRank(rets, i, cfg.pctWindow);
    const imbRank = rollingPctRank(imbs, i, cfg.pctWindow);
    const volRank = rollingPctRank(vols, i, cfg.pctWindow);
    const b = bars[i]!;
    const bp = bars[i - 1]!;
    const isDown = retRank <= cfg.cascadeRetP && imbRank <= cfg.imbP && volRank >= cfg.volP;
    const isUp = retRank >= 100 - cfg.cascadeRetP && imbRank >= 100 - cfg.imbP && volRank >= cfg.volP;
    if (!isDown && !isUp) continue;
    const type: EventType = isDown ? "E1" : "E2";
    // amplitude: max adverse excursion from pre-event close over next bars (cap = reversion window)
    const prePx = bp.c;
    let worst = 0;
    let revertedAt: number | null = null;
    const maxBars = Math.floor(cfg.reversionCapMin / 5);
    for (let j = i; j < Math.min(bars.length, i + maxBars); j++) {
      const bj = bars[j]!;
      // adverse excursion from pre-event close (low for E1, high for E2)
      const adv = isDown
        ? Math.log(bj.l / prePx)
        : Math.log(bj.h / prePx);
      if (isDown ? adv < worst : adv > worst) worst = adv;
      if (Math.abs(Math.log(bj.c / prePx)) <= cfg.reversionTol) {
        revertedAt = (bj.t - b.t) / 60_000;
        break;
      }
    }
    raw.push({
      type,
      t: b.t,
      price: b.c,
      amplitude: worst,
      durationMin: revertedAt,
      meta: { retRank, imbRank, volRank, ret5m: b.ret, buyRatio: b.buyRatio },
    });
  }
  const e1 = debounce(raw.filter((e) => e.type === "E1"), cfg.debounceMin);
  const e2 = debounce(raw.filter((e) => e.type === "E2"), cfg.debounceMin);
  return [...e1, ...e2].sort((a, b) => a.t - b.t);
}

/**
 * E12 absorption : après chaque E1/E2, on cherche un contre-flux GENUIN.
 * Le seuil (P90/P10) est calculé sur la fenêtre PRE-événement uniquement
 * (barres < cascade), pour éviter que la barre de cascade elle-même
 * ne contamine le percentile (un simple retour à la normale ne compte pas).
 */
export function detectAbsorption(
  cascades: FlipEvent[],
  bars: Bar5m[],
  cfg: DetectConfig = DEFAULT_CFG,
): FlipEvent[] {
  const byTime = new Map(bars.map((b, i) => [b.t, i]));
  const out: FlipEvent[] = [];
  for (const c of cascades) {
    const idx = byTime.get(c.t);
    if (idx === undefined || idx < 12) continue;
    const from = Math.max(0, idx - cfg.pctWindow);
    const pre = bars.slice(from, idx).map((b) => b.buyRatio).filter(Number.isFinite);
    if (pre.length < 12) continue;
    const sorted = [...pre].sort((a, b) => a - b);
    if (sorted[sorted.length - 1] === sorted[0]) continue; // aucune info pré-événement
    const hiThr = percentile(sorted, 100 - cfg.imbP);
    const loThr = percentile(sorted, cfg.imbP);
    const nBars = Math.ceil(cfg.absorptionWindowMin / 5);
    for (let j = idx + 1; j < Math.min(bars.length, idx + 1 + nBars); j++) {
      const bj = bars[j]!;
      const br = bj.buyRatio;
      const absorbed = c.type === "E1" ? br > hiThr : br < loThr;
      if (absorbed) {
        out.push({
          type: "E12",
          t: bj.t,
          price: bj.c,
          amplitude: 0,
          durationMin: (bj.t - c.t) / 60_000,
          meta: { afterEvent: c.type, afterT: c.t, buyRatio: br, thr: c.type === "E1" ? hiThr : loThr },
        });
        break;
      }
    }
  }
  return out;
}

/**
 * E3–E11 sur grille horaire (funding, OI, premium, rendements 1h).
 * Tous les seuils en percentiles causaux 7j.
 */
export function detectHourly(hours: HourRow[], cfg: DetectConfig = HOUR_CFG): FlipEvent[] {
  const fund = hours.map((h) => h.funding ?? NaN);
  const oiChg = hours.map((h) => h.oiChg1h ?? NaN);
  const prem = hours.map((h) => h.premium ?? NaN);
  const rets = hours.map((h) => h.ret1h);
  const absPrem = hours.map((h) => h.premium == null ? NaN : Math.abs(h.premium));
  const out: FlipEvent[] = [];

  const push = (type: EventType, i: number, amplitude: number, meta: Record<string, number | string>) =>
    out.push({ type, t: hours[i]!.t, price: NaN, amplitude, durationMin: null, meta });

  // Causal NaN-safe percentile rank of series[i] within finite window values.
  const crank = (series: number[], i: number, w: number): number => {
    const from = Math.max(0, i - w + 1);
    const win: number[] = [];
    for (let k = from; k <= i; k++) {
      const v = series[k];
      if (v !== undefined && Number.isFinite(v)) win.push(v);
    }
    const cur = series[i];
    if (win.length < 12 || cur === undefined || !Number.isFinite(cur)) return NaN;
    const sorted = [...win].sort((a, b) => a - b);
    if (sorted[sorted.length - 1] === sorted[0]) return 50; // fenêtre dégénérée : aucune info
    let le = 0;
    for (const x of sorted) { if (x <= cur) le++; else break; }
    return (le / sorted.length) * 100;
  };

  for (let i = 1; i < hours.length; i++) {
    const h = hours[i]!;
    const fR = crank(fund, i, cfg.pctWindow);
    const oR = crank(oiChg, i, cfg.pctWindow);
    const pR = crank(absPrem, i, cfg.pctWindow);
    const rR = crank(rets, i, cfg.pctWindow);
    if (Number.isFinite(fR) && fR >= 99 && (h.funding ?? 0) >= cfg.fundAbsFloor)
      push("E3", i, h.funding ?? 0, { fundRank: fR });
    if (Number.isFinite(fR) && fR <= 1 && (h.funding ?? 0) <= -cfg.fundAbsFloor)
      push("E4", i, h.funding ?? 0, { fundRank: fR });
    if (Number.isFinite(oR) && oR >= 99) push("E5", i, h.oiChg1h ?? 0, { oiRank: oR });
    if (Number.isFinite(oR) && oR <= 1) push("E6", i, h.oiChg1h ?? 0, { oiRank: oR });
    if (Number.isFinite(pR) && pR >= 99) push("E7", i, h.premium ?? 0, { premRank: pR });
    if (Number.isFinite(rR) && Number.isFinite(oR)) {
      if (rR >= 90 && oR <= 10) push("E8", i, h.ret1h, { retRank: rR, oiRank: oR });
      if (rR <= 10 && oR >= 90) push("E9", i, h.ret1h, { retRank: rR, oiRank: oR });
      if (rR >= 90 && oR >= 90) push("E10", i, h.ret1h, { retRank: rR, oiRank: oR });
      if (rR <= 10 && oR <= 10) push("E11", i, h.ret1h, { retRank: rR, oiRank: oR });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface EventStats {
  type: EventType;
  n: number;
  perDay: number;
  amplitudePct: { p10: number; p50: number; p90: number } | null;
  durationMin: { p50: number; p90: number; revertedPct: number } | null;
}

/** Descriptifs par type d'événement : fréquence, amplitude, durée. Descriptif uniquement. */
export function describeEvents(events: FlipEvent[], daysSpan: number): EventStats[] {
  const types: EventType[] = ["E1","E2","E3","E4","E5","E6","E7","E8","E9","E10","E11","E12"];
  return types.map((type) => {
    const evs = events.filter((e) => e.type === type);
    const amps = evs.map((e) => Math.abs(e.amplitude) * 100).sort((a, b) => a - b);
    const durs = evs.map((e) => e.durationMin).filter((d): d is number => d != null).sort((a, b) => a - b);
    const hasAmp = ["E1", "E2"].includes(type);
    return {
      type,
      n: evs.length,
      perDay: daysSpan > 0 ? evs.length / daysSpan : 0,
      amplitudePct: hasAmp && amps.length > 0
        ? { p10: percentile(amps, 10), p50: percentile(amps, 50), p90: percentile(amps, 90) }
        : null,
      durationMin: hasAmp
        ? {
            p50: durs.length ? percentile(durs, 50) : NaN,
            p90: durs.length ? percentile(durs, 90) : NaN,
            revertedPct: evs.length ? (durs.length / evs.length) * 100 : 0,
          }
        : null,
    };
  });
}
