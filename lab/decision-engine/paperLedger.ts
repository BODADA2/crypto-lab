/**
 * Ledger paper : bankroll fictive, positions, règles de sortie.
 * Exits : hard stop -8%, time-exit (pas de nouvel ATH en N sec → 100%),
 * TP1 50% à +100%, trailing stop sur le moonbag.
 */
import type { EngineConfig, PaperPosition } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

export interface ExitEvent {
  mint: string;
  ticker: string;
  kind: "STOP_LOSS" | "TIME_EXIT" | "TAKE_PROFIT_50" | "TRAILING_STOP" | "MANUAL";
  exitPrice: number;
  pnlPct: number;
  pnlUsd: number;
  detail: string;
  timestamp: number;
}

export class PaperLedger {
  private positions = new Map<string, PaperPosition>();
  private exits: ExitEvent[] = [];
  bankrollUsd: number;

  constructor(private cfg: EngineConfig = DEFAULT_CONFIG) {
    this.bankrollUsd = cfg.paperBankrollUsd;
  }

  open(mint: string, ticker: string, price: number, now: number): PaperPosition | null {
    if (this.positions.has(mint)) return this.positions.get(mint)!;
    if (this.positions.size >= this.cfg.maxConcurrentPositions) return null;
    const invested = this.bankrollUsd * (this.cfg.positionSizePct / 100);
    const qty = invested / price;
    const pos: PaperPosition = {
      mint, ticker, entryPrice: price, quantity: qty, entryTime: now,
      investedUsd: invested, peakPrice: price, peakTime: now,
      tp1Done: false, remainingQty: qty,
    };
    this.positions.set(mint, pos);
    return pos;
  }

  get openCount(): number { return this.positions.size; }
  get exitsLog(): ExitEvent[] { return this.exits; }
  get openPositions(): PaperPosition[] { return [...this.positions.values()]; }

  /**
   * Évalue les sorties pour une position au prix courant.
   * Retourne les événements de sortie générés (paper).
   */
  evaluate(mint: string, price: number, now: number): ExitEvent[] {
    const pos = this.positions.get(mint);
    if (!pos) return [];
    const out: ExitEvent[] = [];

    if (price > pos.peakPrice) {
      pos.peakPrice = price;
      pos.peakTime = now;
    }

    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const close = (kind: ExitEvent["kind"], qty: number, detail: string) => {
      const pnlUsd = (price - pos.entryPrice) * qty;
      out.push({ mint, ticker: pos.ticker, kind, exitPrice: price, pnlPct, pnlUsd, detail, timestamp: now });
      this.bankrollUsd += pnlUsd;
      pos.remainingQty -= qty;
    };

    // 1. Hard stop
    if (pnlPct <= this.cfg.stopLossPct) {
      close("STOP_LOSS", pos.remainingQty, `stop ${this.cfg.stopLossPct}% touché`);
      this.positions.delete(mint);
      this.exits.push(...out);
      return out;
    }

    // 2. TP1 : 50% à +100%
    if (!pos.tp1Done && pnlPct >= this.cfg.takeProfitPct) {
      pos.tp1Done = true;
      close("TAKE_PROFIT_50", pos.remainingQty / 2, `+${this.cfg.takeProfitPct}% : 50% sécurisé`);
    }

    // 3. Trailing stop sur le moonbag (après TP1)
    if (pos.tp1Done && pos.remainingQty > 0) {
      const fromPeak = ((price - pos.peakPrice) / pos.peakPrice) * 100;
      if (fromPeak <= this.cfg.trailingStopPct) {
        close("TRAILING_STOP", pos.remainingQty, `trailing ${this.cfg.trailingStopPct}% depuis peak $${pos.peakPrice}`);
        this.positions.delete(mint);
        this.exits.push(...out);
        return out;
      }
    }

    // 4. Time-exit : pas de nouvel ATH depuis N secondes → 100%
    if (now - pos.peakTime >= this.cfg.timeExitSeconds * 1000 && pos.remainingQty > 0) {
      close("TIME_EXIT", pos.remainingQty, `aucun ATH depuis ${this.cfg.timeExitSeconds}s → stagnation = mort`);
      this.positions.delete(mint);
    }

    this.exits.push(...out);
    return out;
  }
}
