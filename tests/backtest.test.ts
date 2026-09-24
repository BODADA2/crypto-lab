import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { synthSeries } from "../lab/backtest/synth.ts";
import {
  estimateSlippage,
  formatReport,
  loadHistoryDir,
  readHistoryFile,
  runBacktest,
  simulateToken,
  summarize,
  MIN_TRADES_FOR_CONCLUSION,
  type BacktestRules,
} from "../lab/backtest/harness.ts";
import { computeVolumeSignal } from "../lab/signals/volume.ts";
import { runExample, EXAMPLE_RULES } from "../lab/backtest/example.ts";
import type { TokenSnapshot } from "../lab/types.ts";

const HISTORY = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "history");

const RULES: BacktestRules = { threshold: 50, takeProfit: 0.5, stopLoss: 0.25, timeStopBars: 10, sizeUsd: 50, feesRoundTrip: 0.013, maxSlippage: 0.03 };

/** Série de prix contrôlée : liquidité 100 000 $, prix donné par barre. */
function priced(prices: number[], liq = 100_000): TokenSnapshot[] {
  const base = synthSeries({ mint: "CtrlMint111111111111111111111111111111111111", bars: prices.length, seed: 1 });
  return base.map((s, i) => ({ ...s, priceUsd: prices[i]!, liquidityUsd: liq }));
}

describe("slippage et coûts", () => {
  it("slippage ∝ taille/liquidité, plafonné, max si liquidité inconnue", () => {
    expect(estimateSlippage(50, 100_000)).toBeCloseTo(0.0005);
    expect(estimateSlippage(50, 500)).toBe(0.03);
    expect(estimateSlippage(50, null)).toBe(0.03);
    expect(estimateSlippage(50, 0, 0.05)).toBe(0.05);
  });

  it("un trade à prix constant perd exactement les coûts", () => {
    const series = priced([1, 1, 1, 1]);
    const trades = simulateToken(series, () => 100, { ...RULES, timeStopBars: 1 });
    expect(trades.length).toBeGreaterThan(0);
    const t = trades[0]!;
    expect(t.grossRet).toBeCloseTo(0);
    expect(t.ret).toBeCloseTo((1 - 0.0005) * (1 - 0.0005) * (1 - 0.013) - 1, 6);
  });
});

describe("simulation entrée/sortie", () => {
  it("entre à t+1 (pas de lookahead) et sort au take-profit", () => {
    const series = priced([1, 1, 1.1, 1.6, 2.0]);
    let calls = 0;
    const trades = simulateToken(series, (s) => { calls++; return s.length === 1 ? 100 : 0; }, RULES);
    expect(trades.length).toBe(1);
    expect(trades[0]!.entryPrice).toBe(1); // barre 1, pas barre 0
    expect(trades[0]!.exitPrice).toBe(1.6);
    expect(trades[0]!.exit).toBe("take-profit");
    expect(trades[0]!.bars).toBe(2);
    expect(calls).toBeGreaterThan(0);
  });

  it("sort au stop-loss", () => {
    const series = priced([1, 1, 0.9, 0.7, 0.5]);
    const trades = simulateToken(series, (s) => (s.length === 1 ? 100 : 0), RULES);
    expect(trades[0]!.exit).toBe("stop-loss");
    expect(trades[0]!.exitPrice).toBe(0.7);
    expect(trades[0]!.ret).toBeLessThan(-0.3);
  });

  it("sort au time-stop puis en fin de données", () => {
    const series = priced([1, 1, 1.05, 1.1, 1.08, 1.12, 1.15]);
    const ts = simulateToken(series, (s) => (s.length === 1 ? 100 : 0), { ...RULES, timeStopBars: 3 });
    expect(ts[0]!.exit).toBe("time-stop");
    expect(ts[0]!.bars).toBe(3);
    const eod = simulateToken(series, (s) => (s.length === 1 ? 100 : 0), { ...RULES, timeStopBars: 50 });
    expect(eod[0]!.exit).toBe("end-of-data");
    expect(eod[0]!.exitPrice).toBe(1.15);
  });

  it("refuse d'entrer sous la liquidité minimale ; signal sous le seuil → aucun trade", () => {
    expect(simulateToken(priced([1, 1, 2], 10_000), () => 100, RULES)).toEqual([]);
    expect(simulateToken(priced([1, 1, 2]), () => 10, RULES)).toEqual([]);
  });

  it("respecte le cooldown entre deux trades sur le même token", () => {
    const series = priced(Array(12).fill(1));
    const one = simulateToken(series, () => 100, { ...RULES, timeStopBars: 1, cooldownBars: 1 });
    const spaced = simulateToken(series, () => 100, { ...RULES, timeStopBars: 1, cooldownBars: 4 });
    expect(one.length).toBeGreaterThan(spaced.length);
  });
});

describe("rapport", () => {
  it("n < 30 → non concluant avec message explicite", () => {
    const series = priced([1, 1, 1.6]);
    const report = runBacktest(new Map([["a", series]]), () => 100, RULES);
    expect(report.n).toBe(1);
    expect(report.conclusive).toBe(false);
    expect(report.message).toMatch(new RegExp(`n=1 < ${MIN_TRADES_FOR_CONCLUSION}`));
    expect(report.message).toMatch(/AUCUNE conclusion/);
    expect(report.winRate).toBe(1);
    expect(formatReport(report)).toContain("n=1 trades");
  });

  it("n = 0 → toutes les métriques nulles", () => {
    const r = summarize([], 0, 0);
    expect(r.n).toBe(0);
    expect(r.conclusive).toBe(false);
    expect(r.winRate).toBeNull();
    expect(r.maxDrawdown).toBeNull();
    expect(formatReport(r)).toMatch(/Aucun trade/);
  });

  it("calcule win rate, espérance, profit factor et max drawdown", () => {
    const mk = (ret: number, i: number) => ({
      mint: "m",
      entryAt: `2026-09-0${i}T00:00:00.000Z`,
      exitAt: `2026-09-0${i}T01:00:00.000Z`,
      entryPrice: 1,
      exitPrice: 1 + ret,
      ret,
      grossRet: ret,
      bars: 1,
      exit: "time-stop" as const,
      score: 50,
      costs: 0,
    });
    const r = summarize([mk(0.5, 1), mk(-0.2, 2), mk(-0.2, 3), mk(0.1, 4)], 1, 10);
    expect(r.winRate).toBe(0.5);
    expect(r.expectancy).toBeCloseTo(0.05);
    expect(r.profitFactor).toBeCloseTo(0.6 / 0.4);
    // équité : 1.5 → 1.2 → 0.96 → 1.056 ; pic 1.5 ; dd = (1.5-0.96)/1.5
    expect(r.maxDrawdown).toBeCloseTo(0.36);
    expect(r.finalEquity).toBeCloseTo(1.056);
    expect(r.exits["time-stop"]).toBe(4);
  });
});

describe("fixtures data/history", () => {
  it("lit les fichiers JSONL (lignes invalides ignorées) et charge le dossier", () => {
    const map = loadHistoryDir(HISTORY);
    expect(map.size).toBe(8);
    for (const [mint, series] of map) {
      expect(series.length).toBe(120);
      expect(series[0]!.mint).toBe(mint);
    }
    expect(loadHistoryDir("/chemin/inexistant").size).toBe(0);
    const first = [...map.keys()][0]!;
    expect(readHistoryFile(join(HISTORY, `${first}.jsonl`)).length).toBe(120);
  });

  it("exemple exécutable : signal volume sur fixtures → n ≥ 30, rapport complet", () => {
    const report = runExample(HISTORY);
    expect(report.n).toBeGreaterThanOrEqual(MIN_TRADES_FOR_CONCLUSION);
    expect(report.conclusive).toBe(true);
    expect(report.winRate).toBeGreaterThan(0);
    expect(report.winRate).toBeLessThan(1);
    expect(report.maxDrawdown).toBeGreaterThan(0);
    expect(report.trades.every((t) => t.score >= EXAMPLE_RULES.threshold)).toBe(true);
    expect(report.trades.every((t) => t.entryAt < t.exitAt)).toBe(true);
    const txt = formatReport(report);
    expect(txt).toMatch(/win rate/);
    expect(txt).toMatch(/max drawdown/);
  });

  it("le même signal sur un sous-ensemble de fixtures refuse de conclure", () => {
    const map = loadHistoryDir(HISTORY);
    const one = new Map([[...map.entries()][0]!]);
    const report = runBacktest(one, (s) => computeVolumeSignal(s), EXAMPLE_RULES);
    expect(report.n).toBeLessThan(MIN_TRADES_FOR_CONCLUSION);
    expect(report.conclusive).toBe(false);
  });
});
