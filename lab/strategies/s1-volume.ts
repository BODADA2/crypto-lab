/**
 * S1 — Volume anormal (enveloppe de lab/signals/volume.ts).
 *
 * BUY si, sur l'historique 5 min du token :
 *   - le signal volume est éligible (âge ≥ minAgeMin, liquidité ≥ minLiquidityUsd, ≥ 6 fenêtres de référence) ;
 *   - z-score du volume 5 min ≥ minZ (défaut 3) ;
 *   - pression acheteuse : achats/ventes 5 min ≥ minBuySellRatio (défaut 1, i.e. pas plus de ventes que d'achats) ;
 *   - volume 5 min / liquidité ≥ minVolumeToLiquidity (défaut 5 %) : un pic de 500 $ sur un pool de 1 M$ n'est pas un signal.
 * Force = score du signal volume (0–100). Stop/objectif proposés en fraction du prix courant.
 * Invalidation : le volume 5 min retombe sous moyenne + 1 σ, ou le prix passe sous le stop.
 */
import { computeVolumeSignal, type VolumeSignalOptions } from "../signals/volume.ts";
import type { Strategy, StrategyInput, StrategySignal } from "./types.ts";

export interface S1Params {
  /** z-score minimal du volume 5 min (défaut 3). */
  minZ: number;
  minAgeMin: number;
  minLiquidityUsd: number;
  /** Ratio achats/ventes 5 min minimal (défaut 1). */
  minBuySellRatio: number;
  /** Volume 5 min / liquidité minimal (défaut 0.05). */
  minVolumeToLiquidity: number;
  /** Stop proposé : fraction sous le prix (défaut 0.25 = −25 %). */
  stopPct: number;
  /** Objectif proposé : fraction au-dessus du prix (défaut 0.5 = +50 %). */
  targetPct: number;
  /** Nombre de fenêtres de référence du z-score (défaut 12). */
  lookback: number;
}

export const S1_DEFAULTS: S1Params = {
  minZ: 3,
  minAgeMin: 10,
  minLiquidityUsd: 20_000,
  minBuySellRatio: 1,
  minVolumeToLiquidity: 0.05,
  stopPct: 0.25,
  targetPct: 0.5,
  lookback: 12,
};

export function createS1Volume(overrides: Partial<S1Params> = {}): Strategy {
  const p: S1Params = { ...S1_DEFAULTS, ...overrides };
  return {
    id: "s1-volume",
    version: "1.0.0",
    family: "memecoin",
    describe: () =>
      `volume 5 min z ≥ ${p.minZ} sur ${p.lookback} fenêtres, âge ≥ ${p.minAgeMin} min, liquidité ≥ ${p.minLiquidityUsd} $, achats/ventes ≥ ${p.minBuySellRatio}, vol/liq ≥ ${p.minVolumeToLiquidity * 100} % ; stop −${p.stopPct * 100} %, objectif +${p.targetPct * 100} %`,
    signals(input: StrategyInput): StrategySignal[] {
      const series = input.history.length ? input.history : input.snapshot ? [input.snapshot] : [];
      if (series.length === 0) return [];
      const last = series[series.length - 1]!;
      if (last.priceUsd <= 0) return [];
      const opts: VolumeSignalOptions = { lookback: p.lookback, minAgeMin: p.minAgeMin, minLiquidityUsd: p.minLiquidityUsd, now: () => input.now };
      const v = computeVolumeSignal(series, opts);
      if (!v.eligible) return [];
      const z = v.components.zScore;
      if (z === null || z < p.minZ) return [];
      const bs = v.components.buySellRatio;
      if (bs === null || bs < p.minBuySellRatio) return [];
      const v2l = v.components.volumeToLiquidity;
      if (v2l === null || v2l < p.minVolumeToLiquidity) return [];
      const mean = v.components.baselineMean ?? 0;
      const std = v.components.baselineStd ?? 0;
      const stop = last.priceUsd * (1 - p.stopPct);
      return [
        {
          strategyId: "s1-volume",
          strategyVersion: "1.0.0",
          mint: last.mint,
          side: "BUY",
          strength: v.score,
          reasons: [`z-score volume ${z.toFixed(2)} ≥ ${p.minZ}`, ...v.reasons],
          invalidation: `volume 5 min < ${(mean + std).toFixed(0)} $ (moyenne + 1 σ) ou prix < ${stop.toPrecision(4)} (−${p.stopPct * 100} %)`,
          proposedStop: stop,
          proposedTarget: last.priceUsd * (1 + p.targetPct),
          refPrice: last.priceUsd,
          ts: new Date(input.now).toISOString(),
        },
      ];
    },
  };
}
