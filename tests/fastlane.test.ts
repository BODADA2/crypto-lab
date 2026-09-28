import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import {
  parseCreateEvent,
  parseCreateEventData,
  SlotClock,
  runFastlaneDetector,
  latencyPercentiles,
  newStats,
  PUMP_PROGRAM,
  type WsLike,
  type DetectedCreate,
} from "../lab/collect/fastlane.ts";

// ---------------------------------------------------------------------------
// Helpers : fabrique un événement Create Anchor sérialisé en Borsh (base64)
// ---------------------------------------------------------------------------

function borshStr(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

function fakePubkey(seed: number): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = (seed + i) % 256;
  return b;
}

/** Construit un "Program data:" réaliste pour un CreateEvent. */
function makeCreateDataB64(name = "TestToken", symbol = "TEST", uri = "https://x/y.json", mintSeed = 7): string {
  const disc = Buffer.alloc(8, 0xab); // discriminateur quelconque (non vérifié par le parser)
  const buf = Buffer.concat([
    disc,
    borshStr(name),
    borshStr(symbol),
    borshStr(uri),
    fakePubkey(mintSeed),
    fakePubkey(mintSeed + 1),
    fakePubkey(mintSeed + 2),
  ]);
  return buf.toString("base64");
}

function createLogs(b64: string): string[] {
  return [
    `Program ${PUMP_PROGRAM} invoke [1]`,
    "Program log: Instruction: Create",
    `Program data: ${b64}`,
    `Program ${PUMP_PROGRAM} success`,
  ];
}

// ---------------------------------------------------------------------------
// parseCreateEventData / parseCreateEvent
// ---------------------------------------------------------------------------

describe("parseCreateEventData", () => {
  it("décode un CreateEvent Borsh valide", () => {
    const b64 = makeCreateDataB64("Claude", "CLAUDE", "https://x/z.json", 7);
    const c = parseCreateEventData(b64);
    expect(c).not.toBeNull();
    expect(c!.name).toBe("Claude");
    expect(c!.symbol).toBe("CLAUDE");
    expect(c!.uri).toBe("https://x/z.json");
    expect(c!.mint).toBe(bs58.encode(fakePubkey(7)));
    expect(c!.bondingCurve).toBe(bs58.encode(fakePubkey(8)));
    expect(c!.user).toBe(bs58.encode(fakePubkey(9)));
  });

  it("rejette le base64 invalide", () => {
    expect(parseCreateEventData("!!!pas-du-base64!!!")).toBeNull();
  });

  it("rejette les données tronquées", () => {
    const full = Buffer.from(makeCreateDataB64(), "base64");
    expect(parseCreateEventData(full.subarray(0, 20).toString("base64"))).toBeNull();
  });

  it("rejette les strings de longueur absurde", () => {
    const disc = Buffer.alloc(8);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(10_000_000, 0); // 10 Mo de "nom"
    const buf = Buffer.concat([disc, len, Buffer.alloc(10)]);
    expect(parseCreateEventData(buf.toString("base64"))).toBeNull();
  });
});

describe("parseCreateEvent", () => {
  it("détecte un Create dans des logs Anchor standards", () => {
    const r = parseCreateEvent(createLogs(makeCreateDataB64("Mimi", "MIMI", "u", 42)));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.create.name).toBe("Mimi");
      expect(r.create.mint).toBe(bs58.encode(fakePubkey(42)));
    }
  });

  it("ignore les logs de buy/sell (pas de contexte Create)", () => {
    const logs = [
      `Program ${PUMP_PROGRAM} invoke [1]`,
      "Program log: Instruction: Buy",
      `Program data: ${makeCreateDataB64()}`,
      `Program ${PUMP_PROGRAM} success`,
    ];
    const r = parseCreateEvent(logs);
    expect(r.ok).toBe(false);
  });

  it("ignore les logs sans Program data", () => {
    const r = parseCreateEvent([`Program ${PUMP_PROGRAM} invoke [1]`, "Program log: Instruction: Create"]);
    expect(r.ok).toBe(false);
  });

  it("signale un Program data non parsable dans un contexte Create", () => {
    const r = parseCreateEvent([`Program ${PUMP_PROGRAM} invoke [1]`, "Program log: Instruction: Create", "Program data: aGk="]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure?.reason).toBe("program_data_unparsable");
  });
});

// ---------------------------------------------------------------------------
// SlotClock
// ---------------------------------------------------------------------------

describe("SlotClock", () => {
  it("retourne null sans ancrage", () => {
    expect(new SlotClock().estimateSlotTime(123)).toBeNull();
  });

  it("interpole entre deux slots observés", () => {
    const c = new SlotClock();
    c.observe(1000, 10_000);
    c.observe(1010, 14_000); // 10 slots en 4000 ms = 400 ms/slot
    expect(c.estimateSlotTime(1005)).toBe(12_000);
  });

  it("extrapole au-delà du dernier slot", () => {
    const c = new SlotClock();
    c.observe(1000, 10_000);
    expect(c.estimateSlotTime(1005)).toBe(10_000 + 5 * 400);
  });

  it("ignore les régressions de slot", () => {
    const c = new SlotClock();
    c.observe(1000, 10_000);
    c.observe(999, 20_000); // ignoré
    expect(c.estimateSlotTime(1000)).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// latencyPercentiles
// ---------------------------------------------------------------------------

describe("latencyPercentiles", () => {
  it("retourne null sans échantillon", () => {
    expect(latencyPercentiles([])).toBeNull();
  });
  it("calcule p50/p95/p99", () => {
    const p = latencyPercentiles([100, 200, 300, 400, 500]);
    expect(p!.p50).toBe(300);
    expect(p!.p95).toBe(500);
  });
  it("newStats initialise à zéro", () => {
    expect(newStats().notifications).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runFastlaneDetector avec WebSocket simulé
// ---------------------------------------------------------------------------

class FakeWs implements WsLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    if (this.onmessage) this.onmessage({ data });
  }
  emitClose(code = 1006, reason = "test"): void {
    if (this.onclose) this.onclose({ code, reason });
  }
}

function logsNotif(sub: number, slot: number, signature: string, logs: string[]): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: { subscription: sub, result: { context: { slot }, value: { signature, err: null, logs } } },
  });
}

function slotNotif(sub: number, slot: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "slotNotification",
    params: { subscription: sub, result: { parent: slot - 1, root: slot - 10, slot } },
  });
}

describe("runFastlaneDetector", () => {
  it("souscrit aux logs + slots, détecte les creates, mesure la latence", async () => {
    const fakes: FakeWs[] = [];
    const detected: DetectedCreate[] = [];
    let t = 1_000_000;
    let stop = false;
    const promise = runFastlaneDetector({
      wsUrl: "wss://fake",
      createWs: () => {
        const f = new FakeWs();
        fakes.push(f);
        return f;
      },
      now: () => t,
      onCreate: (c) => detected.push(c),
      statsEveryMs: 1_000_000, // pas de stats intermédiaires
      pingEveryMs: 1_000_000,
      shouldStop: () => stop,
    });

    const ws = fakes[0];
    if (!ws) throw new Error("WebSocket simulé non créé");
    ws.onopen!({});
    // Vérifie les deux souscriptions.
    const subs = ws.sent.map((s) => JSON.parse(s).method).sort();
    expect(subs).toEqual(["logsSubscribe", "slotSubscribe"]);

    // Ancre l'horloge : slot 5000 à t=1_000_000 (via slotSubscribe, indépendant).
    ws.emit(slotNotif(2, 5000));
    // Le slot 5002 a lieu à t=1_000_800 (2 slots × 400 ms) mais la notification
    // n'arrive qu'à t=1_001_600 → latence estimée = 800 ms.
    t += 1600;
    ws.emit(logsNotif(1, 5002, "sigAAA", createLogs(makeCreateDataB64("Zed", "ZED", "u", 11))));
    // Une notification buy (pas de Create) → ignorée.
    ws.emit(logsNotif(1, 5003, "sigBBB", [`Program ${PUMP_PROGRAM} invoke [1]`, "Program log: Instruction: Buy"]));
    stop = true;
    ws.emitClose(1000, "fin du test");

    const stats = await promise;
    expect(detected).toHaveLength(1);
    const first = detected[0];
    if (!first) throw new Error("aucune création détectée");
    expect(first.mint).toBe(bs58.encode(fakePubkey(11)));
    expect(first.signature).toBe("sigAAA");
    expect(first.detectionLatencyMs).toBe(800);
    expect(stats.notifications).toBe(2);
    expect(stats.createsDetected).toBe(1);
    expect(stats.latenciesMs).toEqual([800]);
  });

  it("reconnecte après une fermeture inattendue", async () => {
    const fakes: FakeWs[] = [];
    let stop = false;
    const promise = runFastlaneDetector({
      wsUrl: "wss://fake",
      createWs: () => {
        const f = new FakeWs();
        fakes.push(f);
        return f;
      },
      now: () => Date.now(),
      statsEveryMs: 1_000_000,
      pingEveryMs: 1_000_000,
      maxBackoffMs: 5,
      shouldStop: () => stop,
    });
    const ws0 = fakes[0];
    if (!ws0) throw new Error("WebSocket simulé non créé");
    ws0.onopen!({});
    ws0.emitClose(1006, "boom");
    // Laisse le temps au backoff (1000 ms initiaux) puis à la reconnexion.
    await new Promise((r) => setTimeout(r, 1500));
    expect(fakes.length).toBe(2);
    stop = true;
    const ws1 = fakes[1];
    if (!ws1) throw new Error("WebSocket simulé non reconnecté");
    ws1.emitClose(1000, "fin du test");
    const stats = await promise;
    expect(stats.reconnects).toBe(1);
  });

  it("s'arrête à la durée programmée même sur connexion stable", async () => {
    const fakes: FakeWs[] = [];
    let stop = false;
    const t0 = Date.now();
    const promise = runFastlaneDetector({
      wsUrl: "wss://fake",
      createWs: () => {
        const f = new FakeWs();
        fakes.push(f);
        return f;
      },
      now: () => Date.now(),
      statsEveryMs: 1_000_000,
      pingEveryMs: 50,
      shouldStop: () => stop,
    });
    const ws = fakes[0];
    if (!ws) throw new Error("WebSocket simulé non créé");
    ws.onopen!({});
    // Aucune déconnexion : la connexion reste stable, seul shouldStop arrête.
    setTimeout(() => {
      stop = true;
    }, 120);
    const stats = await promise;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(fakes.length).toBe(1); // aucune reconnexion nécessaire
    expect(stats.reconnects).toBe(0);
  });

  it("rafraîchit l'URL WS à la reconnexion si refreshWsUrl est fourni", async () => {
    const fakes: FakeWs[] = [];
    const seenUrls: string[] = [];
    let stop = false;
    let n = 0;
    const promise = runFastlaneDetector({
      wsUrl: "wss://fake/v1",
      refreshWsUrl: () => `wss://fake/v${++n + 1}`,
      createWs: (url) => {
        seenUrls.push(url);
        const f = new FakeWs();
        fakes.push(f);
        return f;
      },
      now: () => Date.now(),
      statsEveryMs: 1_000_000,
      pingEveryMs: 1_000_000,
      maxBackoffMs: 5,
      shouldStop: () => stop,
    });
    const ws0 = fakes[0];
    if (!ws0) throw new Error("WebSocket simulé non créé");
    expect(seenUrls[0]).toBe("wss://fake/v1");
    ws0.onopen!({});
    ws0.emitClose(1006, "boom");
    // Backoff initial 1000 ms → reconnexion ensuite.
    await new Promise((r) => setTimeout(r, 1500));
    expect(fakes.length).toBe(2);
    expect(seenUrls[1]).toBe("wss://fake/v2");
    stop = true;
    const ws1 = fakes[1];
    if (!ws1) throw new Error("WebSocket simulé non reconnecté");
    ws1.emitClose(1000, "fin du test");
    const stats = await promise;
    expect(stats.reconnects).toBe(1);
  });

  it("conserve l'ancienne URL si refreshWsUrl lève", async () => {
    const fakes: FakeWs[] = [];
    const seenUrls: string[] = [];
    let stop = false;
    const promise = runFastlaneDetector({
      wsUrl: "wss://fake/v1",
      refreshWsUrl: () => {
        throw new Error("CLI indisponible");
      },
      createWs: (url) => {
        seenUrls.push(url);
        const f = new FakeWs();
        fakes.push(f);
        return f;
      },
      now: () => Date.now(),
      statsEveryMs: 1_000_000,
      pingEveryMs: 1_000_000,
      maxBackoffMs: 5,
      shouldStop: () => stop,
    });
    const ws0 = fakes[0];
    if (!ws0) throw new Error("WebSocket simulé non créé");
    ws0.onopen!({});
    ws0.emitClose(1006, "boom");
    await new Promise((r) => setTimeout(r, 1500));
    expect(fakes.length).toBe(2);
    expect(seenUrls[1]).toBe("wss://fake/v1");
    stop = true;
    fakes[1]!.emitClose(1000, "fin du test");
    const stats = await promise;
    expect(stats.reconnects).toBe(1);
  });
});
