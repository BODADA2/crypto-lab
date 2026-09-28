/**
 * Ledger du moteur paper (§3, §4). Append-only : les décisions s'ouvrent, puis une
 * clôture est ajoutée. Jamais de réécriture destructrice. Les fichiers vivent sous
 * data/paper-engine/ (données du moteur, pas du collecteur).
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE } from "./config.ts";
import type {
  ClosedPaperDecision,
  DecisionClose,
  PaperDecision,
  PerformanceMetrics,
} from "./types.ts";

export const LEDGER_DIR = join("data", "paper-engine");
export const DECISIONS_FILE = join(LEDGER_DIR, "decisions.jsonl");
export const CHANGELOG_FILE = join(LEDGER_DIR, "CHANGELOG.md");

type LedgerRecord =
  | { type: "open"; decision: PaperDecision }
  | { type: "close"; close: DecisionClose }
  | { type: "cancel"; decisionId: string; at: string; reason: string };

export function ensureLedgerDir(rootDir: string): void {
  const dir = join(rootDir, LEDGER_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cl = join(rootDir, CHANGELOG_FILE);
  if (!existsSync(cl)) {
    writeFileSync(
      cl,
      "# Changelog du moteur paper\n\nToute modification de paramètre ou de seuil est tracée ici\n(preuve n≥30, données séparées — §5 du cahier des charges).\n",
    );
  }
}

function appendRecord(rootDir: string, rec: LedgerRecord): void {
  ensureLedgerDir(rootDir);
  appendFileSync(join(rootDir, DECISIONS_FILE), JSON.stringify(rec) + "\n");
}

export function openDecision(rootDir: string, d: PaperDecision): void {
  appendRecord(rootDir, { type: "open", decision: d });
}

export function closeDecision(rootDir: string, c: DecisionClose): void {
  appendRecord(rootDir, { type: "close", close: c });
}

export function cancelDecision(rootDir: string, decisionId: string, reason: string, at?: string): void {
  appendRecord(rootDir, {
    decisionId,
    at: at ?? new Date().toISOString(),
    reason,
    type: "cancel",
  });
}

/** Prochain ID de décision (PE-0001, PE-0002, …). */
export function nextDecisionId(rootDir: string): string {
  const path = join(rootDir, DECISIONS_FILE);
  if (!existsSync(path)) return "PE-0001";
  let max = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as LedgerRecord;
      if (rec.type === "open") {
        const m = /^PE-(\d+)$/.exec(rec.decision.id);
        if (m && m[1]) max = Math.max(max, parseInt(m[1], 10));
      }
    } catch {
      /* ligne ignorée */
    }
  }
  return `PE-${String(max + 1).padStart(4, "0")}`;
}

/** Reconstruit l'état : décisions ouvertes, clôturées, annulées. */
export function loadLedger(rootDir: string): {
  decisions: PaperDecision[];
  closed: ClosedPaperDecision[];
} {
  const decisions = new Map<string, PaperDecision>();
  const closes = new Map<string, DecisionClose>();
  const path = join(rootDir, DECISIONS_FILE);
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as LedgerRecord;
        if (rec.type === "open") decisions.set(rec.decision.id, rec.decision);
        else if (rec.type === "close") closes.set(rec.close.decisionId, rec.close);
        else if (rec.type === "cancel") {
          const d = decisions.get(rec.decisionId);
          if (d) d.status = "cancelled";
        }
      } catch {
        /* ligne ignorée */
      }
    }
  }
  const closed: ClosedPaperDecision[] = [];
  for (const d of decisions.values()) {
    const c = closes.get(d.id);
    if (c && d.kind === "trade") {
      d.status = "closed";
      closed.push({ ...d, close: c });
    }
  }
  return { decisions: [...decisions.values()], closed };
}

/** Equity après chaque clôture (ordre chronologique), en partant du capital virtuel. */
export function equityCurve(rootDir: string): Array<{ at: string; equity: number; decisionId: string }> {
  const { closed } = loadLedger(rootDir);
  const sorted = [...closed].sort((a, b) => a.close.closedAt.localeCompare(b.close.closedAt));
  let equity: number = ENGINE.virtualCapitalUsd;
  const curve = [{ at: "", equity, decisionId: "START" }];
  for (const d of sorted) {
    const size = d.sizeUsd ?? 0;
    equity += (size * d.close.resultPct) / 100;
    curve.push({ at: d.close.closedAt, equity, decisionId: d.id });
  }
  return curve;
}

/** Drawdown courant (pic → maintenant), en %. */
export function currentDrawdownPct(rootDir: string): number {
  const curve = equityCurve(rootDir);
  let peak = curve[0]?.equity ?? ENGINE.virtualCapitalUsd;
  let dd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    dd = Math.max(dd, ((peak - p.equity) / peak) * 100);
  }
  return dd;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const hi = s[m] ?? 0;
  const lo = s[m - 1] ?? hi;
  return s.length % 2 ? hi : (lo + hi) / 2;
};

function bucketStats(ds: ClosedPaperDecision[]): { trades: number; winRate: number | null; averageR: number | null } {
  const rs = ds.map((d) => d.close.resultR);
  const wins = rs.filter((r) => r > 0).length;
  return {
    trades: ds.length,
    winRate: ds.length ? wins / ds.length : null,
    averageR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
  };
}

function mcapBucket(d: ClosedPaperDecision): string {
  const mc = d.marketCapUsdAtEntry;
  if (mc === null || mc === undefined || mc <= 0) return "inconnu";
  if (mc < 300_000) return "< 300 k$";
  if (mc < 1_000_000) return "300 k$ – 1 M$";
  if (mc < 5_000_000) return "1 M$ – 5 M$";
  return "≥ 5 M$";
}

/** Métriques de performance §4 sur les décisions clôturées. */
export function computeMetrics(rootDir: string): PerformanceMetrics {
  const { closed } = loadLedger(rootDir);
  const empty: PerformanceMetrics = {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    averageWinPct: null,
    averageLossPct: null,
    profitFactor: null,
    expectancyPct: null,
    maxDrawdownPct: currentDrawdownPct(rootDir),
    averageR: null,
    medianR: null,
    bySetup: {},
    byMarketCap: {},
    byChain: {},
    byRegime: {},
  };
  if (!closed.length) return empty;
  const wins = closed.filter((d) => d.close.resultR > 0);
  const losses = closed.filter((d) => d.close.resultR <= 0);
  const winPcts = wins.map((d) => d.close.resultPct);
  const lossPcts = losses.map((d) => d.close.resultPct);
  const grossWin = winPcts.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossPcts.reduce((a, b) => a + b, 0));
  const rs = closed.map((d) => d.close.resultR);
  const group = (key: (d: ClosedPaperDecision) => string): Record<string, { trades: number; winRate: number | null; averageR: number | null }> => {
    const m = new Map<string, ClosedPaperDecision[]>();
    for (const d of closed) {
      const k = key(d);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(d);
    }
    return Object.fromEntries([...m.entries()].map(([k, v]) => [k, bucketStats(v)]));
  };
  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    averageWinPct: winPcts.length ? grossWin / winPcts.length : null,
    averageLossPct: lossPcts.length ? grossLoss / lossPcts.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : winPcts.length ? Infinity : null,
    expectancyPct:
      closed.length ? closed.reduce((a, d) => a + d.close.resultPct, 0) / closed.length : null,
    maxDrawdownPct: currentDrawdownPct(rootDir),
    averageR: rs.reduce((a, b) => a + b, 0) / rs.length,
    medianR: median(rs),
    bySetup: group((d) => d.setup),
    byMarketCap: group(mcapBucket),
    byChain: group((d) => d.token.chain),
    byRegime: group((d) => d.marketRegime),
  };
}

/** Nombre de décisions clôturées depuis le dernier bloc d'apprentissage traité. */
export function unlearnedCloses(rootDir: string): ClosedPaperDecision[] {
  const { closed } = loadLedger(rootDir);
  const clPath = join(rootDir, CHANGELOG_FILE);
  const cl = existsSync(clPath) ? readFileSync(clPath, "utf8") : "";
  const m = /<!-- learned-through: ([^ ]+) -->/.exec(cl);
  const through = m ? m[1] : null;
  const sorted = [...closed].sort((a, b) => a.close.closedAt.localeCompare(b.close.closedAt));
  if (!through) return sorted;
  const idx = sorted.findIndex((d) => d.id === through);
  return idx < 0 ? sorted : sorted.slice(idx + 1);
}

export function markLearnedThrough(rootDir: string, decisionId: string): void {
  const clPath = join(rootDir, CHANGELOG_FILE);
  let cl = existsSync(clPath) ? readFileSync(clPath, "utf8") : "";
  cl = cl.replace(/<!-- learned-through: [^ ]+ -->\n?/, "");
  writeFileSync(cl, `<!-- learned-through: ${decisionId} -->\n` + cl);
}

/** Trace un ajustement de paramètre (§5 : chaque modification est tracée). */
export function logAdjustment(
  rootDir: string,
  entry: { date: string; parameter: string; before: string; after: string; evidence: string; validation: string },
): void {
  const clPath = join(rootDir, CHANGELOG_FILE);
  const cur = existsSync(clPath) ? readFileSync(clPath, "utf8") : "";
  const block = `\n## ${entry.date} — ${entry.parameter}\n\n- Avant : ${entry.before}\n- Après : ${entry.after}\n- Preuve : ${entry.evidence}\n- Validation (données séparées) : ${entry.validation}\n`;
  writeFileSync(clPath, cur.replace(/<!-- learned-through:[^>]*-->\n?/, "") + block);
  // restaure le marqueur en tête
  const m = /<!-- learned-through: [^ ]+ -->/.exec(cur);
  if (m) {
    const updated = readFileSync(clPath, "utf8");
    writeFileSync(clPath, m[0] + "\n" + updated);
  }
}
