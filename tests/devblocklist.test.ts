import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  emptyBlocklist,
  isBlocklisted,
  blockDev,
  unblockDev,
  getEntry,
  blocklistPenalty,
  blocklistSize,
  loadBlocklist,
  saveBlocklist,
} from "../lab/signals/devblocklist.ts";

const NOW = () => Date.parse("2026-09-28T12:00:00.000Z");
const LATER = () => Date.parse("2026-09-29T12:00:00.000Z");

describe("isBlocklisted", () => {
  it("faux sur registre vide, wallet manquant ou invalide", () => {
    const list = emptyBlocklist();
    expect(isBlocklisted(list, "WALLET1")).toBe(false);
    expect(isBlocklisted(list, null)).toBe(false);
    expect(isBlocklisted(list, undefined)).toBe(false);
    expect(isBlocklisted(list, "")).toBe(false);
  });
  it("vrai après blockDev", () => {
    const list = blockDev(emptyBlocklist(), "WALLET1", { reason: "rug", now: NOW });
    expect(isBlocklisted(list, "WALLET1")).toBe(true);
    expect(isBlocklisted(list, "WALLET2")).toBe(false);
  });
});

describe("blockDev (pureté)", () => {
  it("crée une entrée complète : motif, date, rugs observés = 1, source", () => {
    const list = blockDev(emptyBlocklist(), "W1", { reason: "rug sur MINTabc", source: "manuel", now: NOW });
    const e = getEntry(list, "W1");
    expect(e).toMatchObject({
      wallet: "W1",
      reason: "rug sur MINTabc",
      blockedAt: "2026-09-28T12:00:00.000Z",
      rugsObserved: 1,
      source: "manuel",
      lastSeenAt: "2026-09-28T12:00:00.000Z",
    });
  });
  it("ne modifie pas le registre d'origine (fonction pure)", () => {
    const before = emptyBlocklist();
    const after = blockDev(before, "W1", { reason: "rug", now: NOW });
    expect(blocklistSize(before)).toBe(0);
    expect(blocklistSize(after)).toBe(1);
    expect(after).not.toBe(before);
  });
  it("un re-signalement incrémente rugsObserved sans écraser le motif d'origine", () => {
    let list = blockDev(emptyBlocklist(), "W1", { reason: "premier rug", now: NOW });
    list = blockDev(list, "W1", { reason: "second rug", source: "semi-auto", now: LATER });
    const e = getEntry(list, "W1")!;
    expect(e.rugsObserved).toBe(2);
    expect(e.reason).toBe("premier rug");
    expect(e.blockedAt).toBe("2026-09-28T12:00:00.000Z");
    expect(e.lastSeenAt).toBe("2026-09-29T12:00:00.000Z");
  });
  it("motif vide → 'motif non précisé', wallet invalide → erreur", () => {
    const list = blockDev(emptyBlocklist(), "W1", { reason: "   ", now: NOW });
    expect(getEntry(list, "W1")?.reason).toBe("motif non précisé");
    expect(() => blockDev(emptyBlocklist(), "", { reason: "x" })).toThrow(/invalide/);
  });
});

describe("unblockDev", () => {
  it("retire le wallet (faux positif / réhabilitation), sans toucher aux autres", () => {
    let list = blockDev(emptyBlocklist(), "W1", { reason: "rug", now: NOW });
    list = blockDev(list, "W2", { reason: "rug", now: NOW });
    const after = unblockDev(list, "W1");
    expect(isBlocklisted(after, "W1")).toBe(false);
    expect(isBlocklisted(after, "W2")).toBe(true);
    expect(isBlocklisted(list, "W1")).toBe(true); // original intact
  });
  it("sur un wallet absent : copie identique, pas d'erreur", () => {
    const list = blockDev(emptyBlocklist(), "W1", { reason: "rug", now: NOW });
    const after = unblockDev(list, "W9");
    expect(after).toEqual(list);
    expect(after).not.toBe(list);
  });
});

describe("blocklistPenalty", () => {
  it("0 si non banni, 60 au premier rug, +10 par rug suivant, plafonné à 100", () => {
    let list = emptyBlocklist();
    expect(blocklistPenalty(list, "W1")).toBe(0);
    list = blockDev(list, "W1", { reason: "rug", now: NOW });
    expect(blocklistPenalty(list, "W1")).toBe(60);
    for (let i = 0; i < 3; i++) list = blockDev(list, "W1", { reason: "rug", now: NOW });
    expect(blocklistPenalty(list, "W1")).toBe(90);
    for (let i = 0; i < 10; i++) list = blockDev(list, "W1", { reason: "rug", now: NOW });
    expect(blocklistPenalty(list, "W1")).toBe(100);
    expect(blocklistPenalty(list, null)).toBe(0);
  });
});

describe("persistance locale", () => {
  it("round-trip save/load dans un répertoire temporaire", () => {
    const dir = mkdtempSync(join(tmpdir(), "devblocklist-"));
    try {
      const path = join(dir, "sub", "dev-blocklist.json");
      let list = blockDev(emptyBlocklist(), "W1", { reason: "rug MINT1", source: "semi-auto", now: NOW });
      list = blockDev(list, "W2", { reason: "bundle en série", now: NOW });
      saveBlocklist(list, path);
      const loaded = loadBlocklist(path);
      expect(loaded).toEqual(list);
      expect(isBlocklisted(loaded, "W1")).toBe(true);
      // Format lisible et éditable à la main.
      expect(readFileSync(path, "utf8")).toContain("bundle en série");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("fichier absent → registre vide ; fichier corrompu → registre vide (jamais d'exception)", () => {
    const dir = mkdtempSync(join(tmpdir(), "devblocklist-"));
    try {
      expect(loadBlocklist(join(dir, "nope.json"))).toEqual({});
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ pas du json");
      expect(loadBlocklist(bad)).toEqual({});
      const arr = join(dir, "arr.json");
      writeFileSync(arr, "[1,2]");
      expect(loadBlocklist(arr)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("entrées malformées : normalisation défensive, jamais de plantage", () => {
    const dir = mkdtempSync(join(tmpdir(), "devblocklist-"));
    try {
      const p = join(dir, "weird.json");
      writeFileSync(p, JSON.stringify({ W1: { reason: 42 }, "": { reason: "vide" }, W2: null }));
      const loaded = loadBlocklist(p);
      expect(isBlocklisted(loaded, "W1")).toBe(true);
      expect(getEntry(loaded, "W1")?.rugsObserved).toBe(1);
      expect(isBlocklisted(loaded, "")).toBe(false);
      expect(isBlocklisted(loaded, "W2")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
