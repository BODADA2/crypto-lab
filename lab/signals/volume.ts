/**
 * Signal « volume anormal » (idée MemeScan).
 *
 * Entrée : série chronologique de snapshots du même token (fenêtres de 5 min, la plus récente en dernier).
 * Composantes :
 *   - z-score du volume 5 min courant vs moyenne/écart-type des 12 fenêtres précédentes ;
 *   - accélération des holders : croissance de la dernière fenêtre vs croissance moyenne précédente ;
 *   - ratio volume 5 min / liquidité ;
 *   - filtres durs : âge >= minAgeMin, liquidité >= minLiquidityUsd, assez d'historique.
 * Sortie : score 0–100 + explication textuelle (chaque composante est tracée).
 */
import type { TokenSnapshot } from "../types.ts";

export interface VolumeSignalOptions {
  /** Nombre de fenêtres de référence (défaut 12). */
  lookback?: number;
  minAgeMin?: number;
  minLiquidityUsd?: number;
  /** z-score à partir duquel la composante volume est saturée (défaut 4). */
  zSaturation?: number;
  now?: () => number;
}

export interface VolumeSignal {
  mint: string;
  score: number;
  eligible: boolean;
  reasons: string[];
  components: {
    zScore: number | null;
    volumeM5: number;
    baselineMean: number | null;
    baselineStd: number | null;
    holderAcceleration: number | null;
    volumeToLiquidity: number | null;
    ageMin: number | null;
    liquidityUsd: number | null;
    buySellRatio: number | null;
  };
  computedAt: string;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function computeVolumeSignal(series: TokenSnapshot[], opts: VolumeSignalOptions = {}): VolumeSignal {
  const lookback = opts.lookback ?? 12;
  const minAge = opts.minAgeMin ?? 10;
  const minLiq = opts.minLiquidityUsd ?? 20_000;
  const zSat = opts.zSaturation ?? 4;
  const now = opts.now ?? (() => Date.now());
  const reasons: string[] = [];
  const last = series[series.length - 1];
  const computedAt = new Date(now()).toISOString();

  const empty = (mint: string, reason: string): VolumeSignal => ({
    mint,
    score: 0,
    eligible: false,
    reasons: [reason],
    components: {
      zScore: null,
      volumeM5: 0,
      baselineMean: null,
      baselineStd: null,
      holderAcceleration: null,
      volumeToLiquidity: null,
      ageMin: null,
      liquidityUsd: null,
      buySellRatio: null,
    },
    computedAt,
  });

  if (!last) return empty("?", "série vide");
  const nowMs = Date.parse(last.fetchedAt) || now();
  const ageMin = last.pairCreatedAt ? (nowMs - last.pairCreatedAt) / 60_000 : null;
  // Liquidité 0 = inconnue (convention lab/types.ts) : traitée comme insuffisante.
  const liq: number | null = last.liquidityUsd > 0 ? last.liquidityUsd : null;

  // Filtres durs (inéligible → score 0, mais on renseigne quand même les composantes).
  let eligible = true;
  if (ageMin !== null && ageMin < minAge) {
    eligible = false;
    reasons.push(`âge ${ageMin.toFixed(1)} min < ${minAge} min`);
  }
  if (liq === null || liq < minLiq) {
    eligible = false;
    reasons.push(`liquidité ${liq === null ? "inconnue" : `${liq.toFixed(0)} $`} < ${minLiq} $`);
  }
  const baseline = series.slice(Math.max(0, series.length - 1 - lookback), series.length - 1).map((s) => s.volume.m5);
  if (baseline.length < Math.min(lookback, 6)) {
    eligible = false;
    reasons.push(`historique insuffisant (${baseline.length} fenêtres, min ${Math.min(lookback, 6)})`);
  }

  // Composante 1 : z-score du volume.
  const bMean = baseline.length ? mean(baseline) : null;
  const bStd = baseline.length >= 2 ? std(baseline) : null;
  let z: number | null = null;
  if (bMean !== null && bStd !== null) {
    // Plancher d'écart-type pour éviter la division par ~0 quand le volume était nul et constant.
    const floor = Math.max(bStd, bMean * 0.25, 1);
    z = (last.volume.m5 - bMean) / floor;
  }
  const volScore = z === null ? 0 : clamp01(z / zSat);
  if (z !== null) reasons.push(`volume 5 min ${last.volume.m5.toFixed(0)} $ vs moyenne ${bMean!.toFixed(0)} $ (z=${z.toFixed(2)})`);

  // Composante 2 : accélération des holders.
  const holders = series.map((s) => s.holders).filter((h): h is number => h !== null);
  let holderAcc: number | null = null;
  if (holders.length >= 3) {
    const growth: number[] = [];
    for (let i = 1; i < holders.length; i++) growth.push((holders[i] as number) - (holders[i - 1] as number));
    const lastG = growth[growth.length - 1] as number;
    const prevG = mean(growth.slice(0, -1));
    holderAcc = prevG > 0 ? lastG / prevG : lastG > 0 ? 3 : 0;
    reasons.push(`holders +${lastG} (x${holderAcc.toFixed(2)} vs tendance)`);
  }
  const holderScore = holderAcc === null ? 0 : clamp01((holderAcc - 1) / 2);

  // Composante 3 : volume / liquidité.
  const v2l = liq && liq > 0 ? last.volume.m5 / liq : null;
  const v2lScore = v2l === null ? 0 : clamp01(v2l / 0.5);
  if (v2l !== null) reasons.push(`volume/liquidité ${(v2l * 100).toFixed(1)} %`);

  // Composante 4 : pression acheteuse (achats / ventes sur 5 min).
  const { buys, sells } = last.txns.m5;
  const bs = buys + sells > 0 ? buys / Math.max(1, sells) : null;
  const bsScore = bs === null ? 0 : clamp01((bs - 1) / 2);
  if (bs !== null) reasons.push(`achats/ventes 5 min ${buys}/${sells}`);

  // Pondération : volume 50 %, holders 20 %, vol/liq 15 %, pression 15 %.
  const raw = 0.5 * volScore + 0.2 * holderScore + 0.15 * v2lScore + 0.15 * bsScore;
  const score = eligible ? Math.round(raw * 100) : 0;
  if (!eligible) reasons.push("inéligible → score 0");

  return {
    mint: last.mint,
    score,
    eligible,
    reasons,
    components: {
      zScore: z,
      volumeM5: last.volume.m5,
      baselineMean: bMean,
      baselineStd: bStd,
      holderAcceleration: holderAcc,
      volumeToLiquidity: v2l,
      ageMin,
      liquidityUsd: liq,
      buySellRatio: bs,
    },
    computedAt,
  };
}

/** Applique le signal à plusieurs séries et renvoie les scores triés (décroissant). */
export function rankVolumeSignals(seriesByMint: Map<string, TokenSnapshot[]>, opts?: VolumeSignalOptions): VolumeSignal[] {
  const out: VolumeSignal[] = [];
  for (const [, series] of seriesByMint) if (series.length) out.push(computeVolumeSignal(series, opts));
  return out.sort((a, b) => b.score - a.score);
}
