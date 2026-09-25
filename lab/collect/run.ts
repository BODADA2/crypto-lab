/**
 * Cycle de collecte (GitHub Actions toutes les 15 min, ou à la main) :
 *   npx tsx lab/collect/run.ts            → DexScreener + Reddit + GitHub → data/
 *   npx tsx lab/collect/run.ts pump 600   → PumpPortal pendant 600 s max → data/scans/pump-<date>.jsonl
 *
 * Écrit :
 *   data/scans/<ISO>.json          (ScanResult complet)
 *   data/tokens/<mint>.json        (dernier TokenSnapshot unifié, enrichi on-chain si possible — lisible tel quel par le Risk Engine/exécuteur)
 *   data/mintinfo/<mint>.json      (autorités, top10, extensions Token-2022 ; cache TTL, seulement si RPC disponible)
 *   data/history/<mint>.jsonl      (série de snapshots pour le backtest / signal volume, même type)
 *   data/signals/volume-<ISO>.json (scores du signal volume sur les séries assez longues)
 *   data/narratives/<date>.json    (termes en accélération)
 *   data/meta.json                 (compteurs)
 *
 * Aucun secret de trading ici. Variables optionnelles : GITHUB_TOKEN, PUMPPORTAL_API_KEY, HELIUS_API_KEY (active
 * l'enrichissement on-chain des mints qui passent le pré-filtre liquidité ≥ 20 k$ et âge ≥ 10 min, ≈ 4 crédits/token).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enrichSnapshot } from "./bridge.ts";
import { createDiskCache } from "./cache.ts";
import { createDexScreenerClient, type DexScreenerClient } from "./dexscreener.ts";
import { createGithubClient, type GithubClient } from "./github.ts";
import { createHeliusClient } from "./helius.ts";
import { fetchMintInfo, type JsonRpc, type MintInfo } from "./mintinfo.ts";
import { createPumpPortalClient } from "./pumpportal.ts";
import { createRedditClient, type RedditClient } from "./reddit.ts";
import type { FetchLike, ScanResult, TokenSnapshot } from "./types.ts";
import { readHistoryFile } from "../backtest/harness.ts";
import { computeNarratives, type NarrativeDoc } from "../signals/narrative.ts";
import { rankVolumeSignals } from "../signals/volume.ts";

export interface RunOptions {
  dataDir: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Clients pré-construits (tests). */
  clients?: { dex?: DexScreenerClient; reddit?: RedditClient; github?: GithubClient };
  /** Nombre max de mints DexScreener interrogés par cycle (défaut 300 = 10 requêtes de 30). */
  maxMints?: number;
  /** Nombre max de lignes conservées par fichier d'historique (défaut 2 016 = 7 j à 5 min). */
  historyMaxLines?: number;
  githubToken?: string;
  /** JSON-RPC Solana injectable (Helius) ; absent → pas d'enrichissement on-chain, valeurs conservatrices. */
  rpc?: JsonRpc;
  /** Pré-filtre avant enrichissement (politique de risque). */
  mintInfoMinLiquidityUsd?: number;
  mintInfoMinAgeMin?: number;
  /** Durée de validité d'un mintinfo en cache (défaut 1 h). */
  mintInfoTtlMs?: number;
  /** Nombre max d'enrichissements par cycle (défaut 20 → ≤ 80 crédits/cycle). */
  maxMintInfoPerCycle?: number;
}

/** Pré-filtre : n'enrichir que les tokens que le Risk Engine pourrait accepter. */
export function passesMintInfoPrefilter(snap: TokenSnapshot, nowMs: number, minLiquidityUsd = 20_000, minAgeMin = 10): boolean {
  if (snap.liquidityUsd < minLiquidityUsd) return false;
  if (snap.pairCreatedAt === null) return false;
  return (nowMs - snap.pairCreatedAt) / 60_000 >= minAgeMin;
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function runCollect(opts: RunOptions): Promise<{ scan: ScanResult; scanPath: string; volumeSignals: number; narratives: number; mintInfos: number; rpcCalls: number }> {
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
  const data = opts.dataDir;
  for (const d of ["scans", "tokens", "history", "signals", "narratives", "cache", "mintinfo"]) mkdirSync(join(data, d), { recursive: true });

  const dex = opts.clients?.dex ?? createDexScreenerClient({ fetch: fetchImpl, cache: createDiskCache(join(data, "cache"), now), now });
  const reddit = opts.clients?.reddit ?? createRedditClient({ fetch: fetchImpl });
  const github = opts.clients?.github ?? createGithubClient({ fetch: fetchImpl, now, token: opts.githubToken ?? process.env.GITHUB_TOKEN });

  const startedAt = new Date(now()).toISOString();
  const errors: ScanResult["errors"] = [];
  const scan: ScanResult = {
    startedAt,
    finishedAt: startedAt,
    profiles: [],
    boosts: [],
    tokens: [],
    reddit: [],
    github: [],
    errors,
    requests: { dexscreener: 0, reddit: 0, github: 0 },
  };

  // 1) DexScreener : profils + boosts → mints → snapshots.
  try {
    scan.profiles = await dex.getLatestProfiles("solana");
  } catch (e) {
    errors.push({ source: "dexscreener:profiles", message: (e as Error).message });
  }
  try {
    scan.boosts = await dex.getTopBoosts("solana");
  } catch (e) {
    errors.push({ source: "dexscreener:boosts", message: (e as Error).message });
  }
  // Tokens à observer (amendement 1, 25/09/2026) : nouveaux (boosts/profils), migrés récemment (PumpPortal), puis
  // tokens déjà suivis encore vivants, du plus liquide au moins liquide. Avant : plafond de 60 qui laissait
  // tomber les tokens suivis (séries interrompues) et ignorait les migrations.
  const tracked = existsSync(join(data, "tokens")) ? readTrackedTokens(join(data, "tokens")) : [];
  const mints = selectMintsToPoll({
    fresh: [...scan.boosts.map((b) => b.tokenAddress), ...scan.profiles.map((p) => p.tokenAddress)],
    migrated: loadRecentMigrations(join(data, "scans"), now()),
    tracked,
    now: now(),
    cap: opts.maxMints ?? 300,
  });
  try {
    if (mints.length) scan.tokens = await dex.getSnapshots(mints);
  } catch (e) {
    errors.push({ source: "dexscreener:tokens", message: (e as Error).message });
  }
  scan.requests.dexscreener = dex.requestCount;

  // 2) Reddit.
  const r = await reddit.collect();
  scan.reddit = r.posts;
  errors.push(...r.errors);
  scan.requests.reddit = reddit.requestCount;

  // 3) GitHub.
  const g = await github.collect();
  scan.github = g.repos;
  errors.push(...g.errors);
  scan.requests.github = github.requestCount;

  scan.finishedAt = new Date(now()).toISOString();
  const stamp = scan.finishedAt.replace(/[:.]/g, "-");
  const scanPath = join(data, "scans", `${stamp}.json`);
  writeFileSync(scanPath, JSON.stringify(scan, null, 2) + "\n");

  // 4) Enrichissement on-chain (autorités, top10, extensions) pour les tokens qui passent le pré-filtre.
  const mintInfos = new Map<string, MintInfo>();
  let rpcCalls = 0;
  let enriched = 0;
  const ttl = opts.mintInfoTtlMs ?? 3_600_000;
  const maxEnrich = opts.maxMintInfoPerCycle ?? 20;
  for (const snap of scan.tokens) {
    const cachePath = join(data, "mintinfo", `${safeName(snap.mint)}.json`);
    let cached: MintInfo | null = null;
    if (existsSync(cachePath)) {
      try {
        cached = JSON.parse(readFileSync(cachePath, "utf8")) as MintInfo;
      } catch {
        cached = null;
      }
    }
    const fresh = cached && now() - Date.parse(cached.fetchedAt) < ttl;
    if (fresh && cached) {
      mintInfos.set(snap.mint, cached);
      continue;
    }
    if (!opts.rpc || enriched >= maxEnrich) {
      if (cached) mintInfos.set(snap.mint, cached); // périmé mais mieux que rien : on garde en signalant fetchedAt
      continue;
    }
    if (!passesMintInfoPrefilter(snap, now(), opts.mintInfoMinLiquidityUsd, opts.mintInfoMinAgeMin)) continue;
    try {
      // Exclusions du top 10 : le pool (vault LP) est propriétaire de ses comptes de token.
      const info = await fetchMintInfo(opts.rpc, snap.mint, { excludeOwners: snap.pairAddress ? [snap.pairAddress] : [], now });
      enriched += 1;
      if (!info) continue;
      rpcCalls += info.rpcCalls;
      mintInfos.set(snap.mint, info);
      writeFileSync(cachePath, JSON.stringify(info, null, 2) + "\n");
    } catch (e) {
      errors.push({ source: `mintinfo:${snap.mint}`, message: (e as Error).message });
    }
  }
  // Réécriture du scan : erreurs d'enrichissement incluses.
  writeFileSync(scanPath, JSON.stringify(scan, null, 2) + "\n");

  // 5) Tokens (dernier état, enrichi on-chain si un MintInfo existe) + historique (observation brute).
  const maxLines = opts.historyMaxLines ?? 2016;
  const seriesByMint = new Map<string, TokenSnapshot[]>();
  for (const snap of scan.tokens) {
    const name = safeName(snap.mint);
    writeFileSync(join(data, "tokens", `${name}.json`), JSON.stringify(enrichSnapshot(snap, mintInfos.get(snap.mint) ?? {}), null, 2) + "\n");
    const hist = join(data, "history", `${name}.jsonl`);
    appendFileSync(hist, JSON.stringify(snap) + "\n");
    let series = readHistoryFile(hist);
    if (series.length > maxLines) {
      series = series.slice(-maxLines);
      writeFileSync(hist, series.map((s) => JSON.stringify(s)).join("\n") + "\n");
    }
    seriesByMint.set(snap.mint, series);
  }

  // 6) Signal volume sur les séries.
  const signals = rankVolumeSignals(seriesByMint, { now });
  const computedAt = new Date(now()).toISOString();
  writeFileSync(join(data, "signals", `volume-${stamp}.json`), JSON.stringify({ computedAt, signals }, null, 2) + "\n");

  // 7) Narratifs : documents des 8 derniers jours (scans archivés récents + ce scan).
  const docs: NarrativeDoc[] = [];
  for (const p of scan.reddit) docs.push({ at: p.createdUtc * 1000, text: `${p.title} ${p.selftext}`, source: "reddit" });
  for (const repo of scan.github) docs.push({ at: Date.parse(repo.pushedAt) || now(), text: `${repo.fullName.split("/")[1] ?? ""} ${repo.description ?? ""} ${repo.topics.join(" ")}`, source: "github" });
  for (const tkn of scan.tokens) docs.push({ at: tkn.pairCreatedAt ?? now(), text: `${tkn.name} ${tkn.symbol}`, source: "token" });
  // Archive des documents du cycle (le lecteur dédoublonne via horodatage + source + texte).
  if (docs.length) appendFileSync(join(data, "narratives", "docs.jsonl"), docs.map((d) => JSON.stringify(d)).join("\n") + "\n");
  docs.push(...loadArchivedDocs(join(data, "narratives"), now() - 8 * 86_400_000));
  const terms = computeNarratives(dedupeDocs(docs), { now });
  writeFileSync(join(data, "narratives", `${computedAt.slice(0, 10)}.json`), JSON.stringify({ computedAt, terms }, null, 2) + "\n");

  // 8) Meta (crédits Helius : 1 par appel RPC standard, cumul mensuel partagé avec le job early-buyers).
  const metaPath = join(data, "meta.json");
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>) : {};
  meta.lastCollectAt = scan.finishedAt;
  meta.lastCollectRequests = { ...scan.requests, rpc: rpcCalls };
  if (rpcCalls > 0) {
    const month = scan.finishedAt.slice(0, 7);
    meta.heliusCreditsMonth = (meta.heliusMonth === month ? Number(meta.heliusCreditsMonth ?? 0) : 0) + rpcCalls;
    meta.heliusMonth = month;
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

  return { scan, scanPath, volumeSignals: signals.length, narratives: terms.length, mintInfos: mintInfos.size, rpcCalls };
}

export interface TrackedToken {
  mint: string;
  liquidityUsd: number;
  /** Epoch ms du dernier snapshot connu. */
  lastSeen: number;
}

/** Liquidité sous laquelle un token suivi est considéré mort (plus observé). */
export const DEAD_LIQUIDITY_USD = 5_000;
/** Au-delà, un token suivi n'est plus observé (borne la taille de la liste). */
export const TRACK_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Fenêtre des migrations PumpPortal ajoutées à la liste d'observation. */
export const MIGRATION_WINDOW_MS = 48 * 3_600_000;

/**
 * Liste des mints à interroger ce cycle, sans doublon, plafonnée : nouveaux d'abord, puis migrés récents, puis suivis
 * vivants (liquidité ≥ 5 k$, vus depuis ≤ 7 j) du plus liquide au moins liquide. Fonction pure (testée).
 */
export function selectMintsToPoll(p: { fresh: string[]; migrated: string[]; tracked: TrackedToken[]; now: number; cap: number }): string[] {
  const alive = p.tracked
    .filter((t) => t.liquidityUsd >= DEAD_LIQUIDITY_USD && p.now - t.lastSeen <= TRACK_MAX_AGE_MS)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    .map((t) => t.mint);
  const dead = new Set(p.tracked.filter((t) => t.liquidityUsd < DEAD_LIQUIDITY_USD).map((t) => t.mint));
  const migrated = p.migrated.filter((m) => !dead.has(m));
  return Array.from(new Set([...p.fresh, ...migrated, ...alive])).slice(0, p.cap);
}

/** Dernier snapshot de chaque token suivi (data/tokens/<mint>.json). */
function readTrackedTokens(tokensDir: string): TrackedToken[] {
  const out: TrackedToken[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(tokensDir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(tokensDir, f), "utf8")) as { mint?: string; liquidityUsd?: number; fetchedAt?: string };
      const lastSeen = s.fetchedAt ? Date.parse(s.fetchedAt) : NaN;
      out.push({ mint: s.mint ?? f.replace(/\.json$/, ""), liquidityUsd: Number(s.liquidityUsd) || 0, lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0 });
    } catch {
      /* fichier illisible : ignoré */
    }
  }
  return out;
}

/** Mints migrés (PumpPortal, kind = "migrate") depuis moins de 48 h, lus dans les fichiers pump-<date>.jsonl récents. */
export function loadRecentMigrations(scansDir: string, nowMs: number, windowMs = MIGRATION_WINDOW_MS): string[] {
  if (!existsSync(scansDir)) return [];
  const since = nowMs - windowMs;
  const days = new Set<string>();
  for (let t = since; t <= nowMs + 86_400_000; t += 86_400_000) days.add(new Date(t).toISOString().slice(0, 10));
  const seen = new Map<string, number>();
  for (const day of days) {
    const f = join(scansDir, `pump-${day}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { kind?: string; mint?: string; receivedAt?: string };
        const ts = ev.receivedAt ? Date.parse(ev.receivedAt) : NaN;
        if (ev.kind === "migrate" && ev.mint && ts >= since && ts <= nowMs) seen.set(ev.mint, Math.max(seen.get(ev.mint) ?? 0, ts));
      } catch {
        /* ligne corrompue ignorée */
      }
    }
  }
  // Les plus récentes d'abord.
  return Array.from(seen.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);
}

function loadArchivedDocs(dir: string, sinceMs: number): NarrativeDoc[] {
  const p = join(dir, "docs.jsonl");
  if (!existsSync(p)) return [];
  const out: NarrativeDoc[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as NarrativeDoc;
      if (d.at >= sinceMs) out.push({ ...d, source: d.source });
    } catch {
      /* ignorée */
    }
  }
  return out;
}

function dedupeDocs(docs: NarrativeDoc[]): NarrativeDoc[] {
  const seen = new Set<string>();
  const out: NarrativeDoc[] = [];
  for (const d of docs) {
    const k = `${d.at}|${d.source}|${d.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

/** Job PumpPortal borné dans le temps (job GitHub Actions séparé, 10 min max). */
export async function runPump(opts: { dataDir: string; durationMs: number; apiKey?: string; now?: () => number }): Promise<{ events: number; file: string }> {
  const now = opts.now ?? (() => Date.now());
  const outDir = join(opts.dataDir, "scans");
  const client = createPumpPortalClient({ outDir, apiKey: opts.apiKey, now, onStatus: (s) => console.error(`[pumpportal] ${s}`) });
  client.start();
  await new Promise<void>((r) => setTimeout(r, opts.durationMs));
  client.stop();
  const metaPath = join(opts.dataDir, "meta.json");
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>) : {};
  meta.lastPumpRun = new Date(now()).toISOString();
  meta.pumpEvents = client.stats.events;
  mkdirSync(opts.dataDir, { recursive: true });
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { events: client.stats.events, file: join(outDir, `pump-${new Date(now()).toISOString().slice(0, 10)}.jsonl`) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dataDir = resolve(process.env.DATA_DIR ?? "data");
  const mode = process.argv[2] ?? "collect";
  if (mode === "pump") {
    const seconds = Number(process.argv[3] ?? 300);
    // Plafond relevé à 600 s (amendement 1) : dépôt public = minutes Actions illimitées.
    const res = await runPump({ dataDir, durationMs: Math.min(seconds, 600) * 1000, apiKey: process.env.PUMPPORTAL_API_KEY });
    console.log(`PumpPortal : ${res.events} événements → ${res.file}`);
  } else {
    const apiKey = process.env.HELIUS_API_KEY;
    const rpc = apiKey ? createHeliusClient({ fetch: globalThis.fetch, apiKey }).rpc : undefined;
    const res = await runCollect({ dataDir, rpc });
    console.log(
      `Scan ${res.scanPath} : ${res.scan.tokens.length} tokens, ${res.mintInfos} enrichis on-chain (${res.rpcCalls} appels RPC), ${res.scan.reddit.length} posts, ${res.scan.github.length} dépôts, ${res.scan.errors.length} erreurs, ${res.volumeSignals} signaux, ${res.narratives} termes.`,
    );
    if (res.scan.errors.length) console.error(JSON.stringify(res.scan.errors, null, 2));
  }
}
