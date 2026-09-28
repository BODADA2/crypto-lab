# EXP-2026-09-28-e4-windows — Fenêtres early buyers, qualité des données (famille A)

- **hypothesis_id** : H-S1-E4
- **question** : Les 5 WINDOW_DEFS (pre_t0_set, first_block, first_5_slots, first_60s, first_300s) sont-elles matériellement différentes ? (Si Jaccard ~1 partout → fenêtres redondantes.)
- **method** (data-quality, aucun label, aucun modèle) : pour chaque `data/earlybuyers/<mint>.json` — t0ms depuis `data/history` (`findT0`), set pré-t0 = buyers avec `blockTime != null` ET `blockTime*1000 <= t0ms` (même règle que `snapshot.ts`, sans appels Helius) ; `applyWindow()` par WINDOW_DEF → tailles, Jaccard par paires (sets de wallets), part first_block du set pré-t0.
- **data** : `data/earlybuyers/*.json` (70 fichiers, lecture seule — l'agent backfill écrit en parallèle : fichiers lus en l'état) + `data/history/*.jsonl` pour t0ms. Pas de split d'univers (data-quality).
- **n** : 61 mints avec historique + t0 (9 abandonnés sans historique/t0 ; 14 sets pré-t0 vides — exclus des stats de fenêtres).
- **leakage_status** : **PASS** — aucun label futur, aucun modèle ; fenêtres = filtres du set pré-t0 ; `first_block`/`first_5_slots` → [] si aucun slot non-null (documenté dans `windows.ts`) ; lecture seule, aucun appel réseau.
- **results** :
  - Tailles (moyenne / médiane) : pre_t0_set 41,9 / 50 · **first_block 3,3 / 3** · first_5_slots 7,4 / 6 · first_60s 38,1 / 50 · first_300s 40,6 / 50.
  - Part first_block du set pré-t0 : moyenne 10,1 %, médiane 6,0 % — les snipers stricts sont une petite minorité.
  - Jaccard moyens par paires : pre_t0↔first_block **0,101** · pre_t0↔first_5_slots 0,241 · **pre_t0↔first_60s 0,924** · **pre_t0↔first_300s 0,975** · first_block↔first_5_slots 0,546 · first_60s↔first_300s **0,938**.
  - 0 mint sans info de slot (first_block toujours calculable quand le set est non vide).
- **verdict** : **PROMISING** — les définitions **par slots sont matériellement différentes** (first_block = ~6–10 % du set, Jaccard 0,10 vs pre_t0) ; les fenêtres **temporelles 60s/300s sont quasi-redondantes** avec le set pré-t0 complet (Jaccard 0,92–0,98) et entre elles (0,94). Action : garder first_block / first_5_slots comme définitions distinctes, déprécier first_60s / first_300s.

## Fiche triage

- **HYPOTHESIS** : H-S1-E4 — les 5 fenêtres sont matériellement différentes (Jaccard < 0,9).
- **N** : 61 mints (70 fichiers ; 9 sans historique/t0, 14 sets pré-t0 vides).
- **EFFECT** : Jaccard pre_t0↔first_block = 0,10 (distinct) ; pre_t0↔first_60s = 0,92 et pre_t0↔first_300s = 0,98 (redondants) ; first_block = 10 % du set en moyenne.
- **P-VALUE** : n/a (data-quality descriptive, pas de test inférentiel).
- **CI** : n/a.
- **OOS EFFECT** : non mesuré — holdout gelé (non applicable au data-quality).
- **COHORT STABILITY** : n/a (pas de split — qualité des définitions, pas une mesure de performance).
- **TIME STABILITY** : n/a (idem).
- **COST SENSITIVITY** : non évaluée (data-quality, aucune stratégie).
- **LEAKAGE STATUS** : PASS — aucun label, aucun modèle, lecture seule ; règle pré-t0 identique à snapshot.ts.
- **VERDICT** : **PROMISING** — slots = définitions distinctes et utilisables ; fenêtres temporelles = redondantes → à déprécier.

## Suivi suggéré

- Retirer first_60s / first_300s des analyses Phase 2 (ou les garder comme contrôle de redondance explicite).
- Quand le backfill early buyers atteindra n ≥ 30 : comparer la **prédictibilité** des features calculées sur first_block vs pre_t0_set (question ouverte n°1 du labo).
- Noter : 14/61 sets pré-t0 vides (blockTime null ou post-t0) — à surveiller dans le backfill (qualité des données on-chain).
