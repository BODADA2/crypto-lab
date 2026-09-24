/**
 * Harnais de backtest sur snapshots historiques.
 *
 * Données : `data/history/<mint>.jsonl` — une ligne JSON par observation (TokenSnapshot),
 * ordre chronologique, idéalement une observation toutes les 5 minutes.
 *
 * Déroulement : pour chaque token, on fait glisser une fenêtre ; le signal reçoit la série
 * jusqu'à l'instant t (jamais le futur) ; si `score >= threshold` et pas de position ouverte,
 * on entre AU PRIX DE L'OBSERVATION SUIVANTE (t+1, pas de lookahead), coûts déduits.
 * Sortie : take-profit, stop-loss, time-stop (nombre d'observations) ou fin de série.
 * Coûts : frais fixes (1,3 % aller-retour par défaut : ~1 % terminal + ~0,3 % réseau/priorité)
 * + slippage ∝ taille / liquidité (modèle produit constant simplifié, plafonné).
 *
 * Refus explicite de conclure si n < 30 trades.
 *
 * Chantier 2 : le harnais accepte aussi une `Strategy` (lab/strategies) à la place d'un signal ad hoc
 * (`runStrategyBacktest`) et des barres OHLCV pour la famille crypto (`simulateBars` / `runBarsBacktest`).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeSnapshot } from "../collect/types.ts";
import { localStamp } from "../strategies/ohlcv.ts";
import type { OhlcvBar, Side, Strategy, StrategyContext, StrategyInput, StrategySignal } from "../strategies/types.ts";
import type { TokenSnapshot } from "../types.ts";

export type SignalFn = (seriesUpToNow: TokenSnapshot[]) => { score: number } | number;

export interface BacktestRules {
  /** Score minimal d'entrée. */
  threshold: number;
  /** Take-profit en fraction (0.5 = +50 %). */
  takeProfit: number;
  /** Stop-loss en fraction (0.25 = -25 %). */
  stopLoss: number;
  /** Nombre max d'observations en position. */
  timeStopBars: number;
  /** Taille de position en USD (influence le slippage). */
  sizeUsd: number;
  /** Frais fixes aller-retour, fraction (défaut 0.013). */
  feesRoundTrip?: number;
  /** Plafond de slippage par côté (défaut 0.03 = politique de risque). */
  maxSlippage?: number;
  /** Liquidité minimale pour entrer (défaut 20 000 $). */
  minLiquidityUsd?: number;
  /** Nombre d'observations avant qu'un nouveau trade sur le même token soit possible (défaut 1). */
  cooldownBars?: number;
}

export interface Trade {
  /** Mint (memecoin) ou symbole (crypto). */
  mint: string;
  entryAt: string;
  exitAt: string;
  entryPrice: number;
  exitPrice: number;
  /** Rendement net (fraction) après frais et slippage. */
  ret: number;
  /** Rendement brut prix seul. */
  grossRet: number;
  bars: number;
  exit: "take-profit" | "stop-loss" | "time-stop" | "end-of-data";
  score: number;
  costs: number;
  /** BUY (long) ou SELL (short, famille crypto). Absent = BUY. */
  side?: Side;
  strategyId?: string;
  /** Contexte au moment de l'entrée (métriques par régime). */
  context?: StrategyContext;
}

export interface BacktestReport {
  n: number;
  conclusive: boolean;
  message: string;
  winRate: number | null;
  /** Espérance = rendement moyen net par trade (fraction). */
  expectancy: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  /** Max drawdown de la courbe d'équité composée (fraction). */
  maxDrawdown: number | null;
  /** Équité finale pour 1 unité de capital (composé trade après trade, taille fixe). */
  finalEquity: number | null;
  exits: Record<Trade["exit"], number>;
  trades: Trade[];
  tokens: number;
  observations: number;
}

export const MIN_TRADES_FOR_CONCLUSION = 30;

/** Slippage estimé par côté : impact ≈ taille / liquidité (moitié du pool de chaque côté), plafonné. */
export function estimateSlippage(sizeUsd: number, liquidityUsd: number | null, cap = 0.03): number {
  if (!liquidityUsd || liquidityUsd <= 0) return cap;
  return Math.min(cap, sizeUsd / liquidityUsd);
}

function scoreOf(v: { score: number } | number): number {
  return typeof v === "number" ? v : v.score;
}

/** Simule un seul token ; renvoie les trades. */
export function simulateToken(series: TokenSnapshot[], signal: SignalFn, rules: BacktestRules): Trade[] {
  const fees = rules.feesRoundTrip ?? 0.013;
  const cap = rules.maxSlippage ?? 0.03;
  const minLiq = rules.minLiquidityUsd ?? 20_000;
  const cooldown = rules.cooldownBars ?? 1;
  const trades: Trade[] = [];
  let i = 0;
  while (i < series.length - 1) {
    const upToNow = series.slice(0, i + 1);
    const score = scoreOf(signal(upToNow));
    const next = series[i + 1] as TokenSnapshot;
    if (score < rules.threshold || next.priceUsd <= 0 || next.liquidityUsd < minLiq) {
      i += 1;
      continue;
    }
    // Entrée à t+1.
    const entryIdx = i + 1;
    const entry = next;
    const entryPrice = entry.priceUsd;
    const slipIn = estimateSlippage(rules.sizeUsd, entry.liquidityUsd, cap);
    let exitIdx = -1;
    let exit: Trade["exit"] = "end-of-data";
    for (let j = entryIdx + 1; j < series.length; j++) {
      const s = series[j] as TokenSnapshot;
      if (s.priceUsd <= 0) continue; // 0 = prix inconnu
      const gross = s.priceUsd / entryPrice - 1;
      if (gross <= -rules.stopLoss) {
        exitIdx = j;
        exit = "stop-loss";
        break;
      }
      if (gross >= rules.takeProfit) {
        exitIdx = j;
        exit = "take-profit";
        break;
      }
      if (j - entryIdx >= rules.timeStopBars) {
        exitIdx = j;
        exit = "time-stop";
        break;
      }
    }
    if (exitIdx === -1) {
      // Fin de série : on sort sur la dernière observation valorisée.
      for (let j = series.length - 1; j > entryIdx; j--) {
        if ((series[j] as TokenSnapshot).priceUsd > 0) {
          exitIdx = j;
          break;
        }
      }
      if (exitIdx === -1) break; // aucune observation de sortie possible
    }
    const exitSnap = series[exitIdx] as TokenSnapshot;
    const exitPrice = exitSnap.priceUsd;
    const slipOut = estimateSlippage(rules.sizeUsd, exitSnap.liquidityUsd, cap);
    const grossRet = exitPrice / entryPrice - 1;
    const costs = fees + slipIn + slipOut;
    const ret = (1 + grossRet) * (1 - slipIn) * (1 - slipOut) * (1 - fees) - 1;
    trades.push({
      mint: entry.mint,
      entryAt: entry.fetchedAt,
      exitAt: exitSnap.fetchedAt,
      entryPrice,
      exitPrice,
      ret,
      grossRet,
      bars: exitIdx - entryIdx,
      exit,
      score,
      costs,
    });
    i = exitIdx + cooldown;
  }
  return trades;
}

export function summarize(trades: Trade[], tokens: number, observations: number): BacktestReport {
  const n = trades.length;
  const exits: BacktestReport["exits"] = { "take-profit": 0, "stop-loss": 0, "time-stop": 0, "end-of-data": 0 };
  for (const t of trades) exits[t.exit] += 1;
  if (n === 0) {
    return {
      n,
      conclusive: false,
      message: `Aucun trade généré (n=0 < ${MIN_TRADES_FOR_CONCLUSION}) : impossible de conclure.`,
      winRate: null,
      expectancy: null,
      avgWin: null,
      avgLoss: null,
      profitFactor: null,
      maxDrawdown: null,
      finalEquity: null,
      exits,
      trades,
      tokens,
      observations,
    };
  }
  const wins = trades.filter((t) => t.ret > 0);
  const losses = trades.filter((t) => t.ret <= 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const expectancy = sum(trades.map((t) => t.ret)) / n;
  const grossWin = sum(wins.map((t) => t.ret));
  const grossLoss = Math.abs(sum(losses.map((t) => t.ret)));
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of [...trades].sort((a, b) => a.entryAt.localeCompare(b.entryAt))) {
    equity *= 1 + t.ret;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  const conclusive = n >= MIN_TRADES_FOR_CONCLUSION;
  return {
    n,
    conclusive,
    message: conclusive
      ? `n=${n} trades : résultats statistiquement exploitables (avec prudence : données de fixtures/historique partiel).`
      : `n=${n} < ${MIN_TRADES_FOR_CONCLUSION} trades : échantillon trop petit, AUCUNE conclusion ne doit être tirée.`,
    winRate: wins.length / n,
    expectancy,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null,
    maxDrawdown: maxDd,
    finalEquity: equity,
    exits,
    trades,
    tokens,
    observations,
  };
}

export function runBacktest(seriesByMint: Map<string, TokenSnapshot[]>, signal: SignalFn, rules: BacktestRules): BacktestReport {
  const trades: Trade[] = [];
  let observations = 0;
  for (const [, series] of seriesByMint) {
    const sorted = [...series].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    observations += sorted.length;
    trades.push(...simulateToken(sorted, signal, rules));
  }
  return summarize(trades, seriesByMint.size, observations);
}

// ---------------------------------------------------------------------------
// Stratégies (lab/strategies) sur snapshots — famille memecoin
// ---------------------------------------------------------------------------

/** Compléments d'input par série (wallets suivis, achats, migration, contexte) : fonction de la série jusqu'à t. */
export type InputExtras = (seriesUpToNow: TokenSnapshot[]) => Partial<Omit<StrategyInput, "now" | "snapshot" | "history">>;

/** Construit l'input d'une stratégie à l'instant de la dernière observation (jamais de futur). */
export function inputFromSeries(seriesUpToNow: TokenSnapshot[], extras?: InputExtras): StrategyInput {
  const last = seriesUpToNow[seriesUpToNow.length - 1] ?? null;
  const now = last ? Date.parse(last.fetchedAt) : 0;
  return { now, snapshot: last, history: seriesUpToNow, context: {}, ...(extras ? extras(seriesUpToNow) : {}) };
}

/** Force du meilleur signal BUY de la stratégie (0 si aucun) — adapte une Strategy au SignalFn du harnais. */
export function strategyToSignalFn(strategy: Strategy, extras?: InputExtras): SignalFn {
  return (seriesUpToNow) => {
    const input = inputFromSeries(seriesUpToNow, extras);
    let best = 0;
    for (const sig of strategy.signals(input)) if (sig.side === "BUY" && sig.strength > best) best = sig.strength;
    return best;
  };
}

/** Backtest d'une stratégie memecoin : mêmes règles de sortie que `runBacktest`, trades étiquetés par stratégie. */
export function runStrategyBacktest(seriesByMint: Map<string, TokenSnapshot[]>, strategy: Strategy, rules: BacktestRules, extras?: InputExtras): BacktestReport {
  if (strategy.family !== "memecoin") throw new Error(`runStrategyBacktest attend une stratégie memecoin (${strategy.id} est ${strategy.family})`);
  const report = runBacktest(seriesByMint, strategyToSignalFn(strategy, extras), rules);
  for (const t of report.trades) t.strategyId = strategy.id;
  return report;
}

// ---------------------------------------------------------------------------
// Stratégies sur barres OHLCV — famille crypto (S4)
// ---------------------------------------------------------------------------

export interface BarBacktestRules {
  /** Force minimale du signal pour passer l'ordre. */
  minStrength: number;
  /** Frais aller-retour, fraction (défaut 0.002). */
  feesRoundTrip?: number;
  /** Slippage par côté, fraction (défaut 0.0005). */
  slippagePerSide?: number;
  /** Ordres max par jour local (défaut 1). Le compteur est incrémenté À L'ORDRE, jamais au signal. */
  maxEntriesPerDay?: number;
  /** Fuseau du compteur journalier (défaut America/New_York). */
  timeZone?: string;
  /** "next-open" (défaut, pas de lookahead : rempli à l'ouverture de la barre suivante) ou "signal-close". */
  fillAt?: "next-open" | "signal-close";
  /** Porte avant l'ordre (ex. Risk Engine simulé) : false ⇒ pas d'ordre, compteur inchangé. */
  canOrder?: (signal: StrategySignal, bar: OhlcvBar) => boolean;
  /** Time-stop en barres si le signal n'a pas de `exitBy` (défaut 0 = aucun). */
  timeStopBars?: number;
  context?: StrategyContext;
}

export interface BarBacktestReport extends BacktestReport {
  /** Signaux vus (≥ minStrength) et ordres passés — le premier peut dépasser le second (porte, fin de données). */
  signalsSeen: number;
  ordersPlaced: number;
  /** Ordres par jour local (clé AAAA-MM-JJ). */
  ordersByDay: Record<string, number>;
}

/**
 * Simule une stratégie « crypto » sur une série de barres. À chaque barre clôturée i, la stratégie reçoit
 * bars[0..i] (jamais le futur). Sorties : stop (prix du stop, ou ouverture si gap au-delà), objectif, `exitBy`
 * (clôture de la barre qui l'atteint), time-stop en barres, fin de données. Short (SELL) : rendement inversé.
 */
export function simulateBars(bars: OhlcvBar[], strategy: Strategy, rules: BarBacktestRules, symbol = "?"): { trades: Trade[]; signalsSeen: number; ordersPlaced: number; ordersByDay: Record<string, number> } {
  const fees = rules.feesRoundTrip ?? 0.002;
  const slip = rules.slippagePerSide ?? 0.0005;
  const maxPerDay = rules.maxEntriesPerDay ?? 1;
  const tz = rules.timeZone ?? "America/New_York";
  const fillAt = rules.fillAt ?? "next-open";
  const barMs = bars.length >= 2 ? Math.min(...bars.slice(1, Math.min(bars.length, 50)).map((b, i) => b.ts - bars[i]!.ts)) : 300_000;
  const trades: Trade[] = [];
  const ordersByDay: Record<string, number> = {};
  let signalsSeen = 0;
  let ordersPlaced = 0;
  let i = 0;
  while (i < bars.length - 1) {
    const bar = bars[i]!;
    const input: StrategyInput = { now: bar.ts + barMs, snapshot: null, history: [], symbol, bars: bars.slice(0, i + 1), context: rules.context ?? {} };
    const sig = strategy
      .signals(input)
      .filter((s) => s.strength >= rules.minStrength)
      .sort((a, b) => b.strength - a.strength)[0];
    if (!sig) {
      i += 1;
      continue;
    }
    signalsSeen += 1;
    const day = localStamp(bar.ts, tz).day;
    if ((ordersByDay[day] ?? 0) >= maxPerDay || (rules.canOrder && !rules.canOrder(sig, bar))) {
      i += 1;
      continue;
    }
    // Ordre passé : c'est ICI que le compteur s'incrémente.
    ordersByDay[day] = (ordersByDay[day] ?? 0) + 1;
    ordersPlaced += 1;
    const entryIdx = fillAt === "next-open" ? i + 1 : i;
    const entryBar = bars[entryIdx]!;
    const entryPrice = fillAt === "next-open" ? entryBar.open : entryBar.close;
    const side: Side = sig.side;
    const stop = sig.proposedStop;
    const target = sig.proposedTarget;
    const exitByMs = sig.exitBy ? Date.parse(sig.exitBy) : NaN;
    let exitIdx = -1;
    let exitPrice = 0;
    let exit: Trade["exit"] = "end-of-data";
    for (let j = fillAt === "next-open" ? entryIdx : entryIdx + 1; j < bars.length; j++) {
      const b = bars[j]!;
      if (stop !== undefined && (side === "BUY" ? b.low <= stop : b.high >= stop)) {
        exitIdx = j;
        exitPrice = side === "BUY" ? Math.min(stop, b.open) : Math.max(stop, b.open);
        exit = "stop-loss";
        break;
      }
      if (target !== undefined && (side === "BUY" ? b.high >= target : b.low <= target)) {
        exitIdx = j;
        exitPrice = target;
        exit = "take-profit";
        break;
      }
      if (Number.isFinite(exitByMs) && b.ts + barMs >= exitByMs) {
        exitIdx = j;
        exitPrice = b.close;
        exit = "time-stop";
        break;
      }
      if ((rules.timeStopBars ?? 0) > 0 && j - entryIdx >= (rules.timeStopBars as number)) {
        exitIdx = j;
        exitPrice = b.close;
        exit = "time-stop";
        break;
      }
    }
    if (exitIdx === -1) {
      exitIdx = bars.length - 1;
      exitPrice = bars[exitIdx]!.close;
      exit = "end-of-data";
    }
    const grossRet = side === "BUY" ? exitPrice / entryPrice - 1 : 1 - exitPrice / entryPrice;
    const costs = fees + 2 * slip;
    trades.push({
      mint: symbol,
      entryAt: new Date(entryBar.ts).toISOString(),
      exitAt: new Date(bars[exitIdx]!.ts + barMs).toISOString(),
      entryPrice,
      exitPrice,
      ret: grossRet - costs,
      grossRet,
      bars: exitIdx - entryIdx,
      exit,
      score: sig.strength,
      costs,
      side,
      strategyId: strategy.id,
      context: rules.context ?? {},
    });
    i = exitIdx + 1;
  }
  return { trades, signalsSeen, ordersPlaced, ordersByDay };
}

export function runBarsBacktest(barsBySymbol: Map<string, OhlcvBar[]>, strategy: Strategy, rules: BarBacktestRules): BarBacktestReport {
  if (strategy.family !== "crypto") throw new Error(`runBarsBacktest attend une stratégie crypto (${strategy.id} est ${strategy.family})`);
  const trades: Trade[] = [];
  const ordersByDay: Record<string, number> = {};
  let observations = 0;
  let signalsSeen = 0;
  let ordersPlaced = 0;
  for (const [symbol, bars] of barsBySymbol) {
    const sorted = [...bars].sort((a, b) => a.ts - b.ts);
    observations += sorted.length;
    const r = simulateBars(sorted, strategy, rules, symbol);
    trades.push(...r.trades);
    signalsSeen += r.signalsSeen;
    ordersPlaced += r.ordersPlaced;
    for (const [d, n] of Object.entries(r.ordersByDay)) ordersByDay[`${symbol}:${d}`] = n;
  }
  return { ...summarize(trades, barsBySymbol.size, observations), signalsSeen, ordersPlaced, ordersByDay };
}

/** Lit un fichier JSONL de snapshots (lignes vides ignorées, lignes invalides écartées, anciens formats normalisés). */
export function readHistoryFile(path: string): TokenSnapshot[] {
  const out: TokenSnapshot[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const s = normalizeSnapshot(JSON.parse(l));
      if (s) out.push(s);
    } catch {
      /* ligne corrompue : ignorée */
    }
  }
  return out;
}

/** Charge tout `data/history/*.jsonl` en Map<mint, série>. */
export function loadHistoryDir(dir: string): Map<string, TokenSnapshot[]> {
  const map = new Map<string, TokenSnapshot[]>();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const series = readHistoryFile(join(dir, f));
    if (series.length) map.set(f.replace(/\.jsonl$/, ""), series);
  }
  return map;
}

/** Rendu texte du rapport (pour la console et le brief). */
export function formatReport(r: BacktestReport): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)} %`);
  const lines = [
    `Backtest : ${r.tokens} tokens, ${r.observations} observations, n=${r.n} trades`,
    r.message,
  ];
  if (r.n > 0) {
    lines.push(
      `win rate ${pct(r.winRate)} | espérance ${pct(r.expectancy)} / trade | gain moyen ${pct(r.avgWin)} | perte moyenne ${pct(r.avgLoss)}`,
      `profit factor ${r.profitFactor === null ? "n/a" : r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2)} | max drawdown ${pct(r.maxDrawdown)} | équité finale ${r.finalEquity?.toFixed(3)}`,
      `sorties : TP ${r.exits["take-profit"]}, SL ${r.exits["stop-loss"]}, time ${r.exits["time-stop"]}, fin ${r.exits["end-of-data"]}`,
    );
  }
  return lines.join("\n");
}
