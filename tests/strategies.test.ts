import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { synthSeries } from "../lab/backtest/synth.ts";
import { synthOhlcv, SOL_FIXTURE_OPTIONS, toCompactJsonl, tradingDays } from "../lab/backtest/synth-ohlcv.ts";
import { loadHistoryDir, runBacktest, runBarsBacktest, runStrategyBacktest, simulateBars, strategyToSignalFn } from "../lab/backtest/harness.ts";
import { createRegistry, defaultRegistry } from "../lab/strategies/registry.ts";
import { createS1Volume } from "../lab/strategies/s1-volume.ts";
import { createS2EarlyBuyers, findWalletCluster, loadTrackedWallets } from "../lab/strategies/s2-earlybuyers.ts";
import { createS3Migration } from "../lab/strategies/s3-migration.ts";
import { createS4Ivb, evaluateIvb, forcedExitTs, IVB_DEFAULTS } from "../lab/strategies/s4-ivb.ts";
import { atr, localStamp, parseOhlcvJsonl, utcOffsetMinutes, zonedTimeToUtc } from "../lab/strategies/ohlcv.ts";
import {
  computeAllMetrics,
  computeStrategyMetrics,
  formatMetrics,
  MIN_TRADES_FOR_CONCLUSION,
  tradesFromBacktest,
  tradesFromLedger,
  type StrategyTrade,
} from "../lab/strategies/metrics.ts";
import type { Strategy, StrategyInput, StrategySignal } from "../lab/strategies/types.ts";
import type { LedgerEntry, TokenSnapshot } from "../lab/types.ts";
import { history, NY, session, weekdays } from "./helpers/ohlcv.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MINT = "StratMint111111111111111111111111111111111111";
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "strat-"));
  tmpDirs.push(d);
  return d;
}

/** Série memecoin plate (volume 5 min constant), dernière fenêtre modifiable. */
function flatSeries(bars = 13, last: Partial<TokenSnapshot> = {}, all: Partial<TokenSnapshot> = {}): TokenSnapshot[] {
  const base = synthSeries({ mint: MINT, bars, seed: 5, liquidity0: 60_000 });
  const out = base.map((s, i) => ({
    ...s,
    volume: { ...s.volume, m5: 1000 },
    volume5m: 1000,
    holders: 100 + i,
    liquidityUsd: 60_000,
    txns: { ...s.txns, m5: { buys: 6, sells: 4 } },
    ...all,
  }));
  const l = out[out.length - 1]!;
  out[out.length - 1] = { ...l, ...last, volume: { ...l.volume, ...(last.volume ?? {}) } };
  return out;
}
const nowOf = (series: TokenSnapshot[]): number => Date.parse(series[series.length - 1]!.fetchedAt);
const memeInput = (series: TokenSnapshot[], extra: Partial<StrategyInput> = {}): StrategyInput => ({
  now: nowOf(series),
  snapshot: series[series.length - 1]!,
  history: series,
  context: {},
  ...extra,
});

// ---------------------------------------------------------------------------
describe("registre", () => {
  const dummy = (id: string, strength: number, throws = false): Strategy => ({
    id,
    version: "0.1.0",
    family: "memecoin",
    describe: () => `dummy ${id}`,
    signals: () => {
      if (throws) throw new Error(`boom ${id}`);
      return [{ strategyId: "usurpé", strategyVersion: "?", mint: MINT, side: "BUY", strength, reasons: [], invalidation: "-", ts: "" }];
    },
  });

  it("enregistre, liste (triée), retrouve, refuse les doublons et les ids vides", () => {
    const r = createRegistry();
    r.register(dummy("b", 1));
    r.register(dummy("a", 2));
    expect(r.list().map((s) => s.id)).toEqual(["a", "b"]);
    expect(r.get("a")?.describe()).toBe("dummy a");
    expect(r.has("zz")).toBe(false);
    expect(() => r.register(dummy("a", 3))).toThrow(/déjà enregistrée/);
    expect(() => r.register({ ...dummy("x", 1), id: "" })).toThrow(/sans id/);
    expect(r.unregister("a")).toBe(true);
    expect(r.list().length).toBe(1);
  });

  it("run : isole les erreurs, trie par force, borne 0–100 et impose l'identité de la stratégie", () => {
    const r = createRegistry([dummy("weak", 10), dummy("strong", 250), dummy("broken", 50, true)]);
    const res = r.run(memeInput(flatSeries()));
    expect(res.evaluated).toEqual(["broken@0.1.0", "strong@0.1.0", "weak@0.1.0"]);
    expect(res.errors).toEqual([{ strategyId: "broken", message: "boom broken" }]);
    expect(res.signals.map((s) => [s.strategyId, s.strength])).toEqual([
      ["strong", 100],
      ["weak", 10],
    ]);
    expect(res.signals[0]!.strategyVersion).toBe("0.1.0");
  });

  it("run par famille et registre par défaut (S1–S4 décrites)", () => {
    const r = defaultRegistry();
    expect(r.list().map((s) => s.id)).toEqual(["s1-volume", "s2-earlybuyers", "s3-migration", "s4-ivb"]);
    expect(r.list("crypto").map((s) => s.id)).toEqual(["s4-ivb"]);
    expect(r.describeAll().every((d) => d.includes("—"))).toBe(true);
    // Un input memecoin vide n'émet rien et ne fait planter aucune stratégie.
    const res = r.run({ now: 0, snapshot: null, history: [], context: {} });
    expect(res.signals).toEqual([]);
    expect(res.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("S1 — volume", () => {
  const s1 = createS1Volume();

  it("série plate → aucun signal ; historique vide → aucun signal", () => {
    expect(s1.signals(memeInput(flatSeries()))).toEqual([]);
    expect(s1.signals({ now: 0, snapshot: null, history: [], context: {} })).toEqual([]);
  });

  it("pic de volume (z ≥ 3, achats > ventes, vol/liq ≥ 5 %) → BUY avec raisons, stop −25 %, objectif +50 %", () => {
    const series = flatSeries(13, { volume: { m5: 6000, h1: 0, h6: 0, h24: 0 }, txns: { m5: { buys: 30, sells: 10 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } } });
    const [sig] = s1.signals(memeInput(series));
    expect(sig).toBeDefined();
    expect(sig!.side).toBe("BUY");
    expect(sig!.mint).toBe(MINT);
    expect(sig!.strength).toBeGreaterThan(50);
    expect(sig!.reasons[0]).toMatch(/z-score volume \d+\.\d+ ≥ 3/);
    const price = series[12]!.priceUsd;
    expect(sig!.proposedStop).toBeCloseTo(price * 0.75, 10);
    expect(sig!.proposedTarget).toBeCloseTo(price * 1.5, 10);
    expect(sig!.ts).toBe(series[12]!.fetchedAt);
    expect(sig!.invalidation).toMatch(/moyenne \+ 1 σ/);
  });

  it("filtres : pression vendeuse, vol/liq trop faible, z sous le seuil, liquidité insuffisante", () => {
    const spike = (extra: Partial<TokenSnapshot>) => flatSeries(13, { volume: { m5: 6000, h1: 0, h6: 0, h24: 0 }, ...extra });
    expect(s1.signals(memeInput(spike({ txns: { m5: { buys: 5, sells: 20 }, h1: { buys: 0, sells: 0 }, h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } } })))).toEqual([]);
    expect(s1.signals(memeInput(spike({ liquidityUsd: 1_000_000 })))).toEqual([]); // 6000 / 1 M = 0,6 %
    expect(s1.signals(memeInput(flatSeries(13, { volume: { m5: 1500, h1: 0, h6: 0, h24: 0 } })))).toEqual([]); // z = 2
    expect(s1.signals(memeInput(spike({ liquidityUsd: 10_000 })))).toEqual([]);
  });

  it("paramètres : minZ abaissé à 1.5 accepte un pic modéré ; describe() les expose", () => {
    const loose = createS1Volume({ minZ: 1.5, minVolumeToLiquidity: 0 });
    expect(loose.signals(memeInput(flatSeries(13, { volume: { m5: 1600, h1: 0, h6: 0, h24: 0 } }))).length).toBe(1);
    expect(loose.describe()).toMatch(/z ≥ 1\.5/);
  });
});

// ---------------------------------------------------------------------------
describe("S2 — wallets suivis", () => {
  const s2 = createS2EarlyBuyers();
  const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
  const tracked = [
    { address: "W1", score: 80 },
    { address: "W2", score: 60 },
    { address: "W3", score: 40 },
  ];
  const series = () => flatSeries(3, { fetchedAt: new Date(T0).toISOString() });

  it("findWalletCluster : plus grand groupe distinct dans la fenêtre, achats futurs et wallets non suivis ignorés", () => {
    const buys = [
      { wallet: "W1", ts: T0 - 20 * 60_000 },
      { wallet: "X", ts: T0 - 19 * 60_000 },
      { wallet: "W1", ts: T0 - 18 * 60_000 }, // même wallet : compte une fois
      { wallet: "W2", ts: T0 - 12 * 60_000 },
      { wallet: "W3", ts: T0 - 5 * 60_000 },
      { wallet: "W1", ts: T0 + 60_000 }, // futur
    ];
    const c = findWalletCluster(buys, new Set(["W1", "W2", "W3"]), 10 * 60_000, T0)!;
    expect(c.wallets).toEqual(["W2", "W3"]);
    expect(c.endTs).toBe(T0 - 5 * 60_000);
    expect(findWalletCluster(buys, new Set(["Z"]), 10 * 60_000, T0)).toBeNull();
  });

  it("2 wallets suivis en 10 min → BUY ; force pondérée par les scores ; raisons nomment les wallets", () => {
    const buys = [
      { wallet: "W1", ts: T0 - 9 * 60_000 },
      { wallet: "W2", ts: T0 - 2 * 60_000 },
    ];
    const [sig] = s2.signals(memeInput(series(), { trackedWallets: tracked, buys }));
    expect(sig?.side).toBe("BUY");
    expect(sig!.reasons[1]).toBe("wallets : W1, W2");
    expect(sig!.strength).toBe(Math.round(50 * (0.5 + 70 / 200)));
    const three = s2.signals(memeInput(series(), { trackedWallets: tracked, buys: [...buys, { wallet: "W3", ts: T0 - 1 * 60_000 }] }))[0]!;
    expect(three.strength).toBeGreaterThan(sig!.strength);
  });

  it("11 min d'écart, wallet non suivi, achat futur, regroupement trop ancien → aucun signal", () => {
    const at = (min: number, wallet: string) => ({ wallet, ts: T0 - min * 60_000 });
    expect(s2.signals(memeInput(series(), { trackedWallets: tracked, buys: [at(13, "W1"), at(2, "W2")] }))).toEqual([]);
    expect(s2.signals(memeInput(series(), { trackedWallets: tracked, buys: [at(5, "W1"), at(2, "X")] }))).toEqual([]);
    expect(s2.signals(memeInput(series(), { trackedWallets: tracked, buys: [at(5, "W1"), { wallet: "W2", ts: T0 + 60_000 }] }))).toEqual([]);
    expect(s2.signals(memeInput(series(), { trackedWallets: tracked, buys: [at(45, "W1"), at(40, "W2")] }))).toEqual([]); // fin à −40 min > 30
    expect(createS2EarlyBuyers({ maxAgeMin: 60 }).signals(memeInput(series(), { trackedWallets: tracked, buys: [at(45, "W1"), at(40, "W2")] })).length).toBe(1);
  });

  it("filtres : liquidité insuffisante, score de wallet minimal, aucun wallet suivi", () => {
    const buys = [
      { wallet: "W2", ts: T0 - 3 * 60_000 },
      { wallet: "W3", ts: T0 - 1 * 60_000 },
    ];
    expect(s2.signals(memeInput(flatSeries(3, { fetchedAt: new Date(T0).toISOString(), liquidityUsd: 5_000 }), { trackedWallets: tracked, buys }))).toEqual([]);
    expect(createS2EarlyBuyers({ minWalletScore: 50 }).signals(memeInput(series(), { trackedWallets: tracked, buys }))).toEqual([]);
    expect(s2.signals(memeInput(series(), { trackedWallets: [], buys }))).toEqual([]);
  });

  it("loadTrackedWallets lit data/wallets/*.json (profils early-buyer), ignore les fichiers corrompus", () => {
    const dir = tmp();
    writeFileSync(join(dir, "W1.json"), JSON.stringify({ address: "W1", score: 77, recurrence: 3 }));
    writeFileSync(join(dir, "W2.json"), JSON.stringify({ address: "W2" }));
    writeFileSync(join(dir, "bad.json"), "{ pas du json");
    writeFileSync(join(dir, "notes.txt"), "ignoré");
    expect(loadTrackedWallets(dir)).toEqual([
      { address: "W1", score: 77 },
      { address: "W2", score: 0 },
    ]);
    expect(loadTrackedWallets(join(dir, "absent"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("S3 — post-migration", () => {
  const s3 = createS3Migration();
  const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);
  const snap = (o: Partial<TokenSnapshot> = {}) =>
    flatSeries(2, { fetchedAt: new Date(T0).toISOString(), top10Pct: 20, mintAuthority: null, freezeAuthority: null, liquidityUsd: 40_000, ...o });
  const mig = (ageMin: number) => ({ migratedAt: T0 - ageMin * 60_000 });

  it("migration il y a 30 min, liquidité ≥ 20 k$, top 10 < 30 %, autorités révoquées → BUY avec time-stop 24 h", () => {
    const [sig] = s3.signals(memeInput(snap(), { migration: mig(30) }));
    expect(sig?.side).toBe("BUY");
    expect(sig!.exitBy).toBe(new Date(T0 + 24 * 3_600_000).toISOString());
    expect(sig!.reasons.join(" ")).toMatch(/migration il y a 30 min/);
    expect(sig!.strength).toBe(Math.round(40 + 30 * (1 - 20 / 30) + 30 * 0.5));
    expect(sig!.invalidation).toMatch(/time-stop/);
  });

  it("top 10 inconnu (100) ou ≥ 30 % → aucun signal", () => {
    expect(s3.signals(memeInput(snap({ top10Pct: 100 }), { migration: mig(30) }))).toEqual([]);
    expect(s3.signals(memeInput(snap({ top10Pct: 30 }), { migration: mig(30) }))).toEqual([]);
    expect(s3.signals(memeInput(snap({ top10Pct: 29.9 }), { migration: mig(30) })).length).toBe(1);
  });

  it("autorités UNKNOWN ou présentes, extension risquée → aucun signal", () => {
    expect(s3.signals(memeInput(snap({ mintAuthority: "UNKNOWN" }), { migration: mig(30) }))).toEqual([]);
    expect(s3.signals(memeInput(snap({ freezeAuthority: "Fr33ze" }), { migration: mig(30) }))).toEqual([]);
    expect(s3.signals(memeInput(snap({ riskyExtensions: ["PermanentDelegate"] }), { migration: mig(30) }))).toEqual([]);
  });

  it("fenêtre d'âge [10, 120] min, migration future ou absente, liquidité → aucun signal", () => {
    expect(s3.signals(memeInput(snap(), { migration: mig(5) }))).toEqual([]);
    expect(s3.signals(memeInput(snap(), { migration: mig(121) }))).toEqual([]);
    expect(s3.signals(memeInput(snap(), { migration: mig(-1) }))).toEqual([]);
    expect(s3.signals(memeInput(snap(), {}))).toEqual([]);
    expect(s3.signals(memeInput(snap({ liquidityUsd: 19_999 }), { migration: mig(30) }))).toEqual([]);
    expect(createS3Migration({ maxAgeMin: 240 }).signals(memeInput(snap(), { migration: mig(200) })).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("S4 — IVB (fuseau, fourchette, contraction, cassure)", () => {
  const s4 = createS4Ivb();
  const input = (bars: StrategyInput["bars"]): StrategyInput => ({ now: bars![bars!.length - 1]!.ts + 300_000, snapshot: null, history: [], symbol: "SOL", bars, context: {} });

  it("Intl : 9 h 30 New York = 13 h 30 Z en été (EDT) et 14 h 30 Z en hiver (EST)", () => {
    const summer = zonedTimeToUtc(NY, 2026, 10, 30, 9, 30);
    const winter = zonedTimeToUtc(NY, 2026, 11, 2, 9, 30);
    expect(new Date(summer).toISOString()).toBe("2026-10-30T13:30:00.000Z");
    expect(new Date(winter).toISOString()).toBe("2026-11-02T14:30:00.000Z");
    expect(utcOffsetMinutes(summer, NY)).toBe(-240);
    expect(utcOffsetMinutes(winter, NY)).toBe(-300);
    expect(localStamp(winter, NY)).toEqual({ day: "2026-11-02", minutes: 570 });
  });

  it("première clôture hors fourchette avec contraction et volume → BUY : stop structurel, objectif 2 R, sortie 16 h ET", () => {
    const { bars, dayStart } = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 } });
    const bIdx = dayStart + 8; // 10 h 10
    const upTo = bars.slice(0, bIdx + 1);
    const [sig] = s4.signals(input(upTo));
    expect(sig).toBeDefined();
    expect(sig!.side).toBe("BUY");
    expect(sig!.symbol).toBe("SOL");
    const entry = bars[bIdx]!.close;
    expect(sig!.refPrice).toBe(entry);
    const a = atr(bars, bIdx, 14)!;
    const rangeLow = 100 - 0.25;
    expect(sig!.proposedStop).toBeCloseTo(rangeLow - 0.5 * a, 12);
    const r = entry - sig!.proposedStop!;
    expect(sig!.proposedTarget).toBeCloseTo(entry + 2 * r, 12);
    expect(sig!.exitBy).toBe(new Date(zonedTimeToUtc(NY, 2026, 9, 21, 16, 0)).toISOString());
    expect(sig!.reasons.some((x) => x.includes("contraction 0.500"))).toBe(true);
    expect(sig!.reasons.some((x) => x.includes("3.00 × moyenne des 20 barres"))).toBe(true);
    // Diagnostic complet.
    const ev = evaluateIvb(upTo);
    expect(ev.fires).toBe(true);
    expect(ev.previousDays.length).toBe(10);
    expect(ev.previousDays).not.toContain(ev.day);
  });

  it("cassure baissière → SELL, stop au-dessus du high + tampon ATR", () => {
    const { bars, dayStart } = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 0, side: "SELL", volume: 400 } });
    const upTo = bars.slice(0, dayStart + 7);
    const [sig] = s4.signals(input(upTo));
    expect(sig?.side).toBe("SELL");
    const a = atr(upTo, upTo.length - 1, 14)!;
    expect(sig!.proposedStop).toBeCloseTo(100.25 + 0.5 * a, 12);
    expect(sig!.proposedTarget).toBeLessThan(sig!.refPrice!);
  });

  it("première cassure seulement : la barre suivante (toujours hors fourchette) n'émet rien", () => {
    const { bars, dayStart } = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 }, driftAfter: 0.05 });
    const bIdx = dayStart + 8;
    expect(s4.signals(input(bars.slice(0, bIdx + 1))).length).toBe(1);
    expect(s4.signals(input(bars.slice(0, bIdx + 2)))).toEqual([]);
    expect(evaluateIvb(bars.slice(0, bIdx + 2)).reason).toMatch(/première cassure a déjà eu lieu/);
    // Même une « seconde cassure » plus forte en fin de fenêtre est ignorée.
    expect(s4.signals(input(bars.slice(0, dayStart + 20)))).toEqual([]);
  });

  it("cassure tardive (après les 90 min) ignorée ; avant la cassure : « aucune clôture hors fourchette »", () => {
    const late = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 18, side: "BUY", volume: 300 } }); // 11 h 30
    const idx = late.dayStart + 6 + 18;
    expect(s4.signals(input(late.bars.slice(0, idx + 1)))).toEqual([]);
    expect(evaluateIvb(late.bars.slice(0, idx + 1)).reason).toMatch(/cassure tardive ignorée/);
    const justInTime = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 17, side: "BUY", volume: 300 } }); // 11 h 25
    expect(s4.signals(input(justInTime.bars.slice(0, justInTime.dayStart + 6 + 17 + 1))).length).toBe(1);
    expect(evaluateIvb(late.bars.slice(0, late.dayStart + 10)).reason).toMatch(/aucune clôture hors fourchette/);
  });

  it("contraction : le jour courant est EXCLU de la moyenne des jours précédents", () => {
    // 10 jours à 1.0 ; largeur du jour 0.79 → ratio 0.79 ≤ 0.8 (exclu) ; inclus il serait 0.79/0.981 = 0.805 > 0.8.
    const ok = history(10, 1, { day: "", width: 0.79, breakout: { offsetBars: 1, side: "BUY", volume: 300 } });
    const evOk = evaluateIvb(ok.bars.slice(0, ok.dayStart + 8));
    expect(evOk.contractionRatio).toBeCloseTo(0.79, 10);
    expect(evOk.fires).toBe(true);
    const ko = history(10, 1, { day: "", width: 0.81, breakout: { offsetBars: 1, side: "BUY", volume: 300 } });
    const evKo = evaluateIvb(ko.bars.slice(0, ko.dayStart + 8));
    expect(evKo.fires).toBe(false);
    expect(evKo.reason).toMatch(/pas de contraction : ratio 0\.810/);
    // Les 10 jours précédents seulement (le 11e plus ancien est ignoré) : un vieux jour très large ne compte pas.
    const days = weekdays("2026-08-31", 12);
    const bars = [...session({ day: days[0]!, width: 100 }), ...days.slice(1, 11).flatMap((d) => session({ day: d, width: 1 })), ...session({ day: days[11]!, width: 0.79, breakout: { offsetBars: 1, side: "BUY", volume: 300 } })];
    const ev = evaluateIvb(bars.slice(0, 11 * 78 + 8));
    expect(ev.previousDays).toEqual(days.slice(1, 11));
    expect(ev.contractionRatio).toBeCloseTo(0.79, 10);
  });

  it("volume : la barre de cassure est EXCLUE de la moyenne des 20 barres précédentes", () => {
    // 20 barres précédentes à 100, cassure à 150 → ratio 1.5 exact (exclue) ; incluse : 150/102.4 = 1.46 < 1.5.
    const h = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 150 } });
    const ev = evaluateIvb(h.bars.slice(0, h.dayStart + 9));
    expect(ev.volumeRatio).toBeCloseTo(1.5, 10);
    expect(ev.fires).toBe(true);
    const h2 = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 149 } });
    const ev2 = evaluateIvb(h2.bars.slice(0, h2.dayStart + 9));
    expect(ev2.fires).toBe(false);
    expect(ev2.reason).toMatch(/volume insuffisant : ratio 1\.49/);
  });

  it("changement d'heure : les mêmes heures locales sont détectées avant (EDT) et après (EST) le 1er novembre", () => {
    const days = weekdays("2026-10-16", 12); // 16 oct. → 2 nov. (index 10 = 30 oct., 11 = 2 nov.)
    const build = (testIdx: number) => {
      const bars = days.slice(0, testIdx).flatMap((d) => session({ day: d, width: 1 }));
      const day = days[testIdx]!;
      return { bars: [...bars, ...session({ day, width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 } })], day, dayStart: bars.length };
    };
    const edt = build(10); // 30 oct. (EDT)
    const edtSig = s4.signals(input(edt.bars.slice(0, edt.dayStart + 9)))[0]!;
    expect(edt.day).toBe("2026-10-30");
    expect(edtSig.exitBy).toBe("2026-10-30T20:00:00.000Z");
    expect(new Date(edt.bars[edt.dayStart + 8]!.ts).toISOString()).toBe("2026-10-30T14:10:00.000Z");
    const est = build(11); // 2 nov. (EST)
    const estSig = s4.signals(input(est.bars.slice(0, est.dayStart + 9)))[0]!;
    expect(est.day).toBe("2026-11-02");
    expect(estSig.exitBy).toBe("2026-11-02T21:00:00.000Z");
    expect(new Date(est.bars[est.dayStart + 8]!.ts).toISOString()).toBe("2026-11-02T15:10:00.000Z");
    // Un fuseau fixe (UTC−5) aurait pris 10 h 10 EDT pour 9 h 10 : hors fourchette et hors fenêtre.
    expect(evaluateIvb(edt.bars.slice(0, edt.dayStart + 9), { timeZone: "Etc/GMT+5" }).fires).toBe(false);
    expect(forcedExitTs("2026-10-30", IVB_DEFAULTS)).toBe(Date.parse("2026-10-30T20:00:00.000Z"));
  });

  it("aucun signal sans historique suffisant (9 jours précédents, fourchette incomplète, ATR ou volume indisponibles)", () => {
    const nine = history(9, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 } });
    const ev = evaluateIvb(nine.bars.slice(0, nine.dayStart + 9));
    expect(ev.fires).toBe(false);
    expect(ev.reason).toMatch(/historique insuffisant : 9 jours précédents complets < 10/);
    expect(s4.signals(input(nine.bars.slice(0, nine.dayStart + 9)))).toEqual([]);
    // Fourchette du jour incomplète : une barre de 9 h 40 manquante.
    const h = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 } });
    const holed = [...h.bars.slice(0, h.dayStart + 2), ...h.bars.slice(h.dayStart + 3, h.dayStart + 9)];
    expect(evaluateIvb(holed).reason).toMatch(/fourchette d'ouverture du jour incomplète/);
    // Barres non chronologiques.
    expect(evaluateIvb([h.bars[1]!, h.bars[0]!]).reason).toMatch(/non chronologiques/);
    expect(evaluateIvb([]).reason).toBe("aucune barre");
    expect(s4.signals({ now: 0, snapshot: null, history: [], context: {} })).toEqual([]);
    // Volume : lookback plus grand que l'historique disponible.
    expect(evaluateIvb(h.bars.slice(h.dayStart - 5, h.dayStart + 9), { lookbackDays: 0, maxContractionRatio: Infinity, volumeLookbackBars: 30 }).reason).toMatch(/historique de volume insuffisant/);
  });

  it("paramètres documentés dans describe() ; fourchette et fenêtre paramétrables", () => {
    expect(s4.describe()).toMatch(/9 h 30–10 h 00 America\/New_York/);
    expect(s4.describe()).toMatch(/16 h 00/);
    const wide = createS4Ivb({ breakoutWindowMin: 120 });
    const late = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 18, side: "BUY", volume: 300 } });
    expect(wide.signals(input(late.bars.slice(0, late.dayStart + 6 + 18 + 1))).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("harnais : stratégies sur snapshots et sur barres", () => {
  it("runStrategyBacktest = runBacktest(strategyToSignalFn) ; trades étiquetés ; famille vérifiée", () => {
    const series = loadHistoryDir(join(HERE, "fixtures", "history"));
    const s1 = createS1Volume({ minZ: 1.5, minVolumeToLiquidity: 0, minBuySellRatio: 0 });
    const rules = { threshold: 30, takeProfit: 0.5, stopLoss: 0.25, timeStopBars: 12, sizeUsd: 50, cooldownBars: 3 };
    const a = runStrategyBacktest(series, s1, rules);
    const b = runBacktest(series, strategyToSignalFn(s1), rules);
    expect(a.n).toBe(b.n);
    expect(a.n).toBeGreaterThan(0);
    expect(a.trades.every((t) => t.strategyId === "s1-volume")).toBe(true);
    expect(() => runStrategyBacktest(series, createS4Ivb(), rules)).toThrow(/memecoin/);
    expect(() => runBarsBacktest(new Map(), s1, { minStrength: 1 })).toThrow(/crypto/);
  });

  it("simulateBars : le compteur d'ordres est incrémenté À L'ORDRE (porte refusée ⇒ 0 ordre, 1 signal vu)", () => {
    const { bars } = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 }, driftAfter: 0.05 });
    const s4 = createS4Ivb();
    const refused = simulateBars(bars, s4, { minStrength: 1, canOrder: () => false }, "SOL");
    expect(refused.signalsSeen).toBe(1);
    expect(refused.ordersPlaced).toBe(0);
    expect(refused.ordersByDay).toEqual({});
    const placed = simulateBars(bars, s4, { minStrength: 1 }, "SOL");
    expect(placed.ordersPlaced).toBe(1);
    expect(placed.ordersByDay).toEqual({ "2026-09-21": 1 });
    expect(placed.trades[0]!.side).toBe("BUY");
    expect(placed.trades[0]!.strategyId).toBe("s4-ivb");
    // Un signal sous la force minimale n'est ni vu ni ordonné.
    expect(simulateBars(bars, s4, { minStrength: 101 }, "SOL").signalsSeen).toBe(0);
  });

  it("simulateBars : entrée à l'ouverture suivante, objectif, stop, sortie forcée 16 h ET (time-stop)", () => {
    const s4 = createS4Ivb();
    const tp = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 }, driftAfter: 0.05 });
    const t1 = simulateBars(tp.bars, s4, { minStrength: 1 }, "SOL").trades[0]!;
    expect(t1.exit).toBe("take-profit");
    expect(t1.entryPrice).toBe(tp.bars[tp.dayStart + 9]!.open);
    expect(t1.grossRet).toBeGreaterThan(0);
    expect(t1.ret).toBeCloseTo(t1.grossRet - 0.003, 12);
    const sl = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 }, driftAfter: -0.05 });
    const t2 = simulateBars(sl.bars, s4, { minStrength: 1 }, "SOL").trades[0]!;
    expect(t2.exit).toBe("stop-loss");
    expect(t2.ret).toBeLessThan(0);
    const flat = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 } });
    const t3 = simulateBars(flat.bars, s4, { minStrength: 1 }, "SOL").trades[0]!;
    expect(t3.exit).toBe("time-stop");
    expect(t3.exitAt).toBe(new Date(zonedTimeToUtc(NY, 2026, 9, 21, 16, 0)).toISOString());
    // Short : rendement inversé.
    const sh = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "SELL", volume: 300 }, driftAfter: -0.05 });
    const t4 = simulateBars(sh.bars, s4, { minStrength: 1 }, "SOL").trades[0]!;
    expect(t4.side).toBe("SELL");
    expect(t4.exit).toBe("take-profit");
    expect(t4.grossRet).toBeGreaterThan(0);
  });

  it("fixture tests/fixtures/ohlcv/SOL-5m.jsonl : ≥ 40 séances, régénérable à l'identique, backtest déterministe", () => {
    const text = readFileSync(join(HERE, "fixtures", "ohlcv", "SOL-5m.jsonl"), "utf8");
    const bars = parseOhlcvJsonl(text);
    const sessions = new Set(bars.map((b) => localStamp(b.ts, NY).day));
    expect(sessions.size).toBeGreaterThanOrEqual(40);
    expect(bars.length).toBe(sessions.size * 78);
    expect(toCompactJsonl(synthOhlcv(SOL_FIXTURE_OPTIONS))).toBe(text);
    expect(tradingDays("2026-10-05", 3)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
    // La fixture traverse le changement d'heure : offsets −240 puis −300.
    expect(utcOffsetMinutes(bars[0]!.ts, NY)).toBe(-240);
    expect(utcOffsetMinutes(bars[bars.length - 1]!.ts, NY)).toBe(-300);
    const r1 = runBarsBacktest(new Map([["SOL", bars]]), createS4Ivb(), { minStrength: 1 });
    const r2 = runBarsBacktest(new Map([["SOL", bars]]), createS4Ivb(), { minStrength: 1 });
    expect(r1).toEqual(r2);
    expect(r1.ordersPlaced).toBe(10);
    expect(r1.signalsSeen).toBe(10);
    expect(r1.conclusive).toBe(false); // 10 < 30 : la fixture ne « prouve » rien, elle exerce la mécanique
    expect(r1.exits["take-profit"] + r1.exits["stop-loss"] + r1.exits["time-stop"]).toBe(10);
    expect(Object.values(r1.ordersByDay).every((n) => n === 1)).toBe(true);
    // Séance 28 (volume × 1.2) et 37 (cassure à 11 h 40) ne produisent aucun ordre.
    expect(r1.ordersByDay["SOL:2026-11-12"]).toBeUndefined();
    expect(r1.ordersByDay["SOL:2026-11-25"]).toBeUndefined();
  });

  it("parseOhlcvJsonl accepte objets et tableaux, ignore les lignes corrompues", () => {
    const bars = parseOhlcvJsonl('{"ts":1,"open":1,"high":2,"low":0.5,"close":1.5,"volume":10}\n[2,1,2,0.5,1.5,10]\n\n{pas json\n[3,"x",2,0.5,1.5,10]\n');
    expect(bars.length).toBe(2);
    expect(bars[1]).toEqual({ ts: 2, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  });
});

// ---------------------------------------------------------------------------
describe("métriques par stratégie", () => {
  const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
  /** n trades espacés de `gapHours`, rendements cycliques. */
  const trades = (n: number, rets: number[], strategyId = "s1-volume", gapHours = 6, sol?: number[]): StrategyTrade[] =>
    Array.from({ length: n }, (_, i) => ({
      strategyId,
      key: "M",
      side: "BUY" as const,
      entryAt: new Date(T0 + i * gapHours * 3_600_000).toISOString(),
      exitAt: new Date(T0 + i * gapHours * 3_600_000 + 3_600_000).toISOString(),
      ret: rets[i % rets.length]!,
      fees: 0.013,
      slippage: 0.001,
      ...(sol ? { context: { solChange24hPct: sol[i % sol.length]! } } : {}),
    }));

  it("n < 30 → conclusive: false + message explicite ; n = 0 → tout à null", () => {
    const m = computeStrategyMetrics(trades(12, [0.1, -0.05]));
    expect(m.n).toBe(12);
    expect(m.conclusive).toBe(false);
    expect(m.message).toMatch(/n=12 < 30 trades .* AUCUNE conclusion/);
    expect(m.winRate).toBeCloseTo(0.5, 10);
    const z = computeStrategyMetrics([], "vide");
    expect(z).toMatchObject({ n: 0, conclusive: false, winRate: null, sharpe: null, maxDrawdown: null, strategyId: "vide" });
    expect(z.message).toMatch(/n=0/);
  });

  it("n ≥ 30 → conclusive: true ; win rate, espérance, profit factor, drawdown, gains/pertes moyens, frais, slippage", () => {
    const m = computeStrategyMetrics(trades(30, [0.1, -0.05]));
    expect(m.conclusive).toBe(true);
    expect(m.n).toBe(MIN_TRADES_FOR_CONCLUSION);
    expect(m.winRate).toBeCloseTo(0.5, 10);
    expect(m.expectancy).toBeCloseTo(0.025, 10);
    expect(m.profitFactor).toBeCloseTo(1.5 / 0.75, 10);
    expect(m.avgWin).toBeCloseTo(0.1, 10);
    expect(m.avgLoss).toBeCloseTo(-0.05, 10);
    expect(m.avgFees).toBeCloseTo(0.013, 10);
    expect(m.avgSlippage).toBeCloseTo(0.001, 10);
    expect(m.maxDrawdown).toBeCloseTo(0.05, 10); // une perte de 5 % après un pic
    expect(m.firstEntryAt).toBe(new Date(T0).toISOString());
  });

  it("déterminisme : ordre d'entrée mélangé ⇒ métriques identiques", () => {
    const base = trades(40, [0.2, -0.1, 0.05, -0.02, 0.3]);
    const shuffled = [...base].sort((a, b) => (a.ret > b.ret ? -1 : 1)).reverse();
    const m1 = computeStrategyMetrics(base);
    const m2 = computeStrategyMetrics(shuffled);
    expect(m2).toEqual(m1);
    expect(JSON.stringify(computeAllMetrics(base))).toBe(JSON.stringify(computeAllMetrics(shuffled)));
  });

  it("Sharpe / Sortino par trade, annualisés × √(trades/an) quand la période ≥ 1 jour, sinon facteur 1", () => {
    const rets = [0.1, -0.05, 0.02, -0.01];
    const m = computeStrategyMetrics(trades(40, rets)); // 40 trades sur 39 × 6 h + 1 h ≈ 9,79 j
    const mean = rets.reduce((a, b) => a + b, 0) / 4;
    const xs = Array.from({ length: 40 }, (_, i) => rets[i % 4]!);
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / 39);
    const down = Math.sqrt(xs.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / 40);
    expect(m.annualization.applied).toBe(true);
    expect(m.annualization.tradesPerYear).toBeCloseTo(40 / (m.annualization.spanDays / 365.25), 8);
    expect(m.sharpe).toBeCloseTo((mean / sd) * m.annualization.factor, 8);
    expect(m.sortino).toBeCloseTo((mean / down) * m.annualization.factor, 8);
    const intraday = computeStrategyMetrics(trades(4, rets, "x", 0.25)); // 1 h 45 au total
    expect(intraday.annualization).toMatchObject({ applied: false, factor: 1, tradesPerYear: null });
    expect(intraday.sharpe).toBeCloseTo(mean / sd * 0 + mean / Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / 3), 8);
    // Rendements constants → écart-type nul → Sharpe null (pas d'infini).
    expect(computeStrategyMetrics(trades(5, [0.01])).sharpe).toBeNull();
  });

  it("performance par régime : heure (fuseau), jour de semaine, tendance SOL 24 h ; buckets non concluants marqués", () => {
    const m = computeStrategyMetrics(trades(6, [0.1, -0.1, 0.2], "s", 24, [1.5, -2, 0]), undefined, { timeZone: "America/Moncton" });
    // T0 = 1er sept. 2026 12:00 Z (mardi) = 09:00 à Moncton (UTC−3).
    expect(Object.keys(m.byRegime.hour)).toEqual(["09"]);
    expect(m.byRegime.hour["09"]!.n).toBe(6);
    expect(Object.keys(m.byRegime.weekday)).toEqual(["dim", "jeu", "mar", "mer", "sam", "ven"]); // mardi → dimanche, trié
    expect(m.byRegime.weekday["mar"]).toMatchObject({ n: 1, conclusive: false, expectancy: 0.1 });
    expect(m.byRegime.solTrend["up"]).toMatchObject({ n: 2, expectancy: 0.1 });
    expect(m.byRegime.solTrend["down"]).toMatchObject({ n: 2, expectancy: -0.1 });
    expect(m.byRegime.solTrend["flat"]).toMatchObject({ n: 2, expectancy: 0.2 });
    expect(computeStrategyMetrics(trades(3, [0.1])).byRegime.solTrend).toEqual({ unknown: expect.objectContaining({ n: 3 }) });
    // Heure UTC vs Moncton.
    expect(Object.keys(computeStrategyMetrics(trades(1, [0.1]), undefined, { timeZone: "UTC" }).byRegime.hour)).toEqual(["12"]);
    expect(formatMetrics(m)).toMatch(/tendance SOL 24 h : down n=2\* .* ; flat n=2\* .* ; up n=2\*/);
  });

  it("computeAllMetrics sépare les stratégies ; tradesFromBacktest adapte les trades du harnais", () => {
    const mixed = [...trades(3, [0.1], "a"), ...trades(2, [-0.1], "b")];
    const all = computeAllMetrics(mixed);
    expect(all.map((m) => [m.strategyId, m.n])).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
    const { bars } = history(10, 1, { day: "", width: 0.5, breakout: { offsetBars: 2, side: "BUY", volume: 300 }, driftAfter: 0.05 });
    const sim = simulateBars(bars, createS4Ivb(), { minStrength: 1, context: { solChange24hPct: -3 } }, "SOL");
    const adapted = tradesFromBacktest(sim.trades);
    expect(adapted[0]).toMatchObject({ strategyId: "s4-ivb", key: "SOL", side: "BUY", context: { solChange24hPct: -3 } });
    expect(computeStrategyMetrics(adapted).byRegime.solTrend["down"]?.n).toBe(1);
    expect(tradesFromBacktest([{ mint: "m", entryAt: "a", exitAt: "b", ret: 0.1, grossRet: 0.12, costs: 0.02 }])[0]!.strategyId).toBe("adhoc");
  });

  it("tradesFromLedger : BUY puis SELL remplis → un trade avec frais et slippage ; ventes orphelines ignorées", () => {
    const fill = (qty: number, netCad: number, slippageBps: number) => ({ priceUsd: 1, fxCadPerUsd: 1.35, qty, grossCad: netCad, netCad, slippageBps });
    const e = (o: Partial<LedgerEntry>): LedgerEntry => ({ ts: "2026-09-01T00:00:00.000Z", intentId: "i", mint: "M", kind: "BUY", decision: "PAPER", mode: "paper", reasons: [], requestedSizeCad: 40, ...o });
    const ledger: LedgerEntry[] = [
      e({ ts: "2026-09-01T00:00:00.000Z", kind: "SELL", fill: fill(1, 10, 10) }), // orpheline
      e({ ts: "2026-09-01T01:00:00.000Z", kind: "BUY", fill: fill(100, 40, 20), fees: { platformCad: 0.4, swapCad: 0, priorityCad: 0.1, totalCad: 0.5 }, reasons: ["strategy:s3-migration"] }),
      e({ ts: "2026-09-01T02:00:00.000Z", kind: "BUY", decision: "REJECTED", fill: fill(100, 40, 20) }), // non rempli
      e({ ts: "2026-09-02T03:00:00.000Z", kind: "SELL", fill: fill(100, 48, 30), fees: { platformCad: 0.5, swapCad: 0, priorityCad: 0, totalCad: 0.5 }, pnlCad: 8 }),
    ];
    const t = tradesFromLedger(ledger);
    expect(t.length).toBe(1);
    expect(t[0]).toMatchObject({ strategyId: "s3-migration", key: "M", entryAt: "2026-09-01T01:00:00.000Z", exitAt: "2026-09-02T03:00:00.000Z" });
    expect(t[0]!.ret).toBeCloseTo(8 / 40, 10);
    expect(t[0]!.fees).toBeCloseTo(1 / 40, 10);
    expect(t[0]!.slippage).toBeCloseTo((25 * 2) / 10_000, 10);
    expect(t[0]!.grossRet).toBeCloseTo(9 / 40, 10);
    const m = computeStrategyMetrics(t);
    expect(m.conclusive).toBe(false);
    expect(m.avgFees).toBeCloseTo(0.025, 10);
  });
});
