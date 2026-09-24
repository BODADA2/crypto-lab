/**
 * S3 — Post-graduation (migration pump.fun → DEX).
 *
 * BUY dans la fenêtre [minAgeMin, maxAgeMin] minutes après une migration CONNUE (`input.migration`, issue de
 * PumpPortal `data/scans/pump-*.jsonl`) si :
 *   - liquidité ≥ minLiquidityUsd (défaut 20 000 $) ;
 *   - top 10 < maxTop10Pct (défaut 30 %) — donc une concentration INCONNUE (100) ne passe jamais ;
 *   - autorités mint/freeze révoquées ET vérifiées (null) — "UNKNOWN" ne passe jamais ;
 *   - prix connu.
 * Sortie forcée par time-stop `timeStopHours` (défaut 24 h) après le signal : `exitBy` dans le signal.
 * Force : 40 + 30 × (1 − top10/maxTop10) + 30 × min(1, liquidité / (4 × minLiquidité)).
 * Invalidation : liquidité < minLiquidité, top 10 ≥ seuil, ou time-stop atteint.
 */
import { clamp, type Strategy, type StrategyInput, type StrategySignal } from "./types.ts";

export interface S3Params {
  minLiquidityUsd: number;
  /** Top 10 strictement inférieur à ce seuil (défaut 30 %). */
  maxTop10Pct: number;
  /** Âge minimal depuis la migration (défaut 10 min : laisser passer les snipers). */
  minAgeMin: number;
  /** Âge maximal depuis la migration (défaut 120 min : après, ce n'est plus « post-graduation »). */
  maxAgeMin: number;
  /** Time-stop en heures (défaut 24). */
  timeStopHours: number;
  stopPct: number;
  targetPct: number;
}

export const S3_DEFAULTS: S3Params = {
  minLiquidityUsd: 20_000,
  maxTop10Pct: 30,
  minAgeMin: 10,
  maxAgeMin: 120,
  timeStopHours: 24,
  stopPct: 0.3,
  targetPct: 0.8,
};

export function createS3Migration(overrides: Partial<S3Params> = {}): Strategy {
  const p: S3Params = { ...S3_DEFAULTS, ...overrides };
  return {
    id: "s3-migration",
    version: "1.0.0",
    family: "memecoin",
    describe: () =>
      `migration connue depuis ${p.minAgeMin}–${p.maxAgeMin} min, liquidité ≥ ${p.minLiquidityUsd} $, top 10 < ${p.maxTop10Pct} %, autorités révoquées vérifiées ; time-stop ${p.timeStopHours} h, stop −${p.stopPct * 100} %, objectif +${p.targetPct * 100} %`,
    signals(input: StrategyInput): StrategySignal[] {
      const snap = input.snapshot ?? input.history[input.history.length - 1] ?? null;
      const mig = input.migration;
      if (!snap || !mig || !Number.isFinite(mig.migratedAt)) return [];
      if (mig.migratedAt > input.now) return []; // migration « future » : donnée incohérente, pas de signal
      const ageMin = (input.now - mig.migratedAt) / 60_000;
      if (ageMin < p.minAgeMin || ageMin > p.maxAgeMin) return [];
      if (snap.priceUsd <= 0) return [];
      if (snap.liquidityUsd < p.minLiquidityUsd) return [];
      if (!(snap.top10Pct < p.maxTop10Pct)) return [];
      if (snap.mintAuthority !== null || snap.freezeAuthority !== null) return [];
      if (Array.isArray(snap.riskyExtensions) && snap.riskyExtensions.length > 0) return [];
      const concentration = 1 - snap.top10Pct / p.maxTop10Pct;
      const liq = Math.min(1, snap.liquidityUsd / (4 * p.minLiquidityUsd));
      const strength = Math.round(clamp(40 + 30 * concentration + 30 * liq, 0, 100));
      const stop = snap.priceUsd * (1 - p.stopPct);
      const exitBy = new Date(input.now + p.timeStopHours * 3_600_000).toISOString();
      return [
        {
          strategyId: "s3-migration",
          strategyVersion: "1.0.0",
          mint: snap.mint,
          side: "BUY",
          strength,
          reasons: [
            `migration il y a ${ageMin.toFixed(0)} min (${new Date(mig.migratedAt).toISOString()})`,
            `liquidité ${snap.liquidityUsd.toFixed(0)} $ ≥ ${p.minLiquidityUsd}`,
            `top 10 ${snap.top10Pct.toFixed(1)} % < ${p.maxTop10Pct} %`,
            "autorités mint et freeze révoquées (vérifiées on-chain)",
          ],
          invalidation: `liquidité < ${p.minLiquidityUsd} $, top 10 ≥ ${p.maxTop10Pct} %, prix < ${stop.toPrecision(4)}, ou time-stop ${exitBy}`,
          proposedStop: stop,
          proposedTarget: snap.priceUsd * (1 + p.targetPct),
          exitBy,
          refPrice: snap.priceUsd,
          ts: new Date(input.now).toISOString(),
        },
      ];
    },
  };
}
