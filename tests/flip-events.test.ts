/**
 * Tests FLIP ENGINE — détecteurs d'événements §66 (données synthétiques).
 * Aucun accès réseau : logique pure uniquement.
 */
import { describe, expect, it } from "vitest";
import {
  percentile,
  rollingPctRank,
  toBars5m,
  detectCascades,
  detectAbsorption,
  detectHourly,
  describeEvents,
  DEFAULT_CFG,
  HOUR_CFG,
  type Bar5m,
  type HourRow,
  type Kline1m,
} from "../lab/flip/events.js";

function flatBars(n: number, px = 100): Bar5m[] {
  const bars: Bar5m[] = [];
  for (let i = 0; i < n; i++) {
    bars.push({
      t: i * 300_000, o: px, h: px * 1.001, l: px * 0.999, c: px,
      // bruit déterministe réaliste : buyRatio/volume ne sont jamais parfaitement constants
      v: 1000 * (1 + 0.05 * Math.sin(i * 1.7)),
      buyRatio: 0.5 + 0.02 * Math.sin(i * 0.9),
      ret: 0,
    });
  }
  return bars;
}

/** Accès indexé sûr pour les tests (les barres existent par construction). */
const at = (bars: Bar5m[], i: number): Bar5m => bars[i] as Bar5m;

describe("percentile", () => {
  it("p50 d'une série simple", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBeCloseTo(3, 9);
  });
  it("vide → NaN", () => {
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("rollingPctRank", () => {
  it("est causal : pas de lookahead", () => {
    const a = [1, 2, 3, 4, 5, 100, 100, 100];
    const b = [1, 2, 3, 4, 5, -100, -100, -100];
    // le rang à i=4 ne doit pas dépendre des valeurs futures
    expect(rollingPctRank(a, 4, 10)).toBeCloseTo(rollingPctRank(b, 4, 10), 9);
  });
  it("le minimum a un rang bas", () => {
    const s = [5, 5, 5, 5, 5, 5, 5, 5, 5, 1];
    expect(rollingPctRank(s, 9, 10)).toBeLessThanOrEqual(10);
  });
  it("fenêtre dégénérée (constante) → 50, pas 100", () => {
    const s = new Array(50).fill(0.0000125);
    expect(rollingPctRank(s, 49, 50)).toBe(50);
  });
});

describe("toBars5m", () => {
  it("agrège 5 klines 1m", () => {
    const klines: Kline1m[] = [];
    for (let i = 0; i < 10; i++) {
      klines.push({ t: i * 60_000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 10, buyVol: 6, n: 5 });
    }
    const bars = toBars5m(klines);
    expect(bars).toHaveLength(2);
    expect(at(bars, 0).o).toBe(100);
    expect(at(bars, 0).h).toBe(105);
    expect(at(bars, 0).c).toBe(104.5);
    expect(at(bars, 0).buyRatio).toBeCloseTo(0.6, 9);
    expect(at(bars, 1).ret).toBeCloseTo(Math.log(109.5 / 104.5), 9);
  });
});

describe("detectCascades", () => {
  it("détecte E1 sur chute + imbalance vendeur + volume", () => {
    const bars = flatBars(2500);
    const crash = at(bars, 2000);
    crash.c = 95; crash.l = 94.5; crash.v = 12000; crash.buyRatio = 0.08;
    crash.ret = Math.log(95 / 100);
    at(bars, 2001).ret = Math.log(100 / 95);
    const evs = detectCascades(bars, DEFAULT_CFG);
    const e1 = evs.filter((e) => e.type === "E1");
    expect(e1.length).toBeGreaterThanOrEqual(1);
    expect(e1[0]!.amplitude).toBeLessThan(0);
    expect((e1[0]!.meta.retRank as number)).toBeLessThanOrEqual(1);
  });
  it("détecte E2 sur spike acheteur (miroir)", () => {
    const bars = flatBars(2500);
    const spike = at(bars, 2000);
    spike.c = 105; spike.h = 105.5; spike.v = 12000; spike.buyRatio = 0.92;
    spike.ret = Math.log(105 / 100);
    at(bars, 2001).ret = Math.log(100 / 105);
    const evs = detectCascades(bars, DEFAULT_CFG);
    expect(evs.some((e) => e.type === "E2")).toBe(true);
  });
  it("pas d'événement sur marché plat", () => {
    const bars = flatBars(2500);
    expect(detectCascades(bars, DEFAULT_CFG)).toHaveLength(0);
  });
  it("pas de cascade sans volume (chute seule ne suffit pas)", () => {
    const bars = flatBars(2500);
    const crash = at(bars, 2000);
    crash.c = 95; crash.l = 94.5; crash.v = 1000; crash.buyRatio = 0.08; // volume normal
    crash.ret = Math.log(95 / 100);
    at(bars, 2001).ret = Math.log(100 / 95);
    const evs = detectCascades(bars, DEFAULT_CFG);
    expect(evs.filter((e) => e.type === "E1")).toHaveLength(0);
  });
  it("debounce : peu d'événements pour une chute prolongée", () => {
    const bars = flatBars(2500);
    for (const i of [2000, 2001, 2002]) {
      const b = at(bars, i);
      b.c = 100 - (i - 1999) * 2;
      b.l = b.c - 0.5;
      b.v = 12000; b.buyRatio = 0.08;
      b.ret = Math.log(b.c / (i === 2000 ? 100 : at(bars, i - 1).c));
    }
    const evs = detectCascades(bars, DEFAULT_CFG).filter((e) => e.type === "E1");
    expect(evs.length).toBeLessThanOrEqual(2);
  });
  it("durationMin : prix qui revient → durée mesurée", () => {
    const bars = flatBars(2500);
    const crash = at(bars, 2000);
    crash.c = 95; crash.l = 94.5; crash.v = 12000; crash.buyRatio = 0.08;
    crash.ret = Math.log(95 / 100);
    // retour immédiat sous le seuil 0.3%
    at(bars, 2001).c = 99.9;
    at(bars, 2001).ret = Math.log(99.9 / 95);
    const evs = detectCascades(bars, DEFAULT_CFG).filter((e) => e.type === "E1");
    expect(evs.length).toBeGreaterThanOrEqual(1);
    expect(evs[0]!.durationMin).not.toBeNull();
    expect(evs[0]!.durationMin!).toBeLessThanOrEqual(10);
  });
});

describe("detectAbsorption", () => {
  it("détecte E12 après E1 quand le contre-flux acheteur dépasse le niveau pré-événement", () => {
    const bars = flatBars(2500);
    const crash = at(bars, 2000);
    crash.c = 95; crash.l = 94.5; crash.v = 12000; crash.buyRatio = 0.08;
    crash.ret = Math.log(95 / 100);
    at(bars, 2001).ret = Math.log(100 / 95);
    at(bars, 2002).buyRatio = 0.95; at(bars, 2002).v = 8000; // contre-flux genuin
    const casc = detectCascades(bars, DEFAULT_CFG).filter((e) => e.type === "E1");
    const abs = detectAbsorption(casc, bars, DEFAULT_CFG);
    expect(abs.length).toBeGreaterThanOrEqual(1);
    expect(abs[0]!.type).toBe("E12");
    expect(abs[0]!.durationMin!).toBeLessThanOrEqual(15);
  });
  it("pas d'E12 sur simple retour à la normale (pas de contre-flux)", () => {
    const bars = flatBars(2500);
    const crash = at(bars, 2000);
    crash.c = 95; crash.l = 94.5; crash.v = 12000; crash.buyRatio = 0.08;
    crash.ret = Math.log(95 / 100);
    at(bars, 2001).ret = Math.log(100 / 95);
    // buyRatio revient juste à ~0.5 : pas d'absorption au sens E12
    const casc = detectCascades(bars, DEFAULT_CFG).filter((e) => e.type === "E1");
    expect(detectAbsorption(casc, bars, DEFAULT_CFG)).toHaveLength(0);
  });
});

function flatHours(n: number): HourRow[] {
  const rows: HourRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      t: i * 3_600_000, ret1h: 0.0001, oi: 1_000_000,
      oiChg1h: 0.0001, premium: 0.0001, funding: 0.00001,
    });
  }
  return rows;
}

describe("detectHourly", () => {
  it("E3 sur funding extrême (percentile + plancher absolu)", () => {
    const hrs = flatHours(200);
    hrs[150]!.funding = 0.01;
    const evs = detectHourly(hrs, HOUR_CFG);
    expect(evs.some((e) => e.type === "E3" && e.t === hrs[150]!.t)).toBe(true);
  });
  it("pas d'E3 quand le funding est quasi-constant (anti-artefact)", () => {
    const hrs = flatHours(200);
    // funding constant au max local : le percentile seul dirait E3, le plancher absolu dit non
    for (const r of hrs) r.funding = 0.0000125;
    hrs[150]!.funding = 0.000013;
    const evs = detectHourly(hrs, HOUR_CFG);
    expect(evs.some((e) => e.type === "E3")).toBe(false);
  });
  it("E5/E6 sur expansion/collapse OI", () => {
    const hrs = flatHours(200);
    hrs[150]!.oiChg1h = 0.25;
    hrs[160]!.oiChg1h = -0.25;
    const evs = detectHourly(hrs, HOUR_CFG);
    expect(evs.some((e) => e.type === "E5" && e.t === hrs[150]!.t)).toBe(true);
    expect(evs.some((e) => e.type === "E6" && e.t === hrs[160]!.t)).toBe(true);
  });
  it("E8 : prix↑ + OI↓ ; E9 : prix↓ + OI↑", () => {
    const hrs = flatHours(200);
    hrs[150]!.ret1h = 0.05; hrs[150]!.oiChg1h = -0.05;
    hrs[160]!.ret1h = -0.05; hrs[160]!.oiChg1h = 0.05;
    const evs = detectHourly(hrs, HOUR_CFG);
    expect(evs.some((e) => e.type === "E8" && e.t === hrs[150]!.t)).toBe(true);
    expect(evs.some((e) => e.type === "E9" && e.t === hrs[160]!.t)).toBe(true);
  });
  it("E7 sur choc de premium absolu", () => {
    const hrs = flatHours(200);
    hrs[150]!.premium = -0.02;
    const evs = detectHourly(hrs, HOUR_CFG);
    expect(evs.some((e) => e.type === "E7" && e.t === hrs[150]!.t)).toBe(true);
  });
  it("pas d'événement sur régime plat", () => {
    expect(detectHourly(flatHours(200), HOUR_CFG)).toHaveLength(0);
  });
});

describe("describeEvents", () => {
  it("compte et calcule les descriptifs", () => {
    const bars = flatBars(2500);
    const crash = at(bars, 2000);
    crash.c = 95; crash.l = 94.5; crash.v = 12000; crash.buyRatio = 0.08;
    crash.ret = Math.log(95 / 100);
    at(bars, 2001).ret = Math.log(100 / 95);
    const evs = detectCascades(bars, DEFAULT_CFG);
    const stats = describeEvents(evs, 30);
    const s1 = stats.find((s) => s.type === "E1")!;
    expect(s1.n).toBeGreaterThanOrEqual(1);
    expect(s1.perDay).toBeCloseTo(s1.n / 30, 9);
    expect(s1.amplitudePct).not.toBeNull();
    expect(s1.amplitudePct!.p50).toBeGreaterThan(0);
  });
});
