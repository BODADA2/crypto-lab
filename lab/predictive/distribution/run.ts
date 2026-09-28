/**
 * Runner d'analyse — Domaine 4/5 DISTRIBUTION, phase DÉCOUVERTE.
 * Usage : npx tsx lab/predictive/distribution/run.ts
 * Lit data/history/, data/tokens/, data/earlybuyers/ (lecture seule).
 * N'écrit RIEN dans le dépôt ; imprime le rapport Markdown sur stdout.
 * Le holdout n'est jamais mesuré (aucune variable ne passe la découverte).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HORIZON_LABELS, splitUniverse, type Universe } from "../universe.ts";
import type { TokenSnapshot } from "../../types.ts";
import {
  buildT0Row,
  joinTokensTop10,
  parseEarlyBuyerMetrics,
  analyzePair,
  coverageByUniverse,
  yBaseline,
  temporalHalves,
  MIN_N_CONCLUSION,
  type T0Row,
} from "./distribution.ts";

const ROOT = new URL("../../..", import.meta.url).pathname;
const HIST = join(ROOT, "data/history");
const TOKENS = join(ROOT, "data/tokens");
const EB = join(ROOT, "data/earlybuyers");

const fmt = (v: number | null, d = 4): string =>
  v === null || !Number.isFinite(v) ? "n/a" : v.toFixed(d);
const pct = (v: number | null): string => (v === null ? "n/a" : (v * 100).toFixed(2) + " %");

// ---------- chargement ----------
const rows: T0Row[] = [];
const noT0: string[] = [];
for (const f of readdirSync(HIST)) {
  if (!f.endsWith(".jsonl")) continue;
  const mint = f.slice(0, -6);
  try {
    const series = readFileSync(join(HIST, f), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as TokenSnapshot);
    const row = buildT0Row(mint, series);
    if (row) rows.push(row); else noT0.push(mint);
  } catch { /* fichier illisible : ignoré, compté ci-dessous */ }
}
const t0ByMint = new Map(rows.map((r) => [r.mint, r]));

// jointure data/tokens (top10Pct au dernier tick)
let tokensKnown = 0;
let tokensAligned = 0;
const alignedX: { x: number; row: T0Row }[] = [];
for (const r of rows) {
  const p = join(TOKENS, r.mint + ".json");
  if (!existsSync(p)) continue;
  try {
    const tok = JSON.parse(readFileSync(p, "utf8"));
    const e = joinTokensTop10(r.mint, { fetchedAt: tok.fetchedAt, top10Pct: tok.top10Pct }, r.t0FetchedAt);
    if (e.top10Pct !== null) {
      tokensKnown++;
      if (e.alignedT0) { tokensAligned++; alignedX.push({ x: e.top10Pct, row: r }); }
    }
  } catch { /* ignoré */ }
}

// early buyers
interface EBRow { mint: string; universe: Universe; top5: number|null; gini: number|null; ssm: number|null; sellersOver50: number|null; row: T0Row|null; migratedAt: string|null; t0FetchedAt: string|null }
const ebRows: EBRow[] = [];
let ebFiles = 0;
if (existsSync(EB)) {
  for (const f of readdirSync(EB)) {
    if (!f.endsWith(".json")) continue;
    ebFiles++;
    const mint = f.slice(0, -5);
    try {
      const raw = JSON.parse(readFileSync(join(EB, f), "utf8"));
      const m = parseEarlyBuyerMetrics(mint, raw);
      const row = t0ByMint.get(mint) ?? null;
      ebRows.push({
        mint, universe: m.universe,
        top5: m.top5Share, gini: m.gini, ssm: m.sameSlotMax,
        sellersOver50: m.sellersOver50, row,
        migratedAt: (raw.migratedAt as string) ?? null,
        t0FetchedAt: row?.t0FetchedAt ?? null,
      });
    } catch { /* ignoré */ }
  }
}

// ---------- helpers ----------
function pairFor(varName: string, getX: (r: T0Row) => number | null, uni: Universe | "all", hi: number) {
  const xs: number[] = []; const ys: number[] = [];
  for (const r of rows) {
    if (uni !== "all" && r.universe !== uni) continue;
    const x = getX(r); const y = r.y[hi] ?? null;
    if (x !== null && y !== null) { xs.push(x); ys.push(y); }
  }
  return analyzePair(xs, ys);
}

// ---------- rapport ----------
const L: string[] = [];
L.push("# Domaine 4/5 — DISTRIBUTION : rapport d'analyse (découverte)");
L.push("");
L.push("## 1. Inventaire des données");
L.push(`- data/history : fichiers lus ; lignes t0 valides = ${rows.length} ; sans t0 = ${noT0.length}`);
L.push(`- data/tokens : top10Pct connu (dernier tick) sur ${tokensKnown} mints ; aligné avec le tick t0 sur ${tokensAligned} mints`);
L.push(`- data/earlybuyers : ${ebFiles} fichiers ; métriques exploitables : ${ebRows.filter(e => e.top5 !== null).length}`);
L.push(`- ticks aberrants (glitch ≥100×) exclus de Y : ${rows.reduce((a, r) => a + r.aberrantTicks, 0)} sur ${rows.reduce((a, r) => a + r.seriesTicks, 0)} ticks`);
L.push("");
L.push("## 2. Couverture de Y par horizon (sur les lignes t0 valides)");
for (const b of yBaseline(rows)) {
  L.push(`- ${b.horizon} : n=${b.n} (${pct(rows.length ? b.n / rows.length : null)} des t0) ; moyenne=${fmt(b.mean)} ; médiane=${fmt(b.medianY)} ; IC95%=[${b.ci ? b.ci.map((v) => fmt(v)).join(", ") : "n/a"}] ; pertes extrêmes (≤-50 %)=${pct(b.fracExtremeLoss)}`);
}
L.push("");
L.push("## 3. Couverture des variables X par univers (X non nul ET Y(h) non nul)");
function covSection(name: string, getX: (r: T0Row) => number | null) {
  const cov = coverageByUniverse(rows.map((r) => ({ universe: r.universe, x: getX(r), y: r.y })));
  L.push(`### ${name}`);
  for (const u of ["discovery", "calibration", "holdout"] as Universe[]) {
    const c = cov[u];
    L.push(`- ${u} : X=${c.xTotal} ; 1h=${c.perHorizon[0]} ; 6h=${c.perHorizon[1]} ; 24h=${c.perHorizon[2]}`);
  }
}
covSection("top10Pct à t0 (data/history ; 100 = inconnu → null)", (r) => r.top10Pct);
covSection("holders à t0", (r) => r.holders);
covSection("évolution top10Pct pré-t0 → t0 (delta, connu aux deux bornes)", (r) =>
  r.top10Pct !== null && r.top10PctPreT0 !== null ? r.top10Pct - r.top10PctPreT0 : null);
covSection("top10Pct aligné t0 (data/tokens, dernier tick = tick t0)", (r) => {
  const a = alignedX.find((e) => e.row.mint === r.mint);
  return a ? a.x : null;
});
covSection("sellRatio à t0 (proxy auxiliaire sells, fenêtre h1)", (r) => r.sellRatioT0);
L.push("");

L.push("## 4. Analyses X→Y (univers discovery)");
function anaSection(name: string, getX: (r: T0Row) => number | null) {
  L.push(`### ${name}`);
  for (let hi = 0; hi < 3; hi++) {
    const a = pairFor(name, getX, "discovery", hi);
    if (a.n === 0) {
      L.push(`- ${HORIZON_LABELS[hi]} : n=0 — INMESURABLE (aucune valeur X disponible)`);
      continue;
    }
    L.push(`- ${HORIZON_LABELS[hi]} : n=${a.n}${a.conclusive ? "" : ` (< ${MIN_N_CONCLUSION} : non concluant)`} ; spearman=${fmt(a.spearman)} ; médiane Y=${fmt(a.medianY)} ; moyenne=${fmt(a.mean)} ; IC95%=[${a.ci ? a.ci.map((v) => fmt(v)).join(", ") : "n/a"}] ; pertes extrêmes=${pct(a.fracExtremeLoss)}${a.trimmed ? ` ; sans outliers P1/P99 (n=${a.trimmed.n}, retirés=${a.trimmed.removed}) : spearman=${fmt(a.trimmed.spearman)}, médiane=${fmt(a.trimmed.medianY)}` : ""}`);
    if (a.deciles) {
      const d = a.deciles;
      L.push(`  décile bas X (n=${d.bottomN}) : médiane=${fmt(d.bottomMedian)}, moyenne=${fmt(d.bottomMean)} ; décile haut X (n=${d.topN}) : médiane=${fmt(d.topMedian)}, moyenne=${fmt(d.topMean)}`);
    }
  }
}
anaSection("top10Pct à t0", (r) => r.top10Pct);
anaSection("holders à t0", (r) => r.holders);
anaSection("delta top10Pct (t0 − pré-t0)", (r) =>
  r.top10Pct !== null && r.top10PctPreT0 !== null ? r.top10Pct - r.top10PctPreT0 : null);
anaSection("top10Pct aligné t0 (data/tokens)", (r) => {
  const a = alignedX.find((e) => e.row.mint === r.mint);
  return a ? a.x : null;
});
anaSection("sellRatio à t0 (auxiliaire)", (r) => r.sellRatioT0);
L.push("");

L.push("## 5. Stabilité temporelle (deux moitiés de la fenêtre, univers discovery)");
{
  const disc = rows.filter((r) => r.universe === "discovery");
  const { first, second } = temporalHalves(disc);
  L.push(`- 1ère moitié (t0 les plus anciens, n=${first.length}) vs 2e moitié (n=${second.length})`);
  for (let hi = 0; hi < 3; hi++) {
    const ys1 = first.map((r) => r.y[hi] ?? null).filter((v): v is number => v !== null);
    const ys2 = second.map((r) => r.y[hi] ?? null).filter((v): v is number => v !== null);
    const srt = (a: number[]) => [...a].sort((x, y) => x - y);
    const med = (a: number[]) => (a.length ? (srt(a)[Math.floor(a.length / 2)] ?? null) : null);
    L.push(`- ${HORIZON_LABELS[hi]} : médiane Y 1ère moitié=${fmt(med(ys1))} (n=${ys1.length}) ; 2e moitié=${fmt(med(ys2))} (n=${ys2.length})`);
  }
  L.push("- Sans variable X mesurable, la stabilité temporelle des relations X→Y est non applicable.");
}
L.push("");

L.push("## 6. Early buyers (descriptif, n < 30 — aucune conclusion)");
L.push("| mint (8) | univ | top5_share | gini | same_slot_max | sellers>50% | t0 vs migration | Y 1h | Y 6h | Y 24h |");
L.push("|---|---|---|---|---|---|---|---|---|---|");
for (const e of ebRows) {
  if (e.top5 === null) { L.push(`| ${e.mint.slice(0, 8)} | ${e.universe} | SANS METRIQUES | | | | | | | |`); continue; }
  const offMin = e.migratedAt && e.t0FetchedAt
    ? Math.round((Date.parse(e.t0FetchedAt) - Date.parse(e.migratedAt)) / 60000) : null;
  const y = e.row ? e.row.y : [null, null, null];
  L.push(`| ${e.mint.slice(0, 8)} | ${e.universe} | ${fmt(e.top5)} | ${fmt(e.gini)} | ${fmt(e.ssm)} | ${e.sellersOver50 ?? "n/a"} | ${offMin === null ? "n/a" : offMin + " min"} | ${fmt(y[0] ?? null)} | ${fmt(y[1] ?? null)} | ${fmt(y[2] ?? null)} |`);
}
{
  const withM = ebRows.filter((e) => e.top5 !== null && e.row);
  for (let hi = 0; hi < 3; hi++) {
    for (const [vn, get] of [["top5_share", (e: EBRow) => e.top5], ["gini", (e: EBRow) => e.gini], ["same_slot_max", (e: EBRow) => e.ssm]] as const) {
      const xs: number[] = []; const ys: number[] = [];
      for (const e of withM) { const x = get(e); const y = e.row!.y[hi] ?? null; if (x !== null && y !== null) { xs.push(x); ys.push(y); } }
      const a = analyzePair(xs, ys);
      L.push(`- ${vn} → Y ${HORIZON_LABELS[hi]} : n=${a.n} (< 30, descriptif) ; spearman=${fmt(a.spearman)} ; médiane Y=${fmt(a.medianY)}`);
    }
  }
}
L.push("");
L.push("## 7. Clusters (top10Pct × sells)");
L.push("- Cluster spécifié (top10Pct élevé ET sells élevés à t0) : NON EXÉCUTABLE — top10Pct inconnu à t0 sur 100 % des lignes (codage 100).");
L.push(`- Couverture du proxy sells seul à t0 : ${rows.filter((r) => r.sellRatioT0 !== null).length}/${rows.length} lignes ont un ratio sells/(buys+sells) mesurable (fenêtre h1).`);
L.push("");
L.push("## 8. Déclarations");
L.push("- Données data/history/ et data/tokens/ biaisées vers les tokens chauds : toute mesure ci-dessus est une borne OPTIMISTE.");
L.push("- Holdout gelé (≥75) : jamais mesuré — aucune variable ne passe la phase découverte (n < 30 partout où X est mesurable).");
L.push("- data/track-unbiased/ : non touché.");
L.push("- AUCUN push, AUCUNE transaction réelle, AUCUNE modification hors du périmètre autorisé.");

console.log(L.join("\n"));
