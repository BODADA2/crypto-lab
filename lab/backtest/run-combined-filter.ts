/**
 * Backtest walk-forward du filtre combiné : (domaine URI = ipfs.io) ET (devBuy >= seuil)
 * + backtest du filtre d'exclusion industriel.
 *
 * Données réelles uniquement : data/scans/pump-2026-09-24…28.jsonl (creates + migrates exhaustifs).
 * devBuy = solAmount du create (connu à la création : pas de lookahead).
 * Outcome = migration dans les W heures suivant le create (fenêtre fixe anti-censure).
 *
 * Règles du labo : n>=30 pour conclure, médianes, honnêteté stricte.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/hatch/workspace/crypto-lab/repo";
const SCAN_DIR = join(REPO, "data/scans");
const HISTORY_DIR = join(REPO, "data/history");

interface Create {
  mint: string;
  receivedAt: number; // ms
  devBuy: number | null; // solAmount
  marketCapSol: number | null;
  pool: string | null;
  domain: string; // "?" si pas d'URI
  mayhem: boolean;
}

function domainOf(uri: string | null | undefined): string {
  if (!uri) return "?";
  const m = /^https?:\/\/([^/:]+)/i.exec(uri);
  return m ? m[1].toLowerCase() : "?";
}

function loadScans(): { creates: Create[]; migratesByMint: Map<string, number> } {
  const creates: Create[] = [];
  const migratesByMint = new Map<string, number>();
  const seen = new Set<string>();
  const files = readdirSync(SCAN_DIR).filter((f) => /^pump-2026-09-2[4-8]\.jsonl$/.test(f)).sort();
  for (const f of files) {
    for (const line of readFileSync(join(SCAN_DIR, f), "utf8").split("\n")) {
      const l = line.trim();
      if (!l) continue;
      let e: any;
      try { e = JSON.parse(l); } catch { continue; }
      if (e.kind === "create") {
        if (seen.has(e.mint)) continue;
        seen.add(e.mint);
        creates.push({
          mint: e.mint,
          receivedAt: Date.parse(e.receivedAt),
          devBuy: typeof e.solAmount === "number" ? e.solAmount : null,
          marketCapSol: typeof e.marketCapSol === "number" ? e.marketCapSol : null,
          pool: e.pool ?? e.raw?.pool ?? null,
          domain: domainOf(e.raw?.uri),
          mayhem: e.raw?.is_mayhem_mode === true,
        });
      } else if (e.kind === "migrate") {
        const t = Date.parse(e.receivedAt);
        const prev = migratesByMint.get(e.mint);
        if (prev === undefined || t < prev) migratesByMint.set(e.mint, t);
      }
    }
  }
  creates.sort((a, b) => a.receivedAt - b.receivedAt);
  return { creates, migratesByMint };
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

const { creates, migratesByMint } = loadScans();
console.log(`creates dédupliqués: ${creates.length}, mints migrés: ${migratesByMint.size}`);

// --- Distribution des délais create -> migrate (pour choisir la fenêtre W) ---
const delaysH: number[] = [];
for (const c of creates) {
  const m = migratesByMint.get(c.mint);
  if (m !== undefined && m >= c.receivedAt) delaysH.push((m - c.receivedAt) / 3600_000);
}
delaysH.sort((a, b) => a - b);
console.log(`délais create->migrate (n=${delaysH.length}): médiane=${quantile(delaysH, 0.5).toFixed(1)}h p75=${quantile(delaysH, 0.75).toFixed(1)}h p90=${quantile(delaysH, 0.9).toFixed(1)}h p95=${quantile(delaysH, 0.95).toFixed(1)}h`);

// --- Pools distincts + artefact bonk ---
const pools = new Map<string, { n: number; devBuyZero: number; devBuyVals: number[] }>();
for (const c of creates) {
  const p = c.pool ?? "?";
  let e = pools.get(p);
  if (!e) { e = { n: 0, devBuyZero: 0, devBuyVals: [] }; pools.set(p, e); }
  e.n++;
  if (c.devBuy === 0) e.devBuyZero++;
  if (c.devBuy !== null) e.devBuyVals.push(c.devBuy);
}
for (const [p, e] of pools) {
  console.log(`pool=${p} n=${e.n} devBuy==0: ${pct(e.devBuyZero / e.n)} médiane devBuy=${quantile(e.devBuyVals, 0.5).toFixed(2)}`);
}

// Fenêtre de suivi : données jusqu'au 2026-09-28T04:35Z.
const DATA_END = Date.parse("2026-09-28T04:35:00Z");
const W_HOURS = 12; // choisie après mesure des délais (voir sortie)
const W_MS = W_HOURS * 3600_000;

// Outcome avec fenêtre fixe : 1 si migré dans [create, create+W].
function outcome(c: Create): boolean {
  const m = migratesByMint.get(c.mint);
  return m !== undefined && m >= c.receivedAt && m <= c.receivedAt + W_MS;
}

// Split walk-forward : train = 24+25 (suivi complet), test = 26+27 avec >= W de suivi dispo.
const T = (s: string) => Date.parse(s);
const train = creates.filter((c) => c.receivedAt < T("2026-09-26T00:00:00Z") && c.receivedAt + W_MS <= DATA_END);
const test = creates.filter((c) => c.receivedAt >= T("2026-09-26T00:00:00Z") && c.receivedAt + W_MS <= DATA_END);
console.log(`train n=${train.length} (${new Date(train[0].receivedAt).toISOString()} → ${new Date(train[train.length-1].receivedAt).toISOString()})`);
console.log(`test  n=${test.length} (${new Date(test[0].receivedAt).toISOString()} → ${new Date(test[test.length-1].receivedAt).toISOString()})`);

interface Seg { name: string; trainN: number; trainRate: number; testN: number; testRate: number; }
const results: any = { window_hours: W_HOURS, segments: [] as Seg[], sensitivity: [] as any[], exclusion: {} as any };

function rate(set: Create[], pred: (c: Create) => boolean) {
  const s = set.filter(pred);
  const k = s.filter(outcome).length;
  return { n: s.length, k, rate: s.length ? k / s.length : NaN };
}

// Quartiles de devBuy sur TRAIN (pool != bonk, devBuy non nul connu)
const trainDevBuys = train.filter((c) => c.pool !== "bonk" && c.devBuy !== null && c.devBuy > 0).map((c) => c.devBuy as number);
const q3train = quantile(trainDevBuys, 0.75);
console.log(`devBuy Q3 sur train (hors bonk): ${q3train.toFixed(2)} SOL`);

// Filtre combiné : ipfs.io ET devBuy >= seuil, hors pool bonk (artefact devBuy)
const INDUSTRIAL = new Set(["metadata.j7tracker.io", "meta.uxento.io", "pump.mypinata.cloud", "gateway.pinata.cloud"]);
function combined(c: Create, thr: number): boolean {
  return c.pool !== "bonk" && c.domain === "ipfs.io" && c.devBuy !== null && c.devBuy >= thr;
}

const thresholds = [...new Set([1.0, +q3train.toFixed(2), 1.3, 1.5])].sort((a, b) => a - b);
for (const thr of thresholds) {
  const tr = rate(train, (c) => combined(c, thr));
  const te = rate(test, (c) => combined(c, thr));
  const [lo, hi] = ci95(te.rate, te.n);
  const entry = {
    seuil: +thr.toFixed(2),
    train_n: tr.n, train_k: tr.k, train_rate: tr.rate,
    test_n: te.n, test_k: te.k, test_rate: te.rate,
    test_ci95: [lo, hi],
    conclusive: te.n >= 30,
  };
  results.sensitivity.push(entry);
  console.log(`seuil ${thr.toFixed(2)}: train ${tr.k}/${tr.n}=${pct(tr.rate)} | test ${te.k}/${te.n}=${pct(te.rate)} IC[${pct(lo)},${pct(hi)}] n>=30:${te.n >= 30}`);
}

// Base rates train/test pour comparaison
const baseTr = rate(train, () => true), baseTe = rate(test, () => true);
console.log(`base train: ${baseTr.k}/${baseTr.n}=${pct(baseTr.rate)} | base test: ${baseTe.k}/${baseTe.n}=${pct(baseTe.rate)}`);
results.base = { train: baseTr, test: baseTe };

// --- Filtre d'exclusion industriel ---
function excluded(c: Create): boolean {
  return INDUSTRIAL.has(c.domain) || c.mayhem;
}
const excTr = rate(train, excluded), excTe = rate(test, excluded);
const keptTr = rate(train, (c) => !excluded(c)), keptTe = rate(test, (c) => !excluded(c));
console.log(`exclusion: exclus train ${excTr.k}/${excTr.n}=${pct(excTr.rate)} test ${excTe.k}/${excTe.n}=${pct(excTe.rate)}`);
console.log(`kept: train ${keptTr.k}/${keptTr.n}=${pct(keptTr.rate)} test ${keptTe.k}/${keptTe.n}=${pct(keptTe.rate)}`);
results.exclusion = { excluded_train: excTr, excluded_test: excTe, kept_train: keptTr, kept_test: keptTe };
// runners filtrés par erreur = migrés dans l'ensemble exclu (test)
const excMigratedTest = test.filter((c) => excluded(c) && outcome(c));
results.exclusion.runners_filtres_par_erreur_test = excMigratedTest.length;

// --- Couverture history pour le volet prix (MFE/P&L conditionnel) ---
const THR = 1.3;
const testFilter = test.filter((c) => combined(c, THR));
const histFiles = new Set(readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, "")));
const withHist = testFilter.filter((c) => histFiles.has(c.mint));
console.log(`test filtre combiné: n=${testFilter.length}, avec history: ${withHist.length} (${pct(withHist.length / Math.max(1, testFilter.length))})`);
results.history_coverage = { filter_n: testFilter.length, with_history: withHist.length };

// Délai create -> premier snapshot (combien du mouvement est raté)
interface Snap { priceUsd: number; fetchedAt: number; liquidityUsd: number; }
function loadSeries(mint: string): Snap[] {
  const p = join(HISTORY_DIR, mint + ".jsonl");
  if (!existsSync(p)) return [];
  const out: Snap[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const l = line.trim(); if (!l) continue;
    try {
      const s = JSON.parse(l);
      if (s.priceUsd > 0) out.push({ priceUsd: s.priceUsd, fetchedAt: Date.parse(s.fetchedAt), liquidityUsd: s.liquidityUsd ?? 0 });
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => a.fetchedAt - b.fetchedAt);
}

const entryDelaysH: number[] = [];
const trades: any[] = [];
for (const c of withHist) {
  const series = loadSeries(c.mint);
  if (series.length < 2) continue;
  entryDelaysH.push((series[0].fetchedAt - c.receivedAt) / 3600_000);
  // Entrée au premier snapshot (pas de lookahead : c'est notre première observation).
  // Sortie avec règles : TP +100 %, SL -50 %, time-stop 48 h, sinon dernier snapshot.
  // + version SANS CAP (hold jusqu'au dernier snapshot) pour mesurer la vraie queue droite.
  const entry = series[0].priceUsd;
  let mfe = 0, mae = 0, exitP = series[series.length - 1].priceUsd, exitReason = "fin";
  const tEnd = series[0].fetchedAt + 48 * 3600_000;
  for (const s of series.slice(1)) {
    const g = s.priceUsd / entry - 1;
    if (g > mfe) mfe = g;
    if (g < mae) mae = g;
    if (g >= 1.0) { exitP = s.priceUsd; exitReason = "TP+100%"; break; }
    if (g <= -0.5) { exitP = s.priceUsd; exitReason = "SL-50%"; break; }
    if (s.fetchedAt >= tEnd) { exitP = s.priceUsd; exitReason = "time-stop 48h"; break; }
  }
  const gross = exitP / entry - 1;
  const grossUncapped = series[series.length - 1].priceUsd / entry - 1;
  trades.push({ mint: c.mint, migrated: outcome(c), entryDelayH: entryDelaysH[entryDelaysH.length - 1], mfe, mae, gross, grossUncapped, exitReason, devBuy: c.devBuy, domain: c.domain });
}
results.entry_delay = { n: entryDelaysH.length, median_h: quantile(entryDelaysH, 0.5), p90_h: quantile(entryDelaysH, 0.9) };
console.log(`délai create->1er snapshot (n=${entryDelaysH.length}): médiane=${quantile(entryDelaysH, 0.5).toFixed(1)}h p90=${quantile(entryDelaysH, 0.9).toFixed(1)}h`);

const mfes = trades.map((t) => t.mfe), maes = trades.map((t) => t.mae);
const mig = trades.filter((t) => t.migrated);
const nonMig = trades.filter((t) => !t.migrated);
const exitReasons: Record<string, number> = {};
for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
results.conditional_trades = {
  n: trades.length,
  mfe_median: quantile(mfes, 0.5), mae_median: quantile(maes, 0.5),
  migrated_among: mig.length,
  migration_rate_in_tracked: mig.length / Math.max(1, trades.length),
  gross_median: quantile(trades.map((t) => t.gross), 0.5),
  gross_mean: trades.reduce((a, t) => a + t.gross, 0) / Math.max(1, trades.length),
  gross_uncapped_median: quantile(trades.map((t) => t.grossUncapped), 0.5),
  gross_uncapped_mean: trades.reduce((a, t) => a + t.grossUncapped, 0) / Math.max(1, trades.length),
  wins: trades.filter((t) => t.gross > 0).length,
  exit_reasons: exitReasons,
  migrated_split: {
    n: mig.length,
    gross_median: quantile(mig.map((t) => t.gross), 0.5),
    gross_mean: mig.reduce((a, t) => a + t.gross, 0) / Math.max(1, mig.length),
    uncapped_median: quantile(mig.map((t) => t.grossUncapped), 0.5),
    uncapped_mean: mig.reduce((a, t) => a + t.grossUncapped, 0) / Math.max(1, mig.length),
    mfe_median: quantile(mig.map((t) => t.mfe), 0.5),
  },
  nonmigrated_split: {
    n: nonMig.length,
    gross_median: quantile(nonMig.map((t) => t.gross), 0.5),
    gross_mean: nonMig.reduce((a, t) => a + t.gross, 0) / Math.max(1, nonMig.length),
    uncapped_median: quantile(nonMig.map((t) => t.grossUncapped), 0.5),
  },
};
results.trades_detail = trades;
console.log(`trades conditionnels n=${trades.length} (migrés: ${mig.length}, soit ${pct(mig.length / Math.max(1, trades.length))} — biais de suivi vs 10.73 % réel)`);
console.log(`  sorties: ${JSON.stringify(exitReasons)}`);
console.log(`  migrés: brut médian=${pct(quantile(mig.map((t) => t.gross), 0.5))} moyenne=${pct(mig.reduce((a, t) => a + t.gross, 0) / Math.max(1, mig.length))} | sans cap: médian=${pct(quantile(mig.map((t) => t.grossUncapped), 0.5))}`);
console.log(`  non-migrés (n=${nonMig.length}): brut médian=${pct(quantile(nonMig.map((t) => t.gross), 0.5))} moyenne=${pct(nonMig.reduce((a, t) => a + t.gross, 0) / Math.max(1, nonMig.length))}`);

// --- Interaction mayhem x filtre combiné (le filtre d'exclusion sert-il EN PLUS ?) ---
const cfTest = test.filter((c) => combined(c, THR));
const cfMayhem = rate(test, (c) => combined(c, THR) && c.mayhem);
const cfNoMayhem = rate(test, (c) => combined(c, THR) && !c.mayhem);
console.log(`combiné+mayhem: ${cfMayhem.k}/${cfMayhem.n}=${pct(cfMayhem.rate)} | combiné sans mayhem: ${cfNoMayhem.k}/${cfNoMayhem.n}=${pct(cfNoMayhem.rate)}`);
results.mayhem_interaction = { with_mayhem: cfMayhem, without_mayhem: cfNoMayhem };

// --- Analyse de breakeven : quel multiple gagnant faut-il ? ---
// E = p*W + (1-p)*L - coûts ; avec p=test, L=perte médiane non-migrés (conditionnelle)
const p = results.sensitivity.find((s: any) => s.seuil === 1.3).test_rate;
const L = results.conditional_trades.nonmigrated_split.gross_median; // ~ -0.95
for (const costs of [0.06, 0.08, 0.10]) {
  const Wneed = ((1 + costs) - (1 - p) * (1 + L)) / p - 1;
  console.log(`breakeven (coûts ${(costs * 100).toFixed(0)}%): multiple gagnant moyen requis = x${(1 + Wneed).toFixed(2)}`);
}
results.breakeven = { p_test: p, L_nonmigrated_median: L };

// P&L net après hurdles 6/8/10 % (frais+loyers, red team) — slippage simplifié via liquidité du 1er snapshot
for (const hurdle of [0.06, 0.08, 0.10]) {
  const nets = trades.map((t) => {
    const slip = 0.01; // ~1 % par côté sur 50 $ (ordre de grandeur, liquidité médiane élevée ici)
    return (1 + t.gross) * (1 - hurdle) * (1 - 2 * slip) - 1;
  });
  const mean = nets.reduce((a, b) => a + b, 0) / Math.max(1, nets.length);
  console.log(`hurdle ${(hurdle * 100).toFixed(0)}%: net moyen=${pct(mean)} médian=${pct(quantile(nets, 0.5))} wins=${nets.filter((x) => x > 0).length}/${nets.length}`);
  results[`pnl_hurdle_${Math.round(hurdle * 100)}`] = { mean, median: quantile(nets, 0.5), wins: nets.filter((x) => x > 0).length, n: nets.length };
}

writeFileSync(join(REPO, "data/backtests/combined-filter-2026-09-28.json"), JSON.stringify(results, null, 2));
console.log("JSON écrit.");
