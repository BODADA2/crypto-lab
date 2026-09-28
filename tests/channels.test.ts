import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { eligibleCalls, evaluateChannels, fourQuestionsGreen, H6_START, toSnapshot } from "../lab/backtest/preregistered-channels.ts";
import type { Call } from "../lab/collect/telegram.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const call = (address: string, postedMs: number, lagMs = 60_000, chain: Call["chain"] = "solana", channel = "c1"): Call =>
  ({ channel, postId: 1, postedAt: iso(postedMs), seenAt: iso(postedMs + lagMs), chain, chainTag: null, address, symbol: "X", text: "" }) as Call;

describe("hypothèse 6 — les 4 questions sur 14 canaux", () => {
  it("ne juge que les calls publiés après le départ, vus en direct, tradables, un par adresse", () => {
    const t = H6_START + 3_600_000;
    const got = eligibleCalls([
      call("A", H6_START - 60_000), // avant le départ
      call("B", t, 45 * 60_000), // vu trop tard
      call("C", t, 60_000, "other"), // chaîne non tradable
      call("D", t),
      call("D", t + 60_000, 60_000, "solana", "c2"), // doublon d'adresse
    ]);
    expect(got.map((c) => `${c.address}@${c.channel}`)).toEqual(["D@c1"]);
  });

  it("vert seulement si l'argent entre ET pas de piège (liquidité ≥ 20 k$, pas −50 % depuis le call)", () => {
    const s = (p: number, l: number, v5: number, b5: number, s5: number) => toSnapshot("M", { t: iso(H6_START), p, l, v5, b5, s5 })!;
    expect(fourQuestionsGreen(s(1, 30_000, 2_000, 10, 5), 1)).toBe(true);
    expect(fourQuestionsGreen(s(1, 30_000, 1_000, 10, 5), 1)).toBe(false); // volume < 5 % de la liquidité
    expect(fourQuestionsGreen(s(1, 30_000, 2_000, 4, 5), 1)).toBe(false); // plus de ventes
    expect(fourQuestionsGreen(s(1, 15_000, 2_000, 10, 5), 1)).toBe(false); // liquidité trop faible
    expect(fourQuestionsGreen(s(0.4, 30_000, 2_000, 10, 5), 1)).toBe(false); // −60 % depuis le call
  });

  it("simule un trade sur données compactes et rend un verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "h6-"));
    mkdirSync(join(dir, "history"));
    const t0 = H6_START + 3_600_000;
    writeFileSync(join(dir, "calls.jsonl"), JSON.stringify(call("Tok", t0)) + "\n");
    const rows = [0, 1, 2, 3].map((i) => ({ t: iso(t0 + 60_000 + i * 900_000), p: i < 2 ? 1 : 2, l: 30_000, v5: 2_000, b5: 10, s5: 5 }));
    writeFileSync(join(dir, "history", "Tok.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = evaluateChannels(dir);
    expect(r.eligible).toBe(1);
    expect(r.verdict.a.n).toBe(1);
    expect(r.verdict.a.winRate).toBe(1);
    expect(r.verdict.verdict).toBe("NON CONCLUANT");
  });
});
