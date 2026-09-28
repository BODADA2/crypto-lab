import { describe, it, expect } from "vitest";
import { buildDevRegistry, type DevProfile } from "../lab/collect/devregistry.ts";
import type { PumpEvent } from "../lab/collect/types.ts";

const T0 = Date.parse("2026-09-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function ev(kind: "create" | "migrate", mint: string, deployer: string | null, atMs: number): PumpEvent {
  return {
    kind,
    mint,
    signature: "sig",
    name: "n",
    symbol: "s",
    traderPublicKey: deployer,
    solAmount: null,
    marketCapSol: null,
    pool: null,
    receivedAt: iso(atMs),
    raw: {},
    lateDiscovery: false,
  };
}

describe("buildDevRegistry", () => {
  it("crédite les graduations au deployer via jointure par mint", () => {
    const events = [
      ev("create", "m1", "devA", T0),
      ev("create", "m2", "devA", T0 + 1000),
      ev("create", "m3", "devB", T0 + 2000),
      ev("create", "m4", "devB", T0 + 3000),
      ev("migrate", "m1", null, T0 + 4000),
      ev("migrate", "m3", null, T0 + 5000),
    ];
    const reg = buildDevRegistry(events);
    expect(reg).toHaveLength(2);
    const a = reg.find((p) => p.deployer === "devA")!;
    const b = reg.find((p) => p.deployer === "devB")!;
    expect(a.creates).toBe(2);
    expect(a.graduations).toBe(1);
    expect(a.graduationRate).toBe(0.5);
    expect(b.graduations).toBe(1);
  });

  it("ignore les deployers sous le seuil minCreates", () => {
    const events = [ev("create", "m1", "solo", T0)];
    expect(buildDevRegistry(events)).toHaveLength(0);
    expect(buildDevRegistry(events, { minCreates: 1 })).toHaveLength(1);
  });

  it("ne crédite jamais une migration sans create connu (pas d'attribution inventée)", () => {
    const events = [ev("migrate", "mx", null, T0), ev("create", "m1", "devA", T0), ev("create", "m2", "devA", T0 + 1)];
    const reg = buildDevRegistry(events);
    expect(reg).toHaveLength(1);
    expect(reg[0]!.graduations).toBe(0);
  });

  it("pondère le score par la taille de l'échantillon (2/2 < 5/5)", () => {
    const small: PumpEvent[] = [];
    const big: PumpEvent[] = [];
    for (let i = 0; i < 2; i++) {
      small.push(ev("create", `s${i}`, "devSmall", T0 + i));
      small.push(ev("migrate", `s${i}`, null, T0 + 100 + i));
    }
    for (let i = 0; i < 5; i++) {
      big.push(ev("create", `b${i}`, "devBig", T0 + i));
      big.push(ev("migrate", `b${i}`, null, T0 + 100 + i));
    }
    const reg = buildDevRegistry([...small, ...big]);
    const s = reg.find((p) => p.deployer === "devSmall")!;
    const b = reg.find((p) => p.deployer === "devBig")!;
    expect(s.graduationRate).toBe(1);
    expect(b.graduationRate).toBe(1);
    expect(s.score).toBeLessThan(b.score);
    expect(b.score).toBe(100);
  });

  it("trie par score décroissant", () => {
    const events = [
      ev("create", "m1", "devA", T0),
      ev("create", "m2", "devA", T0 + 1),
      ev("create", "m3", "devB", T0 + 2),
      ev("create", "m4", "devB", T0 + 3),
      ev("create", "m5", "devB", T0 + 4),
      ev("create", "m6", "devB", T0 + 5),
      ev("create", "m7", "devB", T0 + 6),
      ev("migrate", "m1", null, T0 + 10),
      ev("migrate", "m3", null, T0 + 11),
      ev("migrate", "m4", null, T0 + 12),
      ev("migrate", "m5", null, T0 + 13),
      ev("migrate", "m6", null, T0 + 14),
      ev("migrate", "m7", null, T0 + 15),
    ];
    const reg: DevProfile[] = buildDevRegistry(events);
    expect(reg[0]!.deployer).toBe("devB");
  });
});
