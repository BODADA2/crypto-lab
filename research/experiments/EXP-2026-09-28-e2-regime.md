# EXP-2026-09-28-e2-regime — Régime de marché (famille J)

- **hypothesis_id** : H-S1-E2
- **question** : Le régime module-t-il les risk filters ? Le signal Phase 1 « frénésie → Y@1h négatif » (H-PRED-FLOW-01, X = sellsM5 à t0) est-il stable à travers les terciles de régime ?
- **method** :
  1. Régime par jour calendaire UTC (2026-09-24 → 2026-09-28) depuis `data/scans/` : launches/heure (mints uniques par jour de premier `createdAt`), graduations/heure (proxy : mint vu hors `pumpfun` au moins une fois), turnover H1 médian à t0 (history, discovery) → z-scores → score composite → terciles.
  2. Par tercile : n, Spearman(sellsM5@t0, y1h), IC95 % bootstrap du Spearman.
  3. Interaction régime × signal : test z de Fisher sur les paires de terciles.
  4. Stabilité : cohortes dex + moitiés temporelles (ρ global par cohorte).
- **data** : `data/history/*.jsonl` + `data/scans/*.json` (352 fichiers), lecture seule. **Biais déclaré : tokens chauds → borne OPTIMISTE.**
- **n** : 327 tokens discovery avec y1h non-null et jour t0 couvert par le régime (T1 : 155, T2 : 74, T3 : 98).
- **leakage_status** : **PASS avec caveat documenté** — signal/labels : mêmes règles que Phase 1 (≤ t0ms vs post-t0, `aberrantMask`, SKHY exclu) ; **le régime du jour est calculé ex-post** (journée complète connue). En production il faudrait un régime trailing (jours précédents). Le test mesure la modulation rétrospective, pas un signal temps réel. AUCUNE lecture du holdout.
- **results** :
  - Table de régime : 09-24 T3 (43,3 launches/h) · 09-25 T2 · 09-26 T3 (40,6/h) · 09-27 T1 · 09-28 T1 (partiel : ~3,4 h de couverture scan, taux normalisés par heure).
  - Tercile 1 : n=155, **ρ = −0,239**, p=2,3×10⁻³, IC95 % [−0,401 ; −0,081].
  - Tercile 2 : n=74, **ρ = −0,171**, p=0,14, IC95 % [−0,423 ; +0,083] (inclut 0 — sous-puissant).
  - Tercile 3 : n=98, **ρ = −0,369**, p≈1×10⁻⁴ (underflow), IC95 % [−0,551 ; −0,149].
  - **Interactions (Fisher z) : T1 vs T3 p=0,27 ; T1 vs T2 p=0,62 ; T2 vs T3 p=0,17 → aucune différence significative.**
  - Stabilité cohortes : pumpswap ρ=−0,274 (n=270, p=3,1×10⁻⁶) ; raydium ρ=+0,168 (n=42, p=0,28, non significatif) — cohérent avec le bémol Phase 1 (effet concentré sur pumpswap).
  - Stabilité temporelle : 1re moitié ρ=−0,310 (p=2,2×10⁻⁵) ; 2e moitié ρ=−0,239 (p=2,3×10⁻³) — même direction.
- **verdict** : **NULL** — pas de modulation significative du signal par le régime (toutes les interactions p > 0,17). Le signal reste négatif dans les 3 terciles (T2 sous-puissant). Caveats : 5 jours seulement, régime ex-post, T2 = un seul jour (09-25).

## Fiche triage

- **HYPOTHESIS** : H-S1-E2 — le régime du jour module le signal frénésie→Y@1h (interaction régime × signal).
- **N** : 327 (T1 155 / T2 74 / T3 98).
- **EFFECT** : ρ = −0,239 (T1) / −0,171 (T2) / −0,369 (T3) — même direction partout.
- **P-VALUE** : interactions Fisher z : 0,27 / 0,62 / 0,17 → non significatives.
- **CI** : T1 [−0,40 ; −0,08] ; T2 [−0,42 ; +0,08] ; T3 [−0,55 ; −0,15].
- **OOS EFFECT** : non mesuré — holdout gelé.
- **COHORT STABILITY** : pumpswap ρ=−0,274 (p=3×10⁻⁶) ; raydium ρ=+0,17 (n=42, p=0,28, non conclusif).
- **TIME STABILITY** : stable en direction — −0,31 puis −0,24, p < 0,01 dans les deux moitiés.
- **COST SENSITIVITY** : non évaluée (aucune stratégie construite).
- **LEAKAGE STATUS** : PASS — caveat : régime calculé ex-post (version temps réel = trailing) ; holdout jamais lu. Borne optimiste (tokens chauds).
- **VERDICT** : **NULL** — le régime ne module pas significativement le risk filter dans cet échantillon.

## Suivi suggéré

- Re-test avec régime **trailing** (jours J−1..J−7) sur `data/track-unbiased/` (30 j de collecte → ~30 jours de régime, terciles robustes).
- Si toujours NULL : abandonner la piste « régime » pour ce signal (principe : ne pas confondre absence de preuve et preuve d'absence — ici n total = 327, puissance limitée pour les interactions).
