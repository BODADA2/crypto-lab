// Client Jupiter (mode live). Tout appel réseau passe par `fetchImpl` / `rpc` injectés ;
// les tests n'appellent JAMAIS ce client réel, ils fournissent un mock de l'interface JupiterClient.

import fs from "node:fs";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;
/** Loyer d'un compte de token (165 octets), en SOL — estimation pessimiste utilisée pour les frais d'une nouvelle position. */
export const ATA_RENT_SOL = 0.00203928;

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** Montant en unités de base du token d'entrée (lamports pour SOL). */
  amount: bigint;
  slippageBps: number;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  slippageBps: number;
  priceImpactPct: number;
  /** Réponse brute, à renvoyer telle quelle à /swap. */
  raw: unknown;
}

export interface JupiterClient {
  getQuote(params: QuoteParams): Promise<JupiterQuote>;
  /** Construit la transaction de swap (base64, non signée) pour la clé publique donnée. */
  buildSwapTx(quote: JupiterQuote, userPublicKey: string): Promise<{ swapTransaction: string }>;
  /** Envoie une transaction signée (base64) et renvoie sa signature. */
  sendTransaction(signedTxBase64: string): Promise<{ txid: string }>;
}

/** Signataire local : la clé ne quitte jamais la machine d'Hervé. */
export interface Signer {
  publicKey: string;
  sign(txBase64: string): Promise<string>;
}

export interface JupiterClientOptions {
  fetchImpl?: typeof fetch;
  /** Base de l'API swap (v1). */
  apiBase?: string;
  /** Point d'entrée RPC Solana pour l'envoi. */
  rpcUrl: string;
  apiKey?: string;
}

/** Client réel. Jamais instancié en test. */
export function createJupiterClient(opts: JupiterClientOptions): JupiterClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = (opts.apiBase ?? "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;

  async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
    if (!res.ok) throw new Error(`Jupiter ${res.status} ${res.statusText} sur ${url}`);
    return (await res.json()) as T;
  }

  return {
    async getQuote(p) {
      const q = new URLSearchParams({
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        amount: p.amount.toString(),
        slippageBps: String(p.slippageBps),
      });
      const raw = await json<Record<string, unknown>>(`${apiBase}/quote?${q.toString()}`);
      return {
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        inAmount: BigInt(String(raw.inAmount ?? "0")),
        outAmount: BigInt(String(raw.outAmount ?? "0")),
        slippageBps: p.slippageBps,
        priceImpactPct: Number(raw.priceImpactPct ?? 0),
        raw,
      };
    },
    async buildSwapTx(quote, userPublicKey) {
      const body = JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      });
      const r = await json<{ swapTransaction: string }>(`${apiBase}/swap`, { method: "POST", body });
      if (!r.swapTransaction) throw new Error("Jupiter : swapTransaction absente");
      return { swapTransaction: r.swapTransaction };
    },
    async sendTransaction(signedTxBase64) {
      // Envoi JSON-RPC direct (fetch natif) pour ne pas dépendre de Connection en dehors du mode live.
      const r = await json<{ result?: string; error?: { message?: string } }>(opts.rpcUrl, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          params: [signedTxBase64, { encoding: "base64", skipPreflight: false, maxRetries: 3 }],
        }),
      });
      if (!r.result) throw new Error(`RPC sendTransaction : ${r.error?.message ?? "réponse vide"}`);
      return { txid: r.result };
    },
  };
}

/** Prix spot de SOL en USD d'après un devis 1 SOL → USDC (cotation réelle, jamais une constante). */
export async function solPriceFromQuote(client: Pick<JupiterClient, "getQuote">): Promise<number> {
  const q = await client.getQuote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: BigInt(LAMPORTS_PER_SOL), slippageBps: 50 });
  const price = Number(q.outAmount) / 10 ** USDC_DECIMALS;
  if (!Number.isFinite(price) || price <= 0) throw new Error("devis SOL→USDC invalide");
  return price;
}

/**
 * Charge le signataire depuis ~/.crypto-lab/keypair.json (tableau de 64 octets, format solana-keygen).
 * Import dynamique de @solana/web3.js : rien n'est chargé en mode paper.
 */
export async function loadSigner(keypairPath: string): Promise<Signer> {
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error("keypair.json : tableau de 64 octets attendu");
  const web3 = await import("@solana/web3.js");
  const kp = web3.Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
  return {
    publicKey: kp.publicKey.toBase58(),
    async sign(txBase64) {
      const tx = web3.VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
      tx.sign([kp]);
      return Buffer.from(tx.serialize()).toString("base64");
    },
  };
}
