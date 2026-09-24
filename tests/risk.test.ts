import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { consecutiveLosses, evaluate, failedExecutionsWithin, loadPolicy, policyProblems, positionTags, resolvePolicyPath, validatePolicy } from "../lab/risk/engine.ts";
import { dateKey, hourInZone, isoWeekKey } from "../lab/time.ts";
import type { Intent, RiskPolicy } from "../lab/types.ts";
import type { IntentV2 } from "../lab/risk/types.ts";
import { MINT_A, MINT_B, MINT_C, MINT_D, MINT_E, NOW, REPO_ROOT, intent, ledgerEntry, policy, portfolio, snapshot } from "./execFixtures.ts";

const P = policy();

function reasonsOf(i: Partial<IntentV2> = {}, extra: Parameters<typeof evaluate>[1] = portfolio(), snap = snapshot(), pol = P, now: Date = NOW, ledger = []) {
  return evaluate(intent(i), extra, snap, pol, now, ledger);
}

describe("Risk Engine — cas nominal", () => {
  it("accepte un BUY conforme et renvoie la taille retenue", () => {
    const v = reasonsOf();
    expect(v).toEqual({ allowed: true, reasons: [], adjustedSizeCad: 40 });
  });

  it("accepte un SELL avec position existante", () => {
    const pf = portfolio({ positions: [{ mint: MINT_A, qty: 1000, costCad: 40, openedAt: NOW.toISOString() }] });
    const v = reasonsOf({ kind: "SELL", sizeCad: 100 }, pf);
    expect(v.allowed).toBe(true);
    expect(v.adjustedSizeCad).toBe(100);
  });

  it("ne lève jamais : entrées absurdes → rejet motivé", () => {
    // @ts-expect-error entrées volontairement invalides
    const v = evaluate(null, undefined, undefined, undefined, "n'importe quoi");
    expect(v.allowed).toBe(false);
    expect(v.reasons.length).toBeGreaterThan(0);
    // @ts-expect-error politique invalide
    expect(evaluate(intent(), portfolio(), snapshot(), { version: 2 }, NOW).reasons[0]).toMatch(/POLITIQUE_INVALIDE/);
    expect(evaluate(intent(), portfolio(), snapshot(), P, "date-invalide").reasons[0]).toMatch(/HORLOGE_INVALIDE/);
  });
});

describe("Risk Engine — champs et cohérence", () => {
  it("rejette un intent avec champs manquants", () => {
    const v = reasonsOf({ thesis: "", invalidation: undefined as unknown as string });
    expect(v.allowed).toBe(false);
    expect(v.reasons).toContain("CHAMP_MANQUANT: thesis");
    expect(v.reasons).toContain("CHAMP_MANQUANT: invalidation");
  });

  it("rejette un kind inconnu et un NO_ACTION", () => {
    expect(reasonsOf({ kind: "HOLD" as unknown as Intent["kind"] }).reasons.join()).toMatch(/KIND_INVALIDE/);
    const v = reasonsOf({ kind: "NO_ACTION" });
    expect(v.allowed).toBe(false);
    expect(v.reasons[0]).toMatch(/^NO_ACTION/);
  });

  it("rejette une taille non numérique ou un mint mal formé", () => {
    expect(reasonsOf({ sizeCad: "40" as unknown as number }).reasons).toContain("CHAMP_MANQUANT: sizeCad");
    expect(reasonsOf({ mint: "pas-un-mint" }).reasons.join()).toMatch(/MINT_INVALIDE/);
  });

  it("rejette un portefeuille malformé", () => {
    const v = evaluate(intent(), { cashCad: NaN } as unknown as ReturnType<typeof portfolio>, snapshot(), P, NOW);
    expect(v.allowed).toBe(false);
    expect(v.reasons[0]).toMatch(/PORTEFEUILLE_INVALIDE/);
  });
});

describe("Risk Engine — expiration et doublons", () => {
  it("rejette un intent expiré", () => {
    const v = reasonsOf({ expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join()).toMatch(/INTENT_EXPIRE/);
  });

  it("borne l'expiration au TTL par défaut même si expiresAt est lointain", () => {
    const v = reasonsOf({
      createdAt: new Date(NOW.getTime() - 31 * 60_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 24 * 3600_000).toISOString(),
    });
    expect(v.reasons.join()).toMatch(/INTENT_EXPIRE/);
  });

  it("accepte un intent juste avant son expiration", () => {
    expect(reasonsOf({ expiresAt: new Date(NOW.getTime() + 1000).toISOString() }).allowed).toBe(true);
  });

  it("rejette un intent dont l'id est déjà dans le ledger (même s'il avait été rejeté)", () => {
    const v = evaluate(intent({ id: "dup" }), portfolio(), snapshot(), P, NOW, [ledgerEntry({ intentId: "dup", decision: "REJECTED", mint: MINT_C })]);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join()).toMatch(/INTENT_DUPLIQUE/);
  });
});

describe("Risk Engine — fenêtre horaire (America/Moncton)", () => {
  it("rejette à 4h30 heure locale (07:30 UTC en heure avancée)", () => {
    const now = new Date("2026-09-24T07:30:00Z");
    expect(hourInZone(now, "America/Moncton")).toBe(4);
    const v = evaluate(intent({ createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() }), portfolio(), snapshot({ fetchedAt: now.toISOString() }), P, now);
    expect(v.reasons.join()).toMatch(/FENETRE_INTERDITE: 4h/);
  });

  it("accepte à 1h30 heure locale même si l'heure UTC (4h) est dans la fenêtre", () => {
    const now = new Date("2026-09-24T04:30:00Z");
    expect(hourInZone(now, "America/Moncton")).toBe(1);
    const v = evaluate(
      intent({ createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() }),
      portfolio(),
      snapshot({ createdAt: new Date(now.getTime() - 3600_000).toISOString(), fetchedAt: now.toISOString() }),
      P,
      now,
    );
    expect(v.allowed).toBe(true);
  });

  it("gère l'heure normale (hiver, UTC-4) : 06:30 UTC = 2h30 → rejeté, 05:59 UTC = 1h59 → accepté", () => {
    const winter = new Date("2026-12-15T06:30:00Z");
    expect(hourInZone(winter, "America/Moncton")).toBe(2);
    const mk = (now: Date) =>
      evaluate(
        intent({ createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() }),
        portfolio(),
        snapshot({ createdAt: new Date(now.getTime() - 3600_000).toISOString(), fetchedAt: now.toISOString() }),
        P,
        now,
      );
    expect(mk(winter).reasons.join()).toMatch(/FENETRE_INTERDITE/);
    expect(mk(new Date("2026-12-15T05:59:00Z")).allowed).toBe(true);
  });

  it("borne haute exclusive : 8h00 local est autorisé", () => {
    const now = new Date("2026-09-24T11:00:00Z"); // 08:00 ADT
    expect(hourInZone(now, "America/Moncton")).toBe(8);
    const v = evaluate(
      intent({ createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString() }),
      portfolio(),
      snapshot({ createdAt: new Date(now.getTime() - 3600_000).toISOString(), fetchedAt: now.toISOString() }),
      P,
      now,
    );
    expect(v.allowed).toBe(true);
  });

  it("clés jour/semaine calculées dans le fuseau", () => {
    const late = new Date("2026-09-25T02:30:00Z"); // 24 sept 23:30 à Moncton
    expect(dateKey(late, "America/Moncton")).toBe("2026-09-24");
    expect(dateKey(late, "UTC")).toBe("2026-09-25");
    expect(isoWeekKey(NOW, "America/Moncton")).toBe("2026-W39");
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"), "UTC")).toBe("2026-W53");
  });
});

describe("Risk Engine — limites de portefeuille", () => {
  it("rejette une taille au-dessus du max par position", () => {
    expect(reasonsOf({ sizeCad: 51 }).reasons.join()).toMatch(/TAILLE_MAX/);
  });

  it("rejette une taille ≤ 0 ou sous le minimum", () => {
    expect(reasonsOf({ sizeCad: 0 }).reasons.join()).toMatch(/TAILLE_INVALIDE/);
    expect(reasonsOf({ sizeCad: 5 }).reasons.join()).toMatch(/TAILLE_MIN/);
  });

  it("rejette quand le nombre max de positions est atteint (mais accepte le renfort d'une position existante)", () => {
    const pos = (m: string) => ({ mint: m, qty: 1, costCad: 40, openedAt: NOW.toISOString(), markCad: 40 });
    const pf = portfolio({ positions: [MINT_B, MINT_C, MINT_D, MINT_E].map(pos), cashCad: 540 });
    expect(reasonsOf({}, pf).reasons.join()).toMatch(/POSITIONS_MAX/);
    const pf2 = portfolio({ positions: [MINT_A, MINT_C, MINT_D, MINT_E].map(pos), cashCad: 540 });
    // renfort de MINT_A : 40 déjà investis + 10 = 50 → OK
    expect(reasonsOf({ sizeCad: 10 }, pf2).allowed).toBe(true);
    expect(reasonsOf({ sizeCad: 11 }, pf2).reasons.join()).toMatch(/TAILLE_MAX/);
  });

  it("rejette quand l'exposition dépasserait le plafond", () => {
    const pos = (m: string) => ({ mint: m, qty: 1, costCad: 50, openedAt: NOW.toISOString(), markCad: 60 });
    const pf = portfolio({ positions: [MINT_B, MINT_C, MINT_D].map(pos), cashCad: 550 }); // exposition marquée 180
    expect(reasonsOf({ sizeCad: 30 }, pf).reasons.join()).toMatch(/EXPOSITION_MAX/);
    expect(reasonsOf({ sizeCad: 20 }, pf).allowed).toBe(true);
  });

  it("rejette quand la taille dépasse le cash disponible", () => {
    const v = reasonsOf({ sizeCad: 40 }, portfolio({ cashCad: 30 }));
    expect(v.reasons.join()).toMatch(/CASH_INSUFFISANT: 40 CAD > cash disponible 30/);
  });

  it("réduit la taille aux plafonds quand allowSizeAdjustment est activé", () => {
    const pol = policy({ allowSizeAdjustment: true });
    const v = reasonsOf({ sizeCad: 80 }, portfolio(), snapshot(), pol);
    expect(v).toEqual({ allowed: true, reasons: [], adjustedSizeCad: 50 });
    // mais pas sous le minimum d'ordre
    const v2 = reasonsOf({ sizeCad: 40 }, portfolio({ cashCad: 5 }), snapshot(), pol);
    expect(v2.allowed).toBe(false);
  });

  it("rejette une vente sans position", () => {
    const v = reasonsOf({ kind: "SELL", sizeCad: 40 });
    expect(v.reasons.join()).toMatch(/VENTE_SANS_POSITION/);
  });
});

describe("Risk Engine — pertes et drawdown", () => {
  it("bloque après la perte quotidienne max", () => {
    const pf = portfolio({ dailyPnlByDate: { "2026-09-24": -70 } });
    expect(reasonsOf({}, pf).reasons.join()).toMatch(/PERTE_QUOTIDIENNE/);
    expect(reasonsOf({}, portfolio({ dailyPnlByDate: { "2026-09-24": -69.99 } })).allowed).toBe(true);
  });

  it("bloque après la perte hebdomadaire max", () => {
    const pf = portfolio({ weeklyPnlByWeek: { "2026-W39": -140 } });
    expect(reasonsOf({}, pf).reasons.join()).toMatch(/PERTE_HEBDO/);
  });

  it("bloque au-delà du drawdown max depuis le pic (35 % de 700 = 245 CAD)", () => {
    const pf = portfolio({ cashCad: 455, peakEquityCad: 700 });
    expect(reasonsOf({}, pf).reasons.join()).toMatch(/DRAWDOWN_MAX/);
    expect(reasonsOf({}, portfolio({ cashCad: 456, peakEquityCad: 700 })).allowed).toBe(true);
  });

  it("le drawdown tient compte des positions marquées au marché", () => {
    // au coût : 400 + 100 = 500 (drawdown 200, OK) ; au marché : 400 + 10 = 410 (drawdown 290 ≥ 245 → rejet)
    const pf = portfolio({ cashCad: 400, peakEquityCad: 700, positions: [{ mint: MINT_B, qty: 1, costCad: 100, openedAt: NOW.toISOString(), markCad: 10 }] });
    expect(reasonsOf({}, pf).reasons.join()).toMatch(/DRAWDOWN_MAX/);
    const atCost = portfolio({ cashCad: 400, peakEquityCad: 700, positions: [{ mint: MINT_B, qty: 1, costCad: 100, openedAt: NOW.toISOString(), markCad: 100 }] });
    expect(reasonsOf({}, atCost).allowed).toBe(true);
    // sans marque, l'état est inconnu : aucun nouvel achat
    const unmarked = portfolio({ cashCad: 400, peakEquityCad: 700, positions: [{ mint: MINT_B, qty: 1, costCad: 100, openedAt: NOW.toISOString() }] });
    expect(reasonsOf({}, unmarked).reasons.join()).toMatch(/MARQUE_INCONNUE/);
  });
});

describe("Risk Engine — slippage, cadence, qualité du token", () => {
  it("rejette un slippage supérieur au max ou nul", () => {
    expect(reasonsOf({ maxSlippageBps: 301 }).reasons.join()).toMatch(/SLIPPAGE_MAX/);
    expect(reasonsOf({ maxSlippageBps: 0 }).reasons.join()).toMatch(/SLIPPAGE_INVALIDE/);
    expect(reasonsOf({ maxSlippageBps: 300 }).allowed).toBe(true);
  });

  it("rejette un second ordre sur le même mint en moins d'une heure (PENDING compte aussi)", () => {
    const recent = ledgerEntry({ intentId: "old-a", mint: MINT_A, decision: "PENDING", ts: new Date(NOW.getTime() - 59 * 60_000).toISOString() });
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, [recent]).reasons.join()).toMatch(/CADENCE_MINT/);
    const old = ledgerEntry({ intentId: "old-a", mint: MINT_A, ts: new Date(NOW.getTime() - 61 * 60_000).toISOString() });
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, [old]).allowed).toBe(true);
    const rejectedRecent = ledgerEntry({ intentId: "old-a", mint: MINT_A, decision: "REJECTED", ts: new Date(NOW.getTime() - 60_000).toISOString() });
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, [rejectedRecent]).allowed).toBe(true);
  });

  it("rejette sans instantané, ou avec un instantané d'un autre mint, ou périmé", () => {
    expect(reasonsOf({}, portfolio(), null as unknown as ReturnType<typeof snapshot>).reasons.join()).toMatch(/SNAPSHOT_MANQUANT/);
    expect(reasonsOf({}, portfolio(), snapshot({ mint: MINT_B })).reasons.join()).toMatch(/SNAPSHOT_INCOHERENT/);
    expect(reasonsOf({}, portfolio(), snapshot({ fetchedAt: new Date(NOW.getTime() - 16 * 60_000).toISOString() })).reasons.join()).toMatch(/SNAPSHOT_PERIME/);
  });

  it("rejette une liquidité insuffisante", () => {
    expect(reasonsOf({}, portfolio(), snapshot({ liquidityUsd: 19_999 })).reasons.join()).toMatch(/LIQUIDITE_MIN/);
    expect(reasonsOf({}, portfolio(), snapshot({ liquidityUsd: 20_000 })).allowed).toBe(true);
  });

  it("rejette un token trop jeune", () => {
    expect(reasonsOf({}, portfolio(), snapshot({ createdAt: new Date(NOW.getTime() - 9 * 60_000).toISOString() })).reasons.join()).toMatch(/AGE_MIN/);
    expect(reasonsOf({}, portfolio(), snapshot({ createdAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() })).allowed).toBe(true);
  });

  it("rejette les autorités mint/freeze non révoquées (sauf si la politique l'autorise)", () => {
    expect(reasonsOf({}, portfolio(), snapshot({ mintAuthority: "Auth111" })).reasons.join()).toMatch(/MINT_AUTHORITY/);
    expect(reasonsOf({}, portfolio(), snapshot({ freezeAuthority: "Auth111" })).reasons.join()).toMatch(/FREEZE_AUTHORITY/);
    expect(reasonsOf({}, portfolio(), snapshot({ mintAuthority: "Auth111" }), policy({ allowMintAuthority: true })).allowed).toBe(true);
  });

  it("rejette une concentration top10 trop élevée", () => {
    expect(reasonsOf({}, portfolio(), snapshot({ top10Pct: 40.1 })).reasons.join()).toMatch(/TOP10_MAX/);
    expect(reasonsOf({}, portfolio(), snapshot({ top10Pct: 40 })).allowed).toBe(true);
  });

  it("un SELL n'est pas bloqué par la qualité du token (on doit pouvoir sortir)", () => {
    const pf = portfolio({ positions: [{ mint: MINT_A, qty: 1000, costCad: 40, openedAt: NOW.toISOString() }] });
    const v = reasonsOf({ kind: "SELL", sizeCad: 40 }, pf, snapshot({ liquidityUsd: 100, mintAuthority: "x", top10Pct: 99 }));
    expect(v.allowed).toBe(true);
  });

  it("accumule toutes les raisons (pas seulement la première)", () => {
    const v = reasonsOf({ sizeCad: 60, maxSlippageBps: 500 }, portfolio(), snapshot({ liquidityUsd: 1 }));
    expect(v.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("Politique — validation et chargement", () => {
  it("valide la politique d'exemple et détecte les incohérences", () => {
    expect(policyProblems(P)).toEqual([]);
    expect(() => validatePolicy(policy({ maxPositionSizeCad: 500 }))).toThrow(/maxPositionSizeCad > maxExposureCad/);
    expect(policyProblems(policy({ forbiddenWindow: { startHour: 2, endHour: 8, timeZone: "Mars/Olympus" } })).join()).toMatch(/timeZone invalide/);
    expect(policyProblems({ ...P, allowMintAuthority: "non" } as unknown as RiskPolicy).join()).toMatch(/booléen/);
  });

  it("refuse de charger une politique située dans le dépôt", () => {
    const inRepo = path.join(REPO_ROOT, "lab", "risk", "policy.example.json");
    expect(() => loadPolicy(inRepo, { repoRoot: REPO_ROOT, home: os.tmpdir(), env: {} })).toThrow(/jamais être lue depuis le dépôt/);
    // même désignée explicitement via RISK_POLICY_PATH
    expect(() => loadPolicy(inRepo, { repoRoot: REPO_ROOT, home: os.tmpdir(), env: { RISK_POLICY_PATH: inRepo } })).toThrow(/dépôt/);
  });

  it("charge une politique sous ~/.crypto-lab ou via RISK_POLICY_PATH hors dépôt, refuse ailleurs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
    fs.mkdirSync(path.join(home, ".crypto-lab"));
    const local = path.join(home, ".crypto-lab", "risk.policy.json");
    fs.writeFileSync(local, JSON.stringify(P));
    expect(loadPolicy(local, { repoRoot: REPO_ROOT, home, env: {} }).maxPositionSizeCad).toBe(50);
    expect(resolvePolicyPath({ home, env: {} })).toBe(local);

    const elsewhere = path.join(home, "autre.json");
    fs.writeFileSync(elsewhere, JSON.stringify(P));
    expect(() => loadPolicy(elsewhere, { repoRoot: REPO_ROOT, home, env: {} })).toThrow(/RISK_POLICY_PATH/);
    expect(loadPolicy(elsewhere, { repoRoot: REPO_ROOT, home, env: { RISK_POLICY_PATH: elsewhere } }).version).toBe(2);
    expect(resolvePolicyPath({ home, env: { RISK_POLICY_PATH: elsewhere } })).toBe(elsewhere);

    fs.writeFileSync(local, "{ pas du json");
    expect(() => loadPolicy(local, { repoRoot: REPO_ROOT, home, env: {} })).toThrow(/JSON invalide/);
    fs.writeFileSync(local, JSON.stringify({ ...P, maxDrawdownPct: 500 }));
    expect(() => loadPolicy(local, { repoRoot: REPO_ROOT, home, env: {} })).toThrow(/maxDrawdownPct/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Politique v2 (chantier 6) : corrélation, série de pertes, budget d'erreurs, âge du signal — reduce-only préservé
// ---------------------------------------------------------------------------
describe("Politique v2 — validation", () => {
  it("la politique d'exemple est en version 2 avec les quatre champs v2 validés", () => {
    expect(P.version).toBe(2);
    expect(policyProblems(P)).toEqual([]);
    expect(policyProblems({ ...P, maxCorrelatedPositions: undefined }).join()).toMatch(/maxCorrelatedPositions doit être un nombre fini/);
    expect(policyProblems({ ...P, maxConsecutiveLosses: 0 }).join()).toMatch(/maxConsecutiveLosses doit être ≥ 1/);
    expect(policyProblems({ ...P, executionErrorBudget: 1.5 }).join()).toMatch(/executionErrorBudget doit être entier/);
    expect(policyProblems({ ...P, maxSignalAgeMinutes: -1 }).join()).toMatch(/maxSignalAgeMinutes doit être ≥ 0/);
    expect(policyProblems({ ...P, maxCorrelatedPositions: 5 }).join()).toMatch(/maxCorrelatedPositions > maxOpenPositions/);
    expect(policyProblems({ ...P, version: 3 }).join()).toMatch(/version doit être 1 ou 2/);
  });

  it("une politique v1 sans champs v2 reste valide et n'applique aucune règle v2", () => {
    const v1 = { ...P, version: 1 } as Record<string, unknown>;
    for (const f of ["maxCorrelatedPositions", "maxConsecutiveLosses", "executionErrorBudget", "maxSignalAgeMinutes"]) delete v1[f];
    expect(policyProblems(v1)).toEqual([]);
    const noSignal = intent();
    delete noSignal.signalTs;
    expect(evaluate(noSignal, portfolio(), snapshot(), v1 as unknown as RiskPolicy, NOW).allowed).toBe(true);
  });
});

describe("Politique v2 — âge du signal", () => {
  it("rejette un BUY dont le signal est plus vieux que maxSignalAgeMinutes", () => {
    const v = reasonsOf({ signalTs: new Date(NOW.getTime() - 21 * 60_000).toISOString() });
    expect(v.allowed).toBe(false);
    expect(v.reasons.join()).toMatch(/SIGNAL_PERIME/);
    expect(reasonsOf({ signalTs: new Date(NOW.getTime() - 20 * 60_000).toISOString() }).allowed).toBe(true);
  });

  it("rejette un BUY sans signalTs, avec signalTs sans fuseau, ou signalTs dans le futur", () => {
    const missing = intent();
    delete missing.signalTs;
    expect(evaluate(missing, portfolio(), snapshot(), P, NOW).reasons.join()).toMatch(/SIGNAL_TS_MANQUANT/);
    expect(reasonsOf({ signalTs: "2026-09-24T14:50:00" }).reasons.join()).toMatch(/DATE_INVALIDE: signalTs/);
    expect(reasonsOf({ signalTs: new Date(NOW.getTime() + 6 * 60_000).toISOString() }).reasons.join()).toMatch(/SIGNAL_FUTUR/);
  });

  it("un SELL n'est jamais bloqué par l'âge du signal (reduce-only)", () => {
    const pf = portfolio({ positions: [{ mint: MINT_A, qty: 1000, costCad: 40, openedAt: NOW.toISOString() }] });
    const stale = intent({ kind: "SELL", sizeCad: 40 });
    delete stale.signalTs;
    expect(evaluate(stale, pf, snapshot(), P, NOW).allowed).toBe(true);
    expect(reasonsOf({ kind: "SELL", sizeCad: 40, signalTs: new Date(NOW.getTime() - 3600_000).toISOString() }, pf).allowed).toBe(true);
  });
});

describe("Politique v2 — série de pertes", () => {
  const sellLoss = (id: string, minutesAgo: number, pnlCad: number, mint = MINT_B) =>
    ledgerEntry({ intentId: id, mint, kind: "SELL", decision: "PAPER", pnlCad, ts: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString() });

  it("bloque les achats après 3 pertes consécutives (dernière < 24 h)", () => {
    const ledger = [sellLoss("l1", 300, -5), sellLoss("l2", 200, -8), sellLoss("l3", 100, -2)];
    const v = evaluate(intent(), portfolio(), snapshot(), P, NOW, ledger);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join()).toMatch(/SERIE_DE_PERTES: 3 pertes consécutives/);
    expect(consecutiveLosses(ledger)).toEqual({ count: 3, lastLossTs: ledger[2]!.ts });
  });

  it("deux pertes seulement, ou un gain intercalé, ne bloquent pas", () => {
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, [sellLoss("l1", 300, -5), sellLoss("l2", 100, -8)]).allowed).toBe(true);
    const withWin = [sellLoss("l1", 400, -5), sellLoss("l2", 300, -8), sellLoss("w", 200, 3), sellLoss("l3", 100, -2)];
    expect(consecutiveLosses(withWin).count).toBe(1);
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, withWin).allowed).toBe(true);
    // l'ordre des lignes dans le tableau n'a pas d'importance : c'est le ts qui compte
    expect(consecutiveLosses([withWin[3]!, withWin[0]!, withWin[2]!, withWin[1]!]).count).toBe(1);
  });

  it("le blocage expire 24 h après la dernière perte", () => {
    const ledger = [sellLoss("l1", 3000, -5), sellLoss("l2", 2000, -8), sellLoss("l3", 24 * 60 + 1, -2)];
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, ledger).allowed).toBe(true);
    const ledger2 = [sellLoss("l1", 3000, -5), sellLoss("l2", 2000, -8), sellLoss("l3", 24 * 60 - 1, -2)];
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, ledger2).reasons.join()).toMatch(/SERIE_DE_PERTES/);
  });

  it("les ventes REJECTED/FAILED et les achats ne comptent pas dans la série ; les SELL restent possibles pendant le blocage", () => {
    const ledger = [sellLoss("l1", 300, -5), sellLoss("l2", 200, -8), { ...sellLoss("r", 150, -50), decision: "REJECTED" as const }, ledgerEntry({ intentId: "b", kind: "BUY", ts: new Date(NOW.getTime() - 120 * 60_000).toISOString() })];
    expect(consecutiveLosses(ledger).count).toBe(2);
    const blocked = [...ledger, sellLoss("l3", 100, -2)];
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, blocked).reasons.join()).toMatch(/SERIE_DE_PERTES/);
    const pf = portfolio({ positions: [{ mint: MINT_A, qty: 1000, costCad: 40, openedAt: NOW.toISOString() }] });
    expect(evaluate(intent({ kind: "SELL", sizeCad: 40 }), pf, snapshot(), P, NOW, blocked).allowed).toBe(true);
  });
});

describe("Politique v2 — budget d'erreurs d'exécution", () => {
  const failed = (id: string, minutesAgo: number) =>
    ledgerEntry({ intentId: id, decision: "FAILED", reasons: ["EXECUTION: boom"], fill: undefined, fees: undefined, ts: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString() });

  it("bloque les achats après 3 FAILED en 24 h, pas après 2", () => {
    const three = [failed("f1", 600), failed("f2", 300), failed("f3", 10)];
    const v = evaluate(intent(), portfolio(), snapshot(), P, NOW, three);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join()).toMatch(/BUDGET_ERREURS: 3 échec/);
    expect(failedExecutionsWithin(three, NOW)).toBe(3);
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, three.slice(1)).allowed).toBe(true);
  });

  it("les FAILED de plus de 24 h ne comptent plus ; les SELL passent malgré le budget épuisé", () => {
    const old = [failed("f1", 25 * 60), failed("f2", 300), failed("f3", 10)];
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, old).allowed).toBe(true);
    const three = [failed("f1", 600), failed("f2", 300), failed("f3", 10)];
    const pf = portfolio({ positions: [{ mint: MINT_A, qty: 1000, costCad: 40, openedAt: NOW.toISOString() }] });
    expect(evaluate(intent({ kind: "SELL", sizeCad: 40 }), pf, snapshot(), P, NOW, three).allowed).toBe(true);
  });
});

describe("Politique v2 — corrélation entre positions", () => {
  const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const buyFill = (mint: string, tags: { narrativeTag?: string; sourceWallet?: string }, minutesAgo = 120, costCad = 40) => ({
    ...ledgerEntry({ intentId: `buy-${mint.slice(0, 4)}`, mint, kind: "BUY", decision: "PAPER", ts: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), sizeCad: costCad }),
    ...tags,
  });
  const pos = (mint: string, costCad = 40) => ({ mint, qty: 1, costCad, openedAt: NOW.toISOString(), markCad: costCad });

  it("2 positions déjà ouvertes sur le même narratif → 3e refusée (CORRELATION_NARRATIF) ; narratif différent accepté", () => {
    const ledger = [buyFill(MINT_B, { narrativeTag: "AI-Agents" }), buyFill(MINT_C, { narrativeTag: " ai-agents " })];
    const pf = portfolio({ positions: [pos(MINT_B), pos(MINT_C)], cashCad: 620 });
    const v = evaluate(intent({ narrativeTag: "ai-agents", sizeCad: 10 }), pf, snapshot(), P, NOW, ledger);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join()).toMatch(/CORRELATION_NARRATIF: 2 position\(s\) déjà sur « ai-agents »/);
    expect(evaluate(intent({ narrativeTag: "dog-coins", sizeCad: 10 }), pf, snapshot(), P, NOW, ledger).allowed).toBe(true);
    expect(positionTags(MINT_C, ledger)).toEqual({ narrativeTag: "ai-agents", sourceWallet: null });
  });

  it("exposition cumulée par narratif plafonnée à maxExposureCad / 2 (100 $) même avec une seule position corrélée", () => {
    const ledger = [buyFill(MINT_B, { narrativeTag: "ai-agents" }, 120, 50)];
    const pf = portfolio({ positions: [pos(MINT_B, 50)], cashCad: 650 });
    // 50 déjà + 50 demandés = 100 → OK ; + 50,01 → refus
    expect(evaluate(intent({ narrativeTag: "ai-agents", sizeCad: 50 }), pf, snapshot(), P, NOW, ledger).allowed).toBe(true);
    const marked = portfolio({ positions: [{ ...pos(MINT_B, 50), markCad: 60 }], cashCad: 650 }); // marque 60 → max(coût, marque) = 60
    const v = evaluate(intent({ narrativeTag: "ai-agents", sizeCad: 50 }), marked, snapshot(), P, NOW, ledger);
    expect(v.reasons.join()).toMatch(/EXPOSITION_NARRATIF: 60 \+ 50 CAD sur « ai-agents » > 100/);
  });

  it("même wallet source : 2 positions max et exposition ≤ 100 $ (CORRELATION_WALLET / EXPOSITION_WALLET)", () => {
    const ledger = [buyFill(MINT_B, { sourceWallet: WALLET }), buyFill(MINT_C, { sourceWallet: WALLET })];
    const pf = portfolio({ positions: [pos(MINT_B), pos(MINT_C)], cashCad: 620 });
    const v = evaluate(intent({ sourceWallet: WALLET, sizeCad: 10 }), pf, snapshot(), P, NOW, ledger);
    expect(v.reasons.join()).toMatch(/CORRELATION_WALLET/);
    const one = [buyFill(MINT_B, { sourceWallet: WALLET }, 120, 50)];
    const pf1 = portfolio({ positions: [pos(MINT_B, 50)], cashCad: 650 });
    const v2 = evaluate(intent({ sourceWallet: WALLET, sizeCad: 50 }), pf1, snapshot({ liquidityUsd: 50_000 }), policy({ allowSizeAdjustment: false }), NOW, one);
    expect(v2.allowed).toBe(true);
    expect(evaluate(intent({ sourceWallet: WALLET, sizeCad: 50 }), portfolio({ positions: [pos(MINT_B, 51)], cashCad: 649 }), snapshot(), P, NOW, [buyFill(MINT_B, { sourceWallet: WALLET }, 120, 51)]).reasons.join()).toMatch(/EXPOSITION_WALLET/);
  });

  it("sans étiquette dans l'intent ou dans le ledger : aucune corrélation possible (limite documentée) ; sourceWallet mal formé → rejet", () => {
    const ledger = [buyFill(MINT_B, {}), buyFill(MINT_C, {})];
    const pf = portfolio({ positions: [pos(MINT_B), pos(MINT_C)], cashCad: 620 });
    expect(evaluate(intent({ narrativeTag: "ai-agents", sizeCad: 10 }), pf, snapshot(), P, NOW, ledger).allowed).toBe(true);
    expect(evaluate(intent({ sizeCad: 10 }), pf, snapshot(), P, NOW, [buyFill(MINT_B, { narrativeTag: "x" }), buyFill(MINT_C, { narrativeTag: "x" })]).allowed).toBe(true);
    expect(reasonsOf({ sourceWallet: "pas-un-wallet" }).reasons.join()).toMatch(/WALLET_INVALIDE/);
    expect(reasonsOf({ narrativeTag: 42 as unknown as string }).reasons.join()).toMatch(/CHAMP_INVALIDE: narrativeTag/);
  });

  it("le renfort d'une position existante compte sa propre exposition mais pas comme position corrélée supplémentaire", () => {
    const ledger = [buyFill(MINT_A, { narrativeTag: "ai-agents" }, 120, 40), buyFill(MINT_B, { narrativeTag: "ai-agents" }, 120, 40)];
    const pf = portfolio({ positions: [pos(MINT_A), pos(MINT_B)], cashCad: 620 });
    // MINT_A déjà ouverte (40) + MINT_B (40) + 10 = 90 ≤ 100 ; positions corrélées = MINT_B + celle-ci = 2 ≤ 2 → OK
    expect(evaluate(intent({ narrativeTag: "ai-agents", sizeCad: 10 }), pf, snapshot(), P, NOW, ledger).allowed).toBe(true);
    // avec 45 déjà sur chacune : 45 + 45 + 5 = 95 OK ; le plafond par mint (50) laisse 5 → 10 refusé par TAILLE_MAX, pas par corrélation
    const pf2 = portfolio({ positions: [pos(MINT_A, 45), pos(MINT_B, 45)], cashCad: 610 });
    const v = evaluate(intent({ narrativeTag: "ai-agents", sizeCad: 10 }), pf2, snapshot(), P, NOW, ledger);
    expect(v.reasons.join()).toMatch(/TAILLE_MAX/);
    expect(v.reasons.join()).not.toMatch(/CORRELATION/);
  });

  it("les SELL ignorent la corrélation (reduce-only)", () => {
    const ledger = [buyFill(MINT_A, { narrativeTag: "ai-agents" }), buyFill(MINT_B, { narrativeTag: "ai-agents" }), buyFill(MINT_C, { narrativeTag: "ai-agents" })];
    const pf = portfolio({ positions: [pos(MINT_A), pos(MINT_B), pos(MINT_C)], cashCad: 580 });
    expect(evaluate(intent({ kind: "SELL", sizeCad: 40, narrativeTag: "ai-agents" }), pf, snapshot(), P, NOW, ledger).allowed).toBe(true);
  });
});
