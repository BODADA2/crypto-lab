import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadDailyStatsFromScans,
  computeChainRegimes,
  formatRegimeBriefLines,
  type DailyChainStats,
} from "../lab/collect/chainregime.ts";

const stats = (date: string, creates: number, migrates = 0): DailyChainStats => ({
  chain: "solana",
  date,
  creates,
  migrates,
  totalSolIn: creates * 2,
  medianMcapSol: 30,
});

describe("computeChainRegimes", () => {
  it("classe famine / calme / normal / chaud / frénésie par percentile", () => {
    // Base : 7 jours à 100 créations. Jour testé à 100 → percentile 100 → frénésie ;
    // à 50 → famine.
    const base = Array.from({ length: 7 }, (_, i) => stats(`2026-09-${String(i + 1).padStart(2, "0")}`, 100));
    const high = computeChainRegimes([...base, stats("2026-09-08", 100)]);
    expect(high[high.length - 1]?.regime).toBe("frénésie");
    const low = computeChainRegimes([...base, stats("2026-09-08", 50)]);
    expect(low[low.length - 1]?.regime).toBe("famine");
  });

  it("calcule le taux de migration et le percentile", () => {
    const base = Array.from({ length: 7 }, (_, i) => stats(`2026-09-${String(i + 1).padStart(2, "0")}`, 100, 2));
    const regs = computeChainRegimes([...base, stats("2026-09-08", 120, 6)]);
    const last = regs[regs.length - 1]!;
    expect(last.migrationRate).toBeCloseTo(0.05, 10);
    expect(last.createsPercentile).toBe(100);
  });

  it("régime 'inconnu' avec moins de 3 jours d'historique (NO ACTION)", () => {
    const regs = computeChainRegimes([stats("2026-09-01", 100), stats("2026-09-02", 120)]);
    expect(regs.every((r) => r.regime === "inconnu")).toBe(true);
    expect(regs[0]?.createsPercentile).toBeNull();
  });

  it("chaque chaîne est notée sur SON propre passé uniquement", () => {
    const sol = Array.from({ length: 7 }, (_, i) => stats(`2026-09-${String(i + 1).padStart(2, "0")}`, 100));
    const base2 = sol.map((s) => ({ ...s, chain: "base", creates: 10 }));
    const regs = computeChainRegimes([...sol, ...base2, { ...stats("2026-09-08", 10), chain: "base" }]);
    const baseReg = regs.find((r) => r.chain === "base" && r.date === "2026-09-08");
    // 10 créations vs base « base » à 10 → percentile 100 → frénésie (pas famine).
    expect(baseReg?.regime).toBe("frénésie");
  });

  it("la briefLine cite les chiffres clés", () => {
    const base = Array.from({ length: 7 }, (_, i) => stats(`2026-09-${String(i + 1).padStart(2, "0")}`, 100, 3));
    const regs = computeChainRegimes([...base, stats("2026-09-08", 100, 3)]);
    const line = regs[regs.length - 1]?.briefLine ?? "";
    expect(line).toMatch(/solana/);
    expect(line).toMatch(/2026-09-08/);
    expect(line).toMatch(/100/);
  });
});

describe("formatRegimeBriefLines", () => {
  it("renvoie 'aucune donnée' sans régimes", () => {
    const lines = formatRegimeBriefLines([], "data/scans/");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/aucune donnée/);
  });
  it("une ligne par chaîne (la plus récente)", () => {
    const base = Array.from({ length: 7 }, (_, i) => stats(`2026-09-${String(i + 1).padStart(2, "0")}`, 100));
    const regs = computeChainRegimes([...base, stats("2026-09-08", 100), stats("2026-09-09", 100)]);
    const lines = formatRegimeBriefLines(regs, "data/scans/");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2026-09-09");
    expect(lines[0]).toContain("data/scans/");
  });
});

describe("loadDailyStatsFromScans", () => {
  it("agrège creates / migrates / SOL / mcap médiane par fichier", () => {
    const dir = mkdtempSync(join(tmpdir(), "chainregime-"));
    try {
      const lines = [
        JSON.stringify({ kind: "create", mint: "a", solAmount: 3, marketCapSol: 30 }),
        JSON.stringify({ kind: "create", mint: "b", solAmount: 5, marketCapSol: 50 }),
        JSON.stringify({ kind: "create", mint: "c", solAmount: 1, marketCapSol: 10 }),
        JSON.stringify({ kind: "migrate", mint: "a" }),
        "ligne corrompue",
        "",
      ].join("\n");
      writeFileSync(join(dir, "pump-2026-09-26.jsonl"), lines);
      writeFileSync(join(dir, "notes.txt"), "ignoré");
      const out = loadDailyStatsFromScans(dir);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ chain: "solana", date: "2026-09-26", creates: 3, migrates: 1, totalSolIn: 9, medianMcapSol: 30 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("renvoie [] sans répertoire", () => {
    expect(loadDailyStatsFromScans("/chemin/inexistant")).toEqual([]);
  });
});
