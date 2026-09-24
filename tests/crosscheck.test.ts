import { describe, expect, it } from "vitest";
import { CONVICTION_THRESHOLDS, SIGNAL_FAMILIES, convictionFor, crossCheck, type SignalFamily, type SignalInput } from "../lab/signals/crosscheck.ts";

const NOW = new Date("2026-09-24T15:00:00Z");
const MINT = "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs";
let n = 0;
const sig = (family: SignalFamily, cause: string, extra: Partial<SignalInput> = {}): SignalInput => ({
  id: `s${++n}`,
  family,
  cause,
  strength: 0.8,
  ts: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
  ...extra,
});

describe("crossCheck — indépendance des causes", () => {
  it("fixture « boost payé » : volume + holders + mentions + narratif issus d'un seul boost → convergence 1, FAIBLE", () => {
    const boost = `dexscreener-boost:${MINT}`;
    const r = crossCheck([sig("market", boost), sig("onchain", boost), sig("human", boost), sig("project", boost, { strength: 1 })], NOW);
    expect(r.convergence).toBe(1);
    expect(r.families).toHaveLength(1);
    expect(r.conviction).toBe("FAIBLE");
    expect(r.warnings.join()).toMatch(/cause commune « dexscreener-boost:.* » : 4 signaux sur 4 familles/);
    expect(r.warnings.join()).toMatch(/forte suspicion de cause unique/);
    expect(r.causes).toHaveLength(1);
    expect(r.causes[0]!.countedAs).not.toBeNull();
  });

  it("5 familles, 5 causes distinctes → convergence 5, FORTE", () => {
    const r = crossCheck(
      [sig("human", `reddit:post1`), sig("market", `dexscreener-pair:${MINT}`), sig("onchain", `helius-wallet:abc`), sig("project", `github:repo`), sig("macro", `coingecko:btc-dominance`)],
      NOW,
    );
    expect(r.convergence).toBe(5);
    expect(r.families).toEqual([...SIGNAL_FAMILIES]);
    expect(r.conviction).toBe("FORTE");
    expect(r.independence).toMatch(/5 famille\(s\) indépendante\(s\) : human \+ market \+ onchain \+ project \+ macro/);
  });

  it("1 famille = FAIBLE quelle que soit la force et le nombre de causes", () => {
    const r = crossCheck([sig("market", "a", { strength: 1 }), sig("market", "b", { strength: 1 }), sig("market", "c", { strength: 1 })], NOW);
    expect(r.convergence).toBe(1);
    expect(r.conviction).toBe("FAIBLE");
    expect(r.warnings.join()).toMatch(/n'apporte pas de famille nouvelle/);
  });

  it("2 et 3 familles indépendantes = MOYENNE ; 4 = FORTE (seuils publics)", () => {
    expect(crossCheck([sig("human", "a"), sig("market", "b")], NOW).conviction).toBe("MOYENNE");
    expect(crossCheck([sig("human", "a"), sig("market", "b"), sig("onchain", "c")], NOW).conviction).toBe("MOYENNE");
    expect(crossCheck([sig("human", "a"), sig("market", "b"), sig("onchain", "c"), sig("project", "d")], NOW).conviction).toBe("FORTE");
    expect(CONVICTION_THRESHOLDS).toEqual({ MOYENNE: 2, FORTE: 4 });
    expect(convictionFor(0)).toBe("FAIBLE");
    expect(convictionFor(1)).toBe("FAIBLE");
  });

  it("couplage optimal : boost → {market, onchain} et pumpportal → {market} comptent 2 (pas 1 par glouton)", () => {
    const r = crossCheck([sig("market", "boost"), sig("onchain", "boost"), sig("market", "pumpportal")], NOW);
    expect(r.convergence).toBe(2);
    expect(r.families.sort()).toEqual(["market", "onchain"]);
    const boost = r.causes.find((c) => c.cause === "boost")!;
    expect(boost.countedAs).toBe("onchain");
    expect(r.causes.find((c) => c.cause === "pumpportal")!.countedAs).toBe("market");
  });

  it("deux causes couvrant les mêmes deux familles → 2, pas 4", () => {
    const r = crossCheck([sig("market", "a"), sig("human", "a"), sig("market", "b"), sig("human", "b")], NOW);
    expect(r.convergence).toBe(2);
    expect(r.conviction).toBe("MOYENNE");
  });

  it("la cause est normalisée (casse, espaces) : « Reddit:P1 » et « reddit:p1 » sont la même cause", () => {
    const r = crossCheck([sig("human", "Reddit:P1"), sig("market", " reddit:p1 ")], NOW);
    expect(r.convergence).toBe(1);
    expect(r.causes).toHaveLength(1);
  });

  it("un signal sans cause est ignoré (indépendance non prouvable) avec avertissement", () => {
    const r = crossCheck([sig("human", ""), sig("market", "b"), { ...sig("onchain", "c"), cause: undefined as unknown as string }], NOW);
    expect(r.convergence).toBe(1);
    expect(r.ignored.map((i) => i.reason).join()).toMatch(/cause racine absente/);
    expect(r.used).toHaveLength(1);
    expect(r.ignored).toHaveLength(2);
  });
});

describe("crossCheck — validation et fraîcheur", () => {
  it("aucun signal / tableau vide / horloge invalide → convergence 0, FAIBLE, avertissement", () => {
    expect(crossCheck([], NOW)).toMatchObject({ convergence: 0, conviction: "FAIBLE", families: [] });
    expect(crossCheck([], NOW).warnings.join()).toMatch(/aucun signal/);
    expect(crossCheck([sig("human", "a")], "pas-une-date").warnings.join()).toMatch(/horloge invalide/);
    expect(crossCheck(null as unknown as SignalInput[], NOW).convergence).toBe(0);
  });

  it("signaux périmés (> maxAgeMinutes) ou datés dans le futur sont ignorés", () => {
    const old = sig("human", "a", { ts: new Date(NOW.getTime() - 61 * 60_000).toISOString() });
    const future = sig("market", "b", { ts: new Date(NOW.getTime() + 10 * 60_000).toISOString() });
    const fresh = sig("onchain", "c");
    const r = crossCheck([old, future, fresh], NOW);
    expect(r.convergence).toBe(1);
    expect(r.ignored.map((i) => i.reason).join()).toMatch(/périmé/);
    expect(r.ignored.map((i) => i.reason).join()).toMatch(/futur/);
    expect(crossCheck([old, fresh], NOW, { maxAgeMinutes: 120 }).convergence).toBe(2);
  });

  it("famille inconnue, ts sans fuseau, strength hors 0..1, id dupliqué → ignorés, jamais d'exception", () => {
    const r = crossCheck(
      [
        sig("social" as unknown as SignalFamily, "a"),
        sig("human", "b", { ts: "2026-09-24T14:55:00" }),
        sig("market", "c", { strength: 1.5 }),
        sig("onchain", "d", { id: "dup" }),
        sig("project", "e", { id: "dup" }),
        null as unknown as SignalInput,
      ],
      NOW,
    );
    expect(r.convergence).toBe(1);
    expect(r.ignored).toHaveLength(5);
    expect(r.ignored.map((i) => i.reason).join(" | ")).toMatch(/famille inconnue.*fuseau.*0\.\.1.*dupliqué.*non-objet/);
  });

  it("minStrength filtre les signaux ténus ; une convergence de signaux faibles est signalée", () => {
    const weak = [sig("human", "a", { strength: 0.1 }), sig("market", "b", { strength: 0.1 }), sig("onchain", "c", { strength: 0.2 })];
    const r = crossCheck(weak, NOW);
    expect(r.convergence).toBe(3);
    expect(r.warnings.join()).toMatch(/force moyenne faible/);
    expect(crossCheck(weak, NOW, { minStrength: 0.15 }).convergence).toBe(1);
  });

  it("déterminisme : même entrée → même sortie, indépendamment de l'ordre des signaux", () => {
    const a = [sig("human", "x"), sig("market", "y"), sig("onchain", "y"), sig("macro", "z")];
    const r1 = crossCheck(a, NOW);
    const r2 = crossCheck([...a].reverse(), NOW);
    expect(r1.convergence).toBe(r2.convergence);
    expect(r1.families).toEqual(r2.families);
    expect(r1.conviction).toBe(r2.conviction);
    expect(r1.causes.map((c) => c.cause)).toEqual(r2.causes.map((c) => c.cause));
  });

  it("l'entrée n'est pas mutée", () => {
    const a = [sig("human", "x")];
    const copy = JSON.parse(JSON.stringify(a));
    crossCheck(a, NOW);
    expect(a).toEqual(copy);
  });
});
