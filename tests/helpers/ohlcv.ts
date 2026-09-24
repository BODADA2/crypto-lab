// Constructeur de séances OHLCV 5 min CONTRÔLÉES pour les tests S4 (heures locales America/New_York → UTC via Intl).
import { zonedTimeToUtc } from "../../lab/strategies/ohlcv.ts";
import type { OhlcvBar } from "../../lab/strategies/types.ts";

export const NY = "America/New_York";

export interface SessionSpec {
  /** AAAA-MM-JJ local. */
  day: string;
  /** Milieu de la fourchette d'ouverture. */
  mid?: number;
  /** Largeur de la fourchette (high − low). */
  width?: number;
  /** Volume de chaque barre ordinaire. */
  volume?: number;
  /** Cassure : décalage en barres après la fin de la fourchette (0 = barre de 10 h 00), côté, volume de la barre. */
  breakout?: { offsetBars: number; side: "BUY" | "SELL"; volume?: number; push?: number };
  /** Dérive par barre après la cassure (prix absolu, signé). */
  driftAfter?: number;
  /** Barres supplémentaires à altérer : index (0-based dans la séance) → surcharge partielle. */
  overrides?: Record<number, Partial<OhlcvBar>>;
  timeZone?: string;
  /** Minutes locales de début/fin de séance (défaut 9 h 30 – 16 h 00). */
  startMin?: number;
  endMin?: number;
}

/**
 * Séance de 78 barres. Barres de fourchette (les 6 premières) : high = mid + width/2 (barre 0), low = mid − width/2
 * (barre 1), clôtures au milieu. Barres suivantes : plates au milieu, sauf la cassure (clôture hors fourchette de
 * `push`, défaut width/4) puis dérive.
 */
export function session(spec: SessionSpec): OhlcvBar[] {
  const tz = spec.timeZone ?? NY;
  const mid = spec.mid ?? 100;
  const width = spec.width ?? 1;
  const vol = spec.volume ?? 100;
  const startMin = spec.startMin ?? 570;
  const endMin = spec.endMin ?? 960;
  const [y, m, d] = spec.day.split("-").map(Number) as [number, number, number];
  const n = (endMin - startMin) / 5;
  const hi = mid + width / 2;
  const lo = mid - width / 2;
  const out: OhlcvBar[] = [];
  let price = mid;
  for (let k = 0; k < n; k++) {
    const minutes = startMin + k * 5;
    const ts = zonedTimeToUtc(tz, y, m, d, Math.floor(minutes / 60), minutes % 60);
    let bar: OhlcvBar;
    if (k < 6) {
      bar = { ts, open: mid, high: k === 0 ? hi : mid + width / 8, low: k === 1 ? lo : mid - width / 8, close: mid, volume: vol };
    } else if (spec.breakout && k === 6 + spec.breakout.offsetBars) {
      const push = spec.breakout.push ?? width / 4;
      const close = spec.breakout.side === "BUY" ? hi + push : lo - push;
      bar = { ts, open: price, high: Math.max(price, close), low: Math.min(price, close), close, volume: spec.breakout.volume ?? vol * 3 };
      price = close;
    } else if (spec.breakout && k > 6 + spec.breakout.offsetBars && spec.driftAfter) {
      const close = price + spec.driftAfter;
      bar = { ts, open: price, high: Math.max(price, close), low: Math.min(price, close), close, volume: vol };
      price = close;
    } else {
      bar = { ts, open: price, high: price + width / 8, low: price - width / 8, close: price, volume: vol };
    }
    const o = spec.overrides?.[k];
    if (o) bar = { ...bar, ...o };
    out.push(bar);
  }
  return out;
}

/** Jours ouvrés consécutifs à partir de `startDay` (inclus). */
export function weekdays(startDay: string, n: number): string[] {
  const [y, m, d] = startDay.split("-").map(Number) as [number, number, number];
  const out: string[] = [];
  let t = Date.UTC(y, m - 1, d);
  while (out.length < n) {
    const dt = new Date(t);
    const wd = dt.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(dt.toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/** `priorDays` séances plates de largeur `priorWidth` puis la séance testée. Renvoie aussi l'indice de la première barre du jour testé. */
export function history(priorDays: number, priorWidth: number, test: SessionSpec, startDay = "2026-09-07"): { bars: OhlcvBar[]; dayStart: number } {
  const days = weekdays(startDay, priorDays + 1);
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < priorDays; i++) bars.push(...session({ day: days[i]!, mid: test.mid ?? 100, width: priorWidth, volume: test.volume ?? 100 }));
  const dayStart = bars.length;
  bars.push(...session({ ...test, day: test.day || days[priorDays]! }));
  return { bars, dayStart };
}
