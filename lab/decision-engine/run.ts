/**
 * DECISION ENGINE — run paper. Lecture seule (DexScreener public + Helius read).
 * Aucun ordre réel, aucune écriture on-chain. Signaux → JSONL, positions → ledger.json.
 *
 * Usage : npx tsx lab/decision-engine/run.ts [--candidates 10] [--max-credits 100]
 */
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "./decisionEngine.ts";
import { PaperLedger, type ExitEvent } from "./paperLedger.ts";
import { buildSnapshots, fetchDexPairs } from "./feeds.ts";
import { DEFAULT_CONFIG, type PaperPosition, type Signal } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(ROOT, { recursive: true });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function args(): { candidates: number; maxCredits: number } {
  const a = process.argv.slice(2);
  const get = (k: string, d: number) => {
    const i = a.indexOf(k);
    return i >= 0 && a[i + 1] ? Number(a[i + 1]) || d : d;
  };
  return { candidates: get("--candidates", 10), maxCredits: get("--max-credits", 100) };
}

interface LedgerFile {
  bankrollUsd: number;
  positions: PaperPosition[];
  exits: ExitEvent[];
}

function loadLedger(): PaperLedger {
  const ledger = new PaperLedger(DEFAULT_CONFIG);
  const p = join(ROOT, "ledger.json");
  if (!existsSync(p)) return ledger;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as LedgerFile;
    ledger.bankrollUsd = data.bankrollUsd;
    // Restaure les positions via open() pour garder la logique de sizing cohérente
    for (const pos of data.positions) {
      (ledger as unknown as { positions: Map<string, PaperPosition> }).positions.set(pos.mint, pos);
    }
    (ledger as unknown as { exits: ExitEvent[] }).exits.push(...(data.exits ?? []));
  } catch {
    // ledger corrompu → repart propre, sans écraser l'historique JSONL
  }
  return ledger;
}

function saveLedger(ledger: PaperLedger): void {
  const data: LedgerFile = {
    bankrollUsd: ledger.bankrollUsd,
    positions: ledger.openPositions,
    exits: ledger.exitsLog,
  };
  writeFileSync(join(ROOT, "ledger.json"), JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  const { candidates, maxCredits } = args();
  console.log(`[decision-engine] PAPER RUN — candidats=${candidates} crédits_max=${maxCredits}`);

  const ledger = loadLedger();
  const signalsPath = join(ROOT, `signals-${today()}.jsonl`);
  const exitsPath = join(ROOT, `exits-${today()}.jsonl`);

  // 1. Scan → snapshots → décisions
  const snapshots = await buildSnapshots({ maxCandidates: candidates, maxHeliusCredits: maxCredits });
  console.log(`[decision-engine] ${snapshots.length} snapshots après pré-filtre liquidité`);

  let buys = 0;
  let skips = 0;
  for (const s of snapshots) {
    const signal: Signal = decide(s, DEFAULT_CONFIG);
    appendFileSync(signalsPath, JSON.stringify(signal) + "\n");
    if (signal.action === "BUY") {
      buys++;
      const pos = ledger.open(s.mint, s.ticker, s.priceUsd, Date.now());
      console.log(`[BUY-paper] ${s.ticker} conf=${signal.confidence_score} ${signal.reasoning_short}${pos ? "" : " (ledger plein/doublon)"}`);
    } else {
      skips++;
    }
  }

  // 2. Suivi des positions ouvertes : refresh prix + exits
  const open = ledger.openPositions;
  if (open.length > 0) {
    const pairs = await fetchDexPairs(open.map((p) => p.mint));
    const now = Date.now();
    for (const pos of open) {
      const arr = pairs.get(pos.mint) ?? [];
      const best = [...arr].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const price = best?.priceUsd ? Number(best.priceUsd) : null;
      if (price == null || price <= 0) {
        console.log(`[ledger] ${pos.ticker} : prix indisponible, position conservée`);
        continue;
      }
      const events = ledger.evaluate(pos.mint, price, now);
      for (const e of events) {
        appendFileSync(exitsPath, JSON.stringify(e) + "\n");
        console.log(`[${e.kind}-paper] ${e.ticker} @ $${e.exitPrice} pnl ${e.pnlPct.toFixed(1)}% (${e.detail})`);
      }
    }
  }

  saveLedger(ledger);
  const spent = snapshots.length > 0 ? snapshots[snapshots.length - 1].heliusCredits : 0;
  console.log(
    `[decision-engine] FIN — BUY=${buys} SKIP=${skips} positions_ouvertes=${ledger.openCount} ` +
    `bankroll=$${ledger.bankrollUsd.toFixed(2)} crédits_helius≈${spent}`,
  );
}

main().catch((e) => {
  console.error("[decision-engine] ERREUR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
