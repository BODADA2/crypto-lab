# EXP-2026-09-28-flip-s1-flip01 — H-FLIP-01 : cascade longue → reversal vs continuation

**Données :** Binance perp SOLUSDT 1m, 264 960 bougies, 2026-03-28 → 2026-09-27. **Discovery uniquement** (< 2026-07-16T09:35:59Z) ; holdout JAMAIS lu.
**Résultats machine :** `research/results/res-flip-s1-flip01.json`.
**Code :** `lab/flip/` (`run-s1.ts`, `events.ts`, `labels.ts`, `stats.ts`) ; tests `tests/flip-events.test.ts` (21/21) + `tests/flip-s1.test.ts` (15/15).

## Détecteur (gelé Sprint 0)
- 5m-barres construites des klines 1m ; ret ≥ P99,5 intra-discovery (seuil : **+0,337 %**) ; pas de kline 1m manquante dans la barre ; ≥ 3,5 j de recul (t ≥ DS_START + 7 j).
- 201 cascades détectées au total ; discovery : **E1=49, E2=64, E12=15** (fenêtre événement [2026-04-04, 2026-07-16]).
- Caveat §7.2 respecté : **E1/E2 = proxies** (pas de prints historiques de liquidations) ; ~68 % des cascades n'ont PAS de collapse OI concurrent (dOI 1h > P10).

## Résultats (discovery, n=49 E1)

| Métrique | E1 | Baseline | Diff | p | Verdict partiel |
|---|---|---|---|---|---|
| P(reversal_4h) | 81,63 % [68,6 ; 90,0] | all-bars (n=10 300) : 94,88 % | −13,25 pts | ≈0 | E1 < hasard |
| P(reversal_4h) | 81,63 % | big-down appariées (n=484) : 85,74 % | −4,11 pts [−15,4 ; +7,2] | 0,44 | indiscernable |
| P(reversal_1h) | 73,47 % [59,7 ; 83,8] | — | — | — | — |
| P(continuation_4h) | 67,35 % [53,4 ; 78,8] | — | — | — | coexiste avec le reversal |
| Médiane Y@1h signée (sens reversal) | **−32,09 bp** [−59,1 ; −12,9] | — | — | — | **falsifier déclenché** |
| NET@1h, coûts 20 bp (médiane) | −52,09 bp ; P(NET>0) = 20,4 % [11,5 ; 33,6] | — | — | — | non économique |
| Stabilité temporelle D1 vs D2 | 80,77 % (n=26) vs 82,61 % (n=23) | diff −1,84 pt | 0,87 | stable |

- E2 miroir (exploratoire) : P(reversal_4h) = 76,56 % (n=64) — même bruit de fond.
- « Venue adverse » HL-proxy : **n=0** — DATA ISSUE (les 4 865 bougies HL 5m couvrent 2026-09-11→27, hors discovery).

## Verdict : KILLED
Le taux de reversal absolu (81,6 %) n'est que du bruit de marché à l'échelle 5 min : indiscernable des big-down appariées (p=0,44) et INFÉRIEUR au hasard (p≈0). Le falsifier pré-enregistré a tiré : médiane Y@1h signée = **−32,09 bp, IC95 % strictement négatif** → la cascade longue E1, en médiane, **continue** plutôt qu'elle ne se résorbe. NET médian −52 bp à coûts réalistes.
- **OOS :** « holdout gelé » — NON MESURÉ (jamais lu).
- **COHORT STABILITY :** D1/D2 stables (p=0,87) — le NULL est stable, pas instable.
- **LEAKAGE STATUS :** OK — détecteurs/labels construits uniquement sur données ≤ discovery ; `feature_timestamp ≤ t_event` ; exclusion ±4 h des cascades des baselines ; holdout jamais lu ; curseur de labels corrigé (recherche binaire par événement).
- **NEXT_ACTION :** tester la **continuation** comme hypothèse alternative (cf. H-FLIP-04/H-FLIP-07) — pas de re-test de H-FLIP-01 sur discovery.

## Limites / DATA ISSUEs relevées
1. E1 = proxy (pas de prints de liquidations historiques) ; seulement ~32 % des cascades ont un collapse OI concurrent.
2. Métriques Binance : granularité réelle **5 min** (52 992 lignes / 184 j), pas 30 min comme nommé.
3. Bougies HL 5m inutilisables pour discovery (historique < 17 j, période holdout).
