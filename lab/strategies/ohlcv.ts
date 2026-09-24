/**
 * Utilitaires OHLCV et fuseau horaire pour les stratégies « crypto » (barres 5 min).
 * Aucune dépendance : Intl (ICU natif) gère l'heure d'été/hiver.
 */
import { zonedParts } from "../time.ts";
import type { OhlcvBar } from "./types.ts";

export interface LocalStamp {
  /** AAAA-MM-JJ dans le fuseau. */
  day: string;
  /** Minutes locales depuis minuit (0..1439). */
  minutes: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// Mémo des horodatages locaux : Intl.formatToParts coûte ~µs ; un backtest en appelle des millions de fois sur les
// mêmes barres. Borné (vidé au-delà de MEMO_MAX entrées) pour ne pas croître sans limite.
const MEMO_MAX = 200_000;
const stampMemo = new Map<string, Map<number, LocalStamp>>();

/** Jour local et minutes locales depuis minuit d'un instant epoch ms, dans le fuseau. */
export function localStamp(ts: number, timeZone: string): LocalStamp {
  let byTs = stampMemo.get(timeZone);
  if (!byTs) {
    byTs = new Map();
    stampMemo.set(timeZone, byTs);
  }
  const hit = byTs.get(ts);
  if (hit) return hit;
  const p = zonedParts(new Date(ts), timeZone);
  const st: LocalStamp = { day: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`, minutes: p.hour * 60 + p.minute };
  if (byTs.size >= MEMO_MAX) byTs.clear();
  byTs.set(ts, st);
  return st;
}

/**
 * Instant UTC (epoch ms) correspondant à une heure LOCALE dans le fuseau (DST géré par Intl).
 * Méthode : on part de l'hypothèse « local = UTC », on mesure le décalage réel à cet instant, on corrige, puis on
 * vérifie une seconde fois (le décalage peut changer autour d'une transition d'heure). Pour une heure locale
 * inexistante (saut de printemps), renvoie l'instant après le saut.
 */
export function zonedTimeToUtc(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const diff = asUtc - guess; // décalage du fuseau à l'instant `guess`
    const next = wanted - diff;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** Décalage (minutes) du fuseau par rapport à UTC à un instant donné (ex. −240 pour EDT, −300 pour EST). */
export function utcOffsetMinutes(ts: number, timeZone: string): number {
  const p = zonedParts(new Date(ts), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
  return Math.round((asUtc - ts) / 60_000);
}

/** True Range d'une barre par rapport à la clôture précédente. */
export function trueRange(bar: OhlcvBar, prevClose: number | null): number {
  if (prevClose === null) return bar.high - bar.low;
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/**
 * ATR simple (moyenne des `period` derniers True Range) calculé sur les barres jusqu'à `endIdx` INCLUS.
 * Null si moins de `period` + 1 barres disponibles.
 */
export function atr(bars: readonly OhlcvBar[], endIdx: number, period: number): number | null {
  if (period <= 0 || endIdx - period < 0) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += trueRange(bars[i]!, bars[i - 1]!.close);
  return sum / period;
}

/** Vrai si les barres (à partir de `fromIdx`) sont strictement chronologiques et finies. */
export function barsAreSane(bars: readonly OhlcvBar[], fromIdx = 0): boolean {
  for (let i = Math.max(0, fromIdx); i < bars.length; i++) {
    const b = bars[i]!;
    if (!(Number.isFinite(b.ts) && Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close) && Number.isFinite(b.volume))) return false;
    if (b.high < b.low || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) return false;
    if (i > 0 && b.ts <= bars[i - 1]!.ts) return false;
  }
  return true;
}

/** Lit un fichier JSONL de barres (`{ts,open,high,low,close,volume}` ou `[ts,o,h,l,c,v]` par ligne). */
export function parseOhlcvJsonl(text: string): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const v = JSON.parse(l) as unknown;
      if (Array.isArray(v) && v.length >= 6) {
        const [ts, open, high, low, close, volume] = v as number[];
        out.push({ ts: ts!, open: open!, high: high!, low: low!, close: close!, volume: volume! });
      } else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        out.push({ ts: Number(o.ts), open: Number(o.open), high: Number(o.high), low: Number(o.low), close: Number(o.close), volume: Number(o.volume) });
      }
    } catch {
      /* ligne corrompue : ignorée */
    }
  }
  return out.filter((b) => [b.ts, b.open, b.high, b.low, b.close, b.volume].every((x) => Number.isFinite(x)));
}
