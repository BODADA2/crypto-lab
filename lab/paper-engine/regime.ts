/**
 * Régime de marché du moteur paper (§10 du cahier des charges).
 *
 * Source : l'indicateur de régime par chaîne EXISTANT (lab/collect/chainregime.ts),
 * calculé sur les VRAIES données de data/scans/. On ne réinvente pas un régime
 * parallèle : on mappe ChainRegimeName vers les régimes du cahier des charges.
 *
 * Mapping (documenté, heuristique — pas une vérité) :
 *   famine    → LOW LIQUIDITY
 *   calme     → SIDEWAYS
 *   normal    → SIDEWAYS
 *   chaud     → HIGH VOLATILITY
 *   frénésie  → MEME MANIA
 *   inconnu   → INCONNU (règles de sécurité inchangées, jamais assouplies)
 *
 * Affinage BULL/BEAR/RISK OFF via la tendance du taux de migration et du market
 * cap médian sur les derniers jours (données réelles). Si indéterminable → INCONNU.
 */
import { join } from "node:path";
import {
  computeChainRegimes,
  loadDailyStatsFromScans,
  type ChainRegime,
} from "../collect/chainregime.ts";

export type MarketRegime =
  | "BULL"
  | "BEAR"
  | "SIDEWAYS"
  | "HIGH VOLATILITY"
  | "LOW LIQUIDITY"
  | "MEME MANIA"
  | "RISK OFF"
  | "INCONNU";

export interface RegimeResult {
  regime: MarketRegime;
  chainRegime: ChainRegime | null;
  note: string;
  /** Données utilisées (traçabilité). */
  source: string;
}

const BASE_MAP: Record<string, MarketRegime> = {
  famine: "LOW LIQUIDITY",
  calme: "SIDEWAYS",
  normal: "SIDEWAYS",
  chaud: "HIGH VOLATILITY",
  frénésie: "MEME MANIA",
  inconnu: "INCONNU",
};

export function determineRegime(rootDir: string, chain = "solana"): RegimeResult {
  const source = "data/scans/ via lab/collect/chainregime.ts";
  let regimes: ChainRegime[];
  try {
    regimes = computeChainRegimes(loadDailyStatsFromScans(join(rootDir, "data", "scans")));
  } catch {
    return { regime: "INCONNU", chainRegime: null, note: "données de régime illisibles", source };
  }
  const series = regimes.filter((r) => r.chain === chain);
  if (!series.length) {
    return { regime: "INCONNU", chainRegime: null, note: `aucune donnée de régime pour ${chain}`, source };
  }
  const cur = series[series.length - 1];
  if (!cur) {
    return { regime: "INCONNU", chainRegime: null, note: "régime chaîne indéterminable", source };
  }
  let regime: MarketRegime = BASE_MAP[cur.regime] ?? "INCONNU";
  const notes: string[] = [`régime chaîne "${cur.regime}" le ${cur.date} (${cur.briefLine})`];

  // Affinage directionnel sur données réelles (3 derniers jours).
  const tail = series.slice(-3);
  const mig = tail.map((r) => r.migrationRate).filter((m): m is number => m !== null);
  const mcaps = tail.map((r) => r.medianMcapSol).filter((m): m is number => m > 0);
  if (mig.length >= 2 && mcaps.length >= 2) {
    const migLast = mig[mig.length - 1] ?? 0;
    const migFirst = mig[0] ?? 0;
    const mcapLast = mcaps[mcaps.length - 1] ?? 1;
    const mcapFirst = mcaps[0] ?? 1;
    const migTrend = migLast - migFirst;
    const mcapTrend = mcapLast / mcapFirst - 1;
    if (regime === "MEME MANIA" || regime === "HIGH VOLATILITY") {
      if (migTrend > 0.02 && mcapTrend > 0.2) {
        regime = "BULL";
        notes.push("taux de migration et market caps en hausse → BULL");
      } else if (migTrend < -0.02 && mcapTrend < -0.2) {
        regime = "BEAR";
        notes.push("taux de migration et market caps en baisse → BEAR");
      }
    }
    const avgMig = mig.reduce((a, b) => a + b, 0) / mig.length;
    if (avgMig < 0.005 && cur.createsPercentile !== null && cur.createsPercentile < 20) {
      regime = "RISK OFF";
      notes.push("migration quasi nulle et créations au plus bas → RISK OFF");
    }
  } else {
    notes.push("tendance directionnelle indéterminable (historique < 3 jours) → pas d'affinage");
  }

  return { regime, chainRegime: cur ?? null, note: notes.join(" ; "), source };
}
