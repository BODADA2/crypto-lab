# EXP-2026-09-28-e3-danger — Danger baseline (famille G)

- **hypothesis_id** : H-S1-E3
- **question** : Le danger (P_DD50_24h, binaire) est-il plus prédictible que le rendement depuis les mêmes features pré-t0 les plus simples (liqT0, turnoverH1, turnoverM5) ?
- **method** : Spearman(feature, dd50_24h ∈ {0,1}) vs Spearman(feature, y6h) et (feature, y1h), univers discovery, tokens appariés pour la comparaison ; IC95 % bootstrap de la différence appariée ||ρ_danger| − |ρ_Y|| (positif = danger plus prédictible). Stabilité : cohortes dex + temps sur ρ(turnoverH1, danger).
- **data** : `data/history/*.jsonl`, lecture seule ; SKHY exclu. **Biais déclaré : tokens chauds → borne OPTIMISTE.**
- **n** : 339 tokens discovery avec dd50_24h non-null et feature non-null (taux de base DD50 = 69,6 %).
- **leakage_status** : **PASS** — features à t0 (liqT0, turnover = volume/liquidité du snapshot t0, ≤ t0ms) ; labels dd50_24h / y post-t0 avec `aberrantMask` (même règle que `labels.ts`) ; Spearman binaire = corrélation de rang point-bisériale, standard ; AUCUNE lecture du holdout.
- **results** :
  - liqT0 (log2) : |ρ_danger| = 0,079 vs |ρ_y6h| = 0,417 → diff = −0,338, IC95 % [−0,212 ; +0,086] (inclut 0).
  - turnoverH1 : |ρ_danger| = 0,132 vs |ρ_y6h| = 0,431 → diff = −0,298, IC95 % [−0,146 ; +0,157] (inclut 0).
  - turnoverM5 : |ρ_danger| = 0,122 vs |ρ_y6h| = 0,519 → diff = −0,397, **IC95 % [−0,318 ; −0,007] (exclut 0 — significatif)**.
  - Même pattern vs y1h (diffs −0,30 à −0,42, sens identique).
  - **Le danger est donc MOINS prédictible que le rendement** — l'inverse de l'hypothèse.
  - Stabilité de ρ(turnoverH1, danger) : pumpswap −0,002 (n=279) vs raydium +0,374 (n=44) — incohérent entre dex ; 1re moitié +0,222 (n=184) vs 2e moitié +0,008 (n=155) — **instable dans le temps**.
- **verdict** : **KILLED** — hypothèse falsifiée : |ρ| danger < |ρ| rendement sur les 3 features (significatif pour turnoverM5), et la corrélation danger elle-même est instable (cohortes + temps). Le binaire DD50 jette l'information de magnitude que le rendement conserve.

## Fiche triage

- **HYPOTHESIS** : H-S1-E3 — |ρ(danger)| > |ρ(rendement)| à features égales.
- **N** : 339 (base DD50 = 69,6 %).
- **EFFECT** : ||ρ_danger| − |ρ_y6h|| = −0,34 (liqT0) / −0,30 (turnoverH1) / −0,40 (turnoverM5) — négatif partout.
- **P-VALUE** : diff turnoverM5 : IC95 % bootstrap [−0,318 ; −0,007] exclut 0 → l'inverse de l'hypothèse est significatif ; liqT0/turnoverH1 non significatifs.
- **CI** : voir diffs ci-dessus (bootstrap apparié, 2000 reps).
- **OOS EFFECT** : non mesuré — holdout gelé.
- **COHORT STABILITY** : instable — pumpswap −0,00 vs raydium +0,37 pour ρ(turnoverH1, danger).
- **TIME STABILITY** : instable — +0,22 (1re moitié) → +0,01 (2e moitié).
- **COST SENSITIVITY** : non évaluée (aucune stratégie construite).
- **LEAKAGE STATUS** : PASS — features ≤ t0ms, labels post-t0 nettoyés, holdout jamais lu ; borne optimiste (tokens chauds).
- **VERDICT** : **KILLED** — falsifiée sur données discovery ; le danger binaire est moins prédictible que le rendement continu.

## Suivi suggéré

- Aucun — hypothèse tuée. Ne pas ressusciter sans nouvelles données (track-unbiased 30 j) ET une justification théorique du pourquoi le binaire surpasserait le continu.
- Leçon méthode : préférer les labels continus (ddMax24h) aux seuils binaires pour la prédictibilité.
