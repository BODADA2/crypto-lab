/**
 * Phase 2 — clustering wallet → entity-like group (§4 de la spec d'Hervé).
 *
 * WALLET ≠ ENTITY : une adresse on-chain n'est PAS une personne. Les
 * clusters ci-dessous sont des « entity-like groups » / « coordinated sets »
 * construits sur des preuves observables pré-t0, jamais des affirmations
 * d'identité. Chaque cluster porte ses preuves (evidence[]) : on ne dit
 * jamais « une entité = une personne ».
 *
 * Niveaux de preuve (combinables) :
 *  - "same_slot"            : ≥2 buyers avec un slot non-null identique ;
 *  - "temporal_sync"        : chaîne d'arrivées triées par blockTimeMs où
 *                             chaque arrivée suit la précédente de ≤2000 ms ;
 *  - "persistent_cooccurrence" : paire de wallets co-early-buyers sur ≥2
 *                             tokens DISTINCTS (hors token courant), avec
 *                             observations ≤ t0ms — fusion par union-find.
 *
 * Règle temporelle : toutes les sources (slot, blockTimeMs, observations
 * d'overlap) sont ≤ t0ms par construction ; ce module n'introduit aucune
 * donnée post-t0.
 */

export type LinkEvidence = "same_slot" | "temporal_sync" | "persistent_cooccurrence";

const EVIDENCE_ORDER: LinkEvidence[] = ["same_slot", "temporal_sync", "persistent_cooccurrence"];

/** Entrée minimale pour le clustering (subset de SnapshotBuyer). */
export interface ClusterInput {
  wallet: string;
  slot: number | null;
  blockTimeMs: number;
}

/** Un entity-like group : wallets liés par des preuves observables. */
export interface EntityCluster {
  id: string;
  members: string[];
  evidence: LinkEvidence[];
}

export interface ClusteringResult {
  /** Groupes de ≥2 wallets (triés par premier membre pour la déterminisme). */
  clusters: EntityCluster[];
  /** Wallets non liés à aucun autre (triés). */
  singletons: string[];
  /** Nombre total d'entités apparentes = clusters + singletons. */
  entityCount: number;
}

/* ------------------------------------------------------------------ */
/* Union-find                                                          */
/* ------------------------------------------------------------------ */

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  constructor(wallets: string[]) {
    for (const w of wallets) {
      this.parent.set(w, w);
      this.rank.set(w, 0);
    }
  }

  find(x: string): string {
    let p = this.parent.get(x)!;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Clé de paire + carte de co-occurrence                               */
/* ------------------------------------------------------------------ */

/** Clé canonique d'une paire non ordonnée de wallets (base58 : pas de "|"). */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface WalletObservationLike {
  mint: string;
  blockTimeMs: number;
}

/**
 * Nombre de tokens DISTINCTS (hors `excludeMint`) où chaque paire de
 * wallets apparaît comme early buyer, observations ≤ t0ms uniquement.
 *
 * Complexité : O(Σ n²) par token — acceptable pour des sets d'early
 * buyers (quelques centaines de wallets au plus). Cette carte sert la
 * preuve "persistent_cooccurrence" : on ne compte PAS le token courant
 * (cohérent avec overlapFrac qui exige ≥1 AUTRE token).
 */
export function buildPairOverlap(
  idx: Map<string, WalletObservationLike[]>,
  t0ms: number,
  excludeMint?: string,
): Map<string, number> {
  // wallet -> mints distincts (observations ≤ t0ms, hors token courant)
  const byWallet = new Map<string, Set<string>>();
  for (const [wallet, obs] of idx) {
    const mints = new Set<string>();
    for (const o of obs) {
      if (o.mint === excludeMint) continue;
      if (o.blockTimeMs > t0ms) continue;
      mints.add(o.mint);
    }
    if (mints.size) byWallet.set(wallet, mints);
  }
  // mint -> wallets présents (pour éviter le O(W²) global)
  const byMint = new Map<string, string[]>();
  for (const [wallet, mints] of byWallet) {
    for (const m of mints) {
      const arr = byMint.get(m) ?? [];
      arr.push(wallet);
      byMint.set(m, arr);
    }
  }
  const counts = new Map<string, number>();
  for (const wallets of byMint.values()) {
    for (let i = 0; i < wallets.length; i++) {
      for (let j = i + 1; j < wallets.length; j++) {
        const k = pairKey(wallets[i]!, wallets[j]!);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* Clustering                                                          */
/* ------------------------------------------------------------------ */

const TEMPORAL_SYNC_GAP_MS = 2000;
const PERSISTENT_COOCCURRENCE_MIN = 2;

/**
 * Regroupe les wallets en entity-like groups sur trois preuves.
 *
 * @param buyers  buyers du snapshot (subset {wallet, slot, blockTimeMs}).
 * @param overlap carte paire -> nombre de tokens co-early-buyés
 *                (voir buildPairOverlap) ; seules les paires avec
 *                overlap ≥ 2 fusionnent.
 */
export function clusterWallets(
  buyers: ClusterInput[],
  overlap: Map<string, number>,
): ClusteringResult {
  const wallets = [...new Set(buyers.map((b) => b.wallet))];
  const uf = new UnionFind(wallets);
  const linkEvidence = new Map<string, Set<LinkEvidence>>();

  const link = (a: string, b: string, ev: LinkEvidence): void => {
    uf.union(a, b);
    const k = pairKey(a, b);
    let s = linkEvidence.get(k);
    if (!s) {
      s = new Set();
      linkEvidence.set(k, s);
    }
    s.add(ev);
  };

  // 1. same_slot : ≥2 buyers avec slot non-null identique.
  const bySlot = new Map<number, string[]>();
  for (const b of buyers) {
    if (b.slot == null) continue;
    const arr = bySlot.get(b.slot) ?? [];
    arr.push(b.wallet);
    bySlot.set(b.slot, arr);
  }
  for (const members of bySlot.values()) {
    if (members.length < 2) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        link(members[i]!, members[j]!, "same_slot");
      }
    }
  }

  // 2. temporal_sync : chaîne d'arrivées à ≤2000 ms d'écart (tri blockTimeMs).
  const byTime = [...buyers].sort((a, b) => a.blockTimeMs - b.blockTimeMs);
  let chainStart = 0;
  const closeChain = (endExclusive: number): void => {
    const run = byTime.slice(chainStart, endExclusive);
    if (run.length >= 2) {
      for (let i = 1; i < run.length; i++) {
        link(run[i - 1]!.wallet, run[i]!.wallet, "temporal_sync");
      }
    }
  };
  for (let i = 1; i < byTime.length; i++) {
    if (byTime[i]!.blockTimeMs - byTime[i - 1]!.blockTimeMs > TEMPORAL_SYNC_GAP_MS) {
      closeChain(i);
      chainStart = i;
    }
  }
  closeChain(byTime.length);

  // 3. persistent_cooccurrence : paires avec overlap ≥ 2 (union-find).
  const walletSet = new Set(wallets);
  for (const [k, count] of overlap) {
    if (count < PERSISTENT_COOCCURRENCE_MIN) continue;
    const sep = k.indexOf("|");
    if (sep < 0) continue;
    const a = k.slice(0, sep);
    const b = k.slice(sep + 1);
    if (!walletSet.has(a) || !walletSet.has(b)) continue;
    link(a, b, "persistent_cooccurrence");
  }

  // Composantes connexes -> clusters / singletons.
  const comps = new Map<string, string[]>();
  for (const w of wallets) {
    const r = uf.find(w);
    const arr = comps.get(r) ?? [];
    arr.push(w);
    comps.set(r, arr);
  }

  const clusters: EntityCluster[] = [];
  const singletons: string[] = [];
  for (const members of comps.values()) {
    if (members.length < 2) {
      singletons.push(members[0]!);
      continue;
    }
    members.sort();
    const ev = new Set<LinkEvidence>();
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const s = linkEvidence.get(pairKey(members[i]!, members[j]!));
        if (s) for (const e of s) ev.add(e);
      }
    }
    clusters.push({
      id: "",
      members,
      evidence: EVIDENCE_ORDER.filter((e) => ev.has(e)),
    });
  }
  clusters.sort((a, b) => (a.members[0]! < b.members[0]! ? -1 : 1));
  clusters.forEach((c, i) => {
    c.id = `cluster_${i}`;
  });
  singletons.sort();

  return { clusters, singletons, entityCount: clusters.length + singletons.length };
}

/* ------------------------------------------------------------------ */
/* Concentration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Indice Herfindahl-Hirschman : Σ parts² (0..1).
 * Ex. parts [0.5, 0.5] → 0.5 ; monopole → 1. null si aucune part.
 */
export function hhi(shares: number[]): number | null {
  const s = shares.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (s.length === 0) return null;
  let acc = 0;
  for (const v of s) acc += v * v;
  return acc;
}

/**
 * Parts de montant par entité apparente (clusters puis singletons,
 * ordre déterministe identique à celui de `c`). Somme = 1 (sauf total 0).
 */
export function entityAmountShares(
  items: Array<{ wallet: string; amount: bigint }>,
  c: ClusteringResult,
): number[] {
  const total = items.reduce((a, b) => a + b.amount, 0n);
  const byEntity = new Map<string, number>();
  c.clusters.forEach((cl, i) => {
    for (const m of cl.members) byEntity.set(m, i);
  });
  const offset = c.clusters.length;
  c.singletons.forEach((w, i) => byEntity.set(w, offset + i));
  const sums: bigint[] = new Array(c.entityCount).fill(0n);
  for (const it of items) {
    const e = byEntity.get(it.wallet);
    if (e === undefined) continue;
    sums[e] = sums[e]! + it.amount;
  }
  if (total === 0n) return sums.map(() => 0);
  return sums.map((s) => Number(s) / Number(total));
}

/**
 * Montants absolus par entité apparente (même ordre que
 * entityAmountShares) — pour giniOf / topNAmountShare.
 */
export function entityAmounts(
  items: Array<{ wallet: string; amount: bigint }>,
  c: ClusteringResult,
): bigint[] {
  const byEntity = new Map<string, number>();
  c.clusters.forEach((cl, i) => {
    for (const m of cl.members) byEntity.set(m, i);
  });
  const offset = c.clusters.length;
  c.singletons.forEach((w, i) => byEntity.set(w, offset + i));
  const sums: bigint[] = new Array(c.entityCount).fill(0n);
  for (const it of items) {
    const e = byEntity.get(it.wallet);
    if (e === undefined) continue;
    sums[e] = sums[e]! + it.amount;
  }
  return sums;
}
