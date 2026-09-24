/**
 * Informations on-chain d'un mint (SPL Token classique ou Token-2022) via JSON-RPC injectable.
 *
 * Appels (1 crédit Helius chacun, 4 au total par token) :
 *   getAccountInfo(mint, base64)        → décodage du compte mint (autorités, decimals, supply, extensions)
 *   getTokenSupply(mint)                → offre totale (source de vérité pour le dénominateur)
 *   getTokenLargestAccounts(mint)       → 20 plus gros COMPTES de token (pas des wallets)
 *   getMultipleAccounts(top, jsonParsed) → propriétaire de chaque compte (pour exclure LP vaults / bonding curve)
 *
 * Layout mint (82 octets, identique pour SPL et Token-2022) :
 *   [0..4)   option u32 LE (0 = None, 1 = Some)   [4..36)  mintAuthority
 *   [36..44) supply u64 LE                        [44]     decimals
 *   [45]     isInitialized                        [46..50) option u32 LE   [50..82) freezeAuthority
 * Token-2022 : si len > 165, l'octet 165 = type de compte (1 = Mint), puis TLV à partir de 166 :
 *   type u16 LE, length u16 LE, données. Les types sont listés dans EXTENSION_NAMES.
 *
 * `holders` (nombre de détenteurs) reste INCONNU : il faudrait getProgramAccounts (10 crédits, lourd) ou
 * Helius DAS `getTokenAccounts` paginé ; non fait ici, documenté dans README.
 */
import bs58 from "bs58";

export type JsonRpc = <T = unknown>(method: string, params: unknown[]) => Promise<T>;

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MINT_SIZE = 82;
export const ACCOUNT_TYPE_OFFSET = 165;

export const EXTENSION_NAMES: Record<number, string> = {
  0: "Uninitialized",
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
  24: "ConfidentialMintBurn",
  25: "ScaledUiAmount",
  26: "Pausable",
  27: "PausableAccount",
};

/** Extensions Token-2022 considérées dangereuses pour un acheteur (taxe, gel par défaut, délégué permanent, hook). */
export const RISKY_EXTENSIONS = new Set(["TransferFeeConfig", "PermanentDelegate", "TransferHook", "DefaultAccountState", "NonTransferable", "Pausable"]);

export interface DecodedMint {
  program: "spl-token" | "token-2022" | "unknown";
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: string;
  decimals: number;
  isInitialized: boolean;
  extensions: string[];
}

export interface TopAccount {
  address: string;
  owner: string | null;
  amountRaw: string;
  pct: number;
  excluded: boolean;
}

export interface MintInfo extends DecodedMint {
  mint: string;
  /** Part des 10 plus gros comptes (hors exclusions) en % de l'offre, 0..100 ; null si offre nulle. */
  top10Pct: number | null;
  topAccounts: TopAccount[];
  excludedCount: number;
  /** Toujours null ici : voir en-tête. */
  holders: null;
  riskyExtensions: string[];
  fetchedAt: string;
  /** Appels RPC effectués. */
  rpcCalls: number;
}

function readU32LE(b: Uint8Array, o: number): number {
  return ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)) >>> 0;
}
function readU16LE(b: Uint8Array, o: number): number {
  return (b[o] as number) | ((b[o + 1] as number) << 8);
}
function readU64LE(b: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i] as number);
  return v;
}
function pubkey(b: Uint8Array, o: number): string {
  return bs58.encode(b.subarray(o, o + 32));
}

/** Décode les octets bruts d'un compte mint. `owner` = programme propriétaire du compte. */
export function decodeMintAccount(data: Uint8Array, owner: string): DecodedMint {
  if (data.length < MINT_SIZE) throw new Error(`compte mint trop court (${data.length} octets < ${MINT_SIZE})`);
  const mintAuthority = readU32LE(data, 0) === 1 ? pubkey(data, 4) : null;
  const supplyRaw = readU64LE(data, 36).toString();
  const decimals = data[44] as number;
  const isInitialized = (data[45] as number) === 1;
  const freezeAuthority = readU32LE(data, 46) === 1 ? pubkey(data, 50) : null;
  const program: DecodedMint["program"] = owner === TOKEN_PROGRAM_ID ? "spl-token" : owner === TOKEN_2022_PROGRAM_ID ? "token-2022" : "unknown";
  const extensions: string[] = [];
  if (data.length > ACCOUNT_TYPE_OFFSET && (program === "token-2022" || program === "unknown")) {
    const accountType = data[ACCOUNT_TYPE_OFFSET] as number;
    if (accountType === 1) {
      let o = ACCOUNT_TYPE_OFFSET + 1;
      while (o + 4 <= data.length) {
        const type = readU16LE(data, o);
        const len = readU16LE(data, o + 2);
        o += 4;
        if (type === 0) break; // Uninitialized = fin des TLV
        extensions.push(EXTENSION_NAMES[type] ?? `Unknown(${type})`);
        o += len;
      }
    }
  }
  return { program, mintAuthority, freezeAuthority, supplyRaw, decimals, isInitialized, extensions };
}

export function decodeMintAccountBase64(b64: string, owner: string): DecodedMint {
  return decodeMintAccount(new Uint8Array(Buffer.from(b64, "base64")), owner);
}

export interface MintInfoOptions {
  /** Comptes de token à exclure du top 10 (vaults LP, ATA de bonding curve). */
  excludeAccounts?: string[];
  /** Propriétaires (wallets/PDA) à exclure : pool Raydium/PumpSwap, bonding curve pump.fun, etc. */
  excludeOwners?: string[];
  /** Résoudre les propriétaires via getMultipleAccounts (1 appel). Défaut : true si excludeOwners non vide. */
  resolveOwners?: boolean;
  now?: () => number;
}

interface AccountInfoValue {
  data: [string, string];
  owner: string;
  lamports: number;
  executable: boolean;
}
interface TokenAmount {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
}
interface LargestAccount extends TokenAmount {
  address: string;
}
interface ParsedTokenAccount {
  data: { parsed?: { info?: { owner?: string } } } | [string, string];
  owner: string;
}

export function computeTop10(
  accounts: Array<{ address: string; owner: string | null; amountRaw: string }>,
  supplyRaw: string,
  exclude: { accounts?: Set<string>; owners?: Set<string> } = {},
): { top10Pct: number | null; topAccounts: TopAccount[]; excludedCount: number } {
  const supply = BigInt(supplyRaw);
  const sorted = [...accounts].sort((a, b) => (BigInt(b.amountRaw) > BigInt(a.amountRaw) ? 1 : BigInt(b.amountRaw) < BigInt(a.amountRaw) ? -1 : 0));
  const topAccounts: TopAccount[] = sorted.map((a) => ({
    address: a.address,
    owner: a.owner,
    amountRaw: a.amountRaw,
    pct: supply > 0n ? Number((BigInt(a.amountRaw) * 10_000n) / supply) / 100 : 0,
    excluded: Boolean(exclude.accounts?.has(a.address) || (a.owner !== null && exclude.owners?.has(a.owner))),
  }));
  const kept = topAccounts.filter((a) => !a.excluded).slice(0, 10);
  const sum = kept.reduce((s, a) => s + BigInt(a.amountRaw), 0n);
  const top10Pct = supply > 0n ? Math.min(100, Number((sum * 10_000n) / supply) / 100) : null;
  return { top10Pct, topAccounts, excludedCount: topAccounts.filter((a) => a.excluded).length };
}

export async function fetchMintInfo(rpc: JsonRpc, mint: string, opts: MintInfoOptions = {}): Promise<MintInfo | null> {
  const now = opts.now ?? (() => Date.now());
  let calls = 0;
  const call = async <T,>(method: string, params: unknown[]): Promise<T> => {
    calls += 1;
    return rpc<T>(method, params);
  };
  const info = await call<{ value: AccountInfoValue | null }>("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }]);
  if (!info?.value) return null;
  const decoded = decodeMintAccountBase64(info.value.data[0], info.value.owner);
  const supply = await call<{ value: TokenAmount }>("getTokenSupply", [mint, { commitment: "confirmed" }]);
  const supplyRaw = supply?.value?.amount ?? decoded.supplyRaw;
  const largest = await call<{ value: LargestAccount[] }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
  const list = Array.isArray(largest?.value) ? largest.value : [];
  const excludeOwners = new Set(opts.excludeOwners ?? []);
  const excludeAccounts = new Set(opts.excludeAccounts ?? []);
  const resolve = opts.resolveOwners ?? excludeOwners.size > 0;
  const owners = new Map<string, string | null>();
  if (resolve && list.length) {
    const multi = await call<{ value: Array<ParsedTokenAccount | null> }>("getMultipleAccounts", [list.map((a) => a.address), { encoding: "jsonParsed", commitment: "confirmed" }]);
    (multi?.value ?? []).forEach((acc, i) => {
      const addr = list[i]?.address;
      if (!addr) return;
      const parsedOwner = acc && !Array.isArray(acc.data) ? acc.data.parsed?.info?.owner : undefined;
      owners.set(addr, typeof parsedOwner === "string" ? parsedOwner : null);
    });
  }
  const top = computeTop10(
    list.map((a) => ({ address: a.address, owner: owners.get(a.address) ?? null, amountRaw: a.amount })),
    supplyRaw,
    { accounts: excludeAccounts, owners: excludeOwners },
  );
  return {
    mint,
    ...decoded,
    supplyRaw,
    top10Pct: top.top10Pct,
    topAccounts: top.topAccounts,
    excludedCount: top.excludedCount,
    holders: null,
    riskyExtensions: decoded.extensions.filter((e) => RISKY_EXTENSIONS.has(e)),
    fetchedAt: new Date(now()).toISOString(),
    rpcCalls: calls,
  };
}
