import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendJsonl, appendLedger, computeDrawdown, findOrphanPending, pnlByDay, pnlByWeek, readJsonl, readLedger, rebuildPortfolio } from "../lab/ledger/ledger.ts";
import * as ledgerMod from "../lab/ledger/ledger.ts";
import { appendHypothesis, readJournal, updateHypothesisResult, weeklyReport } from "../lab/journal/journal.ts";
import { emptyPortfolio } from "../lab/exec/paper.ts";
import type { HypothesisEntry, LedgerEntry } from "../lab/types.ts";
import { MINT_A, MINT_B, NOW, ledgerEntry } from "./execFixtures.ts";

const TZ = "America/Moncton";
let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});
const mkTmp = (): string => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")));

function scenario(): LedgerEntry[] {
  const t = (min: number): string => new Date(NOW.getTime() + min * 60_000).toISOString();
  return [
    ledgerEntry({ ts: t(0), intentId: "b1", mint: MINT_A, kind: "BUY", fill: { priceUsd: 0.001, fxCadPerUsd: 1.37, qty: 28_000, grossCad: 40, netCad: 39.4, slippageBps: 200 } }),
    ledgerEntry({ ts: t(1), intentId: "b2", mint: MINT_B, kind: "BUY", fill: { priceUsd: 0.01, fxCadPerUsd: 1.37, qty: 3_500, grossCad: 50, netCad: 49.2, slippageBps: 200 } }),
    ledgerEntry({ ts: t(2), intentId: "r1", mint: MINT_A, kind: "BUY", decision: "REJECTED", reasons: ["CADENCE_MINT: x"], fill: undefined, fees: undefined }),
    // vente totale de A avec gain de 20 (net 60 pour un coût 40)
    ledgerEntry({ ts: t(120), intentId: "s1", mint: MINT_A, kind: "SELL", fill: { priceUsd: 0.0016, fxCadPerUsd: 1.37, qty: 28_000, grossCad: 61, netCad: 60, slippageBps: 200 }, pnlCad: 20, equityAfterCad: 800 }),
    // vente de la moitié de B avec perte de 5 (net 20 pour un coût 25)
    ledgerEntry({ ts: t(24 * 60 + 5), intentId: "s2", mint: MINT_B, kind: "SELL", fill: { priceUsd: 0.006, fxCadPerUsd: 1.37, qty: 1_750, grossCad: 20.3, netCad: 20, slippageBps: 200 }, pnlCad: -5 }),
    // remplissage live : ignoré en paper
    ledgerEntry({ ts: t(24 * 60 + 6), intentId: "l1", mint: MINT_B, kind: "BUY", decision: "EXECUTED", mode: "live" }),
  ];
}

describe("Ledger — E/S JSONL", () => {
  it("append atomique puis relecture, fichier absent → []", () => {
    const dir = mkTmp();
    const file = path.join(dir, "sub", "trades.jsonl");
    expect(readLedger(file)).toEqual([]);
    appendLedger(file, ledgerEntry({ intentId: "a" }));
    appendLedger(file, ledgerEntry({ intentId: "b" }));
    const entries = readLedger(file);
    expect(entries.map((e) => e.intentId)).toEqual(["a", "b"]);
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("ligne malformée → exception explicite (le ledger doit rester intègre)", () => {
    const dir = mkTmp();
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, '{"ok":1}\n\n{oops\n');
    expect(() => readJsonl(file)).toThrow(/:3 ligne JSONL invalide/);
  });

  it("refuse une entrée contenant un saut de ligne et ignore les lignes vides", () => {
    const dir = mkTmp();
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, '{"a":1}\n\n\n');
    appendJsonl(file, { b: 2 });
    expect(readJsonl(file)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("Ledger — reconstruction du portefeuille", () => {
  it("rejoue achats et ventes : cash, positions, PnL réalisé, compteurs jour/semaine", () => {
    const pf = rebuildPortfolio(scenario(), { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(pf.cashCad).toBeCloseTo(700 - 40 - 50 + 60 + 20, 10);
    expect(pf.positions).toHaveLength(1);
    expect(pf.positions[0]!.mint).toBe(MINT_B);
    expect(pf.positions[0]!.qty).toBeCloseTo(1_750, 9);
    expect(pf.positions[0]!.costCad).toBeCloseTo(25, 9);
    expect(pf.realizedPnlCad).toBe(15);
    expect(pf.dailyPnlByDate).toEqual({ "2026-09-24": 20, "2026-09-25": -5 });
    expect(pf.weeklyPnlByWeek).toEqual({ "2026-W39": 15 });
  });

  it("ignore les entrées rejetées et celles d'un autre mode ; l'ordre chronologique est rétabli", () => {
    const shuffled = [...scenario()].reverse();
    const paper = rebuildPortfolio(shuffled, { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(paper.positions).toHaveLength(1);
    const live = rebuildPortfolio(shuffled, { initialCashCad: 700, mode: "live", timeZone: TZ });
    expect(live.positions.map((p) => p.mint)).toEqual([MINT_B]);
    expect(live.cashCad).toBe(660);
  });

  it("le ledger est rejouable : même entrées → même état (déterminisme)", () => {
    const a = rebuildPortfolio(scenario(), { initialCashCad: 700, mode: "paper", timeZone: TZ });
    const b = rebuildPortfolio(scenario(), { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(a).toEqual(b);
  });

  it("pic d'équité : prend l'équité journalisée si présente, et les marques courantes", () => {
    const pf = rebuildPortfolio(scenario(), { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(pf.peakEquityCad).toBe(800); // equityAfterCad de s1
    const marked = rebuildPortfolio(scenario(), { initialCashCad: 700, mode: "paper", timeZone: TZ, marksUsd: { [MINT_B]: 1 }, fxCadPerUsd: 1.37 });
    expect(marked.positions[0]!.markCad).toBeCloseTo(1_750 * 1.37, 6);
    expect(marked.peakEquityCad).toBeCloseTo(690 + 1_750 * 1.37, 6);
  });

  it("computeDrawdown depuis le pic", () => {
    const pf = { ...emptyPortfolio(700), cashCad: 500, peakEquityCad: 800 };
    const dd = computeDrawdown(pf);
    expect(dd).toEqual({ equityCad: 500, peakEquityCad: 800, drawdownCad: 300, drawdownPctOfPeak: 37.5 });
    expect(computeDrawdown({ ...emptyPortfolio(700), cashCad: 900 }).drawdownCad).toBe(0);
  });

  it("pnlByDay / pnlByWeek depuis le ledger, dans le fuseau", () => {
    const entries = scenario();
    expect(pnlByDay(entries, TZ)).toEqual({ "2026-09-24": 20, "2026-09-25": -5 });
    expect(pnlByWeek(entries, TZ)).toEqual({ "2026-W39": 15 });
    expect(pnlByDay(entries, TZ, "live")).toEqual({});
  });

  it("findOrphanPending ne renvoie que les intents dont la dernière entrée est PENDING", () => {
    const entries = [
      ledgerEntry({ intentId: "done", decision: "PENDING" }),
      ledgerEntry({ intentId: "done", decision: "PAPER" }),
      ledgerEntry({ intentId: "stuck", decision: "PENDING" }),
    ];
    expect(findOrphanPending(entries).map((e) => e.intentId)).toEqual(["stuck"]);
  });
});

describe("Journal d'hypothèses et rapport hebdomadaire", () => {
  const hyp = (o: Partial<HypothesisEntry>): HypothesisEntry => ({
    id: "h",
    createdAt: NOW.toISOString(),
    hypothesis: "test",
    signal: "sig",
    data: {},
    decision: "BUY",
    context: {},
    ...o,
  });

  it("append, lecture et mise à jour du résultat (réécriture atomique)", () => {
    const dir = mkTmp();
    const file = path.join(dir, "hypotheses.jsonl");
    appendHypothesis(file, hyp({ id: "h1" }));
    appendHypothesis(file, hyp({ id: "h2" }));
    expect(updateHypothesisResult(file, "h1", { result: "WIN", return: 0.2 }, NOW)).toBe(true);
    expect(updateHypothesisResult(file, "inconnu", { result: "WIN" }, NOW)).toBe(false);
    const j = readJournal(file);
    expect(j.map((e) => e.id)).toEqual(["h1", "h2"]);
    expect(j[0]).toMatchObject({ result: "WIN", return: 0.2, resolvedAt: NOW.toISOString() });
    expect(j[1]!.result).toBeUndefined();
    expect(() => appendHypothesis(file, hyp({ id: "" }))).toThrow(/requis/);
  });

  it("rapport : les quatre sections, contenu tiré du ledger et du journal", () => {
    const hyps = [
      hyp({ id: "w", signal: "volume-spike", return: 0.3, result: "WIN", resolvedAt: NOW.toISOString() }),
      hyp({ id: "l", signal: "early-overlap", return: -0.2, result: "LOSS", resolvedAt: NOW.toISOString() }),
      hyp({ id: "m", signal: "narrative", decision: "NO_ACTION", result: "MISSED", return: 0.8, hypothesis: "token X va pumper", resolvedAt: NOW.toISOString() }),
    ];
    const md = weeklyReport({ ledger: scenario(), hypotheses: hyps, weekKey: "2026-W39", timeZone: TZ });
    expect(md).toContain("# Rapport hebdomadaire — 2026-W39");
    for (const s of ["## WHAT WORKED", "## WHAT FAILED", "## WHAT WE MISSED", "## WHAT TO CHANGE"]) expect(md).toContain(s);
    expect(md).toMatch(/WHAT WORKED[\s\S]*`volume-spike`[\s\S]*Vente s1 sur .* \+20\.00 CAD/);
    expect(md).toMatch(/WHAT FAILED[\s\S]*`early-overlap`[\s\S]*Vente s2 .* -5\.00 CAD[\s\S]*CADENCE_MINT ×1/);
    expect(md).toMatch(/WHAT WE MISSED[\s\S]*token X va pumper — mouvement observé 80\.0 %/);
    expect(md).toContain("PnL réalisé : 15.00 CAD");
  });

  it("rapport : aucun changement de stratégie proposé quand n < 10 sur le signal", () => {
    const few = Array.from({ length: 9 }, (_, i) => hyp({ id: `f${i}`, signal: "weak", return: -0.5, resolvedAt: NOW.toISOString() }));
    const md = weeklyReport({ ledger: [], hypotheses: few, weekKey: "2026-W39", timeZone: TZ });
    expect(md).toMatch(/`weak` : n insuffisant \(9\/10\) — aucun changement de stratégie proposé/);
    expect(md).not.toMatch(/retirer le signal/);
  });

  it("rapport : propose un changement à partir de 10 observations (même si toutes ne sont pas de la semaine)", () => {
    const old = new Date("2026-08-01T12:00:00Z").toISOString();
    const many = Array.from({ length: 10 }, (_, i) => hyp({ id: `m${i}`, signal: "weak", return: -0.5, createdAt: old, resolvedAt: i === 0 ? NOW.toISOString() : old }));
    const good = Array.from({ length: 12 }, (_, i) => hyp({ id: `g${i}`, signal: "strong", return: 0.4, createdAt: old, resolvedAt: i === 0 ? NOW.toISOString() : old }));
    const md = weeklyReport({ ledger: [], hypotheses: [...many, ...good], weekKey: "2026-W39", timeZone: TZ });
    expect(md).toMatch(/`weak` : 0\.0 % de gagnants sur 10.*→ réduire le poids ou retirer le signal/);
    expect(md).toMatch(/`strong` : 100\.0 % de gagnants sur 12.*→ candidat à une pondération accrue/);
    const custom = weeklyReport({ ledger: [], hypotheses: many, weekKey: "2026-W39", timeZone: TZ, minObservations: 20 });
    expect(custom).toMatch(/n insuffisant \(10\/20\)/);
  });

  it("rapport : semaine vide → sections présentes avec mentions neutres", () => {
    const md = weeklyReport({ ledger: [], hypotheses: [], weekKey: "2026-W10", timeZone: TZ });
    expect(md).toContain("Rien de concluant cette semaine.");
    expect(md).toContain("Aucun échec enregistré.");
    expect(md).toContain("Rien à changer : pas de signal observé.");
  });
});

describe("Ledger local chaîné (C2)", () => {
  const { appendChainedLedger, readChainedLedger, loadOrCreateLedgerKey, exportLedger, LedgerChainError, computeEntryHmac } = ledgerMod;

  it("clé créée à la demande (64 hex, mode 600) puis relue à l'identique", () => {
    const dir = mkTmp();
    const keyPath = path.join(dir, "sub", "ledger.key");
    const k1 = loadOrCreateLedgerKey(keyPath);
    expect(k1).toHaveLength(32);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(loadOrCreateLedgerKey(keyPath).equals(k1)).toBe(true);
    fs.writeFileSync(keyPath, "pas-une-cle");
    expect(() => loadOrCreateLedgerKey(keyPath)).toThrow(LedgerChainError);
  });

  it("append chaîne seq/prevHmac/hmac ; la relecture vérifie la chaîne", () => {
    const dir = mkTmp();
    const key = loadOrCreateLedgerKey(path.join(dir, "k"));
    const file = path.join(dir, "trades.jsonl");
    const a = appendChainedLedger(file, key, ledgerEntry({ intentId: "a" }));
    const b = appendChainedLedger(file, key, ledgerEntry({ intentId: "b" }));
    expect(a.seq).toBe(1);
    expect(a.prevHmac).toBe("");
    expect(b.seq).toBe(2);
    expect(b.prevHmac).toBe(a.hmac);
    expect(b.hmac).toBe(computeEntryHmac(key, 2, a.hmac!, ledgerEntry({ intentId: "b" })));
    expect(readChainedLedger(file, key).map((e) => e.intentId)).toEqual(["a", "b"]);
    expect(readChainedLedger(path.join(dir, "absent.jsonl"), key)).toEqual([]);
  });

  it("toute altération est détectée : ligne modifiée, supprimée, insérée, réordonnée, autre clé", () => {
    const dir = mkTmp();
    const key = loadOrCreateLedgerKey(path.join(dir, "k"));
    const file = path.join(dir, "trades.jsonl");
    for (const id of ["a", "b", "c"]) appendChainedLedger(file, key, ledgerEntry({ intentId: id, pnlCad: -10, kind: "SELL" }));
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const tamper = (mutated: string[]): void => fs.writeFileSync(file, mutated.join("\n") + "\n");

    tamper([lines[0]!, lines[1]!.replace('"pnlCad":-10', '"pnlCad":1000'), lines[2]!]);
    expect(() => readChainedLedger(file, key)).toThrow(/HMAC invalide/);
    tamper([lines[0]!, lines[2]!]);
    expect(() => readChainedLedger(file, key)).toThrow(/séquence attendue 2/);
    tamper([lines[0]!, lines[1]!]); // suppression de la dernière ligne : indétectable par la chaîne seule…
    expect(readChainedLedger(file, key)).toHaveLength(2); // …mais le fichier vit sous ~/.crypto-lab, hors de portée du dépôt
    tamper([lines[1]!, lines[0]!, lines[2]!]);
    expect(() => readChainedLedger(file, key)).toThrow(/séquence/);
    tamper([lines[0]!, lines[1]!, lines[1]!, lines[2]!]);
    expect(() => readChainedLedger(file, key)).toThrow(/séquence/);
    tamper(lines);
    expect(() => readChainedLedger(file, loadOrCreateLedgerKey(path.join(dir, "k2")))).toThrow(/HMAC invalide/);
    // ligne forgée sans hmac
    tamper([...lines, JSON.stringify({ ...ledgerEntry({ intentId: "z" }), seq: 4, prevHmac: JSON.parse(lines[2]!).hmac })]);
    expect(() => readChainedLedger(file, key)).toThrow(/HMAC invalide/);
  });

  it("exportLedger copie le local vers le dépôt (écriture seule) ; les lignes exportées se relisent avec readLedger", () => {
    const dir = mkTmp();
    const key = loadOrCreateLedgerKey(path.join(dir, "k"));
    const local = path.join(dir, "home", "trades.jsonl");
    appendChainedLedger(local, key, ledgerEntry({ intentId: "a" }));
    const exported = path.join(dir, "repo", "ledger", "trades.jsonl");
    exportLedger(local, exported);
    expect(fs.readFileSync(exported, "utf8")).toBe(fs.readFileSync(local, "utf8"));
    expect(readLedger(exported)[0]!.hmac).toBeDefined();
  });

  it("rebuildPortfolio : une ligne importée du dépôt ne crée ni cash ni position, seules ses pertes comptent", () => {
    const imported = (o: Partial<LedgerEntry>): LedgerEntry => ledgerEntry({ origin: "repo-import", ...o });
    const entries = [
      imported({ intentId: "i-buy", mint: MINT_A, kind: "BUY" }),
      imported({ intentId: "i-gift", mint: MINT_B, kind: "SELL", pnlCad: 1000, fill: { priceUsd: 1, fxCadPerUsd: 1.37, qty: 1, grossCad: 1010, netCad: 1000, slippageBps: 0 } }),
      imported({ intentId: "i-loss", mint: MINT_B, kind: "SELL", pnlCad: -70, fill: { priceUsd: 1, fxCadPerUsd: 1.37, qty: 1, grossCad: 10, netCad: 9, slippageBps: 0 } }),
    ];
    const pf = rebuildPortfolio(entries, { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(pf.cashCad).toBe(700);
    expect(pf.positions).toEqual([]);
    expect(pf.realizedPnlCad).toBe(-70);
    expect(pf.dailyPnlByDate["2026-09-24"]).toBe(-70);
    expect(pf.peakEquityCad).toBe(700);
  });
});
