/**
 * Risque de bundle / dump précoce — H-BUNDLE (hypothèse issue de l'interview Cupsey, 2026-09-28).
 *
 * Cupsey : « if the coin… you can tell if there's supply control and if those early
 * entries like 3k/5k/10k entries are selling, it's probably the bundle selling ».
 * Deux volets :
 *
 * 1) `bundleRiskStatic` — utilisable MAINTENANT avec nos données : top10Pct,
 *    holders, autorités mint/freeze, liquidité. Score 0..100 + raisons lisibles.
 *    L'inconnu est traité comme risqué (cohérent avec la philosophie du labo :
 *    `makeSnapshot` met top10Pct=100 par défaut = conservateur).
 *
 * 2) `detectEarlyDump` — la vraie détection dynamique (wallets entrés tôt qui
 *    vendent en bloc). Fonction pure, testée, PRÊTE — mais les données de trades
 *    par wallet ne sont pas collectées actuellement (`subscribeTokenTrade`
 *    PumpPortal est payant : 0,01 SOL / 10 000 événements). Ne pas l'utiliser
 *    avec des données inventées : sans trades réels, elle ne prouve rien.
 *
 * Usage prévu : filtre d'EXCLUSION en paper (pas d'entrée si risque élevé),
 * validé par backtest n ≥ 30 avant toute règle dure. Ne touche ni au Risk Engine
 * existant, ni à la politique — c'est un signal, pas une règle.
 */
import { UNKNOWN_AUTHORITY, type TokenSnapshot } from "../collect/types.ts";

export interface BundleRisk {
  /** 0..100, 100 = risque maximal. */
  score: number;
  reasons: string[];
}

type SnapView = Pick<TokenSnapshot, "top10Pct" | "holders" | "mintAuthority" | "freezeAuthority" | "liquidityUsd">;

/**
 * Score statique de risque bundle à partir d'un snapshot. Fonction pure (testée).
 * Seuils documentés et conservateurs ; tout seuil se calibre en backtest.
 */
export function bundleRiskStatic(s: SnapView): BundleRisk {
  let score = 0;
  const reasons: string[] = [];

  if (s.top10Pct >= 100) {
    score += 40;
    reasons.push("top10 inconnu (100 % par défaut = conservateur)");
  } else if (s.top10Pct >= 60) {
    score += 30;
    reasons.push(`top10 à ${s.top10Pct} % (concentration élevée)`);
  } else if (s.top10Pct >= 40) {
    score += 15;
    reasons.push(`top10 à ${s.top10Pct} % (au-dessus du plafond de 40 %)`);
  }

  if (s.holders === null || s.holders < 50) {
    score += 20;
    reasons.push(s.holders === null ? "nombre de holders inconnu" : `seulement ${s.holders} holders`);
  }

  if (s.mintAuthority !== null && s.mintAuthority !== UNKNOWN_AUTHORITY) {
    score += 15;
    reasons.push("mint authority active (offre extensible)");
  }
  if (s.freezeAuthority !== null && s.freezeAuthority !== UNKNOWN_AUTHORITY) {
    score += 15;
    reasons.push("freeze authority active (wallets gelables)");
  }

  if (s.liquidityUsd > 0 && s.liquidityUsd < 20_000) {
    score += 10;
    reasons.push(`liquidité faible (${Math.round(s.liquidityUsd)} $ < 20 000 $)`);
  }

  return { score: Math.min(100, score), reasons };
}

/** Seuil suggéré pour un filtre d'exclusion en paper (à calibrer, pas une règle dure). */
export const BUNDLE_EXCLUDE_SCORE = 60;

export interface WalletTrade {
  wallet: string;
  side: "buy" | "sell";
  /** Epoch ms du trade. */
  atMs: number;
  /** Volume en USD. */
  usd: number;
}

export interface EarlyDumpOptions {
  /** Fenêtre d'entrée précoce après la première observation (défaut 30 min). */
  earlyWindowMin?: number;
  /** Fenêtre d'observation des ventes après l'entrée (défaut 30 min). */
  dumpWindowMin?: number;
  /** Part minimale du volume d'achat précoce revendue pour lever le drapeau (défaut 0,5). */
  sellRatio?: number;
  /** Volume USD minimal des achats précoces pour que le test soit significatif (défaut 100). */
  minEarlyUsd?: number;
}

export interface EarlyDumpResult {
  flag: boolean;
  earlyWallets: number;
  earlyBuyUsd: number;
  earlySellUsd: number;
  sellRatio: number;
  reason: string | null;
}

/**
 * Détecte le pattern « les entrées précoces vendent en bloc » (Cupsey).
 * Pure et testée. `firstSeenMs` = première observation du mint (cf. firstseen.ts).
 *
 * IMPORTANT : nécessite des trades réels par wallet — non collectés à ce jour.
 * Ne jamais alimenter cette fonction avec des volumes estimés ou inventés.
 */
export function detectEarlyDump(trades: WalletTrade[], firstSeenMs: number, opts: EarlyDumpOptions = {}): EarlyDumpResult {
  const earlyWindowMs = (opts.earlyWindowMin ?? 30) * 60_000;
  const dumpWindowMs = (opts.dumpWindowMin ?? 30) * 60_000;
  const sellRatioThreshold = opts.sellRatio ?? 0.5;
  const minEarlyUsd = opts.minEarlyUsd ?? 100;

  const empty: EarlyDumpResult = { flag: false, earlyWallets: 0, earlyBuyUsd: 0, earlySellUsd: 0, sellRatio: 0, reason: null };
  if (!Number.isFinite(firstSeenMs)) return { ...empty, reason: "firstSeen invalide" };

  const earlyWallets = new Set<string>();
  let earlyBuyUsd = 0;
  for (const t of trades) {
    if (t.side === "buy" && t.atMs >= firstSeenMs && t.atMs <= firstSeenMs + earlyWindowMs && t.usd > 0) {
      earlyWallets.add(t.wallet);
      earlyBuyUsd += t.usd;
    }
  }
  if (earlyWallets.size === 0 || earlyBuyUsd < minEarlyUsd) {
    return { ...empty, earlyWallets: earlyWallets.size, earlyBuyUsd, reason: "pas assez d'achats précoces pour conclure" };
  }

  let earlySellUsd = 0;
  for (const t of trades) {
    if (t.side === "sell" && earlyWallets.has(t.wallet) && t.atMs > firstSeenMs && t.atMs <= firstSeenMs + earlyWindowMs + dumpWindowMs && t.usd > 0) {
      earlySellUsd += t.usd;
    }
  }
  const sellRatio = earlySellUsd / earlyBuyUsd;
  const flag = sellRatio >= sellRatioThreshold;
  return {
    flag,
    earlyWallets: earlyWallets.size,
    earlyBuyUsd: Math.round(earlyBuyUsd * 100) / 100,
    earlySellUsd: Math.round(earlySellUsd * 100) / 100,
    sellRatio: Math.round(sellRatio * 1000) / 1000,
    reason: flag ? `ventes groupées : ${earlyWallets.size} wallets précoces ont revendu ${Math.round(sellRatio * 100)} % de leurs achats` : null,
  };
}
