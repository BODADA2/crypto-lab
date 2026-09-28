/**
 * AUDIT — contamination "late discovery" du flux create.
 *
 * Constat : 607 creates (0,9 %) portent un tuple (solAmount, vSol, vTok, mcapSol) IDENTIQUE
 * au décimal près : (85.005359057, 115.005359056806, 279900000, 410.8801681200643).
 * vSol=115 > 85 (seuil de graduation) => ce ne sont PAS des observations à la création :
 * le collecteur a émis un "create" tardif (découverte après migration) avec un état de
 * courbe figé. 607/607 sont migrés. Ils passent le filtre (devBuy 85 >= 1.3) et gonflent
 * artificiellement son taux de migration mesuré.
 *
 * Ce script re-mesure TOUT sur les creates GENUINE (hors tuple constant PH) :
 *  - taux de base train/test
 *  - filtre combiné (seuils 1.0 / 1.3 / 1.5) train/test + IC95
 *  - raffinement mayhem, filtre d'exclusion industriel, buckets H-TOOL
 *  - caractérisation gagnants (continuation >= x2) sur migrés genuine
 *
 * Données réelles uniquement. Règles du labo : n>=30, IC 95 %, honnêteté stricte.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/hatch/workspace/crypto-lab/repo";
const SCAN_DIR = join(REPO, "data/scans");
const HISTORY_DIR = join(REPO, "data/history");

const PH_TUPLE = [85.005359057, 115.005359056806, 279900000, 410.8801681200643];

interface Create {
  mint: string; receivedAt: number; devBuy: number | null; marketCapSol: number | null;
  pool: string | null; domain: string; mayhem: boolean; vSol: number | null;
  dev: string | null; hour: number; isPH: boolean;
}
function domainOf(uri: string | null | undefined): string {
  if (!uri) return "?";
  const m = /^https?:\/\/([^/:]+)/i.exec(uri);
  return m ? m[1].toLowerCase() : "?";
}
const pct = (x: number) => `${(x * 100).toFixed(2)} %`;
function ci95(p: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const se = Math.sqrt(p * (1 - p) / n);
  return [Math.max(0, p - 1.96 * se), Math.min(1, p + 1.96 * se)];
}
function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const med = (xs: number[]) => quantile(xs, 0.5);

const creates: Create[] = [];
const migratesByMint = new Map<string, number>();
const seen = new Set<string>();
for (const f of readdirSync(SCAN_DIR).filter((f) => /^pump-2026-09-2[4-8]\.jsonl$/.test(f)).sort()) {
  for (const line of readFileSync(join(SCAN_DIR, f), "utf8").split("\n")) {
    const l = line.trim(); if (!l) continue;
    let e: any; try { e = JSON.parse(l); } catch { continue; }
    if (e.kind === "create") {
      if (seen.has(e.mint)) continue;
      seen.add(e.mint);
      const raw = e.raw ?? {};
      const tup = [e.solAmount, raw.vSolInBondingCurve, raw.vTokensInBondingCurve, e.marketCapSol];
      const isPH = tup.every((v, i) => v === PH_TUPLE[i]);
      creates.push({
        mint: e.mint, receivedAt: Date.parse(e.receivedAt),
        devBuy: typeof e.solAmount === "number" ? e.solAmount : null,
        marketCapSol: typeof e.marketCapSol === "number" ? e.marketCapSol : null,
        pool: e.pool ?? raw.pool ?? null, domain: domainOf(raw.uri),
        mayhem: raw.is_mayhem_mode === true,
        vSol: typeof raw.vSolInBondingCurve === "number" ? raw.vSolInBondingCurve : null,
        dev: e.traderPublicKey ?? raw.traderPublicKey ?? null,
        hour: new Date(e.receivedAt).getUTCHours(), isPH,
      });
    } else if (e.kind === "migrate") {
      const t = Date.parse(e.receivedAt);
      const prev = migratesByMint.get(e.mint);
      if (prev === undefined || t < prev) migratesByMint.set(e.mint, t);
    }
  }
}
creates.sort((a, b) => a.receivedAt - b.receivedAt);

const T = (s: string) => Date.parse(s);
const DATA_END = T("2026-09-28T04:35:00Z");
const W_MS = 12 * 3600_000;
const outcome = (c: Create) => {
  const m = migratesByMint.get(c.mint);
  return m !== undefined && m >= c.receivedAt && m <= c.receivedAt + W_MS;
};
const genuine = (c: Create) => !c.isPH;
const inWin = (c: Create, lo: number, hi: number) =>
  c.receivedAt >= lo && c.receivedAt < hi && c.receivedAt + W_MS <= DATA_END;

const nPH = creates.filter((c) => c.isPH).length;
const nPHmig = creates.filter((c) => c.isPH && outcome(c)).length;
console.log(`creates: ${creates.length} | PH (late-discovery): ${nPH} (${pct(nPH / creates.length)}) | PH migrés: ${nPHmig}/${nPH}`);
console.log(`creates genuine: ${creates.length - nPH}`);

const out: any = { ph_total: nPH, ph_migrated: nPHmig, creates_total: creates.length };

// ============ PARTIE 1 : taux de base genuine ============
const trainAll = creates.filter((c) => inWin(c, T("2026-09-24T00:00:00Z"), T("2026-09-26T00:00:00Z")));
const testAll = creates.filter((c) => inWin(c, T("2026-09-26T00:00:00Z"), T("2026-09-28T00:00:00Z")));
function rate(set: Create[]) {
  const k = set.filter(outcome).length;
  return { n: set.length, k, rate: set.length ? k / set.length : NaN };
}
const bTr = rate(trainAll.filter(genuine)), bTe = rate(testAll.filter(genuine));
const bTrAll = rate(trainAll), bTeAll = rate(testAll);
console.log(`\n## Base rates — AVEC PH: train ${pct(bTrAll.rate)} test ${pct(bTeAll.rate)} | GENUINE: train ${pct(bTr.rate)} (n=${bTr.n}) test ${pct(bTe.rate)} (n=${bTe.n})`);
out.base = { with_ph: { train: bTrAll, test: bTeAll }, genuine: { train: bTr, test: bTe } };

// ============ PARTIE 2 : filtre combiné genuine ============
const combined = (c: Create, thr: number) =>
  genuine(c) && c.pool !== "bonk" && c.domain === "ipfs.io" && c.devBuy !== null && c.devBuy >= thr;
const combinedWithPH = (c: Create, thr: number) =>
  c.pool !== "bonk" && c.domain === "ipfs.io" && c.devBuy !== null && c.devBuy >= thr;
console.log(`\n## Filtre combiné — AVEC PH vs GENUINE (test)`);
const sens: any[] = [];
for (const thr of [1.0, 1.3, 1.5]) {
  const gTr = rate(trainAll.filter((c) => combined(c, thr)));
  const gTe = rate(testAll.filter((c) => combined(c, thr)));
  const pTr = rate(trainAll.filter((c) => combinedWithPH(c, thr)));
  const pTe = rate(testAll.filter((c) => combinedWithPH(c, thr)));
  const [lo, hi] = ci95(gTe.rate, gTe.n);
  console.log(`seuil ${thr}: AVEC PH train ${pTr.k}/${pTr.n}=${pct(pTr.rate)} test ${pTe.k}/${pTe.n}=${pct(pTe.rate)} | GENUINE train ${gTr.k}/${gTr.n}=${pct(gTr.rate)} test ${gTe.k}/${gTe.n}=${pct(gTe.rate)} IC[${pct(lo)},${pct(hi)}] n>=30:${gTe.n >= 30}`);
  sens.push({ seuil: thr, with_ph: { train: pTr, test: pTe }, genuine: { train: gTr, test: gTe, ci95: [lo, hi] } });
}
out.filtre_combine = sens;

// ============ PARTIE 3 : mayhem + exclusion, genuine ============
{
  const f = (c: Create) => combined(c, 1.3);
  const mY = rate(testAll.filter((c) => f(c) && c.mayhem));
  const mN = rate(testAll.filter((c) => f(c) && !c.mayhem));
  console.log(`\n## Mayhem x filtre (genuine, test): avec mayhem ${mY.k}/${mY.n}=${pct(mY.rate)} | sans mayhem ${mN.k}/${mN.n}=${pct(mN.rate)}`);
  out.mayhem = { with: mY, without: mN };
  const IND = new Set(["metadata.j7tracker.io", "meta.uxento.io", "pump.mypinata.cloud", "gateway.pinata.cloud"]);
  const exc = (c: Create) => genuine(c) && (IND.has(c.domain) || c.mayhem);
  const e = rate(testAll.filter(exc)), k = rate(testAll.filter((c) => genuine(c) && !exc(c)));
  const runnersErr = testAll.filter((c) => exc(c) && outcome(c)).length;
  console.log(`## Exclusion industrielle (genuine, test): exclus ${e.k}/${e.n}=${pct(e.rate)} | conservés ${k.k}/${k.n}=${pct(k.rate)} | runners filtrés par erreur: ${runnersErr}`);
  out.exclusion = { exclus: e, conserves: k, runners_filtres_par_erreur: runnersErr };
}

// ============ PARTIE 4 : H-TOOL buckets, genuine (fenêtre edge-check: creates <= 09-26) ============
{
  const seg = creates.filter((c) => genuine(c) && c.receivedAt < T("2026-09-26T00:00:00Z") && c.receivedAt + W_MS <= DATA_END);
  const doms = ["ipfs.io", "metadata.j7tracker.io", "meta.uxento.io", "pump.mypinata.cloud", "gateway.pinata.cloud", "?"];
  console.log(`\n## H-TOOL genuine (creates <= 09-26, n=${seg.length})`);
  const tab: any[] = [];
  for (const d of doms) {
    const g = seg.filter((c) => c.domain === d);
    const r = rate(g);
    const [lo, hi] = ci95(r.rate, r.n);
    console.log(`  ${d}: n=${g.length} ${r.k} migrés = ${pct(r.rate)} IC[${pct(lo)},${pct(hi)}]`);
    tab.push({ domain: d, n: g.length, k: r.k, rate: r.rate, ci95: [lo, hi] });
  }
  const mhY = rate(seg.filter((c) => c.mayhem)), mhN = rate(seg.filter((c) => !c.mayhem));
  console.log(`  mayhem=true: ${mhY.k}/${mhY.n}=${pct(mhY.rate)} | mayhem=false: ${mhN.k}/${mhN.n}=${pct(mhN.rate)}`);
  out.h_tool_genuine = tab;
  out.mayhem_genuine_seg = { with: mhY, without: mhN };
}

// ============ PARTIE 5 : gagnants sur migrés GENUINE ============
interface Snap { priceUsd: number; fetchedAt: number; }
function loadSeries(mint: string): Snap[] {
  const p = join(HISTORY_DIR, mint + ".jsonl");
  if (!existsSync(p)) return [];
  const o: Snap[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const l = line.trim(); if (!l) continue;
    try {
      const s = JSON.parse(l);
      if (s.priceUsd > 0) o.push({ priceUsd: s.priceUsd, fetchedAt: Date.parse(s.fetchedAt) });
    } catch { /* ignore */ }
  }
  return o.sort((a, b) => a.fetchedAt - b.fetchedAt);
}
{
  const gm = creates.filter((c) => genuine(c) && inWin(c, T("2026-09-24T00:00:00Z"), T("2026-09-28T00:00:00Z")) && outcome(c));
  console.log(`\n## Migrés genuine 24-27 (12h): n=${gm.length}`);
  let tracked = 0, winners = 0, bigs = 0;
  const conts: number[] = [];
  const devFirst = new Map<string, number>();
  for (const c of creates) { if (!c.dev) continue; const p = devFirst.get(c.dev); if (p === undefined || c.receivedAt < p) devFirst.set(c.dev, c.receivedAt); }
  const featW: Record<string, { n: number; w: number }> = {};
  const add = (k: string, w: boolean) => { featW[k] = featW[k] ?? { n: 0, w: 0 }; featW[k].n++; if (w) featW[k].w++; };
  for (const c of gm) {
    const mt = migratesByMint.get(c.mint)!;
    const post = loadSeries(c.mint).filter((s) => s.fetchedAt >= mt);
    if (!post.length) continue;
    tracked++;
    const mx = Math.max(...post.filter((s) => s.fetchedAt <= mt + 48 * 3600_000).map((s) => s.priceUsd));
    const cont = mx / post[0].priceUsd;
    conts.push(cont);
    const w = cont >= 2.0; if (w) winners++; if (cont >= 5.0) bigs++;
    const d = c.devBuy ?? NaN;
    add(d < 1 ? "devBuy<1" : d < 1.3 ? "devBuy 1-1.3" : d < 2 ? "devBuy 1.3-2" : d < 3 ? "devBuy 2-3" : "devBuy>=3", w);
    const rep = !!c.dev && (devFirst.get(c.dev) ?? c.receivedAt) < c.receivedAt;
    add(rep ? "dev répété" : "dev nouveau", w);
    const h = c.hour;
    add(h < 6 ? "00-06" : h < 12 ? "06-12" : h < 18 ? "12-18" : "18-24", w);
    const dl = (mt - c.receivedAt) / 3600_000;
    add(dl < 0.25 ? "délai<15min" : dl < 1 ? "15-60min" : dl < 4 ? "1-4h" : "délai>4h", w);
  }
  console.log(`  suivis avec proxy: ${tracked} | gagnants(cont>=x2): ${winners} (${pct(winners / Math.max(1, tracked))}) | gros(>=x5): ${bigs}`);
  console.log(`  continuation: médiane=x${med(conts).toFixed(2)}`);
  for (const [k, v] of Object.entries(featW)) {
    const r = v.w / v.n; const [lo, hi] = ci95(r, v.n);
    console.log(`  ${k}: n=${v.n} gagnants=${v.w} (${pct(r)}) IC[${pct(lo)},${pct(hi)}] n>=30:${v.n >= 30}`);
  }
  out.gagnants_genuine = { migrants: gm.length, tracked, winners, big_winners: bigs, cont_median: med(conts), features: featW };
}

writeFileSync(join(REPO, "data/backtests/audit-late-discovery-2026-09-28.json"), JSON.stringify(out, null, 2));
console.log("\nJSON écrit : data/backtests/audit-late-discovery-2026-09-28.json");
