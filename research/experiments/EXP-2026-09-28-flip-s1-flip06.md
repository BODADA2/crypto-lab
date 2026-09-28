# EXP-2026-09-28-flip-s1-flip06 — H-FLIP-06 : effet conditionnel de l'absorption (E12)

**Données :** idem EXP flip01 (Binance perp SOLUSDT 1m, discovery < 2026-07-16T09:35:59Z ; holdout JAMAIS lu).
**Résultats machine :** `research/results/res-flip-s1-flip06.json`.
**Code :** `lab/flip/` (`events.ts:detectAbsorption`, `run-s1.ts`) ; tests verts (36/36 flip).

## Détecteur absorption (gelé Sprint 0)
- E12 : dans les 3 barres 5m après une cascade E1, ret ≥ P1 (−0,331 %) **et** volume ≥ P90.
- Discovery : **15 E12** au total ; côté E1 : **7 absorbées / 42 non absorbées**.

## Résultats (E1, discovery)

| Groupe | n | P(reversal_4h) | P(reversal_1h) | Médiane Y@1h signée (bp) |
|---|---|---|---|---|
| Absorbée (E12) | **7** | 85,71 % [48,7 ; 97,4] | 85,71 % | −19,17 [−93,4 ; +9,5] |
| Non absorbée | 42 | 80,95 % [66,7 ; 90,0] | 71,43 % | −33,66 [−59,5 ; −3,6] |
| Diff (abs − non) | — | +4,76 pts [−23,8 ; +33,3], **p=0,76** | +14,29 pts [−15,0 ; +43,6], **p=0,43** | — |

- NET@1h, coûts 20 bp : absorbée médiane −39,17 bp, P(NET>0)=14,3 % [2,6 ; 51,3] ; non absorbée −53,66 bp, P=21,4 % [11,7 ; 35,9].
- Miroir E2 (exploratoire) : 8 absorbées / 56 non ; diff +12,5 pts, p=0,435 — même absence de signal.

## Verdict : TESTING — INCONNU (n insuffisant)
Le groupe absorbé (**n=7 < 30**) ne permet aucun test formel. Direction observée cohérente avec l'hypothèse (+4,8 pts reversal_4h) mais IC95 % [−23,8 ; +33,3] et p=0,76 : **bruit**. Les deux groupes ont une médiane Y@1h signée négative (l'absorption n'inverse pas le biais continuation vu en H-FLIP-01).
- **OOS :** « holdout gelé » — NON MESURÉ.
- **LEAKAGE STATUS :** OK (idem flip01).
- **NEXT_ACTION :** re-tester quand n_absorbé ≥ 30 (fenêtre plus longue ou calibration — **sans re-tuner la définition E12 sur discovery**). L'absorption E1 reste rare (~14 % des cascades) : l'effet, s'il existe, est un filtre de fréquence, pas un edge de fréquence.

## Note
L'asymétrie Sprint 0 (E1 11 % vs E2 38 % de taux d'absorption) est confirmée en nature (7/49 ≈ 14 %) mais son **effet conditionnel sur le reversal reste non mesurable** à ce n.
