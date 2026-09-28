import { describe, it, expect } from "vitest";
import { buildFirstSeen, entryDelayMinutes } from "../lab/collect/firstseen.ts";

describe("buildFirstSeen", () => {
  it("retient la première observation par mint", () => {
    const idx = buildFirstSeen([
      { mint: "m1", receivedAt: "2026-09-01T00:05:00Z" },
      { mint: "m1", receivedAt: "2026-09-01T00:01:00Z" },
      { mint: "m2", receivedAt: "2026-09-01T00:03:00Z" },
    ]);
    expect(idx.m1).toBe("2026-09-01T00:01:00Z");
    expect(idx.m2).toBe("2026-09-01T00:03:00Z");
  });

  it("ignore les lignes sans mint ou sans date", () => {
    expect(buildFirstSeen([{ mint: "", receivedAt: "2026-09-01T00:01:00Z" }])).toEqual({});
  });
});

describe("entryDelayMinutes", () => {
  it("calcule le délai en minutes", () => {
    expect(entryDelayMinutes("2026-09-01T00:00:00Z", "2026-09-01T00:05:00Z")).toBe(5);
  });

  it("retourne null si l'entrée précède la première observation ou si une date est invalide", () => {
    expect(entryDelayMinutes("2026-09-01T00:05:00Z", "2026-09-01T00:01:00Z")).toBeNull();
    expect(entryDelayMinutes("n'importe quoi", "2026-09-01T00:01:00Z")).toBeNull();
  });
});
