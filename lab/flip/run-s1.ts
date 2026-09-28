/**
 * FLIP ENGINE — Branch B, Sprint 1 : premiers tests prédictifs H-FLIP-01/06/10.
 *
 * DISCOVERY UNIQUEMENT. Le holdout n'est jamais lu (assert en dur).
 * Splits chronologiques gelés (spec §8) appliqués à l'historique complet collecté
 * (2026-03-28 → 2026-09-27) : discovery 60 % | calibration 20 % | holdout 20 %.
 * NOTE : les bornes Sprint 0 (échantillon 30j) sont caduques — l'historique complet
 * a changé ; la RÈGLE 60/20/20 est gelée, pas les dates.
 *
 * Anti-leakage : features causales (rollingPctRank ≤ t), tEvent = clôture de barre,
 * labels forward uniquement, conditionnement E12 point-in-time (voir labels.ts).
 * LEAKAGE_STATUS documenté par test dans le JSON de résultats.
 */
import {
  toBars5m, detectCascades, detectAbsorption, rollingPctRank,
  DEFAULT_CFG, type Bar5m, type FlipEvent, type Kline1m,
} from "./events.js";
import { labelCascades, labelBaselineBars, MIN, type ForwardLabel, type LabeledCascade } from "./labels.js";
import { wilsonCI, twoPropZ, bootstrapMedianCI, median, mean, signTest } from "./stats.js";
import { alignTroughs, summarizeLeadLag, type HLCandle } from "./leadlag.js";
import { readJsonlSync, writeJson, DATA_DIR } from "./store.js";

// ---------------------------------------------------------------- splits
const DS_START = Date.parse("2026-03-28T00:00:00Z");
const DS_END = Date.parse("2026-09-27T23:59:59Z");
const SPAN = DS_END - DS_START;
const DISCOVERY_END = DS_START + 0.6 * SPAN;
const CALIB_END = DS_START + 0.8 * SPAN;
const HOLDOUT_START = CALIB_END; // jamais lu
const WARMUP_MS = 7 * 24 * 3600_000;
const MAX_FORWARD_T = DISCOVERY_END + 24 * 3600_000; // labels ≤ +24h
if (!(MAX_FORWARD_T < HOLDOUT_START)) {
  throw new Error("LEAK GUARD: la fenêtre forward discovery chevaucherait le holdout");
}
const EV_START = DS_START + WARMUP_MS; // warmup 7j pour les percentiles causaux
const EV_END = DISCOVERY_END - 4 * 3600_000; // labels 4h complets

const N_MIN = 30;
const FEE_BP = 5; // taker Binance VIP0, barème public — par jambe
const SLIP_BP = 5; // ESTIMÉ (pas de carnet historique) — par jambe

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const pct = (x: number) => r2(x * 100);

interface Num { [k: string]: number | string | boolean | null | number[] }

function loadAll() {
  const tag = "2026-03_2026-09";
  const klines: Kline1m[] = readJsonlSync(`klines-solusdt-1m-${tag}.jsonl`).map((r) => ({
    t: r[0] as number, o: r[1] as number, h: r[2] as number, l: r[3] as number,
    c: r[4] as number, v: r[5] as number, buyVol: r[6] as number, n: r[7] as number,
  }));
  const hl: HLCandle[] = readJsonlSync(`hl-candles-sol-5m-${tag}.jsonl`).map((r) => ({
    t: r[0] as number, o: r[1] as number, h: r[2] as number, l: r[3] as number,
    c: r[4] as number, v: r[5] as number,
  }));
  const metrics: Array<{ t: number; oi: number }> = readJsonlSync(`metrics-solusdt-30m-${tag}.jsonl`)
    .map((r) => ({ t: r[0] as number, oi: r[1] as number }));
  const spot: Kline1m[] = readJsonlSync(`klines-spot-solusdt-1m-${tag}.jsonl`).map((r) => ({
    t: r[0] as number, o: r[1] as number, h: r[2] as number, l: r[3] as number,
    c: r[4] as number, v: r[5] as number, buyVol: r[6] as number, n: r[7] as number,
  }));
  return { klines, hl, metrics, spot };
}

function checkContiguous(klines: Kline1m[]): { gaps: number; first: number; last: number } {
  let gaps = 0;
  for (let i = 1; i < klines.length; i++) {
    if (klines[i]!.t - klines[i - 1]!.t !== 60_000) gaps++;
  }
  return { gaps, first: klines[0]?.t ?? NaN, last: klines[klines.length - 1]?.t ?? NaN };
}

/** ΔOI 1h + rang percentile causal 7j (metrics 30m → forward-fill horaire). */
function oiCollapseFlags(metrics: Array<{ t: number; oi: number }>, bars: Bar5m[]): Map<number, boolean> {
  const hourFloor = (t: number) => Math.floor(t / 3_600_000) * 3_600_000;
  const oiByHour = new Map<number, number>();
  let mi = 0;
  const hours: number[] = [];
  {
    const set = new Set<number>();
    for (const b of bars) set.add(hourFloor(b.t));
    hours.push(...[...set].sort((a, b) => a - b));
  }
  for (const h of hours) {
    while (mi < metrics.length && metrics[mi]!.t <= h + 3_600_000) mi++;
    const m = metrics[mi - 1];
    if (m && m.oi > 0) oiByHour.set(h, m.oi);
  }
  const chg: number[] = hours.map((h, i) => {
    const oi = oiByHour.get(h);
    const prev = i > 0 ? oiByHour.get(hours[i - 1]!) : undefined;
    return oi !== undefined && prev !== undefined && prev > 0 ? oi / prev - 1 : NaN;
  });
  // rang causal 7j (168h)
  const out = new Map<number, boolean>();
  for (let i = 0; i < hours.length; i++) {
    const r = rollingPctRank(chg, i, 168);
    out.set(hours[i]!, Number.isFinite(r) && r <= 10); // ΔOI 1h ≤ P10 causal
  }
  return out;
}

function propSummary(labs: ForwardLabel[], key: "reversal4h" | "reversal1h" | "reversal5m" | "continuation4h" | "continuation1h" | "continuation5m") {
  const k = labs.filter((l) => l[key]).length;
  return { n: labs.length, k, p: labs.length ? k / labs.length : NaN, ci: wilsonCI(k, labs.length) };
}

function netStats(yRevs: number[], costBp: number): Num {
  const nets = yRevs.filter(Number.isFinite).map((y) => y - costBp / 10000);
  const k = nets.filter((x) => x > 0).length;
  return {
    n: nets.length,
    medianGrossBp: r2(median(yRevs) * 10000),
    medianNetBp: r2(median(nets) * 10000),
    meanNetBp: r2(mean(nets) * 10000),
    pNetPos: r4(nets.length ? k / nets.length : NaN),
    ciNetPos: wilsonCI(k, nets.length).map(r4),
    maxAbsGrossBp: r2(Math.max(...yRevs.filter(Number.isFinite).map(Math.abs), 0) * 10000),
  };
}

async function main() {
  console.log(`[flip/s1] splits: discovery < ${new Date(DISCOVERY_END).toISOString()} | holdout ≥ ${new Date(HOLDOUT_START).toISOString()} (JAMAIS LU)`);
  const { klines, hl, metrics, spot } = loadAll();
  console.log(`[flip/s1] ${klines.length} klines perp 1m, ${spot.length} klines spot 1m, ${hl.length} bougies HL 5m, ${metrics.length} metrics`);
  const cont = checkContiguous(klines);
  console.log(`[flip/s1] contiguïté klines 1m: gaps=${cont.gaps}`);
  if (cont.gaps > 0) throw new Error(`trous dans les klines 1m (${cont.gaps}) — toBars5m par index invalide`);

  const bars = toBars5m(klines);
  console.log(`[flip/s1] ${bars.length} barres 5m`);
  console.log("[flip/s1] detectCascades…");
  const t0 = Date.now();
  const cascades = detectCascades(bars, DEFAULT_CFG);
  console.log(`[flip/s1] cascades: ${cascades.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const absorptions = detectAbsorption(cascades, bars, DEFAULT_CFG);

  const inDisc = (t: number) => t >= EV_START && t <= EV_END;
  const cascD = cascades.filter((c) => inDisc(c.t));
  const absD = absorptions.filter((a) => inDisc(a.t));
  const e1 = cascD.filter((c) => c.type === "E1");
  const e2 = cascD.filter((c) => c.type === "E2");
  console.log(`[flip/s1] discovery: E1=${e1.length} E2=${e2.length} E12=${absD.length}`);

  const opt = { maxForwardT: MAX_FORWARD_T };
  const labeled = labelCascades(klines, bars, cascD, absD, opt);
  const lab1 = labeled.filter((l) => l.type === "E1");
  const lab2 = labeled.filter((l) => l.type === "E2");
  console.log(`[flip/s1] labellisées: E1=${lab1.length} E2=${lab2.length}`);

  // ---- baselines (barres ordinaires, même convention tEvent)
  const warmupBars = Math.ceil(WARMUP_MS / (5 * MIN));
  // seuil "gros mouvement down" : rang causal ≤ 5 du ret 5m
  const rets = bars.map((b) => b.ret);
  const bigDownThr = (() => {
    const ranks: number[] = [];
    for (let i = 0; i < bars.length; i++) ranks.push(rollingPctRank(rets, i, DEFAULT_CFG.pctWindow));
    const vals = bars.map((b, i) => ({ r: b.ret, rank: ranks[i]! }))
      .filter((x) => x.rank <= 5 && x.r < 0).map((x) => x.r);
    vals.sort((a, b) => a - b);
    return vals.length ? vals[Math.floor(vals.length / 2)]! : -0.01;
  })();
  console.log(`[flip/s1] seuil big-down (médiane des ret ≤P5): ${(bigDownThr * 100).toFixed(3)}%`);
  const baseAll = labelBaselineBars(klines, bars, cascD, opt, warmupBars, false, 0)
    .filter((l) => l.tEvent >= EV_START && l.tEvent <= EV_END && l.type === "E1");
  const baseBig = labelBaselineBars(klines, bars, cascD, opt, warmupBars, true, bigDownThr)
    .filter((l) => l.tEvent >= EV_START && l.tEvent <= EV_END);
  console.log(`[flip/s1] baselines: all=${baseAll.length} bigDown=${baseBig.length}`);

  const results: Record<string, unknown> = {
    manifest: {
      generatedAt: new Date().toISOString(),
      venue: "Binance SOLUSDT perp (data.vision) + Hyperliquid (funding, candles 5m)",
      period: "2026-03-28 → 2026-09-27",
      splits: {
        discovery: `< ${new Date(DISCOVERY_END).toISOString()} (60% les plus anciens)`,
        calibration: "20% suivants — non utilisés ce sprint",
        holdout: `≥ ${new Date(HOLDOUT_START).toISOString()} — GELÉ, JAMAIS LU`,
      },
      warmup: "7j (percentiles causaux)",
      config5m: DEFAULT_CFG,
      nMin: N_MIN,
      costs: { feeBpPerLeg: FEE_BP, slippageBpPerLeg: SLIP_BP, note: "slippage ESTIMÉ (pas de carnet historique)" },
      leakageGuard: "assert MAX_FORWARD_T < HOLDOUT_START — vérifié à l'exécution",
    },
  };

  // ================================================================ H-FLIP-01
  {
    const r4h = propSummary(lab1, "reversal4h");
    const r1h = propSummary(lab1, "reversal1h");
    const c4h = propSummary(lab1, "continuation4h");
    const b4h = propSummary(baseAll, "reversal4h");
    const bb4h = propSummary(baseBig, "reversal4h");
    const vsAll = twoPropZ(r4h.k, r4h.n, b4h.k, b4h.n);
    const vsBig = twoPropZ(r4h.k, r4h.n, bb4h.k, bb4h.n);
    const yRev = lab1.map((l) => l.yRev1h).filter(Number.isFinite);
    const yRevMed = median(yRev);
    const yRevCI = bootstrapMedianCI(yRev);
    // adversarial : deux moitiés de discovery
    const mid = (EV_START + EV_END) / 2;
    const d1 = lab1.filter((l) => l.tEvent < mid);
    const d2 = lab1.filter((l) => l.tEvent >= mid);
    const d1r = propSummary(d1, "reversal4h");
    const d2r = propSummary(d2, "reversal4h");
    const halves = twoPropZ(d1r.k, d1r.n, d2r.k, d2r.n);
    // adversarial : autre venue (HL, proxy sans imbalance : ret ≤ P1 + vol ≥ P90)
    const hlBars: Bar5m[] = hl.map((c) => ({
      t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, buyRatio: 0.5, ret: 0,
    }));
    for (let i = 1; i < hlBars.length; i++) hlBars[i]!.ret = Math.log(hlBars[i]!.c / hlBars[i - 1]!.c);
    const hlRets = hlBars.map((b) => b.ret);
    const hlVols = hlBars.map((b) => b.v);
    const hlE1 = hlBars.filter((b, i) => {
      if (i < 1 || !inDisc(b.t)) return false;
      return rollingPctRank(hlRets, i, DEFAULT_CFG.pctWindow) <= 1
        && rollingPctRank(hlVols, i, DEFAULT_CFG.pctWindow) >= 90;
    });
    // debounce 30 min
    const hlE1d: typeof hlE1 = [];
    for (const b of hlE1) {
      const last = hlE1d[hlE1d.length - 1];
      if (!last || b.t - last.t >= 30 * MIN) hlE1d.push(b);
    }
    const hlLab = hlE1d.map((b) => {
      const prev = hlBars[hlBars.indexOf(b) - 1];
      if (!prev) return null;
      // labels sur klines HL 5m elles-mêmes (même logique, résolution 5m)
      return { b, prev };
    }).filter((x): x is { b: Bar5m; prev: Bar5m } => !!x);
    // reversal 4h sur HL : clôture 5m qui récupère ≥50% de l'excursion sous 4h
    let hlRev = 0, hlN = 0;
    for (const { b, prev } of hlLab) {
      const exc = -Math.log(b.l / prev.c);
      if (!(exc > 1e-9)) continue;
      const thr = prev.c * Math.exp(-exc / 2);
      let rev = false;
      for (let j = hlBars.indexOf(b) + 1; j < hlBars.length && hlBars[j]!.t <= b.t + 240 * MIN; j++) {
        if (hlBars[j]!.c >= thr) { rev = true; break; }
      }
      hlN++; if (rev) hlRev++;
    }

    const e2r4h = propSummary(lab2, "reversal4h"); // miroir exploratoire (H-FLIP-07)
    results["H-FLIP-01"] = {
      hypothesis: "Cascade long (E1) → reversal par absorption plutôt que continuation",
      n: { E1: lab1.length, E2_mirror: lab2.length, baselineAll: baseAll.length, baselineBigDown: baseBig.length, hlProxy: hlN },
      reversal: {
        E1_rev4h: { ...r4h, p: pct(r4h.p), ci: r4h.ci.map(pct) },
        E1_rev1h: { ...r1h, p: pct(r1h.p), ci: r1h.ci.map(pct) },
        E1_cont4h: { ...c4h, p: pct(c4h.p), ci: c4h.ci.map(pct) },
        E2_rev4h_mirror: { ...e2r4h, p: pct(e2r4h.p), ci: e2r4h.ci.map(pct) },
      },
      vsBaseline: {
        baselineAll_rev4h: { p: pct(b4h.p), ci: b4h.ci.map(pct) },
        baselineBigDown_rev4h: { p: pct(bb4h.p), ci: bb4h.ci.map(pct) },
        E1_vs_all: { diffPt: r2(vsAll.diff * 100), pValue: r4(vsAll.pValue), ciDiffPt: vsAll.ciDiff.map((x) => r2(x * 100)) },
        E1_vs_bigDown: { diffPt: r2(vsBig.diff * 100), pValue: r4(vsBig.pValue), ciDiffPt: vsBig.ciDiff.map((x) => r2(x * 100)) },
      },
      yRev1h: {
        medianBp: r2(yRevMed * 10000), ciBp: yRevCI.map((x) => r2(x * 10000)),
        meanBp: r2(mean(yRev) * 10000),
        note: "positif = mean-revert ; falsifier yaml: médiane ≤ 0 → tester continuation",
      },
      net1hHold: {
        cost20bp: netStats(yRev, 20),
        cost10bp: netStats(yRev, 10),
        cost40bp: netStats(yRev, 40),
        note: "trade hypothétique : entrée tEvent (clôture cascade), sortie +1h, notionnel 1x",
      },
      adversarial: {
        discoveryHalves: {
          D1: { ...d1r, p: pct(d1r.p), ci: d1r.ci.map(pct) },
          D2: { ...d2r, p: pct(d2r.p), ci: d2r.ci.map(pct) },
          diffPt: r2(halves.diff * 100), pValue: r4(halves.pValue),
        },
        otherVenue_HL_proxy: {
          n: hlN, rev4h: pct(hlN ? hlRev / hlN : NaN), ci: wilsonCI(hlRev, hlN).map(pct),
          caveat: "proxy HL sans taker imbalance (ret≤P1 + vol≥P90) — définition différente, comparaison indicative",
        },
      },
      leakageStatus: "PASS — features = percentiles causaux ≤ t ; tEvent = clôture barre ; labels = klines > tEvent uniquement ; baselines même convention ; holdout jamais lu (assert exécution)",
    };
    console.log(`[flip/s1] H-FLIP-01: E1 n=${lab1.length} rev4h=${pct(r4h.p)}% (base all ${pct(b4h.p)}%, big ${pct(bb4h.p)}%) médiane yRev1h=${r2(yRevMed * 10000)}bp`);
  }

  // ================================================================ H-FLIP-06
  {
    const abs = lab1.filter((l) => l.absorbed);
    const noAbs = lab1.filter((l) => !l.absorbed);
    const cmp = (key: "reversal4h" | "reversal1h", yy: "yRev1h" | "yRev4h") => {
      const a = propSummary(abs, key);
      const b = propSummary(noAbs, key);
      const t = twoPropZ(a.k, a.n, b.k, b.n);
      const ya = abs.map((l) => l[yy]).filter(Number.isFinite);
      const yb = noAbs.map((l) => l[yy]).filter(Number.isFinite);
      return {
        absorbed: { n: a.n, p: pct(a.p), ci: a.ci.map(pct) },
        notAbsorbed: { n: b.n, p: pct(b.p), ci: b.ci.map(pct) },
        diffPt: r2(t.diff * 100), pValue: r4(t.pValue), ciDiffPt: t.ciDiff.map((x) => r2(x * 100)),
        medianYRev_absorbedBp: r2(median(ya) * 10000),
        medianYRev_notAbsorbedBp: r2(median(yb) * 10000),
        ciMedian_absorbedBp: bootstrapMedianCI(ya).map((x) => r2(x * 10000)),
        ciMedian_notAbsorbedBp: bootstrapMedianCI(yb).map((x) => r2(x * 10000)),
      };
    };
    const rev4 = cmp("reversal4h", "yRev4h");
    const rev1 = cmp("reversal1h", "yRev1h");
    const netA = netStats(abs.map((l) => l.yRev1h).filter(Number.isFinite), 20);
    const netB = netStats(noAbs.map((l) => l.yRev1h).filter(Number.isFinite), 20);
    // miroir exploratoire E2
    const abs2 = lab2.filter((l) => l.absorbed);
    const noAbs2 = lab2.filter((l) => !l.absorbed);
    const t2 = twoPropZ(
      abs2.filter((l) => l.reversal4h).length, abs2.length,
      noAbs2.filter((l) => l.reversal4h).length, noAbs2.length);
    results["H-FLIP-06"] = {
      hypothesis: "Cascade long + absorption rapide (E1→E12 ≤15min) → reversal plus fort que sans absorption",
      groups: {
        E1_absorbed_n: abs.length, E1_notAbsorbed_n: noAbs.length,
        nMinPerGroup: N_MIN,
        absorbedSufficient: abs.length >= N_MIN,
      },
      reversal4h_byAbsorption: rev4,
      reversal1h_byAbsorption: rev1,
      net1hHold_cost20bp: { absorbed: netA, notAbsorbed: netB },
      E2_mirror_exploratory: {
        absorbed_n: abs2.length, notAbsorbed_n: noAbs2.length,
        diffPt: r2(t2.diff * 100), pValue: r4(t2.pValue),
      },
      leakageStatus: "PASS — groupe absorbé : tEvent = clôture barre E12 (post-événement connu alors) ; groupe non absorbé : tEvent = clôture cascade + 15 min (absence d'absorption connue à fermeture fenêtre) ; labels > tEvent uniquement",
    };
    console.log(`[flip/s1] H-FLIP-06: absorbed n=${abs.length} rev4h=${rev4.absorbed.p}% vs notAbsorbed n=${noAbs.length} rev4h=${rev4.notAbsorbed.p}%`);
  }

  // ================================================================ H-FLIP-10
  // DATA ISSUE (2026-09-28) : HL candleSnapshot 5m ne sert que les ~5000 dernieres
  // bougies (~17j : 2026-09-11 -> 09-27) — startTime ancien ignore, endTime ancien -> [].
  // Aucune couverture du discovery => le lead-lag HL<->Binance specifie est NON TESTABLE.
  // Pivot honnete : lead-lag PERP<->SPOT Binance en 1m (historique profond des deux cotes),
  // qui repond a la sous-question "vraies cascades vs ventes spot" : si le spot mene
  // systematiquement, la dislocation est probablement une vente spot ; si le perp mene
  // avec collapse d'OI, c'est compatible avec une cascade de liquidations perp.
  {
    const oiCollapse = oiCollapseFlags(metrics, bars);
    const hourFloor = (t: number) => Math.floor(t / 3_600_000) * 3_600_000;
    const spotFirst = spot[0]?.t ?? Infinity;
    const spotLast = spot[spot.length - 1]?.t ?? -Infinity;
    const cascDspot = cascD
      .filter((c) => c.t >= spotFirst && c.t <= spotLast)
      .filter((c): c is FlipEvent & { type: "E1" | "E2" } => c.type === "E1" || c.type === "E2");
    // alignement des creux/pics sur klines 1m, fenetre +/-30 min, resolution 60 s
    const pts = alignTroughs(cascDspot, klines, spot, 30);
    const summ = summarizeLeadLag(pts, 60);
    const lags = pts.map((pp) => pp.lagS).filter((x): x is number => x !== null);
    const st = signTest(lags.map((l) => (Math.abs(l) <= 60 ? 0 : l)));
    // vraie cascade vs vente spot (proxy OI) : dOI 1h <= P10 causal autour de l'evenement
    const isTrueCascade = (tC: number): boolean | null => {
      const v = oiCollapse.get(hourFloor(tC));
      return v === undefined ? null : v;
    };
    const truePts = pts.filter((pp) => isTrueCascade(pp.tCascade) === true);
    const spotPts = pts.filter((pp) => isTrueCascade(pp.tCascade) === false);
    const trueS = summarizeLeadLag(truePts, 60);
    const spotS = summarizeLeadLag(spotPts, 60);
    const e1s = summarizeLeadLag(pts.filter((pp) => pp.type === "E1"), 60);
    const e2s = summarizeLeadLag(pts.filter((pp) => pp.type === "E2"), 60);
    // falsifier yaml : pas de leader stable (50/50 +/- IC95) a n>=30 -> NULL
    // Test du leader : UNIQUEMENT le test des signes sur les cas decisifs.
    // (le two-prop "independant" refLeads vs otherLeads est invalide : deux issues
    // d'un meme echantillon — retire.)
    const dec = summ.refLeads + summ.otherLeads;
    results["H-FLIP-10"] = {
      hypothesis: "Lead-lag inter-marches : la dislocation apparait d'abord sur un marche",
      venueHL: {
        status: "NON TESTABLE — DATA ISSUE",
        detail: "HL candleSnapshot 5m limite aux ~5000 dernieres bougies (~17j) ; startTime ancien ignore, endTime ancien -> []. Aucune couverture du discovery (60% les plus anciens). Teste le 2026-09-28.",
      },
      proxy: {
        ref: "Binance SOLUSDT PERP 1m (data.vision)",
        other: "Binance SOLUSDT SPOT 1m (data.vision)",
        resolution: "1m -> lag quantifie par pas de 60 s ; |lag| <= 60 s = indiscernable (tied)",
        window: "+/-30 min autour de la barre de cascade",
        note: "lag > 0 = le PERP creuse en premier ; lag < 0 = le SPOT creuse en premier",
      },
      n: { cascadesDiscovery: cascDspot.length, measured: summ.n, null: summ.nNull },
      leadLag: {
        medianLagS: Math.round(summ.medianLagS),
        iqrLagS: summ.iqrLagS.map(Math.round),
        perpLeads: summ.refLeads, spotLeads: summ.otherLeads, tied: summ.tied,
        leaderShare: r4(summ.leaderShare),
        decisiveN: dec,
        signTestDecisive: { n: st.n, pValue: r4(st.pValue) },
      },
      byType: {
        E1: { n: e1s.n, medianLagS: Math.round(e1s.medianLagS), perpLeads: e1s.refLeads, spotLeads: e1s.otherLeads, tied: e1s.tied },
        E2: { n: e2s.n, medianLagS: Math.round(e2s.medianLagS), perpLeads: e2s.refLeads, spotLeads: e2s.otherLeads, tied: e2s.tied },
      },
      trueCascadeVsSpot: {
        proxy: "vraie cascade ~= cascade + dOI 1h <= P10 causal (+/-1h) ; spot-like ~= sans collapse OI — PROXY, pas des prints de liquidation",
        trueCascade: { n: trueS.n, medianLagS: Math.round(trueS.medianLagS), perpLeads: trueS.refLeads, spotLeads: trueS.otherLeads, tied: trueS.tied },
        spotLike: { n: spotS.n, medianLagS: Math.round(spotS.medianLagS), perpLeads: spotS.refLeads, spotLeads: spotS.otherLeads, tied: spotS.tied },
      },
      leakageStatus: "PASS — creux cherches sur klines 1m alignees autour de t_cascade (mesure, pas feature de decision) ; aucune donnee holdout",
      dataIssue: "prints de liquidation historiques : AUCUNE source publique -> E1/E2 restent des proxies (spec section 4)",
    };
    console.log(`[flip/s1] H-FLIP-10: n=${summ.n} mediane lag=${Math.round(summ.medianLagS)}s perp->${summ.refLeads} spot->${summ.otherLeads} tied=${summ.tied}`);
  }

  const p = writeJson("res-flip-s1.json", results);
  console.log(`[flip/s1] résultats → ${p}`);
  console.log(`[flip/s1] DATA_DIR=${DATA_DIR} — AUCUN push, AUCUNE transaction, holdout jamais lu`);
}

main().catch((e) => { console.error("[flip/s1] ERREUR:", e); process.exit(1); });
