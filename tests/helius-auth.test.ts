/**
 * Tests du module d'auth Helius (skill, surrogate court-terme).
 * Le runner CLI est injecté : aucun appel réel, aucune clé dans les tests.
 */
import { describe, it, expect } from "vitest";
import {
  getHeliusRpcUrl,
  withHeliusAuthRefresh,
  isHeliusAuthFailure,
  HeliusAuthError,
  type CliRunner,
} from "../lab/collect/helius-auth.ts";
import { HeliusError } from "../lab/collect/helius.ts";

const okRunner: CliRunner = (base) => `${base}?api-key=hsurr:FAKE`;
const failingRunner: CliRunner = () => {
  throw new Error("sentinel indisponible");
};

describe("getHeliusRpcUrl", () => {
  it("renvoie l'URL du CLI, sans espaces", () => {
    const url = getHeliusRpcUrl("https://mainnet.helius-rpc.com/", (b) => `${b}?api-key=hsurr:X\n`);
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=hsurr:X");
  });

  it("supporte une base WSS", () => {
    const url = getHeliusRpcUrl("wss://mainnet.helius-rpc.com/", okRunner);
    expect(url).toBe("wss://mainnet.helius-rpc.com/?api-key=hsurr:FAKE");
  });

  it("lève HeliusAuthError quand le CLI échoue, sans fuiter l'URL", () => {
    let err: unknown;
    try {
      getHeliusRpcUrl("https://mainnet.helius-rpc.com/", failingRunner);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HeliusAuthError);
    const msg = (err as Error).message;
    expect(msg).toContain("mainnet.helius-rpc.com");
    expect(msg).not.toContain("hsurr");
    expect(msg).not.toContain("api-key=");
  });

  it("rejette une sortie CLI vide ou invalide", () => {
    expect(() => getHeliusRpcUrl("https://mainnet.helius-rpc.com/", () => "  \n")).toThrow(HeliusAuthError);
    expect(() => getHeliusRpcUrl("https://mainnet.helius-rpc.com/", () => "pas-une-url")).toThrow(HeliusAuthError);
  });
});

describe("isHeliusAuthFailure", () => {
  it("détecte 401/403, ignore le reste", () => {
    expect(isHeliusAuthFailure(new HeliusError("Helius HTTP 401 (getSlot)", 401))).toBe(true);
    expect(isHeliusAuthFailure(new HeliusError("Helius HTTP 403 (getSlot)", 403))).toBe(true);
    expect(isHeliusAuthFailure(new HeliusError("Helius HTTP 429 (getSlot)", 429))).toBe(false);
    expect(isHeliusAuthFailure(new Error("boom"))).toBe(false);
    expect(isHeliusAuthFailure(null)).toBe(false);
  });
});

describe("withHeliusAuthRefresh", () => {
  it("exécute fn avec l'URL fraîche", async () => {
    const seen: string[] = [];
    const res = await withHeliusAuthRefresh(
      "https://mainnet.helius-rpc.com/",
      async (url) => {
        seen.push(url);
        return "ok";
      },
      okRunner,
    );
    expect(res).toBe("ok");
    expect(seen).toEqual(["https://mainnet.helius-rpc.com/?api-key=hsurr:FAKE"]);
  });

  it("régénère l'URL une fois sur 401 puis réessaie", async () => {
    let calls = 0;
    const runner: CliRunner = () => `https://mainnet.helius-rpc.com/?api-key=hsurr:V${++calls}`;
    const used: string[] = [];
    const res = await withHeliusAuthRefresh(
      "https://mainnet.helius-rpc.com/",
      async (url) => {
        used.push(url);
        if (used.length === 1) throw new HeliusError("Helius HTTP 401 (getSlot)", 401);
        return "retried";
      },
      runner,
    );
    expect(res).toBe("retried");
    expect(used).toHaveLength(2);
    expect(used[0]).not.toBe(used[1]);
  });

  it("propage les erreurs non-auth sans réessayer", async () => {
    let calls = 0;
    await expect(
      withHeliusAuthRefresh(
        "https://mainnet.helius-rpc.com/",
        async () => {
          calls++;
          throw new HeliusError("Helius HTTP 429 (getSlot)", 429);
        },
        okRunner,
      ),
    ).rejects.toThrow("429");
    expect(calls).toBe(1);
  });
});
