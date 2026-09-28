/**
 * ÉTAPE 2 — Backtest walk-forward du "second filtre" : confirmation momentum post-migration.
 *
 * Candidat issu de la caractérisation (genuine uniquement) :
 *   signal = 1er snapshot dans [migration, migration+60min] avec imbalance acheteurs m5 > 0.2
 *            (buys-sells)/(buys+sells), sur >= 10 txns m5.
 *   → sur genuine : 25.3 % de gagnants (cont>=x2) vs 3.2 % si vendeurs (CIs disjoints).
 * Stratégie testée : entrée au 1er snapshot APRÈS le signal (pas de lookahead),
 * sortie TP+100 % / SL-50 % / time-stop 48h. Coûts : hurdle 8 % par round-trip.
 *
 * Protocole du labo : train = creates 24–25, test = creates 26–27 (suivi 12h complet),
 * n>=30, médianes. FALSIFICATEUR : net médian sur test <= 0 → abandonner proprement.
 *
 * Biais documentés :
 *  - creates PH (late-discovery) exclus — voir audit-late-discovery.ts ;
 *  - échantillon history = tokens chauds suivis → les résultats sont une borne OPTIMISTE ;
 *  - snapshots clairsemés : les sorties s'exécutent au snapshot suivant (pas au tick exact).
 * Données réelles uniquement. Aucun seuil du moteur modifié, aucune transaction réelle.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/hatch/workspace/crypto-lab/repo";
const SCAN_DIR = join(REPO, "data/scans");
const HISTORY_DIR = join(REPO, "data/history");
const PH_TUPLE = [85.005359057, 115.005359056806, 279900000, 410.8801681200643];

interface Create { mint: string; receivedAt: number; devBuy: number | null; pool: string | null; domain: string; mayhem: boolean; }
function domainOf(uri: string | null | undefined): string {
  if (!uri) return "?";
  const m = /^https?:\/\/([^/:]+)/i.exec(uri);
  return m ? m[1].toLowerCase() : "?";
}
interface Snap {
  priceUsd: number; fetchedAt: number; buys5: number; sells5: number;
  imb5: number | null; ntx5: number;
}
const pct = (x: number) => `${(x * 100).toFixed(2)} %`;
function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const med = (xs: number[]) => quantile(xs, 0.5);

// --- Chargement ---
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
      if (tup.every((v, i) => v === PH_TUPLE[i])) continue; // PH late-discovery : exclu
      creates.push({
        mint: e.mint, receivedAt: Date.parse(e.receivedAt),
        devBuy: typeof e.solAmount === "number" ? e.solAmount : null,
        pool: e.pool ?? raw.pool ?? null, domain: domainOf(raw.uri),
        mayhem: raw.is_mayhem_mode === true,
      });
    } else if (e.kind === "migrate") {
      const t = Date.parse(e.receivedAt);
      const prev = migratesByMint.get(e.mint);
      if (prev === undefined || t < prev) migratesByMint.set(e.mint, t);
    }
  }
}
creates.sort((a, b) => a.receivedAt - b.receivedAt);
console.log(`creates genuine: ${creates.length}`);

function loadSeries(mint: string): Snap[] {
  const p = join(HISTORY_DIR, mint + ".jsonl");
  if (!existsSync(p)) return [];
  const o: Snap[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const l = line.trim(); if (!l) continue;
    try {
      const s = JSON.parse(l);
      if (!(s.priceUsd > 0)) continue;
      const b = s.txns?.m5?.buys ?? 0, sl = s.txns?.m5?.sells ?? 0;
      const n = b + sl;
      o.push({ priceUsd: s.priceUsd, fetchedAt: Date.parse(s.fetchedAt), buys5: b, sells5: sl, imb5: n > 0 ? (b - sl) / n : null, ntx5: n });
    } catch { /* ignore */ }
  }
  return o.sort((a, b) => a.fetchedAt - b.fetchedAt);
}

const T = (s: string) => Date.parse(s);
const DATA_END = T("2026-09-28T04:35:00Z");
const W_MS = 12 * 3600_000;
const HURDLE = 0.08;

interface Trade { mint: string; split: string; entryDelayMin: number; gross: number; net: number; mfe: number; mae: number; exitReason: string; sigImb: number; }

function simulate(split: string, lo: number, hi: number, useSignal: boolean): Trade[] {
  const trades: Trade[] = [];
  for (const c of creates) {
    if (!(c.receivedAt >= lo && c.receivedAt < hi && c.receivedAt + W_MS <= DATA_END)) continue;
    const mt = migratesByMint.get(c.mint);
    if (mt === undefined || mt < c.receivedAt || mt > c.receivedAt + W_MS) continue;
    const series = loadSeries(c.mint);
    const post = series.filter((s) => s.fetchedAt >= mt);
    if (post.length < 2) continue;
    // Signal : 1er snapshot <= 60 min post-migration
    const sigIdx = post.findIndex((s) => s.fetchedAt <= mt + 3600_000);
    if (sigIdx === -1) continue;
    const sig = post[sigIdx];
    if (useSignal) {
      if (sig.imb5 === null || sig.imb5 <= 0.2 || sig.ntx5 < 10) continue;
    }
    // Entrée : 1er snapshot APRÈS le signal (pas de lookahead)
    const entryIdx = sigIdx + 1;
    if (entryIdx >= post.length) continue;
    const entry = post[entryIdx];
    const tEnd = entry.fetchedAt + 48 * 3600_000;
    let exitP = post[post.length - 1].priceUsd, reason = "fin";
    let mfe = 0, mae = 0;
    for (const s of post.slice(entryIdx + 1)) {
      const g = s.priceUsd / entry.priceUsd - 1;
      if (g > mfe) mfe = g;
      if (g < mae) mae = g;
      if (g >= 1.0) { exitP = s.priceUsd; reason = "TP+100%"; break; }
      if (g <= -0.5) { exitP = s.priceUsd; reason = "SL-50%"; break; }
      if (s.fetchedAt >= tEnd) { exitP = s.priceUsd; reason = "time-stop 48h"; break; }
    }
    const gross = exitP / entry.priceUsd - 1;
    trades.push({
      mint: c.mint, split, entryDelayMin: (entry.fetchedAt - mt) / 60000,
      gross, net: (1 + gross) * (1 - HURDLE) - 1, mfe, mae, exitReason: reason, sigImb: sig.imb5 ?? NaN,
    });
  }
  return trades;
}

const out: any = { hurdle: HURDLE, falsificateur: "net médian test <= 0 → abandon" };
for (const useSignal of [false, true]) {
  const label = useSignal ? "AVEC signal (imb>0.2)" : "SANS signal (baseline)";
  console.log(`\n## ${label}`);
  out[label] = {};
  for (const [split, lo, hi] of [["train", T("2026-09-24T00:00:00Z"), T("2026-09-26T00:00:00Z")], ["test", T("2026-09-26T00:00:00Z"), T("2026-09-28T00:00:00Z")]] as const) {
    const tr = simulate(split, lo, hi, useSignal);
    const nets = tr.map((t) => t.net), grosses = tr.map((t) => t.gross);
    const wins = nets.filter((x) => x > 0).length;
    const reasons: Record<string, number> = {};
    for (const t of tr) reasons[t.exitReason] = (reasons[t.exitReason] ?? 0) + 1;
    console.log(`  ${split}: n=${tr.length} net médian=${pct(med(nets))} moyen=${pct(nets.reduce((a, b) => a + b, 0) / Math.max(1, nets.length))} wins=${wins}/${tr.length} (${pct(wins / Math.max(1, tr.length))})`);
    console.log(`    brut médian=${pct(med(grosses))} MFE médian=${pct(med(tr.map((t) => t.mfe)))} MAE médian=${pct(med(tr.map((t) => t.mae)))} délai entrée médian=${med(tr.map((t) => t.entryDelayMin)).toFixed(0)}min`);
    console.log(`    sorties: ${JSON.stringify(reasons)} n>=30:${tr.length >= 30}`);
    out[label][split] = {
      n: tr.length, net_median: med(nets),
      net_mean: nets.reduce((a, b) => a + b, 0) / Math.max(1, nets.length),
      wins, gross_median: med(grosses),
      mfe_median: med(tr.map((t) => t.mfe)), mae_median: med(tr.map((t) => t.mae)),
      entry_delay_min_median: med(tr.map((t) => t.entryDelayMin)), exit_reasons: reasons,
    };
  }
}

const testNet = out["AVEC signal (imb>0.2)"]["test"].net_median;
const testN = out["AVEC signal (imb>0.2)"]["test"].n;
console.log(`\n## VERDICT`);
if (testN < 30) {
  console.log(`  DONNÉES INSUFFISANTES : n=${testN} < 30 sur test → pas de conclusion, ne pas intégrer.`);
  out.verdict = "DONNÉES INSUFFISANTES";
} else if (testNet <= 0) {
  console.log(`  ABANDON (falsificateur) : net médian test = ${pct(testNet)} <= 0 → le second filtre ne passe pas.`);
  out.verdict = "ABANDON";
} else {
  console.log(`  SIGNAL : net médian test = ${pct(testNet)} > 0, n=${testN} → candidat à approfondir (borne optimiste, échantillon chaud).`);
  out.verdict = "CANDIDAT";
}

writeFileSync(join(REPO, "data/backtests/momentum-confirm-2026-09-28.json"), JSON.stringify(out, null, 2));
console.log("JSON écrit : data/backtests/momentum-confirm-2026-09-28.json");
