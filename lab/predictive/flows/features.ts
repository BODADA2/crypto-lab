/**
 * DOMAINE 2/5 — FLOW STRUCTURE (phase DÉCOUVERTE).
 *
 * Variables X mesurées à t0 (premier snapshot liquidityUsd >= 20 000, priceUsd > 0),
 * dérivées des agrégats de flux DexScreener (fenêtres m5/h1). Les tailles de
 * transactions individuelles ne sont PAS disponibles dans ces séries :
 * seules les variables d'agrégats sont testées (limite déclarée dans la doc).
 */
import type { TokenSnapshot } from "../../types.ts";

export interface FlowFeatures {
  /** Nombre de buys (fenêtre m5) à t0. */
  buysM5: number;
  /** Nombre de sells (fenêtre m5) à t0. */
  sellsM5: number;
  /** Flux net : buys - sells (m5). */
  netM5: number;
  /** Ratio buys/sells (m5), lissé +0.5 pour éviter les divisions par zéro. */
  ratioM5: number;
  /** Dominance acheteuse buys/(buys+sells) (m5) ; null si aucun trade. */
  dominanceM5: number | null;
  /** Ratio buys/sells (h1), lissé. */
  ratioH1: number;
  /**
   * Accélération des buys : taux m5 vs taux h1 = 12 * buysM5 / buysH1.
   * >1 = les 5 dernières minutes sont plus intenses que la moyenne horaire.
   * null si buysH1 == 0.
   */
  accelBuys: number | null;
  /** Volume USD (m5). */
  volM5: number;
  /**
   * Taille moyenne implicite d'un trade : volM5 / (buys+sells) (m5).
   * null si aucun trade.
   */
  avgSizeM5: number | null;
  /**
   * Inflexion intra-snapshot : log(ratioM5) - log(ratioH1).
   * >0 = la structure des 5 dernières minutes est plus acheteuse que l'heure.
   */
  structM5vsH1: number;
  /**
   * Changement de structure pré-t0 : log(ratioM5_t0) - log(ratioM5_prev).
   * null si t0 est le premier snapshot (cas majoritaire : ~87 % des mints).
   */
  structChgPre: number | null;
  /**
   * Divergence prix/flux : -sign(priceChangeM5) * (dominanceM5 - 0.5).
   * Positif quand le prix monte alors que les sells dominent (ou l'inverse).
   * null si dominanceM5 null.
   */
  divPriceDominance: number | null;
  /**
   * Divergence prix/accélération : -sign(priceChangeM5) * (accelBuys - 1).
   * Positif quand le prix monte alors que le rythme des buys ralentit (ou l'inverse).
   * null si accelBuys null.
   */
  divPriceAccel: number | null;
  /** priceChange.m5 à t0 (contrôle : le momentum prix est-il lui-même prédictif ?). */
  priceChgM5: number;
}

const S = 0.5; // lissage anti-division-par-zéro

function ratio(buys: number, sells: number): number {
  return (buys + S) / (sells + S);
}

/**
 * Calcule les features à t0. `sorted` = série triée par fetchedAt croissant,
 * `t0` = indice t0 (cf. findT0 du protocole).
 */
export function flowFeaturesAtT0(sorted: TokenSnapshot[], t0: number): FlowFeatures {
  const cur = sorted[t0]!;
  const buysM5 = cur.txns?.m5?.buys ?? 0;
  const sellsM5 = cur.txns?.m5?.sells ?? 0;
  const buysH1 = cur.txns?.h1?.buys ?? 0;
  const sellsH1 = cur.txns?.h1?.sells ?? 0;
  const totalM5 = buysM5 + sellsM5;
  const ratioM5 = ratio(buysM5, sellsM5);
  const ratioH1 = ratio(buysH1, sellsH1);
  const dominanceM5 = totalM5 > 0 ? buysM5 / totalM5 : null;
  const accelBuys = buysH1 > 0 ? (12 * buysM5) / buysH1 : null;
  const volM5 = cur.volume?.m5 ?? 0;
  const avgSizeM5 = totalM5 > 0 ? volM5 / totalM5 : null;
  const priceChgM5 = cur.priceChange?.m5 ?? 0;

  let structChgPre: number | null = null;
  if (t0 > 0) {
    const prev = sorted[t0 - 1]!;
    const rPrev = ratio(prev.txns?.m5?.buys ?? 0, prev.txns?.m5?.sells ?? 0);
    structChgPre = Math.log(ratioM5) - Math.log(rPrev);
  }

  const signP = Math.sign(priceChgM5);
  const divPriceDominance =
    dominanceM5 !== null ? -signP * (dominanceM5 - 0.5) : null;
  const divPriceAccel = accelBuys !== null ? -signP * (accelBuys - 1) : null;

  return {
    buysM5,
    sellsM5,
    netM5: buysM5 - sellsM5,
    ratioM5,
    dominanceM5,
    ratioH1,
    accelBuys,
    volM5,
    avgSizeM5,
    structM5vsH1: Math.log(ratioM5) - Math.log(ratioH1),
    structChgPre,
    divPriceDominance,
    divPriceAccel,
    priceChgM5,
  };
}

/** Noms des variables X testées (ordre du rapport). */
export const FEATURE_NAMES: (keyof FlowFeatures)[] = [
  "buysM5",
  "sellsM5",
  "netM5",
  "ratioM5",
  "dominanceM5",
  "ratioH1",
  "accelBuys",
  "volM5",
  "avgSizeM5",
  "structM5vsH1",
  "structChgPre",
  "divPriceDominance",
  "divPriceAccel",
  "priceChgM5",
];

/** Libellés FR pour le rapport. */
export const FEATURE_LABELS: Record<keyof FlowFeatures, string> = {
  buysM5: "buys m5",
  sellsM5: "sells m5",
  netM5: "flux net m5 (buys−sells)",
  ratioM5: "ratio buys/sells m5",
  dominanceM5: "dominance acheteuse m5",
  ratioH1: "ratio buys/sells h1",
  accelBuys: "accélération buys (m5 vs h1)",
  volM5: "volume m5 USD",
  avgSizeM5: "taille moyenne implicite / trade m5",
  structM5vsH1: "inflexion structure m5 vs h1",
  structChgPre: "changement structure pré-t0",
  divPriceDominance: "divergence prix / dominance",
  divPriceAccel: "divergence prix / accélération",
  priceChgM5: "priceChange m5 (contrôle)",
};
