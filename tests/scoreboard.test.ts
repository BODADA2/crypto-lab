import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildBoard, channelStats, measureCall, parseObs, renderHtml, type CallResult } from "../lab/scoreboard/build.ts";
import { mergeNewCalls, type Call } from "../lab/collect/telegram.ts";
import { toCompact } from "../lab/collect/calls.ts";
import { snapshotsFromPairs } from "../lab/collect/dexscreener.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-09-26T12:00:00Z");
const call = (over: Partial<Call> = {}): Call => ({ channel: "chan", postId: 1, postedAt: new Date(T0).toISOString(), seenAt: new Date(T0 + 5 * 60_000).toISOString(), chain: "solana", chainTag: "SOL", address: "Addr1111111111111111111111111111111pump", symbol: "CAT", text: "", ...over });
const o = (h: number, p: number, l = 30_000) => ({ t: T0 + 10 * 60_000 + h * H, p, l });

describe("Honest Calls — mesure d'un call", () => {
  it("départ = 1re observation après le call ; résultat à 24 h ; plus haut sur 24 h", () => {
    const r = measureCall(call(), [o(-1, 0.5), o(0, 1), o(3, 2.5), o(24, 0.4)], T0 + 30 * H);
    expect(r).toMatchObject({ status: "judged", p0: 1, maxX: 2.5, vanished: false });
    expect(r.ret).toBeCloseTo(-0.6);
  });
  it("un token disparu des données avant 24 h compte −100 %", () => {
    const r = measureCall(call(), [o(0, 1), o(2, 0.3)], T0 + 30 * H);
    expect(r).toMatchObject({ status: "judged", ret: -1, vanished: true });
  });
  it("moins de 24 h de recul : en cours ; arriéré et chaînes non suivies : exclus", () => {
    expect(measureCall(call(), [o(0, 1), o(2, 1.5)], T0 + 3 * H).status).toBe("early");
    expect(measureCall(call({ seenAt: new Date(T0 + 2 * H).toISOString() }), [o(3, 1)], T0 + 30 * H).status).toBe("backlog");
    expect(measureCall(call({ chain: "other" }), [], T0).status).toBe("out-of-scope");
    expect(measureCall(call(), [], T0).status).toBe("no-data");
  });
  it("statistiques par canal : médiane, ×2, moitié perdue, copieur après frais, classement dès 10 calls", () => {
    const rs: CallResult[] = [0.5, -0.8, -1, 0.1].map((ret, i) => ({ channel: "chan", symbol: null, chain: "solana", address: "a" + i, postedAt: "", status: "judged", ret, maxX: i === 0 ? 2.2 : 1.1 }));
    const s = channelStats("chan", rs);
    expect(s).toMatchObject({ judged: 4, hitX2: 0.25, halved: 0.5, ranked: false });
    expect(s.median24).toBeCloseTo(-0.35);
    expect(s.copier).toBeCloseTo(((1.5 + 0.2 + 0 + 1.1) * 0.987) / 4 - 1);
  });
  it("lit le format complet et le format compact", () => {
    const snap = snapshotsFromPairs([{ chainId: "solana", dexId: "x", pairAddress: "P", baseToken: { address: "M", symbol: "M", name: "M" }, priceUsd: "2", liquidity: { usd: 40_000 }, volume: { m5: 1 }, txns: { m5: { buys: 3, sells: 1 } }, pairCreatedAt: 1 } as never], "2026-09-26T12:00:00Z")[0]!;
    const full = parseObs(JSON.stringify(snap));
    const compact = parseObs(JSON.stringify(toCompact(snap)));
    expect(full).toEqual({ t: T0, p: 2, l: 40_000, sym: "M" });
    expect(compact).toEqual(full);
    expect(toCompact(snap)).toMatchObject({ v5: 1, b5: 3, s5: 1 });
  });
});

describe("Honest Calls — plusieurs canaux", () => {
  it("deux canaux qui annoncent le même token ont chacun leur call", () => {
    const a = call({ channel: "a", postId: 1 });
    const b = call({ channel: "b", postId: 7 });
    expect(mergeNewCalls([], [a, b]).map((c) => c.channel)).toEqual(["a", "b"]);
    expect(mergeNewCalls([a], [{ ...a, postId: 2 }])).toEqual([]);
  });
  it("de bout en bout : page autonome avec les données incluses", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-"));
    mkdirSync(join(dir, "history"));
    writeFileSync(join(dir, "calls.jsonl"), JSON.stringify(call()) + "\n");
    writeFileSync(join(dir, "history", "Addr1111111111111111111111111111111pump.jsonl"), [o(0, 1), o(24, 3)].map((x) => JSON.stringify({ t: new Date(x.t).toISOString(), p: x.p, l: x.l })).join("\n") + "\n");
    const board = buildBoard([dir], T0 + 30 * H);
    expect(board.channels[0]).toMatchObject({ channel: "chan", judged: 1, median24: 2 });
    const html = renderHtml(board);
    expect(html).toContain('"channel":"chan"');
    expect(html).not.toContain("/*__BOARD__*/");
  });
});
