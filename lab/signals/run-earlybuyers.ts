/**
 * Job « early-buyer overlap » (quotidien, optionnel : auth via le skill helius).
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
/**
 * Job « early-buyer bundle » (quotidien, optionnel : auth via le skill helius).
 *   npx tsx lab/signals/run-earlybuyers.ts [--tokens 50] [--k 3] [--n 50]
 *     [--max-credits 15000] [--monthly-cap 400000] [--no-sells] [--max-pages 60] [--require-history-t0]
 *
 * 1) Lit les migrations dans data/scans/pump-*.jsonl (les plus récentes d'abord, dédoublonnées),
 *    filtrées sur les mints ayant un t0 valide dans data/history/ si --require-history-t0.
 * 2) Pour chaque token migré (max --tokens), récupère ses N premiers acheteurs via Helius
 *    (cache dans data/earlybuyers/<mint>.json pour ne jamais repayer un token déjà lu ;
 *    getTransaction tolérant -32015 : versions 0/1/2 puis transaction ignorée et comptée dans skippedTx).
 * 3) Calcule les métriques de bundling H-BUNDLE (top5_share, gini, same_slot_max) et,
 *    sauf --no-sells, les ventes coordonnées post-migration (coordinated_sells) pour les
 *    tokens dont la fenêtre de 5 min post-migration est écoulée.
 * 4) Calcule les wallets présents dans ≥ K tokens et écrit data/wallets/<address>.json.
 * 5) Met à jour data/meta.json (crédits Helius cumulés du mois, estimation).
 *
 * Garde-fous : arrêt propre si --max-credits (ce run) ou --monthly-cap (mois calendaire,
 * lu dans data/meta.json) est atteint. Aucune métrique n'est un signal d'achat :
 * T-BUNDLE est pré-enregistré (docs/preregistered-addendum-2026-09-28.md).
 *
 * Budget : ≈ (pages de signatures + transactions lues) crédits par token ; avec n=50 et
 * maxTransactions=200, au plus ~210 crédits/token pour les acheteurs, + ~410 pour les
 * ventes (10 wallets × 41). 50 tokens/jour ≈ 31 k/jour au pire ≈ sous le plafond mensuel.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHeliusClient, type EarlyBuyersResult, type HeliusClient } from "../collect/helius.ts";
import { getHeliusRpcUrl, withHeliusAuthRefresh, HeliusAuthError } from "../collect/helius-auth.ts";
import type { PumpEvent, WalletTokenEvent } from "../collect/types.ts";
import {
  computeBundleMetrics,
  computeCoordinatedSells,
  computeEarlyBuyerOverlap,
  writeWalletProfiles,
  type BundleMetrics,
  type CoordinatedSells,
  type EarlyBuyerSet,
} from "./earlybuyers.ts";

/** Borne haute de crédits par token : ~210 (acheteurs) + ~410 (ventes : 10 wallets × 41). */
export const EST_CREDITS_PER_TOKEN = 650;

/**
 * t0 d'un token depuis son historique DexScreener : `fetchedAt` (ms) du premier snapshot
 * avec priceUsd > 0 et liquidityUsd >= 20000. `null` si aucun snapshot valide.
 */
export function findHistoryT0(dataDir: string, mint: string): number | null {
  const p = join(dataDir, "history", `${mint}.jsonl`);
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as { priceUsd?: number; liquidityUsd?: number; fetchedAt?: string };
      if ((d.priceUsd ?? 0) > 0 && (d.liquidityUsd ?? 0) >= 20000 && d.fetchedAt) {
        const ms = Date.parse(d.fetchedAt);
        if (!Number.isNaN(ms)) return ms;
      }
    } catch {
      /* ligne ignorée */
    }
  }
  return null;
}

export interface EarlyBuyersJobOptions {
  dataDir: string;
  helius: HeliusClient;
  maxTokens?: number;
  minRecurrence?: number;
  topN?: number;
  now?: () => number;
  /** Plafond de crédits Helius pour ce run (arrêt propre si dépassé). Défaut 15000. */
  maxCredits?: number;
  /** Plafond mensuel calendaire (défaut 400000 < 1M gratuit). */
  monthlyCap?: number;
  /** Calculer coordinated_sells quand la fenêtre post-migration est écoulée. Défaut true. */
  withSells?: boolean;
  /** Top acheteurs analysés pour les ventes, par montant décroissant (défaut 10). */
  sellsWallets?: number;
  /** Transactions lues par wallet pour les ventes (défaut 40, max 100 côté Helius). */
  sellsTxLimit?: number;
  /** Sauter l'analyse overlap (défaut false). */
  skipOverlap?: boolean;
  /** Pages de signatures remontées par getEarlyBuyers (défaut 10 ; 60 recommandé anti-troncature, 1 crédit/page). */
  maxPages?: number;
  /**
   * Pré-filtre : ne backfiller que les mints ayant data/history/<mint>.jsonl avec un t0 valide
   * (findHistoryT0). Les mints sans série ou sans t0 sont ignorés AVANT tout appel payant.
   * Défaut false.
   */
  requireHistoryT0?: boolean;
}

export interface CachedEarlyBuyers extends EarlyBuyersResult {
  fetchedAt?: string;
  migratedAt?: string | null;
  metrics?: BundleMetrics;
  sells?: CoordinatedSells;
}

export interface EarlyBuyersJobReport {
  tokens: number;
  wallets: number;
  credits: number;
  fetched: number;
  metricsComputed: number;
  sellsComputed: number;
  stoppedEarly: string | null;
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

function readMeta(dataDir: string): Record<string, unknown> {
  const metaPath = join(dataDir, "meta.json");
  return existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>) : {};
}

export async function runEarlyBuyersJob(o: EarlyBuyersJobOptions): Promise<EarlyBuyersJobReport> {
  const now = o.now ?? (() => Date.now());
  const maxCredits = o.maxCredits ?? 15000;
  const monthlyCap = o.monthlyCap ?? 400000;
  const withSells = o.withSells ?? true;
  const sellsWallets = o.sellsWallets ?? 10;
  const sellsTxLimit = Math.min(o.sellsTxLimit ?? 40, 100);
  const scansDir = join(o.dataDir, "scans");
  const cacheDir = join(o.dataDir, "earlybuyers");
  mkdirSync(cacheDir, { recursive: true });

  const meta = readMeta(o.dataDir);
  const month = new Date(now()).toISOString().slice(0, 7);
  let monthCredits = meta.heliusMonth === month ? Number(meta.heliusCreditsMonth ?? 0) : 0;
  const report: EarlyBuyersJobReport = {
    tokens: 0,
    wallets: 0,
    credits: 0,
    fetched: 0,
    metricsComputed: 0,
    sellsComputed: 0,
    stoppedEarly: null,
  };
  const stopCheck = (): string | null => {
    if (report.credits >= maxCredits) return `plafond run ${maxCredits} crédits atteint`;
    if (monthCredits + report.credits >= monthlyCap) return `plafond mensuel ${monthlyCap} crédits atteint`;
    return null;
  };
  if (monthCredits >= monthlyCap) {
    report.stoppedEarly = `plafond mensuel ${monthlyCap} crédits déjà atteint (${monthCredits}) : rien à faire`;
    return report;
  }

  let migrations = readMigrations(scansDir);
  if (o.requireHistoryT0) {
    const before = migrations.length;
    migrations = migrations.filter((m) => findHistoryT0(o.dataDir, m.mint) !== null);
    const dropped = before - migrations.length;
    if (dropped > 0) console.log(`[earlybuyers] pré-filtre t0 : ${dropped} mints sans historique/t0 ignorés avant tout appel payant.`);
  }
  migrations = migrations.slice(0, o.maxTokens ?? 20);
  const sets: EarlyBuyerSet[] = [];
  const before = o.helius.credits;

  const saveCache = (mint: string, data: CachedEarlyBuyers) => {
    writeFileSync(join(cacheDir, `${mint}.json`), JSON.stringify(data, null, 2) + "\n");
  };

  for (const m of migrations) {
    const reason = stopCheck();
    if (reason) {
      report.stoppedEarly = reason;
      break;
    }
    const cachePath = join(cacheDir, `${m.mint}.json`);
    let res: CachedEarlyBuyers;
    if (existsSync(cachePath)) {
      try {
        res = JSON.parse(readFileSync(cachePath, "utf8")) as CachedEarlyBuyers;
      } catch {
        continue;
      }
    } else {
      // Garde-fou : ne pas engager un token si la borne haute dépasse le plafond.
      if (report.credits + EST_CREDITS_PER_TOKEN > maxCredits || monthCredits + report.credits + EST_CREDITS_PER_TOKEN > monthlyCap) {
        report.stoppedEarly = "plafond crédits : token suivant non engagé (borne haute)";
        break;
      }
      try {
        const fresh = await o.helius.getEarlyBuyers(m.mint, o.topN ?? 50, { maxTransactions: 200, maxPages: o.maxPages ?? 10 });
        report.fetched += 1;
        res = { ...fresh, fetchedAt: new Date(now()).toISOString(), migratedAt: m.receivedAt ?? null };
      } catch (e) {
        console.error(`[earlybuyers] ${m.mint}: ${(e as Error).message}`);
        continue;
      }
    }
    // Métriques de bundling : gratuites (calcul local), (re)calculées si absentes.
    if (!res.metrics) {
      res.metrics = computeBundleMetrics(res.buyers, { truncated: res.truncated, now });
      report.metricsComputed += 1;
    }
    if (res.migratedAt == null && m.receivedAt) res.migratedAt = m.receivedAt;
    // Ventes coordonnées : seulement si la fenêtre post-migration est écoulée.
    if (withSells && !res.sells && res.migratedAt) {
      const migratedAtMs = Date.parse(res.migratedAt);
      const windowSec = 300;
      if (!Number.isNaN(migratedAtMs) && now() > migratedAtMs + (windowSec + 600) * 1000) {
        const reasonSells = stopCheck();
        if (reasonSells) {
          report.stoppedEarly = reasonSells;
          saveCache(m.mint, res);
          break;
        }
        try {
          const top = [...res.buyers]
            .sort((a, b) => {
              const x = BigInt(a.amountRaw);
              const y = BigInt(b.amountRaw);
              return x < y ? 1 : x > y ? -1 : 0;
            })
            .slice(0, sellsWallets);
          const histories = new Map<string, WalletTokenEvent[]>();
          for (const b of top) {
            const h = await o.helius.getWalletTokenHistory(b.wallet, { limit: sellsTxLimit });
            histories.set(b.wallet, h.events);
          }
          res.sells = computeCoordinatedSells(top, histories, m.mint, migratedAtMs, { windowSec, now });
          report.sellsComputed += 1;
        } catch (e) {
          console.error(`[earlybuyers:sells] ${m.mint}: ${(e as Error).message}`);
        }
      }
    }
    saveCache(m.mint, res);
    sets.push({ mint: m.mint, buyers: res.buyers, migratedAt: res.migratedAt ?? m.receivedAt });
    report.credits = o.helius.credits - before;
  }
  // Tous les tokens déjà en cache participent à l'univers (même s'ils ne sont plus dans les scans).
  for (const f of readdirSync(cacheDir)) {
    const mint = f.replace(/\.json$/, "");
    if (sets.some((s) => s.mint === mint)) continue;
    try {
      const res = JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as CachedEarlyBuyers;
      sets.push({ mint, buyers: res.buyers });
    } catch {
      /* ignorée */
    }
  }
  if (!o.skipOverlap) {
    const profiles = computeEarlyBuyerOverlap(sets, { minRecurrence: o.minRecurrence ?? 3, topN: o.topN ?? 50, now });
    writeWalletProfiles(profiles, join(o.dataDir, "wallets"));
    report.wallets = profiles.length;
  }
  report.tokens = sets.length;
  report.credits = o.helius.credits - before;
  const metaPath = join(o.dataDir, "meta.json");
  const freshMeta = readMeta(o.dataDir);
  freshMeta.heliusCreditsMonth = (freshMeta.heliusMonth === month ? Number(freshMeta.heliusCreditsMonth ?? 0) : 0) + report.credits;
  freshMeta.heliusMonth = month;
  freshMeta.lastEarlyBuyersRun = new Date(now()).toISOString();
  writeFileSync(metaPath, JSON.stringify(freshMeta, null, 2) + "\n");
  return report;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name: string, def: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : def;
  };
  const flag = (name: string) => process.argv.includes(`--${name}`);
  // En cas de 401/403 (surrogate expiré), régénère l'URL une fois et réessaie.
  // Le job est idempotent (cache par token) : une reprise ne repaie rien.
  let res: EarlyBuyersJobReport;
  try {
    res = await withHeliusAuthRefresh("https://mainnet.helius-rpc.com/", async (url) => {
      const helius = createHeliusClient({ fetch: globalThis.fetch, rpcUrl: url });
      return runEarlyBuyersJob({
        dataDir: resolve(process.env.DATA_DIR ?? "data"),
        helius,
        maxTokens: arg("tokens", 20),
        minRecurrence: arg("k", 3),
        topN: arg("n", 50),
        maxCredits: arg("max-credits", 15000),
        monthlyCap: arg("monthly-cap", 400000),
        withSells: !flag("no-sells"),
        sellsWallets: arg("sells-wallets", 10),
        sellsTxLimit: arg("sells-tx", 40),
        skipOverlap: flag("skip-overlap"),
        maxPages: arg("max-pages", 10),
        requireHistoryT0: flag("require-history-t0"),
      });
    });
  } catch (e) {
    console.log(
      `Auth Helius indisponible (${e instanceof HeliusAuthError ? e.message : e}) : job early-buyers ignoré.`,
    );
    process.exit(0);
  }
  console.log(
    `early-buyers : ${res.tokens} tokens (${res.fetched} récupérés), ${res.wallets} wallets récurrents, ` +
      `${res.metricsComputed} métriques calculées, ${res.sellsComputed} ventes analysées, ${res.credits} crédits Helius.` +
      (res.stoppedEarly ? ` ARRÊT PRÉCOCE : ${res.stoppedEarly}.` : ""),
  );
}
