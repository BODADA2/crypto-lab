/**
 * Harnais de comparaison H-EXIT — scalps vs runners vs adaptatif, sur séries réelles.
 *
 * Protocole (documenté, identique pour les 3 variantes — seule la SORTIE change) :
 * - Entrée : première observation avec liquidité ≥ 20 000 $ et prix > 0, puis
 *   entrée AU PRIX DE L'OBSERVATION SUIVANTE (t+1, pas de lookahead).
 * - Variantes : "scalp" (tout le monde en scalp), "runner" (tout le monde en
 *   runner), "adaptive" (classifyExitRegime via le score catalyst du token).
 * - Chaque token = 1 trade (rendement net blendé des paliers) ; les rapports
 *   passent par `summarize` qui applique la règle n ≥ 30 (MIN_TRADES_FOR_CONCLUSION).
 *
 * La question testée : la séparation des régimes (thèse Cupsey/Cented) bat-elle
 * un régime unique ? Si aucune variante n'atteint n ≥ 30, le rapport le dit
 * explicitement : AUCUNE conclusion (NO ACTION).
 */
import type { TokenSnapshot } from "../types.ts";
import { summarize, type BacktestReport, type Trade } from "./harness.ts";
import { classifyExitRegime, simulateExit, type ExitCosts, type ExitRegime, type PricePoint } from "../signals/exit.ts";

export type ExitVariant = "scalp" | "runner" | "adaptive";

export interface ExitComparisonInput {
  /** Séries par mint (jamais de futur : chaque série est indépendante). */
  seriesByMint: Map<string, TokenSnapshot[]>;
  /** Score catalyst 0..100 par mint (walk-forward, cf. catalyst.ts). Absent → 0. */
  catalystByMint?: Map<string, number>;
  costs?: ExitCosts;
  /** Liquidité minimale d'entrée en $ (défaut 20 000, politique de risque). */
  minLiquidityUsd?: number;
  /** Observations minimales APRÈS l'entrée (défaut 2). */
  minBarsAfterEntry?: number;
}

export interface ExitComparisonReport {
  variants: Record<ExitVariant, BacktestReport>;
  /** Nombre de tokens classés runner par l'adaptatif (transparence). */
  adaptiveRunnerCount: number;
  adaptiveScalpCount: number;
  skipped: number;
  note: string;
}

function toPricePoints(series: TokenSnapshot[]): PricePoint[] {
  return series.map((s) => ({ t: s.fetchedAt, price: s.priceUsd, liquidityUsd: s.liquidityUsd }));
}

function planToTrade(mint: string, entry: TokenSnapshot, plan: { fills: ReturnType<typeof simulateExit>["fills"]; blendedRet: number; blendedGross: number; regime: ExitRegime }): Trade {
  const last = plan.fills[plan.fills.length - 1]!;
  return {
    mint,
    entryAt: entry.fetchedAt,
    exitAt: last.exitAt,
    entryPrice: entry.priceUsd,
    exitPrice: last.exitPrice,
    ret: plan.blendedRet,
    grossRet: plan.blendedGross,
    bars: last.bars,
    exit: last.exit,
    score: plan.regime === "runner" ? 1 : 0,
    costs: 0,
    strategyId: `exit-${plan.regime}`,
  };
}

export function runExitComparison(input: ExitComparisonInput): ExitComparisonReport {
  const minLiq = input.minLiquidityUsd ?? 20_000;
  const minAfter = input.minBarsAfterEntry ?? 2;
  const costs: ExitCosts = input.costs ?? { sizeUsd: 50, feesRoundTrip: 0.013, maxSlippage: 0.03 };
  const catalyst = input.catalystByMint ?? new Map<string, number>();

  const tradesByVariant: Record<ExitVariant, Trade[]> = { scalp: [], runner: [], adaptive: [] };
  let skipped = 0;
  let adaptiveRunnerCount = 0;
  let adaptiveScalpCount = 0;
  let observations = 0;

  for (const [mint, raw] of input.seriesByMint) {
    const series = [...raw].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    observations += series.length;
    // Entrée : première observation éligible, exécution à t+1.
    const signalIdx = series.findIndex((s) => s.priceUsd > 0 && s.liquidityUsd >= minLiq);
    if (signalIdx === -1 || signalIdx + 1 >= series.length) {
      skipped += 1;
      continue;
    }
    const entryIdx = signalIdx + 1;
    if (series.length - entryIdx < minAfter) {
      skipped += 1;
      continue;
    }
    const entry = series[entryIdx] as TokenSnapshot;
    if (entry.priceUsd <= 0) {
      skipped += 1;
      continue;
    }
    const path = toPricePoints(series);
    const cat = catalyst.get(mint) ?? 0;
    const adaptiveRegime = classifyExitRegime(cat);
    if (adaptiveRegime === "runner") adaptiveRunnerCount += 1;
    else adaptiveScalpCount += 1;

    const variants: Record<ExitVariant, ExitRegime> = {
      scalp: "scalp",
      runner: "runner",
      adaptive: adaptiveRegime,
    };
    for (const v of Object.keys(variants) as ExitVariant[]) {
      try {
        const plan = simulateExit(path, entryIdx, variants[v] as ExitRegime, costs);
        tradesByVariant[v].push(planToTrade(mint, entry, plan));
      } catch {
        // Série inexploitable pour cette variante (ex. aucune sortie possible).
      }
    }
  }

  const variants = {
    scalp: summarize(tradesByVariant.scalp, input.seriesByMint.size, observations),
    runner: summarize(tradesByVariant.runner, input.seriesByMint.size, observations),
    adaptive: summarize(tradesByVariant.adaptive, input.seriesByMint.size, observations),
  };
  const conclusive = (Object.values(variants) as BacktestReport[]).filter((r) => r.conclusive).length;
  return {
    variants,
    adaptiveRunnerCount,
    adaptiveScalpCount,
    skipped,
    note:
      conclusive === 3
        ? "Les 3 variantes atteignent n ≥ 30 : comparaison lisible (reste une mesure historique, pas une preuve live)."
        : `Seules ${conclusive}/3 variantes atteignent n ≥ 30 : ne comparer que les variantes conclusives ; les autres = NO ACTION.`,
  };
}
