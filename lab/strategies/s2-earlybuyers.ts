/**
 * S2 — Entrée groupée de wallets suivis.
 *
 * Les wallets suivis sont les profils `data/wallets/<address>.json` produits par lab/signals/earlybuyers.ts
 * (récurrence parmi les premiers acheteurs de tokens gradués). BUY si au moins `minWallets` (défaut 2) wallets
 * suivis DISTINCTS achètent le même token dans une fenêtre glissante de `windowMin` (défaut 10) minutes, la
 * fenêtre se terminant au plus `maxAgeMin` (défaut 30) minutes avant `now` (un regroupement d'hier n'est pas un
 * signal d'aujourd'hui). Seuls les achats ≤ now comptent (pas de lookahead).
 * Filtres : liquidité ≥ minLiquidityUsd, prix connu.
 * Force : 50 + 10 par wallet au-delà du minimum, pondérée par le score moyen des wallets (0–100).
 * Invalidation : un des wallets du groupe ressort (vente observée) ou prix < stop.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clamp, type ObservedBuy, type Strategy, type StrategyInput, type StrategySignal, type TrackedWallet } from "./types.ts";

export interface S2Params {
  /** Nombre minimal de wallets suivis distincts dans la fenêtre (défaut 2). */
  minWallets: number;
  /** Largeur de la fenêtre glissante en minutes (défaut 10). */
  windowMin: number;
  /** Âge maximal (minutes) de la fin du regroupement par rapport à `now` (défaut 30). */
  maxAgeMin: number;
  minLiquidityUsd: number;
  /** Score minimal d'un wallet suivi pour compter (défaut 0 = tous les profils). */
  minWalletScore: number;
  stopPct: number;
  targetPct: number;
}

export const S2_DEFAULTS: S2Params = {
  minWallets: 2,
  windowMin: 10,
  maxAgeMin: 30,
  minLiquidityUsd: 20_000,
  minWalletScore: 0,
  stopPct: 0.3,
  targetPct: 0.6,
};

export interface WalletCluster {
  wallets: string[];
  /** Début et fin du regroupement (epoch ms). */
  startTs: number;
  endTs: number;
}

/**
 * Plus grand regroupement de wallets suivis distincts dans une fenêtre de `windowMs` parmi les achats ≤ now.
 * À égalité, le plus récent. Null si aucun achat suivi.
 */
export function findWalletCluster(buys: ObservedBuy[], tracked: Set<string>, windowMs: number, now: number): WalletCluster | null {
  const events = buys
    .filter((b) => tracked.has(b.wallet) && Number.isFinite(b.ts) && b.ts <= now)
    .sort((a, b) => a.ts - b.ts);
  if (events.length === 0) return null;
  let best: WalletCluster | null = null;
  for (let i = 0; i < events.length; i++) {
    const start = events[i]!.ts;
    const seen = new Map<string, number>();
    for (let j = i; j < events.length && events[j]!.ts - start <= windowMs; j++) {
      const e = events[j]!;
      if (!seen.has(e.wallet)) seen.set(e.wallet, e.ts);
    }
    const wallets = Array.from(seen.keys());
    const endTs = Math.max(...Array.from(seen.values()));
    if (!best || wallets.length > best.wallets.length || (wallets.length === best.wallets.length && endTs > best.endTs)) {
      best = { wallets, startTs: start, endTs };
    }
  }
  return best;
}

/** Lit `data/wallets/*.json` (WalletProfile) → wallets suivis. Fichiers illisibles ignorés. */
export function loadTrackedWallets(walletsDir: string): TrackedWallet[] {
  if (!existsSync(walletsDir)) return [];
  const out: TrackedWallet[] = [];
  for (const f of readdirSync(walletsDir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const p = JSON.parse(readFileSync(join(walletsDir, f), "utf8")) as { address?: unknown; score?: unknown };
      if (typeof p.address === "string" && p.address.length > 0) {
        out.push({ address: p.address, score: typeof p.score === "number" && Number.isFinite(p.score) ? p.score : 0 });
      }
    } catch {
      /* fichier corrompu : ignoré */
    }
  }
  return out;
}

export function createS2EarlyBuyers(overrides: Partial<S2Params> = {}): Strategy {
  const p: S2Params = { ...S2_DEFAULTS, ...overrides };
  return {
    id: "s2-earlybuyers",
    version: "1.0.0",
    family: "memecoin",
    describe: () =>
      `≥ ${p.minWallets} wallets suivis (score ≥ ${p.minWalletScore}) achètent le même token en ${p.windowMin} min, regroupement âgé de ≤ ${p.maxAgeMin} min, liquidité ≥ ${p.minLiquidityUsd} $ ; stop −${p.stopPct * 100} %, objectif +${p.targetPct * 100} %`,
    signals(input: StrategyInput): StrategySignal[] {
      const snap = input.snapshot ?? input.history[input.history.length - 1] ?? null;
      if (!snap || snap.priceUsd <= 0) return [];
      if (snap.liquidityUsd < p.minLiquidityUsd) return [];
      const trackedList = (input.trackedWallets ?? []).filter((w) => w.score >= p.minWalletScore);
      if (trackedList.length === 0 || !input.buys || input.buys.length === 0) return [];
      const tracked = new Set(trackedList.map((w) => w.address));
      const cluster = findWalletCluster(input.buys, tracked, p.windowMin * 60_000, input.now);
      if (!cluster || cluster.wallets.length < p.minWallets) return [];
      if (input.now - cluster.endTs > p.maxAgeMin * 60_000) return [];
      const scoreOf = new Map(trackedList.map((w) => [w.address, w.score] as const));
      const avgScore = cluster.wallets.reduce((s, w) => s + (scoreOf.get(w) ?? 0), 0) / cluster.wallets.length;
      const base = 50 + 10 * (cluster.wallets.length - p.minWallets);
      const strength = Math.round(clamp(base * (0.5 + avgScore / 200), 0, 100));
      const stop = snap.priceUsd * (1 - p.stopPct);
      return [
        {
          strategyId: "s2-earlybuyers",
          strategyVersion: "1.0.0",
          mint: snap.mint,
          side: "BUY",
          strength,
          reasons: [
            `${cluster.wallets.length} wallets suivis entrés entre ${new Date(cluster.startTs).toISOString()} et ${new Date(cluster.endTs).toISOString()} (fenêtre ${p.windowMin} min)`,
            `wallets : ${cluster.wallets.join(", ")}`,
            `score moyen des wallets ${avgScore.toFixed(0)}/100`,
            `liquidité ${snap.liquidityUsd.toFixed(0)} $`,
          ],
          invalidation: `un wallet du groupe vend, ou prix < ${stop.toPrecision(4)} (−${p.stopPct * 100} %)`,
          proposedStop: stop,
          proposedTarget: snap.priceUsd * (1 + p.targetPct),
          refPrice: snap.priceUsd,
          ts: new Date(input.now).toISOString(),
        },
      ];
    },
  };
}
