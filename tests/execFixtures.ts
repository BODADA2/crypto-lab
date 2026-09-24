// Fixtures partagées par les tests. Aucun accès réseau.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LedgerEntry, PortfolioState, RiskPolicy, TokenSnapshot } from "../lab/types.ts";
import { emptyPortfolio } from "../lab/exec/paper.ts";
import { sealManifest } from "../lab/exec/integrity.ts";
import type { IntentV2, RiskPolicyV2 } from "../lab/risk/types.ts";

export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const MINT_A = "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs";
export const MINT_B = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
export const MINT_C = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MINT_D = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const MINT_E = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

/** Jeudi 24 septembre 2026, 15:00 UTC = 12:00 à Moncton (heure avancée, UTC-3). */
export const NOW = new Date("2026-09-24T15:00:00Z");

/** Politique d'exemple (v2). Le type de retour reste `RiskPolicy` tant que lab/types.ts n'a pas absorbé la v2. */
export function policy(overrides: Partial<RiskPolicyV2> = {}): RiskPolicy {
  const base = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "lab", "risk", "policy.example.json"), "utf8")) as RiskPolicyV2;
  return { ...base, ...overrides } as unknown as RiskPolicy;
}

export function snapshot(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  const createdMs = NOW.getTime() - 60 * 60_000; // 1 h d'âge
  return {
    mint: MINT_A,
    chain: "solana",
    symbol: "TEST",
    name: "Test token",
    createdAt: new Date(createdMs).toISOString(),
    pairCreatedAt: createdMs,
    pairAddress: "pair-test",
    dexId: "raydium",
    url: null,
    priceUsd: 0.001,
    liquidityUsd: 50_000,
    fdvUsd: null,
    marketCapUsd: null,
    volume: { m5: 1_000, h1: 10_000, h6: 50_000, h24: 100_000 },
    volume5m: 1_000,
    volume1h: 10_000,
    volume24h: 100_000,
    priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
    txns: { m5: { buys: 5, sells: 5 }, h1: { buys: 50, sells: 50 }, h6: { buys: 250, sells: 250 }, h24: { buys: 500, sells: 500 } },
    holders: 1_200,
    top10Pct: 25,
    mintAuthority: null,
    freezeAuthority: null,
    boostsActive: 0,
    pairCount: 1,
    source: "fixture",
    fetchedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    decimals: 6,
    ...overrides,
  };
}

/** Intent v2 : `signalTs` par défaut = 1 min avant `createdAt` (celui des overrides s'il est fourni). */
export function intent(overrides: Partial<IntentV2> = {}): IntentV2 {
  const createdAt = overrides.createdAt ?? new Date(NOW.getTime() - 5 * 60_000).toISOString();
  const createdMs = Date.parse(createdAt);
  return {
    id: "int-1",
    createdAt,
    signalTs: new Date((Number.isFinite(createdMs) ? createdMs : NOW.getTime()) - 60_000).toISOString(),
    kind: "BUY",
    mint: MINT_A,
    sizeCad: 40,
    maxSlippageBps: 200,
    thesis: "test",
    signals: ["fixture"],
    invalidation: "test",
    expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
    ...overrides,
  };
}

export function portfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return { ...emptyPortfolio(700), ...overrides };
}

export function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    intentId: "old-1",
    mint: MINT_B,
    kind: "BUY",
    decision: "PAPER",
    mode: "paper",
    reasons: [],
    requestedSizeCad: 40,
    sizeCad: 40,
    fill: { priceUsd: 0.001, fxCadPerUsd: 1.37, qty: 28_000, grossCad: 40, netCad: 39.4, slippageBps: 200 },
    fees: { platformCad: 0.4, swapCad: 0.12, priorityCad: 0.1, totalCad: 0.62 },
    ...overrides,
  };
}

/**
 * Crée un faux dépôt + faux HOME dans un dossier temporaire, avec la politique d'exemple installée localement et le
 * manifeste d'intégrité scellé pour le code réel (comme si Hervé avait lancé `seal.ts`). `seal: false` pour un HOME non scellé.
 */
export function makeSandbox(policyOverrides: Partial<RiskPolicyV2> = {}, opts: { seal?: boolean } = {}): { root: string; repoRoot: string; home: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crypto-lab-"));
  const repoRoot = path.join(root, "repo");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(repoRoot, "intents"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "data", "tokens"), { recursive: true });
  fs.mkdirSync(path.join(home, ".crypto-lab"), { recursive: true });
  fs.writeFileSync(path.join(home, ".crypto-lab", "risk.policy.json"), JSON.stringify(policy(policyOverrides), null, 2));
  if (opts.seal !== false) sealManifest({ codeRoot: REPO_ROOT, home });
  return { root, repoRoot, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function writeIntent(repoRoot: string, name: string, data: unknown): void {
  fs.writeFileSync(path.join(repoRoot, "intents", name), typeof data === "string" ? data : JSON.stringify(data));
}

export function writeSnapshot(repoRoot: string, snap: TokenSnapshot): void {
  fs.writeFileSync(path.join(repoRoot, "data", "tokens", `${snap.mint}.json`), JSON.stringify(snap));
}
