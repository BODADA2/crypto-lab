/**
 * Strategy Engine — contrat commun (chantier 2 de docs/architecture-v2.md).
 *
 * Une stratégie est une fonction PURE : mêmes entrées ⇒ mêmes signaux. Elle ne lit ni fichier ni réseau, ne
 * connaît ni le portefeuille ni la politique de risque, et n'exécute jamais rien. Elle propose ; le cross-check,
 * le scoring, le red team, puis le Risk Engine (sur la machine d'Hervé) disposent.
 *
 * Deux familles :
 *   - "memecoin" : entrée = dernier TokenSnapshot + historique de snapshots (5 min) du même token ;
 *   - "crypto"   : entrée = barres OHLCV (5 min) d'un actif liquide (SOL, BTC).
 */
import type { TokenSnapshot } from "../types.ts";

export type StrategyFamily = "memecoin" | "crypto";
export type Side = "BUY" | "SELL";

/** Barre OHLCV. `ts` = ouverture de la barre, epoch ms (UTC). */
export interface OhlcvBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Contexte de marché, optionnel et jamais inventé : absent = inconnu. */
export interface StrategyContext {
  solPriceUsd?: number;
  /** Variation de SOL sur 24 h en % (sert aux métriques « par régime »). */
  solChange24hPct?: number;
  btcDominance?: number;
  /** Régime qualitatif fourni par l'analyse (ex. "risk-on", "risk-off", "range"). Libre, informatif. */
  regime?: string;
}

/** Achat observé sur le token (Helius) : sert à S2 (wallets suivis). */
export interface ObservedBuy {
  wallet: string;
  /** Horodatage de l'achat, epoch ms. */
  ts: number;
  signature?: string;
}

/** Wallet suivi (profil `data/wallets/<address>.json` réduit). */
export interface TrackedWallet {
  address: string;
  /** Score 0–100 du profil early-buyer (récurrence pondérée). */
  score: number;
}

/** Événement de migration (graduation pump.fun → DEX) connu pour le token : sert à S3. */
export interface MigrationInfo {
  /** Horodatage de la migration, epoch ms. */
  migratedAt: number;
  pool?: string | null;
}

export interface StrategyInput {
  /** Instant d'évaluation, epoch ms. Les stratégies n'utilisent JAMAIS de donnée postérieure. */
  now: number;
  /** Dernier instantané du token (famille memecoin) ; null si aucun. */
  snapshot: TokenSnapshot | null;
  /** Historique chronologique du token, dernier élément = `snapshot` (famille memecoin). */
  history: TokenSnapshot[];
  /** Symbole de l'actif (famille crypto, ex. "SOL"). */
  symbol?: string;
  /** Barres OHLCV chronologiques, la dernière étant la plus récente CLÔTURÉE (famille crypto). */
  bars?: OhlcvBar[];
  /** Wallets suivis (S2). */
  trackedWallets?: TrackedWallet[];
  /** Achats observés sur le token, tous wallets confondus (S2). */
  buys?: ObservedBuy[];
  /** Migration connue (S3). */
  migration?: MigrationInfo | null;
  context: StrategyContext;
}

export interface StrategySignal {
  strategyId: string;
  strategyVersion: string;
  /** Mint (memecoin) … */
  mint?: string;
  /** … ou symbole (crypto). Au moins l'un des deux. */
  symbol?: string;
  side: Side;
  /** Force du signal, 0–100. */
  strength: number;
  /** Chaque raison est traçable (chiffres inclus). */
  reasons: string[];
  /** Condition d'invalidation lisible : ce qui rendrait le signal faux. */
  invalidation: string;
  /** Stop proposé (prix). */
  proposedStop?: number;
  /** Objectif proposé (prix). */
  proposedTarget?: number;
  /** Sortie forcée au plus tard à cet instant (ISO 8601) : time-stop absolu. */
  exitBy?: string;
  /** Prix de référence au moment du signal. */
  refPrice?: number;
  /** Horodatage du signal (ISO 8601) = `input.now`. */
  ts: string;
}

export interface Strategy {
  id: string;
  version: string;
  family: StrategyFamily;
  /** Description courte (paramètres inclus) pour le brief et le README. */
  describe(): string;
  /** Renvoie zéro ou plusieurs signaux. Pure. Ne lève jamais pour un input structurellement valide. */
  signals(input: StrategyInput): StrategySignal[];
}

export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
export const round2 = (n: number): number => Math.round(n * 100) / 100;
