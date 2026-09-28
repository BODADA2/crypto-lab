import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectLateDiscovery,
  lateDiscoveryOf,
  GRADUATION_VSOL_SOL,
} from "../lab/collect/lateDiscovery.ts";
import {
  sampledFor,
  trackPhase,
  intervalForPhase,
  isMigratedDex,
  admitToSample,
  ingestScanFiles,
  snapshotDueEntries,
  PRE_INTERVAL_MS,
  POST_FAST_INTERVAL_MS,
  POST_SLOW_INTERVAL_MS,
  MAX_ACTIVE_TOKENS,
  type DayManifest,
  type TrackedEntry,
  type SnapshotProvider,
} from "../lab/collect/track-unbiased.ts";
import { parsePumpMessage } from "../lab/collect/pumpportal.ts";
import { makeSnapshot } from "../lab/collect/types.ts";

// ---------------------------------------------------------------------------
// detectLateDiscovery
// ---------------------------------------------------------------------------

describe("detectLateDiscovery", () => {
  const tupleRaw = {
    solAmount: 85.005359057,
    vSolInBondingCurve: 115.005359056806,
    vTokensInBondingCurve: 279900000,
    marketCapSol: 410.8801681200643,
  };

  it("flagge le tuple exact de l'audit", () => {
    expect(detectLateDiscovery({ kind: "create", raw: tupleRaw })).toBe(true);
  });

  it("flagge un create observé à vSol >= 85 hors tuple (les 14 supplémentaires)", () => {
    expect(detectLateDiscovery({ kind: "create", raw: { vSolInBondingCurve: 90.5, solAmount: 60 } })).toBe(true);
  });

  it("ne flagge pas un genuine (max observé : vSol = 84,32)", () => {
    expect(detectLateDiscovery({ kind: "create", raw: { vSolInBondingCurve: 84.32098765299982 } })).toBe(false);
  });

  it("frontière exacte à 85", () => {
    expect(GRADUATION_VSOL_SOL).toBe(85);
    expect(detectLateDiscovery({ kind: "create", raw: { vSolInBondingCurve: 85 } })).toBe(true);
    expect(detectLateDiscovery({ kind: "create", raw: { vSolInBondingCurve: 84.9999 } })).toBe(false);
  });

  it("ne flagge jamais un migrate (vSol >= 85 par définition après graduation)", () => {
    expect(detectLateDiscovery({ kind: "migrate", raw: tupleRaw })).toBe(false);
  });

  it("vSol absent (cas Bonk) → jamais flaggé", () => {
    expect(detectLateDiscovery({ kind: "create", raw: { solAmount: 0 } })).toBe(false);
    expect(detectLateDiscovery({ kind: "create", raw: {} })).toBe(false);
    expect(detectLateDiscovery({ kind: "create" })).toBe(false);
  });

  it("tolère les valeurs non numériques sans crasher", () => {
    expect(detectLateDiscovery({ kind: "create", raw: { vSolInBondingCurve: NaN } })).toBe(false);
    expect(detectLateDiscovery({ kind: "create", raw: { vSolInBondingCurve: "115.0" } })).toBe(true);
    expect(detectLateDiscovery({ kind: "create", raw: null })).toBe(false);
  });
});

describe("lateDiscoveryOf (compat lignes historiques)", () => {
  it("respecte le flag explicite quand il existe", () => {
    expect(lateDiscoveryOf({ kind: "create", raw: { vSolInBondingCurve: 115 }, lateDiscovery: false })).toBe(false);
    expect(lateDiscoveryOf({ kind: "create", raw: {}, lateDiscovery: true })).toBe(true);
  });

  it("détecte à la volée quand le flag est absent", () => {
    expect(lateDiscoveryOf({ kind: "create", raw: { vSolInBondingCurve: 115 } })).toBe(true);
    expect(lateDiscoveryOf({ kind: "create", raw: { vSolInBondingCurve: 10 } })).toBe(false);
  });
});

describe("parsePumpMessage expose lateDiscovery", () => {
  it("create tardif → flag true, valeur brute conservée", () => {
    const ev = parsePumpMessage(
      JSON.stringify({
        txType: "create",
        mint: "LateMint111111111111111111111111111111111111",
        solAmount: 85.005359057,
        vSolInBondingCurve: 115.005359056806,
        vTokensInBondingCurve: 279900000,
        marketCapSol: 410.8801681200643,
      }),
      Date.now()
    );
    expect(ev?.lateDiscovery).toBe(true);
    expect(ev?.solAmount).toBe(85.005359057); // brut conservé (flag-only, pas d'écrasement)
  });

  it("create genuine → flag false", () => {
    const ev = parsePumpMessage(
      JSON.stringify({
        txType: "create",
        mint: "GenuineMint11111111111111111111111111111111",
        solAmount: 1.5,
        vSolInBondingCurve: 31.5,
      }),
      Date.now()
    );
    expect(ev?.lateDiscovery).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sampledFor — échantillonnage déterministe
// ---------------------------------------------------------------------------

describe("sampledFor", () => {
  it("est déterministe : même entrée → même sortie, indépendant de l'ordre", () => {
    expect(sampledFor("2026-09-28", "MintA")).toBe(sampledFor("2026-09-28", "MintA"));
  });

  it("respecte le taux de 5 % à grande échelle", () => {
    let n = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) if (sampledFor("2026-09-28", `RateMint${i}`)) n++;
    const rate = n / N;
    expect(rate).toBeGreaterThan(0.04);
    expect(rate).toBeLessThan(0.06);
  });

  it("le seed dépend de la date UTC du create", () => {
    // Deux jours différents ne donnent pas le même ensemble (probabilité négligeable d'égalité).
    let diff = 0;
    for (let i = 0; i < 200; i++) {
      if (sampledFor("2026-09-28", `D${i}`) !== sampledFor("2026-09-29", `D${i}`)) diff++;
    }
    expect(diff).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// trackPhase / intervalForPhase / isMigratedDex / admitToSample
// ---------------------------------------------------------------------------

describe("trackPhase", () => {
  const t0 = Date.UTC(2026, 8, 28, 12, 0, 0);

  it("pre pendant 12 h après le create", () => {
    expect(trackPhase({ receivedAtMs: t0, migratedAtMs: null, nowMs: t0 + 11 * 3_600_000 })).toBe("pre");
    expect(trackPhase({ receivedAtMs: t0, migratedAtMs: null, nowMs: t0 + 13 * 3_600_000 })).toBe("done");
  });

  it("post-fast 60 min puis post-slow 48 h après migration", () => {
    expect(trackPhase({ receivedAtMs: t0, migratedAtMs: t0 + 60_000, nowMs: t0 + 61_000 + 30 * 60_000 })).toBe("post-fast");
    expect(trackPhase({ receivedAtMs: t0, migratedAtMs: t0 + 60_000, nowMs: t0 + 61_000 + 2 * 3_600_000 })).toBe("post-slow");
    expect(trackPhase({ receivedAtMs: t0, migratedAtMs: t0 + 60_000, nowMs: t0 + 61_000 + 49 * 3_600_000 })).toBe("done");
  });

  it("intervalForPhase suit les cadences du protocole", () => {
    expect(intervalForPhase("pre")).toBe(PRE_INTERVAL_MS);
    expect(intervalForPhase("post-fast")).toBe(POST_FAST_INTERVAL_MS);
    expect(intervalForPhase("post-slow")).toBe(POST_SLOW_INTERVAL_MS);
    expect(intervalForPhase("done")).toBeNull();
  });
});

describe("isMigratedDex", () => {
  it("pumpfun → pas migré ; autre dex → migré ; null → pas d'info", () => {
    expect(isMigratedDex("pumpfun")).toBe(false);
    expect(isMigratedDex("raydium")).toBe(true);
    expect(isMigratedDex("pumpswap")).toBe(true);
    expect(isMigratedDex(null)).toBe(false);
    expect(isMigratedDex(undefined)).toBe(false);
  });
});

describe("admitToSample", () => {
  it("refuse au-delà du cap, sans tronquer les en-cours", () => {
    expect(admitToSample(MAX_ACTIVE_TOKENS - 1)).toBe(true);
    expect(admitToSample(MAX_ACTIVE_TOKENS)).toBe(false);
    expect(admitToSample(MAX_ACTIVE_TOKENS + 500)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ingestScanFiles — bout en bout sur fichiers temporaires
// ---------------------------------------------------------------------------

/** Trouve des mints déterministiquement échantillonnés (ou non) pour un seed donné. */
function findMints(seedDate: string, want: boolean, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n && i < 100000; i++) {
    const mint = `TestMint${want ? "In" : "Out"}${i}1111111111111111111111`;
    if (sampledFor(seedDate, mint) === want) out.push(mint);
  }
  expect(out.length).toBe(n);
  return out;
}

describe("ingestScanFiles", () => {
  let scanDir: string;
  let dataDir: string;
  const nowMs = Date.UTC(2026, 8, 28, 12, 0, 0);
  const nowIso = new Date(nowMs).toISOString();
  const seedDate = "2026-09-28";

  beforeEach(() => {
    scanDir = mkdtempSync(join(tmpdir(), "track-scan-"));
    dataDir = mkdtempSync(join(tmpdir(), "track-data-"));
  });

  function writeScan(lines: object[]): void {
    writeFileSync(join(scanDir, `pump-${seedDate}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  function makeCtx() {
    return {
      manifests: new Map<string, DayManifest>(),
      knownMints: new Set<string>(),
      state: { scanOffsets: {} as Record<string, number>, lastGitSyncAt: null as number | null },
      nowMs,
    };
  }

  it("échantillonne les genuine, ignore les late-discovery, déduplique les mints", () => {
    const [in1, in2] = findMints(seedDate, true, 2);
    const [out1] = findMints(seedDate, false, 1);
    writeScan([
      { kind: "create", mint: in1!, symbol: "IN1", receivedAt: nowIso, raw: { vSolInBondingCurve: 31.5, solAmount: 1.5 } },
      { kind: "create", mint: in2!, symbol: "IN2", receivedAt: nowIso, raw: { vSolInBondingCurve: 40, solAmount: 2 } },
      { kind: "create", mint: "Late11111111111111111111111111111111111111", receivedAt: nowIso, raw: { vSolInBondingCurve: 115.005359056806, solAmount: 85.005359057 } },
      { kind: "create", mint: out1!, symbol: "OUT", receivedAt: nowIso, raw: { vSolInBondingCurve: 31.5 } },
      { kind: "create", mint: in1!, symbol: "IN1-DUP", receivedAt: nowIso, raw: { vSolInBondingCurve: 31.5 } }, // doublon
      { kind: "migrate", mint: in1!, receivedAt: nowIso },
    ]);
    const stats = ingestScanFiles({ scanDir, dataDir, ctx: makeCtx() });
    expect(stats.createsSeen).toBe(4); // doublon exclu
    expect(stats.lateDiscoverySeen).toBe(1);
    expect(stats.sampled).toBe(2);
    expect(stats.migratesSeen).toBe(1);
  });

  it("les entrées échantillonnées portent les bons champs et le migrate bascule en post", () => {
    const [in1] = findMints(seedDate, true, 1);
    writeScan([
      { kind: "create", mint: in1!, symbol: "IN1", receivedAt: nowIso, raw: { vSolInBondingCurve: 31.5 } },
      { kind: "migrate", mint: in1!, receivedAt: nowIso },
    ]);
    const ctx = makeCtx();
    ingestScanFiles({ scanDir, dataDir, ctx });
    const m = ctx.manifests.get(seedDate);
    expect(m).toBeDefined();
    const e = m!.tracked[in1!]!;
    expect(e.status).toBe("post");
    expect(e.migrationSource).toBe("event");
    expect(e.migratedAt).toBe(nowIso);
    expect(e.seedDate).toBe(seedDate);
    expect(e.discoveredAt).toBe(nowIso);
    expect(e.lastSnapshotAt).toBeNull();
    expect(m!.counters.sampled).toBe(1);
  });

  it("ne ré-ingère pas les mêmes lignes deux fois (offsets)", () => {
    const [in1] = findMints(seedDate, true, 1);
    writeScan([{ kind: "create", mint: in1!, receivedAt: nowIso, raw: { vSolInBondingCurve: 31.5 } }]);
    const ctx = makeCtx();
    const s1 = ingestScanFiles({ scanDir, dataDir, ctx });
    const s2 = ingestScanFiles({ scanDir, dataDir, ctx });
    expect(s1.sampled).toBe(1);
    expect(s2.createsSeen).toBe(0);
    expect(s2.sampled).toBe(0);
  });

  it("n'échantillonne pas les creates dont la fenêtre de 12 h est déjà écoulée (bootstrap)", () => {
    const oldSeed = "2026-09-27";
    const [in1] = findMints(oldSeed, true, 1);
    const oldIso = new Date(nowMs - 13 * 3_600_000).toISOString(); // 2026-09-27T23:00Z
    writeScan([
      { kind: "create", mint: in1!, receivedAt: oldIso, raw: { vSolInBondingCurve: 31.5 } },
    ]);
    const ctx = makeCtx();
    const stats = ingestScanFiles({ scanDir, dataDir, ctx });
    expect(stats.createsSeen).toBe(1);
    expect(stats.sampled).toBe(0);
    expect(stats.expiredSeen).toBe(1);
    const m = ctx.manifests.get(oldSeed);
    expect(m!.counters.expiredSeen).toBe(1);
    expect(Object.keys(m!.tracked).length).toBe(0);
  });

  it("au-delà du cap : nouveaux refusés avec motif, en-cours intacts", () => {
    const ins = findMints(seedDate, true, 3);
    const ctx = makeCtx();
    // Pré-remplit le manifest au cap.
    const m: DayManifest = {
      version: 1,
      seedDate,
      p: 0.05,
      startedAt: nowIso,
      updatedAt: nowIso,
      tracked: {},
      dropped: [],
      counters: { createsSeen: 0, lateDiscoverySeen: 0, sampled: 0, snapshots: 0, migratesSeen: 0, expiredSeen: 0 },
    };
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      const mint = `CapMint${i}1111111111111111111111111111111111`;
      const e: TrackedEntry = {
        mint,
        symbol: null,
        seedDate,
        receivedAt: nowIso,
        discoveredAt: nowIso,
        status: "pre",
        migratedAt: null,
        migrationSource: null,
        lastSnapshotAt: nowIso,
        snapshots: 1,
      };
      m.tracked[mint] = e;
      ctx.knownMints.add(mint);
    }
    ctx.manifests.set(seedDate, m);
    writeScan(ins.map((mint) => ({ kind: "create", mint, receivedAt: nowIso, raw: { vSolInBondingCurve: 31.5 } })));
    const stats = ingestScanFiles({ scanDir, dataDir, ctx });
    expect(stats.sampled).toBe(0);
    expect(stats.droppedCap).toBe(3);
    expect(m.dropped.length).toBe(3);
    expect(m.dropped[0]!.reason).toBe("cap-200");
    expect(Object.keys(m.tracked).length).toBe(MAX_ACTIVE_TOKENS); // en-cours intacts
  });
});

// ---------------------------------------------------------------------------
// snapshotDueEntries — avec un client DexScreener simulé
// ---------------------------------------------------------------------------

describe("snapshotDueEntries", () => {
  let dataDir: string;
  const nowMs = Date.UTC(2026, 8, 28, 12, 0, 0);
  const nowIso = new Date(nowMs).toISOString();
  const seedDate = "2026-09-28";

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "track-snap-"));
  });

  function entry(over: Partial<TrackedEntry> = {}): TrackedEntry {
    return {
      mint: "SnapMint1111111111111111111111111111111111",
      symbol: "SNAP",
      seedDate,
      receivedAt: new Date(nowMs - 60_000).toISOString(),
      discoveredAt: new Date(nowMs - 60_000).toISOString(),
      status: "pre",
      migratedAt: null,
      migrationSource: null,
      lastSnapshotAt: null,
      snapshots: 0,
      ...over,
    };
  }

  function manifestWith(e: TrackedEntry): DayManifest {
    return {
      version: 1,
      seedDate,
      p: 0.05,
      startedAt: nowIso,
      updatedAt: nowIso,
      tracked: { [e.mint]: e },
      dropped: [],
      counters: { createsSeen: 1, lateDiscoverySeen: 0, sampled: 1, snapshots: 0, migratesSeen: 0, expiredSeen: 0 },
    };
  }

  it("écrit le snapshot avec les métadonnées tracker", async () => {
    const e = entry();
    const m = manifestWith(e);
    const dex: SnapshotProvider = {
      getSnapshots: async (mints: string[]) =>
        mints.map((mint) => makeSnapshot({ mint, fetchedAt: nowIso, dexId: "pumpfun", priceUsd: 0.001, liquidityUsd: 1000 })),
    };
    const stats = await snapshotDueEntries({
      dex,
      dataDir,
      ctx: { manifests: new Map([[seedDate, m]]), knownMints: new Set([e.mint]), state: { scanOffsets: {}, lastGitSyncAt: null }, nowMs },
    });
    expect(stats.written).toBe(1);
    const f = join(dataDir, seedDate, `${e.mint}.jsonl`);
    expect(existsSync(f)).toBe(true);
    const line = JSON.parse(readFileSync(f, "utf8").split("\n")[0]!);
    expect(line.mint).toBe(e.mint);
    expect(line.tracker.seedDate).toBe(seedDate);
    expect(line.tracker.receivedAt).toBe(e.receivedAt);
    expect(e.status).toBe("pre"); // toujours pré-migration
    expect(e.snapshots).toBe(1);
  });

  it("bascule en post quand le dexId n'est plus pumpfun (migration vue par snapshot)", async () => {
    const e = entry();
    const m = manifestWith(e);
    const dex: SnapshotProvider = {
      getSnapshots: async (mints: string[]) =>
        mints.map((mint) => makeSnapshot({ mint, fetchedAt: nowIso, dexId: "raydium", priceUsd: 0.002, liquidityUsd: 50000 })),
    };
    const stats = await snapshotDueEntries({
      dex,
      dataDir,
      ctx: { manifests: new Map([[seedDate, m]]), knownMints: new Set([e.mint]), state: { scanOffsets: {}, lastGitSyncAt: null }, nowMs },
    });
    expect(stats.migratedByDex).toBe(1);
    expect(e.status).toBe("post");
    expect(e.migrationSource).toBe("dex");
    expect(e.migratedAt).toBe(nowIso);
  });

  it("les erreurs DexScreener sont non fatales (réessai au prochain tick)", async () => {
    const e = entry();
    const m = manifestWith(e);
    const dex: SnapshotProvider = {
      getSnapshots: async (_mints: string[]) => {
        throw new Error("rate limit");
      },
    };
    const stats = await snapshotDueEntries({
      dex,
      dataDir,
      ctx: { manifests: new Map([[seedDate, m]]), knownMints: new Set([e.mint]), state: { scanOffsets: {}, lastGitSyncAt: null }, nowMs },
    });
    expect(stats.errors).toBe(1);
    expect(stats.written).toBe(0);
    expect(e.status).toBe("pre"); // intact, réessayé plus tard
    const dayDir = join(dataDir, seedDate);
    expect(!existsSync(dayDir) || readdirSync(dayDir).filter((f) => f.endsWith(".jsonl")).length === 0).toBe(true);
  });

  it("un token au-delà de sa fenêtre passe en done sans snapshot", async () => {
    const e = entry({ receivedAt: new Date(nowMs - 13 * 3_600_000).toISOString() });
    const m = manifestWith(e);
    let called = false;
    const dex: SnapshotProvider = {
      getSnapshots: async (_mints: string[]) => {
        called = true;
        return [];
      },
    };
    const stats = await snapshotDueEntries({
      dex,
      dataDir,
      ctx: { manifests: new Map([[seedDate, m]]), knownMints: new Set([e.mint]), state: { scanOffsets: {}, lastGitSyncAt: null }, nowMs },
    });
    expect(e.status).toBe("done");
    expect(stats.due).toBe(0);
    expect(called).toBe(false);
  });
});
