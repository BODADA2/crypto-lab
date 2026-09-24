/**
 * S4 — IVB (Initial Volatility Breakout) sur barres OHLCV 5 min de SOL / BTC. PORT CORRIGÉ.
 *
 * Idée : une séance qui ouvre dans une fourchette ANORMALEMENT ÉTROITE (contraction de volatilité) puis casse
 * cette fourchette avec du volume a tendance à poursuivre le mouvement dans la journée.
 *
 * Définitions (toutes les heures sont LOCALES dans `timeZone`, défaut America/New_York, DST géré par Intl) :
 *   - fourchette d'ouverture = barres dont l'OUVERTURE est dans [rangeStartMin, rangeEndMin) = [9 h 30, 10 h 00),
 *     soit 6 barres de 5 min ; la fourchette n'est valable que si les 6 barres sont présentes ;
 *   - contraction = largeur (high − low) de la fourchette du jour ÷ moyenne des largeurs des `lookbackDays` jours
 *     PRÉCÉDENTS (jour courant EXCLU) ; il faut exactement `lookbackDays` jours antérieurs à fourchette complète ;
 *   - cassure = PREMIÈRE barre, dans les `breakoutWindowMin` (90) minutes qui suivent la fin de la fourchette
 *     (ouverture de barre dans [10 h 00, 11 h 30)), dont la CLÔTURE est > high (BUY) ou < low (SELL) ;
 *     une cassure plus tard dans la journée est ignorée ; une seconde cassure le même jour est ignorée ;
 *   - volume = volume de la barre de cassure ÷ moyenne des `volumeLookbackBars` barres PRÉCÉDENTES (barre de
 *     cassure EXCLUE) ; requis ≥ minVolumeRatio ;
 *   - stop structurel = bord OPPOSÉ de la fourchette ∓ stopAtrBuffer × ATR(atrPeriod) ; R = |entrée − stop| ;
 *     objectif = entrée ± targetR × R ; sortie forcée à forcedExitMin (16 h 00) ;
 *   - la stratégie n'émet le signal QUE lorsque la dernière barre fournie est la barre de cassure : elle est pure,
 *     et le « compteur d'ordres par jour » (maxEntriesPerDay) est tenu par le harnais/l'exécuteur et incrémenté
 *     À L'ORDRE, pas à la détection (voir lab/backtest/harness.ts → simulateBars).
 *
 * Erreurs du port d'origine corrigées : jour courant inclus dans la moyenne de contraction ; barre courante
 * incluse dans la moyenne de volume ; entrée sur n'importe quelle barre hors fourchette (pas seulement la première,
 * y compris après 11 h 30) ; fuseau horaire fixe (UTC−5) faux six mois par an ; compteur incrémenté au signal.
 */
import { atr, barsAreSane, localStamp, zonedTimeToUtc } from "./ohlcv.ts";
import { clamp, type OhlcvBar, type Side, type Strategy, type StrategyInput, type StrategySignal } from "./types.ts";

export interface IvbParams {
  /** Fuseau des heures de séance (défaut "America/New_York"). */
  timeZone: string;
  /** Minutes locales depuis minuit : début de fourchette (défaut 570 = 9 h 30), inclus. */
  rangeStartMin: number;
  /** Fin de fourchette (défaut 600 = 10 h 00), exclu. */
  rangeEndMin: number;
  /** Fenêtre d'entrée après la fin de fourchette, en minutes (défaut 90 → jusqu'à 11 h 30). */
  breakoutWindowMin: number;
  /** Durée d'une barre en minutes (défaut 5). */
  barMinutes: number;
  /** Jours précédents pour la moyenne de largeur (défaut 10). */
  lookbackDays: number;
  /** Ratio de contraction maximal (défaut 0.8 : fourchette ≤ 80 % de la moyenne). */
  maxContractionRatio: number;
  /** Barres précédentes pour la moyenne de volume (défaut 20). */
  volumeLookbackBars: number;
  /** Ratio de volume minimal de la barre de cassure (défaut 1.5). */
  minVolumeRatio: number;
  /** Période ATR en barres (défaut 14). */
  atrPeriod: number;
  /** Tampon du stop en multiples d'ATR (défaut 0.5). */
  stopAtrBuffer: number;
  /** Objectif en multiples de R (défaut 2). */
  targetR: number;
  /** Sortie forcée, minutes locales (défaut 960 = 16 h 00). */
  forcedExitMin: number;
  /** Ordres max par séance (défaut 1) — compteur tenu par l'exécuteur/harnais, incrémenté à l'ordre. */
  maxEntriesPerDay: number;
}

export const IVB_DEFAULTS: IvbParams = {
  timeZone: "America/New_York",
  rangeStartMin: 9 * 60 + 30,
  rangeEndMin: 10 * 60,
  breakoutWindowMin: 90,
  barMinutes: 5,
  lookbackDays: 10,
  maxContractionRatio: 0.8,
  volumeLookbackBars: 20,
  minVolumeRatio: 1.5,
  atrPeriod: 14,
  stopAtrBuffer: 0.5,
  targetR: 2,
  forcedExitMin: 16 * 60,
  maxEntriesPerDay: 1,
};

export interface DayRange {
  day: string;
  high: number;
  low: number;
  width: number;
  /** Indices des barres de fourchette dans le tableau d'entrée. */
  barIdx: number[];
  complete: boolean;
}

export interface IvbEvaluation {
  /** Jour local de la dernière barre. */
  day: string;
  range: DayRange | null;
  /** Jours précédents (complets) utilisés pour la moyenne, du plus ancien au plus récent. */
  previousDays: string[];
  contractionRatio: number | null;
  /** Indice de la PREMIÈRE cassure de la fenêtre (ou null). */
  breakoutIdx: number | null;
  side: Side | null;
  volumeRatio: number | null;
  atr: number | null;
  /** Vrai si la dernière barre est la première cassure et que tous les filtres passent. */
  fires: boolean;
  /** Raison de non-signal (diagnostic). */
  reason: string | null;
}

/** Fourchettes d'ouverture par jour local (dans l'ordre chronologique des jours), à partir de l'indice `fromIdx`. */
export function dayRanges(bars: readonly OhlcvBar[], p: IvbParams, fromIdx = 0): DayRange[] {
  const expected = Math.round((p.rangeEndMin - p.rangeStartMin) / p.barMinutes);
  const byDay = new Map<string, DayRange>();
  for (let i = Math.max(0, fromIdx); i < bars.length; i++) {
    const b = bars[i]!;
    const st = localStamp(b.ts, p.timeZone);
    if (st.minutes < p.rangeStartMin || st.minutes >= p.rangeEndMin) continue;
    let r = byDay.get(st.day);
    if (!r) {
      r = { day: st.day, high: -Infinity, low: Infinity, width: 0, barIdx: [], complete: false };
      byDay.set(st.day, r);
    }
    r.high = Math.max(r.high, b.high);
    r.low = Math.min(r.low, b.low);
    r.barIdx.push(i);
  }
  const out = Array.from(byDay.values());
  for (const r of out) {
    r.width = r.high - r.low;
    r.complete = r.barIdx.length === expected;
  }
  return out;
}

/** Évaluation complète et diagnostiquée de la dernière barre. Pure. */
export function evaluateIvb(bars: readonly OhlcvBar[], params: Partial<IvbParams> = {}): IvbEvaluation {
  const p: IvbParams = { ...IVB_DEFAULTS, ...params };
  const none = (reason: string, partial: Partial<IvbEvaluation> = {}): IvbEvaluation => ({
    day: "",
    range: null,
    previousDays: [],
    contractionRatio: null,
    breakoutIdx: null,
    side: null,
    volumeRatio: null,
    atr: null,
    fires: false,
    reason,
    ...partial,
  });
  if (bars.length === 0) return none("aucune barre");
  const lastIdx = bars.length - 1;
  const last = bars[lastIdx]!;
  if (!Number.isFinite(last.ts)) return none("barres invalides ou non chronologiques");
  const stLast = localStamp(last.ts, p.timeZone);
  const day = stLast.day;

  // Seuls les lookbackDays + 1 derniers jours locaux servent : on remonte jusqu'à leur première barre.
  let fromIdx = lastIdx;
  let daysSeen = 1;
  let prevDay = day;
  for (let i = lastIdx - 1; i >= 0; i--) {
    const ts = bars[i]!.ts;
    if (!Number.isFinite(ts)) break;
    const d = localStamp(ts, p.timeZone).day;
    if (d !== prevDay) {
      daysSeen += 1;
      if (daysSeen > p.lookbackDays + 1) break;
      prevDay = d;
    }
    fromIdx = i;
  }
  // Les barres plus anciennes que la fenêtre utile ne sont pas lues : leur validité est indifférente.
  if (!barsAreSane(bars, Math.max(0, fromIdx - Math.max(p.volumeLookbackBars, p.atrPeriod + 1)))) return none("barres invalides ou non chronologiques");
  const ranges = dayRanges(bars, p, fromIdx);
  const todayRange = ranges.find((r) => r.day === day) ?? null;
  if (!todayRange || !todayRange.complete) return none("fourchette d'ouverture du jour incomplète ou absente", { day, range: todayRange });

  // Contraction : moyenne des `lookbackDays` jours PRÉCÉDENTS complets (jour courant exclu).
  const previous = ranges.filter((r) => r.day < day && r.complete).slice(-p.lookbackDays);
  if (previous.length < p.lookbackDays) {
    return none(`historique insuffisant : ${previous.length} jours précédents complets < ${p.lookbackDays}`, { day, range: todayRange, previousDays: previous.map((r) => r.day) });
  }
  const avgWidth = previous.reduce((s, r) => s + r.width, 0) / previous.length;
  const contractionRatio = avgWidth > 0 ? todayRange.width / avgWidth : Infinity;
  const base: Partial<IvbEvaluation> = { day, range: todayRange, previousDays: previous.map((r) => r.day), contractionRatio };
  if (!(contractionRatio <= p.maxContractionRatio)) return none(`pas de contraction : ratio ${contractionRatio.toFixed(3)} > ${p.maxContractionRatio}`, base);

  // Première cassure dans la fenêtre [rangeEnd, rangeEnd + breakoutWindow).
  let breakoutIdx: number | null = null;
  let side: Side | null = null;
  const firstWindowIdx = (todayRange.barIdx[todayRange.barIdx.length - 1] ?? -1) + 1;
  for (let i = firstWindowIdx; i <= lastIdx; i++) {
    const b = bars[i]!;
    const st = localStamp(b.ts, p.timeZone);
    if (st.day !== day) continue;
    if (st.minutes < p.rangeEndMin) continue;
    if (st.minutes >= p.rangeEndMin + p.breakoutWindowMin) break;
    if (b.close > todayRange.high) {
      breakoutIdx = i;
      side = "BUY";
      break;
    }
    if (b.close < todayRange.low) {
      breakoutIdx = i;
      side = "SELL";
      break;
    }
  }
  if (breakoutIdx === null || side === null) {
    const stNow = stLast.minutes;
    const late = stNow >= p.rangeEndMin + p.breakoutWindowMin;
    return none(late ? "fenêtre de cassure terminée sans cassure (cassure tardive ignorée)" : "aucune clôture hors fourchette pour l'instant", base);
  }
  if (breakoutIdx !== lastIdx) {
    return none(`la première cassure a déjà eu lieu (barre ${breakoutIdx}, ${new Date(bars[breakoutIdx]!.ts).toISOString()}) : pas de seconde entrée`, { ...base, breakoutIdx, side });
  }

  // Volume de la barre de cassure vs moyenne des N barres PRÉCÉDENTES (barre courante exclue).
  if (breakoutIdx - p.volumeLookbackBars < 0) return none(`historique de volume insuffisant (< ${p.volumeLookbackBars} barres précédentes)`, { ...base, breakoutIdx, side });
  let volSum = 0;
  for (let i = breakoutIdx - p.volumeLookbackBars; i < breakoutIdx; i++) volSum += bars[i]!.volume;
  const avgVol = volSum / p.volumeLookbackBars;
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : Infinity;
  const withVol: Partial<IvbEvaluation> = { ...base, breakoutIdx, side, volumeRatio };
  if (!(volumeRatio >= p.minVolumeRatio)) return none(`volume insuffisant : ratio ${volumeRatio.toFixed(2)} < ${p.minVolumeRatio}`, withVol);

  const a = atr(bars, breakoutIdx, p.atrPeriod);
  if (a === null) return none(`ATR indisponible (< ${p.atrPeriod + 1} barres)`, withVol);

  return { ...none("", withVol), atr: a, fires: true, reason: null };
}

/** Instant UTC de la sortie forcée pour le jour local donné. */
export function forcedExitTs(day: string, p: IvbParams): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc(p.timeZone, y, m, d, Math.floor(p.forcedExitMin / 60), p.forcedExitMin % 60);
}

export function createS4Ivb(overrides: Partial<IvbParams> = {}): Strategy {
  const p: IvbParams = { ...IVB_DEFAULTS, ...overrides };
  const hm = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
  return {
    id: "s4-ivb",
    version: "2.0.0",
    family: "crypto",
    describe: () =>
      `IVB ${p.barMinutes} min : fourchette ${hm(p.rangeStartMin)}–${hm(p.rangeEndMin)} ${p.timeZone}, contraction ≤ ${p.maxContractionRatio} × moyenne des ${p.lookbackDays} jours précédents, première clôture hors fourchette dans les ${p.breakoutWindowMin} min, volume ≥ ${p.minVolumeRatio} × moyenne des ${p.volumeLookbackBars} barres précédentes, stop bord opposé ∓ ${p.stopAtrBuffer} ATR(${p.atrPeriod}), objectif ${p.targetR} R, sortie forcée ${hm(p.forcedExitMin)}, ${p.maxEntriesPerDay} ordre/séance`,
    signals(input: StrategyInput): StrategySignal[] {
      const bars = input.bars;
      if (!bars || bars.length === 0) return [];
      const ev = evaluateIvb(bars, p);
      if (!ev.fires || ev.side === null || ev.range === null || ev.atr === null || ev.breakoutIdx === null) return [];
      const bar = bars[ev.breakoutIdx]!;
      const entry = bar.close;
      const stop = ev.side === "BUY" ? ev.range.low - p.stopAtrBuffer * ev.atr : ev.range.high + p.stopAtrBuffer * ev.atr;
      const r = Math.abs(entry - stop);
      if (!(r > 0)) return [];
      const target = ev.side === "BUY" ? entry + p.targetR * r : entry - p.targetR * r;
      const exitBy = new Date(forcedExitTs(ev.day, p)).toISOString();
      const contraction = ev.contractionRatio ?? 1;
      const vol = ev.volumeRatio ?? p.minVolumeRatio;
      const strength = Math.round(clamp(50 + 25 * (1 - contraction / p.maxContractionRatio) + 25 * Math.min(1, (vol - p.minVolumeRatio) / p.minVolumeRatio), 0, 100));
      return [
        {
          strategyId: "s4-ivb",
          strategyVersion: "2.0.0",
          symbol: input.symbol ?? "?",
          side: ev.side,
          strength,
          reasons: [
            `fourchette ${hm(p.rangeStartMin)}–${hm(p.rangeEndMin)} ${p.timeZone} : ${ev.range.low} – ${ev.range.high} (largeur ${ev.range.width.toPrecision(4)})`,
            `contraction ${contraction.toFixed(3)} ≤ ${p.maxContractionRatio} vs ${ev.previousDays.length} jours précédents (${ev.previousDays[0]} → ${ev.previousDays[ev.previousDays.length - 1]})`,
            `première clôture hors fourchette ${entry} à ${new Date(bar.ts).toISOString()} (barre ${ev.breakoutIdx})`,
            `volume ${bar.volume} = ${vol.toFixed(2)} × moyenne des ${p.volumeLookbackBars} barres précédentes`,
            `ATR(${p.atrPeriod}) ${ev.atr.toPrecision(4)} ; stop ${stop.toPrecision(6)} ; R ${r.toPrecision(4)} ; objectif ${target.toPrecision(6)}`,
          ],
          invalidation: `clôture ${ev.side === "BUY" ? "<" : ">"} ${stop.toPrecision(6)} (bord opposé ∓ ${p.stopAtrBuffer} ATR) ou ${hm(p.forcedExitMin)} ${p.timeZone} (${exitBy})`,
          proposedStop: stop,
          proposedTarget: target,
          exitBy,
          refPrice: entry,
          ts: new Date(input.now).toISOString(),
        },
      ];
    },
  };
}
