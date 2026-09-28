/**
 * ÉTAPE 1 — Caractérisation gagnants vs perdants DANS l'univers du filtre combiné.
 *
 * Univers : creates 24–27 sept, pool=pump (hors bonk), domaine=ipfs.io, devBuy>=1.3, !mayhem,
 * migrés dans les 12h (n≈526, dont ~480 suivis en history).
 * Gagnant = continuation post-migration >= x2 depuis le 1er snapshot post-migration
 * (proxy du prix de migration). Gros gagnant >= x5.
 *
 * Données réelles uniquement. Biais documenté : l'échantillon suivi (history) sur-représente
 * les tokens chauds — les taux de continuation sont une borne OPTIMISTE. Les comparaisons
 * ENTRE buckets restent informatives (signal différentiel).
 * Règles du labo : n>=30 pour conclure, IC 95 %, honnêteté stricte.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/hatch/workspace/crypto-lab/repo";
const SCAN_DIR = join(REPO, "data/scans");
const HISTORY_DIR = join(REPO, "data/history");

interface Create {
  mint: string; receivedAt: number; devBuy: number | null; marketCapSol: number | null;
  pool: string | null; domain: string; mayhem: boolean;
  vSol: number | null; dev: string | null; hour: number;
}
interface Snap {
  priceUsd: number; fetchedAt: number; liquidityUsd: number;
  volume5m: number; buys5: number; sells5: number; pcM5: number | null; pcH1: number | null;
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

// --- Chargement creates + migrates ---
const creates: Create[] = [];
const migratesByMint = new Map<string, number>();
const seen = new Set<string>();
const scanFiles = readdirSync(SCAN_DIR).filter((f) => /^pump-2026-09-2[4-8]\.jsonl$/.test(f)).sort();
for (const f of scanFiles) {
  for (const line of readFileSync(join(SCAN_DIR, f), "utf8").split("\n")) {
    const l = line.trim(); if (!l) continue;
    let e: any; try { e = JSON.parse(l); } catch { continue; }
    if (e.kind === "create") {
      if (seen.has(e.mint)) continue;
      seen.add(e.mint);
      const raw = e.raw ?? {};
      creates.push({
        mint: e.mint,
        receivedAt: Date.parse(e.receivedAt),
        devBuy: typeof e.solAmount === "number" ? e.solAmount : null,
        marketCapSol: typeof e.marketCapSol === "number" ? e.marketCapSol : null,
        pool: e.pool ?? raw.pool ?? null,
        domain: domainOf(raw.uri),
        mayhem: raw.is_mayhem_mode === true,
        vSol: typeof raw.vSolInBondingCurve === "number" ? raw.vSolInBondingCurve : null,
        dev: e.traderPublicKey ?? raw.traderPublicKey ?? null,
        hour: new Date(e.receivedAt).getUTCHours(),
      });
    } else if (e.kind === "migrate") {
      const t = Date.parse(e.receivedAt);
      const prev = migratesByMint.get(e.mint);
      if (prev === undefined || t < prev) migratesByMint.set(e.mint, t);
    }
  }
}
creates.sort((a, b) => a.receivedAt - b.receivedAt);
console.log(`creates: ${creates.length}, migrates: ${migratesByMint.size}`);

const T = (s: string) => Date.parse(s);
const DATA_END = T("2026-09-28T04:35:00Z");
const W_MS = 12 * 3600_000;
const inUniverse = (c: Create) =>
  c.receivedAt >= T("2026-09-24T00:00:00Z") && c.receivedAt < T("2026-09-28T00:00:00Z") &&
  c.receivedAt + W_MS <= DATA_END &&
  c.pool !== "bonk" && c.domain === "ipfs.io" &&
  c.devBuy !== null && c.devBuy >= 1.3 && !c.mayhem;
const migrated = (c: Create) => {
  const m = migratesByMint.get(c.mint);
  return m !== undefined && m >= c.receivedAt && m <= c.receivedAt + W_MS;
};
const universe = creates.filter(inUniverse);
const migrants = universe.filter(migrated);
console.log(`univers filtre 24-27: n=${universe.length}, migrés 12h: n=${migrants.length} (${pct(migrants.length / universe.length)})`);

// --- Dev répété ? (H-DEV : le dev a déjà lancé avant dans notre dataset) ---
const devFirstSeen = new Map<string, number>();
for (const c of creates) {
  if (!c.dev) continue;
  const prev = devFirstSeen.get(c.dev);
  if (prev === undefined || c.receivedAt < prev) devFirstSeen.set(c.dev, c.receivedAt);
}

// --- Séries history ---
function loadSeries(mint: string): Snap[] {
  const p = join(HISTORY_DIR, mint + ".jsonl");
  if (!existsSync(p)) return [];
  const out: Snap[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const l = line.trim(); if (!l) continue;
    try {
      const s = JSON.parse(l);
      if (!(s.priceUsd > 0)) continue;
      out.push({
        priceUsd: s.priceUsd, fetchedAt: Date.parse(s.fetchedAt), liquidityUsd: s.liquidityUsd ?? 0,
        volume5m: s.volume5m ?? s.volume?.m5 ?? 0,
        buys5: s.txns?.m5?.buys ?? 0, sells5: s.txns?.m5?.sells ?? 0,
        pcM5: typeof s.priceChange?.m5 === "number" ? s.priceChange.m5 : null,
        pcH1: typeof s.priceChange?.h1 === "number" ? s.priceChange.h1 : null,
      });
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => a.fetchedAt - b.fetchedAt);
}

interface Migrant {
  c: Create; migTime: number; delayH: number; devRepeat: boolean;
  tracked: boolean; proxyDelayH: number | null;
  contMax: number | null; // continuation max post-migration / proxy
  winner: boolean; bigWinner: boolean;
  early: { pcM5: number | null; pcH1: number | null; imb5: number | null; vol5m: number; liq: number } | null;
}
const rows: Migrant[] = [];
for (const c of migrants) {
  const migTime = migratesByMint.get(c.mint)!;
  const series = loadSeries(c.mint);
  const post = series.filter((s) => s.fetchedAt >= migTime);
  const r: Migrant = {
    c, migTime, delayH: (migTime - c.receivedAt) / 3600_000,
    devRepeat: !!c.dev && (devFirstSeen.get(c.dev) ?? c.receivedAt) < c.receivedAt,
    tracked: series.length > 0, proxyDelayH: null, contMax: null,
    winner: false, bigWinner: false, early: null,
  };
  if (post.length > 0) {
    const proxy = post[0];
    r.proxyDelayH = (proxy.fetchedAt - migTime) / 3600_000;
    const win48 = post.filter((s) => s.fetchedAt <= migTime + 48 * 3600_000);
    const mx = Math.max(...win48.map((s) => s.priceUsd));
    r.contMax = mx / proxy.priceUsd;
    r.winner = r.contMax >= 2.0;
    r.bigWinner = r.contMax >= 5.0;
    const earlySnap = post.find((s) => s.fetchedAt <= migTime + 3600_000);
    if (earlySnap) {
      const tot = earlySnap.buys5 + earlySnap.sells5;
      r.early = {
        pcM5: earlySnap.pcM5, pcH1: earlySnap.pcH1,
        imb5: tot > 0 ? (earlySnap.buys5 - earlySnap.sells5) / tot : null,
        vol5m: earlySnap.volume5m, liq: earlySnap.liquidityUsd,
      };
    }
  }
  rows.push(r);
}
const tracked = rows.filter((r) => r.contMax !== null);
console.log(`migrés suivis avec proxy prix: n=${tracked.length}`);
const winners = tracked.filter((r) => r.winner);
const bigs = tracked.filter((r) => r.bigWinner);
console.log(`gagnants (cont>=x2): n=${winners.length} (${pct(winners.length / tracked.length)}) | gros (>=x5): n=${bigs.length} (${pct(bigs.length / tracked.length)})`);
const pd = tracked.map((r) => r.proxyDelayH as number);
console.log(`délai migration->proxy (n=${pd.length}): médiane=${med(pd).toFixed(1)}h p90=${quantile(pd, 0.9).toFixed(1)}h`);

// --- Utilitaires d'analyse ---
const out: any = { universe_n: universe.length, migrants_n: migrants.length, tracked_n: tracked.length };
function bucketRate(name: string, key: (r: Migrant) => string, order?: string[]) {
  const groups = new Map<string, Migrant[]>();
  for (const r of tracked) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const keys = order ?? [...groups.keys()].sort();
  console.log(`\n## ${name} — taux de gagnants (cont>=x2)`);
  const tab: any[] = [];
  for (const k of keys) {
    const g = groups.get(k) ?? [];
    const w = g.filter((r) => r.winner).length;
    const b = g.filter((r) => r.bigWinner).length;
    const rate = g.length ? w / g.length : NaN;
    const [lo, hi] = ci95(rate, g.length);
    console.log(`  ${k}: n=${g.length} gagnants=${w} (${pct(rate)}) IC[${pct(lo)},${pct(hi)}] gros(>=x5)=${b} | n>=30:${g.length >= 30}`);
    tab.push({ bucket: k, n: g.length, winners: w, rate, ci95: [lo, hi], big_winners: b });
  }
  out[name] = tab;
}
function qbuckets(vals: number[]): [number, number, number] {
  return [quantile(vals, 0.25), quantile(vals, 0.5), quantile(vals, 0.75)];
}

// A. devBuy (quartiles sur les migrés suivis)
{
  const vs = tracked.map((r) => r.c.devBuy as number);
  const [q1, q2, q3] = qbuckets(vs);
  console.log(`\n(devBuy quartiles: ${q1.toFixed(2)} / ${q2.toFixed(2)} / ${q3.toFixed(2)} SOL)`);
  bucketRate("A1_devBuy", (r) => {
    const d = r.c.devBuy as number;
    return d < q1 ? `Q1 <${q1.toFixed(2)}` : d < q2 ? `Q2 <${q2.toFixed(2)}` : d < q3 ? `Q3 <${q3.toFixed(2)}` : `Q4 >=${q3.toFixed(2)}`;
  }, [`Q1 <${q1.toFixed(2)}`, `Q2 <${q2.toFixed(2)}`, `Q3 <${q3.toFixed(2)}`, `Q4 >=${q3.toFixed(2)}`]);
}
// A2. marketCapSol au create
{
  const vs = tracked.map((r) => r.c.marketCapSol ?? NaN).filter((x) => !isNaN(x));
  const [q1, q2, q3] = qbuckets(vs);
  bucketRate("A2_mcapSol", (r) => {
    const v = r.c.marketCapSol; if (v === null) return "NA";
    return v < q1 ? `Q1 <${q1.toFixed(0)}` : v < q2 ? `Q2 <${q2.toFixed(0)}` : v < q3 ? `Q3 <${q3.toFixed(0)}` : `Q4 >=${q3.toFixed(0)}`;
  });
}
// A3. vSolInBondingCurve au create (progression courbe)
{
  const vs = tracked.map((r) => r.c.vSol ?? NaN).filter((x) => !isNaN(x));
  if (vs.length > 30) {
    const [q1, q2, q3] = qbuckets(vs);
    bucketRate("A3_vSol", (r) => {
      const v = r.c.vSol; if (v === null) return "NA";
      return v < q1 ? `Q1 <${q1.toFixed(0)}` : v < q2 ? `Q2 <${q2.toFixed(0)}` : v < q3 ? `Q3 <${q3.toFixed(0)}` : `Q4 >=${q3.toFixed(0)}`;
    });
  } else console.log(`\nA3_vSol: données insuffisantes (n=${vs.length}) — INCONNU`);
  out.A3_vSol_coverage = vs.length;
}
// A4. heure UTC du create
bucketRate("A4_heureUTC", (r) => {
  const h = r.c.hour;
  return h < 6 ? "00-06" : h < 12 ? "06-12" : h < 18 ? "12-18" : "18-24";
}, ["00-06", "06-12", "12-18", "18-24"]);
// A5. dev répété (H-DEV)
bucketRate("A5_devRepeat", (r) => (r.devRepeat ? "dev déjà vu" : "dev nouveau"));
// B. délai create->migrate
{
  const vs = tracked.map((r) => r.delayH);
  const [q1, q2, q3] = qbuckets(vs);
  console.log(`\n(délai quartiles: ${q1.toFixed(2)}h / ${q2.toFixed(2)}h / ${q3.toFixed(2)}h)`);
  bucketRate("B_delaiMigration", (r) =>
    r.delayH < q1 ? `rapide <${q1.toFixed(1)}h` : r.delayH < q2 ? `<${q2.toFixed(1)}h` : r.delayH < q3 ? `<${q3.toFixed(1)}h` : `lent >=${q3.toFixed(1)}h`);
}
// C. signal précoce post-migration (1er snapshot <= 60 min après migration)
{
  const withEarly = tracked.filter((r) => r.early !== null);
  console.log(`\nC: ${withEarly.length}/${tracked.length} avec snapshot précoce (<=60min post-migration)`);
  out.C_coverage = { n: withEarly.length, of: tracked.length };
  const sub = (name: string, key: (r: Migrant) => string, order?: string[]) => {
    const groups = new Map<string, Migrant[]>();
    for (const r of withEarly) {
      const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r);
    }
    console.log(`\n## ${name}`);
    const tab: any[] = [];
    for (const k of order ?? [...groups.keys()].sort()) {
      const g = groups.get(k) ?? [];
      const w = g.filter((r) => r.winner).length;
      const rate = g.length ? w / g.length : NaN;
      const [lo, hi] = ci95(rate, g.length);
      console.log(`  ${k}: n=${g.length} gagnants=${w} (${pct(rate)}) IC[${pct(lo)},${pct(hi)}] n>=30:${g.length >= 30}`);
      tab.push({ bucket: k, n: g.length, winners: w, rate, ci95: [lo, hi] });
    }
    out[name] = tab;
  };
  sub("C1_pcM5_precoce", (r) => {
    const v = r.early!.pcM5; if (v === null) return "NA";
    return v < -10 ? "dump <-10%" : v <= 10 ? "-10..+10%" : v <= 50 ? "+10..+50%" : "pump >+50%";
  }, ["dump <-10%", "-10..+10%", "+10..+50%", "pump >+50%"]);
  sub("C2_imbalance5m", (r) => {
    const v = r.early!.imb5; if (v === null) return "NA";
    return v < -0.2 ? "vendeurs <-0.2" : v <= 0.2 ? "-0.2..+0.2" : "acheteurs >+0.2";
  }, ["vendeurs <-0.2", "-0.2..+0.2", "acheteurs >+0.2"]);
  sub("C3_volume5m", (r) => {
    const vs = withEarly.map((x) => x.early!.vol5m);
    const [a, b, c2] = qbuckets(vs);
    const v = r.early!.vol5m;
    return v < a ? `Q1` : v < b ? `Q2` : v < c2 ? `Q3` : `Q4`;
  }, ["Q1", "Q2", "Q3", "Q4"]);
}

// D. Borne optimiste "acheter à la migration" : entrée au proxy, TP+100% / SL-50% / 48h
{
  const sims: number[] = [];
  let wins = 0;
  for (const r of tracked) {
    const migTime = r.migTime;
    const series = loadSeries(r.c.mint);
    const post = series.filter((s) => s.fetchedAt >= migTime);
    if (post.length < 2) continue;
    const entry = post[0].priceUsd;
    const tEnd = post[0].fetchedAt + 48 * 3600_000;
    let exitP = post[post.length - 1].priceUsd;
    for (const s of post.slice(1)) {
      const g = s.priceUsd / entry - 1;
      if (g >= 1.0 || g <= -0.5) { exitP = s.priceUsd; break; }
      if (s.fetchedAt >= tEnd) { exitP = s.priceUsd; break; }
    }
    const gross = exitP / entry - 1;
    sims.push(gross);
    if (gross > 0) wins++;
  }
  const mean = sims.reduce((a, b) => a + b, 0) / Math.max(1, sims.length);
  console.log(`\n## D_acheterMigration (BORNE OPTIMISTE, échantillon chaud)`);
  console.log(`  n=${sims.length} brut médian=${pct(med(sims))} moyenne=${pct(mean)} wins=${wins}/${sims.length} (${pct(wins / Math.max(1, sims.length))})`);
  console.log(`  MFE médian (contMax-1): ${pct(med(tracked.map((r) => (r.contMax as number) - 1)))}`);
  out.D_acheterMigration = { n: sims.length, median: med(sims), mean, wins, note: "borne optimiste: échantillon history = tokens chauds" };
}

// E. Proxy social : profils/boosts DexScreener avec liens (site/telegram)
{
  const withLinks = new Set<string>();
  let profCount = 0;
  for (const f of readdirSync(SCAN_DIR).filter((f) => /^2026-09-2[4-8]T.*\.json$/.test(f))) {
    try {
      const e = JSON.parse(readFileSync(join(SCAN_DIR, f), "utf8"));
      for (const p of [...(e.profiles ?? []), ...(e.boosts ?? [])]) {
        profCount++;
        const links = p.links ?? [];
        if (links.length > 0) withLinks.add(p.tokenAddress ?? p.mint ?? "");
      }
    } catch { /* ignore */ }
  }
  const g1 = tracked.filter((r) => withLinks.has(r.c.mint));
  const g0 = tracked.filter((r) => !withLinks.has(r.c.mint));
  const w1 = g1.filter((r) => r.winner).length, w0 = g0.filter((r) => r.winner).length;
  const [lo1, hi1] = ci95(g1.length ? w1 / g1.length : NaN, g1.length);
  const [lo0, hi0] = ci95(g0.length ? w0 / g0.length : NaN, g0.length);
  console.log(`\n## E_social (liens site/telegram dans scans)`);
  console.log(`  profils/boosts scannés: ${profCount}, mints avec liens: ${withLinks.size}`);
  console.log(`  avec liens: n=${g1.length} gagnants=${w1} (${pct(g1.length ? w1 / g1.length : NaN)}) IC[${pct(lo1)},${pct(hi1)}`);
  console.log(`  sans liens: n=${g0.length} gagnants=${w0} (${pct(g0.length ? w0 / g0.length : NaN)}) IC[${pct(lo0)},${pct(hi0)}]`);
  out.E_social = { profils_scannes: profCount, mints_avec_liens: withLinks.size, avec_liens: { n: g1.length, winners: w1 }, sans_liens: { n: g0.length, winners: w0 } };
}

writeFileSync(join(REPO, "data/backtests/winners-characterization-2026-09-28.json"), JSON.stringify(out, null, 2));
console.log("\nJSON écrit : data/backtests/winners-characterization-2026-09-28.json");
