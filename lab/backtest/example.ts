/**
 * Exemple exécutable : `npx tsx lab/backtest/example.ts [dossier-history]`
 * Par défaut, utilise `tests/fixtures/history/` (séries synthétiques) ; passer `data/history`
 * pour les vraies séries collectées.
 *
 * Signal appliqué : volume anormal (lab/signals/volume.ts) avec seuil 40.
 * Règles : TP +50 %, SL -25 %, time-stop 12 barres (1 h à 5 min/barre), 50 $ par position.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { computeVolumeSignal } from "../signals/volume.ts";
import { formatReport, loadHistoryDir, runBacktest, type BacktestRules } from "./harness.ts";

export const EXAMPLE_RULES: BacktestRules = {
  threshold: 40,
  takeProfit: 0.5,
  stopLoss: 0.25,
  timeStopBars: 12,
  sizeUsd: 50,
  feesRoundTrip: 0.013,
  maxSlippage: 0.03,
  minLiquidityUsd: 20_000,
  cooldownBars: 3,
};

export function runExample(historyDir: string) {
  const series = loadHistoryDir(historyDir);
  const report = runBacktest(series, (s) => computeVolumeSignal(s, { minLiquidityUsd: 20_000 }), EXAMPLE_RULES);
  return report;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = process.argv[2] ? resolve(process.argv[2]) : resolve(here, "../../tests/fixtures/history");
  const report = runExample(dir);
  console.log(formatReport(report));
  if (!report.conclusive) process.exitCode = 2;
}
