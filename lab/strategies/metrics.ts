/**
 * Métriques par stratégie à partir d'une liste de trades simulés (harnais) ou du ledger.
 *
 * Toutes les fonctions sont pures et déterministes (même liste ⇒ mêmes chiffres, à l'ordre près : les trades
 * sont triés par date d'entrée puis de sortie puis clé).
 *
 * Refus de conclure : n < MIN_TRADES_FOR_CONCLUSION (30) ⇒ `conclusive: false` + message. Les chiffres sont
 * quand même calculés (utiles pour le suivi), mais le champ `conclusive` doit être vérifié avant toute décision.
 * Chaque bucket « par régime » porte son propre `conclusive` (n ≥ 30 dans le bucket).
 *
 * Sharpe / Sortino PAR TRADE, annualisés :
 *   sharpe_trade  = moyenne(ret) / écart-type(ret)  (écart-type d'échantillon, n − 1)
 *   sortino_trade = moyenne(ret) / écart-type des pertes (racine de la moyenne des min(0, ret)²)
 *   annualisation : × √(tradesPerYear), tradesPerYear = n / (durée couverte en années), durée = première entrée →
 *   dernière sortie ; si la durée est < 1 jour (ou n < 2), aucune annualisation (facteur 1) et
 *   `annualization.applied = false`. Le taux sans risque est pris à 0.
 */
import { zonedParts } from "../time.ts";
import type { LedgerEntry } from "../types.ts";
import type { Side, StrategyContext } from "./types.ts";

export const MIN_TRADES_FOR_CONCLUSION = 30;

export interface StrategyTrade {
  strategyId: string;
  /** Mint ou symbole. */
  key: string;
  side: Side;
  entryAt: string;
  exitAt: string;
  /** Rendement NET par trade (fraction), frais et slippage déduits. */
  ret: number;
  /** Rendement brut (prix seul). */
  grossRet?: number;
  /** Frais en fraction du notionnel (aller-retour). */
  fees?: number;
  /** Slippage en fraction du notionnel (aller-retour). */
  slippage?: number;
  /** Contexte à l'entrée (tendance SOL 24 h…). */
  context?: StrategyContext;
}

export interface Bucket {
  n: number;
  conclusive: boolean;
  winRate: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  totalRet: number;
}

export interface StrategyMetrics {
  strategyId: string;
  n: number;
  conclusive: boolean;
  message: string;
  winRate: number | null;
  /** Espérance = rendement net moyen par trade (fraction). */
  expectancy: number | null;
  profitFactor: number | null;
  /** Drawdown max de la courbe d'équité composée (fraction), trades dans l'ordre chronologique. */
  maxDrawdown: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Frais et slippage moyens par trade (fraction), sur les trades qui les renseignent. */
  avgFees: number | null;
  avgSlippage: number | null;
  sharpe: number | null;
  sortino: number | null;
  annualization: { applied: boolean; tradesPerYear: number | null; factor: number; spanDays: number };
  byRegime: {
    /** Heure locale d'entrée (00..23) dans `timeZone`. */
    hour: Record<string, Bucket>;
    /** Jour de semaine d'entrée (lun..dim). */
    weekday: Record<string, Bucket>;
    /** Tendance SOL 24 h à l'entrée : "up" (> 0), "down" (< 0), "flat" (= 0), "unknown". */
    solTrend: Record<string, Bucket>;
  };
  timeZone: string;
  firstEntryAt: string | null;
  lastExitAt: string | null;
}

export interface MetricsOptions {
  /** Fuseau des buckets heure / jour (défaut America/Moncton). */
  timeZone?: string;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0);
function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}
const WEEKDAYS = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];

function bucketOf(trades: StrategyTrade[]): Bucket {
  const n = trades.length;
  const wins = trades.filter((t) => t.ret > 0);
  const losses = trades.filter((t) => t.ret <= 0);
  const gw = sum(wins.map((t) => t.ret));
  const gl = Math.abs(sum(losses.map((t) => t.ret)));
  return {
    n,
    conclusive: n >= MIN_TRADES_FOR_CONCLUSION,
    winRate: n ? wins.length / n : null,
    expectancy: n ? sum(trades.map((t) => t.ret)) / n : null,
    profitFactor: gl > 0 ? gw / gl : wins.length ? Infinity : null,
    totalRet: sum(trades.map((t) => t.ret)),
  };
}

function groupBy(trades: StrategyTrade[], key: (t: StrategyTrade) => string): Record<string, Bucket> {
  const groups = new Map<string, StrategyTrade[]>();
  for (const t of trades) {
    const k = key(t);
    const list = groups.get(k) ?? [];
    list.push(t);
    groups.set(k, list);
  }
  const out: Record<string, Bucket> = {};
  for (const k of Array.from(groups.keys()).sort()) out[k] = bucketOf(groups.get(k)!);
  return out;
}

export function solTrendOf(ctx: StrategyContext | undefined): "up" | "down" | "flat" | "unknown" {
  const v = ctx?.solChange24hPct;
  if (typeof v !== "number" || !Number.isFinite(v)) return "unknown";
  return v > 0 ? "up" : v < 0 ? "down" : "flat";
}

export function sortTrades(trades: readonly StrategyTrade[]): StrategyTrade[] {
  return [...trades].sort((a, b) => a.entryAt.localeCompare(b.entryAt) || a.exitAt.localeCompare(b.exitAt) || a.key.localeCompare(b.key));
}

/** Métriques d'UNE stratégie (les trades d'autres stratégies sont ignorés si `strategyId` est fourni). */
export function computeStrategyMetrics(input: readonly StrategyTrade[], strategyId?: string, opts: MetricsOptions = {}): StrategyMetrics {
  const tz = opts.timeZone ?? "America/Moncton";
  const id = strategyId ?? input[0]?.strategyId ?? "?";
  const trades = sortTrades(input.filter((t) => t.strategyId === id && Number.isFinite(t.ret)));
  const n = trades.length;
  const conclusive = n >= MIN_TRADES_FOR_CONCLUSION;
  const message = conclusive
    ? `n=${n} trades : exploitable avec prudence (frais et slippage modélisés, pas de garantie hors échantillon).`
    : `n=${n} < ${MIN_TRADES_FOR_CONCLUSION} trades : échantillon trop petit, AUCUNE conclusion ne doit être tirée.`;
  const empty: StrategyMetrics = {
    strategyId: id,
    n,
    conclusive,
    message,
    winRate: null,
    expectancy: null,
    profitFactor: null,
    maxDrawdown: null,
    avgWin: null,
    avgLoss: null,
    avgFees: null,
    avgSlippage: null,
    sharpe: null,
    sortino: null,
    annualization: { applied: false, tradesPerYear: null, factor: 1, spanDays: 0 },
    byRegime: { hour: {}, weekday: {}, solTrend: {} },
    timeZone: tz,
    firstEntryAt: null,
    lastExitAt: null,
  };
  if (n === 0) return empty;

  const rets = trades.map((t) => t.ret);
  const wins = trades.filter((t) => t.ret > 0);
  const losses = trades.filter((t) => t.ret <= 0);
  const grossWin = sum(wins.map((t) => t.ret));
  const grossLoss = Math.abs(sum(losses.map((t) => t.ret)));
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of trades) {
    equity *= 1 + t.ret;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
  }
  const fees = trades.map((t) => t.fees).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const slips = trades.map((t) => t.slippage).filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const first = trades[0]!.entryAt;
  const lastExit = trades.reduce((m, t) => (t.exitAt > m ? t.exitAt : m), trades[0]!.exitAt);
  const spanMs = Math.max(0, Date.parse(lastExit) - Date.parse(first));
  const spanDays = spanMs / 86_400_000;
  const applied = n >= 2 && spanDays >= 1;
  const tradesPerYear = applied ? n / (spanDays / 365.25) : null;
  const factor = applied && tradesPerYear ? Math.sqrt(tradesPerYear) : 1;

  const m = mean(rets);
  const sd = sampleStd(rets);
  const downside = Math.sqrt(mean(rets.map((r) => Math.min(0, r) ** 2)));
  const sharpe = sd > 0 ? (m / sd) * factor : null;
  const sortino = downside > 0 ? (m / downside) * factor : null;

  return {
    ...empty,
    winRate: wins.length / n,
    expectancy: m,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null,
    maxDrawdown: maxDd,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    avgFees: fees.length ? mean(fees) : null,
    avgSlippage: slips.length ? mean(slips) : null,
    sharpe,
    sortino,
    annualization: { applied, tradesPerYear, factor, spanDays },
    byRegime: {
      hour: groupBy(trades, (t) => String(zonedParts(new Date(Date.parse(t.entryAt)), tz).hour).padStart(2, "0")),
      weekday: groupBy(trades, (t) => {
        const p = zonedParts(new Date(Date.parse(t.entryAt)), tz);
        return WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()] ?? "?";
      }),
      solTrend: groupBy(trades, (t) => solTrendOf(t.context)),
    },
    firstEntryAt: first,
    lastExitAt: lastExit,
  };
}

/** Métriques de toutes les stratégies présentes dans la liste, par id trié. */
export function computeAllMetrics(trades: readonly StrategyTrade[], opts: MetricsOptions = {}): StrategyMetrics[] {
  const ids = Array.from(new Set(trades.map((t) => t.strategyId))).sort();
  return ids.map((id) => computeStrategyMetrics(trades, id, opts));
}

/** Adapte les trades du harnais (lab/backtest/harness.ts → Trade) au format des métriques. */
export function tradesFromBacktest(
  trades: ReadonlyArray<{ mint: string; entryAt: string; exitAt: string; ret: number; grossRet: number; costs: number; side?: Side; strategyId?: string; context?: StrategyContext }>,
  fallbackStrategyId = "adhoc",
): StrategyTrade[] {
  return trades.map((t) => ({
    strategyId: t.strategyId ?? fallbackStrategyId,
    key: t.mint,
    side: t.side ?? "BUY",
    entryAt: t.entryAt,
    exitAt: t.exitAt,
    ret: t.ret,
    grossRet: t.grossRet,
    // Le harnais modélise frais + slippage dans `costs` ; on ne sépare pas ce qu'il n'a pas séparé.
    fees: undefined,
    slippage: undefined,
    ...(t.context ? { context: t.context } : {}),
  }));
}

/**
 * Reconstruit des trades depuis le ledger : chaque SELL rempli (PAPER/EXECUTED) clôt la position ouverte par les
 * BUY remplis précédents sur le même mint (FIFO agrégé : coût moyen). `strategyId` est lu dans `reasons`
 * (`strategy:<id>`) sinon "ledger". Les frais viennent de `fees.totalCad`, le slippage de `fill.slippageBps`.
 */
export function tradesFromLedger(entries: readonly LedgerEntry[]): StrategyTrade[] {
  const filled = entries.filter((e) => e && (e.decision === "PAPER" || e.decision === "EXECUTED") && e.fill).sort((a, b) => a.ts.localeCompare(b.ts));
  const open = new Map<string, { costCad: number; qty: number; feesCad: number; slipBps: number[]; entryAt: string; strategyId: string }>();
  const out: StrategyTrade[] = [];
  const strategyOf = (e: LedgerEntry): string => {
    const r = e.reasons.find((x) => x.startsWith("strategy:"));
    return r ? r.slice("strategy:".length) : "ledger";
  };
  for (const e of filled) {
    const fill = e.fill!;
    if (e.kind === "BUY") {
      const cur = open.get(e.mint) ?? { costCad: 0, qty: 0, feesCad: 0, slipBps: [], entryAt: e.ts, strategyId: strategyOf(e) };
      cur.costCad += fill.netCad;
      cur.qty += fill.qty;
      cur.feesCad += e.fees?.totalCad ?? 0;
      cur.slipBps.push(fill.slippageBps);
      open.set(e.mint, cur);
    } else if (e.kind === "SELL") {
      const cur = open.get(e.mint);
      if (!cur || cur.qty <= 0 || cur.costCad <= 0) continue; // vente sans achat connu : ignorée
      const portion = Math.min(1, fill.qty / cur.qty);
      const costPart = cur.costCad * portion;
      const pnl = typeof e.pnlCad === "number" ? e.pnlCad : fill.netCad - costPart;
      const feesCad = cur.feesCad * portion + (e.fees?.totalCad ?? 0);
      const slipBps = mean([...cur.slipBps, fill.slippageBps]);
      out.push({
        strategyId: cur.strategyId,
        key: e.mint,
        side: "BUY",
        entryAt: cur.entryAt,
        exitAt: e.ts,
        ret: pnl / costPart,
        grossRet: (pnl + feesCad) / costPart,
        fees: feesCad / costPart,
        slippage: (slipBps * 2) / 10_000,
      });
      cur.qty -= fill.qty;
      cur.costCad -= costPart;
      cur.feesCad -= cur.feesCad * portion;
      if (cur.qty <= 1e-12) open.delete(e.mint);
    }
  }
  return out;
}

/** Rendu texte (brief / console). */
export function formatMetrics(m: StrategyMetrics): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(2)} %`);
  const num = (v: number | null) => (v === null ? "n/a" : v === Infinity ? "∞" : v.toFixed(2));
  const lines = [`${m.strategyId} : n=${m.n} — ${m.message}`];
  if (m.n > 0) {
    lines.push(
      `win rate ${pct(m.winRate)} | espérance ${pct(m.expectancy)} | profit factor ${num(m.profitFactor)} | max drawdown ${pct(m.maxDrawdown)}`,
      `gain moyen ${pct(m.avgWin)} | perte moyenne ${pct(m.avgLoss)} | frais ${pct(m.avgFees)} | slippage ${pct(m.avgSlippage)}`,
      `Sharpe ${num(m.sharpe)} | Sortino ${num(m.sortino)} (${m.annualization.applied ? `annualisés × √${m.annualization.tradesPerYear?.toFixed(0)} trades/an` : "par trade, non annualisés"})`,
    );
    const reg = (name: string, r: Record<string, Bucket>) =>
      `${name} : ${Object.entries(r)
        .map(([k, b]) => `${k} n=${b.n}${b.conclusive ? "" : "*"} esp ${pct(b.expectancy)}`)
        .join(" ; ")}`;
    lines.push(reg("par heure", m.byRegime.hour), reg("par jour", m.byRegime.weekday), reg("tendance SOL 24 h", m.byRegime.solTrend), "(* = bucket non concluant, n < 30)");
  }
  return lines.join("\n");
}
