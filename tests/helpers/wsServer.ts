/**
 * Faux serveur WebSocket minimal (RFC 6455, trames texte/close/ping) sur `node:http`,
 * sans dépendance `ws`. Suffisant pour tester le client PumpPortal avec le WebSocket natif de Node 22.
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface FakeWsConnection {
  socket: Socket;
  received: string[];
  send(text: string): void;
  close(code?: number): void;
}

export interface FakeWsServer {
  url: string;
  connections: FakeWsConnection[];
  /** Appelé à chaque message texte reçu. */
  onMessage: ((conn: FakeWsConnection, text: string) => void) | null;
  onConnection: ((conn: FakeWsConnection) => void) | null;
  /** Attend la n-ième connexion (1 = première). */
  waitForConnection(n: number, timeoutMs?: number): Promise<FakeWsConnection>;
  close(): Promise<void>;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Décode les trames complètes présentes dans `buf` ; renvoie les trames et le reste non consommé. */
function decodeFrames(buf: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off] as number;
    const b1 = buf[off + 1] as number;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buf.length < p + 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length < p + len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export function startFakeWsServer(): Promise<FakeWsServer> {
  const server: Server = createServer((_req, res) => {
    res.statusCode = 426;
    res.end("upgrade required");
  });
  const api: FakeWsServer = {
    url: "",
    connections: [],
    onMessage: null,
    onConnection: null,
    waitForConnection(n, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const c = api.connections[n - 1];
          if (c) return resolve(c);
          if (Date.now() - t0 > timeoutMs) return reject(new Error(`connexion ${n} non reçue`));
          setTimeout(tick, 5);
        };
        tick();
      });
    },
    close() {
      for (const c of api.connections) c.socket.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };

  server.on("upgrade", (req, socket: Socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
    const conn: FakeWsConnection = {
      socket,
      received: [],
      send(text) {
        if (!socket.destroyed) socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
      },
      close(code = 1000) {
        const p = Buffer.alloc(2);
        p.writeUInt16BE(code, 0);
        if (!socket.destroyed) socket.write(encodeFrame(0x8, p));
        setTimeout(() => socket.destroy(), 20);
      },
    };
    api.connections.push(conn);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, rest } = decodeFrames(pending);
      pending = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 0x1) {
          const text = f.payload.toString("utf8");
          conn.received.push(text);
          api.onMessage?.(conn, text);
        } else if (f.opcode === 0x8) {
          if (!socket.destroyed) socket.write(encodeFrame(0x8, f.payload));
          socket.end();
        } else if (f.opcode === 0x9) {
          socket.write(encodeFrame(0xa, f.payload));
        }
      }
    });
    socket.on("error", () => undefined);
    api.onConnection?.(conn);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      api.url = `ws://127.0.0.1:${port}/api/data`;
      resolve(api);
    });
  });
}
