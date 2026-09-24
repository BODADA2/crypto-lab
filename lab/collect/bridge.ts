/**
 * Enrichissement on-chain d'un TokenSnapshot (type unique, `lab/types.ts`).
 *
 * Avant le chantier 1, ce fichier convertissait le snapshot « collecte » vers le snapshot « risque ». Il n'y a plus
 * qu'un type : ce module applique seulement ce qu'un `MintInfo` (lab/collect/mintinfo.ts) apporte de plus que
 * DexScreener — autorités réelles (null = révoquée, sinon adresse), `top10Pct`, `decimals`, `riskyExtensions`,
 * `holders` s'il est fourni. Sans enrichissement, le snapshot garde ses inconnus explicites et conservateurs
 * (autorités "UNKNOWN", top10 100, holders null) ⇒ refus du Risk Engine tant que rien n'a été vérifié.
 */
import { UNKNOWN_AUTHORITY, type TokenSnapshot } from "../types.ts";
import type { MintInfo } from "./mintinfo.ts";

export { UNKNOWN_AUTHORITY };

export interface OnChainEnrichment {
  holders?: number | null;
  top10Pct?: number | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  decimals?: number;
  riskyExtensions?: string[];
}

/** Convertit un MintInfo en enrichissement ; les champs manquants restent absents (→ valeurs conservatrices). */
export function enrichmentFromMintInfo(info: MintInfo | null | undefined): OnChainEnrichment {
  if (!info) return {};
  const e: OnChainEnrichment = {
    mintAuthority: info.mintAuthority,
    freezeAuthority: info.freezeAuthority,
    decimals: info.decimals,
    riskyExtensions: [...info.riskyExtensions],
  };
  if (info.top10Pct !== null) e.top10Pct = info.top10Pct;
  if (typeof info.holders === "number") e.holders = info.holders;
  return e;
}

/** Applique l'enrichissement on-chain à un snapshot (copie ; l'original n'est pas modifié). */
export function enrichSnapshot(s: TokenSnapshot, enrich: OnChainEnrichment | MintInfo = {}): TokenSnapshot {
  const e: OnChainEnrichment = "supplyRaw" in enrich ? enrichmentFromMintInfo(enrich) : enrich;
  const out: TokenSnapshot = {
    ...s,
    volume: { ...s.volume },
    volume5m: s.volume.m5,
    volume1h: s.volume.h1,
    volume24h: s.volume.h24,
    priceChange: { ...s.priceChange },
    txns: { m5: { ...s.txns.m5 }, h1: { ...s.txns.h1 }, h6: { ...s.txns.h6 }, h24: { ...s.txns.h24 } },
    holders: typeof e.holders === "number" ? e.holders : s.holders,
    top10Pct: typeof e.top10Pct === "number" && Number.isFinite(e.top10Pct) ? e.top10Pct : s.top10Pct,
    mintAuthority: e.mintAuthority !== undefined ? e.mintAuthority : s.mintAuthority,
    freezeAuthority: e.freezeAuthority !== undefined ? e.freezeAuthority : s.freezeAuthority,
  };
  if (e.decimals !== undefined) out.decimals = e.decimals;
  else if (s.decimals !== undefined) out.decimals = s.decimals;
  if (e.riskyExtensions !== undefined) out.riskyExtensions = [...e.riskyExtensions];
  else if (s.riskyExtensions !== undefined) out.riskyExtensions = [...s.riskyExtensions];
  return out;
}

/** Ancien nom (pont collecte → risque). Conservé pour les appelants existants ; identique à `enrichSnapshot`. */
export const toRiskSnapshot = enrichSnapshot;
