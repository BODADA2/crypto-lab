/**
 * Encode un compte mint SPL / Token-2022 en base64 (fixtures hors ligne), avec le vrai layout :
 * 82 octets de base, puis pour Token-2022 : padding jusqu'à 165, octet type de compte (1 = Mint), TLV.
 */
import bs58 from "bs58";

export interface MintFixture {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  /** Extensions Token-2022 : [type, longueur des données]. */
  extensions?: Array<[number, number]>;
}

export function encodeMintAccount(f: MintFixture): string {
  const base = Buffer.alloc(82);
  if (f.mintAuthority) {
    base.writeUInt32LE(1, 0);
    Buffer.from(bs58.decode(f.mintAuthority)).copy(base, 4);
  }
  base.writeBigUInt64LE(f.supply, 36);
  base[44] = f.decimals;
  base[45] = 1;
  if (f.freezeAuthority) {
    base.writeUInt32LE(1, 46);
    Buffer.from(bs58.decode(f.freezeAuthority)).copy(base, 50);
  }
  if (!f.extensions) return base.toString("base64");
  const parts: Buffer[] = [base, Buffer.alloc(165 - 82), Buffer.from([1])];
  for (const [type, len] of f.extensions) {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type, 0);
    h.writeUInt16LE(len, 2);
    parts.push(h, Buffer.alloc(len, 7));
  }
  return Buffer.concat(parts).toString("base64");
}
