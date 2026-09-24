/**
 * Générateur déterministe de séances OHLCV 5 min (fixtures S4 / tests). Ce n'est PAS de la donnée de marché.
 *
 * Chaque séance couvre les heures de bourse locales [sessionStartMin, sessionEndMin) dans `timeZone`
 * (défaut 9 h 30 – 16 h 00 America/New_York, 78 barres), jours ouvrés seulement. Les horodatages sont convertis
 * en UTC via Intl : les séances qui traversent un changement d'heure ont des heures UTC différentes.
 *
 * `npx tsx lab/backtest/synth-ohlcv.ts > tests/fixtures/ohlcv/SOL-5m.jsonl` régénère la fixture livrée
 * (format compact `[ts, open, high, low, close, volume]` par ligne).
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { zonedTimeToUtc } from "../strategies/ohlcv.ts";
import type { OhlcvBar } from "../strategies/types.ts";
import { mulberry32 } from "./synth.ts";

export interface SynthOhlcvOptions {
  /** Premier jour (AAAA-MM-JJ, local). Les week-ends sont sautés. */
  startDay: string;
  /** Nombre de séances à produire. */
  sessions: number;
  seed?: number;
  timeZone?: string;
  sessionStartMin?: number;
  sessionEndMin?: number;
  barMinutes?: number;
  price0?: number;
  /** Volume de base par barre. */
  volume0?: number;
  /** Largeur « normale » de la fourchette d'ouverture, en fraction du prix (défaut 1 %). */
  rangeWidthPct?: number;
  /**
   * Séances « IVB » injectées : index (0-based) → scénario. Une séance IVB a une fourchette contractée
   * (× contraction), puis une cassure à `breakoutOffsetBars` barres après la fin de la fourchette avec un volume
   * × volumeMult, suivie d'une dérive `driftPct` (fraction du prix) jusqu'à 16 h.
   */
  ivbSessions?: Record<number, { side: "BUY" | "SELL"; contraction?: number; breakoutOffsetBars?: number; volumeMult?: number; driftPct?: number }>;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function isWeekend(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 || wd === 6;
}

/** Jours ouvrés consécutifs à partir de `startDay` (inclus s'il est ouvré). */
export function tradingDays(startDay: string, n: number): string[] {
  const out: string[] = [];
  let day = startDay;
  while (out.length < n) {
    if (!isWeekend(day)) out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

export function synthOhlcv(o: SynthOhlcvOptions): OhlcvBar[] {
  const rnd = mulberry32(o.seed ?? 7);
  const tz = o.timeZone ?? "America/New_York";
  const startMin = o.sessionStartMin ?? 9 * 60 + 30;
  const endMin = o.sessionEndMin ?? 16 * 60;
  const barMin = o.barMinutes ?? 5;
  const rangeBars = 6; // 9 h 30 – 10 h 00
  const widthPct = o.rangeWidthPct ?? 0.01;
  let price = o.price0 ?? 100;
  const vol0 = o.volume0 ?? 1000;
  const out: OhlcvBar[] = [];
  const days = tradingDays(o.startDay, o.sessions);
  days.forEach((day, di) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const ivb = o.ivbSessions?.[di];
    const contraction = ivb?.contraction ?? 0.5;
    const width = price * widthPct * (ivb ? contraction : 0.9 + rnd() * 0.3);
    const mid = price;
    const rangeHigh = mid + width / 2;
    const rangeLow = mid - width / 2;
    const breakoutBar = ivb ? rangeBars + (ivb.breakoutOffsetBars ?? 2) : -1;
    const nBars = Math.round((endMin - startMin) / barMin);
    let prevClose = price;
    for (let k = 0; k < nBars; k++) {
      const minutes = startMin + k * barMin;
      const ts = zonedTimeToUtc(tz, y, m, d, Math.floor(minutes / 60), minutes % 60);
      let open = prevClose;
      let close: number;
      let high: number;
      let low: number;
      let volume = vol0 * (0.8 + rnd() * 0.4);
      if (k < rangeBars) {
        // Barres de fourchette : oscillation contenue dans [rangeLow, rangeHigh].
        open = k === 0 ? mid : prevClose;
        close = rangeLow + (rangeHigh - rangeLow) * rnd();
        high = Math.max(open, close) + (rangeHigh - Math.max(open, close)) * rnd();
        low = Math.min(open, close) - (Math.min(open, close) - rangeLow) * rnd();
        if (k === 0) high = rangeHigh;
        if (k === 1) low = rangeLow;
      } else if (ivb && k === breakoutBar) {
        const push = width * 0.6;
        close = ivb.side === "BUY" ? rangeHigh + push : rangeLow - push;
        high = Math.max(open, close) + push * 0.1;
        low = Math.min(open, close) - push * 0.1;
        volume = vol0 * (ivb.volumeMult ?? 3);
      } else if (ivb && k > breakoutBar) {
        // Dérive après cassure jusqu'à la clôture de séance.
        const remaining = nBars - breakoutBar - 1;
        const step = ((ivb.driftPct ?? 0.02) * price) / Math.max(1, remaining);
        const dir = ivb.side === "BUY" ? 1 : -1;
        close = open + dir * step + (rnd() - 0.5) * width * 0.2;
        high = Math.max(open, close) + width * 0.05 * rnd();
        low = Math.min(open, close) - width * 0.05 * rnd();
      } else {
        // Hors fourchette, jour ordinaire ou avant cassure : bruit contenu dans la fourchette (aucune clôture dehors
        // avant la cassure prévue), puis marche aléatoire après 11 h 30 les jours ordinaires.
        const inWindow = k < rangeBars + 18; // 10 h 00 – 11 h 30
        if (inWindow || ivb) {
          close = rangeLow + (rangeHigh - rangeLow) * (0.2 + 0.6 * rnd());
          high = Math.min(rangeHigh, Math.max(open, close) + width * 0.1 * rnd());
          low = Math.max(rangeLow, Math.min(open, close) - width * 0.1 * rnd());
        } else {
          close = open * (1 + (rnd() - 0.5) * 0.004);
          high = Math.max(open, close) * (1 + rnd() * 0.001);
          low = Math.min(open, close) * (1 - rnd() * 0.001);
        }
      }
      const bar: OhlcvBar = {
        ts,
        open: Number(open.toFixed(4)),
        high: Number(Math.max(high, open, close).toFixed(4)),
        low: Number(Math.min(low, open, close).toFixed(4)),
        close: Number(close.toFixed(4)),
        volume: Math.round(volume),
      };
      out.push(bar);
      prevClose = bar.close;
    }
    // Le prix de référence du lendemain = clôture (petit gap aléatoire).
    price = prevClose * (1 + (rnd() - 0.5) * 0.01);
  });
  return out;
}

/** Fixture livrée : 46 séances du 5 octobre au 7 décembre 2026 (changement d'heure le 1er novembre), 12 séances IVB. */
export const SOL_FIXTURE_OPTIONS: SynthOhlcvOptions = {
  startDay: "2026-10-05",
  sessions: 46,
  seed: 20261005,
  price0: 150,
  volume0: 1000,
  ivbSessions: {
    12: { side: "BUY", breakoutOffsetBars: 1, volumeMult: 3, driftPct: 0.03 }, // 21 oct. (EDT, UTC−4)
    15: { side: "SELL", breakoutOffsetBars: 3, volumeMult: 2.5, driftPct: 0.025 },
    18: { side: "BUY", breakoutOffsetBars: 5, volumeMult: 2, driftPct: -0.02 }, // faux signal → stop
    20: { side: "BUY", breakoutOffsetBars: 0, volumeMult: 4, driftPct: 0.04 }, // 2 nov. : première séance en EST (UTC−5)
    22: { side: "SELL", breakoutOffsetBars: 2, volumeMult: 3, driftPct: 0.03 }, // 4 nov. (EST)
    25: { side: "BUY", breakoutOffsetBars: 8, volumeMult: 2.2, driftPct: 0.015 },
    28: { side: "SELL", breakoutOffsetBars: 1, volumeMult: 1.2, driftPct: 0.03 }, // volume insuffisant → aucun signal
    31: { side: "BUY", breakoutOffsetBars: 4, volumeMult: 3, driftPct: 0.0 }, // flat → sortie forcée 16 h
    34: { side: "SELL", breakoutOffsetBars: 2, volumeMult: 2.8, driftPct: -0.02 }, // faux signal → stop
    37: { side: "BUY", breakoutOffsetBars: 20, volumeMult: 3, driftPct: 0.03 }, // cassure tardive (> 90 min) → ignorée
    40: { side: "BUY", breakoutOffsetBars: 2, volumeMult: 3, driftPct: 0.035 },
    43: { side: "SELL", breakoutOffsetBars: 3, volumeMult: 3, driftPct: 0.03 },
  },
};

export function toCompactJsonl(bars: OhlcvBar[]): string {
  return bars.map((b) => JSON.stringify([b.ts, b.open, b.high, b.low, b.close, b.volume])).join("\n") + "\n";
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.stdout.write(toCompactJsonl(synthOhlcv(SOL_FIXTURE_OPTIONS)));
}
