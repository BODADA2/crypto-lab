/**
 * Job « early-buyer overlap » (quotidien, optionnel : exige HELIUS_API_KEY).
 *   npx tsx lab/signals/run-earlybuyers.ts [--tokens 20] [--k 3] [--n 50]
 *
 * 1) Lit les migrations dans data/scans/pump-*.jsonl (les plus récentes d'abord, dédoublonnées).
 * 2) Pour chaque token migré (max --tokens), récupère ses N premiers acheteurs via Helius
 *    (cache dans data/earlybuyers/<mint>.json pour ne jamais repayer un token déjà lu).
 * 3) Calcule les wallets présents dans ≥ K tokens et écrit data/wallets/<address>.json.
 * 4) Met à jour data/meta.json (crédits Helius cumulés du mois, estimation).
 *
 * Budget : ≈ (pages de signatures + transactions lues) crédits par token ; avec n=50 et
 * maxTransactions=200, au plus ~210 crédits/token → 20 tokens ≈ 4 200 crédits/jour ≈ 130 k/mois (< 1 M gratuit).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHeliusClient, type EarlyBuyersResult, type HeliusClient } from "../collect/helius.ts";
import type { PumpEvent } from "../collect/types.ts";
import { computeEarlyBuyerOverlap, writeWalletProfiles, type EarlyBuyerSet } from "./earlybuyers.ts";

export interface EarlyBuyersJobOptions {
  dataDir: string;
  helius: HeliusClient;
  maxTokens?: number;
  minRecurrence?: number;
  topN?: number;
  now?: () => number;
}

/** Migrations connues, plus récentes d'abord, une par mint. */
export function readMigrations(scansDir: string): PumpEvent[] {
  if (!existsSync(scansDir)) return [];
  const files = readdirSync(scansDir).filter((f) => f.startsWith("pump-") && f.endsWith(".jsonl")).sort().reverse();
  const seen = new Set<string>();
  const out: PumpEvent[] = [];
  for (const f of files) {
    const lines = readFileSync(join(scansDir, f), "utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as PumpEvent;
        if (ev.kind !== "migrate" || seen.has(ev.mint)) continue;
        seen.add(ev.mint);
        out.push(ev);
      } catch {
        /* ignorée */
      }
    }
  }
  return out;
}

export async function runEarlyBuyersJob(o: EarlyBuyersJobOptions): Promise<{ tokens: number; wallets: number; credits: number }> {
  const now = o.now ?? (() => Date.now());
  const scansDir = join(o.dataDir, "scans");
  const cacheDir = join(o.dataDir, "earlybuyers");
  mkdirSync(cacheDir, { recursive: true });
  const migrations = readMigrations(scansDir).slice(0, o.maxTokens ?? 20);
  const sets: EarlyBuyerSet[] = [];
  const before = o.helius.credits;
  for (const m of migrations) {
    const cachePath = join(cacheDir, `${m.mint}.json`);
    let res: EarlyBuyersResult;
    if (existsSync(cachePath)) {
      res = JSON.parse(readFileSync(cachePath, "utf8")) as EarlyBuyersResult;
    } else {
      try {
        res = await o.helius.getEarlyBuyers(m.mint, o.topN ?? 50, { maxTransactions: 200 });
      } catch (e) {
        console.error(`[earlybuyers] ${m.mint}: ${(e as Error).message}`);
        continue;
      }
      writeFileSync(cachePath, JSON.stringify({ ...res, fetchedAt: new Date(now()).toISOString() }, null, 2) + "\n");
    }
    sets.push({ mint: m.mint, buyers: res.buyers, migratedAt: m.receivedAt });
  }
  // Tous les tokens déjà en cache participent à l'univers (même s'ils ne sont plus dans les scans).
  for (const f of readdirSync(cacheDir)) {
    const mint = f.replace(/\.json$/, "");
    if (sets.some((s) => s.mint === mint)) continue;
    try {
      const res = JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as EarlyBuyersResult;
      sets.push({ mint, buyers: res.buyers });
    } catch {
      /* ignorée */
    }
  }
  const profiles = computeEarlyBuyerOverlap(sets, { minRecurrence: o.minRecurrence ?? 3, topN: o.topN ?? 50, now });
  writeWalletProfiles(profiles, join(o.dataDir, "wallets"));
  const credits = o.helius.credits - before;
  const metaPath = join(o.dataDir, "meta.json");
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>) : {};
  const month = new Date(now()).toISOString().slice(0, 7);
  meta.heliusCreditsMonth = (meta.heliusMonth === month ? Number(meta.heliusCreditsMonth ?? 0) : 0) + credits;
  meta.heliusMonth = month;
  meta.lastEarlyBuyersRun = new Date(now()).toISOString();
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { tokens: sets.length, wallets: profiles.length, credits };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.log("HELIUS_API_KEY absent : job early-buyers ignoré.");
    process.exit(0);
  }
  const arg = (name: string, def: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : def;
  };
  const helius = createHeliusClient({ fetch: globalThis.fetch, apiKey });
  const res = await runEarlyBuyersJob({ dataDir: resolve(process.env.DATA_DIR ?? "data"), helius, maxTokens: arg("tokens", 20), minRecurrence: arg("k", 3), topN: arg("n", 50) });
  console.log(`early-buyers : ${res.tokens} tokens, ${res.wallets} wallets récurrents, ${res.credits} crédits Helius.`);
}
