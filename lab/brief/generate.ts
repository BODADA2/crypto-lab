/**
 * Génère `briefs/YYYY-MM-DD.md` à partir de `data/`, `ledger/`, `journal/`.
 *
 * Règles :
 *  - 9 sections fixes : MARKET / NARRATIVES / ON-CHAIN / OPPORTUNITIES / DEV / TRADING / RISKS / AUTOMATION / UNKNOWN ;
 *  - chaque affirmation chiffrée cite le fichier source (chemin relatif au dépôt) ;
 *  - section sans donnée → « aucune donnée » ; rien n'est inventé ;
 *  - aucune recommandation d'ordre : le brief informe, les intents sont produits ailleurs.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanResult } from "../collect/types.ts";
import type { TokenSnapshot } from "../types.ts";
import type { VolumeSignal } from "../signals/volume.ts";
import type { WalletProfile } from "../signals/earlybuyers.ts";
import type { TermStat } from "../signals/narrative.ts";

export interface BriefOptions {
  /** Racine du dépôt (contient data/, ledger/, journal/, briefs/). */
  rootDir: string;
  now?: () => number;
  /** Date du brief (YYYY-MM-DD) ; défaut = date UTC de `now`. */
  date?: string;
  /** Fenêtre « récente » en heures (défaut 24). */
  windowHours?: number;
}

export interface BriefResult {
  date: string;
  path: string;
  markdown: string;
  sections: Record<SectionName, string[]>;
}

export const SECTIONS = ["MARKET", "NARRATIVES", "ON-CHAIN", "OPPORTUNITIES", "DEV", "TRADING", "RISKS", "AUTOMATION", "UNKNOWN"] as const;
export type SectionName = (typeof SECTIONS)[number];
export const NO_DATA = "aucune donnée";

interface LedgerLine {
  intentId?: string;
  decision?: "EXECUTED" | "REJECTED" | "PAPER";
  reasons?: string[];
  mint?: string;
  pnl?: number;
  fees?: number;
  createdAt?: string;
  at?: string;
  timestamp?: string;
}

interface JournalLine {
  id?: string;
  createdAt?: string;
  hypothesis?: string;
  signal?: string;
  decision?: string;
  result?: string;
  error?: string;
  return?: number;
}

// ---------------------------------------------------------------------------
// Lecture tolérante des fichiers
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      /* ignorée */
    }
  }
  return out;
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => join(dir, f));
}

function latest(files: string[]): string | null {
  return files.length ? (files[files.length - 1] as string) : null;
}

const fmtUsd = (v: number | null | undefined) =>
  v === null || v === undefined ? "n/a" : v >= 1000 ? `${Math.round(v).toLocaleString("fr-CA")} $` : `${v.toFixed(2)} $`;
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)} %`);

function lineTime(l: LedgerLine | JournalLine): number {
  const s = (l as LedgerLine).createdAt ?? (l as LedgerLine).at ?? (l as LedgerLine).timestamp;
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// ---------------------------------------------------------------------------
// Génération
// ---------------------------------------------------------------------------

export function generateBrief(opts: BriefOptions): BriefResult {
  const now = opts.now ?? (() => Date.now());
  const t = now();
  const date = opts.date ?? new Date(t).toISOString().slice(0, 10);
  const windowMs = (opts.windowHours ?? 24) * 3_600_000;
  const root = opts.rootDir;
  const rel = (p: string) => relative(root, p).split("\\").join("/");
  const sections = Object.fromEntries(SECTIONS.map((s) => [s, [] as string[]])) as unknown as Record<SectionName, string[]>;
  const unknown: string[] = [];

  // --- Dernier scan -------------------------------------------------------
  const scanFiles = listFiles(join(root, "data", "scans"), ".json");
  const scanPath = latest(scanFiles);
  const scan = scanPath ? readJson<ScanResult>(scanPath) : null;
  const scanAge = scan ? (t - Date.parse(scan.finishedAt)) / 3_600_000 : null;

  // MARKET
  if (scan && scanPath && scan.tokens.length) {
    const src = rel(scanPath);
    const tokens = [...scan.tokens].sort((a, b) => b.volume.h24 - a.volume.h24);
    const totalVol = tokens.reduce((s, x) => s + x.volume.h24, 0);
    const liqOk = tokens.filter((x) => x.liquidityUsd >= 20_000).length;
    sections.MARKET.push(
      `${tokens.length} tokens suivis au dernier scan, volume 24 h cumulé ${fmtUsd(totalVol)} ; ${liqOk} avec liquidité ≥ 20 000 $ (source : ${src}).`,
    );
    for (const x of tokens.slice(0, 5)) {
      sections.MARKET.push(
        `- ${x.symbol || x.mint.slice(0, 6)} (${x.mint}) : prix ${x.priceUsd > 0 ? x.priceUsd : "n/a"} $, vol 24 h ${fmtUsd(x.volume.h24)}, liq ${fmtUsd(x.liquidityUsd)}, Δ24 h ${x.priceChange.h24.toFixed(1)} % (source : ${src}).`,
      );
    }
    if (scan.boosts.length) {
      const b = [...scan.boosts].sort((a, c) => c.totalAmount - a.totalAmount)[0]!;
      sections.MARKET.push(`${scan.boosts.length} tokens boostés DexScreener ; max ${b.totalAmount} boosts pour ${b.tokenAddress} (source : ${src}).`);
    }
  } else {
    unknown.push("Aucun scan DexScreener exploitable dans data/scans/ (MARKET vide).");
  }

  // NARRATIVES
  const narrFiles = listFiles(join(root, "data", "narratives"), ".json");
  const narrPath = latest(narrFiles);
  const narr = narrPath ? readJson<{ computedAt: string; terms: TermStat[] }>(narrPath) : null;
  if (narr && narrPath && narr.terms.length) {
    sections.NARRATIVES.push(`Top termes en accélération (24 h vs 7 j) au ${narr.computedAt} (source : ${rel(narrPath)}) :`);
    for (const term of narr.terms.slice(0, 10)) {
      const srcs = Object.entries(term.sources)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
      sections.NARRATIVES.push(`- « ${term.term} » : ${term.count24h} mentions / 24 h dans ${term.docs24h} documents, base ${term.baselinePerDay.toFixed(1)}/j, croissance x${term.growth.toFixed(1)} (${srcs}).`);
    }
  } else {
    unknown.push("Pas de fichier data/narratives/*.json : NARRATIVES vide (X/Twitter non collecté, API payante).");
  }

  // ON-CHAIN : PumpPortal + wallets
  const pumpFiles = listFiles(join(root, "data", "scans"), ".jsonl").filter((f) => f.includes("pump-"));
  const pumpPath = latest(pumpFiles);
  if (pumpPath) {
    const events = readJsonl<{ kind: string; mint: string; receivedAt: string; symbol?: string | null }>(pumpPath);
    const recent = events.filter((e) => t - Date.parse(e.receivedAt) <= windowMs);
    const creates = recent.filter((e) => e.kind === "create").length;
    const migrations = recent.filter((e) => e.kind === "migrate");
    sections["ON-CHAIN"].push(
      `pump.fun (fenêtre ${opts.windowHours ?? 24} h, ${events.length} événements dans le fichier) : ${creates} créations, ${migrations.length} migrations (source : ${rel(pumpPath)}).`,
    );
    if (creates > 0) {
      sections["ON-CHAIN"].push(`Taux de migration observé sur la fenêtre : ${pct(migrations.length / creates)} (référence historique < 2 %, docs/research-2026-09-24.md §C).`);
    }
    for (const m of migrations.slice(-5)) sections["ON-CHAIN"].push(`- migration ${m.symbol ?? ""} ${m.mint} à ${m.receivedAt} (source : ${rel(pumpPath)}).`);
  }
  const walletFiles = listFiles(join(root, "data", "wallets"), ".json");
  if (walletFiles.length) {
    const profiles = walletFiles.map((p) => ({ p, w: readJson<WalletProfile>(p) })).filter((x): x is { p: string; w: WalletProfile } => !!x.w);
    profiles.sort((a, b) => b.w.score - a.w.score);
    sections["ON-CHAIN"].push(`${profiles.length} wallets « early-buyer » récurrents suivis (source : data/wallets/).`);
    for (const { p, w } of profiles.slice(0, 5)) {
      sections["ON-CHAIN"].push(`- ${w.address} : présent dans ${w.recurrence}/${w.universe} tokens migrés, rang moyen ${w.avgRank.toFixed(1)}, score ${w.score} (source : ${rel(p)}).`);
    }
  }
  if (!sections["ON-CHAIN"].length) unknown.push("Ni flux PumpPortal (data/scans/pump-*.jsonl) ni profils de wallets (data/wallets/) : ON-CHAIN vide.");

  // OPPORTUNITIES : signaux de volume
  const sigFiles = listFiles(join(root, "data", "signals"), ".json").filter((f) => f.includes("volume-"));
  const sigPath = latest(sigFiles);
  const sig = sigPath ? readJson<{ computedAt: string; signals: VolumeSignal[] }>(sigPath) : null;
  if (sig && sigPath) {
    const eligible = sig.signals.filter((s) => s.eligible && s.score >= 40);
    if (eligible.length) {
      sections.OPPORTUNITIES.push(`${eligible.length} tokens avec signal volume ≥ 40 au ${sig.computedAt} (source : ${rel(sigPath)}). Ce sont des candidats à analyser, pas des ordres.`);
      for (const s of eligible.slice(0, 5)) {
        sections.OPPORTUNITIES.push(`- ${s.mint} : score ${s.score} — ${s.reasons.join(" ; ")} (source : ${rel(sigPath)}).`);
      }
    } else {
      sections.OPPORTUNITIES.push(`Aucun token n'atteint le score 40 sur ${sig.signals.length} évalués (source : ${rel(sigPath)}).`);
    }
  } else {
    unknown.push("Pas de fichier data/signals/volume-*.json : OPPORTUNITIES vide (historique < 12 fenêtres ou collecte non lancée).");
  }

  // DEV : GitHub
  if (scan && scanPath && scan.github.length) {
    const src = rel(scanPath);
    const repos = [...scan.github].sort((a, b) => b.stars - a.stars);
    sections.DEV.push(`${repos.length} dépôts GitHub « solana » récents/actifs (source : ${src}).`);
    for (const r of repos.slice(0, 5)) sections.DEV.push(`- ${r.fullName} : ${r.stars} ★, ${r.language ?? "langage n/a"}${r.description ? ` — ${r.description.slice(0, 100)}` : ""} (source : ${src}).`);
  } else {
    unknown.push("Pas de dépôts GitHub dans le dernier scan : DEV vide.");
  }

  // TRADING : ledger
  const ledgerPath = join(root, "ledger", "trades.jsonl");
  const ledger = readJsonl<LedgerLine>(ledgerPath);
  if (ledger.length) {
    const src = rel(ledgerPath);
    const recent = ledger.filter((l) => t - lineTime(l) <= windowMs);
    const count = (d: LedgerLine["decision"], arr: LedgerLine[]) => arr.filter((l) => l.decision === d).length;
    sections.TRADING.push(
      `Ledger : ${ledger.length} lignes au total, ${recent.length} sur ${opts.windowHours ?? 24} h — exécutés ${count("EXECUTED", recent)}, paper ${count("PAPER", recent)}, rejetés ${count("REJECTED", recent)} (source : ${src}).`,
    );
    const withPnl = ledger.filter((l) => typeof l.pnl === "number");
    if (withPnl.length) {
      const total = withPnl.reduce((s, l) => s + (l.pnl as number), 0);
      const recentPnl = recent.filter((l) => typeof l.pnl === "number").reduce((s, l) => s + (l.pnl as number), 0);
      sections.TRADING.push(`PnL cumulé ${total.toFixed(2)} $ sur ${withPnl.length} trades clos ; PnL ${opts.windowHours ?? 24} h ${recentPnl.toFixed(2)} $ (source : ${src}).`);
    } else {
      sections.TRADING.push(`Aucun PnL réalisé enregistré (source : ${src}).`);
    }
  } else {
    sections.TRADING.push(`${NO_DATA} (ledger/trades.jsonl absent ou vide).`);
  }

  // RISKS
  const killRoot = existsSync(join(root, "KILL"));
  if (killRoot) sections.RISKS.push("Fichier KILL présent à la racine : toute exécution est arrêtée (source : KILL).");
  if (ledger.length) {
    const rejected = ledger.filter((l) => l.decision === "REJECTED" && t - lineTime(l) <= windowMs);
    const reasons = new Map<string, number>();
    for (const r of rejected) for (const reason of r.reasons ?? []) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (rejected.length) {
      const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v})`).join(", ");
      sections.RISKS.push(`${rejected.length} intents rejetés par le Risk Engine sur ${opts.windowHours ?? 24} h : ${top || "sans motif"} (source : ${rel(ledgerPath)}).`);
    }
    const withPnl = ledger.filter((l) => typeof l.pnl === "number").sort((a, b) => lineTime(a) - lineTime(b));
    if (withPnl.length) {
      let eq = 0;
      let peak = 0;
      let dd = 0;
      for (const l of withPnl) {
        eq += l.pnl as number;
        peak = Math.max(peak, eq);
        dd = Math.max(dd, peak - eq);
      }
      sections.RISKS.push(`Drawdown max depuis le pic (PnL réalisé) : ${dd.toFixed(2)} $ ; limite politique 35 % de 700 $ = 245 $ (source : ${rel(ledgerPath)}, ARCHITECTURE.md).`);
    }
  }
  if (scanAge !== null && scanAge > 1) sections.RISKS.push(`Données de marché âgées de ${scanAge.toFixed(1)} h : ne pas agir sur ce brief sans rafraîchir (source : ${rel(scanPath as string)}).`);
  if (scan?.errors.length) sections.RISKS.push(`${scan.errors.length} erreurs de collecte au dernier scan : ${scan.errors.map((e) => e.source).join(", ")} (source : ${rel(scanPath as string)}).`);
  if (!sections.RISKS.length) sections.RISKS.push(`${NO_DATA} (aucun ledger, aucun KILL, aucune erreur de collecte connue).`);

  // AUTOMATION
  if (scan && scanPath) {
    sections.AUTOMATION.push(
      `Dernier cycle de collecte : ${scan.startedAt} → ${scan.finishedAt} ; requêtes DexScreener ${scan.requests.dexscreener}, Reddit ${scan.requests.reddit}, GitHub ${scan.requests.github} ; ${scan.errors.length} erreurs ; ${scanFiles.length} scans archivés (source : ${rel(scanPath)}).`,
    );
  }
  const metaPath = join(root, "data", "meta.json");
  const meta = existsSync(metaPath) ? readJson<{ heliusCreditsMonth?: number; lastPumpRun?: string; pumpEvents?: number }>(metaPath) : null;
  if (meta) {
    if (typeof meta.heliusCreditsMonth === "number") sections.AUTOMATION.push(`Crédits Helius consommés ce mois : ${meta.heliusCreditsMonth} / 1 000 000 (source : ${rel(metaPath)}).`);
    if (meta.lastPumpRun) sections.AUTOMATION.push(`Dernier job PumpPortal : ${meta.lastPumpRun}, ${meta.pumpEvents ?? 0} événements (source : ${rel(metaPath)}).`);
  }
  if (!sections.AUTOMATION.length) sections.AUTOMATION.push(`${NO_DATA} (aucun scan ni data/meta.json).`);

  // Journal → UNKNOWN (hypothèses ouvertes)
  const journalPath = join(root, "journal", "hypotheses.jsonl");
  const journal = readJsonl<JournalLine>(journalPath);
  const open = journal.filter((h) => !h.result && !h.error);
  if (open.length) unknown.push(`${open.length} hypothèses sans résultat dans le journal : ${open.slice(0, 5).map((h) => h.id ?? h.hypothesis?.slice(0, 40) ?? "?").join(", ")} (source : ${rel(journalPath)}).`);
  unknown.push("Non collecté (source payante ou fermée) : X/Twitter (pay-per-use), Dune (lecture seule depuis le 10/09/2026), flux de trades PumpPortal (0,01 SOL / 10 000 événements) — docs/research-2026-09-24.md.");
  sections.UNKNOWN.push(...unknown);

  // --- Rendu Markdown ------------------------------------------------------
  const lines: string[] = [`# Brief du ${date}`, "", `Généré le ${new Date(t).toISOString()} par lab/brief/generate.ts. Chaque chiffre cite son fichier source ; « ${NO_DATA} » signifie que rien n'a été collecté, jamais estimé.`, ""];
  for (const name of SECTIONS) {
    lines.push(`## ${name}`, "");
    const body = sections[name];
    if (body.length === 0) lines.push(NO_DATA);
    else lines.push(...body);
    lines.push("");
  }
  const markdown = lines.join("\n");
  return { date, path: join(root, "briefs", `${date}.md`), markdown, sections };
}

export function writeBrief(opts: BriefOptions): BriefResult {
  const r = generateBrief(opts);
  mkdirSync(join(opts.rootDir, "briefs"), { recursive: true });
  writeFileSync(r.path, r.markdown);
  return r;
}

// Exécution directe : `npx tsx lab/brief/generate.ts [racine]`
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const r = writeBrief({ rootDir });
  console.log(`Brief écrit : ${r.path}`);
}
