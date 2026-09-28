/**
 * Tests du client WebSocket via proxy (proxy-ws.ts).
 * Un faux serveur local joue le rôle du proxy (CONNECT) puis de la cible
 * (upgrade 101), en clair : wrapTls est injecté en identité.
 */
import { describe, it, expect } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { createHash } from "node:crypto";
import {
  createProxyWs,
  encodeTextFrame,
  encodeControlFrame,
  parseFrames,
} from "../lab/collect/proxy-ws.ts";
import type { WsLike } from "../lab/collect/fastlane.ts";

function wsAccept(key: string): string {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

/** Trame serveur → client (non masquée). */
function serverTextFrame(text: string): Buffer {
  const p = Buffer.from(text, "utf8");
  const h = Buffer.alloc(2);
  h[0] = 0x81;
  h[1] = p.length;
  return Buffer.concat([h, p]);
}

interface FakeEndpoint {
  server: Server;
  port: number;
  /** Requêtes HTTP reçues (CONNECT puis upgrade). */
  requests: string[];
  /** Sockets clients acceptés. */
  clients: Socket[];
  close(): Promise<void>;
}

async function startFakeEndpoint(): Promise<FakeEndpoint> {
  const requests: string[] = [];
  const clients: Socket[] = [];
  const server = createServer((sock) => {
    clients.push(sock);
    let buf = Buffer.alloc(0);
    let stage = 0; // 0 = CONNECT attendu, 1 = upgrade attendu, 2 = frames
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage < 2) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString("utf8");
        requests.push(head);
        buf = buf.subarray(idx + 4);
        if (stage === 0) {
          sock.write("HTTP/1.1 200 Connection established\r\n\r\n");
          stage = 1;
        } else {
          const m = head.match(/Sec-WebSocket-Key: (\S+)/);
          sock.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${wsAccept(m?.[1] ?? "")}\r\n\r\n`,
          );
          stage = 2;
          // Envoie un message JSON-RPC dès l'upgrade.
          sock.write(serverTextFrame('{"jsonrpc":"2.0","id":1,"result":7}'));
        }
      } else {
        // Décode la trame masquée du client et répond pong aux pings.
        const { frames } = parseFrames(buf);
        // On consomme tout ce qui est parsable pour le test.
        buf = Buffer.alloc(0);
        for (const f of frames) {
          if (f.opcode === 0x9) {
            const h = Buffer.alloc(2);
            h[0] = 0x8a;
            h[1] = f.payload.length;
            sock.write(Buffer.concat([h, f.payload]));
          }
          if (f.opcode === 0x8) {
            sock.end();
          }
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("adresse serveur inconnue");
  return {
    server,
    port: addr.port,
    requests,
    clients,
    close: () =>
      new Promise<void>((res, rej) => {
        for (const c of clients) c.destroy();
        server.close((e) => (e ? rej(e) : res()));
      }),
  };
}

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout d'attente"));
      }
    }, 20);
  });
}

describe("encodeTextFrame / parseFrames", () => {
  it("roundtrip texte court (masqué)", () => {
    const enc = encodeTextFrame("hello");
    expect(enc[1]! & 0x80).toBe(0x80); // bit de masque
    const { frames, rest } = parseFrames(enc);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString("utf8")).toBe("hello");
    expect(rest.length).toBe(0);
  });

  it("roundtrip texte long (> 125 octets, longueur 16 bits)", () => {
    const s = "x".repeat(300);
    const { frames } = parseFrames(encodeTextFrame(s));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString("utf8")).toBe(s);
  });

  it("roundtrip texte très long (> 65535 octets, longueur 64 bits)", () => {
    const s = "y".repeat(70000);
    const { frames } = parseFrames(encodeTextFrame(s));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString("utf8")).toBe(s);
  });

  it("découpe plusieurs trames et garde le reste partiel", () => {
    const a = serverTextFrame("un");
    const b = serverTextFrame("deux");
    const partial = Buffer.concat([a, b, Buffer.from([0x81])]);
    const { frames, rest } = parseFrames(partial);
    expect(frames.map((f) => f.payload.toString("utf8"))).toEqual(["un", "deux"]);
    expect(rest).toEqual(Buffer.from([0x81]));
  });

  it("parse les trames de contrôle", () => {
    const ping = encodeControlFrame(0x9, Buffer.from("pz"));
    const { frames } = parseFrames(ping);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(0x9);
    expect(frames[0]!.payload.toString("utf8")).toBe("pz");
  });
});

describe("createProxyWs", () => {
  it("traverse CONNECT + upgrade 101 et reçoit un message", async () => {
    const ep = await startFakeEndpoint();
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${ep.port}`;
    try {
      const received: unknown[] = [];
      let opened = false;
      const ws: WsLike = createProxyWs("wss://faux-helius.test/?api-key=hsurr:X", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wrapTls: async (s: any) => s,
      });
      ws.onopen = () => {
        opened = true;
      };
      ws.onmessage = (ev) => received.push(ev.data);
      await waitFor(() => received.length > 0);
      expect(opened).toBe(true);
      expect(received[0]).toBe('{"jsonrpc":"2.0","id":1,"result":7}');
      // Vérifie le CONNECT et l'upgrade côté serveur.
      expect(ep.requests[0]).toMatch(/^CONNECT faux-helius\.test:443 HTTP\/1\.1/);
      expect(ep.requests[1]).toMatch(/^GET \/\?api-key=hsurr:X HTTP\/1\.1/);
      expect(ep.requests[1]).toContain("Upgrade: websocket");
      // Envoi client → trame masquée reçue par le serveur sans erreur.
      ws.send('{"jsonrpc":"2.0","id":2,"method":"ping"}');
      await new Promise((r) => setTimeout(r, 200));
      ws.close();
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
      await ep.close();
    }
  });

  it("envoie Proxy-Authorization quand le proxy a des identifiants", async () => {
    const ep = await startFakeEndpoint();
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = `http://user:pw@127.0.0.1:${ep.port}`;
    try {
      const ws: WsLike = createProxyWs("wss://faux-helius.test/", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wrapTls: async (s: any) => s,
      });
      let opened = false;
      ws.onopen = () => {
        opened = true;
      };
      await waitFor(() => opened);
      const expected = "Basic " + Buffer.from("user:pw", "utf8").toString("base64");
      expect(ep.requests[0]).toContain(`Proxy-Authorization: ${expected}`);
      ws.close();
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
      await ep.close();
    }
  });

  it("rapporte les octets reçus via onBytesReceived", async () => {
    const ep = await startFakeEndpoint();
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${ep.port}`;
    try {
      let bytes = 0;
      const ws: WsLike = createProxyWs("wss://faux-helius.test/", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wrapTls: async (s: any) => s,
        onBytesReceived: (n) => {
          bytes += n;
        },
      });
      const received: unknown[] = [];
      ws.onmessage = (ev) => received.push(ev.data);
      await waitFor(() => received.length > 0);
      expect(bytes).toBeGreaterThan(0);
      ws.close();
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
      await ep.close();
    }
  });

  it("signale onclose(1006) si le proxy refuse CONNECT", async () => {
    const ep = await startFakeEndpoint();
    // Ferme le serveur : connexion TCP refusée.
    await ep.close();
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${ep.port}`;
    try {
      const ws: WsLike = createProxyWs("wss://faux-helius.test/");
      let closeCode: number | null = null;
      ws.onclose = (ev) => {
        closeCode = (ev as { code: number }).code;
      };
      await waitFor(() => closeCode !== null);
      expect(closeCode).toBe(1006);
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
    }
  });
});
