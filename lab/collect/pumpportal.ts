/**
 * Client PumpPortal (wss://pumpportal.fun/api/data) — WebSocket natif de Node 22.
 *
 * Seules les souscriptions GRATUITES sont utilisées :
 *   { "method": "subscribeNewToken" }   → créations de tokens pump.fun
 *   { "method": "subscribeMigration" }  → migrations/graduations vers un DEX
 * (`subscribeTokenTrade` / `subscribeAccountTrade` sont payantes : 0,01 SOL / 10 000 événements — jamais appelées.)
 *
 * Règle PumpPortal : UNE seule connexion pour toutes les souscriptions, sinon bannissement 1 h.
 * Le client maintient donc une connexion unique, se reconnecte avec backoff exponentiel,
 * et écrit chaque événement dans `data/scans/pump-<YYYY-MM-DD>.jsonl`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PumpEvent } from "./types.ts";

export const PUMPPORTAL_URL = "wss://pumpportal.fun/api/data";

/** Sous-ensemble du WebSocket natif utilisé (permet un faux dans les tests). */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", cb: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface PumpPortalOptions {
  url?: string;
  apiKey?: string;
  /** Fabrique de WebSocket (défaut : `globalThis.WebSocket`). */
  createWebSocket?: WebSocketFactory;
  /** Répertoire des scans (`data/scans`) ; `null` = pas d'écriture disque. */
  outDir?: string | null;
  onEvent?: (ev: PumpEvent) => void;
  onStatus?: (status: string) => void;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  reconnect?: { baseMs?: number; maxMs?: number; maxAttempts?: number };
  subscriptions?: Array<"subscribeNewToken" | "subscribeMigration">;
}

export interface PumpPortalClient {
  start(): void;
  stop(): void;
  readonly stats: {
    connections: number;
    reconnects: number;
    events: number;
    creates: number;
    migrations: number;
    ignored: number;
    lastEventAt: string | null;
  };
}

/** Nom de fichier JSONL du jour (UTC). */
export function pumpFileName(nowMs: number): string {
  return `pump-${new Date(nowMs).toISOString().slice(0, 10)}.jsonl`;
}

/**
 * Convertit un message brut PumpPortal en PumpEvent, ou `null` s'il ne s'agit pas
 * d'une création/migration (ex. accusé de réception `{ message: "Successfully subscribed..." }`).
 */
export function parsePumpMessage(raw: unknown, receivedAtMs: number): PumpEvent | null {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else {
    return null;
  }
  const txType = typeof obj.txType === "string" ? obj.txType : null;
  const mint = typeof obj.mint === "string" ? obj.mint : null;
  if (!mint) return null;
  let kind: PumpEvent["kind"] | null = null;
  if (txType === "create") kind = "create";
  else if (txType === "migrate" || txType === "migration") kind = "migrate";
  // Certains messages de migration n'ont pas de txType mais un champ pool "pump-amm"/"raydium".
  else if (txType === null && typeof obj.pool === "string" && obj.pool !== "pump") kind = "migrate";
  if (!kind) return null;
  const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    kind,
    mint,
    signature: strOrNull(obj.signature),
    name: strOrNull(obj.name),
    symbol: strOrNull(obj.symbol),
    traderPublicKey: strOrNull(obj.traderPublicKey),
    solAmount: numOrNull(obj.solAmount),
    marketCapSol: numOrNull(obj.marketCapSol),
    pool: strOrNull(obj.pool),
    receivedAt: new Date(receivedAtMs).toISOString(),
    raw: obj,
  };
}

export function createPumpPortalClient(opts: PumpPortalOptions = {}): PumpPortalClient {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const factory: WebSocketFactory =
    opts.createWebSocket ?? ((url) => new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url));
  const baseUrl = opts.url ?? PUMPPORTAL_URL;
  const url = opts.apiKey ? `${baseUrl}?api-key=${encodeURIComponent(opts.apiKey)}` : baseUrl;
  const baseMs = opts.reconnect?.baseMs ?? 1000;
  const maxMs = opts.reconnect?.maxMs ?? 60_000;
  const maxAttempts = opts.reconnect?.maxAttempts ?? Infinity;
  const subs = opts.subscriptions ?? ["subscribeNewToken", "subscribeMigration"];
  const status = (s: string) => opts.onStatus?.(s);

  const stats: PumpPortalClient["stats"] = {
    connections: 0,
    reconnects: 0,
    events: 0,
    creates: 0,
    migrations: 0,
    ignored: 0,
    lastEventAt: null,
  };
  let ws: WebSocketLike | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: unknown = null;

  if (opts.outDir) mkdirSync(opts.outDir, { recursive: true });

  function persist(ev: PumpEvent) {
    if (!opts.outDir) return;
    appendFileSync(join(opts.outDir, pumpFileName(now())), JSON.stringify(ev) + "\n");
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (attempt >= maxAttempts) {
      status(`abandon après ${attempt} tentatives`);
      return;
    }
    const delay = Math.min(maxMs, baseMs * 2 ** attempt);
    attempt += 1;
    stats.reconnects += 1;
    status(`reconnexion dans ${delay} ms (tentative ${attempt})`);
    timer = setTimer(() => {
      timer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    let socket: WebSocketLike;
    try {
      socket = factory(url);
    } catch (e) {
      status(`erreur création socket: ${(e as Error).message}`);
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.addEventListener("open", () => {
      stats.connections += 1;
      attempt = 0;
      status("connecté");
      for (const method of subs) socket.send(JSON.stringify({ method }));
    });
    socket.addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      const parsed = parsePumpMessage(data, now());
      if (!parsed) {
        stats.ignored += 1;
        return;
      }
      stats.events += 1;
      if (parsed.kind === "create") stats.creates += 1;
      else stats.migrations += 1;
      stats.lastEventAt = parsed.receivedAt;
      persist(parsed);
      opts.onEvent?.(parsed);
    });
    socket.addEventListener("error", () => {
      status("erreur socket");
    });
    socket.addEventListener("close", (ev) => {
      status(`fermé (${ev.code})`);
      if (ws === socket) ws = null;
      scheduleReconnect();
    });
  }

  return {
    stats,
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      const s = ws;
      ws = null;
      if (s && s.readyState <= 1) s.close(1000, "stop");
    },
  };
}
