/**
 * Suivi non biaisé dès le create — protocole docs/unbiased-tracking-spec-2026-09-28.md
 * (relecture critique §6 : VALIDÉE AVEC AJUSTEMENTS, appliqués ici).
 *
 * Principe : échantillon aléatoire déterministe (5 %) des creates GENUINE (flag
 * late-discovery appliqué), snapshots DexScreener denses, stockage séparé dans
 * `data/track-unbiased/<UTC-date>/<mint>.jsonl` — JAMAIS mélangé à `data/history/`.
 *
 * Garde-fous :
 * - AUCUN websocket PumpPortal (règle "une seule connexion", bannissement 1 h) : le
 *   tracker consomme les fichiers `data/scans/pump-*.jsonl` via un worktree git détaché
 *   (sparse-checkout `data/scans`) + `git fetch` périodique en lecture seule.
 * - AUCUNE décision de trading, AUCUNE écriture hors `data/track-unbiased/`.
 * - Ne touche ni au collecteur, ni au cron quotidien, ni au paper-engine.
 * - Verrou PID : deux instances ne tournent jamais en même temps.
 * - Reprise idempotente : manifests rechargés, pas de double échantillonnage,
 *   `nextDue` dérivé du dernier snapshot.
 *
 * Usage :
 *   npx tsx lab/collect/track-unbiased.ts --duration-min 13   # borné (cron)
 *   npx tsx lab/collect/track-unbiased.ts --once              # une passe (test)
 *   npx tsx lab/collect/track-unbiased.ts                     # boucle infinie
 *
 * Env : TRACK_DATA_DIR (défaut <repo>/data/track-unbiased),
 *       TRACK_SCAN_DIR (défaut <repo>/../scan-mirror/data/scans),
 *       TRACK_MIRROR_ROOT (défaut <repo>/../scan-mirror ; --no-git-sync pour désactiver).
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDexScreenerClient, type DexScreenerClient } from "./dexscreener.ts";
import { lateDiscoveryOf } from "./lateDiscovery.ts";
import type { FetchLike, TokenSnapshot } from "./types.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paramètres du protocole (spec §2, ajustements §6)
// ---------------------------------------------------------------------------

/** Probabilité d'inclusion dans l'échantillon. */
export const SAMPLE_P = 0.05;
/**
 * Plafond de tokens suivis simultanément (F8).
 *
 * Calibrage empirique (bootstrap 2026-09-28) : ~21 000 creates/jour observés
 * (contre ~13 700/jour sur la fenêtre d'audit) → 5 % ≈ 1 050/jour → ~525 tokens
 * concurrents en fenêtre pré-migration (12 h) + ~30 en post-migration.
 * Le cap initial de 200 (spec §2.4) était déjà insuffisant avec les hypothèses
 * de la spec (325 concurrents) et a été saturé dès le bootstrap (417 refusés).
 * 800 donne ~50 % de marge ; coût API estimé < 6 req/min (limiteur : 60/min).
 */
export const MAX_ACTIVE_TOKENS = 800;
/** Pré-migration : 1 snapshot / 5 min pendant 12 h. */
export const PRE_INTERVAL_MS = 5 * 60_000;
export const PRE_WINDOW_MS = 12 * 3_600_000;
/** Post-migration : 1 / 2 min pendant 60 min, puis 1 / 15 min pendant 48 h. */
export const POST_FAST_INTERVAL_MS = 2 * 60_000;
export const POST_FAST_WINDOW_MS = 60 * 60_000;
export const POST_SLOW_INTERVAL_MS = 15 * 60_000;
export const POST_SLOW_WINDOW_MS = 48 * 3_600_000;
/** Tick interne de la boucle. */
export const TICK_MS = 30_000;
/** Intervalle entre deux `git fetch` du miroir de scans. */
export const GIT_SYNC_EVERY_MS = 3 * 60_000;
/** dexId de la paire pump.fun pré-migration (cf. snipe.ts:pickSolPair). */
const PREFILTER_DEXIDS = new Set(["pumpfun"]);

// ---------------------------------------------------------------------------
// Fonctions pures (testées)
// ---------------------------------------------------------------------------

/** Date UTC `YYYY-MM-DD` (les scans sont en UTC — F5/F11). */
export function utcDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Inclusion déterministe dans l'échantillon : `sha256("track-unbiased:"+dateUTC+":"+mint)`.
 * Reproductible et idempotente au redémarrage (F5). Le seed est la date UTC DU CREATE.
 */
export function sampledFor(seedDate: string, mint: string, p: number = SAMPLE_P): boolean {
  const h = createHash("sha256").update(`track-unbiased:${seedDate}:${mint}`).digest();
  return h.readUInt32BE(0) < p * 0xffffffff;
}

export type TrackPhase = "pre" | "post-fast" | "post-slow" | "done";

/** Phase de suivi d'un token à l'instant `nowMs` (machine à états pure, testée). */
export function trackPhase(args: { receivedAtMs: number; migratedAtMs: number | null; nowMs: number }): TrackPhase {
  const { receivedAtMs, migratedAtMs, nowMs } = args;
  if (migratedAtMs !== null && Number.isFinite(migratedAtMs)) {
    const e = nowMs - migratedAtMs;
    if (e > POST_SLOW_WINDOW_MS) return "done";
    return e <= POST_FAST_WINDOW_MS ? "post-fast" : "post-slow";
  }
  return nowMs - receivedAtMs > PRE_WINDOW_MS ? "done" : "pre";
}

/** Intervalle de snapshot pour une phase (`null` = terminé). */
export function intervalForPhase(phase: TrackPhase): number | null {
  switch (phase) {
    case "pre":
      return PRE_INTERVAL_MS;
    case "post-fast":
      return POST_FAST_INTERVAL_MS;
    case "post-slow":
      return POST_SLOW_INTERVAL_MS;
    case "done":
      return null;
  }
}

/**
 * Migration détectée via snapshot : la paire la plus liquide n'est plus la paire
 * pump.fun (F6). `null`/absent = pas d'information → pas de bascule.
 */
export function isMigratedDex(dexId: string | null | undefined): boolean {
  return typeof dexId === "string" && dexId.length > 0 && !PREFILTER_DEXIDS.has(dexId);
}

/** Admission au suivi (F8 : au-delà du cap, les nouveaux sont refusés, pas les en-cours tronqués). */
export function admitToSample(activeCount: number, maxActive: number = MAX_ACTIVE_TOKENS): boolean {
  return activeCount < maxActive;
}

// ---------------------------------------------------------------------------
// Manifestes
// ---------------------------------------------------------------------------

export type EntryStatus = "pre" | "post" | "done" | "dropped";

export interface TrackedEntry {
  mint: string;
  symbol: string | null;
  /** Date UTC du create = seed d'échantillonnage (F11). */
  seedDate: string;
  /** Heure du create selon le flux (peut précéder la découverte de ~10-15 min — F13). */
  receivedAt: string;
  /** Heure de première vue par CE tracker (entrée exécutable honnête ≥ discoveredAt). */
  discoveredAt: string;
  status: EntryStatus;
  migratedAt: string | null;
  migrationSource: "event" | "dex" | null;
  lastSnapshotAt: string | null;
  snapshots: number;
  dropReason?: string;
}

export interface DayManifest {
  version: 1;
  seedDate: string;
  p: number;
  startedAt: string;
  updatedAt: string;
  tracked: Record<string, TrackedEntry>;
  dropped: Array<{ mint: string; at: string; reason: string }>;
  counters: { createsSeen: number; lateDiscoverySeen: number; sampled: number; snapshots: number; migratesSeen: number; expiredSeen: number };
}

export interface TrackerState {
  scanOffsets: Record<string, number>;
  lastGitSyncAt: number | null;
}

function emptyManifest(seedDate: string, nowIso: string): DayManifest {
  return {
    version: 1,
    seedDate,
    p: SAMPLE_P,
    startedAt: nowIso,
    updatedAt: nowIso,
    tracked: {},
    dropped: [],
    counters: { createsSeen: 0, lateDiscoverySeen: 0, sampled: 0, snapshots: 0, migratesSeen: 0, expiredSeen: 0 },
  };
}

function manifestPath(dataDir: string, seedDate: string): string {
  return join(dataDir, seedDate, "manifest.json");
}

function readManifest(dataDir: string, seedDate: string): DayManifest | null {
  const p = manifestPath(dataDir, seedDate);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as DayManifest;
    if (m.version !== 1 || typeof m.tracked !== "object") return null;
    return m;
  } catch {
    return null;
  }
}

/** Écriture atomique (tmp + rename). */
function writeManifest(dataDir: string, m: DayManifest): void {
  const dir = join(dataDir, m.seedDate);
  mkdirSync(dir, { recursive: true });
  const p = manifestPath(dataDir, m.seedDate);
  const tmp = p + ".tmp";
  m.updatedAt = new Date().toISOString();
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  renameSync(tmp, p);
}

function readState(dataDir: string): TrackerState {
  const p = join(dataDir, "state.json");
  if (!existsSync(p)) return { scanOffsets: {}, lastGitSyncAt: null };
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as TrackerState;
    return { scanOffsets: s.scanOffsets ?? {}, lastGitSyncAt: s.lastGitSyncAt ?? null };
  } catch {
    return { scanOffsets: {}, lastGitSyncAt: null };
  }
}

function writeState(dataDir: string, s: TrackerState): void {
  mkdirSync(dataDir, { recursive: true });
  const p = join(dataDir, "state.json");
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Verrou PID (F4 : jamais deux instances)
// ---------------------------------------------------------------------------

function lockPath(dataDir: string): string {
  return join(dataDir, ".lock");
}

function acquireLock(dataDir: string): boolean {
  mkdirSync(dataDir, { recursive: true });
  const p = lockPath(dataDir);
  if (existsSync(p)) {
    const pid = Number(readFileSync(p, "utf8").trim());
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false; // processus vivant → une autre instance tourne
      } catch {
        /* PID mort : verrou périmé, on le reprend */
      }
    }
  }
  writeFileSync(p, String(process.pid) + "\n");
  return true;
}

function releaseLock(dataDir: string): void {
  try {
    const p = lockPath(dataDir);
    if (existsSync(p) && readFileSync(p, "utf8").trim() === String(process.pid)) unlinkSync(p);
  } catch {
    /* mieux vaut un verrou périmé qu'un crash */
  }
}

// ---------------------------------------------------------------------------
// Ingestion des événements (scan files du worktree miroir)
// ---------------------------------------------------------------------------

export interface IngestStats {
  createsSeen: number;
  lateDiscoverySeen: number;
  sampled: number;
  droppedCap: number;
  migratesSeen: number;
  expiredSeen: number;
}

interface IngestCtx {
  manifests: Map<string, DayManifest>;
  knownMints: Set<string>;
  state: TrackerState;
  nowMs: number;
}

function getManifest(ctx: IngestCtx, dataDir: string, seedDate: string): DayManifest {
  let m = ctx.manifests.get(seedDate);
  if (!m) {
    m = readManifest(dataDir, seedDate) ?? emptyManifest(seedDate, new Date(ctx.nowMs).toISOString());
    ctx.manifests.set(seedDate, m);
  }
  return m;
}

function activeCount(ctx: IngestCtx): number {
  let n = 0;
  for (const m of ctx.manifests.values()) for (const e of Object.values(m.tracked)) if (e.status === "pre" || e.status === "post") n++;
  return n;
}

function findEntry(ctx: IngestCtx, mint: string): { manifest: DayManifest; entry: TrackedEntry } | null {
  for (const manifest of ctx.manifests.values()) {
    const entry = manifest.tracked[mint];
    if (entry) return { manifest, entry };
  }
  return null;
}

/**
 * Lit les nouvelles lignes des `pump-*.jsonl` depuis les offsets mémorisés.
 * Purge-safe : si un fichier a rétréci, on repart de 0.
 */
export function ingestScanFiles(opts: {
  scanDir: string;
  dataDir: string;
  ctx: IngestCtx;
}): IngestStats {
  const { scanDir, dataDir, ctx } = opts;
  const stats: IngestStats = { createsSeen: 0, lateDiscoverySeen: 0, sampled: 0, droppedCap: 0, migratesSeen: 0, expiredSeen: 0 };
  let files: string[] = [];
  try {
    files = readdirSync(scanDir)
      .filter((f) => /^pump-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch {
    return stats;
  }
  const nowIso = new Date(ctx.nowMs).toISOString();
  for (const f of files) {
    const fp = join(scanDir, f);
    let size = 0;
    try {
      size = statSync(fp).size;
    } catch {
      continue;
    }
    let off = ctx.state.scanOffsets[f] ?? 0;
    if (off > size) off = 0; // fichier remplacé (reset --hard) → relire depuis le début
    if (off >= size) continue;
    let chunk: Buffer;
    try {
      const fd = openSync(fp, "r");
      chunk = Buffer.alloc(size - off);
      readSync(fd, chunk, 0, chunk.length, off);
      closeSync(fd);
    } catch {
      continue;
    }
    ctx.state.scanOffsets[f] = size;
    for (const line of chunk.toString("utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      const kind = ev.kind as string | undefined;
      const mint = ev.mint as string | undefined;
      if (!mint || (kind !== "create" && kind !== "migrate")) continue;
      if (kind === "create") {
        if (ctx.knownMints.has(mint)) continue; // dédupliqué par mint (F17)
        ctx.knownMints.add(mint);
        const receivedAt = typeof ev.receivedAt === "string" ? ev.receivedAt : nowIso;
        const seedDate = utcDateOf(Date.parse(receivedAt) || ctx.nowMs); // seed = date UTC DU CREATE (F11)
        const m = getManifest(ctx, dataDir, seedDate);
        m.counters.createsSeen++;
        stats.createsSeen++;
        if (lateDiscoveryOf(ev as { kind?: unknown; raw?: unknown; lateDiscovery?: unknown })) {
          m.counters.lateDiscoverySeen++;
          stats.lateDiscoverySeen++;
          continue; // jamais échantillonné (spec §2.1)
        }
        const receivedMs = Date.parse(receivedAt);
        // Garde-fou bootstrap : un create dont la fenêtre de 12 h est déjà écoulée à la
        // première observation ne peut pas être "suivi dès le create" — il n'entre pas
        // dans la base d'échantillonnage (compteur pour audit, les scans restent la source).
        if (Number.isFinite(receivedMs) && ctx.nowMs - receivedMs > PRE_WINDOW_MS) {
          m.counters.expiredSeen++;
          stats.expiredSeen++;
          continue;
        }
        if (!sampledFor(seedDate, mint)) continue;
        if (!admitToSample(activeCount(ctx))) {
          m.dropped.push({ mint, at: nowIso, reason: "cap-200" });
          stats.droppedCap++;
          continue;
        }
        m.tracked[mint] = {
          mint,
          symbol: typeof ev.symbol === "string" ? ev.symbol : null,
          seedDate,
          receivedAt,
          discoveredAt: nowIso,
          status: "pre",
          migratedAt: null,
          migrationSource: null,
          lastSnapshotAt: null,
          snapshots: 0,
        };
        m.counters.sampled++;
        stats.sampled++;
      } else {
        // migrate → bascule de cadence (mécanisme (a), F6)
        const found = findEntry(ctx, mint);
        if (found && found.entry.status === "pre") {
          found.entry.status = "post";
          found.entry.migratedAt = typeof ev.receivedAt === "string" ? ev.receivedAt : nowIso;
          found.entry.migrationSource = "event";
          found.manifest.counters.migratesSeen++;
          stats.migratesSeen++;
        }
      }
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Snapshots DexScreener
// ---------------------------------------------------------------------------

interface DueEntry {
  manifest: DayManifest;
  entry: TrackedEntry;
}

function dueEntries(ctx: IngestCtx): DueEntry[] {
  const out: DueEntry[] = [];
  for (const manifest of ctx.manifests.values()) {
    for (const entry of Object.values(manifest.tracked)) {
      if (entry.status !== "pre" && entry.status !== "post") continue;
      const receivedMs = Date.parse(entry.receivedAt);
      const migratedMs = entry.migratedAt ? Date.parse(entry.migratedAt) : null;
      const phase = trackPhase({ receivedAtMs: receivedMs, migratedAtMs: migratedMs, nowMs: ctx.nowMs });
      if (phase === "done") {
        entry.status = "done";
        continue;
      }
      const interval = intervalForPhase(phase) as number;
      const lastMs = entry.lastSnapshotAt ? Date.parse(entry.lastSnapshotAt) : 0;
      if (ctx.nowMs - lastMs >= interval) out.push({ manifest, entry });
    }
  }
  return out;
}

export interface SnapshotStats {
  due: number;
  written: number;
  migratedByDex: number;
  errors: number;
}

/** Source minimale de snapshots (le client DexScreener réel la satisfait). */
export interface SnapshotProvider {
  getSnapshots(mints: string[]): Promise<TokenSnapshot[]>;
}

/**
 * Snapshots dus via DexScreener (batch). Les erreurs sont non fatales (F18) :
 * réessayées au prochain tick.
 */
export async function snapshotDueEntries(opts: {
  dex: SnapshotProvider;
  dataDir: string;
  ctx: IngestCtx;
}): Promise<SnapshotStats> {
  const { dex, dataDir, ctx } = opts;
  const stats: SnapshotStats = { due: 0, written: 0, migratedByDex: 0, errors: 0 };
  const due = dueEntries(ctx);
  stats.due = due.length;
  if (!due.length) return stats;
  const mints = due.map((d) => d.entry.mint);
  let snaps: TokenSnapshot[];
  try {
    snaps = await dex.getSnapshots(mints);
  } catch {
    stats.errors++;
    return stats; // réessayé au prochain tick
  }
  const byMint = new Map(snaps.map((s) => [s.mint, s]));
  const nowIso = new Date(ctx.nowMs).toISOString();
  for (const { manifest, entry } of due) {
    const snap = byMint.get(entry.mint);
    if (!snap) {
      // Token absent de DexScreener : on avance quand même l'horloge pour réessayer au prochain intervalle.
      entry.lastSnapshotAt = nowIso;
      continue;
    }
    // Bascule de cadence via le snapshot lui-même (mécanisme (b), F6).
    if (entry.status === "pre" && isMigratedDex(snap.dexId)) {
      entry.status = "post";
      entry.migratedAt = snap.fetchedAt;
      entry.migrationSource = "dex";
      manifest.counters.migratesSeen++;
      stats.migratedByDex++;
    }
    const dir = join(dataDir, entry.seedDate);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ...snap,
      tracker: {
        seedDate: entry.seedDate,
        receivedAt: entry.receivedAt,
        discoveredAt: entry.discoveredAt,
        migratedAt: entry.migratedAt,
        migrationSource: entry.migrationSource,
      },
    });
    try {
      appendFileSync(join(dir, `${entry.mint}.jsonl`), line + "\n");
    } catch {
      stats.errors++;
      continue;
    }
    entry.lastSnapshotAt = snap.fetchedAt;
    entry.snapshots++;
    manifest.counters.snapshots++;
    stats.written++;
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Sync git du miroir (lecture seule — F3)
// ---------------------------------------------------------------------------

async function gitSync(mirrorRoot: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", mirrorRoot, "fetch", "origin"], { timeout: 60_000 });
  } catch {
    return false;
  }
  try {
    await execFileAsync("git", ["-C", mirrorRoot, "reset", "--hard", "origin/main"], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Boucle principale
// ---------------------------------------------------------------------------

export interface TrackerOptions {
  dataDir: string;
  scanDir: string;
  mirrorRoot: string | null;
  gitSync: boolean;
  durationMin?: number;
  once?: boolean;
  fetch?: FetchLike;
  now?: () => number;
  dex?: SnapshotProvider;
  log?: (msg: string) => void;
}

function loadAllManifests(dataDir: string): Map<string, DayManifest> {
  const out = new Map<string, DayManifest>();
  let days: string[] = [];
  try {
    days = readdirSync(dataDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    return out;
  }
  for (const d of days) {
    const m = readManifest(dataDir, d);
    if (m) out.set(d, m);
  }
  return out;
}

export async function runTracker(opts: TrackerOptions): Promise<{ snapshots: number; sampled: number }> {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((m: string) => console.error(`[track-unbiased] ${m}`));
  const dataDir = opts.dataDir;
  if (!acquireLock(dataDir)) {
    log("une autre instance tourne déjà — arrêt sans rien faire");
    return { snapshots: 0, sampled: 0 };
  }
  let stop = false;
  const onSig = () => {
    stop = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  const dex = opts.dex ?? createDexScreenerClient({ fetch: opts.fetch ?? (globalThis.fetch as FetchLike), now });
  const manifests = loadAllManifests(dataDir);
  const knownMints = new Set<string>();
  for (const m of manifests.values()) {
    for (const mint of Object.keys(m.tracked)) knownMints.add(mint);
    for (const d of m.dropped) knownMints.add(d.mint);
  }
  const state = readState(dataDir);
  const ctx: IngestCtx = { manifests, knownMints, state, nowMs: now() };
  const endAt = opts.durationMin ? now() + opts.durationMin * 60_000 : Number.POSITIVE_INFINITY;
  let totalSnapshots = 0;
  let totalSampled = 0;
  try {
    // Sync initiale (non fatale).
    if (opts.gitSync && opts.mirrorRoot) {
      ctx.nowMs = now();
      if (await gitSync(opts.mirrorRoot)) {
        state.lastGitSyncAt = ctx.nowMs;
        log("miroir git synchronisé");
      } else {
        log("git sync échouée — on continue avec les données locales");
      }
    }
    for (;;) {
      if (stop) break;
      ctx.nowMs = now();
      if (opts.gitSync && opts.mirrorRoot && ctx.nowMs - (state.lastGitSyncAt ?? 0) >= GIT_SYNC_EVERY_MS) {
        if (await gitSync(opts.mirrorRoot)) state.lastGitSyncAt = ctx.nowMs;
        else log("git sync échouée — on continue");
      }
      const ing = ingestScanFiles({ scanDir: opts.scanDir, dataDir, ctx });
      totalSampled += ing.sampled;
      if (ing.sampled || ing.migratesSeen || ing.droppedCap) {
        log(`ingest: +${ing.sampled} échantillonnés, +${ing.migratesSeen} migrés, ${ing.droppedCap} refusés (cap), ${ing.lateDiscoverySeen} late-discovery ignorés`);
      }
      const snap = await snapshotDueEntries({ dex, dataDir, ctx });
      totalSnapshots += snap.written;
      if (snap.due) log(`snapshots: ${snap.written}/${snap.due} écrits, ${snap.migratedByDex} migrations détectées (dex)`);
      for (const m of manifests.values()) writeManifest(dataDir, m);
      writeState(dataDir, state);
      if (opts.once || stop) break;
      const waitMs = Math.min(TICK_MS, endAt - now());
      if (waitMs <= 0 || now() >= endAt) break;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  } finally {
    for (const m of manifests.values()) {
      try {
        writeManifest(dataDir, m);
      } catch {
        /* au moins on a essayé */
      }
    }
    try {
      writeState(dataDir, state);
    } catch {
      /* idem */
    }
    releaseLock(dataDir);
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
  log(`fin : ${totalSampled} échantillonnés, ${totalSnapshots} snapshots`);
  return { snapshots: totalSnapshots, sampled: totalSampled };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { durationMin?: number; once?: boolean; gitSync: boolean } {
  const out: { durationMin?: number; once?: boolean; gitSync: boolean } = { gitSync: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--duration-min" && i + 1 < argv.length) out.durationMin = Number(argv[++i]);
    else if (argv[i] === "--once") out.once = true;
    else if (argv[i] === "--no-git-sync") out.gitSync = false;
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // …/repo
  const dataDir = resolve(process.env.TRACK_DATA_DIR ?? join(repoRoot, "data", "track-unbiased"));
  const mirrorRoot = process.env.TRACK_MIRROR_ROOT ?? join(dirname(repoRoot), "scan-mirror");
  const scanDir = resolve(process.env.TRACK_SCAN_DIR ?? join(mirrorRoot, "data", "scans"));
  if (args.durationMin !== undefined && !(args.durationMin > 0)) {
    console.error("--duration-min doit être > 0");
    process.exit(2);
  }
  await runTracker({
    dataDir,
    scanDir,
    mirrorRoot: existsSync(mirrorRoot) ? mirrorRoot : null,
    gitSync: args.gitSync,
    durationMin: args.durationMin,
    once: args.once,
  });
}
