import { describe, it, expect } from "vitest";
import {
  tokenTerms,
  growthToCatalystScore,
  catalystScore,
  createsToDocs,
  acceleratingTermsByDay,
  scoreTokensWalkForward,
} from "../lab/signals/catalyst.ts";
import { computeNarratives } from "../lab/signals/narrative.ts";

describe("tokenTerms", () => {
  it("extrait les termes significatifs, déduplique, ignore les stopwords", () => {
    const terms = tokenTerms("BREAKING CNN", "CNN");
    expect(terms).toContain("breaking");
    expect(terms).toContain("cnn");
    expect(terms).toHaveLength(new Set(terms).size);
  });
  it("ne retient pas les mots génériques type 'coin'", () => {
    expect(tokenTerms("Moon Coin", "MOON")).not.toContain("coin");
  });
});

describe("growthToCatalystScore", () => {
  it("0 sans accélération (growth ≤ 1)", () => {
    expect(growthToCatalystScore(1)).toBe(0);
    expect(growthToCatalystScore(0.5)).toBe(0);
    expect(growthToCatalystScore(NaN)).toBe(0);
  });
  it("mapping documenté : x2 → 20, x3 → 40, x5 → 80, plafonné à 100", () => {
    expect(growthToCatalystScore(2)).toBe(20);
    expect(growthToCatalystScore(3)).toBe(40);
    expect(growthToCatalystScore(5)).toBe(80);
    expect(growthToCatalystScore(6)).toBe(100);
    expect(growthToCatalystScore(50)).toBe(100);
  });
});

const ACCEL = [
  { term: "elon", count24h: 50, baselinePerDay: 4, count7d: 28, growth: 10.2, sources: { token: 50 }, docs24h: 40 },
  { term: "mars", count24h: 12, baselinePerDay: 5, count7d: 35, growth: 2.2, sources: { token: 12 }, docs24h: 10 },
];

describe("catalystScore", () => {
  it("score 0 neutre sans chevauchement (pas un rejet)", () => {
    const s = catalystScore({ name: "Blue Banana", symbol: "BBN" }, ACCEL);
    expect(s.score).toBe(0);
    expect(s.reasons.join(" ")).toMatch(/neutre/);
    expect(s.matchedTerms).toHaveLength(0);
  });
  it("score basé sur le meilleur terme en accélération", () => {
    const s = catalystScore({ name: "Elon Mars Rocket", symbol: "EMR" }, ACCEL);
    expect(s.score).toBe(100); // growth 10.2 → plafonné
    expect(s.matchedTerms.map((m) => m.term)).toContain("elon");
    expect(s.matchedTerms.map((m) => m.term)).toContain("mars");
  });
  it("terme faiblement accéléré → score faible mais non nul", () => {
    const s = catalystScore({ name: "Mars Trip", symbol: "MT" }, ACCEL);
    expect(s.score).toBe(growthToCatalystScore(2.2));
    expect(s.score).toBeGreaterThan(0);
  });
});

describe("walk-forward (pas de lookahead)", () => {
  // Jour 1 : 10 créations « elon » ; jour 2 : 10 créations « elon » + token test.
  const day1 = "2026-09-24";
  const day2 = "2026-09-25";
  const mkCreates = (day: string, n: number, word: string) =>
    Array.from({ length: n }, (_, i) => ({
      name: `${word} token ${i}`,
      symbol: `${word}${i}`,
      receivedAt: `${day}T12:00:00.000Z`,
    }));
  const docs = createsToDocs([...mkCreates(day1, 10, "zzz"), ...mkCreates(day2, 10, "elon")]);

  it("les termes du jour D n'influencent pas le score du jour D", () => {
    const termsByDay = acceleratingTermsByDay(docs, [day2], { minCount: 2, minDocs: 2, topTerms: 50 });
    const terms = termsByDay.get(day2) ?? [];
    // « elon » n'existe que le jour 2 : il ne doit PAS être en accélération pour le jour 2.
    expect(terms.map((t) => t.term)).not.toContain("elon");
  });

  it("scoreTokensWalkForward utilise le passé uniquement", () => {
    const termsByDay = acceleratingTermsByDay(docs, [day1, day2], { minCount: 2, minDocs: 2, topTerms: 50 });
    const scores = scoreTokensWalkForward(
      [
        { mint: "m1", name: "elon rocket", symbol: "ER", at: `${day2}T15:00:00.000Z` },
        { mint: "m2", name: "zzz plain", symbol: "ZP", at: `${day1}T15:00:00.000Z` },
      ],
      termsByDay,
    );
    // m1 (jour 2) : « elon » pas encore en accélération au début du jour 2 → score 0.
    expect(scores.get("m1")?.score).toBe(0);
    // m2 (jour 1) : aucun passé → 0, neutre.
    expect(scores.get("m2")?.score).toBe(0);
  });

  it("un terme qui accélère le jour 1 est détecté le jour 2", () => {
    // « zzz » : 10 créations jour 1 (base vide → pas d'accélération jour 1),
    // puis 40 créations jour 2. Pour le jour 3, zzz accélère.
    const day3 = "2026-09-26";
    const docs2 = createsToDocs([...mkCreates(day1, 10, "zzz"), ...mkCreates(day2, 40, "zzz")]);
    const termsByDay = acceleratingTermsByDay(docs2, [day3], { minCount: 2, minDocs: 2, topTerms: 50 });
    const terms = termsByDay.get(day3) ?? [];
    expect(terms.map((t) => t.term)).toContain("zzz");
    const s = catalystScore({ name: "Zzz Moon", symbol: "ZZ" }, terms);
    expect(s.score).toBeGreaterThan(0);
  });
});

describe("cohérence avec computeNarratives", () => {
  it("createsToDocs produit des documents exploitables par computeNarratives", () => {
    const docs = createsToDocs([
      { name: "Elon Coin", symbol: "ELON", receivedAt: "2026-09-25T10:00:00.000Z" },
      { name: "Elon Mars", symbol: "EM", receivedAt: "2026-09-25T11:00:00.000Z" },
      { name: "Elon Rocket", symbol: "ER", receivedAt: "2026-09-25T12:00:00.000Z" },
    ]);
    const stats = computeNarratives(docs, {
      now: () => Date.parse("2026-09-25T23:00:00.000Z"),
      minCount: 2,
      minDocs: 2,
    });
    expect(stats.map((s) => s.term)).toContain("elon");
  });
});
