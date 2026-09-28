/**
 * DECISION ENGINE MEMECOIN — PAPER ONLY.
 * Aucun signal n'est exécuté réellement. Les signaux sont loggés en JSONL
 * pour mesure à n≥30. L'exécution réelle exigerait un feu vert explicite.
 */

export interface EngineConfig {
  minLiquidityUsd: number;
  maxTop10HolderPct: number;
  velocityTriggerUsd: number;
  curveAccelTriggerPct: number;
  smartWalletTriggerUsd: number;
  stopLossPct: number;
  timeExitSeconds: number;
  takeProfitPct: number;
  trailingStopPct: number;
  positionSizePct: number;
  paperBankrollUsd: number;
  maxConcurrentPositions: number;
  minDataQuality: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  minLiquidityUsd: 8000,
  maxTop10HolderPct: 20,
  velocityTriggerUsd: 20000,
  curveAccelTriggerPct: 10,
  smartWalletTriggerUsd: 5000,
  stopLossPct: -8,
  timeExitSeconds: 240, // milieu de sa fourchette 180-300s
  takeProfitPct: 100,
  trailingStopPct: -15, // sur le moonbag après TP1
  positionSizePct: 2.5,
  paperBankrollUsd: 1000,
  maxConcurrentPositions: 5,
  minDataQuality: 0.8,
};

/** Données d'entrée par token. null = INCONNU (fail-closed sur les filtres). */
export interface TokenSnapshot {
  mint: string;
  ticker: string;
  priceUsd: number;
  liquidityUsd: number | null;
  /** true = migré (LP existe). false/null = bonding curve ou inconnu. */
  migrated: boolean | null;
  lpBurnedOrLocked: boolean | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  top10HolderPctRaw: number | null;
  top10HolderPctAdj: number | null; // excl. plus gros holder si >40% (curve/LP)
  holderExclusionMethod: string;
  velocityUsd2min: number | null;
  velocityMethod: string;
  curveProgressPct: number | null;
  curveAccelPct: number | null;
  narrativeTags: string[];
  smartWalletNetBuyUsd: number | null;
  dataQuality: number;
  timestamp: number;
}

export type Action = "BUY" | "SELL" | "SKIP";
export type Urgency = "HIGH" | "MEDIUM" | "LOW";

export interface LethalCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Signal {
  action: Action;
  ticker: string;
  contract: string;
  confidence_score: number;
  urgency: Urgency;
  position_size_pct: number;
  stop_loss_pct: number;
  take_profit_levels: number[];
  reasoning_short: string;
  // Métadonnées paper (hors format d'origine, pour l'audit)
  mode: "PAPER";
  real_execution: false;
  timestamp: number;
  dataQuality: number;
  lethalChecks: LethalCheck[];
  triggers: string[];
  velocityMethod: string;
}

export interface PaperPosition {
  mint: string;
  ticker: string;
  entryPrice: number;
  quantity: number;
  entryTime: number;
  investedUsd: number;
  peakPrice: number;
  peakTime: number;
  tp1Done: boolean;
  remainingQty: number;
}
