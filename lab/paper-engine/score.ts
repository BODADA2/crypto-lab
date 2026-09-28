/**
 * Score interne du moteur paper (§8 du cahier des charges) : 10 dimensions.
 *
 * Intégration (pas de doublon) :
 * - `securite` / `risque` réutilisent lab/signals/bundle.ts (bundleRiskStatic, BUNDLE_EXCLUDE_SCORE)
 *   et la convention UNKNOWN_AUTHORITY de lab/collect/types.ts ;
 * - `onchain` réutilise lab/signals/devblocklist.ts (isBlocklisted) ;
 * - `momentum`/`volume` réutilisent lab/signals/volume.ts (z-score 5 min) ;
 * - `catalyseur` réutilise lab/signals/catalyst.ts (score walk-forward, déjà validé NO ACTION —
 *   ici c'est une dimension parmi 10, pas un prédicteur) ;
 * - `liquidite`, `narratif`, `asymetrie` suivent les normalisations documentées de
 *   lab/signals/score.weights.json (le score lab reste la référence explicable du classement).
 *
 * RÈGLES DURES (§8, §12) :
 * - un risque critique (autorité active, dev blocklisté, bundle ≥ 60) ÉLIMINE le token,
 *   même si le momentum est extrêmement fort ;
 * - une donnée absente vaut INCONNU (score 0 sur la dimension, `missing: true`) — jamais inventée ;
 * - le score est un CLASSEMENT RELATIF, jamais une garantie de rendement.
 */
import { UNKNOWN_AUTHORITY } from "../collect/types.ts";
import { BUNDLE_EXCLUDE_SCORE, bundleRiskStatic, type BundleRisk } from "../signals/bundle.ts";
import type { TokenSnapshot } from "../types.ts";
import { ENGINE } from "./config.ts";
import type { DimensionResult, InternalScore, ScoreDimension } from "./types.ts";

export const SCORE_DISCLAIMER =
  "Score de classement relatif des candidats — jamais une garantie de rendement. " +
  "Un score élevé avec une faible couverture de données est un score à ne pas croire.";

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export interface ScoreCandidate {
  mint: string;
  symbol: string;
  name: string;
  chain: string;
  /** Barres jusqu'au point de décision (la dernière = point de décision). */
  series: TokenSnapshot[];
  /** Score catalyst walk-forward 0..100 (null = INCONNU). */
  catalystScore: number | null;
  /** Ratio d'accélération narrative 24h/7j (null = INCONNU). */
  narrativeAccelRatio: number | null;
  /** Résultat de isBlocklisted (H-BLOCK). */
  blocklisted: boolean;
  /** z-score volume 5 min (lab/signals/volume.ts, null = INCONNU). */
  volumeZScore5m: number | null;
}

const WEIGHTS: Record<ScoreDimension, number> = {
  securite: 3,
  liquidite: 2,
  onchain: 2,
  momentum: 1.5,
  volume: 1.5,
  structure: 1,
  narratif: 1,
  catalyseur: 1,
  risque: 3,
  asymetrie: 1.5,
};

function dim(
  dimension: ScoreDimension,
  score: number,
  opts: { missing?: boolean; critical?: boolean; notes?: string[] } = {},
): DimensionResult {
  return {
    dimension,
    score: Math.round(clamp01(score / 100) * 100),
    weight: WEIGHTS[dimension],
    missing: opts.missing ?? false,
    critical: opts.critical ?? false,
    notes: opts.notes ?? [],
  };
}

function closes(series: TokenSnapshot[]): number[] {
  return series.map((s) => s.priceUsd).filter((p) => p > 0);
}

export function scoreCandidate(c: ScoreCandidate): InternalScore {
  const last = c.series[c.series.length - 1];
  if (!last) throw new Error("scoreCandidate: série vide");
  const dims: DimensionResult[] = [];
  const notes: string[] = [];

  // 1. SÉCURITÉ — autorités. UNKNOWN = non vérifié (INCONNU, pas une preuve de sécurité).
  {
    const n: string[] = [];
    let score: number | null = null;
    let critical = false;
    let missing = false;
    const mint = last.mintAuthority as string | null | undefined;
    const freeze = last.freezeAuthority as string | null | undefined;
    const active = [mint, freeze].filter(
      (a) => a !== null && a !== undefined && a !== UNKNOWN_AUTHORITY,
    );
    if (active.length > 0) {
      score = 0;
      critical = true;
      n.push(`autorité active détectée (${active.length}) — risque critique`);
    } else if (mint === UNKNOWN_AUTHORITY || freeze === UNKNOWN_AUTHORITY) {
      score = 25;
      missing = true;
      n.push("autorités mint/freeze NON VÉRIFIÉES on-chain (INCONNU — en live, refus systématique)");
    } else {
      score = 100;
      n.push("autorités révoquées (vérifié)");
    }
    dims.push(dim("securite", score, { missing, critical, notes: n }));
  }

  // 2. LIQUIDITÉ
  {
    const liq = last.liquidityUsd;
    if (!(liq > 0)) {
      dims.push(dim("liquidite", 0, { missing: true, notes: ["liquidité inconnue (INCONNU)"] }));
    } else {
      // 20 k$ → 0, 1 M$ → 100, log-linéaire (même méthode que lab/signals/score.ts).
      const s = (Math.log10(liq) - Math.log10(20_000)) / (Math.log10(1_000_000) - Math.log10(20_000));
      dims.push(dim("liquidite", clamp01(s) * 100, { notes: [`liquidité ${Math.round(liq)} $`] }));
    }
  }

  // 3. ON-CHAIN — concentration + blocklist dev (H-BLOCK).
  {
    const n: string[] = [];
    if (c.blocklisted) {
      dims.push(dim("onchain", 0, { critical: true, notes: ["dev BLOCKLISTÉ (H-BLOCK) — risque critique"] }));
    } else {
      const t10 = last.top10Pct;
      let s: number;
      let missing = false;
      if (!(t10 >= 0) || t10 >= 100) {
        s = 10;
        missing = true;
        n.push("concentration top10 inconnue (INCONNU = conservateur)");
      } else {
        s = clamp01(1 - t10 / 60) * 100;
        n.push(`top10 à ${t10.toFixed(1)} %`);
      }
      if (last.holders === null || last.holders === undefined) {
        missing = true;
        n.push("nombre de holders inconnu (INCONNU)");
      } else {
        n.push(`${last.holders} holders`);
      }
      dims.push(dim("onchain", s, { missing, notes: n }));
    }
  }

  // 4. MOMENTUM
  {
    const pc = last.priceChange?.h1;
    if (pc === null || pc === undefined || !Number.isFinite(pc)) {
      dims.push(dim("momentum", 0, { missing: true, notes: ["variation 1h inconnue (INCONNU)"] }));
    } else {
      dims.push(dim("momentum", clamp01(pc / 50) * 100, { notes: [`+${pc.toFixed(1)} % / 1h`] }));
    }
  }

  // 5. VOLUME
  {
    const v1h = last.volume?.h1 ?? last.volume1h;
    const n: string[] = [];
    let s: number;
    let missing = false;
    if (!(v1h > 0)) {
      s = 0;
      missing = true;
      n.push("volume 1h inconnu (INCONNU)");
    } else {
      s = clamp01(Math.log10(1 + v1h) / 6) * 100;
      n.push(`volume 1h ${Math.round(v1h)} $`);
    }
    if (c.volumeZScore5m !== null && Number.isFinite(c.volumeZScore5m)) {
      const zb = clamp01(c.volumeZScore5m / 4);
      s = Math.min(100, s * 0.7 + zb * 100 * 0.3);
      n.push(`z-score 5 min ${c.volumeZScore5m.toFixed(2)}`);
    } else {
      n.push("z-score 5 min inconnu");
    }
    dims.push(dim("volume", s, { missing, notes: n }));
  }

  // 6. STRUCTURE — higher highs / higher lows sur les 12 dernières barres.
  {
    const px = closes(c.series).slice(-12);
    if (px.length < 6) {
      dims.push(dim("structure", 0, { missing: true, notes: [`${px.length} barres < 6 (INCONNU)`] }));
    } else {
      let hh = 0;
      let hl = 0;
      for (let i = 2; i < px.length; i++) {
        const a = px[i] ?? 0;
        const b = px[i - 1] ?? 0;
        const c0 = px[i - 2] ?? 0;
        if (a > b && b > c0) hh++;
        if (a < b && b < c0) hl++;
      }
      let s = ((hh - hl) / (px.length - 2)) * 50 + 50;
      const recentHigh = Math.max(...px.slice(0, -1));
      const lastPx = px[px.length - 1] ?? 0;
      const broke = lastPx > recentHigh;
      if (broke) s = Math.min(100, s + 15);
      dims.push(
        dim("structure", s, { notes: [`HH×${hh} HL×${hl} sur ${px.length} barres`, broke ? "cassure du plus-haut local" : "pas de cassure"] }),
      );
    }
  }

  // 7. NARRATIF — accélération (souvent INCONNU : pas de données sociales collectées).
  {
    if (c.narrativeAccelRatio === null || !Number.isFinite(c.narrativeAccelRatio)) {
      dims.push(dim("narratif", 0, { missing: true, notes: ["accélération narrative inconnue (INCONNU — aucune donnée sociale collectée)"] }));
    } else {
      dims.push(
        dim("narratif", clamp01((c.narrativeAccelRatio - 1) / 4) * 100, {
          notes: [`accélération ×${c.narrativeAccelRatio.toFixed(2)}`],
        }),
      );
    }
  }

  // 8. CATALYSEUR — score walk-forward (backtest NO ACTION : dimension parmi 10, pas un prédicteur).
  {
    if (c.catalystScore === null || !Number.isFinite(c.catalystScore)) {
      dims.push(dim("catalyseur", 0, { missing: true, notes: ["score catalyst inconnu (INCONNU)"] }));
    } else {
      dims.push(
        dim("catalyseur", c.catalystScore, {
          notes: [`catalyst ${c.catalystScore.toFixed(0)}/100 (rappel backtest : ne prédit pas seul)`],
        }),
      );
    }
  }

  // 9. RISQUE — bundle statique + manipulation. Critique si bundle ≥ seuil AVEC preuve
  // mesurée (pas sur la seule absence de données : holders et top10 sont systématiquement
  // inconnus dans data/history — l'aveuglement est noté, pas une preuve de risque).
  {
    const b: BundleRisk = bundleRiskStatic({
      top10Pct: last.top10Pct,
      holders: last.holders ?? null,
      mintAuthority: last.mintAuthority as string | null,
      freezeAuthority: last.freezeAuthority as string | null,
      liquidityUsd: last.liquidityUsd,
    });
    const measuredEvidence =
      (last.top10Pct < 100 && last.top10Pct >= 60) ||
      [last.mintAuthority, last.freezeAuthority].some(
        (a) => a !== null && a !== undefined && a !== UNKNOWN_AUTHORITY,
      ) ||
      (last.holders !== null && last.holders !== undefined && last.holders < 50);
    const critical = b.score >= (ENGINE.bundleExcludeScore ?? BUNDLE_EXCLUDE_SCORE) && measuredEvidence;
    const n = [...b.reasons, "risque de manipulation (wash/bots) : INCONNU — aucune donnée"];
    if (!measuredEvidence && b.score >= 60) {
      n.push("filtre bundle aveugle sur ces données (holders/top10 inconnus) — caveat documenté, pas d'élimination");
    }
    dims.push(
      dim("risque", 100 - b.score, {
        critical,
        missing: true, // la partie manipulation est toujours inconnue
        notes: critical ? [...n, `bundle ${b.score} ≥ ${BUNDLE_EXCLUDE_SCORE} avec preuve mesurée — risque critique`] : n,
      }),
    );
    void notes;
  }

  // 10. ASYMÉTRIE — TP1/stop du plan de sortie.
  {
    const rr = ENGINE.tp1Pct / ENGINE.stopPct;
    dims.push(dim("asymetrie", clamp01((rr - 1) / 3) * 100, { notes: [`R:R planifié ${rr.toFixed(2)} (TP1 ${ENGINE.tp1Pct} % / stop ${ENGINE.stopPct} %)`] }));
  }

  const totalW = dims.reduce((a, d) => a + d.weight, 0);
  const presentW = dims.filter((d) => !d.missing).reduce((a, d) => a + d.weight, 0);
  const composite = dims.reduce((a, d) => a + d.score * d.weight, 0) / totalW;
  const critical = dims.find((d) => d.critical);
  return {
    composite: Math.round(composite),
    dimensions: dims,
    coverage: presentW / totalW,
    eliminated: critical !== undefined,
    eliminationReason: critical ? `${critical.dimension} : ${critical.notes.join(" ; ")}` : null,
    disclaimer: SCORE_DISCLAIMER,
  };
}
