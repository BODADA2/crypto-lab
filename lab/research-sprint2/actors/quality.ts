/**
 * SPRINT 2C — famille E : « qualité historique » d'un wallet / d'une entité
 * (hypothèse H-S2C-E2).
 *
 * Pour un mint m (t0ms) : pour chaque early buyer w du set pré-t0, on
 * calcule sa qualité historique = taux de survie (survival_50_24h) des
 * mints PRÉCÉDENTS (t0' < t0ms) où w était early buyer pré-t0.
 *
 * Règles :
 *  - WALLET ≠ ENTITY : les deux niveaux sont calculés séparément ; une
 *    entité = entity-like group de clusters.ts (preuves observables) ;
 *  - as-of-t0 strict : seuls les mints avec t0' < t0ms alimentent la
 *    qualité — jamais le futur, jamais « smart money » post-hoc ;
 *  - univers DISCOVERY uniquement, SKHY exclu ;
 *  - biais tokens chauds = borne optimiste (déclaré).
 */
import {
  buildPairOverlap,
  clusterWallets,
  type ClusterInput,
} from "../../predictive/earlybuyers/clusters.ts";
import { computeLabels } from "../../predictive/earlybuyers/labels.ts";
import type { MintSet, WalletObservation } from "./incidence.ts";
import { mean } from "./statsx.ts";

export interface WalletQuality {
  wallet: string;
  /** Nombre de mints passés (t0' < t0) où le wallet était early buyer avec label connu. */
  pastCount: number;
  /** Taux de survie_50 des mints passés ; null si pastCount == 0. */
  quality: number | null;
}

export interface MintQualityFeatures {
  mint: string;
  t0ms: number;
  nBuyers: number;
  /** Nb de buyers avec qualité définie (≥1 mint passé labellisé). */
  nWithQuality: number;
  /** Moyenne des qualités wallet-level (sur buyers définis). */
  meanWalletQuality: number | null;
  /** Moyenne des qualités entity-level (entités = clusters + singletons). */
  meanEntityQuality: number | null;
  /** Part des buyers récurrents as-of-t0 dans le set. */
  recurrentFrac: number;
}

/**
 * Qualité historique de chaque wallet du set du mint m, as-of-t0.
 * `survivalOf` : mint → survival_50_24h (null si inconnu).
 */
export function walletQualities(
  m: MintSet,
  inc: Map<string, WalletObservation[]>,
  t0: Map<string, number>,
  survivalOf: Map<string, boolean | null>,
  recurrent: Set<string>,
): WalletQuality[] {
  const out: WalletQuality[] = [];
  for (const b of m.buyers) {
    const obs = inc.get(b.wallet) ?? [];
    let ok = 0;
    let total = 0;
    for (const o of obs) {
      if (o.mint === m.mint) continue;
      const ot0 = t0.get(o.mint);
      if (ot0 == null || ot0 >= m.t0ms) continue; // futur exclu
      const s = survivalOf.get(o.mint);
      if (s == null) continue;
      total++;
      if (s) ok++;
    }
    out.push({
      wallet: b.wallet,
      pastCount: total,
      quality: total > 0 ? ok / total : null,
    });
  }
  void recurrent;
  return out;
}

/**
 * Features qualité par mint (wallet-level + entity-level).
 * Le clustering utilise buildPairOverlap sur l'incidence complète avec
 * t0ms = m.t0ms et excludeMint = m.mint → preuves ≤ t0ms uniquement.
 */
export function mintQualityFeatures(
  sets: MintSet[],
  inc: Map<string, WalletObservation[]>,
  t0: Map<string, number>,
  survivalOf: Map<string, boolean | null>,
  recurrentByMint: Map<string, Set<string>>,
): MintQualityFeatures[] {
  return sets.map((m) => {
    const wq = walletQualities(m, inc, t0, survivalOf, recurrentByMint.get(m.mint) ?? new Set());
    const qByWallet = new Map(wq.map((w) => [w.wallet, w.quality]));
    const defined = wq.filter((w) => w.quality != null);
    const meanWalletQuality = mean(defined.map((w) => w.quality!));

    // Niveau entité : clustering du set avec preuves ≤ t0ms.
    const inputs: ClusterInput[] = m.buyers.map((b) => ({
      wallet: b.wallet,
      slot: b.slot,
      blockTimeMs: b.blockTimeMs,
    }));
    const overlap = buildPairOverlap(inc, m.t0ms, m.mint);
    const c = clusterWallets(inputs, overlap);
    // qualité d'une entité = moyenne des qualités de ses membres (définis).
    const entityQuals: number[] = [];
    const memberQual = (w: string): number | null => qByWallet.get(w) ?? null;
    for (const cl of c.clusters) {
      const qs = cl.members.map(memberQual).filter((q): q is number => q != null);
      if (qs.length) entityQuals.push(mean(qs)!);
    }
    for (const w of c.singletons) {
      const q = memberQual(w);
      if (q != null) entityQuals.push(q);
    }
    const meanEntityQuality = mean(entityQuals);
    const rec = recurrentByMint.get(m.mint) ?? new Set<string>();
    return {
      mint: m.mint,
      t0ms: m.t0ms,
      nBuyers: m.buyers.length,
      nWithQuality: defined.length,
      meanWalletQuality,
      meanEntityQuality,
      recurrentFrac: m.buyers.length ? rec.size / m.buyers.length : 0,
    };
  });
}

/** Charge survival_50_24h (labels) pour un ensemble de mints discovery. */
export function loadSurvival(
  mints: string[],
): { survivalOf: Map<string, boolean | null>; y1hOf: Map<string, number | null> } {
  const survivalOf = new Map<string, boolean | null>();
  const y1hOf = new Map<string, number | null>();
  for (const mint of mints) {
    try {
      const l = computeLabels(mint);
      survivalOf.set(mint, l.dataError ? null : l.survival_50_24h);
      y1hOf.set(mint, l.dataError ? null : l.y1h);
    } catch {
      survivalOf.set(mint, null);
      y1hOf.set(mint, null);
    }
  }
  return { survivalOf, y1hOf };
}
