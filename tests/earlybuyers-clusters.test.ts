/**
 * Tests Phase 2 — clustering wallet→entité + fenêtres early buyers (§3, §4 spec).
 *
 *  - clusters.ts : same_slot, temporal_sync, persistent_cooccurrence
 *    (union-find), singletons, hhi, entityAmountShares, buildPairOverlap ;
 *  - windows.ts  : first_block, first_5_slots, first_60s, first_300s,
 *    pre_t0_set (identité) ;
 *  - features.ts : non-régression bit-identique des 15 features d'origine
 *    (avec et sans opts), audit anti-fuite PASS avec les 7 nouvelles
 *    features (tsMs <= t0ms).
 *
 * Vocabulaire : wallet, cluster, entity-like group, coordinated set —
 * JAMAIS « une entité = une personne ».
 */
import { describe, it, expect } from "vitest";
import {
  buildPairOverlap,
  clusterWallets,
  entityAmountShares,
  hhi,
  pairKey,
} from "../lab/predictive/earlybuyers/clusters.ts";
import type { ClusteringResult } from "../lab/predictive/earlybuyers/clusters.ts";
import { applyWindow, WINDOW_DEFS } from "../lab/predictive/earlybuyers/windows.ts";
import {
  buildOverlapIndex,
  computeFeatureSet,
} from "../lab/predictive/earlybuyers/features.ts";
import { auditAntiLeakage } from "../lab/predictive/earlybuyers/audit.ts";
import { FIXED_FEATURES } from "../lab/predictive/earlybuyers/types.ts";
import type { EarlyBuyerSnapshot, SnapshotBuyer } from "../lab/predictive/earlybuyers/types.ts";

const T0_MS = 1_790_000_000_000;

function mkBuyer(
  wallet: string,
  blockTimeMs: number,
  slot: number | null,
  rank: number,
  amount: string,
): SnapshotBuyer {
  return { wallet, blockTimeMs, slot, rank, amountRaw: BigInt(amount) };
}

function mkSnap(buyers: SnapshotBuyer[]): EarlyBuyerSnapshot {
  return {
    mint: "TESTMINT",
    universe: "discovery",
    t0ms: T0_MS,
    buyers,
    histories: {},
    excludedReason: null,
  };
}

const ORIGINAL_15 = [
  "nBuyers",
  "giniAmt",
  "top1Share",
  "top5Share",
  "sameSlotMax",
  "arrivalSpanSec",
  "medianInterArrivalSec",
  "medianWalletAgeSec",
  "medianTxCountPreT0",
  "newWalletFrac",
  "experiencedWalletFrac",
  "activeWalletFrac",
  "overlapFrac",
  "medianTokensTouched",
  "medianBuySellRatio",
];

const NEW_7 = [
  "entityCount",
  "hhiWallet",
  "hhiEntity",
  "giniEntity",
  "top1EntityShare",
  "coordinatedSetFrac",
  "sniperShare",
];

/* ------------------------------------------------------------------ */

describe("hhi", () => {
  it("[0.5, 0.5] -> 0.5", () => {
    expect(hhi([0.5, 0.5])).toBeCloseTo(0.5, 12);
  });
  it("monopole -> 1, 4 parts égales -> 0.25, vide -> null", () => {
    expect(hhi([1])).toBeCloseTo(1, 12);
    expect(hhi([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0.25, 12);
    expect(hhi([])).toBeNull();
  });
});

describe("clustering", () => {
  it("same_slot : ≥2 buyers au même slot non-null forment un cluster", () => {
    const buyers = [
      { wallet: "w1", slot: 100, blockTimeMs: 1000 },
      { wallet: "w2", slot: 100, blockTimeMs: 90_000 },
      { wallet: "w3", slot: 101, blockTimeMs: 200_000 },
    ];
    const r = clusterWallets(buyers, new Map());
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.members).toEqual(["w1", "w2"]);
    expect(r.clusters[0]!.evidence).toContain("same_slot");
    expect(r.singletons).toEqual(["w3"]);
    expect(r.entityCount).toBe(2);
  });

  it("temporal_sync : chaîne d'arrivées à ≤2000 ms d'écart", () => {
    const buyers = [
      { wallet: "a", slot: 1, blockTimeMs: 0 },
      { wallet: "b", slot: 2, blockTimeMs: 1500 },
      { wallet: "c", slot: 3, blockTimeMs: 3000 }, // gap 1500 -> chaîne continue
      { wallet: "d", slot: 4, blockTimeMs: 60_000 }, // gap 57000 -> rupture
    ];
    const r = clusterWallets(buyers, new Map());
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.members).toEqual(["a", "b", "c"]);
    expect(r.clusters[0]!.evidence).toContain("temporal_sync");
    expect(r.singletons).toEqual(["d"]);
  });

  it("temporal_sync : gap > 2000 ms = pas de lien", () => {
    const buyers = [
      { wallet: "a", slot: 1, blockTimeMs: 0 },
      { wallet: "b", slot: 2, blockTimeMs: 2001 },
    ];
    const r = clusterWallets(buyers, new Map());
    expect(r.clusters).toHaveLength(0);
    expect(r.singletons).toEqual(["a", "b"]);
    expect(r.entityCount).toBe(2);
  });

  it("persistent_cooccurrence : paires overlap ≥ 2 fusionnées par union-find (transitivité)", () => {
    const buyers = [
      { wallet: "w1", slot: 1, blockTimeMs: 0 },
      { wallet: "w2", slot: 2, blockTimeMs: 5000 },
      { wallet: "w3", slot: 3, blockTimeMs: 10_000 },
      { wallet: "w4", slot: 4, blockTimeMs: 20_000 },
    ];
    const overlap = new Map<string, number>([
      [pairKey("w1", "w2"), 2],
      [pairKey("w2", "w3"), 3],
      [pairKey("w1", "w4"), 1], // < 2 : pas de lien
    ]);
    const r = clusterWallets(buyers, overlap);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.members).toEqual(["w1", "w2", "w3"]);
    expect(r.clusters[0]!.evidence).toContain("persistent_cooccurrence");
    expect(r.singletons).toEqual(["w4"]);
    expect(r.entityCount).toBe(2);
  });

  it("preuves combinées : un cluster porte toutes ses evidences", () => {
    const buyers = [
      { wallet: "w1", slot: 100, blockTimeMs: 0 },
      { wallet: "w2", slot: 100, blockTimeMs: 500 },
    ];
    const r = clusterWallets(buyers, new Map());
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.evidence).toEqual(
      expect.arrayContaining(["same_slot", "temporal_sync"]),
    );
  });

  it("aucun lien -> tous singletons", () => {
    const buyers = [
      { wallet: "w1", slot: 1, blockTimeMs: 0 },
      { wallet: "w2", slot: 2, blockTimeMs: 100_000 },
    ];
    const r = clusterWallets(buyers, new Map());
    expect(r.clusters).toHaveLength(0);
    expect(r.singletons).toEqual(["w1", "w2"]);
    expect(r.entityCount).toBe(2);
  });
});

describe("buildPairOverlap", () => {
  it("compte les tokens distincts partagés, exclut le mint courant et les obs > t0ms", () => {
    const idx = new Map([
      ["w1", [{ mint: "A", blockTimeMs: T0_MS - 1000 }, { mint: "B", blockTimeMs: T0_MS - 2000 }, { mint: "C", blockTimeMs: T0_MS - 500 }]],
      ["w2", [{ mint: "A", blockTimeMs: T0_MS - 1000 }, { mint: "B", blockTimeMs: T0_MS - 2000 }]],
      ["w3", [{ mint: "A", blockTimeMs: T0_MS - 1000 }]],
      ["w4", [{ mint: "A", blockTimeMs: T0_MS + 60_000 }]], // post-t0 : ignorée
    ]);
    const m = buildPairOverlap(idx, T0_MS, "C");
    expect(m.get(pairKey("w1", "w2"))).toBe(2);
    expect(m.get(pairKey("w1", "w3"))).toBe(1);
    expect(m.get(pairKey("w1", "w4"))).toBeUndefined();
  });
});

describe("entityAmountShares", () => {
  it("parts par entité apparente (clusters puis singletons)", () => {
    const c: ClusteringResult = {
      clusters: [{ id: "cluster_0", members: ["a", "b"], evidence: ["same_slot"] }],
      singletons: ["c"],
      entityCount: 2,
    };
    const shares = entityAmountShares(
      [
        { wallet: "a", amount: 30n },
        { wallet: "b", amount: 70n },
        { wallet: "c", amount: 100n },
      ],
      c,
    );
    expect(shares).toHaveLength(2);
    expect(shares[0]).toBeCloseTo(0.5, 12);
    expect(shares[1]).toBeCloseTo(0.5, 12);
  });
});

/* ------------------------------------------------------------------ */

describe("windows", () => {
  const buyers: SnapshotBuyer[] = [
    mkBuyer("w1", 1000, 5, 0, "100"),
    mkBuyer("w2", 2000, 5, 1, "100"),
    mkBuyer("w3", 30_000, 9, 2, "100"),
    mkBuyer("w4", 61_000, 12, 3, "100"),
    mkBuyer("w5", 400_000, 20, 4, "100"),
  ];

  it("pre_t0_set = identité", () => {
    expect(applyWindow(buyers, "pre_t0_set")).toBe(buyers);
  });

  it("first_block ne garde que le slot min", () => {
    const w = applyWindow(buyers, "first_block");
    expect(w.map((b) => b.wallet)).toEqual(["w1", "w2"]);
  });

  it("first_5_slots : slot <= min+4", () => {
    const w = applyWindow(buyers, "first_5_slots");
    expect(w.map((b) => b.wallet)).toEqual(["w1", "w2", "w3"]); // slots 5,5,9 <= 9
  });

  it("first_60s coupe au bon seuil (inclusif)", () => {
    const w = applyWindow(buyers, "first_60s");
    expect(w.map((b) => b.wallet)).toEqual(["w1", "w2", "w3", "w4"]); // <= 1000+60000
  });

  it("first_300s coupe au bon seuil", () => {
    const w = applyWindow(buyers, "first_300s");
    expect(w.map((b) => b.wallet)).toEqual(["w1", "w2", "w3", "w4"]); // 400000 > 301000
  });

  it("slots tous null -> first_block = [] (documenté)", () => {
    const b = buyers.map((x) => ({ ...x, slot: null }));
    expect(applyWindow(b, "first_block")).toEqual([]);
    expect(applyWindow(b, "first_5_slots")).toEqual([]);
  });

  it("WINDOW_DEFS couvre les 5 définitions", () => {
    expect(WINDOW_DEFS.map((d) => d.def).sort()).toEqual(
      ["first_300s", "first_5_slots", "first_60s", "first_block", "pre_t0_set"].sort(),
    );
  });
});

/* ------------------------------------------------------------------ */

function richSnap(): EarlyBuyerSnapshot {
  return mkSnap([
    mkBuyer("w1", T0_MS - 300_000, 100, 0, "100"),
    mkBuyer("w2", T0_MS - 299_000, 100, 1, "200"), // même slot + sync temporelle
    mkBuyer("w3", T0_MS - 200_000, 105, 2, "50"),
    mkBuyer("w4", T0_MS - 100_000, 110, 3, "300"),
    mkBuyer("w5", T0_MS - 50_000, 120, 4, "150"),
    mkBuyer("w6", T0_MS - 10_000, 130, 5, "200"),
  ]);
}

describe("features : non-régression des 15 d'origine", () => {
  it("mêmes valeurs avec et sans opts (bit-identique)", () => {
    const snap = richSnap();
    const idx = buildOverlapIndex([snap]);
    const fs1 = computeFeatureSet(snap, idx);
    const fs2 = computeFeatureSet(snap, idx, {});
    const manual: ClusteringResult = {
      clusters: [{ id: "cluster_0", members: ["w1", "w4"], evidence: ["persistent_cooccurrence"] }],
      singletons: ["w2", "w3", "w5", "w6"],
      entityCount: 5,
    };
    const fs3 = computeFeatureSet(snap, idx, { clustering: manual, windowLabel: "first_60s" });

    for (const key of ORIGINAL_15) {
      expect(fs1.features[key], `fs2 ${key}`).toEqual(fs2.features[key]);
      expect(fs1.features[key], `fs3 ${key}`).toEqual(fs3.features[key]);
    }
    // FIXED_FEATURES contient désormais 15 + 7.
    expect(FIXED_FEATURES).toHaveLength(22);
    for (const key of NEW_7) {
      expect(fs1.features[key]).toBeDefined();
    }
    // windowLabel tracé seulement quand fourni.
    expect(fs1.windowLabel).toBeUndefined();
    expect(fs3.windowLabel).toBe("first_60s");
  });

  it("les 7 nouvelles features ont des valeurs cohérentes", () => {
    const snap = richSnap();
    const idx = buildOverlapIndex([snap]);
    const fs = computeFeatureSet(snap, idx);
    const f = fs.features;

    // w1+w2 même slot -> cluster ; le reste singletons : 1 cluster + 4 singletons.
    expect(f.entityCount!.value).toBe(5);
    // HHI wallet sur parts [100,200,50,300,150,200]/1000.
    const shares = [0.1, 0.2, 0.05, 0.3, 0.15, 0.2];
    const expectedHhi = shares.reduce((a, s) => a + s * s, 0);
    expect(f.hhiWallet!.value).toBeCloseTo(expectedHhi, 12);
    // Entités : {w1+w2}=300, w3=50, w4=300, w5=150, w6=200.
    const eShares = [0.3, 0.05, 0.3, 0.15, 0.2];
    expect(f.hhiEntity!.value).toBeCloseTo(
      eShares.reduce((a, s) => a + s * s, 0),
      12,
    );
    expect(f.top1EntityShare!.value).toBeCloseTo(0.3, 12);
    expect(f.giniEntity!.value).toBeGreaterThan(0);
    expect(f.coordinatedSetFrac!.value).toBeCloseTo(2 / 6, 12);
    // first_block = slot 100 = w1,w2 -> 2/6.
    expect(f.sniperShare!.value).toBeCloseTo(2 / 6, 12);
    // clustering fourni explicitement : entités apparentes différentes.
    const fs3 = computeFeatureSet(snap, idx, {
      clustering: {
        clusters: [{ id: "cluster_0", members: ["w1", "w4"], evidence: ["persistent_cooccurrence"] }],
        singletons: ["w2", "w3", "w5", "w6"],
        entityCount: 5,
      },
    });
    expect(fs3.features.top1EntityShare!.value).toBeCloseTo(0.4, 12); // w1+w4 = 400
  });

  it("set vide -> features nulles, pas d'exception", () => {
    const fs = computeFeatureSet(mkSnap([]), buildOverlapIndex([]));
    for (const key of [...ORIGINAL_15, ...NEW_7]) {
      expect(fs.features[key]).toBeDefined();
    }
    expect(fs.features.hhiWallet!.value).toBeNull();
    expect(fs.features.hhiEntity!.value).toBeNull();
  });
});

describe("audit anti-fuite avec les nouvelles features", () => {
  it("PASS : tous les tsMs <= t0ms", () => {
    const snap = richSnap();
    const idx = buildOverlapIndex([snap]);
    const fs1 = computeFeatureSet(snap, idx);
    const fs2 = computeFeatureSet(snap, idx, { windowLabel: "first_5_slots" });
    const r = auditAntiLeakage([fs1, fs2]);
    expect(r.pass).toBe(true);
    expect(r.checked).toBe(44); // 22 features x 2 jeux
    expect(r.violations).toHaveLength(0);
  });
});
