import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBrief, writeBrief, SECTIONS, NO_DATA } from "../lab/brief/generate.ts";
import type { ScanResult } from "../lab/collect/types.ts";
import { loadFixture } from "./helpers/fakeFetch.ts";
import { snapshotsFromPairs, type DexPairsResponse } from "../lab/collect/dexscreener.ts";
import { parseListing } from "../lab/collect/reddit.ts";

const NOW = Date.UTC(2026, 8, 24, 10, 0, 0);
const tmpDirs: string[] = [];
function root(): string {
  const d = mkdtempSync(join(tmpdir(), "brief-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedFull(dir: string) {
  mkdirSync(join(dir, "data", "scans"), { recursive: true });
  mkdirSync(join(dir, "data", "signals"), { recursive: true });
  mkdirSync(join(dir, "data", "narratives"), { recursive: true });
  mkdirSync(join(dir, "data", "wallets"), { recursive: true });
  mkdirSync(join(dir, "ledger"), { recursive: true });
  mkdirSync(join(dir, "journal"), { recursive: true });
  const pairs = loadFixture<DexPairsResponse>("dexscreener/latest-dex-tokens.json").pairs ?? [];
  const scan: ScanResult = {
    startedAt: "2026-09-24T09:45:00.000Z",
    finishedAt: "2026-09-24T09:46:00.000Z",
    profiles: [],
    boosts: [{ chainId: "solana", tokenAddress: "AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump", url: "", description: null, links: [], icon: null, amount: 100, totalAmount: 530 }],
    tokens: snapshotsFromPairs(pairs, "2026-09-24T09:46:00.000Z"),
    reddit: parseListing(loadFixture("reddit/solana-new.json")),
    github: [
      { fullName: "sendaifun/solana-agent-kit", url: "", description: "Connect any AI agents to Solana", stars: 412, language: "TypeScript", topics: [], createdAt: "", pushedAt: "", tickers: [], mints: [] },
    ],
    errors: [{ source: "reddit:r/memecoins", message: "Reddit 429" }],
    requests: { dexscreener: 3, reddit: 3, github: 2 },
  };
  writeFileSync(join(dir, "data", "scans", "2026-09-24T09-46-00-000Z.json"), JSON.stringify(scan));
  writeFileSync(
    join(dir, "data", "scans", "pump-2026-09-24.jsonl"),
    [
      { kind: "create", mint: "M1", receivedAt: "2026-09-24T08:00:00.000Z", symbol: "AAA" },
      { kind: "create", mint: "M2", receivedAt: "2026-09-24T08:01:00.000Z", symbol: "BBB" },
      { kind: "migrate", mint: "M1", receivedAt: "2026-09-24T09:00:00.000Z", symbol: "AAA" },
      { kind: "create", mint: "M0", receivedAt: "2026-09-20T09:00:00.000Z", symbol: "OLD" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "data", "signals", "volume-2026-09-24T09-46-00-000Z.json"),
    JSON.stringify({
      computedAt: "2026-09-24T09:46:00.000Z",
      signals: [
        { mint: "AgentZk3xdkPQuMgHRjZgV1oTuE9DDfcFcayP1fvpump", score: 72, eligible: true, reasons: ["volume 5 min 91000 $ vs moyenne 9000 $ (z=6.10)"], components: {}, computedAt: "" },
        { mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", score: 12, eligible: true, reasons: [], components: {}, computedAt: "" },
      ],
    }),
  );
  writeFileSync(
    join(dir, "data", "narratives", "2026-09-24.json"),
    JSON.stringify({ computedAt: "2026-09-24T09:46:00.000Z", terms: [{ term: "agents", count24h: 6, docs24h: 4, baselinePerDay: 0.3, count7d: 2, growth: 5.4, sources: { reddit: 4, github: 2 } }] }),
  );
  writeFileSync(
    join(dir, "data", "wallets", "A1phaSn1perWa11etXyZ123456789abcdefghjkmnopq.json"),
    JSON.stringify({ address: "A1phaSn1perWa11etXyZ123456789abcdefghjkmnopq", recurrence: 4, universe: 5, score: 70, avgRank: 1.5, appearances: [], computedAt: "" }),
  );
  writeFileSync(
    join(dir, "ledger", "trades.jsonl"),
    [
      { intentId: "i1", decision: "PAPER", createdAt: "2026-09-23T12:00:00.000Z", pnl: 12.5, mint: "X" },
      { intentId: "i2", decision: "PAPER", createdAt: "2026-09-23T18:00:00.000Z", pnl: -20, mint: "Y" },
      { intentId: "i3", decision: "REJECTED", createdAt: "2026-09-24T08:00:00.000Z", reasons: ["liquidity_below_min", "token_too_young"] },
      { intentId: "i4", decision: "REJECTED", createdAt: "2026-09-24T09:00:00.000Z", reasons: ["liquidity_below_min"] },
      { intentId: "i5", decision: "EXECUTED", createdAt: "2026-09-24T09:30:00.000Z", pnl: 4, mint: "Z" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "journal", "hypotheses.jsonl"),
    [
      { id: "H1", createdAt: "2026-09-20T00:00:00.000Z", hypothesis: "early-buyer overlap prédit la migration", signal: "earlybuyers" },
      { id: "H2", createdAt: "2026-09-21T00:00:00.000Z", hypothesis: "volume z>4 précède +50 %", signal: "volume", result: "rejetée", return: -0.1 },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
}

describe("brief", () => {
  it("dépôt vide : 9 sections présentes, toutes « aucune donnée » ou explicitement sans source", () => {
    const dir = root();
    const r = generateBrief({ rootDir: dir, now: () => NOW });
    expect(r.date).toBe("2026-09-24");
    for (const s of SECTIONS) expect(r.markdown).toContain(`## ${s}`);
    expect(r.sections.MARKET).toEqual([]);
    expect(r.markdown.split(NO_DATA).length - 1).toBeGreaterThanOrEqual(6);
    expect(r.sections.UNKNOWN.some((l) => l.includes("MARKET vide"))).toBe(true);
    expect(r.sections.UNKNOWN.some((l) => l.includes("X/Twitter"))).toBe(true);
    // Aucun chiffre inventé : pas de « $ » dans MARKET/OPPORTUNITIES.
    expect(r.sections.OPPORTUNITIES).toEqual([]);
  });

  it("dépôt garni : chaque section chiffrée cite un fichier source", () => {
    const dir = root();
    seedFull(dir);
    const r = generateBrief({ rootDir: dir, now: () => NOW });
    expect(r.sections.MARKET[0]).toMatch(/3 tokens suivis/);
    expect(r.sections.MARKET[0]).toContain("(source : data/scans/2026-09-24T09-46-00-000Z.json)");
    expect(r.sections.MARKET.some((l) => l.includes("530 boosts"))).toBe(true);
    expect(r.sections.NARRATIVES.some((l) => l.includes("« agents »") && l.includes("x5.4"))).toBe(true);
    expect(r.sections["ON-CHAIN"][0]).toMatch(/2 créations, 1 migrations/);
    expect(r.sections["ON-CHAIN"][0]).toContain("data/scans/pump-2026-09-24.jsonl");
    expect(r.sections["ON-CHAIN"].some((l) => l.includes("50.0 %"))).toBe(true);
    expect(r.sections["ON-CHAIN"].some((l) => l.includes("A1phaSn1perWa11etXyZ123456789abcdefghjkmnopq") && l.includes("4/5"))).toBe(true);
    expect(r.sections.OPPORTUNITIES[0]).toMatch(/1 tokens avec signal volume ≥ 40/);
    expect(r.sections.OPPORTUNITIES[0]).toMatch(/pas des ordres/);
    expect(r.sections.DEV.some((l) => l.includes("sendaifun/solana-agent-kit : 412 ★"))).toBe(true);
    expect(r.sections.TRADING[0]).toMatch(/5 sur 24 h — exécutés 1, paper 2, rejetés 2/);
    expect(r.sections.TRADING[1]).toMatch(/PnL cumulé -3\.50 \$ sur 3 trades/);
    expect(r.sections.RISKS.some((l) => l.includes("2 intents rejetés") && l.includes("liquidity_below_min (2)"))).toBe(true);
    expect(r.sections.RISKS.some((l) => l.includes("Drawdown max") && l.includes("20.00 $"))).toBe(true);
    expect(r.sections.RISKS.some((l) => l.includes("1 erreurs de collecte"))).toBe(true);
    expect(r.sections.AUTOMATION[0]).toMatch(/requêtes DexScreener 3, Reddit 3, GitHub 2/);
    expect(r.sections.UNKNOWN.some((l) => l.includes("1 hypothèses sans résultat") && l.includes("H1"))).toBe(true);
    // Toute ligne contenant un chiffre suivi de $ ou % cite une source.
    const numeric = Object.values(r.sections).flat().filter((l) => /\d+(\.\d+)? (\$|%)/.test(l));
    expect(numeric.length).toBeGreaterThan(5);
    for (const l of numeric) expect(l, l).toMatch(/\(source : [^)]+\)|docs\/research/);
  });

  it("signale les données périmées et le fichier KILL", () => {
    const dir = root();
    seedFull(dir);
    writeFileSync(join(dir, "KILL"), "stop");
    const later = NOW + 5 * 3_600_000;
    const r = generateBrief({ rootDir: dir, now: () => later });
    expect(r.sections.RISKS[0]).toMatch(/KILL présent/);
    expect(r.sections.RISKS.some((l) => /âgées de 5\.\d h/.test(l))).toBe(true);
  });

  it("writeBrief écrit briefs/YYYY-MM-DD.md et respecte une date imposée", () => {
    const dir = root();
    seedFull(dir);
    const r = writeBrief({ rootDir: dir, now: () => NOW, date: "2026-09-25" });
    expect(r.path).toBe(join(dir, "briefs", "2026-09-25.md"));
    expect(existsSync(r.path)).toBe(true);
    const md = readFileSync(r.path, "utf8");
    expect(md.startsWith("# Brief du 2026-09-25")).toBe(true);
    expect(md.indexOf("## MARKET")).toBeLessThan(md.indexOf("## UNKNOWN"));
  });

  it("tolère les fichiers corrompus sans planter", () => {
    const dir = root();
    mkdirSync(join(dir, "data", "scans"), { recursive: true });
    mkdirSync(join(dir, "ledger"), { recursive: true });
    writeFileSync(join(dir, "data", "scans", "2026-09-24T00-00-00-000Z.json"), "{ pas du json");
    writeFileSync(join(dir, "ledger", "trades.jsonl"), "{}\nnope\n" + JSON.stringify({ decision: "PAPER", createdAt: "2026-09-24T09:00:00.000Z" }) + "\n");
    const r = generateBrief({ rootDir: dir, now: () => NOW });
    expect(r.sections.MARKET).toEqual([]);
    expect(r.sections.TRADING[0]).toMatch(/2 lignes au total/);
  });
});
