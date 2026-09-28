/**
 * SPRINT 1 — E4 : Fenêtres early buyers, qualité des données (famille A).
 *
 * HYPOTHÈSE H-S1-E4 : « Les 5 WINDOW_DEFS (pre_t0_set, first_block,
 * first_5_slots, first_60s, first_300s) sont matériellement différentes :
 * les Jaccard inter-fenêtres sont < 0.9 et les tailles de sets diffèrent
 * substantiellement. Si Jaccard ~1 partout → fenêtres redondantes. »
 *
 * Méthode (lecture seule, aucun appel API, aucune écriture dans data/) :
 *  - pour chaque data/earlybuyers/<mint>.json : t0ms depuis data/history
 *    (findT0), set pré-t0 = buyers avec blockTime != null ET
 *    blockTime*1000 <= t0ms (même règle que snapshot.ts, sans les appels
 *    Helius) ;
 *  - applyWindow() par WINDOW_DEF → tailles, Jaccard par paires (sets de
 *    wallets), part de buyers first_block.
 * Aucun label, aucun modèle : data-quality uniquement.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { findT0 } from "../predictive/universe.ts";
import {
  WINDOW_DEFS,
  applyWindow,
  type WindowDef,
} from "../predictive/earlybuyers/windows.ts";
import type { SnapshotBuyer } from "../predictive/earlybuyers/types.ts";
import { jaccard, median } from "./common.ts";
import type { TokenSnapshot } from "../types.ts";

const OUT = "research/results/exp-e4-windows.json";

interface RawBuyer {
  wallet?: string;
  blockTime?: number | null; // secondes unix (null exclu du set)
  slot?: number | null;
  rank?: number;
}

function loadPreT0Set(mint: string): SnapshotBuyer[] | null {
  let raw: string;
  try {
    raw = readFileSync(`data/earlybuyers/${mint}.json`, "utf-8");
  } catch {
    return null;
  }
  let hist: string;
  try {
    hist = readFileSync(`data/history/${mint}.jsonl`, "utf-8");
  } catch {
    return null; // pas de série → pas de t0 fiable
  }
  const series: TokenSnapshot[] = [];
  for (const line of hist.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      series.push(JSON.parse(t) as TokenSnapshot);
    } catch {
      /* ignore */
    }
  }
  series.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const t0 = findT0(series);
  if (t0 < 0) return null;
  const t0ms = Date.parse(series[t0]!.fetchedAt);

  let buyers: RawBuyer[];
  try {
    buyers = (JSON.parse(raw) as { buyers?: RawBuyer[] }).buyers ?? [];
  } catch {
    return null;
  }
  const set: SnapshotBuyer[] = [];
  for (const b of buyers) {
    if (b.blockTime == null || !b.wallet) continue;
    const ms = b.blockTime * 1000;
    if (ms > t0ms) continue; // post-t0 : hors set (règle snapshot.ts)
    set.push({
      wallet: b.wallet,
      blockTimeMs: ms,
      slot: b.slot ?? null,
      rank: b.rank ?? 0,
      amountRaw: BigInt(0),
    });
  }
  set.sort((a, b) => a.rank - b.rank);
  return set;
}

function main(): void {
  const files = readdirSync("data/earlybuyers").filter((f) =>
    f.endsWith(".json"),
  );
  const defs = WINDOW_DEFS.map((w) => w.def);
  const sizes: Record<WindowDef, number[]> = {
    pre_t0_set: [],
    first_block: [],
    first_5_slots: [],
    first_60s: [],
    first_300s: [],
  };
  // Jaccard par paires (accumulé en moyenne sur les mints).
  const pairJacc: Record<string, number[]> = {};
  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      pairJacc[`${defs[i]}__${defs[j]}`] = [];
    }
  }
  const firstBlockShare: number[] = [];
  let nMints = 0;
  let nEmptyPreT0 = 0;
  let nNoSlots = 0;
  let dropped = 0;

  for (const f of files) {
    const mint = f.slice(0, -".json".length);
    const set = loadPreT0Set(mint);
    if (set == null) { dropped++; continue; }
    nMints++;
    if (set.length === 0) { nEmptyPreT0++; continue; }
    const winSets = new Map<WindowDef, Set<string>>();
    for (const d of defs) {
      const w = applyWindow(set, d);
      sizes[d].push(w.length);
      winSets.set(d, new Set(w.map((b) => b.wallet)));
    }
    const fb = winSets.get("first_block")!;
    if (fb.size === 0) nNoSlots++;
    firstBlockShare.push(fb.size / set.length);
    for (let i = 0; i < defs.length; i++) {
      for (let j = i + 1; j < defs.length; j++) {
        const a = winSets.get(defs[i]!)!;
        const b = winSets.get(defs[j]!)!;
        pairJacc[`${defs[i]}__${defs[j]}`]!.push(jaccard(a, b));
      }
    }
  }

  const mean = (a: number[]) =>
    a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const summary = {
    experiment: "E4",
    hypothesis_id: "H-S1-E4",
    universe: "n/a (data-quality, pas de split)",
    question:
      "Les 5 définitions de fenêtres early buyers sont-elles matériellement différentes ?",
    leakage_status: "PASS",
    leakage_detail:
      "Aucun label futur, aucun modèle. Fenêtres = filtres du set pré-t0 " +
      "(blockTimeMs <= t0ms, même règle que snapshot.ts). first_block/first_5_slots " +
      "retournent [] si aucun slot non-null (documenté dans windows.ts). " +
      "Lecture seule : data/earlybuyers/ et data/history/ non modifiés ; " +
      "aucun appel Helius (l'agent backfill écrit en parallèle — fichiers lus en l'état).",
    data_bias: "n/a (pas de mesure de performance)",
    n_mint_files: files.length,
    n_mints_with_t0_and_history: nMints,
    n_empty_pre_t0_set: nEmptyPreT0,
    n_no_slot_info: nNoSlots,
    dropped_no_history_or_t0: dropped,
    per_window: Object.fromEntries(
      defs.map((d) => [
        d,
        {
          n: sizes[d].length,
          mean_size: mean(sizes[d]),
          median_size: median(sizes[d]),
          min_size: sizes[d].length ? Math.min(...sizes[d]) : null,
          max_size: sizes[d].length ? Math.max(...sizes[d]) : null,
        },
      ]),
    ),
    mean_jaccard_pairs: Object.fromEntries(
      Object.entries(pairJacc).map(([k, v]) => [k, mean(v)]),
    ),
    first_block_share_of_pre_t0: {
      n: firstBlockShare.length,
      mean: mean(firstBlockShare),
      median: median(firstBlockShare),
    },
    cost_sensitivity: "non évaluée (data-quality, aucune stratégie)",
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`E4: fichiers=${files.length} mints_utilisables=${nMints} vides=${nEmptyPreT0} sans_slots=${nNoSlots} abandonnés=${dropped}`);
  for (const d of defs) {
    console.log(`  ${d}: mean=${mean(sizes[d])?.toFixed(1)} median=${median(sizes[d])}`);
  }
  console.log("  Jaccard moyens :");
  for (const [k, v] of Object.entries(pairJacc)) {
    console.log(`    ${k}: ${mean(v)?.toFixed(3)}`);
  }
  console.log(`→ ${OUT}`);
}

main();
