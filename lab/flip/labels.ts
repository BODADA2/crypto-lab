/**
 * FLIP ENGINE — Branch B, Sprint 1. Labels forward pour H-FLIP-01/06.
 *
 * Anti-leakage strict : tout label à horizon H n'utilise que des klines avec
 * t_kline dans (tEvent, tEvent + H]. tEvent = clôture de la barre de détection
 * (bar open + 5 min) : l'événement n'est connu qu'à la clôture.
 *
 * Pour H-FLIP-06 (conditionnement absorption) :
 *  - groupe absorbé : tEvent = clôture de la barre E12 (l'absorption n'est connue qu'alors) ;
 *  - groupe non absorbé : tEvent = clôture cascade + 15 min (l'absence d'absorption
 *    n'est connue qu'à la fermeture de la fenêtre E12).
 */
import type { Bar5m, FlipEvent, Kline1m } from "./events.js";

export const MIN = 60_000;
export const HORIZONS_MIN = [5, 60, 240] as const; // 5m, 1h, 4h
export const CONT_TOL = 0.002; // continuation = nouvel extrême adverse ≥ 0.2% au-delà
export const REVERSAL_FRAC = 0.5; // reversal = récupération ≥ 50% de l'excursion

export interface ForwardLabel {
  tEvent: number; // feature_timestamp — rien après n'est utilisé comme feature
  type: "E1" | "E2";
  dir: -1 | 1; // -1 = cascade down (E1), +1 = cascade up (E2)
  prePx: number;
  excBar: number; // |log| excursion adverse de la barre de cascade (log pts, > 0)
  reversal5m: boolean;
  reversal1h: boolean;
  reversal4h: boolean;
  continuation5m: boolean;
  continuation1h: boolean;
  continuation4h: boolean;
  y15m: number; y1h: number; y6h: number; y24h: number; // log(px/prePx) bruts
  yRev1h: number; // signé sens reversal : -dir * y1h (positif = mean-revert)
  yRev4h: number;
  complete4h: boolean; // données forward suffisantes jusqu'à tEvent+4h
  complete24h: boolean;
}

interface WinStats {
  maxClose: number;
  minClose: number;
  minLow: number;
  maxHigh: number;
  hasData: boolean;
}

/** Scan linéaire des klines 1m dans (t0, t1]. Les klines sont triées par t. */
function scanWindow(klines: Kline1m[], t0: number, t1: number, fromIdx: number): { s: WinStats; nextIdx: number } {
  let i = fromIdx;
  while (i < klines.length && klines[i]!.t <= t0) i++;
  const s: WinStats = { maxClose: -Infinity, minClose: Infinity, minLow: Infinity, maxHigh: -Infinity, hasData: false };
  let j = i;
  while (j < klines.length && klines[j]!.t <= t1) {
    const k = klines[j]!;
    s.hasData = true;
    if (k.c > s.maxClose) s.maxClose = k.c;
    if (k.c < s.minClose) s.minClose = k.c;
    if (k.l < s.minLow) s.minLow = k.l;
    if (k.h > s.maxHigh) s.maxHigh = k.h;
    j++;
  }
  return { s, nextIdx: i };
}

export interface LabelOptions {
  /** Timestamp max autorisé pour les données forward (jamais dans le holdout). */
  maxForwardT: number;
}

/**
 * Labels pour une cascade (E1/E2) à partir d'un tEvent point-in-time explicite.
 * Retourne null si l'excursion est dégénérée ou les données insuffisantes.
 * `hint` : curseur mutable {idx} — les appels chronologiques réutilisent la position
 * (les klines sont triées) ; sans hint, le scan part de 0.
 */
export function labelCascade(
  klines: Kline1m[],
  type: "E1" | "E2",
  tEvent: number,
  prePx: number,
  cascadeLow: number, // low de la barre de cascade (E1)
  cascadeHigh: number, // high de la barre de cascade (E2)
  opt: LabelOptions,
  hint?: { idx: number },
): ForwardLabel | null {
  const dir: -1 | 1 = type === "E1" ? -1 : 1;
  if (!(prePx > 0)) return null;
  const excBar = dir === -1 ? -Math.log(cascadeLow / prePx) : Math.log(cascadeHigh / prePx);
  if (!(excBar > 1e-9)) return null;

  const t4h = tEvent + 240 * MIN;
  const t24h = tEvent + 24 * 60 * MIN;
  const complete4h = t4h <= opt.maxForwardT;
  const complete24h = t24h <= opt.maxForwardT;
  if (!complete4h) return null; // sans 4h de forward, les labels principaux sont invalides

  const revThr = dir === -1
    ? prePx * Math.exp(-excBar * REVERSAL_FRAC)
    : prePx * Math.exp(excBar * REVERSAL_FRAC);
  const contThr = dir === -1
    ? cascadeLow * Math.exp(-CONT_TOL)
    : cascadeHigh * Math.exp(CONT_TOL);

  const out: ForwardLabel = {
    tEvent, type, dir, prePx, excBar,
    reversal5m: false, reversal1h: false, reversal4h: false,
    continuation5m: false, continuation1h: false, continuation4h: false,
    y15m: NaN, y1h: NaN, y6h: NaN, y24h: NaN, yRev1h: NaN, yRev4h: NaN,
    complete4h, complete24h,
  };

  // 1) Y@t en une seule passe forward (cibles 15m → 24h), à partir du curseur.
  let ki = hint?.idx ?? 0;
  // garde anti-inversion : si le curseur est déjà au-delà de tEvent (ex. tEvent
  // absorbé < tEvent précédent non absorbé), on repart de 0 — coût ponctuel, correct.
  if (hint && ki > 0 && ki < klines.length && klines[ki]!.t > tEvent + MIN) ki = 0;
  while (ki < klines.length && klines[ki]!.t <= tEvent) ki++;
  const k0 = ki; // première kline > tEvent — point de départ des fenêtres d'horizon
  const targets = [15, 60, 240, 360, 1440];
  const pxAt: number[] = [];
  let lastPx = NaN;
  for (const m of targets) {
    const tt = tEvent + m * MIN;
    if (tt > opt.maxForwardT + 1) { pxAt.push(NaN); continue; }
    while (ki < klines.length && klines[ki]!.t <= tt) { lastPx = klines[ki]!.c; ki++; }
    pxAt.push(lastPx);
  }
  const yOf = (px: number) => Number.isFinite(px) && px > 0 ? Math.log(px / prePx) : NaN;
  out.y15m = yOf(pxAt[0]!);
  out.y1h = yOf(pxAt[1]!);
  out.yRev4h = -dir * yOf(pxAt[2]!);
  out.y6h = yOf(pxAt[3]!);
  out.yRev1h = -dir * out.y1h;
  if (complete24h) out.y24h = yOf(pxAt[4]!);
  // Le curseur retient k0 (premier index > tEvent), pas la fin du scan Y :
  // l'appel suivant (tEvent + 5 min) doit pouvoir avancer depuis k0.
  if (hint) hint.idx = k0;

  // 2) Fenêtres reversal/continuation : petits scans depuis k0 (jamais depuis 0).
  const horizons: Array<[number, "reversal5m" | "reversal1h" | "reversal4h", "continuation5m" | "continuation1h" | "continuation4h"]> = [
    [5, "reversal5m", "continuation5m"],
    [60, "reversal1h", "continuation1h"],
    [240, "reversal4h", "continuation4h"],
  ];
  for (const [hMin, rKey, cKey] of horizons) {
    const { s } = scanWindow(klines, tEvent, tEvent + hMin * MIN, k0);
    if (!s.hasData) return null;
    out[rKey] = dir === -1 ? s.maxClose >= revThr : s.minClose <= revThr;
    out[cKey] = dir === -1 ? s.minLow <= contThr : s.maxHigh >= contThr;
  }
  return out;
}

export interface LabeledCascade extends ForwardLabel {
  tCascade: number; // barre de cascade (open)
  absorbed: boolean; // E12 dans les 15 min (E1/E2)
  tAbsorb: number | null; // t de l'E12 si absorbé
}

/**
 * Labellise toutes les cascades E1/E2.
 * tEvent = clôture barre cascade + (0 si absorbé → remplacé par clôture E12 ; 15 min si non absorbé).
 * Voir en-tête du module pour la justification point-in-time (H-FLIP-06).
 */
export function labelCascades(
  klines: Kline1m[],
  bars: Bar5m[],
  cascades: FlipEvent[],
  absorptions: FlipEvent[],
  opt: LabelOptions,
): LabeledCascade[] {
  const barIdx = new Map(bars.map((b, i) => [b.t, i]));
  const absByCascade = new Map<number, FlipEvent>();
  for (const a of absorptions) {
    const at = a.meta.afterT;
    if (typeof at === "number" && !absByCascade.has(at)) absByCascade.set(at, a);
  }
  const out: LabeledCascade[] = [];
  const hint = { idx: 0 };
  for (const c of cascades) {
    if (c.type !== "E1" && c.type !== "E2") continue;
    const i = barIdx.get(c.t);
    if (i === undefined || i < 1) continue;
    const prev = bars[i - 1]!;
    const bar = bars[i]!;
    const a = absByCascade.get(c.t);
    const tEvent = a ? a.t + 5 * MIN : c.t + 5 * MIN + 15 * MIN;
    const lab = labelCascade(klines, c.type, tEvent, prev.c, bar.l, bar.h, opt, hint);
    if (!lab) continue;
    out.push({ ...lab, tCascade: c.t, absorbed: !!a, tAbsorb: a ? a.t : null });
  }
  return out;
}

/** Baseline : barres 5m ordinaires (hors ±4h des cascades), même convention tEvent = clôture. */
export function labelBaselineBars(
  klines: Kline1m[],
  bars: Bar5m[],
  cascades: FlipEvent[],
  opt: LabelOptions,
  warmupBars: number,
  onlyLargeDown: boolean,
  largeDownThr: number, // seuil ret5m (ex. P5 causal) si onlyLargeDown
): ForwardLabel[] {
  const excl = new Set<number>();
  for (const c of cascades) {
    for (let k = -48; k <= 48; k++) excl.add(c.t + k * 5 * MIN);
  }
  const out: ForwardLabel[] = [];
  const hint = { idx: 0 };
  for (let i = warmupBars; i < bars.length; i++) {
    const b = bars[i]!;
    if (excl.has(b.t)) continue;
    const r = b.ret;
    if (onlyLargeDown && !(r <= largeDownThr)) continue;
    if (!onlyLargeDown && !(Math.abs(r) > 1e-9)) continue;
    const prev = bars[i - 1]!;
    const type = r < 0 ? "E1" : "E2"; // "comme si" cascade down/up
    const tEvent = b.t + 5 * MIN;
    const lab = labelCascade(klines, type, tEvent, prev.c, b.l, b.h, opt, hint);
    if (lab) out.push(lab);
  }
  return out;
}
