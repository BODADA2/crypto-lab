/**
 * Classement public des canaux de calls (« Honest Calls ») — mesure ce que les canaux ne montrent pas : les perdants.
 *
 *   npx tsx lab/scoreboard/build.ts [dossier…] [--out site]
 *
 * Lit les calls et les prix collectés par lab/collect/calls.ts (défaut : data-calls et data-channels) et écrit
 * site/index.html (page autonome, données incluses) et site/data.json. Aucune donnée inventée : un call sans prix
 * n'est pas noté, un token qui disparaît des données compte −100 %.
 *
 * Règles de mesure (identiques pour tous les canaux) :
 *   - seuls les calls vus en direct comptent (vus moins de 30 min après publication) ;
 *   - prix de départ = première observation après que le call a été vu (≈ ce qu'un abonné rapide peut obtenir) ;
 *   - « copieur » = achète à ce prix, revend 24 h après, frais de 1,3 % aller-retour ;
 *   - classement : médiane du résultat à 24 h, seulement pour les canaux avec au moins 10 calls notés.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCalls } from "../collect/calls.ts";
import { addressKey, type Call } from "../collect/telegram.ts";

export const LIVE_LAG_MS = 30 * 60_000;
export const DAY_MS = 24 * 3_600_000;
export const VANISH_GAP_MS = 2 * 3_600_000;
export const FEES = 0.013;
export const MIN_JUDGED_FOR_RANK = 10;

export interface Obs {
  t: number;
  p: number;
  l: number;
  /** Ticker vu sur DexScreener, si présent. */
  sym?: string;
}

/** Lit une ligne d'historique, format complet (TokenSnapshot) ou compact ({t,p,l,…}). */
export function parseObs(line: string): Obs | null {
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    const t = Date.parse(String(j.t ?? j.fetchedAt ?? ""));
    const p = Number(j.p ?? j.priceUsd);
    const l = Number(j.l ?? j.liquidityUsd ?? 0);
    if (!Number.isFinite(t) || !Number.isFinite(p)) return null;
    const sym = typeof (j.sym ?? j.symbol) === "string" ? String(j.sym ?? j.symbol) : undefined;
    return sym ? { t, p, l: Number.isFinite(l) ? l : 0, sym } : { t, p, l: Number.isFinite(l) ? l : 0 };
  } catch {
    return null;
  }
}

export function loadObs(dataDir: string): Map<string, Obs[]> {
  const out = new Map<string, Obs[]>();
  const dir = join(dataDir, "history");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const rows = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map(parseObs)
      .filter((o): o is Obs => o !== null)
      .sort((a, b) => a.t - b.t);
    const key = addressKey(f.replace(/\.jsonl$/, ""));
    out.set(key, (out.get(key) ?? []).concat(rows).sort((a, b) => a.t - b.t));
  }
  return out;
}

export type CallStatus = "judged" | "early" | "no-data" | "out-of-scope" | "backlog";

export interface CallResult {
  channel: string;
  symbol: string | null;
  chain: string;
  address: string;
  postedAt: string;
  status: CallStatus;
  /** Prix de départ (1re observation après le call). */
  p0?: number;
  liq0?: number;
  /** Plus haut dans les 24 h, en multiple de p0. */
  maxX?: number;
  /** Variation à 24 h (judged) ou depuis le call (early), fraction. */
  ret?: number;
  vanished?: boolean;
}

/** Mesure un call (fonction pure, testée). */
export function measureCall(c: Call, obs: Obs[], dataEnd: number): CallResult {
  const symbol = c.symbol ?? obs.find((o) => o.sym)?.sym ?? null;
  const base = { channel: c.channel, symbol, chain: c.chain, address: c.address, postedAt: c.postedAt };
  if (c.chain !== "solana" && c.chain !== "robinhood") return { ...base, status: "out-of-scope" };
  const seen = Date.parse(c.seenAt);
  if (seen - Date.parse(c.postedAt) > LIVE_LAG_MS) return { ...base, status: "backlog" };
  const after = obs.filter((o) => o.t >= seen && o.p > 0);
  const first = after[0];
  if (!first) return { ...base, status: "no-data" };
  const window = after.filter((o) => o.t - first.t <= DAY_MS);
  const maxX = Math.max(...window.map((o) => o.p)) / first.p;
  const last = after[after.length - 1] as Obs;
  const at24 = after.find((o) => o.t - first.t >= DAY_MS);
  if (at24) return { ...base, status: "judged", p0: first.p, liq0: first.l, maxX, ret: at24.p / first.p - 1, vanished: false };
  const gone = dataEnd - last.t > VANISH_GAP_MS;
  if (gone && dataEnd - first.t >= DAY_MS) return { ...base, status: "judged", p0: first.p, liq0: first.l, maxX, ret: -1, vanished: true };
  return { ...base, status: "early", p0: first.p, liq0: first.l, maxX, ret: last.p / first.p - 1 };
}

export interface ChannelStats {
  channel: string;
  calls: number;
  live: number;
  judged: number;
  hitX2: number | null;
  halved: number | null;
  median24: number | null;
  copier: number | null;
  best: number | null;
  worst: number | null;
  ranked: boolean;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export function channelStats(channel: string, results: CallResult[]): ChannelStats {
  const mine = results.filter((r) => r.channel === channel);
  const judged = mine.filter((r) => r.status === "judged");
  const rets = judged.map((r) => r.ret as number);
  const n = judged.length;
  return {
    channel,
    calls: mine.length,
    live: mine.filter((r) => r.status === "judged" || r.status === "early").length,
    judged: n,
    hitX2: n ? judged.filter((r) => (r.maxX ?? 0) >= 2).length / n : null,
    halved: n ? judged.filter((r) => (r.ret as number) <= -0.5).length / n : null,
    median24: median(rets),
    copier: n ? rets.reduce((s, r) => s + ((1 + r) * (1 - FEES) - 1), 0) / n : null,
    best: n ? Math.max(...rets) : null,
    worst: n ? Math.min(...rets) : null,
    ranked: n >= MIN_JUDGED_FOR_RANK,
  };
}

export interface Board {
  generatedAt: string;
  dataEnd: string | null;
  channels: ChannelStats[];
  recent: CallResult[];
}

export function buildBoard(dirs: string[], now = Date.now()): Board {
  const calls: Call[] = [];
  const obs = new Map<string, Obs[]>();
  for (const d of dirs) {
    calls.push(...readCalls(join(d, "calls.jsonl")));
    for (const [k, v] of loadObs(d)) obs.set(k, (obs.get(k) ?? []).concat(v).sort((a, b) => a.t - b.t));
  }
  let dataEnd = 0;
  for (const v of obs.values()) {
    const last = v[v.length - 1];
    if (last && last.t > dataEnd) dataEnd = last.t;
  }
  const results = calls.map((c) => measureCall(c, obs.get(addressKey(c.address)) ?? [], dataEnd || now));
  const names = Array.from(new Set(calls.map((c) => c.channel)));
  const channels = names
    .map((n) => channelStats(n, results))
    .sort((a, b) => Number(b.ranked) - Number(a.ranked) || (b.median24 ?? -Infinity) - (a.median24 ?? -Infinity) || b.judged - a.judged);
  const recent = results
    .filter((r) => r.status === "judged" || r.status === "early")
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt))
    .slice(0, 60);
  return { generatedAt: new Date(now).toISOString(), dataEnd: dataEnd ? new Date(dataEnd).toISOString() : null, channels, recent };
}

export function renderHtml(board: Board): string {
  const tpl = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "template.html"), "utf8");
  const json = JSON.stringify(board).replace(/</g, "\\u003c");
  return tpl.replace("/*__BOARD__*/null", json);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let out = resolve("site");
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = resolve(args[++i] as string);
    else dirs.push(args[i] as string);
  }
  const board = buildBoard((dirs.length ? dirs : ["data-calls", "data-channels"]).map((d) => resolve(d)));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "data.json"), JSON.stringify(board, null, 2) + "\n");
  writeFileSync(join(out, "index.html"), renderHtml(board));
  console.log(`Classement : ${board.channels.length} canaux, ${board.recent.length} calls récents → ${out}/index.html`);
}
