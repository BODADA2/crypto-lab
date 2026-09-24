// Simulateur d'exécution (mode paper). Fonctions pures : elles renvoient un nouveau PortfolioState.
// Modèle de frais : 1 % plateforme + 0,3 % swap + priority fee estimée en SOL convertie en CAD.

import type { Intent, LedgerFees, LedgerFill, PortfolioState, Position } from "../types.ts";
import { dateKey, isoWeekKey } from "../time.ts";

export interface FillParams {
  /** Prix de référence du token (USD) — typiquement snapshot.priceUsd. */
  priceUsd: number;
  fxCadPerUsd: number;
  /** Slippage appliqué (bps). En paper : on applique le pire cas = maxSlippageBps de l'intent. */
  slippageBps: number;
  solPriceUsd: number;
  priorityFeeSol: number;
  /** Horodatage de l'exécution. */
  now: Date;
  /** Fuseau pour les clés jour/semaine du PnL. */
  timeZone: string;
  platformFeePct?: number; // défaut 1 %
  swapFeePct?: number; // défaut 0,3 %
  symbol?: string;
}

export interface PaperResult {
  portfolio: PortfolioState;
  fill: LedgerFill;
  fees: LedgerFees;
  pnlCad?: number;
}

export const DEFAULT_PLATFORM_FEE_PCT = 1;
export const DEFAULT_SWAP_FEE_PCT = 0.3;
const EPS_QTY = 1e-9;

export function emptyPortfolio(cashCad: number): PortfolioState {
  return {
    cashCad,
    positions: [],
    realizedPnlCad: 0,
    peakEquityCad: cashCad,
    dailyPnlByDate: {},
    weeklyPnlByWeek: {},
  };
}

export function clonePortfolio(p: PortfolioState): PortfolioState {
  return structuredClone(p);
}

/** Équité courante : cash + positions (au marché si connu, sinon au coût). */
export function equityOf(p: PortfolioState): number {
  return p.cashCad + p.positions.reduce((s, x) => s + (Number.isFinite(x.markCad) ? (x.markCad as number) : x.costCad), 0);
}

function assertParams(params: FillParams): void {
  const checks: Array<[string, number]> = [
    ["priceUsd", params.priceUsd],
    ["fxCadPerUsd", params.fxCadPerUsd],
    ["solPriceUsd", params.solPriceUsd],
  ];
  for (const [name, v] of checks) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`paper: ${name} doit être > 0`);
  }
  if (!Number.isFinite(params.slippageBps) || params.slippageBps < 0) throw new Error("paper: slippageBps invalide");
  if (!Number.isFinite(params.priorityFeeSol) || params.priorityFeeSol < 0) throw new Error("paper: priorityFeeSol invalide");
}

export function computeFees(grossCad: number, params: FillParams): LedgerFees {
  const platformCad = grossCad * ((params.platformFeePct ?? DEFAULT_PLATFORM_FEE_PCT) / 100);
  const swapCad = grossCad * ((params.swapFeePct ?? DEFAULT_SWAP_FEE_PCT) / 100);
  const priorityCad = params.priorityFeeSol * params.solPriceUsd * params.fxCadPerUsd;
  return { platformCad, swapCad, priorityCad, totalCad: platformCad + swapCad + priorityCad };
}

function bumpPnl(p: PortfolioState, pnl: number, now: Date, tz: string): void {
  const d = dateKey(now, tz);
  const w = isoWeekKey(now, tz);
  p.dailyPnlByDate[d] = (p.dailyPnlByDate[d] ?? 0) + pnl;
  p.weeklyPnlByWeek[w] = (p.weeklyPnlByWeek[w] ?? 0) + pnl;
  p.realizedPnlCad += pnl;
}

function updatePeak(p: PortfolioState): void {
  p.peakEquityCad = Math.max(p.peakEquityCad, equityOf(p));
}

/** Achat simulé : sizeCad de cash sort, les frais sont déduits, le reste est converti en tokens au prix dégradé. */
export function executeBuy(portfolio: PortfolioState, intent: Intent, sizeCad: number, params: FillParams): PaperResult {
  assertParams(params);
  if (!Number.isFinite(sizeCad) || sizeCad <= 0) throw new Error("paper: sizeCad doit être > 0");
  if (sizeCad > portfolio.cashCad + 1e-9) throw new Error("paper: cash insuffisant");

  const next = clonePortfolio(portfolio);
  const fees = computeFees(sizeCad, params);
  const netCad = sizeCad - fees.totalCad;
  if (netCad <= 0) throw new Error("paper: frais supérieurs au montant");
  const effPriceUsd = params.priceUsd * (1 + params.slippageBps / 10_000);
  const priceCad = effPriceUsd * params.fxCadPerUsd;
  const qty = netCad / priceCad;

  next.cashCad -= sizeCad;
  const existing = next.positions.find((p) => p.mint === intent.mint);
  if (existing) {
    existing.qty += qty;
    existing.costCad += sizeCad;
    existing.lastPriceUsd = params.priceUsd;
    existing.markCad = existing.qty * params.priceUsd * params.fxCadPerUsd;
    existing.markedAt = params.now.toISOString();
  } else {
    const pos: Position = {
      mint: intent.mint,
      qty,
      costCad: sizeCad,
      openedAt: params.now.toISOString(),
      lastPriceUsd: params.priceUsd,
      markCad: qty * params.priceUsd * params.fxCadPerUsd,
      markedAt: params.now.toISOString(),
    };
    if (params.symbol) pos.symbol = params.symbol;
    next.positions.push(pos);
  }
  updatePeak(next);

  return {
    portfolio: next,
    fill: { priceUsd: effPriceUsd, fxCadPerUsd: params.fxCadPerUsd, qty, grossCad: sizeCad, netCad, slippageBps: params.slippageBps },
    fees,
  };
}

/** Vente simulée : sizeCad est un notionnel au prix de référence ; la quantité est bornée à la position. */
export function executeSell(portfolio: PortfolioState, intent: Intent, sizeCad: number, params: FillParams): PaperResult {
  assertParams(params);
  if (!Number.isFinite(sizeCad) || sizeCad <= 0) throw new Error("paper: sizeCad doit être > 0");
  const next = clonePortfolio(portfolio);
  const pos = next.positions.find((p) => p.mint === intent.mint);
  if (!pos || pos.qty <= EPS_QTY) throw new Error("paper: aucune position à vendre");

  const refPriceCad = params.priceUsd * params.fxCadPerUsd;
  const wantedQty = sizeCad / refPriceCad;
  const qty = Math.min(pos.qty, wantedQty);
  const sellAll = pos.qty - qty <= EPS_QTY || qty / pos.qty > 0.999;
  const soldQty = sellAll ? pos.qty : qty;

  const effPriceUsd = params.priceUsd * (1 - params.slippageBps / 10_000);
  const grossCad = soldQty * effPriceUsd * params.fxCadPerUsd;
  const fees = computeFees(grossCad, params);
  const netCad = grossCad - fees.totalCad;
  const costRemoved = sellAll ? pos.costCad : pos.costCad * (soldQty / pos.qty);
  const pnlCad = netCad - costRemoved;

  next.cashCad += netCad;
  if (sellAll) {
    next.positions = next.positions.filter((p) => p.mint !== intent.mint);
  } else {
    pos.qty -= soldQty;
    pos.costCad -= costRemoved;
    pos.lastPriceUsd = params.priceUsd;
    pos.markCad = pos.qty * refPriceCad;
    pos.markedAt = params.now.toISOString();
  }
  bumpPnl(next, pnlCad, params.now, params.timeZone);
  updatePeak(next);

  return {
    portfolio: next,
    fill: { priceUsd: effPriceUsd, fxCadPerUsd: params.fxCadPerUsd, qty: soldQty, grossCad, netCad, slippageBps: params.slippageBps },
    fees,
    pnlCad,
  };
}

/** Marque-à-marché avec des prix fournis (USD par mint). Les mints absents gardent leur dernier mark. */
export function markToMarket(
  portfolio: PortfolioState,
  pricesUsd: Record<string, number>,
  fxCadPerUsd: number,
  now: Date,
): PortfolioState {
  const next = clonePortfolio(portfolio);
  for (const pos of next.positions) {
    const price = pricesUsd[pos.mint];
    if (Number.isFinite(price) && (price as number) > 0) {
      pos.lastPriceUsd = price as number;
      pos.markCad = pos.qty * (price as number) * fxCadPerUsd;
      pos.markedAt = now.toISOString();
    }
  }
  updatePeak(next);
  return next;
}
