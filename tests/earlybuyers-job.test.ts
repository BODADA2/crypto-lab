/**
 * Tests d'orchestration du job early-buyers (client Helius simulé, aucun réseau).
 * Vérifie : cache, garde-fous crédits (run + mensuel), arrêt propre, phase ventes.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runEarlyBuyersJob } from "../lab/signals/run-earlybuyers.ts";
import type { HeliusClient, EarlyBuyersResult, WalletHistoryResult } from "../lab/collect/helius.ts";
import type { PumpEvent } from "../lab/collect/types.ts";

const NOW = new Date("2026-09-28T12:00:00Z").getTime();
const now = () => NOW;
const OLD_MIGRATE = "2026-09-27T10:00:00.000Z"; // fenêtre 5 min largement écoulée
const NEW_MIGRATE = new Date(NOW - 60_000).toISOString(); // il y a 1 min : fenêtre non écoulée

function makeBuyers(mint: string, n = 10) {
  return Array.from({ length: n }, (_, i) => ({
    wallet: `wallet${i}_${mint.slice(0, 4)}`,
    signature: `sig${i}`,
    blockTime: 1_790_330_000 + i,
    slot: 1000 + i,
    rank: i,
    amountRaw: String(1000 * (n - i)),
  }));
}

/** Client Helius simulé : coûts fixes, données fabriquées. */
function mockHelius(opts: { failOn?: string[] } = {}): HeliusClient & { calls: string[] } {
  let credits = 0;
  const calls: string[] = [];
  const failOn = new Set(opts.failOn ?? []);
  const client = {
    calls,
    get credits() {
      return credits;
    },
    get requestCount() {
      return calls.length;
    },
    async rpc<T>(): Promise<T> {
      throw new Error("non implémenté dans le mock");
    },
    async getSignaturesForAddress() {
      credits += 1;
      calls.push("sigs");
      return [];
    },
    async getTransaction() {
      credits += 1;
      calls.push("tx");
      return null;
    },
    async getEarlyBuyers(mint: string, n = 50, o: { maxPages?: number; maxTransactions?: number } = {}): Promise<EarlyBuyersResult> {
      if (failOn.has(mint)) throw new Error("Helius simulé en panne");
      credits += 61; // coût réaliste mesuré sur le token de référence
      calls.push(`earlybuyers:${mint}:pages=${o.maxPages ?? "def"}`);
      const buyers = makeBuyers(mint, Math.min(n, 10));
      return { mint, buyers, signaturesScanned: 10000, transactionsRead: buyers.length + 1, truncated: true, skippedTx: 0, credits: 61 };
    },
    async getWalletTokenHistory(address: string, o: { limit?: number } = {}): Promise<WalletHistoryResult> {
      const limit = o.limit ?? 20;
      credits += 1 + Math.min(limit, 5);
      calls.push(`history:${address}`);
      return { address, events: [], signaturesScanned: 5, transactionsRead: 5, skippedTx: 0, credits: 1 + Math.min(limit, 5) };
    },
  };
  return client as unknown as HeliusClient & { calls: string[] };
}

function writeScans(dataDir: string, mints: Array<{ mint: string; receivedAt: string }>) {
  const scansDir = join(dataDir, "scans");
  mkdirSync(scansDir, { recursive: true });
  const lines = mints.map(
    (m) => JSON.stringify({ kind: "migrate", mint: m.mint, receivedAt: m.receivedAt } as PumpEvent) + "\n",
  );
  writeFileSync(join(scansDir, "pump-2026-09-28.jsonl"), lines.join(""));
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "eb-job-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("runEarlyBuyersJob", () => {
  it("backfill : récupère, calcule les métriques, met en cache, compte les crédits", async () => {
    writeScans(dataDir, [
      { mint: "mintA", receivedAt: OLD_MIGRATE },
      { mint: "mintB", receivedAt: OLD_MIGRATE },
    ]);
    const helius = mockHelius();
    const r = await runEarlyBuyersJob({ dataDir, helius, maxTokens: 50, now, skipOverlap: true });
    expect(r.fetched).toBe(2);
    expect(r.credits).toBe(2 * 61 + 2 * 10 * 6); // acheteurs + ventes (10 wallets × 6 crédits)
    expect(r.sellsComputed).toBe(2);
    expect(r.stoppedEarly).toBeNull();
    for (const mint of ["mintA", "mintB"]) {
      const cached = JSON.parse(readFileSync(join(dataDir, "earlybuyers", `${mint}.json`), "utf8"));
      expect(cached.metrics.top5_share).toBeGreaterThan(0);
      expect(cached.metrics.gini).toBeGreaterThanOrEqual(0);
      expect(cached.sells).toBeDefined();
      expect(cached.migratedAt).toBe(OLD_MIGRATE);
    }
    const meta = JSON.parse(readFileSync(join(dataDir, "meta.json"), "utf8"));
    expect(meta.heliusCreditsMonth).toBe(r.credits);
  });

  it("arrêt propre quand le plafond du run est atteint (2e token non engagé)", async () => {
    writeScans(dataDir, [
      { mint: "mintA", receivedAt: OLD_MIGRATE },
      { mint: "mintB", receivedAt: OLD_MIGRATE },
    ]);
    const helius = mockHelius();
    // mintA s'engage (0 + 650 ≤ 700), coûte 61 ; mintB bloqué (61 + 650 > 700, borne haute)
    const r = await runEarlyBuyersJob({ dataDir, helius, maxTokens: 50, now, skipOverlap: true, maxCredits: 700, withSells: false });
    expect(r.fetched).toBe(1);
    expect(r.stoppedEarly).toMatch(/plafond/);
    // readMigrations renvoie le plus récent d'abord : un seul des deux est en cache
    expect(readdirSync(join(dataDir, "earlybuyers")).length).toBe(1);
  });

  it("plafond mensuel déjà atteint : rien n'est fait", async () => {
    writeScans(dataDir, [{ mint: "mintA", receivedAt: OLD_MIGRATE }]);
    writeFileSync(join(dataDir, "meta.json"), JSON.stringify({ heliusMonth: "2026-09", heliusCreditsMonth: 500000 }));
    const helius = mockHelius();
    const r = await runEarlyBuyersJob({ dataDir, helius, maxTokens: 50, now, monthlyCap: 400000 });
    expect(r.fetched).toBe(0);
    expect(r.credits).toBe(0);
    expect(r.stoppedEarly).toMatch(/mensuel/);
    expect(helius.calls.length).toBe(0);
  });

  it("cache : 2e run ne refetch pas, métriques calculées gratuitement", async () => {
    writeScans(dataDir, [{ mint: "mintA", receivedAt: OLD_MIGRATE }]);
    const h1 = mockHelius();
    const r1 = await runEarlyBuyersJob({ dataDir, helius: h1, maxTokens: 50, now, skipOverlap: true, withSells: false });
    expect(r1.fetched).toBe(1);
    // Simule un cache ancien sans métriques (comme le fichier historique)
    const cachePath = join(dataDir, "earlybuyers", "mintA.json");
    const old = JSON.parse(readFileSync(cachePath, "utf8"));
    delete old.metrics;
    writeFileSync(cachePath, JSON.stringify(old));
    const h2 = mockHelius();
    const r2 = await runEarlyBuyersJob({ dataDir, helius: h2, maxTokens: 50, now, skipOverlap: true, withSells: false });
    expect(r2.fetched).toBe(0);
    expect(r2.credits).toBe(0);
    expect(r2.metricsComputed).toBe(1);
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cached.metrics.buyerCount).toBe(10);
  });

  it("ventes ignorées si la fenêtre post-migration n'est pas écoulée", async () => {
    writeScans(dataDir, [{ mint: "mintA", receivedAt: NEW_MIGRATE }]);
    const helius = mockHelius();
    const r = await runEarlyBuyersJob({ dataDir, helius, maxTokens: 50, now, skipOverlap: true });
    expect(r.fetched).toBe(1);
    expect(r.sellsComputed).toBe(0);
    const cached = JSON.parse(readFileSync(join(dataDir, "earlybuyers", "mintA.json"), "utf8"));
    expect(cached.sells).toBeUndefined();
    expect(cached.metrics).toBeDefined();
  });

  it("erreur Helius sur un token : les autres continuent", async () => {
    writeScans(dataDir, [
      { mint: "mintA", receivedAt: OLD_MIGRATE },
      { mint: "mintB", receivedAt: OLD_MIGRATE },
    ]);
    const helius = mockHelius({ failOn: ["mintB"] });
    const r = await runEarlyBuyersJob({ dataDir, helius, maxTokens: 50, now, skipOverlap: true, withSells: false });
    expect(r.fetched).toBe(1);
    expect(existsSync(join(dataDir, "earlybuyers", "mintA.json"))).toBe(true);
    expect(existsSync(join(dataDir, "earlybuyers", "mintB.json"))).toBe(false);
  });

  it("maxPages est propagé à getEarlyBuyers (anti-troncature)", async () => {
    writeScans(dataDir, [{ mint: "mintA", receivedAt: OLD_MIGRATE }]);
    const helius = mockHelius();
    await runEarlyBuyersJob({ dataDir, helius, maxTokens: 50, now, skipOverlap: true, withSells: false, maxPages: 60 });
    expect(helius.calls).toContain("earlybuyers:mintA:pages=60");
  });

  it("maxPages vaut 10 par défaut", async () => {
    writeScans(dataDir, [{ mint: "mintA", receivedAt: OLD_MIGRATE }]);
    const helius = mockHelius();
    await runEarlyBuyersJob({ dataDir, helius, maxTokens: 50, now, skipOverlap: true, withSells: false });
    expect(helius.calls).toContain("earlybuyers:mintA:pages=10");
  });

  it("requireHistoryT0 : ignore les mints sans t0 valide avant tout appel payant", async () => {
    writeScans(dataDir, [
      { mint: "mintWithT0", receivedAt: OLD_MIGRATE },
      { mint: "mintNoHistory", receivedAt: OLD_MIGRATE },
      { mint: "mintNoT0", receivedAt: OLD_MIGRATE },
    ]);
    // Historique valide : premier snapshot priceUsd > 0 et liquidityUsd >= 20000.
    mkdirSync(join(dataDir, "history"), { recursive: true });
    writeFileSync(
      join(dataDir, "history", "mintWithT0.jsonl"),
      JSON.stringify({ fetchedAt: "2026-09-27T10:00:00.000Z", priceUsd: 0.001, liquidityUsd: 30000 }) + "\n",
    );
    // Série présente mais aucun snapshot valide (prix nul / liquidité insuffisante).
    writeFileSync(
      join(dataDir, "history", "mintNoT0.jsonl"),
      JSON.stringify({ fetchedAt: "2026-09-27T10:00:00.000Z", priceUsd: 0, liquidityUsd: 100 }) + "\n",
    );
    const helius = mockHelius();
    const r = await runEarlyBuyersJob({
      dataDir,
      helius,
      maxTokens: 50,
      now,
      skipOverlap: true,
      withSells: false,
      requireHistoryT0: true,
    });
    expect(r.fetched).toBe(1);
    expect(existsSync(join(dataDir, "earlybuyers", "mintWithT0.json"))).toBe(true);
    expect(existsSync(join(dataDir, "earlybuyers", "mintNoHistory.json"))).toBe(false);
    expect(existsSync(join(dataDir, "earlybuyers", "mintNoT0.json"))).toBe(false);
    expect(helius.calls.filter((c) => c.startsWith("earlybuyers:"))).toHaveLength(1);
  });
});
