# EXP-2026-09-28-s2c-actors — Familles E : wallets récurrents / entités (H-S2C-E1, H-S2C-E2)

- **hypothesis_id** : H-S2C-E1 (outcomes corrélés), H-S2C-E2 (qualité historique wallet → outcome)
- **question** :
  - E1 : deux mints partageant un early buyer **récurrent** ont-ils des outcomes plus proches que deux mints au hasard ?
  - E2 : la « qualité historique » d'un wallet (taux de survie des mints précédents **où il était early buyer**, as-of-t0) prédit-elle l'outcome du mint courant ? (wallet-level ET entity-level, WALLET ≠ ENTITY)
- **method** :
  - 85 caches `data/earlybuyers/*.json` lus en l'état (backfill en cours, lecture seule) ; t0 depuis `data/history` (`findT0`) ; set pré-t0 strict (`blockTime*1000 <= t0ms`, même règle que `snapshot.ts`).
  - Univers **DISCOVERY uniquement** (34 mints avec historique + t0) ; SKHY exclu ; holdout jamais lu.
  - Incidence wallet→mints (886 wallets distincts) ; récurrence **as-of-t0** : wallet récurrent pour m ssi présent dans ≥1 AUTRE mint avec t0' < t0(m).
  - E1 : 258 paires (a,b) avec t0a<t0b partageant ≥1 wallet récurrent-as-of-t0b ; statistique = moyenne |y1h_a−y1h_b| et part de paires à survival_50 identique ; p par permutation **au niveau des mints** (outcomes mélangés entre mints, paires fixes, 2000 reps).
  - E2 : pour chaque mint, qualité(w) = taux de survival_50 sur les mints passés (t0'<t0) où w était early buyer pré-t0 ; feature mint = moyenne sur buyers avec qualité définie ; niveau entité via `clusterWallets` + `buildPairOverlap(t0ms, excludeMint)` (preuves ≤ t0ms) — qualité d'entité = moyenne des qualités membres.
  - Corrélation de Spearman qualité→y1h + permutation unilatérale ; stabilité par split médian t0 (early/late).
- **data** : `data/earlybuyers/*.json` (85 fichiers, backfill en parallèle) + `data/history/*.jsonl`. Tokens chauds uniquement → **borne optimiste**.
- **n** : 34 mints discovery ; 76 wallets récurrents (≥2 mints) sur 886 ; 24 mints avec ≥1 wallet récurrent as-of-t0 (part moyenne 21,4 %) ; E1 : 258 paires (68 avec y1h bilatéral, 107 avec survival bilatéral) ; E2 : **12 mints** avec qualité définie + y1h (11 mints sans aucun label passé).
- **leakage_status** : **PASS** — sets pré-t0 stricts ; récurrence et qualité calculées uniquement sur mints avec t0' < t0(m) ; labels (`survival_50_24h`, `y1h`) lus uniquement comme outcomes ou comme historique **passé** ; clustering sur preuves ≤ t0ms ; discovery uniquement ; SKHY exclu.
- **results** :
  - E1 : mean|Δy1h| = 2,281, p_perm = **0,787** (outcomes pas plus proches) ; part même survival_50 = 0,514, p_perm = **0,589**. Aucune corrélation détectable.
  - E2 : Spearman(qualité_wallet, y1h) = **0,217**, p_perm = 0,242 (n=12, sous-puissant) ; niveau entité : ρ = **0,00** (n=12). Stabilité temporelle : early ρ=−0,07 (n=7) vs late ρ=+0,30 (n=5) — signe instable. Déciles : n=1–2 par décile, non interprétables.
  - **Déjà-vu** : 8 wallets sont early buyers dans 13–22 des 34 mints (ex. `27HFmP7ccLad…` : 22 mints) — outcomes mixtes (survie/non-survie), donc PAS une cohorte parfaite ; ressemble à une infrastructure de snipe systématique sur tokens chauds, pas à un signal. → versé au mystery queue comme observation.
- **verdict** :
  - H-S2C-E1 : **NULL** — les mints partageant un early buyer récurrent n'ont pas d'outcomes plus corrélés (p≈0,6–0,8, n paires=258).
  - H-S2C-E2 : **NULL** — n=12, corrélation faible non significative, signe instable entre cohortes ; impossible de trancher avec le backfill actuel. À re-tester quand le backfill atteindra n≥30 mints avec historique.

## Fiche triage

- **HYPOTHESIS** : H-S2C-E1 — paires partageant un buyer récurrent → outcomes plus proches ; H-S2C-E2 — qualité historique wallet (as-of-t0) → y1h.
- **N** : 34 mints discovery (85 caches) ; E1 : 258 paires ; E2 : 12 mints.
- **EFFECT** : E1 : p_perm 0,787 (y1h) / 0,589 (survival) — aucun ; E2 : ρ=0,217 (wallet), ρ=0,00 (entité).
- **P-VALUE** : E1 : 0,787 / 0,589 (permutation) ; E2 : 0,242 (permutation unilatérale).
- **CI** : n/a (n trop petit pour E2).
- **OOS EFFECT** : non mesuré — holdout gelé.
- **COHORT STABILITY** : E2 early ρ=−0,07 vs late ρ=+0,30 — instable (n=7/5).
- **TIME STABILITY** : idem (split médian t0).
- **COST SENSITIVITY** : non évaluée (aucune stratégie).
- **LEAKAGE STATUS** : PASS — pré-t0 strict, récurrence/qualité sur passé uniquement (t0'<t0), clustering preuves ≤ t0ms, discovery uniquement, SKHY exclu.
- **VERDICT** : **NULL** (E1) / **NULL** (E2, sous-puissant — re-tester à n≥30).

## Suivi suggéré

- Re-lancer E2 quand le backfill early buyers couvrira ≥30 mints discovery avec historique (n actuel = 12).
- Investiguer les 8 wallets « systématiques » (déjà-vu) : bot de snipe ? pattern temporel ? (mystery queue — observation, pas un signal).
- Ne pas construire de feature « smart money » : la qualité historique reste un filtre d'exclusion potentiel au mieux (famille A), jamais une preuve d'edge.
