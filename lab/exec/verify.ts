// Re-vérification locale (C3). L'exécuteur ne fait confiance à aucun instantané du dépôt : avant tout ordre il construit
// son PROPRE TokenSnapshot depuis le RPC Solana (autorités, décimales, extensions, top 10) et DexScreener (prix,
// liquidité, âge de la paire), horodaté par sa propre horloge. Les clients sont injectés : aucun appel réseau en test.

import { fetchMintInfo, type JsonRpc, type MintInfo } from "../collect/mintinfo.ts";
import { createDexScreenerClient, pairToSnapshot, type DexPair, type DexScreenerClient } from "../collect/dexscreener.ts";
import type { TokenSnapshot } from "../types.ts";

export interface LocalVerifier {
  /** Lève si la vérification est impossible (réseau, mint inconnu, aucune paire). */
  verify(mint: string, now: Date): Promise<TokenSnapshot>;
}

export type DexPairsSource = Pick<DexScreenerClient, "getTokenPairs">;

/** Choisit la paire Solana la plus liquide dont le baseToken est le mint. */
export function pickBestPair(mint: string, pairs: readonly DexPair[]): DexPair | null {
  const candidates = pairs.filter((p) => p && p.chainId === "solana" && p.baseToken?.address === mint);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
}

/** Construit l'instantané vérifié. Pure : testable avec des fixtures. */
export function buildVerifiedSnapshot(mint: string, info: MintInfo, pairs: readonly DexPair[], now: Date): TokenSnapshot {
  const pair = pickBestPair(mint, pairs);
  if (!pair) throw new Error(`aucune paire DexScreener pour ${mint}`);
  const priceUsd = Number(pair.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error(`prix DexScreener invalide pour ${mint}`);
  // Âge inconnu → on considère le token créé à l'instant (rejeté par AGE_MIN) plutôt que de deviner.
  const fetchedAt = now.toISOString();
  const createdAt = typeof pair.pairCreatedAt === "number" && pair.pairCreatedAt > 0 ? new Date(pair.pairCreatedAt).toISOString() : fetchedAt;
  // Champs de marché : ceux de la paire retenue (jamais du dépôt) ; champs on-chain : ceux du RPC.
  const market = pairToSnapshot(pair, fetchedAt);
  return {
    ...market,
    mint,
    symbol: pair.baseToken.symbol ?? "",
    createdAt,
    priceUsd,
    holders: typeof info.holders === "number" ? info.holders : null, // non fourni par ces sources → inconnu explicite
    top10Pct: info.top10Pct ?? 100, // offre nulle ou inconnue → concentration maximale (rejet)
    mintAuthority: info.mintAuthority,
    freezeAuthority: info.freezeAuthority,
    source: "local-verify",
    fetchedAt,
    decimals: info.decimals,
    riskyExtensions: [...info.riskyExtensions],
  };
}

export function createLocalVerifier(deps: { rpc: JsonRpc; dex: DexPairsSource }): LocalVerifier {
  return {
    async verify(mint, now) {
      const [info, pairs] = await Promise.all([fetchMintInfo(deps.rpc, mint, { now: () => now.getTime() }), deps.dex.getTokenPairs(mint)]);
      if (!info) throw new Error(`mint ${mint} introuvable sur le RPC`);
      if (!info.isInitialized) throw new Error(`mint ${mint} non initialisé`);
      return buildVerifiedSnapshot(mint, info, pairs, now);
    },
  };
}

/** JSON-RPC Solana minimal sur fetch natif. */
export function jsonRpcFromFetch(rpcUrl: string, fetchImpl: typeof fetch = fetch): JsonRpc {
  return async <T = unknown>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`RPC ${method} : ${body.error.message ?? "erreur"}`);
    return body.result as T;
  };
}

/** Vérificateur réel (jamais instancié en test). */
export function createDefaultVerifier(rpcUrl: string, fetchImpl: typeof fetch = fetch): LocalVerifier {
  return createLocalVerifier({
    rpc: jsonRpcFromFetch(rpcUrl, fetchImpl),
    dex: createDexScreenerClient({ fetch: (input, init) => fetchImpl(input, init) }),
  });
}
