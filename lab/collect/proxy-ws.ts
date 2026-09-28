/**
 * Client WebSocket minimal tunnellisé via le proxy HTTP(S) d'egress.
 *
 * Contexte : le WebSocket natif de Node (undici) ignore les variables
 * `https_proxy`/`HTTPS_PROXY`, ce qui fait échouer le handshake WSS vers
 * Helius (close 1006) alors que l'egress autorise le trafic — un handshake
 * manuel via curl obtient bien `101 Switching Protocols`.
 *
 * Ce module établit : TCP → proxy → `CONNECT host:443` → TLS → upgrade
 * WebSocket (RFC 6455), et implémente le framing nécessaire (textes masqués
 * à l'envoi, ping/pong, close). Aucune dépendance externe.
 *
 * AUCUN secret n'est loggé : l'URL (qui porte le surrogate) n'apparaît
 * jamais dans les erreurs ni les logs — seul le host est mentionné.
 */
import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";
import type { WsLike } from "./fastlane.ts";

export interface ProxyWsDeps {
  /** Connexion TCP (injectable pour les tests). */
  connectTcp?: (host: string, port: number) => Promise<Socket>;
  /** Négociation TLS par-dessus le socket (injectable pour les tests). */
  wrapTls?: (socket: Socket, servername: string) => Promise<TLSSocket>;
  /** Appelé avec le nombre d'octets reçus (TLS déchiffré), pour mesurer le coût. */
  onBytesReceived?: (n: number) => void;
}

export interface ParsedFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
}

/** Encode une trame texte (client → serveur : toujours masquée). */
export function encodeTextFrame(data: string): Buffer {
  const payload = Buffer.from(data, "utf8");
  const mask = randomBytes(4);
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2 + 4);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4 + 4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10 + 4);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + opcode texte
  mask.copy(header, header.length - 4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, masked]);
}

/** Encode une trame de contrôle (ping/pong/close), payload court. */
export function encodeControlFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const mask = randomBytes(4);
  const header = Buffer.alloc(2 + 4);
  header[0] = 0x80 | (opcode & 0x0f);
  header[1] = 0x80 | payload.length;
  mask.copy(header, 2);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, masked]);
}

/**
 * Découpe les trames complètes en tête du buffer (serveur → client :
 * normalement non masquées, mais le bit de masque est supporté).
 * Retourne les trames et le reste non consommé.
 */
export function parseFrames(buf: Buffer): { frames: ParsedFrame[]; rest: Buffer } {
  const frames: ParsedFrame[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off]!;
    const b1 = buf[off + 1]!;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let hlen = 2;
    if (len === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2);
      hlen = 4;
    } else if (len === 127) {
      if (buf.length - off < 10) break;
      const big = buf.readBigUInt64BE(off + 2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("trame WebSocket trop grande");
      len = Number(big);
      hlen = 10;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buf.length - off < hlen + 4) break;
      mask = buf.subarray(off + hlen, off + hlen + 4);
      hlen += 4;
    }
    if (buf.length - off < hlen + len) break;
    let payload = buf.subarray(off + hlen, off + hlen + len);
    if (mask) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ mask[i % 4]!;
      payload = unmasked;
    }
    frames.push({ opcode, fin, payload });
    off += hlen + len;
  }
  return { frames, rest: buf.subarray(off) };
}

function proxyUrlFromEnv(): URL | null {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Lit un socket jusqu'au délimiteur (inclus), avec timeout. Retourne aussi les octets excédentaires déjà reçus. */
function readUntil(sock: Socket, delim: Buffer, timeoutMs: number): Promise<{ head: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout après ${timeoutMs} ms en attente de réponse`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("error", onError);
      sock.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
      const idx = acc.indexOf(delim);
      if (idx >= 0) {
        const head = acc.subarray(0, idx + delim.length);
        const rest = acc.subarray(idx + delim.length);
        cleanup();
        resolve({ head, rest });
      }
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("connexion fermée pendant le handshake"));
    };
    sock.on("data", onData);
    sock.on("error", onError);
    sock.on("close", onClose);
  });
}

interface ResolvedDeps {
  connectTcp: (host: string, port: number) => Promise<Socket>;
  wrapTls: (socket: Socket, servername: string) => Promise<TLSSocket>;
  onBytesReceived?: (n: number) => void;
}

const defaultDeps: Pick<ResolvedDeps, "connectTcp" | "wrapTls"> = {
  connectTcp: (host, port) =>
    new Promise((resolve, reject) => {
      const s = tcpConnect({ host, port, timeout: 15000 });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
      s.once("timeout", () => reject(new Error("timeout TCP vers le proxy")));
    }),
  wrapTls: (socket, servername) =>
    new Promise((resolve, reject) => {
      const t = tlsConnect({ socket, servername, ALPNProtocols: ["http/1.1"] });
      t.once("secureConnect", () => resolve(t));
      t.once("error", reject);
    }),
};

/**
 * Crée un WsLike connecté en WSS via le proxy d'egress.
 * Si aucune variable proxy n'est définie, connexion directe.
 */
export function createProxyWs(targetUrl: string, deps: ProxyWsDeps = {}): WsLike {
  const d: ResolvedDeps = { ...defaultDeps, ...deps };
  const target = new URL(targetUrl);
  if (target.protocol !== "wss:") throw new Error(`protocole inattendu : ${target.protocol}`);
  const targetHost = target.hostname;
  const targetPort = target.port ? Number(target.port) : 443;
  const path = target.pathname + target.search || "/";

  const handlers: {
    open: ((ev: unknown) => void) | null;
    message: ((ev: { data: unknown }) => void) | null;
    close: ((ev: { code: number; reason: string }) => void) | null;
    error: ((ev: unknown) => void) | null;
  } = { open: null, message: null, close: null, error: null };

  let tls: TLSSocket | null = null;
  let recvBuf: Buffer = Buffer.alloc(0);
  let textAcc: Buffer[] | null = null; // fragments en cours (opcode 0x0)
  let closed = false;

  const fail = (e: unknown) => {
    if (closed) return;
    closed = true;
    try {
      handlers.error?.(e);
    } catch { /* ignoré */ }
    try {
      handlers.close?.({ code: 1006, reason: "" });
    } catch { /* ignoré */ }
  };

  const handleFrames = (sock: TLSSocket) => {
    const { frames, rest } = parseFrames(recvBuf);
    recvBuf = rest;
    for (const f of frames) {
      if (f.opcode === 0x1 || (f.opcode === 0x0 && textAcc)) {
        // Texte (ou fragment de texte).
        if (f.opcode === 0x1) textAcc = [];
        textAcc!.push(f.payload);
        if (f.fin) {
          const text = Buffer.concat(textAcc!).toString("utf8");
          textAcc = null;
          try {
            handlers.message?.({ data: text });
          } catch { /* ignoré */ }
        }
      } else if (f.opcode === 0x9) {
        // Ping → pong avec le même payload.
        try {
          sock.write(encodeControlFrame(0xa, f.payload));
        } catch { /* ignoré */ }
      } else if (f.opcode === 0x8) {
        // Close serveur → on acquitte et on ferme.
        if (!closed) {
          closed = true;
          try {
            sock.write(encodeControlFrame(0x8, f.payload));
          } catch { /* ignoré */ }
          const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1000;
          const reason = f.payload.length > 2 ? f.payload.subarray(2).toString("utf8") : "";
          try {
            handlers.close?.({ code, reason });
          } catch { /* ignoré */ }
          sock.destroy();
        }
      }
      // 0x2 (binaire) et 0xA (pong) : ignorés (non utilisés par JSON-RPC).
    }
  };

  const ws: WsLike = {
    get onopen() { return handlers.open; },
    set onopen(v) { handlers.open = v; },
    get onmessage() { return handlers.message; },
    set onmessage(v) { handlers.message = v; },
    get onclose() { return handlers.close; },
    set onclose(v) { handlers.close = v; },
    get onerror() { return handlers.error; },
    set onerror(v) { handlers.error = v; },
    send(data: string): void {
      if (!tls || closed) throw new Error("WebSocket non connecté");
      tls.write(encodeTextFrame(data));
    },
    ping(): void {
      if (!tls || closed) return;
      try {
        tls.write(encodeControlFrame(0x9));
      } catch { /* ignoré */ }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        tls?.write(encodeControlFrame(0x8, Buffer.from([0x03, 0xe8]))); // 1000
      } catch { /* ignoré */ }
      tls?.destroy();
      try {
        handlers.close?.({ code: 1000, reason: "" });
      } catch { /* ignoré */ }
    },
  };

  (async () => {
    try {
      let sock: Socket;
      const proxy = proxyUrlFromEnv();
      if (proxy) {
        // 1) TCP vers le proxy + CONNECT.
        const raw = await d.connectTcp(proxy.hostname, proxy.port ? Number(proxy.port) : 8080);
        let connectReq =
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` + `Host: ${targetHost}:${targetPort}\r\n`;
        if (proxy.username) {
          const creds = Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
            "utf8",
          ).toString("base64");
          connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
        }
        connectReq += "\r\n";
        raw.write(connectReq);
        const { head: connectHead } = await readUntil(raw, Buffer.from("\r\n\r\n"), 15000);
        const statusLine = connectHead.toString("utf8").split("\r\n", 1)[0] ?? "";
        if (!/^HTTP\/\d(\.\d)? 200/.test(statusLine)) {
          raw.destroy();
          throw new Error(`le proxy a refusé CONNECT vers ${targetHost} (${statusLine.trim()})`);
        }
        // Après un 200 à CONNECT, le serveur n'envoie rien avant le TLS client :
        // aucun octet excédentaire à préserver ici.
        sock = raw;
      } else {
        sock = await d.connectTcp(targetHost, targetPort);
      }
      // 2) TLS.
      tls = await d.wrapTls(sock, targetHost);
      // 3) Upgrade WebSocket.
      const key = randomBytes(16).toString("base64");
      const upgradeReq =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;
      tls.write(upgradeReq);
      const { head: upgradeHead, rest: upgradeRest } = await readUntil(tls, Buffer.from("\r\n\r\n"), 15000);
      const statusLine = upgradeHead.toString("utf8").split("\r\n", 1)[0] ?? "";
      if (!/^HTTP\/\d(\.\d)? 101/.test(statusLine)) {
        throw new Error(`upgrade WebSocket refusé par ${targetHost} (${statusLine.trim()})`);
      }
      // Les octets déjà reçus après le 101 sont les premières trames.
      recvBuf = Buffer.concat([recvBuf, upgradeRest]);
      // 4) Boucle de lecture.
      tls.on("data", (chunk: Buffer) => {
        try {
          d.onBytesReceived?.(chunk.length);
        } catch { /* ignoré */ }
        recvBuf = Buffer.concat([recvBuf, chunk]);
        try {
          handleFrames(tls!);
        } catch (e) {
          fail(e);
        }
      });
      tls.on("error", (e) => fail(e));
      tls.on("close", () => {
        if (!closed) {
          closed = true;
          try {
            handlers.close?.({ code: 1006, reason: "" });
          } catch { /* ignoré */ }
        }
      });
      try {
        handlers.open?.({});
      } catch { /* ignoré */ }
    } catch (e) {
      fail(e);
    }
  })();

  return ws;
}
