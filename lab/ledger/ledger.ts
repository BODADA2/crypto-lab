// Ledger — lecture/écriture JSONL atomique et reconstruction du portefeuille (source de vérité rejouable).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionMode, LedgerEntry, PortfolioState, Position } from "../types.ts";
import { dateKey, isoWeekKey, parseIso } from "../time.ts";
import { emptyPortfolio, equityOf } from "../exec/paper.ts";

const FILLS = new Set(["PAPER", "EXECUTED"]);
const EPS_QTY = 1e-9;

// ---------------------------------------------------------------------------
// E/S JSONL
// ---------------------------------------------------------------------------

/** Lit un fichier JSONL. Fichier absent → []. Ligne malformée → exception (le ledger doit rester intègre). */
export function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const out: T[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (e) {
      throw new Error(`${filePath}:${i + 1} ligne JSONL invalide (${(e as Error).message})`);
    }
  }
  return out;
}

/**
 * Écriture atomique : le contenu complet est écrit dans un fichier temporaire puis renommé
 * (rename est atomique sur un même système de fichiers). Aucune lecture concurrente ne voit un fichier tronqué.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/** Ajoute une ligne JSONL de façon atomique (relecture + réécriture complète + rename). */
export function appendJsonl(filePath: string, entry: unknown): void {
  const line = JSON.stringify(entry);
  if (line.includes("\n")) throw new Error("appendJsonl: une entrée ne doit pas contenir de saut de ligne");
  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) existing += "\n";
  }
  writeFileAtomic(filePath, `${existing}${line}\n`);
}

export function readLedger(filePath: string): LedgerEntry[] {
  return readJsonl<LedgerEntry>(filePath);
}

export function appendLedger(filePath: string, entry: LedgerEntry): void {
  appendJsonl(filePath, entry);
}

// ---------------------------------------------------------------------------
// Reconstruction du portefeuille
// ---------------------------------------------------------------------------

export interface RebuildOptions {
  /** Cash de départ (= capital de trading de la politique). */
  initialCashCad: number;
  /** Ne rejouer que les remplissages de ce mode (paper et live ne se mélangent pas). */
  mode?: ExecutionMode;
  timeZone: string;
  /** Prix courants (USD par mint) pour marquer les positions ouvertes. */
  marksUsd?: Record<string, number>;
  fxCadPerUsd?: number;
}

/** Rejoue les remplissages du ledger dans l'ordre pour reconstruire l'état du portefeuille. */
export function rebuildPortfolio(entries: readonly LedgerEntry[], opts: RebuildOptions): PortfolioState {
  const p = emptyPortfolio(opts.initialCashCad);
  const sorted = [...entries].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  for (const e of sorted) {
    if (!e || !FILLS.has(e.decision) || !e.fill) continue;
    if (opts.mode && e.mode !== opts.mode) continue;
    const at = parseIso(e.ts) ?? new Date(0);
    const f = e.fill;

    if (e.origin === "repo-import") {
      // Ligne copiée du ledger du dépôt (non fiable) : elle ne crée ni cash ni position ; seules ses PERTES comptent.
      if (e.kind === "SELL" && Number.isFinite(e.pnlCad) && (e.pnlCad as number) < 0) {
        const pnl = e.pnlCad as number;
        p.realizedPnlCad += pnl;
        const d = dateKey(at, opts.timeZone);
        const w = isoWeekKey(at, opts.timeZone);
        p.dailyPnlByDate[d] = (p.dailyPnlByDate[d] ?? 0) + pnl;
        p.weeklyPnlByWeek[w] = (p.weeklyPnlByWeek[w] ?? 0) + pnl;
      }
      continue;
    }

    if (e.kind === "BUY") {
      p.cashCad -= f.grossCad;
      const pos = p.positions.find((x) => x.mint === e.mint);
      if (pos) {
        pos.qty += f.qty;
        pos.costCad += f.grossCad;
      } else {
        const np: Position = { mint: e.mint, qty: f.qty, costCad: f.grossCad, openedAt: e.ts };
        p.positions.push(np);
      }
    } else if (e.kind === "SELL") {
      const pos = p.positions.find((x) => x.mint === e.mint);
      p.cashCad += f.netCad;
      const pnl = Number.isFinite(e.pnlCad) ? (e.pnlCad as number) : 0;
      if (pos) {
        const soldQty = Math.min(pos.qty, f.qty);
        const costRemoved = pos.qty > 0 ? pos.costCad * (soldQty / pos.qty) : 0;
        pos.qty -= soldQty;
        pos.costCad -= costRemoved;
        if (pos.qty <= EPS_QTY || pos.qty / (pos.qty + soldQty) < 0.001) {
          p.positions = p.positions.filter((x) => x.mint !== e.mint);
        }
      }
      p.realizedPnlCad += pnl;
      const d = dateKey(at, opts.timeZone);
      const w = isoWeekKey(at, opts.timeZone);
      p.dailyPnlByDate[d] = (p.dailyPnlByDate[d] ?? 0) + pnl;
      p.weeklyPnlByWeek[w] = (p.weeklyPnlByWeek[w] ?? 0) + pnl;
    }

    // Pic d'équité : on utilise l'équité journalisée si présente (marquée au marché), sinon l'équité au coût.
    const eq = Number.isFinite(e.equityAfterCad) ? (e.equityAfterCad as number) : equityOf(p);
    p.peakEquityCad = Math.max(p.peakEquityCad, eq);
  }

  if (opts.marksUsd && opts.fxCadPerUsd) {
    for (const pos of p.positions) {
      const price = opts.marksUsd[pos.mint];
      if (Number.isFinite(price) && (price as number) > 0) {
        pos.lastPriceUsd = price as number;
        pos.markCad = pos.qty * (price as number) * opts.fxCadPerUsd;
      }
    }
    p.peakEquityCad = Math.max(p.peakEquityCad, equityOf(p));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Ledger local chaîné (C2) — ~/.crypto-lab/ledger/trades.jsonl + ~/.crypto-lab/ledger.key
// ---------------------------------------------------------------------------

export class LedgerChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerChainError";
  }
}

const CHAIN_FIELDS = ["seq", "prevHmac", "hmac"] as const;

/** Charge la clé HMAC locale, ou la crée (32 octets aléatoires, mode 600) si absente. */
export function loadOrCreateLedgerKey(keyPath: string): Buffer {
  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, "utf8").trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new LedgerChainError(`${keyPath} : clé invalide (64 caractères hexadécimaux attendus)`);
    return Buffer.from(hex, "hex");
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

function stripChain(entry: LedgerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) if (!(CHAIN_FIELDS as readonly string[]).includes(k)) out[k] = v;
  return out;
}

/** HMAC-SHA256(clé, `seq|prevHmac|json(entrée sans champs de chaîne)`). */
export function computeEntryHmac(key: Buffer, seq: number, prevHmac: string, entry: LedgerEntry): string {
  return crypto.createHmac("sha256", key).update(`${seq}|${prevHmac}|${JSON.stringify(stripChain(entry))}`).digest("hex");
}

/** Lit et VÉRIFIE la chaîne du ledger local. Toute rupture (ligne modifiée, supprimée, insérée, réordonnée) lève. */
export function readChainedLedger(filePath: string, key: Buffer): LedgerEntry[] {
  const entries = readJsonl<LedgerEntry>(filePath);
  let prev = "";
  entries.forEach((e, i) => {
    const seq = i + 1;
    if (e.seq !== seq) throw new LedgerChainError(`${filePath}:${seq} séquence attendue ${seq}, trouvée ${String(e.seq)}`);
    if ((e.prevHmac ?? "") !== prev) throw new LedgerChainError(`${filePath}:${seq} prevHmac ne correspond pas à la ligne précédente`);
    const expected = computeEntryHmac(key, seq, prev, e);
    const given = typeof e.hmac === "string" ? e.hmac : "";
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
      throw new LedgerChainError(`${filePath}:${seq} HMAC invalide (ligne altérée ou clé différente)`);
    }
    prev = given;
  });
  return entries;
}

/** Ajoute une ligne chaînée (relit et vérifie la chaîne avant d'écrire). Renvoie l'entrée telle qu'écrite. */
export function appendChainedLedger(filePath: string, key: Buffer, entry: LedgerEntry): LedgerEntry {
  const existing = readChainedLedger(filePath, key);
  const seq = existing.length + 1;
  const prevHmac = existing.length > 0 ? (existing[existing.length - 1]!.hmac as string) : "";
  const base = stripChain(entry) as unknown as LedgerEntry;
  const hmac = computeEntryHmac(key, seq, prevHmac, base);
  const chained: LedgerEntry = { ...base, seq, prevHmac, hmac };
  appendJsonl(filePath, chained);
  return chained;
}

/** Export en écriture seule vers le dépôt : copie atomique du ledger local (jamais relu par l'exécuteur). */
export function exportLedger(localPath: string, exportPath: string): void {
  const content = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf8") : "";
  writeFileAtomic(exportPath, content);
}

// ---------------------------------------------------------------------------
// Métriques
// ---------------------------------------------------------------------------

export interface DrawdownInfo {
  equityCad: number;
  peakEquityCad: number;
  drawdownCad: number;
  /** En % du pic. */
  drawdownPctOfPeak: number;
}

export function computeDrawdown(p: PortfolioState): DrawdownInfo {
  const equity = equityOf(p);
  const peak = Math.max(p.peakEquityCad, equity);
  const dd = Math.max(0, peak - equity);
  return { equityCad: equity, peakEquityCad: peak, drawdownCad: dd, drawdownPctOfPeak: peak > 0 ? (dd / peak) * 100 : 0 };
}

function pnlBy(entries: readonly LedgerEntry[], keyOf: (d: Date) => string, mode?: ExecutionMode): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    if (!e || !FILLS.has(e.decision) || e.kind !== "SELL" || !Number.isFinite(e.pnlCad)) continue;
    if (mode && e.mode !== mode) continue;
    const at = parseIso(e.ts);
    if (!at) continue;
    const k = keyOf(at);
    out[k] = (out[k] ?? 0) + (e.pnlCad as number);
  }
  return out;
}

export function pnlByDay(entries: readonly LedgerEntry[], timeZone: string, mode?: ExecutionMode): Record<string, number> {
  return pnlBy(entries, (d) => dateKey(d, timeZone), mode);
}

export function pnlByWeek(entries: readonly LedgerEntry[], timeZone: string, mode?: ExecutionMode): Record<string, number> {
  return pnlBy(entries, (d) => isoWeekKey(d, timeZone), mode);
}

/** Intents dont la dernière entrée est PENDING (exécution interrompue) — à clôturer en FAILED. */
export function findOrphanPending(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const last = new Map<string, LedgerEntry>();
  for (const e of entries) if (e && e.intentId) last.set(e.intentId, e);
  return [...last.values()].filter((e) => e.decision === "PENDING");
}
