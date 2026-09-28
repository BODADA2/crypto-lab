/**
 * H-EXIT — comparateur pur à deux régimes de sortie.
 *
 * Origine : interviews Deku, Cupsey, Cented (2026-09-28).
 * - Cupsey : séparer les scalps pré-bond des plays narratifs/virals —
 *   « take a long time to cook » → deux régimes, deux jeux de paramètres,
 *   jamais mélangés dans une même statistique.
 * - Cented : sortie « par prédiction du top » selon la force du narratif
 *   (acheté 5 k$ → sortie 10-20 k$ si c'est le plafond estimé) ; il clippe
 *   aussi par paliers (cf. ARC : clips à 3/30/100 M$).
 * - Deku : sorties en clips de 10-20 %.
 *
 * Deux régimes, paramètres EXPLICITES (seuils à calibrer en backtest n ≥ 30) :
 *
 * 1) "scalp" (pré-bond, conviction faible) : TP +30 %, SL −20 %, time-stop court.
 *    Sortie unique, rapide. C'est le régime par défaut quand rien ne justifie
 *    de tenir (cohérent avec la philosophie du labo : l'inconnu = conservateur).
 *
 * 2) "runner" (narratif/catalyst fort) : sortie PAR PALIERS —
 *    25 % à +50 %, 25 % à +150 %, 25 % à +300 %, solde au time-stop long ou au
 *    stop −25 %. On ne « prédit » pas le top comme Cented (invérifiable à notre
 *    échelle) : on clippe mécaniquement, à la Deku, mais avec des paliers
 *    espacés pour laisser courir le narratif.
 *
 * Classification : `classifyExitRegime` — runner SSI score catalyst ≥ seuil
 * (défaut 40/100, cf. catalyst.ts). Tout le reste = scalp. Un seul critère,
 * lisible, auditable.
 *
 * Comptabilité : identique au harnais (lab/backtest/harness.ts) — frais
 * 1,3 % aller-retour par défaut (1 % terminal + 0,3 % réseau/priorité),
 * slippage ∝ taille/liquidité plafonné à 3 % (politique de risque).
 * `simulateExit` est pure et testée ; le backtest sur données réelles vit dans
 * lab/backtest/exit-harness.ts.
 */
import { estimateSlippage } from "../backtest/harness.ts";

export type ExitRegime = "scalp" | "runner";

export interface PricePoint {
  /** ISO. */
  t: string;
  price: number;
  liquidityUsd: number;
}

export type FillExit = "take-profit" | "stop-loss" | "time-stop" | "end-of-data";

export interface ExitFill {
  /** Fraction de la position sortie sur ce palier (0..1). */
  fraction: number;
  exitPrice: number;
  exitAt: string;
  exit: FillExit;
  /** Observations entre l'entrée et ce palier. */
  bars: number;
  /** Rendement net de CE palier (frais + slippage déduits au prorata). */
  ret: number;
}

export interface ExitPlan {
  regime: ExitRegime;
  entryPrice: number;
  entryAt: string;
  fills: ExitFill[];
  /** Rendement net blendé de la position (somme pondérée des paliers). */
  blendedRet: number;
  /** Rendement brut prix seul (dernier palier vs entrée, pondéré). */
  blendedGross: number;
}

export interface ExitCosts {
  sizeUsd: number;
  feesRoundTrip?: number;
  maxSlippage?: number;
}

/** Paramètres du régime scalp — sortie unique et rapide. */
export const SCALP_PARAMS = {
  takeProfit: 0.3,
  stopLoss: 0.2,
  /** Observations max en position (≈ 6 × 15 min ≈ 1 h 30). */
  timeStopBars: 6,
} as const;

/** Paramètres du régime runner — sortie par paliers. */
export const RUNNER_PARAMS = {
  tiers: [
    { at: 0.5, fraction: 0.25 },
    { at: 1.5, fraction: 0.25 },
    { at: 3.0, fraction: 0.25 },
  ],
  stopLoss: 0.25,
  /** Observations max en position (≈ 48 × 15 min ≈ 12 h). */
  timeStopBars: 48,
} as const;

/** Seuil de conviction catalyst pour le régime runner (0..100, cf. catalyst.ts). */
export const RUNNER_CATALYST_THRESHOLD = 40;

/**
 * Classification du régime de sortie. Un seul critère : la conviction catalyst
 * à l'entrée. Score manquant/invalide → scalp (conservateur).
 */
export function classifyExitRegime(catalystScore: number | null | undefined, threshold = RUNNER_CATALYST_THRESHOLD): ExitRegime {
  if (typeof catalystScore === "number" && Number.isFinite(catalystScore) && catalystScore >= threshold) return "runner";
  return "scalp";
}

function netRet(entryPrice: number, exitPrice: number, costs: ExitCosts, liqIn: number, liqOut: number): number {
  const fees = costs.feesRoundTrip ?? 0.013;
  const cap = costs.maxSlippage ?? 0.03;
  const slipIn = estimateSlippage(costs.sizeUsd, liqIn, cap);
  const slipOut = estimateSlippage(costs.sizeUsd, liqOut, cap);
  const gross = exitPrice / entryPrice - 1;
  return (1 + gross) * (1 - slipIn) * (1 - slipOut) * (1 - fees) - 1;
}

/**
 * Simule la sortie d'une position entrée à `entryIdx` (prix de CETTE observation ;
 * l'appelant gère le t+1 anti-lookahead). Fonction pure.
 *
 * Règles scalp : premier événement parmi TP / SL / time-stop / fin de données.
 * Règles runner : chaque palier est pris au premier passage de son seuil ; le
 * stop-loss liquide TOUT le restant ; le solde sort au time-stop ou en fin de
 * données. Les paliers sont évalués dans l'ordre chronologique des observations.
 */
export function simulateExit(path: PricePoint[], entryIdx: number, regime: ExitRegime, costs: ExitCosts): ExitPlan {
  const entry = path[entryIdx];
  if (!entry || entry.price <= 0) throw new Error("simulateExit : entryIdx invalide ou prix d'entrée ≤ 0");
  const entryPrice = entry.price;
  const fills: ExitFill[] = [];

  const pushFill = (fraction: number, j: number, exit: FillExit) => {
    const p = path[j] as PricePoint;
    fills.push({
      fraction,
      exitPrice: p.price,
      exitAt: p.t,
      exit,
      bars: j - entryIdx,
      ret: netRet(entryPrice, p.price, costs, entry.liquidityUsd, p.liquidityUsd),
    });
  };

  if (regime === "scalp") {
    const { takeProfit, stopLoss, timeStopBars } = SCALP_PARAMS;
    let done = false;
    for (let j = entryIdx + 1; j < path.length && !done; j++) {
      const p = path[j] as PricePoint;
      if (p.price <= 0) continue;
      const gross = p.price / entryPrice - 1;
      if (gross <= -stopLoss) {
        pushFill(1, j, "stop-loss");
        done = true;
      } else if (gross >= takeProfit) {
        pushFill(1, j, "take-profit");
        done = true;
      } else if (j - entryIdx >= timeStopBars) {
        pushFill(1, j, "time-stop");
        done = true;
      }
    }
    if (!done) {
      // Fin de données : sortie sur la dernière observation valorisée.
      for (let j = path.length - 1; j > entryIdx; j--) {
        const p = path[j] as PricePoint;
        if (p.price > 0) {
          pushFill(1, j, "end-of-data");
          done = true;
          break;
        }
      }
      if (!done) throw new Error("simulateExit : aucune observation de sortie possible");
    }
  } else {
    const { tiers, stopLoss, timeStopBars } = RUNNER_PARAMS;
    let remaining = 1;
    let tierIdx = 0;
    let stopped = false;
    for (let j = entryIdx + 1; j < path.length && remaining > 0; j++) {
      const p = path[j] as PricePoint;
      if (p.price <= 0) continue;
      const gross = p.price / entryPrice - 1;
      if (gross <= -stopLoss) {
        pushFill(remaining, j, "stop-loss");
        remaining = 0;
        stopped = true;
        break;
      }
      while (tierIdx < tiers.length && gross >= (tiers[tierIdx] as { at: number; fraction: number }).at) {
        const tier = tiers[tierIdx] as { at: number; fraction: number };
        const frac = Math.min(tier.fraction, remaining);
        pushFill(frac, j, "take-profit");
        remaining -= frac;
        tierIdx += 1;
      }
      if (remaining > 0 && j - entryIdx >= timeStopBars) {
        pushFill(remaining, j, "time-stop");
        remaining = 0;
        break;
      }
    }
    if (remaining > 0 && !stopped) {
      for (let j = path.length - 1; j > entryIdx; j--) {
        const p = path[j] as PricePoint;
        if (p.price > 0) {
          pushFill(remaining, j, "end-of-data");
          remaining = 0;
          break;
        }
      }
      if (remaining > 0) throw new Error("simulateExit : aucune observation de sortie possible");
    }
  }

  let blendedRet = 0;
  let blendedGross = 0;
  for (const f of fills) {
    blendedRet += f.fraction * f.ret;
    blendedGross += f.fraction * (f.exitPrice / entryPrice - 1);
  }
  return { regime, entryPrice, entryAt: entry.t, fills, blendedRet, blendedGross };
}
