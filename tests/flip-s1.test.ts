/**
 * Tests FLIP ENGINE Sprint 1 — labels forward, stats, lead-lag (données synthétiques).
 * Aucun accès réseau : logique pure uniquement.
 */
import { describe, expect, it } from "vitest";
import {
  labelCascade,
  labelCascades,
  labelBaselineBars,
  MIN,
  type ForwardLabel,
} from "../lab/flip/labels.js";
import {
  wilsonCI,
  twoPropZ,
  bootstrapMedianCI,
  median,
  signTest,
} from "../lab/flip/stats.js";
import {
  alignTroughs,
  summarizeLeadLag,
} from "../lab/flip/leadlag.js";
import {
  toBars5m,
  detectCascades,
  detectAbsorption,
  DEFAULT_CFG,
  type Bar5m,
  type Kline1m,
  type FlipEvent,
} from "../lab/flip/events.js";

/** Klines 1m synthétiques : prix plat puis scénario. */
function mkKlines(n: number, px: (i: number) => number): Kline1m[] {
  const out: Kline1m[] = [];
  for (let i = 0; i < n; i++) {
    const c = px(i);
    out.push({ t: i * MIN, o: c, h: c * 1.0005, l: c * 0.9995, c, v: 100, buyVol: 50, n: 10 });
  }
  return out;
}

const OPT = { maxForwardT: 10_000 * MIN };

describe("labelCascade", () => {
  it("reversal détecté quand le prix récupère ≥50% de l'excursion (E1)", () => {
    // chute à i=100 (100 → 95), récupération à 101 sous 1h
    const klines = mkKlines(600, (i) => (i < 100 ? 100 : i < 110 ? 95 : 101));
    const lab = labelCascade(klines, "E1", 100 * MIN, 100, 94.9, 100.1, OPT);
    expect(lab).not.toBeNull();
    expect(lab!.reversal1h).toBe(true);
    expect(lab!.reversal4h).toBe(true);
    expect(lab!.continuation1h).toBe(false);
    expect(lab!.yRev1h).toBeGreaterThan(0);
  });
  it("continuation détectée sur nouveau plus bas (E1)", () => {
    const klines = mkKlines(600, (i) => (i < 100 ? 100 : 94 - (i - 100) * 0.01));
    const lab = labelCascade(klines, "E1", 100 * MIN, 100, 94.9, 100.1, OPT);
    expect(lab).not.toBeNull();
    expect(lab!.continuation1h).toBe(true);
    expect(lab!.reversal1h).toBe(false);
    expect(lab!.yRev1h).toBeLessThan(0);
  });
  it("miroir E2 : reversal = prix qui redescend sous le pré-événement", () => {
    const klines = mkKlines(600, (i) => (i < 100 ? 100 : i < 110 ? 105 : 99));
    const lab = labelCascade(klines, "E2", 100 * MIN, 100, 99.9, 105.1, OPT);
    expect(lab).not.toBeNull();
    expect(lab!.reversal1h).toBe(true);
    expect(lab!.yRev1h).toBeGreaterThan(0); // signé sens reversal
  });
  it("null si forward insuffisant (garde anti-données-manquantes)", () => {
    const klines = mkKlines(600, (i) => 100);
    const lab = labelCascade(klines, "E1", 100 * MIN, 100, 94.9, 100.1, { maxForwardT: 100 * MIN + 60 * MIN });
    expect(lab).toBeNull();
  });
  it("n'utilise que le forward : un spike AVANT tEvent ne compte pas", () => {
    // spike +10% avant tEvent (fuite potentielle), prix reste bas après → ni reversal ni continuation
    const klines = mkKlines(600, (i) => (i >= 50 && i < 90 ? 110 : i < 100 ? 100 : 94));
    const lab = labelCascade(klines, "E1", 100 * MIN, 100, 93.9, 100.1, OPT);
    expect(lab).not.toBeNull();
    expect(lab!.reversal4h).toBe(false); // serait true si le scan incluait t < tEvent
    expect(lab!.continuation4h).toBe(false);
  });
});

describe("labelCascades (conditionnement E12 point-in-time)", () => {
  it("tEvent absorbé = clôture E12 ; non absorbé = clôture cascade + 15 min", () => {
    // construit des barres 5m avec une cascade E1 à la barre 2100 puis absorption
    const bars: Bar5m[] = [];
    for (let i = 0; i < 2500; i++) {
      bars.push({
        t: i * 5 * MIN, o: 100, h: 100.1, l: 99.9, c: 100,
        v: 1000, buyRatio: 0.5 + 0.02 * Math.sin(i * 0.9), ret: 0,
      });
    }
    const crash = bars[2100]!;
    crash.c = 95; crash.l = 94.5; crash.v = 12000; crash.buyRatio = 0.08;
    crash.ret = Math.log(95 / 100);
    bars[2101]!.ret = Math.log(100 / 95);
    bars[2102]!.buyRatio = 0.95; bars[2102]!.v = 8000;
    const casc = detectCascades(bars, DEFAULT_CFG).filter((e) => e.type === "E1");
    expect(casc.length).toBeGreaterThanOrEqual(1);
    const abs = detectAbsorption(casc, bars, DEFAULT_CFG);
    expect(abs.length).toBeGreaterThanOrEqual(1);
    // klines 1m plates autour (labels triviaux, on ne teste que les tEvent)
    const klines = mkKlines(2500 * 5, () => 100);
    const labs = labelCascades(klines, bars, casc, abs, { maxForwardT: 2500 * 5 * MIN });
    const first = labs[0]!;
    expect(first.absorbed).toBe(true);
    expect(first.tEvent).toBe(abs[0]!.t + 5 * MIN);
  });
});

describe("labelBaselineBars", () => {
  it("même convention tEvent = clôture, exclut ±4h des cascades", () => {
    const bars: Bar5m[] = [];
    for (let i = 0; i < 3000; i++) {
      bars.push({
        t: i * 5 * MIN, o: 100, h: 100.1, l: 99.9, c: 100,
        v: 1000, buyRatio: 0.5, ret: i % 2 ? 0.001 : -0.001,
      });
    }
    const klines = mkKlines(3000 * 5, () => 100);
    const fakeCascade: FlipEvent = { type: "E1", t: 1500 * 5 * MIN, price: 100, amplitude: -0.05, durationMin: null, meta: {} };
    const labs = labelBaselineBars(klines, bars, [fakeCascade], { maxForwardT: 3000 * 5 * MIN }, 100, false, 0);
    expect(labs.length).toBeGreaterThan(0);
    // aucune baseline strictement à l'intérieur de la zone d'exclusion ±4h
    const near = labs.filter((l) => Math.abs(l.tEvent - fakeCascade.t) < 235 * MIN);
    expect(near).toHaveLength(0);
  });
});

describe("stats", () => {
  it("wilsonCI : 0/0 → NaN, bornes dans [0,1]", () => {
    expect(wilsonCI(0, 0)[0]).toBeNaN();
    const [lo, hi] = wilsonCI(60, 100);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThan(0.6);
    expect(hi).toBeGreaterThan(0.6);
  });
  it("twoPropZ : différence évidente → p petite ; identiques → p ~ 1", () => {
    const sig = twoPropZ(80, 100, 50, 100);
    expect(sig.pValue).toBeLessThan(1e-4);
    expect(sig.diff).toBeCloseTo(0.3, 9);
    const nosig = twoPropZ(50, 100, 51, 100);
    expect(nosig.pValue).toBeGreaterThan(0.5);
  });
  it("bootstrapMedianCI déterministe et centré sur la médiane", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const [lo, hi] = bootstrapMedianCI(xs, 500, 7);
    const [lo2, hi2] = bootstrapMedianCI(xs, 500, 7);
    expect([lo, hi]).toEqual([lo2, hi2]);
    expect(lo).toBeLessThanOrEqual(median(xs));
    expect(hi).toBeGreaterThanOrEqual(median(xs));
  });
  it("signTest : asymétrie claire → p petite", () => {
    const { pValue } = signTest([...new Array(80).fill(1), ...new Array(20).fill(-1)]);
    expect(pValue).toBeLessThan(1e-6);
  });
});

describe("leadlag", () => {
  it("lag positif quand HL creuse après Binance", () => {
    const mk = (t0: number): Bar5m[] => {
      const out: Bar5m[] = [];
      for (let i = 0; i < 40; i++) {
        out.push({ t: t0 + i * 5 * MIN, o: 100, h: 100.2, l: 99.8, c: 100, v: 100, buyRatio: 0.5, ret: 0 });
      }
      return out;
    };
    const bin = mk(0);
    bin[20]!.l = 95; // creux Binance à t=20
    const hl = mk(0).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    hl[22]!.l = 95; // creux HL 10 min plus tard
    const pts = alignTroughs([{ t: 20 * 5 * MIN, type: "E1" }], bin, hl, 30);
    expect(pts[0]!.lagS).toBe(600);
    const s = summarizeLeadLag(pts);
    expect(s.refLeads).toBe(1);
    expect(s.otherLeads).toBe(0);
  });
  it("tied quand |lag| ≤ 300s (résolution 5m)", () => {
    const mk = (t0: number) => {
      const out: Bar5m[] = [];
      for (let i = 0; i < 40; i++) out.push({ t: t0 + i * 5 * MIN, o: 100, h: 100.2, l: 99.8, c: 100, v: 100, buyRatio: 0.5, ret: 0 });
      return out;
    };
    const bin = mk(0);
    bin[20]!.l = 95;
    const hl = mk(0).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    hl[21]!.l = 94.9; // 5 min plus tard → indiscernable
    const s = summarizeLeadLag(alignTroughs([{ t: 20 * 5 * MIN, type: "E1" }], bin, hl, 30));
    expect(s.tied).toBe(1);
    expect(s.refLeads).toBe(0);
  });
  it("null si pas de creux dans la fenêtre", () => {
    const mk = () => {
      const out: Bar5m[] = [];
      for (let i = 0; i < 10; i++) out.push({ t: i * 5 * MIN, o: 100, h: 100.2, l: 99.8, c: 100, v: 100, buyRatio: 0.5, ret: 0 });
      return out;
    };
    const pts = alignTroughs([{ t: 10_000 * 5 * MIN, type: "E1" }], mk(), mk().map((b) => ({ ...b })), 30);
    expect(pts[0]!.lagS).toBeNull();
  });
});

describe("toBars5m (rappel contiguïté)", () => {
  it("5 klines → 1 barre, utilisé par run-s1 après vérification des gaps", () => {
    const klines = mkKlines(10, (i) => 100 + i);
    expect(toBars5m(klines)).toHaveLength(2);
  });
});
