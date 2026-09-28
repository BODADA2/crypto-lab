/**
 * Feeds read-only : DexScreener (candidats, liquidité, vélocité proxy)
 * + Helius (authorities via DAS getAsset, holders via getTokenLargestAccounts).
 * Réutilise l'auth sécurisée du skill (aucune clé en clair).
 */
import { createHeliusClient } from "../collect/helius.ts";
import { getHeliusRpcUrl } from "../collect/helius-auth.ts";
import type { TokenSnapshot } from "./types.ts";

const DEX = "https://api.dexscreener.com";

interface DexPair {
  dexId: string;
  baseToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { m5?: number };
  txns?: { m5?: { buys?: number; sells?: number } };
  labels?: string[];
  pairCreatedAt?: number;
}

export async function fetchLatestSolanaMints(limit: number): Promise<string[]> {
  const res = await fetch(`${DEX}/token-profiles/latest/v1`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`DexScreener profiles HTTP ${res.status}`);
  const arr = (await res.json()) as Array<{ chainId: string; tokenAddress: string }>;
  return arr.filter((p) => p.chainId === "solana").slice(0, limit).map((p) => p.tokenAddress);
}

export async function fetchDexPairs(mints: string[]): Promise<Map<string, DexPair[]>> {
  const out = new Map<string, DexPair[]>();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    const res = await fetch(`${DEX}/tokens/v1/solana/${batch.join(",")}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`DexScreener tokens HTTP ${res.status}`);
    const arr = (await res.json()) as DexPair[];
    for (const p of arr) {
      const m = p.baseToken.address;
      if (!out.has(m)) out.set(m, []);
      out.get(m)!.push(p);
    }
  }
  return out;
}

interface DasAsset {
  authorities?: Array<{ address: string; scopes: string[] }>;
}

interface LargestAccounts {
  value: Array<{ address: string; amount: string; decimals: number }>;
}

interface TokenSupply {
  value: { amount: string; decimals: number };
}

export interface EnrichedSnapshot extends TokenSnapshot {
  heliusCredits: number;
}

export interface FeedOptions {
  maxCandidates: number;
  /** Cap Helius par run (indicatif). */
  maxHeliusCredits: number;
  /** minInterval entre appels Helius (ms). */
  heliusIntervalMs?: number;
}

export async function buildSnapshots(opts: FeedOptions): Promise<EnrichedSnapshot[]> {
  const mints = await fetchLatestSolanaMints(opts.maxCandidates);
  if (mints.length === 0) return [];
  const pairsByMint = await fetchDexPairs(mints);

  const rpcUrl = getHeliusRpcUrl();
  const helius = createHeliusClient({
    fetch: fetch as never,
    rpcUrl,
    minIntervalMs: opts.heliusIntervalMs ?? 120,
    creditTable: { getAsset: 10, getTokenLargestAccounts: 1, getTokenSupply: 1 },
  });

  const snapshots: EnrichedSnapshot[] = [];

  for (const mint of mints) {
    const pairs = pairsByMint.get(mint) ?? [];
    if (pairs.length === 0) continue;

    // Meilleure paire = plus grosse liquidité
    const best = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const liquidityUsd = best.liquidity?.usd ?? null;
    const priceUsd = best.priceUsd ? Number(best.priceUsd) : 0;
    const ticker = best.baseToken.symbol || "UNKNOWN";

    // Pré-filtre gratuit : liquidité < 8000 → pas un crédit Helius dépensé
    if (liquidityUsd == null || liquidityUsd < 8000) continue;
    if (helius.credits >= opts.maxHeliusCredits) break;

    const migrated: boolean | null = pairs.some((p) => p.dexId !== "pumpfun")
      ? true
      : pairs.every((p) => p.dexId === "pumpfun")
        ? false
        : null;

    // --- Helius : authorities ---
    let mintAuthority: string | null = null;
    let freezeAuthority: string | null = null;
    try {
      const asset = await helius.rpc<DasAsset>("getAsset", [mint]);
      const auths = asset.authorities ?? [];
      if (auths.some((a) => a.scopes.includes("full"))) mintAuthority = "active";
      if (auths.some((a) => a.scopes.includes("freeze"))) freezeAuthority = "active";
    } catch {
      mintAuthority = "unknown-error";
      freezeAuthority = "unknown-error";
    }

    // --- Helius : holders ---
    let top10Raw: number | null = null;
    let top10Adj: number | null = null;
    let exclusionMethod = "none";
    try {
      const [largest, supply] = await Promise.all([
        helius.rpc<LargestAccounts>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]),
        helius.rpc<TokenSupply>("getTokenSupply", [mint, { commitment: "confirmed" }]),
      ]);
      const total = Number(supply.value.amount) / 10 ** supply.value.decimals;
      const amounts = largest.value
        .map((h) => Number(h.amount) / 10 ** h.decimals)
        .sort((a, b) => b - a);
      if (total > 0 && amounts.length > 0) {
        const pct = (arr: number[]) => (arr.reduce((s, x) => s + x, 0) / total) * 100;
        top10Raw = pct(amounts.slice(0, 10));
        // Heuristique v1 : le plus gros holder >40% = curve/LP → exclu de l'ajusté
        if (amounts[0] / total > 0.4) {
          top10Adj = pct(amounts.slice(1, 11));
          exclusionMethod = "v1-heuristic: largest>40% exclu (curve/LP probable)";
        } else {
          top10Adj = top10Raw;
          exclusionMethod = "v1-heuristic: aucun holder >40%, pas d'exclusion";
        }
      }
    } catch {
      exclusionMethod = "erreur-holders";
    }

    const velocityUsd2min = best.volume?.m5 ?? null;

    snapshots.push({
      mint,
      ticker,
      priceUsd,
      liquidityUsd,
      migrated,
      lpBurnedOrLocked: null, // v1 : non vérifié → fail-open seulement si non migré
      mintAuthority: mintAuthority === "active" ? "active" : mintAuthority === "unknown-error" ? "unknown" : null,
      freezeAuthority: freezeAuthority === "active" ? "active" : freezeAuthority === "unknown-error" ? "unknown" : null,
      top10HolderPctRaw: top10Raw,
      top10HolderPctAdj: top10Adj,
      holderExclusionMethod: exclusionMethod,
      velocityUsd2min,
      velocityMethod: "dexscreener-m5-proxy",
      curveProgressPct: null,
      curveAccelPct: null,
      narrativeTags: (best.labels ?? []).filter((l) => l.toUpperCase() !== "MEME"),
      smartWalletNetBuyUsd: null, // v1 : pas de source
      dataQuality: 0.85,
      timestamp: Date.now(),
      heliusCredits: helius.credits,
    });
  }

  return snapshots;
}
