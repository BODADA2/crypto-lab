/**
 * Paramètres du moteur autonome de paper trading (cahier des charges §7).
 *
 * CES PARAMÈTRES SONT PROPRES AU MOTEUR PAPER. Ils ne touchent ni au Risk Engine
 * (lab/risk/engine.ts), ni à la politique (lab/risk/policy.example.json), ni aux
 * poids du score (lab/signals/score.weights.json). Toute modification passe par
 * le changelog tracé de lab/paper-engine/learn.ts (preuve n≥30, données séparées).
 */
export const ENGINE = {
  /** Capital virtuel initial (§7). */
  virtualCapitalUsd: 10_000,
  /** Risque maximal par trade, en % de l'equity courante (§7 : 1 %). */
  maxRiskPerTradePct: 1,
  /** Risque maximal simultané, en % de l'equity (§7 : 5 %). */
  maxSimultaneousRiskPct: 5,
  /** Positions ouvertes simultanées max (dérivé : 5 % / 1 %). */
  maxOpenPositions: 5,
  /** Drawdown max avant HALT du paper trading (§7). */
  haltDrawdownPct: 15,
  /** Après N pertes consécutives, le risque par trade est divisé par 2 (§7). */
  lossStreakHalveAt: 3,
  /** Coûts simulés aller+retour (slippage+frais), même hypothèse que les backtests. */
  entryCostPct: 1.3,
  /** Plan de sortie par défaut : stop et 3 objectifs. */
  stopPct: 20,
  tp1Pct: 30,
  tp2Pct: 80,
  tp3Pct: 200,
  /** Parts de la position sorties à chaque objectif (total = 1). */
  tpShares: [0.5, 0.3, 0.2] as const,
  /** Sortie forcée après N barres sans objectif ni stop touché. */
  timeStopBars: 48,
  /** Seuils d'éligibilité d'une décision. */
  minScore: 60,
  minCoverage: 0.6,
  minLiquidityUsd: 20_000,
  minAgeMin: 10,
  maxTop10Pct: 40,
  /** Seuil d'exclusion bundle (même valeur que lab/signals/bundle.ts). */
  bundleExcludeScore: 60,
  /** Nombre de décisions clôturées par bloc d'apprentissage (§5). */
  learnBlockSize: 20,
  /** Preuve minimale pour ajuster un seuil (§5 : n≥30, jamais sur une petite série). */
  minTradesForAdjustment: 30,
  /** Taille d'un bloc d'analyse d'erreurs. */
  errorBlockSize: 20,
} as const;

/** Adaptation des règles au régime de marché (§10). La sécurité ne s'assouplit jamais. */
export interface RegimeAdaptation {
  minScore: number;
  maxOpenPositions: number;
  stopPct: number;
  /** Vrai = le cycle n'ouvre aucune position (NO_TRADE uniquement). */
  noNewTrades: boolean;
  note: string;
}

export function adaptationForRegime(regime: string): RegimeAdaptation {
  const base: RegimeAdaptation = {
    minScore: ENGINE.minScore,
    maxOpenPositions: ENGINE.maxOpenPositions,
    stopPct: ENGINE.stopPct,
    noNewTrades: false,
    note: "paramètres de base",
  };
  switch (regime) {
    case "MEME MANIA":
      return { ...base, minScore: 70, maxOpenPositions: 3, note: "manie : plus sélectif, moins de positions" };
    case "HIGH VOLATILITY":
      return { ...base, minScore: 65, stopPct: 25, note: "volatilité : stop élargi, sélectivité accrue" };
    case "LOW LIQUIDITY":
      return { ...base, maxOpenPositions: 1, note: "liquidité faible : 1 position max" };
    case "RISK OFF":
      return { ...base, noNewTrades: true, note: "risk-off : NO_TRADE sur tout le cycle" };
    case "BEAR":
      return { ...base, minScore: 70, note: "bear : sélectivité accrue" };
    case "BULL":
    case "SIDEWAYS":
    case "INCONNU":
    default:
      return { ...base, note: regime === "INCONNU" ? "régime indéterminé : règles de sécurité inchangées" : "paramètres de base" };
  }
}
