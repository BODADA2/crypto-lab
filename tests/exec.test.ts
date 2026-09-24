import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isKilled } from "../lab/exec/killswitch.ts";
import { computeFees, emptyPortfolio, equityOf, executeBuy, executeSell, markToMarket } from "../lab/exec/paper.ts";
import { checkMarketPlausibility, parseArgs, runOnce } from "../lab/exec/executor.ts";
import { computeManifest, sealManifest, verifyIntegrity } from "../lab/exec/integrity.ts";
import { buildVerifiedSnapshot, createLocalVerifier, pickBestPair } from "../lab/exec/verify.ts";
import { evaluate } from "../lab/risk/engine.ts";
import type { MintInfo } from "../lab/collect/mintinfo.ts";
import type { DexPair } from "../lab/collect/dexscreener.ts";
import { readLedger, rebuildPortfolio } from "../lab/ledger/ledger.ts";
import { USDC_MINT, type JupiterClient, type Signer } from "../lab/swap/jupiter.ts";
import type { LedgerEntry } from "../lab/types.ts";
import { MINT_A, MINT_B, MINT_C, NOW, intent, ledgerEntry, makeSandbox, policy, portfolio, snapshot, writeIntent, writeSnapshot } from "./execFixtures.ts";

const TZ = "America/Moncton";
const MK = { fxCadPerUsd: 1.37, solPriceUsd: 150, priorityFeeSol: 0.0005 };
const params = { priceUsd: 0.001, fxCadPerUsd: 1.37, slippageBps: 200, solPriceUsd: 150, priorityFeeSol: 0.0005, now: NOW, timeZone: TZ };

describe("Kill switch", () => {
  let sb: ReturnType<typeof makeSandbox> | undefined;
  afterEach(() => sb?.cleanup());

  it("inactif par défaut", () => {
    sb = makeSandbox();
    expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: {} })).toEqual({ killed: false, sources: [] });
  });

  it("fichier KILL à la racine du dépôt (et cliquet : ~/.crypto-lab/KILL est créé, retirer le KILL du dépôt ne réarme rien)", () => {
    sb = makeSandbox();
    fs.writeFileSync(path.join(sb.repoRoot, "KILL"), "");
    expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: {} })).toEqual({ killed: true, sources: ["repo:KILL"], latched: true });
    expect(fs.existsSync(path.join(sb.home, ".crypto-lab", "KILL"))).toBe(true);
    fs.rmSync(path.join(sb.repoRoot, "KILL"));
    expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: {} })).toEqual({ killed: true, sources: ["home:~/.crypto-lab/KILL"] });
    // sans cliquet (lecture seule)
    const sb2 = makeSandbox();
    fs.writeFileSync(path.join(sb2.repoRoot, "KILL"), "");
    expect(isKilled({ repoRoot: sb2.repoRoot, home: sb2.home, env: {}, latch: false })).toEqual({ killed: true, sources: ["repo:KILL"] });
    expect(fs.existsSync(path.join(sb2.home, ".crypto-lab", "KILL"))).toBe(false);
    sb2.cleanup();
  });

  it("fichier ~/.crypto-lab/KILL", () => {
    sb = makeSandbox();
    fs.writeFileSync(path.join(sb.home, ".crypto-lab", "KILL"), "");
    expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: {} }).sources).toEqual(["home:~/.crypto-lab/KILL"]);
  });

  it("variable d'environnement CRYPTO_LAB_KILL=1 (et cumul des sources)", () => {
    sb = makeSandbox();
    expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: { CRYPTO_LAB_KILL: "1" } }).sources).toEqual(["env:CRYPTO_LAB_KILL"]);
    expect(isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: { CRYPTO_LAB_KILL: "0" } }).killed).toBe(false);
    fs.writeFileSync(path.join(sb.repoRoot, "KILL"), "");
    const r = isKilled({ repoRoot: sb.repoRoot, home: sb.home, env: { CRYPTO_LAB_KILL: "true" } });
    expect(r.killed).toBe(true);
    expect(r.sources).toHaveLength(2);
  });
});

describe("Paper trading", () => {
  it("achat : frais 1 % + 0,3 % + priority fee, quantité au prix dégradé par le slippage", () => {
    const r = executeBuy(emptyPortfolio(700), intent({ sizeCad: 40 }), 40, params);
    const priority = 0.0005 * 150 * 1.37;
    expect(r.fees.platformCad).toBeCloseTo(0.4, 10);
    expect(r.fees.swapCad).toBeCloseTo(0.12, 10);
    expect(r.fees.priorityCad).toBeCloseTo(priority, 10);
    expect(r.fees.totalCad).toBeCloseTo(0.52 + priority, 10);
    expect(r.fill.netCad).toBeCloseTo(40 - r.fees.totalCad, 10);
    expect(r.fill.priceUsd).toBeCloseTo(0.00102, 12);
    expect(r.fill.qty).toBeCloseTo(r.fill.netCad / (0.00102 * 1.37), 6);
    expect(r.portfolio.cashCad).toBeCloseTo(660, 10);
    expect(r.portfolio.positions).toHaveLength(1);
    expect(r.portfolio.positions[0]!.costCad).toBe(40);
    expect(r.pnlCad).toBeUndefined();
    // l'original n'est pas muté
    expect(emptyPortfolio(700).cashCad).toBe(700);
  });

  it("achat : renfort d'une position existante cumule quantité et coût", () => {
    const a = executeBuy(emptyPortfolio(700), intent(), 40, params);
    const b = executeBuy(a.portfolio, intent(), 10, params);
    expect(b.portfolio.positions).toHaveLength(1);
    expect(b.portfolio.positions[0]!.costCad).toBe(50);
    expect(b.portfolio.positions[0]!.qty).toBeCloseTo(a.fill.qty + b.fill.qty, 9);
    expect(b.portfolio.cashCad).toBe(650);
  });

  it("achat refusé si cash insuffisant ou taille nulle (le simulateur lève, l'exécuteur journalise FAILED)", () => {
    expect(() => executeBuy(emptyPortfolio(10), intent(), 40, params)).toThrow(/cash insuffisant/);
    expect(() => executeBuy(emptyPortfolio(700), intent(), 0, params)).toThrow(/sizeCad/);
    expect(() => executeBuy(emptyPortfolio(700), intent(), 40, { ...params, priceUsd: 0 })).toThrow(/priceUsd/);
  });

  it("vente totale avec gain : PnL réalisé net de frais, cash et compteurs jour/semaine mis à jour", () => {
    const buy = executeBuy(emptyPortfolio(700), intent(), 40, params);
    const sell = executeSell(buy.portfolio, intent({ kind: "SELL" }), 1000, { ...params, priceUsd: 0.002 });
    const gross = buy.fill.qty * 0.002 * (1 - 0.02) * 1.37;
    expect(sell.fill.qty).toBeCloseTo(buy.fill.qty, 9);
    expect(sell.fill.grossCad).toBeCloseTo(gross, 8);
    expect(sell.fees.totalCad).toBeCloseTo(computeFees(gross, params).totalCad, 8);
    expect(sell.pnlCad).toBeCloseTo(gross - sell.fees.totalCad - 40, 8);
    expect(sell.pnlCad!).toBeGreaterThan(0);
    expect(sell.portfolio.positions).toHaveLength(0);
    expect(sell.portfolio.cashCad).toBeCloseTo(660 + gross - sell.fees.totalCad, 8);
    expect(sell.portfolio.realizedPnlCad).toBeCloseTo(sell.pnlCad!, 10);
    expect(sell.portfolio.dailyPnlByDate["2026-09-24"]).toBeCloseTo(sell.pnlCad!, 10);
    expect(sell.portfolio.weeklyPnlByWeek["2026-W39"]).toBeCloseTo(sell.pnlCad!, 10);
    expect(sell.portfolio.peakEquityCad).toBeCloseTo(sell.portfolio.cashCad, 8);
  });

  it("vente partielle avec perte : coût retiré au prorata, position conservée", () => {
    const buy = executeBuy(emptyPortfolio(700), intent(), 40, params);
    const half = (buy.fill.qty / 2) * 0.0005 * 1.37; // notionnel de la moitié au nouveau prix
    const sell = executeSell(buy.portfolio, intent({ kind: "SELL" }), half, { ...params, priceUsd: 0.0005 });
    expect(sell.fill.qty).toBeCloseTo(buy.fill.qty / 2, 6);
    expect(sell.pnlCad!).toBeLessThan(0);
    expect(sell.portfolio.positions[0]!.costCad).toBeCloseTo(20, 6);
    expect(sell.portfolio.positions[0]!.qty).toBeCloseTo(buy.fill.qty / 2, 6);
    expect(sell.pnlCad).toBeCloseTo(sell.fill.netCad - 20, 6);
  });

  it("vente sans position → exception", () => {
    expect(() => executeSell(emptyPortfolio(700), intent({ kind: "SELL" }), 10, params)).toThrow(/aucune position/);
  });

  it("marque-à-marché : met à jour la valeur des positions et le pic d'équité", () => {
    const buy = executeBuy(emptyPortfolio(700), intent(), 40, params);
    const peakBefore = buy.portfolio.peakEquityCad;
    const up = markToMarket(buy.portfolio, { [MINT_A]: 0.003 }, 1.37, NOW);
    expect(up.positions[0]!.markCad).toBeCloseTo(buy.fill.qty * 0.003 * 1.37, 8);
    expect(equityOf(up)).toBeGreaterThan(700);
    expect(up.peakEquityCad).toBeGreaterThan(peakBefore);
    const down = markToMarket(up, { [MINT_A]: 0.0001 }, 1.37, NOW);
    expect(down.peakEquityCad).toBe(up.peakEquityCad); // le pic ne redescend jamais
    expect(equityOf(down)).toBeLessThan(700);
    const untouched = markToMarket(up, { [MINT_B]: 5 }, 1.37, NOW);
    expect(untouched.positions[0]!.markCad).toBe(up.positions[0]!.markCad);
  });
});

describe("Exécuteur — mode paper de bout en bout", () => {
  let sb: ReturnType<typeof makeSandbox> | undefined;
  afterEach(() => sb?.cleanup());

  const baseOpts = (s: ReturnType<typeof makeSandbox>, extra: Partial<Parameters<typeof runOnce>[0]> = {}) => ({
    repoRoot: s.repoRoot,
    home: s.home,
    env: {},
    now: () => NOW,
    market: () => ({ fxCadPerUsd: 1.37, solPriceUsd: 150, priorityFeeSol: 0.0005 }),
    log: () => {},
    ...extra,
  });

  it("traite un BUY puis un SELL : ledger PENDING → PAPER, intents archivés, portefeuille reconstruit", async () => {
    sb = makeSandbox();
    writeSnapshot(sb.repoRoot, snapshot());
    writeIntent(sb.repoRoot, "2026-09-24T14-55-00Z-buy1.json", intent({ id: "buy1" }));
    const r1 = await runOnce(baseOpts(sb));
    expect(r1.error).toBeUndefined();
    expect(r1.processed.map((p) => p.decision)).toEqual(["PAPER"]);

    const ledgerPath = path.join(sb.repoRoot, "ledger", "trades.jsonl");
    let entries = readLedger(ledgerPath);
    expect(entries.map((e) => e.decision)).toEqual(["PENDING", "PAPER"]);
    expect(entries[1]!.fill?.grossCad).toBe(40);
    expect(entries[1]!.fees?.totalCad).toBeGreaterThan(0.5);
    expect(entries[1]!.equityAfterCad).toBeDefined();
    expect(fs.existsSync(path.join(sb.repoRoot, "intents", "processed", "2026-09-24T14-55-00Z-buy1.json"))).toBe(true);
    expect(fs.readdirSync(path.join(sb.repoRoot, "intents")).filter((f) => f.endsWith(".json"))).toHaveLength(0);

    // Vente 2 h plus tard, prix doublé.
    const later = new Date(NOW.getTime() + 2 * 3600_000);
    writeSnapshot(sb.repoRoot, snapshot({ priceUsd: 0.002, fetchedAt: later.toISOString() }));
    writeIntent(
      sb.repoRoot,
      "2026-09-24T16-55-00Z-sell1.json",
      intent({ id: "sell1", kind: "SELL", sizeCad: 500, createdAt: later.toISOString(), expiresAt: new Date(later.getTime() + 600_000).toISOString() }),
    );
    const r2 = await runOnce(baseOpts(sb, { now: () => later }));
    expect(r2.processed.map((p) => p.decision)).toEqual(["PAPER"]);
    entries = readLedger(ledgerPath);
    expect(entries.map((e) => e.decision)).toEqual(["PENDING", "PAPER", "PENDING", "PAPER"]);
    const sell = entries[3]!;
    expect(sell.kind).toBe("SELL");
    expect(sell.pnlCad!).toBeGreaterThan(0);

    const pf = rebuildPortfolio(entries, { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(pf.positions).toHaveLength(0);
    expect(pf.cashCad).toBeCloseTo(700 + sell.pnlCad!, 6);
    expect(pf.realizedPnlCad).toBeCloseTo(sell.pnlCad!, 10);
  });

  it("rejette et journalise un intent non conforme sans écrire de PENDING, et archive l'intent", async () => {
    sb = makeSandbox();
    writeSnapshot(sb.repoRoot, snapshot({ liquidityUsd: 100 }));
    writeIntent(sb.repoRoot, "a.json", intent({ id: "bad" }));
    const r = await runOnce(baseOpts(sb));
    expect(r.processed[0]!.decision).toBe("REJECTED");
    expect(r.processed[0]!.reasons.join()).toMatch(/LIQUIDITE_MIN/);
    const entries = readLedger(path.join(sb.repoRoot, "ledger", "trades.jsonl"));
    expect(entries.map((e) => e.decision)).toEqual(["REJECTED"]);
    expect(fs.existsSync(path.join(sb.repoRoot, "intents", "processed", "a.json"))).toBe(true);
  });

  it("le même intent rejoué est rejeté comme doublon ; un second ordre sur le même mint est bloqué par la cadence", async () => {
    sb = makeSandbox();
    writeSnapshot(sb.repoRoot, snapshot());
    writeIntent(sb.repoRoot, "1.json", intent({ id: "x1" }));
    await runOnce(baseOpts(sb));
    writeIntent(sb.repoRoot, "2.json", intent({ id: "x1" }));
    writeIntent(sb.repoRoot, "3.json", intent({ id: "x2", sizeCad: 10 }));
    const r = await runOnce(baseOpts(sb, { now: () => new Date(NOW.getTime() + 60_000) }));
    expect(r.processed.map((p) => p.decision)).toEqual(["REJECTED", "REJECTED"]);
    expect(r.processed[0]!.reasons.join()).toMatch(/INTENT_DUPLIQUE/);
    expect(r.processed[1]!.reasons.join()).toMatch(/CADENCE_MINT/);
  });

  it("un fichier JSON invalide est journalisé REJECTED et archivé", async () => {
    sb = makeSandbox();
    writeIntent(sb.repoRoot, "broken.json", "{ pas du json");
    const r = await runOnce(baseOpts(sb));
    expect(r.processed[0]!.decision).toBe("REJECTED");
    expect(r.processed[0]!.reasons[0]).toMatch(/JSON_INVALIDE/);
    expect(r.processed[0]!.intentId).toBe("file:broken.json");
  });

  it("kill switch actif : rien n'est traité ni déplacé", async () => {
    sb = makeSandbox();
    writeSnapshot(sb.repoRoot, snapshot());
    writeIntent(sb.repoRoot, "k.json", intent({ id: "k" }));
    fs.writeFileSync(path.join(sb.home, ".crypto-lab", "KILL"), "");
    const r = await runOnce(baseOpts(sb));
    expect(r.killed).toBe(true);
    expect(r.processed).toHaveLength(0);
    expect(fs.existsSync(path.join(sb.repoRoot, "intents", "k.json"))).toBe(true);
    expect(fs.existsSync(path.join(sb.repoRoot, "ledger", "trades.jsonl"))).toBe(false);
  });

  it("politique absente ou lue depuis le dépôt : refus total", async () => {
    sb = makeSandbox();
    writeIntent(sb.repoRoot, "k.json", intent({ id: "k" }));
    fs.rmSync(path.join(sb.home, ".crypto-lab", "risk.policy.json"));
    const r = await runOnce(baseOpts(sb));
    expect(r.error).toMatch(/^POLITIQUE/);
    expect(r.processed).toHaveLength(0);

    const inRepo = path.join(sb.repoRoot, "risk.policy.json");
    fs.copyFileSync(path.join(process.cwd(), "lab", "risk", "policy.example.json"), inRepo);
    const r2 = await runOnce(baseOpts(sb, { env: { RISK_POLICY_PATH: inRepo } }));
    expect(r2.error).toMatch(/dépôt/);
    expect(fs.existsSync(path.join(sb.repoRoot, "intents", "k.json"))).toBe(true);
  });

  it("un PENDING orphelin est clôturé en FAILED au cycle suivant", async () => {
    sb = makeSandbox();
    const ledgerPath = path.join(sb.repoRoot, "ledger", "trades.jsonl");
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const orphan: LedgerEntry = { ts: NOW.toISOString(), intentId: "o1", mint: MINT_A, kind: "BUY", decision: "PENDING", mode: "paper", reasons: [], requestedSizeCad: 40, sizeCad: 40 };
    fs.writeFileSync(ledgerPath, JSON.stringify(orphan) + "\n");
    await runOnce(baseOpts(sb));
    const entries = readLedger(ledgerPath);
    expect(entries.map((e) => e.decision)).toEqual(["PENDING", "FAILED"]);
    expect(entries[1]!.reasons[0]).toMatch(/ORPHELIN/);
  });

  it("une exécution qui échoue est journalisée FAILED après le PENDING", async () => {
    sb = makeSandbox();
    writeSnapshot(sb.repoRoot, snapshot());
    writeIntent(sb.repoRoot, "f.json", intent({ id: "f" }));
    // priority fee absurde (10 SOL) → frais > montant → le simulateur lève → FAILED
    const r = await runOnce(baseOpts(sb, { market: () => ({ fxCadPerUsd: 1.37, solPriceUsd: 150, priorityFeeSol: 10 }) }));
    expect(r.processed[0]!.decision).toBe("FAILED");
    const entries = readLedger(path.join(sb.repoRoot, "ledger", "trades.jsonl"));
    expect(entries.map((e) => e.decision)).toEqual(["PENDING", "FAILED"]);
  });
});

describe("Exécuteur — mode live", () => {
  let sb: ReturnType<typeof makeSandbox> | undefined;
  afterEach(() => sb?.cleanup());

  const neverCalled: JupiterClient = {
    getQuote: async () => {
      throw new Error("ne doit pas être appelé");
    },
    buildSwapTx: async () => {
      throw new Error("ne doit pas être appelé");
    },
    sendTransaction: async () => {
      throw new Error("ne doit pas être appelé");
    },
  };

  it("refuse sans EXECUTION_MODE=live", async () => {
    sb = makeSandbox();
    fs.writeFileSync(path.join(sb.home, ".crypto-lab", "keypair.json"), JSON.stringify(new Array(64).fill(1)));
    const r = await runOnce({ repoRoot: sb.repoRoot, home: sb.home, env: {}, mode: "live", jupiter: neverCalled, log: () => {} });
    expect(r.error).toMatch(/LIVE_REFUSE.*EXECUTION_MODE/);
  });

  it("refuse sans clé locale", async () => {
    sb = makeSandbox();
    writeIntent(sb.repoRoot, "l.json", intent({ id: "l" }));
    const r = await runOnce({ repoRoot: sb.repoRoot, home: sb.home, env: { EXECUTION_MODE: "live" }, mode: "live", jupiter: neverCalled, log: () => {} });
    expect(r.error).toMatch(/LIVE_REFUSE.*clé locale absente/);
    expect(fs.existsSync(path.join(sb.repoRoot, "intents", "l.json"))).toBe(true);
  });

  it("refuse si le kill switch est actif même avec tout le reste", async () => {
    sb = makeSandbox();
    fs.writeFileSync(path.join(sb.home, ".crypto-lab", "keypair.json"), "[]");
    const r = await runOnce({ repoRoot: sb.repoRoot, home: sb.home, env: { EXECUTION_MODE: "live", CRYPTO_LAB_KILL: "1" }, mode: "live", jupiter: neverCalled, log: () => {} });
    expect(r.killed).toBe(true);
    expect(r.processed).toHaveLength(0);
  });

  it("exécute via un client Jupiter mocké et journalise EXECUTED avec txid", async () => {
    sb = makeSandbox();
    fs.writeFileSync(path.join(sb.home, ".crypto-lab", "keypair.json"), "[]"); // présence vérifiée ; le signer est injecté
    writeSnapshot(sb.repoRoot, snapshot());
    writeIntent(sb.repoRoot, "live1.json", intent({ id: "live1", sizeCad: 40 }));
    const calls: string[] = [];
    const jupiter: JupiterClient = {
      async getQuote(p) {
        calls.push(`quote:${p.inputMint.slice(0, 4)}->${p.outputMint.slice(0, 4)}:${p.amount}`);
        // devis SOL→USDC (cotation réelle de SOL) : 1 SOL = 150 USDC ; sinon devis d'achat du token
        const out = p.outputMint === USDC_MINT ? 150_000_000n : 28_000_000_000n;
        return { inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: out, slippageBps: p.slippageBps, priceImpactPct: 0.1, raw: {} };
      },
      async buildSwapTx() {
        calls.push("build");
        return { swapTransaction: "dHg=" };
      },
      async sendTransaction(tx) {
        calls.push(`send:${tx}`);
        return { txid: "SIG123" };
      },
    };
    const signer: Signer = { publicKey: "PUB", sign: async (tx) => `signed(${tx})` };
    const r = await runOnce({
      repoRoot: sb.repoRoot,
      home: sb.home,
      env: { EXECUTION_MODE: "live" },
      mode: "live",
      jupiter,
      signer,
      verifier: { verify: async (mint, now) => snapshot({ mint, fetchedAt: now.toISOString(), source: "local-verify" }) },
      now: () => NOW,
      market: () => ({ fxCadPerUsd: 1.37, solPriceUsd: 999, priorityFeeSol: 0.0005 }), // solPriceUsd ignoré en live : devis Jupiter
      log: () => {},
    });
    expect(r.error).toBeUndefined();
    expect(r.processed[0]!.decision).toBe("EXECUTED");
    expect(calls).toEqual([`quote:So11->EPjF:1000000000`, `quote:So11->7EYn:${Math.floor((40 / 1.37 / 150) * 1e9)}`, "build", "send:signed(dHg=)"]);
    expect(JSON.parse(fs.readFileSync(path.join(sb.home, ".crypto-lab", "market.json"), "utf8")).solPriceUsd).toBe(150);
    const entries = readLedger(path.join(sb.repoRoot, "ledger", "trades.jsonl"));
    expect(entries.map((e) => e.decision)).toEqual(["PENDING", "EXECUTED"]);
    expect(entries[1]!.fill?.txid).toBe("SIG123");
    expect(entries[1]!.fill?.qty).toBe(28_000); // 28e9 / 10^6 décimales (decimals lus du RPC via le vérificateur)
    expect(entries[1]!.mode).toBe("live");
    expect(entries[1]!.verified).toBe(true);
    expect(entries[1]!.fees?.ataRentCad).toBeGreaterThan(0.3); // nouvelle position : loyer ATA compté
    // les remplissages live ne polluent pas le portefeuille paper
    expect(rebuildPortfolio(entries, { initialCashCad: 700, mode: "paper", timeZone: TZ }).positions).toHaveLength(0);
    expect(rebuildPortfolio(entries, { initialCashCad: 700, mode: "live", timeZone: TZ }).positions[0]!.qty).toBe(28_000);
  });
});

describe("CLI", () => {
  it("analyse les arguments", () => {
    expect(parseArgs(["--once", "--paper"])).toEqual({ once: true, mode: "paper", watchSeconds: 60, unverified: false });
    expect(parseArgs(["--live", "--watch", "30", "--repo", "/x", "--unverified"])).toEqual({ once: false, mode: "live", watchSeconds: 30, repoRoot: "/x", unverified: true });
    expect(parseArgs([]).mode).toBe("paper");
  });
});

describe("Intégrité du code (C1)", () => {
  let sb: ReturnType<typeof makeSandbox> | undefined;
  afterEach(() => sb?.cleanup());

  function fakeCode(root: string): void {
    fs.mkdirSync(path.join(root, "lab", "risk"), { recursive: true });
    fs.writeFileSync(path.join(root, "lab", "risk", "engine.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(root, "lab", "types.ts"), "export type T = 1;\n");
    fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  }

  it("manifeste déterministe, scellement puis vérification : sealed / mismatch (~ + −) / unsealed", () => {
    sb = makeSandbox({}, { seal: false });
    const codeRoot = path.join(sb.root, "code");
    fakeCode(codeRoot);
    const m1 = computeManifest(codeRoot);
    expect(Object.keys(m1.files)).toEqual(["lab/risk/engine.ts", "lab/types.ts", "package.json"]);
    expect(computeManifest(codeRoot).files).toEqual(m1.files);
    expect(verifyIntegrity({ codeRoot, home: sb.home }).status).toBe("unsealed");

    const { manifestPath } = sealManifest({ codeRoot, home: sb.home });
    expect(manifestPath).toBe(path.join(sb.home, ".crypto-lab", "exec.manifest.json"));
    expect(verifyIntegrity({ codeRoot, home: sb.home })).toMatchObject({ status: "sealed", changed: [] });

    fs.appendFileSync(path.join(codeRoot, "lab", "risk", "engine.ts"), "// evil\n");
    fs.writeFileSync(path.join(codeRoot, "lab", "new.ts"), "");
    fs.rmSync(path.join(codeRoot, "lab", "types.ts"));
    const r = verifyIntegrity({ codeRoot, home: sb.home });
    expect(r.status).toBe("mismatch");
    expect(r.changed.sort()).toEqual(["+ lab/new.ts", "~ lab/risk/engine.ts", "− lab/types.ts"].sort());
    fs.writeFileSync(manifestPath, "{ pas du json");
    expect(verifyIntegrity({ codeRoot, home: sb.home }).status).toBe("mismatch");
  });

  it("runOnce : live refusé si non scellé ou altéré ; paper avertit seulement", async () => {
    sb = makeSandbox({}, { seal: false });
    writeSnapshot(sb.repoRoot, snapshot());
    writeIntent(sb.repoRoot, "i.json", intent({ id: "i" }));
    fs.writeFileSync(path.join(sb.home, ".crypto-lab", "keypair.json"), "[]");
    const live = await runOnce({ repoRoot: sb.repoRoot, home: sb.home, env: { EXECUTION_MODE: "live" }, mode: "live", log: () => {} });
    expect(live.error).toMatch(/^CODE_NON_SCELLE/);
    expect(live.integrity?.status).toBe("unsealed");
    const paper = await runOnce({ repoRoot: sb.repoRoot, home: sb.home, env: {}, now: () => NOW, market: () => MK, log: () => {} });
    expect(paper.error).toBeUndefined();
    expect(paper.warnings.join()).toMatch(/code non scellé/);
    expect(paper.processed[0]!.decision).toBe("PAPER");
  });
});

describe("Vérification locale (C3)", () => {
  const info = (o: Partial<MintInfo> = {}): MintInfo => ({
    mint: MINT_A,
    program: "spl-token",
    mintAuthority: null,
    freezeAuthority: null,
    supplyRaw: "1000000",
    decimals: 6,
    isInitialized: true,
    extensions: [],
    top10Pct: 22,
    topAccounts: [],
    excludedCount: 0,
    holders: null,
    riskyExtensions: [],
    fetchedAt: NOW.toISOString(),
    rpcCalls: 3,
    ...o,
  });
  const pair = (o: Partial<DexPair> = {}): DexPair => ({
    chainId: "solana",
    dexId: "raydium",
    url: "u",
    pairAddress: "PAIR1",
    baseToken: { address: MINT_A, name: "Test", symbol: "TST" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
    priceUsd: "0.002",
    liquidity: { usd: 30_000 },
    volume: { m5: 10, h1: 100, h24: 1000 },
    pairCreatedAt: NOW.getTime() - 3600_000,
    ...o,
  });

  it("construit l'instantané depuis le RPC (autorités, décimales, extensions, top10) et la paire la plus liquide", () => {
    const s = buildVerifiedSnapshot(MINT_A, info({ freezeAuthority: "F", riskyExtensions: ["TransferFeeConfig"] }), [pair({ liquidity: { usd: 5 }, pairAddress: "SMALL" }), pair(), pair({ chainId: "ethereum", liquidity: { usd: 1e9 } })], NOW);
    expect(s).toMatchObject({ mint: MINT_A, symbol: "TST", priceUsd: 0.002, liquidityUsd: 30_000, pairAddress: "PAIR1", decimals: 6, freezeAuthority: "F", mintAuthority: null, top10Pct: 22, riskyExtensions: ["TransferFeeConfig"], source: "local-verify", fetchedAt: NOW.toISOString(), volume: { m5: 10, h1: 100, h24: 1000 }, holders: null, dexId: "raydium" });
    expect(s.createdAt).toBe(new Date(NOW.getTime() - 3600_000).toISOString());
    // le Risk Engine rejette l'extension dangereuse
    expect(evaluate(intent(), portfolio(), s, policy(), NOW).reasons.join()).toMatch(/EXTENSION_RISQUEE|FREEZE_AUTHORITY/);
  });

  it("valeurs inconnues → prudence : pas de paire = erreur, âge inconnu = créé maintenant, top10 inconnu = 100 %", () => {
    expect(() => buildVerifiedSnapshot(MINT_A, info(), [pair({ baseToken: { address: MINT_B, name: "", symbol: "" } })], NOW)).toThrow(/aucune paire/);
    expect(() => buildVerifiedSnapshot(MINT_A, info(), [pair({ priceUsd: "0" })], NOW)).toThrow(/prix/);
    const s = buildVerifiedSnapshot(MINT_A, info({ top10Pct: null }), [pair({ pairCreatedAt: undefined })], NOW);
    expect(s.createdAt).toBe(NOW.toISOString());
    expect(s.top10Pct).toBe(100);
    expect(pickBestPair(MINT_A, [])).toBeNull();
  });

  it("createLocalVerifier : mint absent du RPC → erreur (jamais de repli sur le dépôt)", async () => {
    const v = createLocalVerifier({ rpc: async () => ({ value: null }) as never, dex: { getTokenPairs: async () => [pair()] } });
    await expect(v.verify(MINT_A, NOW)).rejects.toThrow(/introuvable/);
  });

  it("runOnce : le vérificateur prime sur data/tokens ; échec de vérification = REJECTED VERIFICATION_IMPOSSIBLE", async () => {
    const sb = makeSandbox();
    try {
      writeSnapshot(sb.repoRoot, snapshot()); // dépôt : tout va bien
      writeIntent(sb.repoRoot, "a.json", intent({ id: "a" }));
      writeIntent(sb.repoRoot, "b.json", intent({ id: "b", mint: MINT_B }));
      let n = 0;
      const verifier = {
        verify: async (mint: string, now: Date) => {
          n++;
          if (mint === MINT_B) throw new Error("RPC 503");
          return snapshot({ mint, mintAuthority: "STILL_THERE", source: "local-verify", fetchedAt: now.toISOString() });
        },
      };
      const r = await runOnce({ repoRoot: sb.repoRoot, home: sb.home, env: {}, now: () => NOW, market: () => MK, verifier, log: () => {} });
      expect(r.processed.map((p) => p.decision)).toEqual(["REJECTED", "REJECTED"]);
      expect(r.processed[0]!.reasons.join()).toMatch(/MINT_AUTHORITY/);
      expect(r.processed[1]!.reasons.join()).toMatch(/VERIFICATION_IMPOSSIBLE: RPC 503/);
      expect(n).toBe(2);
      const entries = readLedger(path.join(sb.repoRoot, "ledger", "trades.jsonl"));
      expect(entries.every((e) => e.verified === true)).toBe(true);
      // requireVerifier sans vérificateur → refus total
      const r2 = await runOnce({ repoRoot: sb.repoRoot, home: sb.home, env: {}, requireVerifier: true, market: () => MK, log: () => {} });
      expect(r2.error).toMatch(/VERIFICATEUR_ABSENT/);
    } finally {
      sb.cleanup();
    }
  });
});

describe("Ledger local, import restrictif, marché (C2, H1)", () => {
  let sb: ReturnType<typeof makeSandbox> | undefined;
  afterEach(() => sb?.cleanup());
  const base = (s: ReturnType<typeof makeSandbox>, extra: Partial<Parameters<typeof runOnce>[0]> = {}) => ({ repoRoot: s.repoRoot, home: s.home, env: {}, now: () => NOW, market: () => MK, log: () => {}, ...extra });

  it("le ledger vit sous ~/.crypto-lab/ledger/ et le dépôt ne reçoit qu'un export identique", async () => {
    sb = makeSandbox();
    writeSnapshot(sb.repoRoot, snapshot());
    writeIntent(sb.repoRoot, "a.json", intent({ id: "a" }));
    await runOnce(base(sb));
    const local = path.join(sb.home, ".crypto-lab", "ledger", "trades.jsonl");
    const exported = path.join(sb.repoRoot, "ledger", "trades.jsonl");
    expect(fs.readFileSync(local, "utf8")).toBe(fs.readFileSync(exported, "utf8"));
    expect(readLedger(local).map((e) => e.seq)).toEqual([1, 2]);
    expect(fs.existsSync(path.join(sb.home, ".crypto-lab", "ledger.key"))).toBe(true);
    // réécrire l'export ne change rien : il est régénéré depuis le local au cycle suivant
    fs.writeFileSync(exported, "");
    await runOnce(base(sb));
    expect(readLedger(exported)).toHaveLength(2);
  });

  it("chaîne rompue dans le ledger local → refus du cycle et KILL local (cliquet)", async () => {
    sb = makeSandbox();
    writeSnapshot(sb.repoRoot, snapshot());
    writeIntent(sb.repoRoot, "a.json", intent({ id: "a" }));
    await runOnce(base(sb));
    const local = path.join(sb.home, ".crypto-lab", "ledger", "trades.jsonl");
    fs.writeFileSync(local, fs.readFileSync(local, "utf8").replace('"decision":"PAPER"', '"decision":"REJECTED"'));
    const r = await runOnce(base(sb));
    expect(r.error).toMatch(/^LEDGER_CHAINE/);
    expect(fs.readFileSync(path.join(sb.home, ".crypto-lab", "KILL"), "utf8")).toMatch(/ledger chain broken/);
    expect((await runOnce(base(sb))).killed).toBe(true);
  });

  it("premier lancement : le ledger du dépôt est importé comme restrictions (pertes, cadence) mais ne crée ni cash ni position", async () => {
    sb = makeSandbox();
    const exported = path.join(sb.repoRoot, "ledger", "trades.jsonl");
    fs.mkdirSync(path.dirname(exported), { recursive: true });
    const gift = ledgerEntry({ intentId: "gift", mint: MINT_B, kind: "SELL", pnlCad: 5000, fill: { priceUsd: 1, fxCadPerUsd: 1.37, qty: 1, grossCad: 5000, netCad: 5000, slippageBps: 0 }, ts: new Date(NOW.getTime() - 3600_000).toISOString() });
    const pos = ledgerEntry({ intentId: "pos", mint: MINT_C, kind: "BUY", ts: new Date(NOW.getTime() - 3600_000).toISOString() });
    const recent = ledgerEntry({ intentId: "recent", mint: MINT_A, kind: "BUY", ts: new Date(NOW.getTime() - 10 * 60_000).toISOString() });
    fs.writeFileSync(exported, [gift, pos, recent].map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeSnapshot(sb.repoRoot, snapshot());
    writeSnapshot(sb.repoRoot, snapshot({ mint: MINT_C }));
    writeIntent(sb.repoRoot, "1.json", intent({ id: "x", sizeCad: 40 }));
    writeIntent(sb.repoRoot, "2.json", intent({ id: "sell-c", kind: "SELL", mint: MINT_C, sizeCad: 40 }));
    writeIntent(sb.repoRoot, "3.json", intent({ id: "big", mint: MINT_C, sizeCad: 50 }));
    const r = await runOnce(base(sb));
    expect(r.warnings.join()).toMatch(/3 ligne\(s\) importée/);
    expect(r.processed.map((p) => p.decision)).toEqual(["REJECTED", "REJECTED", "PAPER"]);
    expect(r.processed[0]!.reasons.join()).toMatch(/CADENCE_MINT/); // l'achat importé sur MINT_A restreint
    expect(r.processed[1]!.reasons.join()).toMatch(/VENTE_SANS_POSITION/); // la position importée n'existe pas
    const local = readLedger(path.join(sb.home, ".crypto-lab", "ledger", "trades.jsonl"));
    expect(local.slice(0, 3).every((e) => e.origin === "repo-import")).toBe(true);
    const pf = rebuildPortfolio(local, { initialCashCad: 700, mode: "paper", timeZone: TZ });
    expect(pf.cashCad).toBe(650); // 700 − 50, aucun cash fictif issu du « cadeau »
  });

  it("marché : valeurs invalides ou écart > 20 % avec la dernière valeur locale → refus du cycle", async () => {
    sb = makeSandbox();
    writeSnapshot(sb.repoRoot, snapshot());
    writeIntent(sb.repoRoot, "a.json", intent({ id: "a" }));
    expect((await runOnce(base(sb, { market: () => ({ fxCadPerUsd: 0, solPriceUsd: 150, priorityFeeSol: 0 }) }))).error).toMatch(/MARCHE_INVALIDE/);
    expect((await runOnce(base(sb, { market: async () => { throw new Error("BoC injoignable"); } }))).error).toMatch(/MARCHE: BoC injoignable/);
    expect((await runOnce(base(sb, { market: () => ({ fxCadPerUsd: 1.37, solPriceUsd: 150, priorityFeeSol: 0.0005 }) }))).error).toBeUndefined();
    const r = await runOnce(base(sb, { market: () => ({ fxCadPerUsd: 1.7, solPriceUsd: 150, priorityFeeSol: 0.0005 }) }));
    expect(r.error).toMatch(/MARCHE_INVRAISEMBLABLE: fxCadPerUsd 1.7 vs dernière valeur locale 1.37/);
    expect(checkMarketPlausibility({ fxCadPerUsd: 1.5, solPriceUsd: 170, priorityFeeSol: 0 }, { fxCadPerUsd: 1.37, solPriceUsd: 150, at: "" })).toBeNull();
    expect(checkMarketPlausibility({ fxCadPerUsd: 1.37, solPriceUsd: 100, priorityFeeSol: 0 }, { fxCadPerUsd: 1.37, solPriceUsd: 150, at: "" })).toMatch(/solPriceUsd/);
    expect(fs.existsSync(path.join(sb.repoRoot, "intents", "a.json"))).toBe(false); // traité au 3e appel
  });

  it("reduce-only de bout en bout : après une perte quotidienne atteinte, le BUY est bloqué mais le SELL passe", async () => {
    sb = makeSandbox();
    writeSnapshot(sb.repoRoot, snapshot());
    writeSnapshot(sb.repoRoot, snapshot({ mint: MINT_C }));
    writeIntent(sb.repoRoot, "0.json", intent({ id: "b0", mint: MINT_C, sizeCad: 50 }));
    writeIntent(sb.repoRoot, "1.json", intent({ id: "b1", sizeCad: 50 }));
    await runOnce(base(sb));
    const t2 = new Date(NOW.getTime() + 2 * 3600_000);
    // effondrement des deux positions : latent ≈ −100 (aucune vente réalisée)
    writeSnapshot(sb.repoRoot, snapshot({ priceUsd: 0.0000001, fetchedAt: t2.toISOString() }));
    writeSnapshot(sb.repoRoot, snapshot({ mint: MINT_C, priceUsd: 0.0000001, fetchedAt: t2.toISOString() }));
    const mk = (i: Partial<Parameters<typeof intent>[0]>) => intent({ createdAt: t2.toISOString(), expiresAt: new Date(t2.getTime() + 600_000).toISOString(), ...i });
    writeIntent(sb.repoRoot, "2.json", mk({ id: "b2", mint: MINT_B, sizeCad: 20 }));
    writeSnapshot(sb.repoRoot, snapshot({ mint: MINT_B, fetchedAt: t2.toISOString() }));
    writeIntent(sb.repoRoot, "3.json", mk({ id: "s1", kind: "SELL", sizeCad: 1000 }));
    const r = await runOnce(base(sb, { now: () => t2, market: () => MK }));
    expect(r.processed.map((p) => `${p.intentId}:${p.decision}`)).toEqual(["b2:REJECTED", "s1:PAPER"]);
    expect(r.processed[0]!.reasons.join()).toMatch(/PERTE_QUOTIDIENNE: -99\.\d+ CAD \(latent -99/);
  });
});
