import { describe, expect, it } from "vitest";
import { CHECK_IDS, DEFAULT_THRESHOLDS, HARD_CHECKS, runChecklist, type CheckId, type RedteamEvidence, type RedteamInput } from "../lab/redteam/checklist.ts";
import { crossCheck, type SignalInput } from "../lab/signals/crosscheck.ts";
import { NOW, snapshot } from "./execFixtures.ts";

/** Preuves complètes et saines : tout OK. */
const CLEAN: RedteamEvidence = {
  insiderSupplyShare: 0.05,
  linkedWalletsSupplyShare: 0.05,
  washTradingShare: 0.1,
  botTradeShare: 0.2,
  uniqueTraders24h: 800,
  lpLockedShare: 0.95,
  buysObserved: 500,
  sellsObserved: 300,
  transferTaxBps: 0,
  deployerSupplyShare: 0.03,
  socialBotShare: 0.1,
  paidPromotion: false,
  narrativeAgeHours: 12,
  narrativeAccelRatio: 2.5,
  priceChange24hPct: 40,
  contradictions: [],
};

const clean = (over: Partial<RedteamInput> = {}, ev: Partial<RedteamEvidence> = {}): RedteamInput => ({
  snapshot: snapshot({ riskyExtensions: [] }),
  evidence: { ...CLEAN, ...ev },
  ...over,
});
const item = (r: ReturnType<typeof runChecklist>, id: CheckId) => r.items.find((i) => i.id === id)!;

describe("checklist — cas nominal et structure", () => {
  it("token sain avec toutes les preuves → OK, 18 items, tous OK", () => {
    const r = runChecklist(clean(), NOW);
    expect(r.verdict).toBe("OK");
    expect(r.items).toHaveLength(18);
    expect(r.items.map((i) => i.id)).toEqual([...CHECK_IDS]);
    expect(r.items.filter((i) => i.status !== "OK").map((i) => `${i.id}:${i.status}:${i.evidence}`)).toEqual([]);
    expect(r.vetoes).toEqual([]);
    expect(r.unknownHard).toEqual([]);
    expect(r.overridden).toBe(false);
    for (const i of r.items) {
      expect(i.evidence.length).toBeGreaterThan(0);
      expect(i.hard).toBe(HARD_CHECKS.includes(i.id));
    }
  });

  it("les critères durs sont exactement : autorités, extensions, concentration, honeypot, liquidité", () => {
    expect([...HARD_CHECKS].sort()).toEqual(["artificialLiquidity", "concentration", "contractExtensions", "honeypot", "mintFreezeAuthority"]);
  });

  it("sans instantané ni preuves : tout est UNKNOWN (jamais OK par défaut) → NO_TRADE", () => {
    const r = runChecklist({ snapshot: null }, NOW);
    expect(r.verdict).toBe("NO_TRADE");
    expect(r.unknownHard.sort()).toEqual([...HARD_CHECKS].sort());
    expect(r.items.filter((i) => i.status === "OK").map((i) => i.id)).toEqual(["contradictoryInfo"]); // rien à contredire
    expect(runChecklist(undefined as unknown as RedteamInput, NOW).verdict).toBe("NO_TRADE");
  });

  it("déterminisme et non-mutation", () => {
    const input = clean();
    const copy = JSON.parse(JSON.stringify(input));
    expect(runChecklist(input, NOW)).toEqual(runChecklist(input, NOW));
    expect(input).toEqual(copy);
  });
});

describe("checklist — chaque critère dur → VETO → NO_TRADE", () => {
  it("mint authority présente", () => {
    const r = runChecklist(clean({ snapshot: snapshot({ mintAuthority: "Auth111", riskyExtensions: [] }) }), NOW);
    expect(r.verdict).toBe("NO_TRADE");
    expect(item(r, "mintFreezeAuthority")).toMatchObject({ status: "VETO", hard: true });
    expect(item(r, "mintFreezeAuthority").evidence).toMatch(/mint authority Auth111/);
  });

  it("freeze authority présente", () => {
    const r = runChecklist(clean({ snapshot: snapshot({ freezeAuthority: "Frz111", riskyExtensions: [] }) }), NOW);
    expect(r.verdict).toBe("NO_TRADE");
    expect(r.vetoes).toEqual(["mintFreezeAuthority"]);
  });

  it("extension Token-2022 dangereuse", () => {
    const r = runChecklist(clean({ snapshot: snapshot({ riskyExtensions: ["permanentDelegate"] }) }), NOW);
    expect(r.verdict).toBe("NO_TRADE");
    expect(item(r, "contractExtensions").status).toBe("VETO");
    expect(item(r, "contractExtensions").evidence).toMatch(/permanentDelegate/);
  });

  it("top 10 > seuil (40 %) ; 30 % → WARN ; seuil surchargeable", () => {
    const r = runChecklist(clean({ snapshot: snapshot({ top10Pct: 40.1, riskyExtensions: [] }) }), NOW);
    expect(r.verdict).toBe("NO_TRADE");
    expect(item(r, "concentration").status).toBe("VETO");
    expect(item(runChecklist(clean({ snapshot: snapshot({ top10Pct: 35, riskyExtensions: [] }) }), NOW), "concentration").status).toBe("WARN");
    expect(runChecklist(clean({ snapshot: snapshot({ top10Pct: 35, riskyExtensions: [] }), thresholds: { maxTop10Pct: 30 } }), NOW).verdict).toBe("NO_TRADE");
    expect(DEFAULT_THRESHOLDS.maxTop10Pct).toBe(40);
  });

  it("honeypot suspect : des achats et aucune vente observée", () => {
    const r = runChecklist(clean({}, { buysObserved: 120, sellsObserved: 0 }), NOW);
    expect(r.verdict).toBe("NO_TRADE");
    expect(item(r, "honeypot").status).toBe("VETO");
    expect(item(r, "honeypot").evidence).toMatch(/AUCUNE vente/);
    // très peu de ventes → WARN seulement
    expect(item(runChecklist(clean({}, { buysObserved: 100, sellsObserved: 2 }), NOW), "honeypot").status).toBe("WARN");
  });

  it("liquidité < seuil (20 000 $)", () => {
    const r = runChecklist(clean({ snapshot: snapshot({ liquidityUsd: 19_999, riskyExtensions: [] }) }), NOW);
    expect(r.verdict).toBe("NO_TRADE");
    expect(item(r, "artificialLiquidity").status).toBe("VETO");
    expect(item(runChecklist(clean({}, { lpLockedShare: 0.2 }), NOW), "artificialLiquidity").status).toBe("WARN");
  });
});

describe("checklist — UNKNOWN sur un critère dur → NO_TRADE", () => {
  it("autorités absentes de l'instantané", () => {
    const s = snapshot({ riskyExtensions: [] }) as unknown as Record<string, unknown>;
    delete s.mintAuthority;
    const r = runChecklist(clean({ snapshot: s as unknown as ReturnType<typeof snapshot> }), NOW);
    expect(r.verdict).toBe("NO_TRADE");
    expect(r.unknownHard).toEqual(["mintFreezeAuthority"]);
    expect(r.vetoes).toEqual([]);
  });

  it("extensions non vérifiées (riskyExtensions absent)", () => {
    const r = runChecklist(clean({ snapshot: snapshot() }), NOW); // le fixture n'a pas riskyExtensions
    expect(r.verdict).toBe("NO_TRADE");
    expect(r.unknownHard).toEqual(["contractExtensions"]);
  });

  it("achats/ventes non observés, ou aucune transaction du tout", () => {
    const r = runChecklist(clean({}, { buysObserved: undefined, sellsObserved: undefined }), NOW);
    expect(r.verdict).toBe("NO_TRADE");
    expect(r.unknownHard).toEqual(["honeypot"]);
    expect(runChecklist(clean({}, { buysObserved: 0, sellsObserved: 0 }), NOW).unknownHard).toEqual(["honeypot"]);
  });

  it("top10Pct ou liquidité non numériques", () => {
    expect(runChecklist(clean({ snapshot: snapshot({ top10Pct: NaN, riskyExtensions: [] }) }), NOW).unknownHard).toEqual(["concentration"]);
    expect(runChecklist(clean({ snapshot: snapshot({ liquidityUsd: undefined as unknown as number, riskyExtensions: [] }) }), NOW).unknownHard).toContain("artificialLiquidity");
  });

  it("UNKNOWN sur un critère doux ne bloque pas : verdict WARN", () => {
    const r = runChecklist(clean({}, { socialBotShare: undefined, insiderSupplyShare: undefined }), NOW);
    expect(r.verdict).toBe("WARN");
    expect(r.warnings.sort()).toEqual(["fakeEngagement", "insiders"]);
    expect(item(r, "insiders").status).toBe("UNKNOWN");
  });
});

describe("checklist — critères doux : VETO / WARN / OK", () => {
  const cases: Array<[CheckId, Partial<RedteamEvidence>, Partial<RedteamEvidence>]> = [
    ["insiders", { insiderSupplyShare: 0.31 }, { insiderSupplyShare: 0.15 }],
    ["linkedWallets", { linkedWalletsSupplyShare: 0.26 }, { linkedWalletsSupplyShare: 0.15 }],
    ["washTrading", { washTradingShare: 0.51 }, { washTradingShare: 0.3 }],
    ["bots", { botTradeShare: 0.71 }, { botTradeShare: 0.5 }],
    ["taxes", { transferTaxBps: 501 }, { transferTaxBps: 100 }],
    ["rugRisk", { deployerSupplyShare: 0.31 }, { deployerSupplyShare: 0.2 }],
    ["fakeEngagement", { socialBotShare: 0.51 }, { socialBotShare: 0.3 }],
    ["narrativeExhausted", { narrativeAgeHours: 169 }, { narrativeAgeHours: 80 }],
    ["pumpTooAdvanced", { priceChange24hPct: 301 }, { priceChange24hPct: 150 }],
    ["contradictoryInfo", { contradictions: ["a", "b", "c"] }, { contradictions: ["a"] }],
  ];
  for (const [id, veto, warn] of cases) {
    it(`${id} : VETO → NO_TRADE ; WARN → WARN`, () => {
      const v = runChecklist(clean({}, veto), NOW);
      expect(v.verdict, `${id} veto`).toBe("NO_TRADE");
      expect(v.vetoes).toEqual([id]);
      const w = runChecklist(clean({}, warn), NOW);
      expect(w.verdict, `${id} warn`).toBe("WARN");
      expect(w.warnings).toEqual([id]);
    });
  }

  it("volume artificiel : volume 24 h > 100 × liquidité → VETO ; > 30 × → WARN ; volume par trader unique", () => {
    expect(item(runChecklist(clean({ snapshot: snapshot({ volume24h: 5_100_000, riskyExtensions: [] }) }), NOW), "artificialVolume").status).toBe("VETO");
    expect(item(runChecklist(clean({ snapshot: snapshot({ volume24h: 1_600_000, riskyExtensions: [] }) }), NOW), "artificialVolume").status).toBe("WARN");
    expect(item(runChecklist(clean({ snapshot: snapshot({ volume24h: 600_000, riskyExtensions: [] }) }, { uniqueTraders24h: 10 }), NOW), "artificialVolume").status).toBe("VETO");
  });

  it("distribution des holders : < 30 → VETO, < 100 → WARN", () => {
    expect(runChecklist(clean({ snapshot: snapshot({ holders: 29, riskyExtensions: [] }) }), NOW).vetoes).toEqual(["holderDistribution"]);
    expect(runChecklist(clean({ snapshot: snapshot({ holders: 99, riskyExtensions: [] }) }), NOW).warnings).toEqual(["holderDistribution"]);
  });

  it("taxes : sans transferTaxBps, une extension de taxe dans l'instantané suffit au VETO (et bloque aussi via contractExtensions)", () => {
    const r = runChecklist(clean({ snapshot: snapshot({ riskyExtensions: ["transferFeeConfig"] }) }, { transferTaxBps: undefined }), NOW);
    expect(r.vetoes.sort()).toEqual(["contractExtensions", "taxes"]);
  });

  it("manipulation sociale : promotion payée ou cause unique dans le cross-check → WARN", () => {
    expect(runChecklist(clean({}, { paidPromotion: true }), NOW).warnings).toEqual(["socialManipulation"]);
    const boost = "dexscreener-boost:x";
    const ts = new Date(NOW.getTime() - 60_000).toISOString();
    const signals: SignalInput[] = [
      { id: "a", family: "market", cause: boost, strength: 0.9, ts },
      { id: "b", family: "onchain", cause: boost, strength: 0.9, ts },
      { id: "c", family: "human", cause: boost, strength: 0.9, ts },
    ];
    const r = runChecklist(clean({ signals, crossCheck: crossCheck(signals, NOW) }), NOW);
    expect(r.verdict).toBe("WARN");
    expect(item(r, "socialManipulation").evidence).toMatch(/cause commune/);
  });

  it("information contradictoire : incohérences internes de l'instantané et signal déclaré avec deux causes", () => {
    const r = runChecklist(clean({ snapshot: snapshot({ volume5m: 50_000, volume1h: 10_000, riskyExtensions: [] }) }), NOW);
    expect(item(r, "contradictoryInfo").status).toBe("WARN");
    expect(item(r, "contradictoryInfo").evidence).toMatch(/volume 5 min > volume 1 h/);
    const ts = new Date(NOW.getTime() - 60_000).toISOString();
    const dup: SignalInput[] = [{ id: "x", family: "market", cause: "a", strength: 1, ts }, { id: "x", family: "market", cause: "b", strength: 1, ts }];
    expect(item(runChecklist(clean({ signals: dup }), NOW), "contradictoryInfo").evidence).toMatch(/signal x déclaré avec 2 causes/);
  });

  it("plusieurs VETO et UNKNOWN durs sont tous listés (pas seulement le premier)", () => {
    const r = runChecklist(clean({ snapshot: snapshot({ mintAuthority: "A", top10Pct: 90, liquidityUsd: 100 }) }, { washTradingShare: 0.9, buysObserved: undefined }), NOW);
    // 100 $ de liquidité pour 100 k$ de volume 24 h : le volume artificiel ressort aussi
    expect(r.vetoes.sort()).toEqual(["artificialLiquidity", "artificialVolume", "concentration", "mintFreezeAuthority", "washTrading"]);
    expect(r.unknownHard.sort()).toEqual(["contractExtensions", "honeypot"]);
    expect(r.summary).toMatch(/NO_TRADE — 5 VETO/);
  });
});

describe("checklist — levée humaine du veto", () => {
  const override = { by: "Hervé", reason: "Freeze authority vérifiée : multisig du protocole, documentée", ts: new Date(NOW.getTime() - 3600_000).toISOString() };

  it("un humanOverride valide lève le NO_TRADE en WARN (jamais OK) et garde la trace de ce qui a été levé", () => {
    const r = runChecklist(clean({ snapshot: snapshot({ freezeAuthority: "Frz", riskyExtensions: [] }), humanOverride: override }), NOW);
    expect(r.verdict).toBe("WARN");
    expect(r.overridden).toBe(true);
    expect(r.override).toMatchObject({ by: "Hervé", lifted: ["mintFreezeAuthority"] });
    expect(item(r, "mintFreezeAuthority").status).toBe("VETO"); // l'item reste VETO : seule la conclusion change
    expect(r.summary).toMatch(/veto levé par Hervé/);
    expect(r.summary).toMatch(/Risk Engine local re-vérifiera .* IGNORE cette levée/);
  });

  it("override incomplet, trop court, sans fuseau, périmé (> 24 h) ou futur → refusé, NO_TRADE maintenu", () => {
    const base = clean({ snapshot: snapshot({ freezeAuthority: "Frz", riskyExtensions: [] }) });
    const bad = [
      { ...override, by: "" },
      { ...override, reason: "ok" },
      { ...override, ts: "2026-09-24T14:00:00" },
      { ...override, ts: new Date(NOW.getTime() - 25 * 3600_000).toISOString() },
      { ...override, ts: new Date(NOW.getTime() + 3600_000).toISOString() },
    ];
    for (const o of bad) {
      const r = runChecklist({ ...base, humanOverride: o }, NOW);
      expect(r.verdict, JSON.stringify(o)).toBe("NO_TRADE");
      expect(r.overridden).toBe(false);
      expect(r.summary).toMatch(/humanOverride refusé/);
    }
  });

  it("un override sur un verdict déjà OK ne change rien ; le champ n'existe que pour lever un NO_TRADE", () => {
    const r = runChecklist(clean({ humanOverride: override }), NOW);
    expect(r.verdict).toBe("OK");
    expect(r.overridden).toBe(false);
    expect(r.override).toBeUndefined();
  });

  it("le dépôt ne peut pas lever un veto : un champ `humanOverride` dans un intent n'est pas lu par le Risk Engine (re-vérification)", async () => {
    // Preuve côté exécution : evaluate() ignore tout champ humanOverride et refuse la freeze authority d'après SON instantané.
    const { evaluate } = await import("../lab/risk/engine.ts");
    const { intent, policy, portfolio } = await import("./execFixtures.ts");
    const forged = { ...intent(), humanOverride: override } as ReturnType<typeof intent>;
    const v = evaluate(forged, portfolio(), snapshot({ freezeAuthority: "Frz" }), policy(), NOW);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join()).toMatch(/FREEZE_AUTHORITY/);
  });
});
