import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { callsToPoll, CALL_TRACK_MS, runCalls } from "../lab/collect/calls.ts";
import { snapshotsFromPairs } from "../lab/collect/dexscreener.ts";
import { extractAddress, extractChainTag, mergeNewCalls, parseChannelPage, type Call } from "../lab/collect/telegram.ts";
import { evaluateCalls, h3Signal, h4Signal } from "../lab/backtest/preregistered-calls.ts";

const SOL_CA = "2pawBaYZZkirQMSFRUDR5xkovFJVUfuM31Jort35pump";
const RBH_CA = "0x7e84eEe12F356b568E6B847fAa05E19cFE4A5f4E";

// Structure réelle de t.me/s/<canal> (septembre 2026), URL et attributs superflus retirés.
const msg = (id: number, iso: string, body: string, reply = "") => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="mad_apes_gambles/${id}">
<div class="tgme_widget_message_bubble">${reply}<div class="tgme_widget_message_text js-message_text" dir="auto">${body}</div>
<div class="tgme_widget_message_footer"><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date"><time datetime="${iso}" class="time">13:06</time></a></span></div></div></div></div>`;
const reply = `<a class="tgme_widget_message_reply"><div class="tgme_widget_message_text js-message_reply_text" dir="auto">( SOL) APE ${SOL_CA}</div></a>`;
const PAGE = [
  msg(226582, "2026-09-25T13:41:00+00:00", `(<tg-emoji><i class="emoji"><b>🔥</b></i></tg-emoji>SOL) APE<br>Gambles Channel<br><br>$APE - Apes At Work meme. Disclaimer <a href="https://x.com/trenchDeploys/status/2103477408326418765">https://x.com/trenchDeploys/status/2103477408326418765</a> <code>${SOL_CA}</code>`),
  msg(226590, "2026-09-25T13:58:00+00:00", `3.5x, 11M <b>$APE</b>`, reply),
  msg(226594, "2026-09-25T15:20:00+00:00", `( 🔥RBH) Louis<br>Gambles Channel<br>$LOUIS is the confirmed Meta cat name. <code>${RBH_CA}</code>`),
  msg(226596, "2026-09-25T15:30:00+00:00", `( 🔥SOL) APE again<br><code>${SOL_CA}</code>`),
].join("\n");

describe("hypothèses 3–4 — lecture des calls Telegram", () => {
  it("extrait adresse, chaîne et ticker ; ignore les updates qui citent un ancien call", () => {
    const { calls, oldestPostId } = parseChannelPage(PAGE, "mad_apes_gambles", "2026-09-25T16:00:00Z");
    expect(oldestPostId).toBe(226582);
    expect(calls.map((c) => [c.postId, c.chain, c.chainTag, c.address, c.symbol])).toEqual([
      [226582, "solana", "SOL", SOL_CA, "APE"],
      [226594, "robinhood", "RBH", RBH_CA, "LOUIS"],
      [226596, "solana", "SOL", SOL_CA, null],
    ]);
    expect(calls[0]?.postedAt).toBe("2026-09-25T13:41:00.000Z");
  });

  it("ne prend jamais un morceau d'URL pour une adresse", () => {
    expect(extractAddress(`voir https://dexscreener.com/solana/8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj et rien d'autre`)).toBeNull();
    expect(extractChainTag("( ARC) MALA")).toBe("ARC");
  });

  it("garde la première apparition de chaque adresse (re-posts ignorés, casse EVM ignorée)", () => {
    const { calls } = parseChannelPage(PAGE, "mad_apes_gambles", "2026-09-25T16:00:00Z");
    const first = mergeNewCalls([], calls);
    expect(first.map((c) => c.postId)).toEqual([226582, 226594]);
    const again = mergeNewCalls(first, [{ ...(calls[1] as Call), postId: 999999, address: RBH_CA.toLowerCase() }]);
    expect(again).toEqual([]);
  });

  it("suit chaque call 7 jours, par chaîne ; les autres chaînes ne sont pas interrogées", () => {
    const base: Call = { channel: "c", postId: 1, postedAt: "2026-09-25T00:00:00Z", seenAt: "2026-09-25T00:05:00Z", chain: "solana", chainTag: "SOL", address: SOL_CA, symbol: null, text: "" };
    const now = Date.parse(base.postedAt) + CALL_TRACK_MS - 1;
    const p = callsToPoll([base, { ...base, chain: "robinhood", address: RBH_CA }, { ...base, chain: "other", address: "0xabc" }, { ...base, postedAt: "2026-09-01T00:00:00Z" }], now);
    expect(p).toEqual({ solana: [SOL_CA], robinhood: [RBH_CA] });
  });

  it("collecte : nouveaux calls ajoutés une seule fois, prix écrits dans data-calls/history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "calls-"));
    const pair = { chainId: "solana", dexId: "pumpswap", pairAddress: "P1", baseToken: { address: SOL_CA, symbol: "APE", name: "Ape" }, priceUsd: "0.001", liquidity: { usd: 30_000 }, volume: { m5: 1, h1: 2, h6: 3, h24: 4 }, txns: {}, pairCreatedAt: 1_780_000_000_000 };
    const fetchImpl = (async (url: string) =>
      url.startsWith("https://t.me/s/")
        ? new Response(PAGE, { status: 200 })
        : new Response(JSON.stringify({ pairs: [pair] }), { status: 200, headers: { "content-type": "application/json" } })) as never;
    const now = () => Date.parse("2026-09-25T16:00:00Z");
    const r1 = await runCalls({ dataDir: dir, channels: ["mad_apes_gambles"], fetch: fetchImpl, now });
    expect(r1.newCalls).toBe(2);
    expect(r1.snapshots).toBe(1);
    const r2 = await runCalls({ dataDir: dir, channels: ["mad_apes_gambles"], fetch: fetchImpl, now });
    expect(r2.newCalls).toBe(0);
  });
});

describe("hypothèses 3–4 — verdict", () => {
  const call: Call = { channel: "c", postId: 1, postedAt: "2026-09-28T12:00:00Z", seenAt: "2026-09-28T12:05:00Z", chain: "solana", chainTag: "SOL", address: SOL_CA, symbol: "APE", text: "" };
  const snap = (min: number, price: number, liq = 50_000, m5 = 100, buys = 5, sells = 5) =>
    snapshotsFromPairs(
      [{ chainId: "solana", dexId: "pumpswap", pairAddress: "P1", baseToken: { address: SOL_CA, symbol: "APE", name: "Ape" }, priceUsd: String(price), liquidity: { usd: liq }, volume: { m5, h1: 0, h6: 0, h24: 0 }, txns: { m5: { buys, sells } }, pairCreatedAt: 1_780_000_000_000 } as never],
      new Date(Date.parse(call.seenAt) + min * 60_000).toISOString(),
    )[0]!;

  it("H3 déclenche une seule fois, sur la première observation après le call", () => {
    const s = [snap(1, 1), snap(16, 1.1), snap(31, 1.2)];
    const sig = h3Signal(call);
    expect([1, 2, 3].map((n) => sig(s.slice(0, n)))).toEqual([1, 0, 0]);
  });

  it("H4 attend volume ≥ 5 % de la liquidité et achats ≥ ventes, dans les 2 h seulement", () => {
    const s = [snap(1, 1, 50_000, 100), snap(16, 1, 50_000, 3_000, 9, 3), snap(31, 1, 50_000, 3_000, 9, 3)];
    const sig = h4Signal(call);
    expect([1, 2, 3].map((n) => sig(s.slice(0, n)))).toEqual([0, 1, 0]);
    expect(sig([snap(200, 1, 50_000, 3_000, 9, 3)])).toBe(0);
  });

  it("de bout en bout : entrée à l'observation suivante, objectif +80 % atteint", () => {
    const dir = mkdtempSync(join(tmpdir(), "calls-v-"));
    mkdirSync(join(dir, "history"));
    writeFileSync(join(dir, "calls.jsonl"), JSON.stringify(call) + "\n");
    const series = [snap(1, 1), snap(16, 1), snap(31, 1.5), snap(46, 2)];
    writeFileSync(join(dir, "history", `${SOL_CA}.jsonl`), series.map((x) => JSON.stringify(x)).join("\n") + "\n");
    const r = evaluateCalls(dir);
    const h3 = r.verdicts[0]!;
    expect(h3.a.n).toBe(1);
    expect(h3.a.winRate).toBe(1);
    expect(h3.verdict).toBe("NON CONCLUANT");
    expect(r.board.withData).toBe(1);
  });
});
