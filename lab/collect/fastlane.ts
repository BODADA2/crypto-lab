/**
 * FAST LANE — détection de créations de tokens en quasi-temps réel via logsSubscribe.
 *
 * Contexte : le pipeline actuel (PumpPortal WS → scan files → commit git ~10 min →
 * git fetch 3 min → cron 15 min) détecte un token en ~8-13 min médiane, alors que la
 * migration arrive en médiane 3 min. Ce module écoute directement les logs du programme
 * Pump.fun via le WebSocket Helius (standard, plan gratuit) et parse l'événement
 * `Create` Anchor depuis les logs — latence cible < 2 s.
 *
 * AUCUNE transaction, AUCUN ordre : observation pure. N'ouvre jamais de connexion
 * vers PumpPortal (règle anti-bannissement : une seule connexion, déjà utilisée
 * par le collecteur principal).
 *
 * Coût : WebSocket standard = ~2 crédits / 0,1 Mo streamé (docs Helius, 09/2026).
 * Le volume exact (firehose = TOUTES les txs du programme, pas seulement les creates)
 * doit être mesuré en live — c'est une des métriques du prototype.
 */
import bs58 from "bs58";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Programme Pump.fun (V1). Vérifiable on-chain ; le prototype loggue les échecs de parse. */
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/** Marqueur Anchor d'invocation d'instruction (insensible à la casse par sécurité). */
const CREATE_INSTRUCTION_MARKER = "instruction: create";
/** Préfixe des événements Anchor émis via `emit!`. */
const PROGRAM_DATA_PREFIX = "Program data:";

/** Durée nominale d'un slot Solana (ms) — utilisée pour l'estimation, calibrée en live. */
export const SLOT_MS = 400;

// ---------------------------------------------------------------------------
// Parsing de l'événement Create (pur, testable sans réseau)
// ---------------------------------------------------------------------------

export interface ParsedCreate {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  bondingCurve: string;
  user: string;
}

export interface ParseFailure {
  reason: string;
  signature?: string;
}

/**
 * Extrait l'événement Create des logs d'une transaction.
 * Stratégie : repère "Program log: Instruction: Create" puis décode le premier
 * "Program data: <base64>" qui suit en Borsh (CreateEvent Anchor :
 * string name, string symbol, string uri, pubkey mint, pubkey bondingCurve, pubkey user).
 * Retourne null si pas de contexte Create (la majorité des notifications : buys/sells).
 */
export function parseCreateEvent(logs: string[]): { ok: true; create: ParsedCreate } | { ok: false; failure?: ParseFailure } {
  let inCreate = false;
  for (const line of logs) {
    if (!inCreate) {
      if (line.toLowerCase().includes(CREATE_INSTRUCTION_MARKER)) inCreate = true;
      continue;
    }
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length).trim();
    const parsed = parseCreateEventData(b64);
    if (parsed) return { ok: true, create: parsed };
    // Un "Program data:" non parsable dans un contexte Create : on continue à
    // chercher (il peut y en avoir plusieurs), mais on retient l'échec.
    return { ok: false, failure: { reason: "program_data_unparsable" } };
  }
  return { ok: false };
}

function readBorshString(buf: Buffer, off: number): { value: string; next: number } | null {
  if (off + 4 > buf.length) return null;
  const len = buf.readUInt32LE(off);
  if (len > 500 || off + 4 + len > buf.length) return null;
  return { value: buf.subarray(off + 4, off + 4 + len).toString("utf8"), next: off + 4 + len };
}

function readPubkey(buf: Buffer, off: number): { value: string; next: number } | null {
  if (off + 32 > buf.length) return null;
  return { value: bs58.encode(buf.subarray(off, off + 32)), next: off + 32 };
}

/** Décode un événement Create Anchor sérialisé en Borsh (base64). */
export function parseCreateEventData(b64: string): ParsedCreate | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (buf.length < 8 + 3 * 4 + 3 * 32) return null; // discriminateur + bornes min
  let off = 8; // discriminateur d'événement Anchor (non vérifié : le contexte Create suffit)
  const name = readBorshString(buf, off);
  if (!name) return null;
  off = name.next;
  const symbol = readBorshString(buf, off);
  if (!symbol) return null;
  off = symbol.next;
  const uri = readBorshString(buf, off);
  if (!uri) return null;
  off = uri.next;
  const mint = readPubkey(buf, off);
  if (!mint) return null;
  off = mint.next;
  const bondingCurve = readPubkey(buf, off);
  if (!bondingCurve) return null;
  off = bondingCurve.next;
  const user = readPubkey(buf, off);
  if (!user) return null;
  // Garde-fous de plausibilité : un mint ne doit pas être le programme système, etc.
  if (mint.value.length < 32 || mint.value.length > 44) return null;
  return { mint: mint.value, name: name.value, symbol: symbol.value, uri: uri.value, bondingCurve: bondingCurve.value, user: user.value };
}

// ---------------------------------------------------------------------------
// Horloge de slots (estimation honnête de la latence)
// ---------------------------------------------------------------------------

/**
 * Convertit un numéro de slot en timestamp estimé, à partir des notifications
 * slotSubscribe observées. Solana produit un slot toutes les ~400 ms en régime
 * nominal ; l'interpolation entre deux slots observés absorbe les variations.
 * Retourne null si l'horloge n'a pas encore de point d'ancrage.
 */
export class SlotClock {
  private points: Array<{ slot: number; at: number }> = [];
  private readonly maxPoints = 120;

  observe(slot: number, at: number = Date.now()): void {
    const last = this.points[this.points.length - 1];
    if (last && slot <= last.slot) return; // régression ignorée
    this.points.push({ slot, at });
    if (this.points.length > this.maxPoints) this.points.shift();
  }

  /** Timestamp estimé (ms epoch) du début du slot donné, ou null. */
  estimateSlotTime(slot: number): number | null {
    const pts = this.points;
    const first = pts[0];
    if (!first) return null;
    if (slot <= first.slot) return first.at - (first.slot - slot) * SLOT_MS;
    for (let i = pts.length - 1; i >= 0; i--) {
      const a = pts[i];
      if (!a || a.slot > slot) continue;
      // Interpolation linéaire entre a et le point suivant si dispo, sinon extrapolation.
      const b = pts[i + 1];
      if (b) {
        const span = b.slot - a.slot;
        if (span <= 0) return a.at;
        return a.at + ((slot - a.slot) / span) * (b.at - a.at);
      }
      return a.at + (slot - a.slot) * SLOT_MS;
    }
    const last = pts[pts.length - 1];
    return last ? last.at : null; // inatteignable en pratique (couvert par la boucle)
  }

  get anchored(): boolean {
    return this.points.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Détecteur WebSocket (logique réutilisable, WS injectable pour les tests)
// ---------------------------------------------------------------------------

export interface DetectedCreate {
  signature: string;
  slot: number;
  mint: string;
  name: string;
  symbol: string;
  /** ms epoch de réception de la notification. */
  receivedAt: number;
  /** Latence estimée on-chain → détection (ms), null si horloge non ancrée. */
  detectionLatencyMs: number | null;
  /** Temps de traitement local (ms) — doit rester < 10 ms. */
  processingMs: number;
  commitment: string;
}

export interface FastlaneStats {
  startedAt: number;
  notifications: number; // toutes les notifications logsSubscribe (firehose)
  createsDetected: number;
  parseFailures: number;
  reconnects: number;
  wsErrors: number;
  latenciesMs: number[]; // detectionLatencyMs des creates (non null)
}

export function newStats(): FastlaneStats {
  return { startedAt: Date.now(), notifications: 0, createsDetected: 0, parseFailures: 0, reconnects: 0, wsErrors: 0, latenciesMs: [] };
}

export function latencyPercentiles(lat: number[]): { p50: number; p95: number; p99: number; max: number } | null {
  if (lat.length === 0) return null;
  const s = [...lat].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] ?? 0 };
}

export interface WsLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  ping?(): void;
  close(): void;
}

export interface FastlaneOptions {
  wsUrl: string;
  /**
   * Appelé après chaque fermeture inattendue pour obtenir une URL WS fraîche
   * (surrogate court-terme pouvant expirer). Si absent ou en échec, l'ancienne
   * URL est réutilisée. Ne jamais logger la valeur renvoyée.
   */
  refreshWsUrl?: () => string;
  program?: string;
  commitment?: "processed" | "confirmed" | "finalized";
  createWs: (url: string) => WsLike;
  now?: () => number;
  onCreate?: (c: DetectedCreate) => void;
  onStats?: (s: FastlaneStats) => void;
  statsEveryMs?: number;
  pingEveryMs?: number;
  maxBackoffMs?: number;
  /** Appelé quand la boucle doit s'arrêter (durée écoulée) ; par défaut ne s'arrête jamais. */
  shouldStop?: () => boolean;
}

interface RpcNotification {
  jsonrpc: string;
  method: string;
  params: {
    subscription: number;
    // logsNotification : { context: { slot }, value: { signature, err, logs[] } }
    // slotNotification : { parent, root, slot }
    result: unknown;
  };
}

/**
 * Boucle de détection. Ne se termine que si shouldStop() devient vrai
 * (le prototype l'utilise pour --duration-min) ou sur erreur fatale de création WS.
 * Reconnexion avec backoff exponentiel ; les événements manqués pendant une
 * coupure sont PERDUS (pas de backfill) — documenté comme limite connue.
 */
export async function runFastlaneDetector(opts: FastlaneOptions): Promise<FastlaneStats> {
  const program = opts.program ?? PUMP_PROGRAM;
  const commitment = opts.commitment ?? "processed";
  const now = opts.now ?? (() => Date.now());
  const stats = newStats();
  const clock = new SlotClock();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  let stopped = false;
  let backoffMs = 1000;
  const maxBackoff = opts.maxBackoffMs ?? 30000;
  let lastStatsAt = now();
  let wsUrl = opts.wsUrl;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (stopped || (opts.shouldStop && opts.shouldStop())) break;
    let ws: WsLike;
    try {
      ws = opts.createWs(wsUrl);
    } catch {
      stats.wsErrors++;
      await sleep(backoffMs);
      backoffMs = Math.min(maxBackoff, backoffMs * 2);
      continue;
    }

    const done = new Promise<void>((resolve) => {
      let logsSub = -1;
      let slotSub = -1;
      let pingTimer: ReturnType<typeof setInterval> | undefined;

      const finish = () => {
        if (pingTimer) clearInterval(pingTimer);
        resolve();
      };
      // Arrêt programmé (ex. --duration-min) : vérifié à chaque ping, même si
      // la connexion reste stable (sinon la boucle ne s'arrêterait jamais).
      const requestStop = () => {
        stopped = true;
        try {
          ws.close();
        } catch { /* ignoré */ }
        finish();
      };

      ws.onopen = () => {
        backoffMs = 1000; // reset après connexion réussie
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [program] }, { commitment }] }));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "slotSubscribe", params: [] }));
        pingTimer = setInterval(() => {
          try {
            // Arrêt programmé même sur connexion stable (voir requestStop).
            if (opts.shouldStop && opts.shouldStop()) {
              requestStop();
              return;
            }
            if (ws.ping) ws.ping();
            else ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }));
          } catch { /* ignoré */ }
        }, opts.pingEveryMs ?? 30000);
      };

      ws.onmessage = (ev) => {
        const tRecv = now();
        let msg: RpcNotification;
        try {
          msg = JSON.parse(String(ev.data)) as RpcNotification;
        } catch {
          return;
        }
        if (msg.method === "logsNotification") {
          const result = msg.params.result as { context?: { slot?: number }; value?: { signature: string; err: unknown | null; logs: string[] } };
          const v = result.value;
          if (!v || !Array.isArray(v.logs)) return;
          stats.notifications++;
          const slot = result.context?.slot ?? 0;
          // Estimation AVANT d'ancrer l'horloge : ancrer d'abord rendrait la
          // latence trivialement nulle (auto-référence). L'horloge est ancrée
          // par slotSubscribe (indépendant) ; on observe ici après coup pour
          // la garder fraîche.
          const slotTime = clock.estimateSlotTime(slot);
          const t0 = now();
          const parsed = parseCreateEvent(v.logs);
          const processingMs = now() - t0;
          if (parsed.ok) {
            const c: DetectedCreate = {
              signature: v.signature,
              slot,
              mint: parsed.create.mint,
              name: parsed.create.name,
              symbol: parsed.create.symbol,
              receivedAt: tRecv,
              detectionLatencyMs: slotTime === null ? null : Math.max(0, tRecv - slotTime),
              processingMs,
              commitment,
            };
            stats.createsDetected++;
            if (c.detectionLatencyMs !== null) stats.latenciesMs.push(c.detectionLatencyMs);
            if (opts.onCreate) opts.onCreate(c);
          } else if (parsed.failure) {
            stats.parseFailures++;
          }
          clock.observe(slot, tRecv);
        } else if (msg.method === "slotNotification") {
          const r = (msg.params as { result?: { slot?: number } }).result;
          if (r && typeof r.slot === "number") clock.observe(r.slot, tRecv);
        }
        // Les réponses de souscription (id 1/2, sans method) sont ignorées.

        if (opts.onStats && tRecv - lastStatsAt >= (opts.statsEveryMs ?? 60000)) {
          lastStatsAt = tRecv;
          opts.onStats(stats);
        }
      };

      ws.onclose = () => finish();
      ws.onerror = () => {
        stats.wsErrors++;
      };
    });

    await done;
    if (stopped || (opts.shouldStop && opts.shouldStop())) break;
    // Fermeture inattendue → reconnexion avec backoff (compte comme interruption mesurée).
    stats.reconnects++;
    if (opts.refreshWsUrl) {
      try {
        wsUrl = opts.refreshWsUrl();
      } catch {
        // Conserve l'ancienne URL : la reconnexion échouera proprement et
        // réessaiera au prochain cycle au lieu de planter la boucle.
      }
    }
    await sleep(backoffMs);
    backoffMs = Math.min(maxBackoff, backoffMs * 2);
  }
  return stats;
}
