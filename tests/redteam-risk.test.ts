// RED TEAM — Risk Engine / exécuteur / kill switch.
// Hypothèse d'attaque : le plan analyse (Claude) peut écrire N'IMPORTE QUEL fichier du dépôt (intents/, data/, ledger/,
// lab/, package.json, KILL…) mais rien sous ~/.crypto-lab/. Hervé fait `git pull` puis lance l'exécuteur.
//
// Convention :
//   it(...)        → l'attaque ÉCHOUE (la défense tient) ; le test documente la défense.
//   it.fails(...)  → l'attaque RÉUSSIT ; le titre commence par « CORRECTIF ATTENDU » et décrit la propriété
//                    que le code DEVRAIT garantir. Le test passera (et devra repasser en `it`) une fois le correctif appliqué.
//   it("CORRIGÉ (xx) — …") → attaque initialement réussie, corrigée ; le test vérifie la propriété garantie.
// Rapport : docs/redteam-risk-engine.md. Ce fichier ne modifie rien sous lab/.

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate, loadPolicy, policyProblems, resolvePolicyPath } from "../lab/risk/engine.ts";
import { isKilled } from "../lab/exec/killswitch.ts";
import { runOnce } from "../lab/exec/executor.ts";
import { executeBuy } from "../lab/exec/paper.ts";
import { readLedger, rebuildPortfolio } from "../lab/ledger/ledger.ts";
import { sealManifest } from "../lab/exec/integrity.ts";
import type { LocalVerifier } from "../lab/exec/verify.ts";
import { USDC_MINT, type JupiterClient, type Signer } from "../lab/swap/jupiter.ts";
import type { Intent, LedgerEntry, PortfolioState, RiskPolicy, TokenSnapshot } from "../lab/types.ts";
import { MINT_A, MINT_B, MINT_C, MINT_D, MINT_E, NOW, REPO_ROOT, intent, ledgerEntry, makeSandbox, policy, portfolio, snapshot, writeIntent, writeSnapshot } from "./execFixtures.ts";

const P = policy();
const TZ = "America/Moncton";
const MARKET = { fxCadPerUsd: 1.37, solPriceUsd: 150, priorityFeeSol: 0.0005 };

type Sandbox = ReturnType<typeof makeSandbox>;
const opts = (s: Sandbox, extra: Partial<Parameters<typeof runOnce>[0]> = {}) => ({
  repoRoot: s.repoRoot,
  home: s.home,
  env: {},
  now: () => NOW,
  market: () => MARKET,
  log: () => {},
  ...extra,
});
const ledgerPathOf = (s: Sandbox): string => path.join(s.repoRoot, "ledger", "trades.jsonl");
const at = (d: Date, i: Partial<Intent> = {}): Intent =>
  intent({ createdAt: new Date(d.getTime() - 60_000).toISOString(), expiresAt: new Date(d.getTime() + 600_000).toISOString(), ...i });

/**
 * Marché « réel » factice : signataire, client Jupiter (devis au prix RÉEL du token et de SOL) et vérificateur local
 * (ce que le RPC et DexScreener répondraient vraiment). Le snapshot du dépôt n'a aucune influence sur ces trois-là.
 */
function fakeLive(realPriceUsd: number, decimals = 6, realSolUsd = MARKET.solPriceUsd, realToken: Partial<TokenSnapshot> = {}) {
  const calls: Array<{ kind: "quote" | "build" | "send"; detail: string }> = [];
  const jupiter: JupiterClient = {
    async getQuote(p) {
      calls.push({ kind: "quote", detail: `${p.inputMint.slice(0, 4)}->${p.outputMint.slice(0, 4)}:${p.amount}` });
      const solIn = Number(p.amount) / 1e9;
      let out: bigint;
      if (p.outputMint === USDC_MINT) out = BigInt(Math.round(solIn * realSolUsd * 1e6)); // cotation SOL→USDC
      else if (p.inputMint === "So11111111111111111111111111111111111111112") out = BigInt(Math.round(((solIn * realSolUsd) / realPriceUsd) * 10 ** decimals)); // BUY : tokens reçus
      else out = BigInt(Math.round(((Number(p.amount) / 10 ** decimals) * realPriceUsd / realSolUsd) * 1e9)); // SELL : lamports reçus
      return { inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: out, slippageBps: p.slippageBps, priceImpactPct: 0, raw: {} };
    },
    async buildSwapTx() {
      calls.push({ kind: "build", detail: "" });
      return { swapTransaction: "dHg=" };
    },
    async sendTransaction(tx) {
      calls.push({ kind: "send", detail: tx });
      return { txid: `SIG${calls.length}` };
    },
  };
  const signer: Signer = { publicKey: "PUB", sign: async (tx) => `signed(${tx})` };
  const verifier: LocalVerifier = {
    verify: async (mint, now) => snapshot({ ...realToken, mint, priceUsd: realPriceUsd, decimals, source: "local-verify", fetchedAt: now.toISOString() }),
  };
  return { jupiter, signer, verifier, calls };
}

function liveOpts(s: Sandbox, live: ReturnType<typeof fakeLive>, extra: Partial<Parameters<typeof runOnce>[0]> = {}) {
  fs.writeFileSync(path.join(s.home, ".crypto-lab", "keypair.json"), JSON.stringify(new Array(64).fill(1)));
  return opts(s, { env: { EXECUTION_MODE: "live" }, mode: "live" as const, jupiter: live.jupiter, signer: live.signer, verifier: live.verifier, ...extra });
}

// ---------------------------------------------------------------------------
// (1) Intents malformés ou astucieux
// ---------------------------------------------------------------------------
describe("(1) Intents malformés ou astucieux", () => {
  it("taille négative, nulle, NaN, Infinity, chaîne, tableau → rejet", () => {
    for (const bad of [-40, 0, -0, NaN, Infinity, -Infinity, "40", [40], { v: 40 }, null, true]) {
      const v = evaluate(intent({ sizeCad: bad as unknown as number }), portfolio(), snapshot(), P, NOW);
      expect(v.allowed, `sizeCad=${String(bad)}`).toBe(false);
    }
  });

  it("JSON ne peut pas transporter NaN/Infinity : le fichier est rejeté comme JSON invalide", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "nan.json", '{"id":"n","createdAt":"2026-09-24T14:59:00Z","kind":"BUY","mint":"' + MINT_A + '","sizeCad":NaN,"maxSlippageBps":200,"thesis":"t","signals":[],"invalidation":"i","expiresAt":"2026-09-24T15:20:00Z"}');
      const r = await runOnce(opts(sb));
      expect(r.processed[0]!.decision).toBe("REJECTED");
      expect(r.processed[0]!.reasons[0]).toMatch(/JSON_INVALIDE/);
    } finally {
      sb.cleanup();
    }
  });

  it("un champ `adjustedSizeCad` glissé dans l'intent est ignoré : la taille retenue vient du Risk Engine", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "adj.json", { ...intent({ id: "adj", sizeCad: 40 }), adjustedSizeCad: 5000, sizeCadAdjusted: 5000 });
      const r = await runOnce(opts(sb));
      expect(r.processed[0]!.decision).toBe("PAPER");
      const fill = readLedger(ledgerPathOf(sb)).at(-1)!;
      expect(fill.sizeCad).toBe(40);
      expect(fill.fill!.grossCad).toBe(40);
    } finally {
      sb.cleanup();
    }
  });

  it("clés JSON dupliquées : la dernière gagne, et elle est évaluée (pas de désynchronisation validation/exécution)", () => {
    const parsed = JSON.parse(`{"sizeCad":40,"sizeCad":5000}`) as { sizeCad: number };
    expect(parsed.sizeCad).toBe(5000);
    expect(evaluate(intent({ sizeCad: parsed.sizeCad }), portfolio(), snapshot(), P, NOW).reasons.join()).toMatch(/TAILLE_MAX/);
  });

  it("dates : createdAt > 5 min dans le futur → rejet ; expiresAt lointain borné au TTL ; createdAt ≤ 5 min dans le futur toléré (35 min de vie max)", () => {
    expect(evaluate(intent({ createdAt: new Date(NOW.getTime() + 6 * 60_000).toISOString() }), portfolio(), snapshot(), P, NOW).reasons.join()).toMatch(/INTENT_FUTUR/);
    const far = intent({ createdAt: new Date(NOW.getTime() - 31 * 60_000).toISOString(), expiresAt: "2999-01-01T00:00:00Z" });
    expect(evaluate(far, portfolio(), snapshot(), P, NOW).reasons.join()).toMatch(/INTENT_EXPIRE/);
    const slightlyFuture = intent({ createdAt: new Date(NOW.getTime() + 4 * 60_000).toISOString() });
    expect(evaluate(slightlyFuture, portfolio(), snapshot(), P, NOW).allowed).toBe(true);
  });

  it("CORRIGÉ (B1) — les dates sans fuseau (ni Z ni offset) et les formats non ISO doivent être rejetés", () => {
    // Date.parse interprète "2026-09-24T15:00:00" (sans Z) en heure LOCALE de la machine d'Hervé : l'intent change de
    // sens selon le fuseau du processus. "Sep 24 2026" et "24/09/2026" sont acceptés par Date.parse aussi.
    const local = intent({ createdAt: "2026-09-24T14:55:00", expiresAt: "2026-09-24T15:20:00" });
    const v = evaluate(local, portfolio(), snapshot(), P, NOW);
    expect(v.reasons.join()).toMatch(/DATE_INVALIDE/);
  });

  it("mint : casse différente = autre clé ; les deux passent la regex base58 et exigent chacun leur propre snapshot", () => {
    const variant = MINT_A.replace(/[a-z]/, (c) => c.toUpperCase());
    expect(variant).not.toBe(MINT_A);
    // avec le snapshot de MINT_A : incohérence → rejet
    expect(evaluate(intent({ mint: variant }), portfolio(), snapshot(), P, NOW).reasons.join()).toMatch(/SNAPSHOT_INCOHERENT/);
    // avec un snapshot forgé pour la variante : accepté — en live Jupiter n'aura pas de route (FAILED), en paper c'est une
    // « nouvelle position » fantôme. Voir (2) : la vérité on-chain doit être vérifiée localement.
    expect(evaluate(intent({ mint: variant }), portfolio(), snapshot({ mint: variant }), P, NOW).allowed).toBe(true);
  });

  it("mint : mint SOL natif, chaîne vide, traversée de répertoire → rejet par le Risk Engine", () => {
    expect(evaluate(intent({ mint: "" }), portfolio(), snapshot(), P, NOW).reasons.join()).toMatch(/CHAMP_MANQUANT: mint/);
    expect(evaluate(intent({ mint: "../../.crypto-lab/risk.policy" }), portfolio(), snapshot(), P, NOW).reasons.join()).toMatch(/MINT_INVALIDE/);
    // SOL natif : format valide, Jupiter refusera SOL→SOL ; paper l'accepterait (pas de perte réelle).
    expect(evaluate(intent({ mint: "So11111111111111111111111111111111111111112" }), portfolio(), snapshot({ mint: "So11111111111111111111111111111111111111112" }), P, NOW).allowed).toBe(true);
  });

  it("CORRIGÉ (B2) — l'exécuteur ne doit toucher au disque avec `intent.mint` qu'après validation (traversée de répertoire)", async () => {
    // loadSnapshot(intent.mint) est appelé AVANT evaluate() avec un mint non validé : data/tokens/<mint>.json est ouvert
    // avec un chemin relatif contrôlé par l'attaquant (../../../.crypto-lab/…). Aucune fuite via les raisons aujourd'hui,
    // mais c'est un accès disque hors de data/tokens/ piloté par l'attaquant.
    const sb = makeSandbox();
    try {
      const seen: string[] = [];
      const traversal = "../../home/.crypto-lab/risk.policy";
      writeIntent(sb.repoRoot, "t.json", intent({ id: "t", mint: traversal }));
      await runOnce(opts(sb, { loadSnapshot: (m) => (seen.push(m), null) }));
      expect(seen).not.toContain(traversal);
    } finally {
      sb.cleanup();
    }
  });

  it("SELL sans position, SELL en paper d'une position live (et inversement) → VENTE_SANS_POSITION", () => {
    expect(evaluate(intent({ kind: "SELL" }), portfolio(), snapshot(), P, NOW).reasons.join()).toMatch(/VENTE_SANS_POSITION/);
    const liveFill = ledgerEntry({ mint: MINT_A, mode: "live", decision: "EXECUTED" });
    const paperPf = rebuildPortfolio([liveFill], { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(evaluate(intent({ kind: "SELL" }), paperPf, snapshot(), P, NOW).reasons.join()).toMatch(/VENTE_SANS_POSITION/);
  });

  it("SELL : un notionnel énorme vend au plus la position (paper et live)", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "1-buy.json", intent({ id: "b" }));
      const later = new Date(NOW.getTime() + 61 * 60_000);
      await runOnce(opts(sb));
      writeSnapshot(sb.repoRoot, snapshot({ fetchedAt: later.toISOString() }));
      writeIntent(sb.repoRoot, "2-sell.json", at(later, { id: "s", kind: "SELL", sizeCad: 1e12 }));
      const r = await runOnce(opts(sb, { now: () => later }));
      expect(r.processed.map((p) => p.decision)).toEqual(["PAPER"]);
      const pf = rebuildPortfolio(readLedger(ledgerPathOf(sb)), { initialCashCad: 700, mode: "paper", timeZone: TZ });
      expect(pf.positions).toHaveLength(0);
      expect(pf.cashCad).toBeLessThan(700); // frais + slippage : jamais de cash créé
    } finally {
      sb.cleanup();
    }
  });

  it("intent avec id contenant un saut de ligne ou des caractères de contrôle : journalisé sans corrompre le JSONL", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "nl.json", intent({ id: "a\nb\r\n{\"decision\":\"EXECUTED\"}" }));
      const r = await runOnce(opts(sb));
      expect(r.error).toBeUndefined();
      const entries = readLedger(ledgerPathOf(sb)); // lèverait si une ligne était corrompue
      expect(entries).toHaveLength(2);
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) Données lues par l'exécuteur : data/tokens/<mint>.json est contrôlé par l'attaquant
// ---------------------------------------------------------------------------
describe("(2) Snapshots forgés (data/tokens est dans le dépôt)", () => {
  it("CORRIGÉ (C3) — un snapshot forgé (liquidité, autorités, âge, top10, fraîcheur) ne doit pas suffire à exécuter un achat LIVE", async () => {
    // Le token réel : freeze authority active, 100 $ de liquidité, créé il y a 30 s. Le snapshot committé dit le contraire.
    const sb = makeSandbox();
    try {
      const forged = snapshot({ liquidityUsd: 999_999, mintAuthority: null, freezeAuthority: null, top10Pct: 1, createdAt: "2020-01-01T00:00:00Z", fetchedAt: NOW.toISOString() });
      writeSnapshot(sb.repoRoot, forged);
      writeIntent(sb.repoRoot, "forged.json", intent({ id: "forged" }));
      const live = fakeLive(0.001, 6, MARKET.solPriceUsd, { freezeAuthority: "Frz1111111111111111111111111111111111111111", liquidityUsd: 100, createdAt: new Date(NOW.getTime() - 30_000).toISOString() });
      const r = await runOnce(liveOpts(sb, live));
      // L'exécuteur re-vérifie localement (RPC + DexScreener) et n'évalue QUE son propre instantané : refus.
      expect(r.processed[0]!.decision).toBe("REJECTED");
      expect(r.processed[0]!.reasons.join()).toMatch(/FREEZE_AUTHORITY/);
      expect(r.processed[0]!.reasons.join()).toMatch(/LIQUIDITE_MIN/);
      expect(r.processed[0]!.reasons.join()).toMatch(/AGE_MIN/);
      expect(live.calls.filter((c) => c.kind === "send")).toHaveLength(0);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (M3) — `fetchedAt` absent ne doit pas désactiver le contrôle de fraîcheur", () => {
    const stale = snapshot() as Partial<TokenSnapshot>;
    delete stale.fetchedAt; // fetchedAt est obligatoire dans le type unifié : on simule un fichier tronqué
    const v = evaluate(intent(), portfolio(), stale as TokenSnapshot, P, NOW);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join()).toMatch(/SNAPSHOT/);
  });

  it("fetchedAt est une simple chaîne : l'attaquant met « maintenant » et le contrôle de fraîcheur devient décoratif", () => {
    // Pas de correctif possible côté Risk Engine : la fraîcheur doit venir d'une lecture locale horodatée par l'exécuteur.
    const v = evaluate(intent(), portfolio(), snapshot({ fetchedAt: new Date(NOW.getTime() + 60_000).toISOString() }), P, NOW);
    expect(v.allowed).toBe(true);
  });

  it("CORRIGÉ (H2) — un prix de snapshot mensonger ne doit pas dicter la marque des positions (plafonds par mint/exposition/drawdown)", async () => {
    // Attaque : après un achat de 50 $ sur MINT_A, publier un snapshot à prix ≈ 0 → la position vaut ≈ 0 → « place » pour
    // 50 $ de plus sur le même mint chaque heure, et l'exposition « 200 $ » se remplit indéfiniment au coût réel.
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "1.json", intent({ id: "b1", sizeCad: 50 }));
      const live = fakeLive(0.001);
      await runOnce(liveOpts(sb, live));
      const t2 = new Date(NOW.getTime() + 61 * 60_000);
      writeSnapshot(sb.repoRoot, snapshot({ priceUsd: 1e-12, fetchedAt: t2.toISOString() })); // mensonge : prix réel toujours 0.001
      writeIntent(sb.repoRoot, "2.json", at(t2, { id: "b2", sizeCad: 49.99 })); // 50 exactement bute sur la marque résiduelle (4e-8 CAD)
      const r = await runOnce(liveOpts(sb, live, { now: () => t2 }));
      // Propriété attendue : 99,99 $ de coût réel sur un mint plafonné à 50 $ → refus.
      expect(r.processed[0]!.decision).toBe("REJECTED");
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (H2) — supprimer le snapshot d'une position ouverte ne doit pas la marquer « au coût » (drawdown aveugle)", () => {
    // Le README l'admet : « une position sans data/tokens/<mint>.json est marquée à son coût ». L'attaquant supprime les
    // fichiers → les pertes latentes disparaissent du drawdown. Propriété attendue : position sans marque récente = refus
    // de tout nouvel achat (ou marque au dernier prix connu du ledger local).
    // Position de 100 $ de coût dont le prix réel a été divisé par 1000 ; le fichier data/tokens/MINT_B.json a été supprimé.
    const bought = ledgerEntry({ mint: MINT_B, decision: "PAPER", fill: { priceUsd: 0.001, fxCadPerUsd: 1.37, qty: 70_000, grossCad: 100, netCad: 98.7, slippageBps: 0 } });
    const pf = rebuildPortfolio([bought], { initialCashCad: 700, mode: "paper", timeZone: TZ }); // aucune marque fournie
    expect(pf.positions[0]!.markCad).toBeUndefined();
    expect(pf.positions[0]!.costCad).toBe(100);
    const v = evaluate(intent(), pf, snapshot(), P, NOW);
    // Propriété attendue : sans marque récente, l'exécuteur refuse d'ouvrir une nouvelle position (état inconnu).
    expect(v.allowed).toBe(false);
  });

  it("CORRIGÉ (C3) — `decimals` forgé dans le snapshot ne doit pas servir à convertir les quantités en live", async () => {
    // decimals=0 au lieu de 6 → la quantité journalisée est 10^6 fois trop grande ; le SELL suivant enverra un montant
    // absurde (échec) ou, dans l'autre sens, un montant de poussière : la position devient invendable via l'exécuteur.
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot({ decimals: 0 }));
      writeIntent(sb.repoRoot, "d.json", intent({ id: "d", sizeCad: 40 }));
      const live = fakeLive(0.001, 6);
      const r = await runOnce(liveOpts(sb, live));
      const fill = readLedger(ledgerPathOf(sb)).at(-1)!;
      const expectedQty = (40 / 1.37 / 0.001); // ≈ 29 197 tokens
      if (r.processed[0]!.decision === "EXECUTED") expect(fill.fill!.qty).toBeCloseTo(expectedQty, -2);
      else expect(r.processed[0]!.decision).toBe("REJECTED");
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) Ledger dans le dépôt
// ---------------------------------------------------------------------------
describe("(3) Ledger falsifiable (ledger/trades.jsonl est dans le dépôt)", () => {
  function seedLossLedger(sb: Sandbox): void {
    // Journée déjà à -70 CAD réalisés : tout nouvel achat doit être bloqué.
    const sell = ledgerEntry({
      intentId: "loss-1",
      mint: MINT_B,
      kind: "SELL",
      decision: "PAPER",
      ts: new Date(NOW.getTime() - 2 * 3600_000).toISOString(),
      pnlCad: -70,
      fill: { priceUsd: 0.0005, fxCadPerUsd: 1.37, qty: 28_000, grossCad: 19, netCad: 18.7, slippageBps: 200 },
    });
    const buy = ledgerEntry({ intentId: "loss-0", mint: MINT_B, kind: "BUY", ts: new Date(NOW.getTime() - 3 * 3600_000).toISOString(), fill: { priceUsd: 0.001, fxCadPerUsd: 1.37, qty: 28_000, grossCad: 88.7, netCad: 88, slippageBps: 200 } });
    fs.mkdirSync(path.dirname(ledgerPathOf(sb)), { recursive: true });
    fs.writeFileSync(ledgerPathOf(sb), [buy, sell].map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  it("témoin : avec le ledger intact, la perte quotidienne bloque l'achat", async () => {
    const sb = makeSandbox();
    try {
      seedLossLedger(sb);
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "x.json", intent({ id: "x" }));
      const r = await runOnce(opts(sb));
      expect(r.processed[0]!.reasons.join()).toMatch(/PERTE_QUOTIDIENNE/);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (C2) — effacer les lignes de pertes du ledger du dépôt ne doit pas réinitialiser la perte quotidienne", async () => {
    const sb = makeSandbox();
    try {
      seedLossLedger(sb);
      // L'exécuteur a déjà tourné une fois avec ce ledger (il « connaît » la perte).
      await runOnce(opts(sb));
      // Attaque : commit qui retire la ligne SELL perdante (Hervé fait git pull).
      const kept = readLedger(ledgerPathOf(sb)).filter((e) => e.kind !== "SELL");
      fs.writeFileSync(ledgerPathOf(sb), kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "x.json", intent({ id: "x", mint: MINT_A }));
      const r = await runOnce(opts(sb));
      // Propriété attendue : l'exécuteur tient son propre ledger local (~/.crypto-lab/ledger/) et bloque quand même.
      expect(r.processed[0]!.decision).toBe("REJECTED");
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (C2) — une ligne SELL inventée (+1000 CAD) ne doit pas neutraliser pertes, drawdown et cash", async () => {
    const sb = makeSandbox();
    try {
      seedLossLedger(sb);
      const fake = ledgerEntry({
        intentId: "gift",
        mint: MINT_C,
        kind: "SELL",
        decision: "PAPER",
        ts: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
        pnlCad: 1000,
        fill: { priceUsd: 1, fxCadPerUsd: 1.37, qty: 1, grossCad: 1010, netCad: 1000, slippageBps: 0 },
        equityAfterCad: 1700,
      });
      fs.appendFileSync(ledgerPathOf(sb), JSON.stringify(fake) + "\n");
      const pf = rebuildPortfolio(readLedger(ledgerPathOf(sb)), { initialCashCad: 700, mode: "paper", timeZone: TZ });
      expect(pf.cashCad).toBeGreaterThan(1500); // cash fictif
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "x.json", intent({ id: "x" }));
      const r = await runOnce(opts(sb));
      expect(r.processed[0]!.decision).toBe("REJECTED");
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (C2) — supprimer les lignes BUY fait disparaître les positions : le plafond de 4 positions/200 $ est contourné", async () => {
    const sb = makeSandbox();
    try {
      // 4 positions ouvertes en paper (exposition 200 $).
      for (const m of [MINT_B, MINT_C, MINT_D, MINT_E]) writeSnapshot(sb.repoRoot, snapshot({ mint: m }));
      [MINT_B, MINT_C, MINT_D, MINT_E].forEach((m, i) => writeIntent(sb.repoRoot, `${i}.json`, intent({ id: `p${i}`, mint: m, sizeCad: 50 })));
      await runOnce(opts(sb));
      expect(readLedger(ledgerPathOf(sb)).filter((e) => e.decision === "PAPER")).toHaveLength(4);
      // Attaque : ledger vidé par un commit.
      fs.writeFileSync(ledgerPathOf(sb), "");
      writeSnapshot(sb.repoRoot, snapshot({ mint: MINT_A }));
      writeIntent(sb.repoRoot, "5.json", intent({ id: "p5", mint: MINT_A, sizeCad: 50 }));
      const r = await runOnce(opts(sb));
      expect(r.processed[0]!.reasons.join()).toMatch(/POSITIONS_MAX|EXPOSITION_MAX/);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (C2) — effacer la ligne PENDING/PAPER d'un mint réarme la cadence (1 ordre/mint/heure) et le contrôle de doublon", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "1.json", intent({ id: "c1" }));
      await runOnce(opts(sb));
      fs.writeFileSync(ledgerPathOf(sb), "");
      writeIntent(sb.repoRoot, "2.json", intent({ id: "c1" })); // même id, même mint, 1 minute plus tard
      const r = await runOnce(opts(sb, { now: () => new Date(NOW.getTime() + 60_000) }));
      expect(r.processed[0]!.reasons.join()).toMatch(/INTENT_DUPLIQUE|CADENCE_MINT/);
    } finally {
      sb.cleanup();
    }
  });

  it("le ledger n'accepte que des lignes JSON valides : une ligne corrompue arrête l'exécuteur (DoS sûr, pas de perte)", async () => {
    const sb = makeSandbox();
    try {
      fs.mkdirSync(path.dirname(ledgerPathOf(sb)), { recursive: true });
      fs.writeFileSync(ledgerPathOf(sb), "{ pas du json\n");
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "x.json", intent({ id: "x" }));
      const r = await runOnce(opts(sb));
      expect(r.error).toMatch(/^LEDGER/);
      expect(r.processed).toHaveLength(0);
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) Politique : chemins, symlinks, variables d'environnement, contenu
// ---------------------------------------------------------------------------
describe("(4) Politique de risque", () => {
  const symlinkOk = (): boolean => {
    try {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "sl-"));
      fs.writeFileSync(path.join(d, "a"), "");
      fs.symlinkSync(path.join(d, "a"), path.join(d, "b"));
      fs.rmSync(d, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };

  it("symlink ~/.crypto-lab/risk.policy.json → fichier du dépôt : refusé (realpath)", () => {
    if (!symlinkOk()) return;
    const sb = makeSandbox();
    try {
      const local = path.join(sb.home, ".crypto-lab", "risk.policy.json");
      const inRepo = path.join(sb.repoRoot, "lab", "risk", "policy.example.json");
      fs.mkdirSync(path.dirname(inRepo), { recursive: true });
      fs.writeFileSync(inRepo, JSON.stringify(policy({ maxPositionSizeCad: 700, maxExposureCad: 700 })));
      fs.rmSync(local);
      fs.symlinkSync(inRepo, local);
      expect(() => loadPolicy(local, { repoRoot: sb.repoRoot, home: sb.home, env: {} })).toThrow(/dépôt/);
    } finally {
      sb.cleanup();
    }
  });

  it("symlink de RÉPERTOIRE ~/.crypto-lab/policies → dépôt, et RISK_POLICY_PATH relatif vers le dépôt : refusés", () => {
    if (!symlinkOk()) return;
    const sb = makeSandbox();
    try {
      const dirLink = path.join(sb.home, ".crypto-lab", "policies");
      fs.symlinkSync(sb.repoRoot, dirLink);
      fs.writeFileSync(path.join(sb.repoRoot, "p.json"), JSON.stringify(P));
      const via = path.join(dirLink, "p.json");
      expect(() => loadPolicy(via, { repoRoot: sb.repoRoot, home: sb.home, env: { RISK_POLICY_PATH: via } })).toThrow(/dépôt/);
      const rel = path.relative(process.cwd(), path.join(sb.repoRoot, "p.json"));
      expect(() => loadPolicy(resolvePolicyPath({ home: sb.home, env: { RISK_POLICY_PATH: rel } }), { repoRoot: sb.repoRoot, home: sb.home, env: { RISK_POLICY_PATH: rel } })).toThrow(/dépôt/);
    } finally {
      sb.cleanup();
    }
  });

  it("le dépôt lui-même atteint via un symlink (repoRoot = lien) : toujours refusé", () => {
    if (!symlinkOk()) return;
    const sb = makeSandbox();
    try {
      const link = path.join(sb.root, "repo-link");
      fs.symlinkSync(sb.repoRoot, link);
      fs.writeFileSync(path.join(sb.repoRoot, "p.json"), JSON.stringify(P));
      expect(() => loadPolicy(path.join(link, "p.json"), { repoRoot: sb.repoRoot, home: sb.home, env: { RISK_POLICY_PATH: path.join(link, "p.json") } })).toThrow(/dépôt/);
      expect(() => loadPolicy(path.join(sb.repoRoot, "p.json"), { repoRoot: link, home: sb.home, env: { RISK_POLICY_PATH: path.join(sb.repoRoot, "p.json") } })).toThrow(/dépôt/);
    } finally {
      sb.cleanup();
    }
  });

  it("contenu : champs manquants, NaN/Infinity (JSON invalide), version ≠ 1, tableau, bornes absurdes → refus", () => {
    const sb = makeSandbox();
    try {
      const local = path.join(sb.home, ".crypto-lab", "risk.policy.json");
      const cases: Array<[string, string]> = [
        ['{"version":1}', /doit être un nombre fini/.source],
        [JSON.stringify(P).replace('"maxPositionSizeCad":50', '"maxPositionSizeCad":Infinity'), /JSON invalide/.source],
        [JSON.stringify(P).replace('"maxDailyLossCad":70', '"maxDailyLossCad":NaN'), /JSON invalide/.source],
        [JSON.stringify({ ...P, version: "1" }), /version doit être 1/.source],
        ["[]", /objet JSON attendu/.source],
        [JSON.stringify({ ...P, maxPositionSizeCad: 1e308 }), /maxPositionSizeCad > maxExposureCad/.source],
        [JSON.stringify({ ...P, maxSlippageBps: 10_001 }), /maxSlippageBps/.source],
        [JSON.stringify({ ...P, forbiddenWindow: { startHour: 2, endHour: 8, timeZone: "" } }), /timeZone invalide/.source],
      ];
      for (const [raw, re] of cases) {
        fs.writeFileSync(local, raw);
        expect(() => loadPolicy(local, { repoRoot: sb.repoRoot, home: sb.home, env: {} }), raw).toThrow(new RegExp(re));
      }
    } finally {
      sb.cleanup();
    }
  });

  it("policyProblems : les champs numériques ne peuvent pas être des chaînes numériques ni des booléens", () => {
    expect(policyProblems({ ...P, maxPositionSizeCad: "50" }).join()).toMatch(/maxPositionSizeCad/);
    expect(policyProblems({ ...P, maxOpenPositions: true }).join()).toMatch(/maxOpenPositions/);
    expect(policyProblems({ ...P, maxOpenPositions: 2.5 }).join()).toMatch(/entier/);
  });

  it("CORRIGÉ (M5) — package.json (dans le dépôt) ne doit pas pouvoir injecter RISK_POLICY_PATH / EXECUTION_MODE dans la commande de lancement", () => {
    // Si Hervé lance `npm run exec`, Claude contrôle la ligne de commande et l'environnement (scripts: { exec: "EXECUTION_MODE=live … --live" }).
    // Propriété attendue : le README interdit npm scripts pour l'exécuteur et package.json ne contient aucun script exec/live/watch.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const readme = fs.readFileSync(path.join(REPO_ROOT, "lab", "README.md"), "utf8");
    const scripts = Object.values(pkg.scripts ?? {}).join("\n");
    expect(scripts).not.toMatch(/executor|--live|EXECUTION_MODE/);
    expect(readme).toMatch(/jamais.*npm run|npm run.*jamais|script de lancement hors du dépôt/i);
  });
});

// ---------------------------------------------------------------------------
// (5) Kill switch
// ---------------------------------------------------------------------------
describe("(5) Kill switch", () => {
  it("KILL déposé entre deux intents d'un même cycle : arrêt net, le 2e intent n'est ni exécuté ni déplacé", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot({ mint: MINT_A }));
      writeSnapshot(sb.repoRoot, snapshot({ mint: MINT_B }));
      writeIntent(sb.repoRoot, "1.json", intent({ id: "k1", mint: MINT_A }));
      writeIntent(sb.repoRoot, "2.json", intent({ id: "k2", mint: MINT_B }));
      let n = 0;
      const r = await runOnce(opts(sb, {
        loadSnapshot: (m) => {
          if (++n === 1) fs.writeFileSync(path.join(sb.home, ".crypto-lab", "KILL"), "");
          return JSON.parse(fs.readFileSync(path.join(sb.repoRoot, "data", "tokens", `${m}.json`), "utf8")) as TokenSnapshot;
        },
      }));
      expect(r.processed.map((p) => p.decision)).toEqual(["PAPER"]);
      expect(r.killed).toBe(true);
      expect(fs.existsSync(path.join(sb.repoRoot, "intents", "2.json"))).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (C4) — un fichier KILL du dépôt supprimé par un commit (git rm KILL + pull) ne doit pas réarmer l'exécution seul", async () => {
    // Le KILL du dépôt est « partagé, visible de Claude » : Claude peut donc aussi le retirer. Propriété attendue : le kill
    // du dépôt est un VERROU À CLIQUET — dès qu'il est vu, l'exécuteur crée ~/.crypto-lab/KILL, qu'Hervé doit retirer à la main.
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "k.json", intent({ id: "k" }));
      fs.writeFileSync(path.join(sb.repoRoot, "KILL"), "arrêt par Hervé");
      expect((await runOnce(opts(sb))).killed).toBe(true);
      fs.rmSync(path.join(sb.repoRoot, "KILL")); // « git pull » après un commit de Claude qui retire KILL
      const r = await runOnce(opts(sb));
      expect(r.killed).toBe(true);
      expect(r.processed).toHaveLength(0);
    } finally {
      sb.cleanup();
    }
  });

  it("KILL remplacé par un répertoire, un symlink cassé ou un fichier vide : toujours « killed »", () => {
    const sb = makeSandbox();
    try {
      fs.mkdirSync(path.join(sb.repoRoot, "KILL"));
      expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: {} }).killed).toBe(true);
      fs.rmdirSync(path.join(sb.repoRoot, "KILL"));
      fs.writeFileSync(path.join(sb.repoRoot, "KILL"), "");
      expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: {} }).killed).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (B4) — CRYPTO_LAB_KILL : toute valeur non vide autre que 0/false/no doit tuer (« oui », « on », « KILL »)", () => {
    const sb = makeSandbox();
    try {
      for (const v of ["oui", "on", "KILL", "y", "2"]) {
        expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: { CRYPTO_LAB_KILL: v } }).killed, v).toBe(true);
      }
    } finally {
      sb.cleanup();
    }
  });

  it("en --watch, l'environnement du processus est figé : CRYPTO_LAB_KILL ne peut pas être ajouté après coup (documenté ; les fichiers KILL restent efficaces)", () => {
    // Pas un contournement par Claude (il ne contrôle pas l'env), mais une limite opérationnelle à documenter.
    const env: Record<string, string | undefined> = {};
    const sb = makeSandbox();
    try {
      expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env }).killed).toBe(false);
      fs.writeFileSync(path.join(sb.home, ".crypto-lab", "KILL"), "");
      expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env }).killed).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// (6) Mode live et intégrité du code exécuté
// ---------------------------------------------------------------------------
describe("(6) Mode live", () => {
  it("EXECUTION_MODE mal orthographié (Live, LIVE, ' live', live=1) → refus", async () => {
    for (const v of ["Live", "LIVE", " live", "live ", "1", "true"]) {
      const sb = makeSandbox();
      try {
        fs.writeFileSync(path.join(sb.home, ".crypto-lab", "keypair.json"), JSON.stringify(new Array(64).fill(1)));
        const r = await runOnce(opts(sb, { env: { EXECUTION_MODE: v }, mode: "live" }));
        expect(r.error, v).toMatch(/LIVE_REFUSE/);
      } finally {
        sb.cleanup();
      }
    }
  });

  it("keypair vide, non tableau, 63 octets, JSON invalide → refus (sans signer injecté)", async () => {
    for (const raw of ["[]", "{}", JSON.stringify(new Array(63).fill(1)), "pas du json", "null"]) {
      const sb = makeSandbox();
      try {
        fs.writeFileSync(path.join(sb.home, ".crypto-lab", "keypair.json"), raw);
        writeSnapshot(sb.repoRoot, snapshot());
        writeIntent(sb.repoRoot, "l.json", intent({ id: "l" }));
        const r = await runOnce(opts(sb, { env: { EXECUTION_MODE: "live" }, mode: "live" }));
        expect(r.error, raw).toMatch(/LIVE_REFUSE/);
        expect(r.processed).toHaveLength(0);
      } finally {
        sb.cleanup();
      }
    }
  });

  it("le mode vient de la CLI (--live) ET de l'env : EXECUTION_MODE=live seul ne bascule pas un --paper en live", async () => {
    const sb = makeSandbox();
    try {
      fs.writeFileSync(path.join(sb.home, ".crypto-lab", "keypair.json"), JSON.stringify(new Array(64).fill(1)));
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "p.json", intent({ id: "p" }));
      const r = await runOnce(opts(sb, { env: { EXECUTION_MODE: "live" }, mode: "paper" }));
      expect(r.mode).toBe("paper");
      expect(r.processed[0]!.decision).toBe("PAPER");
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (C1) — le code de lab/ est dans le dépôt que Claude peut modifier : l'exécuteur doit vérifier son intégrité avant tout ordre live", async () => {
    // Simulation d'un commit malveillant : (a) le fichier engine.ts sur disque est modifié après le scellement (= git pull),
    // (b) en mémoire, evaluate() est remplacé par « toujours autorisé » (vi.mock). Le manifeste scellé doit suffire à refuser.
    vi.resetModules();
    vi.doMock("../lab/risk/engine.ts", async (importOriginal) => {
      const orig = await importOriginal<typeof import("../lab/risk/engine.ts")>();
      return { ...orig, evaluate: (i: Intent) => ({ allowed: true, reasons: [], adjustedSizeCad: i.sizeCad }) };
    });
    const { runOnce: patchedRunOnce } = await import("../lab/exec/executor.ts");
    vi.doUnmock("../lab/risk/engine.ts");
    const sb = makeSandbox();
    try {
      // Copie du code réel, scellée par « Hervé », puis altérée par « git pull ».
      const codeRoot = path.join(sb.root, "code");
      fs.cpSync(path.join(REPO_ROOT, "lab"), path.join(codeRoot, "lab"), { recursive: true });
      for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(codeRoot, f));
      sealManifest({ codeRoot, home: sb.home });
      fs.appendFileSync(path.join(codeRoot, "lab", "risk", "engine.ts"), "\n// export const evaluate = () => ({ allowed: true, reasons: [] });\n");

      writeSnapshot(sb.repoRoot, snapshot({ liquidityUsd: 1, freezeAuthority: "Frozen" }));
      writeIntent(sb.repoRoot, "evil.json", intent({ id: "evil", sizeCad: 700, maxSlippageBps: 9_000 }));
      const live = fakeLive(0.001);
      const r = await patchedRunOnce(liveOpts(sb, live, { codeRoot }));
      expect(r.error).toMatch(/CODE_NON_SCELLE/);
      expect(r.integrity?.changed).toEqual(["~ lab/risk/engine.ts"]);
      expect(r.processed).toHaveLength(0);
      expect(live.calls.filter((c) => c.kind === "send")).toHaveLength(0);
      // Sans aucun manifeste (Hervé n'a jamais scellé) : refus aussi.
      fs.rmSync(path.join(sb.home, ".crypto-lab", "exec.manifest.json"));
      const r2 = await patchedRunOnce(liveOpts(sb, live, { codeRoot }));
      expect(r2.error).toMatch(/CODE_NON_SCELLE: aucun manifeste/);
      // En paper : avertissement seulement.
      const r3 = await patchedRunOnce(opts(sb, { codeRoot, verifier: live.verifier }));
      expect(r3.error).toBeUndefined();
      expect(r3.warnings.join()).toMatch(/code non scellé/);
    } finally {
      sb.cleanup();
      vi.resetModules();
    }
  });

  it("CORRIGÉ (H1) — les paramètres de marché (SOL_PRICE_USD, FX) sont des constantes : un ordre « 50 CAD » peut engager bien plus de SOL réels", async () => {
    // SOL_PRICE_USD=150 dans l'env alors que SOL vaut 250 : 50 CAD → 0,243 SOL = 83 CAD réels envoyés à Jupiter.
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "fx.json", intent({ id: "fx", sizeCad: 50 }));
      const realSolUsd = 250;
      const live = fakeLive(0.001, 6, realSolUsd);
      const r = await runOnce(liveOpts(sb, live, { market: () => ({ ...MARKET, solPriceUsd: 150 }) })); // la « constante » 150 est ignorée en live
      const quote = live.calls.find((c) => c.kind === "quote" && c.detail.startsWith("So11->7EYn"))!; // le devis d'ACHAT (pas la cotation SOL→USDC)
      const lamports = Number(quote.detail.split(":")[1]);
      const realCad = (lamports / 1e9) * realSolUsd * MARKET.fxCadPerUsd;
      // Propriété attendue : le SOL engagé, valorisé au prix RÉEL (cotation live obligatoire), respecte le plafond de 50 CAD.
      expect(r.processed[0]!.decision).toBe("EXECUTED");
      expect(realCad).toBeLessThanOrEqual(50 * 1.01);
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// (7) Fractionnement
// ---------------------------------------------------------------------------
describe("(7) Fractionnement des limites", () => {
  it("5 intents de 10 $ sur le même mint dans le même cycle : cadence (PENDING compte) → un seul passe", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      for (let i = 0; i < 5; i++) writeIntent(sb.repoRoot, `${i}.json`, intent({ id: `f${i}`, sizeCad: 10 }));
      const r = await runOnce(opts(sb));
      expect(r.processed.filter((p) => p.decision === "PAPER")).toHaveLength(1);
      expect(r.processed.filter((p) => p.reasons.join().includes("CADENCE_MINT"))).toHaveLength(4);
    } finally {
      sb.cleanup();
    }
  });

  it("renfort : 40 $ puis 10 $ une heure plus tard OK ; 11 $ refusé (le plafond par mint inclut la position)", () => {
    const pf = portfolio({ positions: [{ mint: MINT_A, qty: 1, costCad: 40, openedAt: NOW.toISOString(), markCad: 40 }], cashCad: 660 });
    expect(evaluate(intent({ sizeCad: 10 }), pf, snapshot(), P, NOW).allowed).toBe(true);
    expect(evaluate(intent({ sizeCad: 10.01 }), pf, snapshot(), P, NOW).reasons.join()).toMatch(/TAILLE_MAX/);
  });

  it("5 mints différents à 50 $ : le 5e est refusé (POSITIONS_MAX) et l'exposition est bornée à 200 $", async () => {
    const sb = makeSandbox();
    try {
      const mints = [MINT_A, MINT_B, MINT_C, MINT_D, MINT_E];
      mints.forEach((m, i) => {
        writeSnapshot(sb.repoRoot, snapshot({ mint: m }));
        writeIntent(sb.repoRoot, `${i}.json`, intent({ id: `m${i}`, mint: m, sizeCad: 50 }));
      });
      const r = await runOnce(opts(sb));
      expect(r.processed.map((p) => p.decision)).toEqual(["PAPER", "PAPER", "PAPER", "PAPER", "REJECTED"]);
      expect(r.processed[4]!.reasons.join()).toMatch(/POSITIONS_MAX|EXPOSITION_MAX/);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (H2) — moyenner à la baisse : le plafond par mint est au prix de MARCHÉ, donc le coût réel par mint n'est pas borné à 50 $", () => {
    // Position de 50 $ de coût tombée à 5 $ de valeur : le Risk Engine autorise 45 $ de plus (coût cumulé 95 $ sur un mint).
    const pf = portfolio({ positions: [{ mint: MINT_A, qty: 1, costCad: 50, openedAt: NOW.toISOString(), markCad: 5 }], cashCad: 650 });
    const v = evaluate(intent({ sizeCad: 45 }), pf, snapshot(), P, NOW);
    // Propriété attendue : plafond appliqué au max(coût, marché) → refus.
    expect(v.allowed).toBe(false);
  });

  it("fenêtre horaire : 1 h 59 accepté, 2 h 00 refusé, 7 h 59 refusé, 8 h 00 accepté — un intent créé à 1 h 55 ne survit pas jusqu'à 8 h (TTL)", () => {
    const mk = (iso: string) => {
      const now = new Date(iso);
      return evaluate(at(now), portfolio(), snapshot({ createdAt: "2026-09-01T00:00:00Z", fetchedAt: now.toISOString() }), P, now);
    };
    expect(mk("2026-09-24T04:59:00Z").allowed).toBe(true); // 01:59 ADT
    expect(mk("2026-09-24T05:00:00Z").reasons.join()).toMatch(/FENETRE_INTERDITE/); // 02:00
    expect(mk("2026-09-24T10:59:00Z").reasons.join()).toMatch(/FENETRE_INTERDITE/); // 07:59
    expect(mk("2026-09-24T11:00:00Z").allowed).toBe(true); // 08:00
    const created155 = intent({ createdAt: "2026-09-24T04:55:00Z", expiresAt: "2026-09-24T11:05:00Z" });
    expect(evaluate(created155, portfolio(), snapshot({ createdAt: "2026-09-01T00:00:00Z", fetchedAt: "2026-09-24T11:01:00Z" }), P, new Date("2026-09-24T11:01:00Z")).reasons.join()).toMatch(/INTENT_EXPIRE/);
  });

  it.fails("CORRECTIF ATTENDU — la perte du jour n'est bornée qu'APRÈS coup : 4 achats de 50 $ puis 2 ventes à -100 % = -100 $ réalisés le même jour (> 70 $)", async () => {
    // NON CORRIGÉ (M2), volontairement : ce test exige que les 3e et 4e ventes soient REJETÉES, ce qui contredit M1
    // (reduce-only : une vente n'est jamais bloquée par une limite de perte). Ce qui a changé : la perte latente des
    // positions marquées compte désormais dans PERTE_QUOTIDIENNE, donc tout nouvel ACHAT est bloqué dès que
    // réalisé + latent ≤ −70. La perte maximale d'une journée reste ≈ maxDailyLossCad + exposition ouverte + frais,
    // et c'est documenté tel quel dans lab/README.md.
    const sb = makeSandbox();
    try {
      const mints = [MINT_B, MINT_C, MINT_D, MINT_E];
      mints.forEach((m, i) => {
        writeSnapshot(sb.repoRoot, snapshot({ mint: m }));
        writeIntent(sb.repoRoot, `a${i}.json`, intent({ id: `a${i}`, mint: m, sizeCad: 50 }));
      });
      await runOnce(opts(sb));
      const t2 = new Date(NOW.getTime() + 2 * 3600_000);
      mints.forEach((m, i) => {
        writeSnapshot(sb.repoRoot, snapshot({ mint: m, priceUsd: 1e-9, fetchedAt: t2.toISOString() })); // effondrement
        writeIntent(sb.repoRoot, `b${i}.json`, at(t2, { id: `b${i}`, mint: m, kind: "SELL", sizeCad: 1000 }));
      });
      const r = await runOnce(opts(sb, { now: () => t2 }));
      expect(r.processed.map((p) => p.decision)).toEqual(["PAPER", "PAPER", "REJECTED", "REJECTED"]);
      const pf = rebuildPortfolio(readLedger(ledgerPathOf(sb)), { initialCashCad: 700, mode: "paper", timeZone: TZ });
      const dayLoss = pf.dailyPnlByDate["2026-09-24"]!;
      expect(dayLoss).toBeLessThan(-99); // état de fait
      // Propriété attendue (à décider dans la politique) : la perte du jour, latente incluse, ne dépasse pas maxDailyLossCad.
      expect(dayLoss).toBeGreaterThanOrEqual(-P.maxDailyLossCad);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (M1) — après la perte quotidienne/hebdo ou en fenêtre interdite, un SELL est bloqué : impossible de SORTIR d'une position qui s'effondre", () => {
    // Contraire au principe « on doit toujours pouvoir sortir ». Les positions restantes du test précédent sont piégées.
    const pf = portfolio({ dailyPnlByDate: { "2026-09-24": -70 }, positions: [{ mint: MINT_A, qty: 1000, costCad: 40, openedAt: NOW.toISOString() }] });
    expect(evaluate(intent({ kind: "SELL", sizeCad: 100 }), pf, snapshot(), P, NOW).allowed).toBe(true);
    const night = new Date("2026-09-24T07:30:00Z"); // 04:30 à Moncton
    const pf2 = portfolio({ positions: [{ mint: MINT_A, qty: 1000, costCad: 40, openedAt: NOW.toISOString() }] });
    expect(evaluate(at(night, { kind: "SELL", sizeCad: 100 }), pf2, snapshot({ fetchedAt: night.toISOString() }), P, night).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (8) Frais et comptabilité
// ---------------------------------------------------------------------------
describe("(8) Frais, slippage, comptabilité", () => {
  it("paper : les frais et le slippage sont dans le coût (BUY) et dans le PnL (SELL) ; un aller-retour au même prix perd ≈ 4,6 % + priority", () => {
    const params = { ...MARKET, priceUsd: 0.001, slippageBps: 200, now: NOW, timeZone: TZ };
    const b = executeBuy(portfolio(), intent(), 50, params);
    expect(b.portfolio.positions[0]!.costCad).toBe(50);
    expect(b.fill.netCad).toBeLessThan(50);
  });

  it("CORRIGÉ (M4) — live : le loyer du compte de token (ATA ≈ 0,002 SOL) et le priority fee « auto » de Jupiter ne sont pas comptés → dérive cash ledger / portefeuille réel", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "fee.json", intent({ id: "fee", sizeCad: 50 }));
      const live = fakeLive(0.001);
      await runOnce(liveOpts(sb, live));
      const e = readLedger(ledgerPathOf(sb)).at(-1)!;
      const ataRentCad = 0.00203928 * MARKET.solPriceUsd * MARKET.fxCadPerUsd; // ≈ 0,42 CAD
      // Propriété attendue : les frais journalisés incluent au moins le loyer ATA (ou le cash est réconcilié avec le solde on-chain).
      expect(e.fees!.totalCad).toBeGreaterThanOrEqual(0.5 + 0.15 + ataRentCad);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (M4) — live SELL : le produit journalisé vient du DEVIS (outAmount), pas du montant reçu on-chain → la perte réalisée peut être sous-estimée de maxSlippageBps", async () => {
    const sb = makeSandbox();
    try {
      // Position live existante puis vente ; le « vrai » remplissage est 3 % sous le devis (slippage max).
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "1.json", intent({ id: "b", sizeCad: 50 }));
      const live = fakeLive(0.001);
      await runOnce(liveOpts(sb, live));
      const t2 = new Date(NOW.getTime() + 61 * 60_000);
      writeSnapshot(sb.repoRoot, snapshot({ fetchedAt: t2.toISOString() }));
      writeIntent(sb.repoRoot, "2.json", at(t2, { id: "s", kind: "SELL", sizeCad: 1000, maxSlippageBps: 300 }));
      await runOnce(liveOpts(sb, live, { now: () => t2 }));
      const sell = readLedger(ledgerPathOf(sb)).at(-1)!;
      expect(sell.decision).toBe("EXECUTED");
      // Propriété attendue : le PnL journalisé est pessimiste (devis × (1 − slippage)) ou confirmé on-chain.
      const pessimisticGross = sell.fill!.grossCad * (1 - 300 / 10_000);
      expect(sell.fill!.netCad).toBeLessThanOrEqual(pessimisticGross);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (H4) — live BUY : le priceImpactPct du devis Jupiter n'est pas vérifié (un pool à 100 $ de liquidité passe avec un snapshot forgé)", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot({ liquidityUsd: 500_000 }));
      writeIntent(sb.repoRoot, "impact.json", intent({ id: "impact", sizeCad: 50 }));
      const live = fakeLive(0.001);
      const original = live.jupiter.getQuote.bind(live.jupiter);
      live.jupiter.getQuote = async (p) => ({ ...(await original(p)), priceImpactPct: 45 }); // 45 % d'impact = pool minuscule
      const r = await runOnce(liveOpts(sb, live));
      expect(r.processed[0]!.decision).not.toBe("EXECUTED");
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// (9) Paper vs live
// ---------------------------------------------------------------------------
describe("(9) Paper vs live", () => {
  it("les pertes paper ne bloquent pas le live (et inversement) : dailyPnl est reconstruit par mode", () => {
    const paperLoss = ledgerEntry({ kind: "SELL", mode: "paper", pnlCad: -500, ts: NOW.toISOString() });
    const livePf = rebuildPortfolio([paperLoss], { initialCashCad: 700, mode: "live", timeZone: TZ });
    expect(livePf.dailyPnlByDate["2026-09-24"]).toBeUndefined();
    const paperPf = rebuildPortfolio([paperLoss], { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(paperPf.dailyPnlByDate["2026-09-24"]).toBe(-500);
  });

  it("la cadence et le doublon sont vérifiés tous modes confondus (un PENDING paper bloque le même mint en live : sens conservateur)", () => {
    const paperPending = ledgerEntry({ intentId: "pp", mint: MINT_A, mode: "paper", decision: "PENDING", ts: new Date(NOW.getTime() - 60_000).toISOString() });
    expect(evaluate(intent(), portfolio(), snapshot(), P, NOW, [paperPending]).reasons.join()).toMatch(/CADENCE_MINT/);
  });

  it("un ledger paper très positif ne gonfle pas le pic d'équité live (equityAfterCad est filtré par mode)", () => {
    const paperWin = ledgerEntry({ kind: "SELL", mode: "paper", pnlCad: 5000, equityAfterCad: 5700, ts: NOW.toISOString() });
    const livePf = rebuildPortfolio([paperWin], { initialCashCad: 700, mode: "live", timeZone: TZ });
    expect(livePf.peakEquityCad).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// (10) Divers
// ---------------------------------------------------------------------------
describe("(10) Divers", () => {
  it("CORRIGÉ (B3) — un intent du dépôt qui est un LIEN SYMBOLIQUE (git les versionne) ne doit pas être suivi", async () => {
    const sb = makeSandbox();
    try {
      const target = path.join(sb.home, ".crypto-lab", "risk.policy.json");
      fs.symlinkSync(target, path.join(sb.repoRoot, "intents", "link.json"));
      let read = false;
      const r = await runOnce(opts(sb, { loadSnapshot: () => (read = true, null) }));
      // Propriété attendue : lstat → REJECTED « SYMLINK » sans ouvrir la cible, et le lien n'est pas « archivé » ailleurs.
      expect(r.processed[0]?.reasons.join()).toMatch(/SYMLINK|LIEN/);
      expect(read).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("CORRIGÉ (B2) — le mint d'une POSITION (issu du ledger) est aussi passé à loadSnapshot sans validation", async () => {
    const sb = makeSandbox();
    try {
      fs.mkdirSync(path.dirname(ledgerPathOf(sb)), { recursive: true });
      const evilMint = "../../home/.crypto-lab/keypair";
      fs.writeFileSync(ledgerPathOf(sb), JSON.stringify(ledgerEntry({ mint: evilMint })) + "\n");
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "x.json", intent({ id: "x" }));
      const seen: string[] = [];
      await runOnce(opts(sb, { loadSnapshot: (m) => (seen.push(m), m === MINT_A ? snapshot() : null) }));
      expect(seen).not.toContain(evilMint);
    } finally {
      sb.cleanup();
    }
  });

  it("le nom du fichier d'intent contrôle l'ordre : un SELL nommé avant le BUY est simplement rejeté (pas de position)", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "0-sell.json", intent({ id: "s", kind: "SELL", sizeCad: 10 }));
      writeIntent(sb.repoRoot, "1-buy.json", intent({ id: "b" }));
      const r = await runOnce(opts(sb));
      expect(r.processed.map((p) => p.decision)).toEqual(["REJECTED", "PAPER"]);
    } finally {
      sb.cleanup();
    }
  });

  it("le drawdown ne peut pas être « réinitialisé » par un pic plus bas : le pic ne descend jamais sous le capital initial", () => {
    const pf: PortfolioState = { ...portfolio({ cashCad: 400 }), peakEquityCad: 400 };
    // Même avec peakEquityCad falsifié à 400 dans l'objet, rebuildPortfolio repart de 700.
    const rebuilt = rebuildPortfolio([], { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(rebuilt.peakEquityCad).toBe(700);
    expect(evaluate(intent(), pf, snapshot(), P, NOW).allowed).toBe(true); // mais evaluate() fait confiance à ce qu'on lui passe
  });

  it("une politique plus permissive dans lab/risk/policy.example.json n'a aucun effet (jamais lue)", async () => {
    const sb = makeSandbox();
    try {
      fs.mkdirSync(path.join(sb.repoRoot, "lab", "risk"), { recursive: true });
      fs.writeFileSync(path.join(sb.repoRoot, "lab", "risk", "policy.example.json"), JSON.stringify(policy({ maxPositionSizeCad: 700, maxExposureCad: 700 })));
      writeSnapshot(sb.repoRoot, snapshot());
      writeIntent(sb.repoRoot, "big.json", intent({ id: "big", sizeCad: 600 }));
      const r = await runOnce(opts(sb));
      expect(r.processed[0]!.reasons.join()).toMatch(/TAILLE_MAX/);
    } finally {
      sb.cleanup();
    }
  });

  it("dérive d'horloge : un intent créé « il y a 29 min » (signal frais) est encore valide, l'exécuteur ne fait confiance qu'à sa propre horloge", () => {
    // Politique v2 : le signal lui-même doit avoir moins de maxSignalAgeMinutes (20) — on le date explicitement ici,
    // le test porte sur l'horloge et le TTL, pas sur l'âge du signal.
    const signalTs = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    const v = evaluate(intent({ createdAt: new Date(NOW.getTime() - 29 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), signalTs }), portfolio(), snapshot(), P, NOW);
    expect(v.allowed).toBe(true);
    expect(evaluate(intent({ createdAt: new Date(NOW.getTime() - 31 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), signalTs }), portfolio(), snapshot(), P, NOW).allowed).toBe(false);
  });

  it("prototype pollution via JSON (__proto__) : sans effet sur le verdict", () => {
    const raw = JSON.parse(`{"__proto__":{"allowed":true},"id":"p","createdAt":"${NOW.toISOString()}","kind":"BUY","mint":"${MINT_A}","sizeCad":5000,"maxSlippageBps":200,"thesis":"t","signals":[],"invalidation":"i","expiresAt":"${new Date(NOW.getTime() + 600_000).toISOString()}"}`) as Intent;
    expect(evaluate(raw, portfolio(), snapshot(), P, NOW).allowed).toBe(false);
    expect(({} as { allowed?: boolean }).allowed).toBeUndefined();
  });
});

// Garde-fou : ce fichier ne doit rien laisser dans le dépôt réel.
afterEach(() => {
  for (const f of ["KILL", "ledger/trades.jsonl"]) expect(fs.existsSync(path.join(REPO_ROOT, f)), `${f} créé dans le dépôt réel`).toBe(false);
});
