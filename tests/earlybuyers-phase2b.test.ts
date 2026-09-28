/**
 * Phase 2.2 — tests : labels étendus, exclusions pré-enregistrées, Cox PH,
 * score §16, décision §17.
 *
 * Règle : données 100% synthétiques (aucune lecture de data/ en écriture,
 * aucun réseau). Les fonctions pures sont testées directement ; les
 * lecteurs de fichiers utilisent des répertoires temporaires.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TokenSnapshot } from "../lab/types.ts";
import {
  computeDeathAgreement,
  computeExtendedLabels,
  deathLabelsFromSeries,
  graduatedFromMigrations,
  readMigrationTimes,
} from "../lab/predictive/earlybuyers/labels.ts";
import {
  applyExclusions,
  PREREGISTERED_EXCLUSIONS,
  type ExclusionCtx,
} from "../lab/predictive/earlybuyers/exclusions.ts";
import {
  fitCoxPH,
  kaplanMeier,
} from "../lab/predictive/earlybuyers/survival.ts";
import {
  buildTokenScore,
  MODEL_VERSION,
  SCORE_FIELDS,
} from "../lab/predictive/earlybuyers/score.ts";
import {
  DECISION_CHECKLIST_IDS,
  evaluateDecisionState,
  type ChecklistItem,
} from "../lab/predictive/earlybuyers/decide.ts";
import type {
  EarlyBuyerSnapshot,
  FeatureSet,
  Labels,
} from "../lab/predictive/earlybuyers/types.ts";

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const T0 = Date.parse("2026-09-20T12:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;

function snap(
  fetchedAt: string,
  priceUsd: number,
  liquidityUsd: number,
): TokenSnapshot {
  return {
    mint: "SYNTH",
    chain: "solana",
    symbol: "S",
    name: "Synth",
    createdAt: fetchedAt,
    pairCreatedAt: null,
    pairAddress: null,
    dexId: null,
    url: null,
    priceUsd,
    liquidityUsd,
    fdvUsd: null,
    marketCapUsd: null,
    fetchedAt,
  } as TokenSnapshot;
}

/** Série synthétique triée : t0 = premier tick prix>0 & liq>=20000. */
function series(ticks: Array<{ dtH: number; price: number; liq: number }>): TokenSnapshot[] {
  return ticks.map((t) =>
    snap(
      new Date(T0 + t.dtH * H).toISOString(),
      t.price,
      t.liq,
    ),
  );
}

function cleanCtx(over: Partial<ExclusionCtx> = {}): ExclusionCtx {
  return {
    mint: "CleanMint1111111111111111111111111111111111",
    dataError: false,
    truncated: false,
    nBuyers: 12,
    sameSlotMax: 2,
    ...over,
  };
}

function checklist(pass: boolean | null): ChecklistItem[] {
  return DECISION_CHECKLIST_IDS.map((id) => ({
    id,
    desc: `critère ${id}`,
    pass,
    detail: "test",
  }));
}

/* ------------------------------------------------------------------ */
/* 1. graduated_7d                                                      */
/* ------------------------------------------------------------------ */

describe("graduated_7d", () => {
  it("true si un migrate tombe dans (t0, t0+7j]", () => {
    expect(graduatedFromMigrations(T0, [T0 + 1 * D])).toBe(true);
    expect(graduatedFromMigrations(T0, [T0 + 7 * D])).toBe(true); // borne incluse
    expect(graduatedFromMigrations(T0, [T0 - 1, T0 + 2 * D])).toBe(true);
  });

  it("false si aucun migrate dans la fenêtre (ou aucun événement)", () => {
    expect(graduatedFromMigrations(T0, [])).toBe(false);
    expect(graduatedFromMigrations(T0, [T0 - D])).toBe(false); // avant t0
    expect(graduatedFromMigrations(T0, [T0])).toBe(false); // borne exclue
    expect(graduatedFromMigrations(T0, [T0 + 8 * D])).toBe(false); // après 7j
  });

  it("null si t0 inconnu", () => {
    expect(graduatedFromMigrations(0, [T0 + D])).toBe(null);
    expect(graduatedFromMigrations(-5, [T0 + D])).toBe(null);
  });

  it("readMigrationTimes lit les événements migrate des scans", () => {
    const dir = mkdtempSync(join(tmpdir(), "scans-"));
    try {
      writeFileSync(
        join(dir, "pump-2026-09-20.jsonl"),
        [
          JSON.stringify({
            kind: "migrate",
            mint: "MINT_A",
            receivedAt: new Date(T0 + D).toISOString(),
          }),
          JSON.stringify({
            kind: "migrate",
            mint: "MINT_A",
            receivedAt: new Date(T0 + 2 * D).toISOString(),
          }),
          JSON.stringify({
            kind: "create",
            mint: "MINT_A",
            receivedAt: new Date(T0).toISOString(),
          }),
          JSON.stringify({
            kind: "migrate",
            mint: "MINT_B",
            receivedAt: "pas-une-date",
          }),
          "ligne corrompue {{{",
          "",
        ].join("\n"),
      );
      const m = readMigrationTimes(dir);
      expect(m.get("MINT_A")).toEqual([T0 + D, T0 + 2 * D]); // triés
      expect(m.has("MINT_B")).toBe(false); // date invalide ignorée
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readMigrationTimes retourne une carte vide si le répertoire est absent", () => {
    expect(readMigrationTimes(join(tmpdir(), "nope-xyz-123"))?.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Définitions de mort + accord                                      */
/* ------------------------------------------------------------------ */

describe("définitions de mort", () => {
  it("death_liq_7d : true si liquidité finale < 1000 USD (série ≥ 7j)", () => {
    const s = series([
      { dtH: 0, price: 1, liq: 50000 },
      { dtH: 24, price: 0.5, liq: 30000 },
      { dtH: 8 * 24, price: 0.01, liq: 500 },
    ]);
    const r = deathLabelsFromSeries(s);
    expect(r.t0ms).toBe(T0);
    expect(r.death_liq_7d).toBe(true);
  });

  it("death_liq_7d : false si liquidité finale >= 1000 USD", () => {
    const s = series([
      { dtH: 0, price: 1, liq: 50000 },
      { dtH: 8 * 24, price: 0.9, liq: 45000 },
    ]);
    expect(deathLabelsFromSeries(s).death_liq_7d).toBe(false);
  });

  it("death_liq_7d : null si série < 7j post-t0", () => {
    const s = series([
      { dtH: 0, price: 1, liq: 50000 },
      { dtH: 24, price: 0.5, liq: 500 },
    ]);
    const r = deathLabelsFromSeries(s);
    expect(r.death_liq_7d).toBe(null);
    expect(r.death_price_7d).toBe(null);
  });

  it("death_liq_7d : null si liquidité finale inconnue (0)", () => {
    const s = series([
      { dtH: 0, price: 1, liq: 50000 },
      { dtH: 8 * 24, price: 0.5, liq: 0 },
    ]);
    expect(deathLabelsFromSeries(s).death_liq_7d).toBe(null);
  });

  it("death_price_7d : true si prix final < 1% du prix t0", () => {
    const s = series([
      { dtH: 0, price: 1, liq: 50000 },
      { dtH: 8 * 24, price: 0.005, liq: 500 },
    ]);
    expect(deathLabelsFromSeries(s).death_price_7d).toBe(true);
  });

  it("death_price_7d : false si prix final >= 1% du prix t0", () => {
    const s = series([
      { dtH: 0, price: 1, liq: 50000 },
      { dtH: 8 * 24, price: 0.5, liq: 45000 },
    ]);
    expect(deathLabelsFromSeries(s).death_price_7d).toBe(false);
  });
});

describe("deathAgreement", () => {
  it("agree=true quand toutes les définitions non-null sont d'accord", () => {
    const r = computeDeathAgreement([
      { name: "death_liq_7d", v: true },
      { name: "death_price_7d", v: true },
      { name: "death_dd80_24h", v: null },
    ]);
    expect(r.agree).toBe(true);
    expect(r.defs).toEqual(["death_liq_7d", "death_price_7d"]);
  });

  it("agree=false en cas de désaccord", () => {
    const r = computeDeathAgreement([
      { name: "death_liq_7d", v: true },
      { name: "death_price_7d", v: false },
      { name: "death_dd80_24h", v: true },
    ]);
    expect(r.agree).toBe(false);
  });

  it("agree=null si moins de 2 définitions non-null", () => {
    expect(
      computeDeathAgreement([
        { name: "death_liq_7d", v: true },
        { name: "death_price_7d", v: null },
        { name: "death_dd80_24h", v: null },
      ]).agree,
    ).toBe(null);
    expect(
      computeDeathAgreement([
        { name: "death_liq_7d", v: null },
        { name: "death_price_7d", v: null },
        { name: "death_dd80_24h", v: null },
      ]).defs,
    ).toEqual([]);
  });
});

describe("computeExtendedLabels", () => {
  it("mint inconnu : extensions null + alias dd80_24h cohérent", () => {
    const l = computeExtendedLabels("MINT_INEXISTANT_XYZ_123", {
      scansDir: join(tmpdir(), "nope-xyz-123"),
    });
    expect(l.graduated_7d).toBe(null); // t0 inconnu
    expect(l.death_liq_7d).toBe(null);
    expect(l.death_price_7d).toBe(null);
    expect(l.death_dd80_24h).toBe(l.dd80_24h); // alias documenté
    expect(l.deathAgreement).toEqual({ defs: [], agree: null });
  });
});

/* ------------------------------------------------------------------ */
/* 3. Exclusions pré-enregistrées                                       */
/* ------------------------------------------------------------------ */

describe("exclusions pré-enregistrées", () => {
  it("4 règles gelées, dans l'ordre", () => {
    expect(PREREGISTERED_EXCLUSIONS.map((r) => r.id)).toEqual([
      "DATA_ERROR",
      "TRUNCATED",
      "SMALL_SET",
      "SNIPE_DOMINATED",
    ]);
  });

  it("contexte sain : non exclu, aucune raison", () => {
    const r = applyExclusions(cleanCtx());
    expect(r.excluded).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("DATA_ERROR : dataError=true déclenche la bonne raison", () => {
    const r = applyExclusions(cleanCtx({ dataError: true }));
    expect(r.excluded).toBe(true);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/DATA_ERROR/);
  });

  it("DATA_ERROR : mint listé dans DATA_ERROR_MINTS même sans flag", () => {
    const r = applyExclusions(
      cleanCtx({ mint: "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3" }),
    );
    expect(r.excluded).toBe(true);
    expect(r.reasons[0]).toMatch(/DATA_ERROR/);
  });

  it("TRUNCATED déclenche la bonne raison", () => {
    const r = applyExclusions(cleanCtx({ truncated: true }));
    expect(r.excluded).toBe(true);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/TRUNCATED/);
  });

  it("SMALL_SET : nBuyers < 5 déclenche la bonne raison", () => {
    const r = applyExclusions(cleanCtx({ nBuyers: 3 }));
    expect(r.excluded).toBe(true);
    expect(r.reasons[0]).toMatch(/SMALL_SET/);
    expect(applyExclusions(cleanCtx({ nBuyers: 5 })).excluded).toBe(false);
  });

  it("SNIPE_DOMINATED : sameSlotMax >= nBuyers/2 déclenche la bonne raison", () => {
    const hit = applyExclusions(cleanCtx({ nBuyers: 8, sameSlotMax: 4 }));
    expect(hit.excluded).toBe(true);
    expect(hit.reasons[0]).toMatch(/SNIPE_DOMINATED/);
    // Juste sous le seuil : pas de déclenchement.
    expect(
      applyExclusions(cleanCtx({ nBuyers: 8, sameSlotMax: 3 })).excluded,
    ).toBe(false);
    // sameSlotMax null : pas de déclenchement (jamais de faux positif).
    expect(
      applyExclusions(cleanCtx({ nBuyers: 8, sameSlotMax: null })).excluded,
    ).toBe(false);
  });

  it("plusieurs règles déclenchées : raisons cumulées", () => {
    const r = applyExclusions(
      cleanCtx({ truncated: true, nBuyers: 2, sameSlotMax: 2 }),
    );
    expect(r.excluded).toBe(true);
    expect(r.reasons).toHaveLength(3);
    expect(r.reasons.join(" ")).toMatch(/TRUNCATED/);
    expect(r.reasons.join(" ")).toMatch(/SMALL_SET/);
    expect(r.reasons.join(" ")).toMatch(/SNIPE_DOMINATED/);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Cox PH + Kaplan-Meier                                             */
/* ------------------------------------------------------------------ */

describe("Cox PH", () => {
  /** Effet connu : x=1 → durées plus courtes (hazard élevé), x=0 → plus longues.
   *  Chevauchement volontaire des plages (8..13) pour éviter la séparation
   *  complète (vraisemblance monotone → SE explosée). */
  function knownEffect() {
    const durations: number[] = [];
    const events: boolean[] = [];
    const X: number[][] = [];
    for (let i = 0; i < 30; i++) {
      durations.push(4 + (i % 10) * 1.0); // 4 .. 13
      events.push(i % 6 !== 0); // quelques censures
      X.push([1]);
    }
    for (let i = 0; i < 30; i++) {
      durations.push(8 + (i % 10) * 1.0); // 8 .. 17 (chevauchement 8..13)
      events.push(i % 6 !== 0);
      X.push([0]);
    }
    return { durations, events, X, featureNames: ["group"] };
  }

  it("converge sur données à effet connu, HR > 1 du bon côté", () => {
    const r = fitCoxPH(knownEffect());
    expect(r.n).toBe(60);
    expect(r.converged).toBe(true);
    expect(r.coef[0]).toBeGreaterThan(0); // x=1 → risque plus élevé
    expect(r.hr[0]).toBeGreaterThan(1);
    expect(r.se[0]).toBeGreaterThan(0);
    expect(r.se[0]).toBeLessThan(Math.abs(r.coef[0]!)); // signal net
    expect(r.pWald[0]).toBeLessThan(0.05);
    expect(r.concordance).not.toBe(null);
    expect(r.concordance!).toBeGreaterThan(0.6); // > 0.5 = mieux que l'aléatoire
  });

  it("n < 30 : non-convergent, concordance null, jamais interprété", () => {
    const r = fitCoxPH({
      durations: [1, 2, 3, 4, 5],
      events: [true, true, false, true, false],
      X: [[0], [1], [0], [1], [0]],
      featureNames: ["x"],
    });
    expect(r.n).toBe(5);
    expect(r.converged).toBe(false);
    expect(r.concordance).toBe(null);
  });

  it("aucun événement : non-convergent", () => {
    const r = fitCoxPH({
      durations: Array.from({ length: 40 }, (_, i) => 1 + i * 0.5),
      events: new Array(40).fill(false),
      X: Array.from({ length: 40 }, (_, i) => [i % 2]),
      featureNames: ["x"],
    });
    expect(r.converged).toBe(false);
    expect(r.concordance).toBe(null);
  });
});

describe("Kaplan-Meier", () => {
  it("courbe correcte sur exemple connu (censure incluse)", () => {
    const km = kaplanMeier([1, 2, 3], [true, false, true]);
    expect(km[0]).toEqual({ t: 0, s: 1 });
    // t=1 : 1 événement / 3 à risque → s = 2/3
    expect(km[1]!.t).toBe(1);
    expect(km[1]!.s).toBeCloseTo(2 / 3, 10);
    // t=2 : censure → pas de palier ; t=3 : 1 événement / 1 à risque → s = 0
    expect(km[2]!.t).toBe(3);
    expect(km[2]!.s).toBeCloseTo(0, 10);
    expect(km).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Score §16                                                         */
/* ------------------------------------------------------------------ */

describe("score §16", () => {
  function baseArgs(over: Record<string, unknown> = {}) {
    const snapshot: EarlyBuyerSnapshot = {
      mint: "ScoreMint11111111111111111111111111111111",
      universe: "discovery",
      t0ms: T0,
      buyers: [],
      histories: {},
      excludedReason: null,
    };
    const fv = (value: number | null) => ({ value, tsMs: T0 - 1000 });
    const featureSet: FeatureSet = {
      mint: snapshot.mint,
      universe: "discovery",
      t0ms: T0,
      features: {
        nBuyers: fv(10),
        giniAmt: fv(0.3),
        top1Share: fv(0.2),
        top5Share: fv(0.5),
        sameSlotMax: fv(3),
        medianWalletAgeSec: fv(86400),
        newWalletFrac: fv(0.4),
        experiencedWalletFrac: fv(0.1),
        activeWalletFrac: fv(0.7),
      },
    };
    const labels: Labels = {
      mint: snapshot.mint,
      universe: "discovery",
      t0ms: T0,
      y1h: null,
      y6h: null,
      y24h: null,
      ddMax24h: null,
      dd30_24h: null,
      dd50_24h: null,
      dd80_24h: null,
      survival_30_24h: null,
      survival_50_24h: null,
      survival_80_24h: null,
      dataError: false,
    };
    return {
      snapshot,
      featureSet,
      labels,
      auditPass: true,
      auditMaxTsMs: T0 - 1000,
      exclusionReasons: [] as string[],
      ...over,
    };
  }

  it("contient EXACTEMENT les champs §16 + UNAVAILABLE", () => {
    const s = buildTokenScore(baseArgs());
    for (const f of SCORE_FIELDS) {
      expect(s, `champ manquant : ${f}`).toHaveProperty(f);
    }
    expect(s).toHaveProperty("UNAVAILABLE");
  });

  it("valeurs observées renseignées, indisponibles = null + raison", () => {
    const s = buildTokenScore(baseArgs());
    expect(s.TOKEN_ID).toBe("ScoreMint11111111111111111111111111111111");
    expect(s.T0).toBe(new Date(T0).toISOString());
    expect(s.MODEL_VERSION).toBe(MODEL_VERSION);
    expect(s.EARLY_BUYERS_N).toBe(10);
    expect(s.GINI).toBe(0.3);
    expect(s.SNIPER_SHARE).toBeCloseTo(3 / 10, 10);
    expect(s.CONCENTRATION_WALLET).toEqual({
      gini: 0.3,
      top1Share: 0.2,
      top5Share: 0.5,
    });
    expect(s.WALLET_AGE_STATS).toEqual({
      medianWalletAgeSec: 86400,
      newWalletFrac: 0.4,
      experiencedWalletFrac: 0.1,
      activeWalletFrac: 0.7,
    });
    // Indisponibles : null + raison explicite.
    for (const f of [
      "DEPLOYER_LINK",
      "HISTORICAL_PNL_STATS",
      "TURNOVER_T0",
      "FRENZY_SCORE",
      "LIQUIDITY_T0",
      "BONDING_STATE",
      "BUNDLE_SHARE",
      "EARLY_ENTITY_N",
      "CONFIDENCE_INTERVAL",
    ] as const) {
      expect(s[f], `${f} doit être null`).toBe(null);
      expect(s.UNAVAILABLE[f], `raison manquante pour ${f}`).toBeTruthy();
    }
  });

  it("PRED_* = null à ce stade avec raison explicite", () => {
    const s = buildTokenScore(baseArgs());
    for (const f of [
      "PRED_Y_1H",
      "PRED_Y_6H",
      "PRED_Y_24H",
      "PRED_DD30",
      "PRED_DD50",
      "PRED_DD80",
      "PRED_SURVIVAL",
    ] as const) {
      expect(s[f]).toBe(null);
      expect(s.UNAVAILABLE[f]).toMatch(/aucun modèle validé/);
    }
  });

  it("n'invente jamais une valeur : feature absente → null", () => {
    const args = baseArgs();
    delete (args.featureSet.features as Record<string, unknown>)["giniAmt"];
    const s = buildTokenScore(args);
    expect(s.GINI).toBe(null);
    expect(s.EARLY_BUYERS_N).toBe(10); // les autres restent
  });

  it("EXCLUSION_REASON : null si aucune raison, join sinon", () => {
    expect(buildTokenScore(baseArgs()).EXCLUSION_REASON).toBe(null);
    const s = buildTokenScore(
      baseArgs({ exclusionReasons: ["TRUNCATED : x", "SMALL_SET : y"] }),
    );
    expect(s.EXCLUSION_REASON).toBe("TRUNCATED : x ; SMALL_SET : y");
  });

  it("audit temporel : pass si tsMs max <= t0ms", () => {
    const ok = buildTokenScore(baseArgs());
    expect(ok.DATA_TIMESTAMP_AUDIT.pass).toBe(true);
    expect(ok.LEAKAGE_STATUS).toBe("PASS");
    const ko = buildTokenScore(baseArgs({ auditMaxTsMs: T0 + 1 }));
    expect(ko.DATA_TIMESTAMP_AUDIT.pass).toBe(false);
    const fail = buildTokenScore(baseArgs({ auditPass: false }));
    expect(fail.LEAKAGE_STATUS).toBe("FAIL");
  });

  it("DATA_QUALITY reflète DATA_ERROR / TRUNCATED", () => {
    expect(buildTokenScore(baseArgs()).DATA_QUALITY).toBe("OK");
    expect(
      buildTokenScore(baseArgs({ truncated: true })).DATA_QUALITY,
    ).toBe("TRUNCATED");
    const args = baseArgs();
    args.labels.dataError = true;
    expect(buildTokenScore(args).DATA_QUALITY).toBe("DATA_ERROR");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Décision §17                                                      */
/* ------------------------------------------------------------------ */

describe("décision §17", () => {
  it("état 3 exige les 11 checks à true (jamais « guaranteed edge »)", () => {
    const r = evaluateDecisionState(checklist(true), false);
    expect(r.state).toBe(3);
    expect(r.summary).toMatch(/candidate predictive relation/);
    expect(r.summary).toMatch(/JAMAIS/);
  });

  it("un seul check à false bloque l'état 3 → état 1", () => {
    const cs = checklist(true);
    cs[3]!.pass = false;
    const r = evaluateDecisionState(cs, false);
    expect(r.state).toBe(1);
    expect(r.summary).toMatch(/NO EVIDENCE/);
  });

  it("un seul check non évaluable (null) bloque l'état 3 → état 1", () => {
    const cs = checklist(true);
    cs[0]!.pass = null; // oos_holdout non évaluable
    const r = evaluateDecisionState(cs, false);
    expect(r.state).toBe(1);
  });

  it("état 2 : lossSignal seul, aucun check contredit", () => {
    const r = evaluateDecisionState(checklist(null), true);
    expect(r.state).toBe(2);
    expect(r.summary).toMatch(/RISK FILTER/);
  });

  it("état 2 refusé si un check contredit (pass=false)", () => {
    const cs = checklist(null);
    cs[5]!.pass = false;
    expect(evaluateDecisionState(cs, true).state).toBe(1);
  });

  it("sans lossSignal et sans tous les checks → état 1", () => {
    expect(evaluateDecisionState(checklist(null), false).state).toBe(1);
    expect(evaluateDecisionState([], true).state).toBe(1); // checklist vide
  });
});
