/**
 * Extraction de tickers (`$PEPE`) et d'adresses base58 (mints Solana, 32–44 caractères)
 * dans du texte libre (Reddit, GitHub, noms de tokens).
 */

/** Alphabet base58 Bitcoin/Solana : sans 0, O, I, l. */
export const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
/** Ticker précédé de `$` : 2 à 10 lettres majuscules (accepte les chiffres après la première lettre). */
export const TICKER_RE = /\$([A-Z][A-Z0-9]{1,9})\b/g;

/** Mots fréquents ressemblant à des tickers mais qui n'en sont pas. */
const TICKER_STOP = new Set(["USD", "CAD", "EUR", "USDC", "USDT", "SOL", "BTC", "ETH", "AI", "API", "NFT", "DEX", "CEX", "TL", "DR", "K", "M"]);

export function extractMints(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(BASE58_RE)) {
    const s = m[0];
    // Écarte les hexadécimaux purs (hash git/tx EVM) et les chaînes sans majuscule ni minuscule mélangées.
    if (/^[0-9a-fA-F]+$/.test(s)) continue;
    if (!/[a-z]/.test(s) || !/[A-Z]/.test(s)) continue;
    out.add(s);
  }
  return Array.from(out);
}

export function extractTickers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TICKER_RE)) {
    const t = m[1] as string;
    if (TICKER_STOP.has(t)) continue;
    out.add(t);
  }
  return Array.from(out);
}
