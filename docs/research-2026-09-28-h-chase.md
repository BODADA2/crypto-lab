# Fiche de recherche — H-CHASE : filtre d'entrée anti-poursuite

**Date :** 28 septembre 2026. **Origine :** TikTok @sixpathsss —
« do not put your bread in charts that go all the way up ».
**Statut :** backtesté n ≥ 30 sur données réelles → **NO ACTION** (non concluant).

## Opérationnalisation (pré-enregistrée avant les résultats)

- **Barre candidate** : prix > 0, liquidité ≥ 20 000 $, index ≥ 3 dans la série
  (assez d'historique pour mesurer le mouvement — walk-forward strict, jamais de futur).
- **Métrique chase(t)** = prix(t) / min(prix(t−1), prix(t−2), prix(t−3)) − 1.
  Le min sur 3 barres capte aussi les pics en V dans la fenêtre (~40 min vu
  l'espacement médian des observations, 13,8 min).
- **Seuil primaire : chase ≥ +50 % ⇒ « vertical »** (rejet / report de l'entrée).
  Justification : +50 % en ~40 min sur un token déjà liquide = l'équivalent mesurable
  du « straight up » de la vidéo ; ≈ P94 de la distribution observée sur les barres
  candidates (sélectif sans vider les buckets). Seuil secondaire +100 % en sensibilité.
- **Variante A « baseline »** : signal = première barre candidate, entrée à t+1.
- **Variante B « chase-filter »** : signal = première barre candidate avec chase < 50 %,
  entrée à t+1 ; token écarté si aucune barre ne passe (réaliste : le trader attend
  que ça se calme, il ne force pas l'entrée).
- **Sorties identiques** : régime scalp via `simulateExit` (TP +30 %, SL −20 %, time-stop),
  coûts taille 50 $, frais 1,3 %, slippage plafonné 3 % — même protocole que H-EXIT.

## Résultats (2713 tokens, `data/history/`, rapport JSON `data/backtests/chase-filter-2026-09-28.json`)

| Métrique | Baseline A (n=445) | Filtrée B (n=387) |
|---|---|---|
| Rendement moyen / trade | +11 095,6 % ⚠️ | −4,2 % |
| **Rendement médian / trade** | **−1,0 %** | **−1,3 %** |
| Win rate | 47,4 % | 45,5 % |
| MFE médian | x1,21 | x1,20 |
| Max 1 trade | x49 398 | x9 |

⚠️ La moyenne de A est fabriquée par **un seul trade à x49 398** (top-5 = 100,1 %
de la somme des rendements) — le même phénomène de ticks aberrants qu'en H-EXIT.
Le verdict repose donc sur la **médiane**, pas la moyenne.

**Bucket observationnel dans A** (verticalité mesurée au seuil +50 %, n concluant) :
- entrées « verticales » (n=154) → MFE médian **x1,25**
- entrées « calmes » (n=291) → MFE médian **x1,20**

**Sensibilité seuil +100 %** : n=408, moyenne −4,4 %, win rate 44,9 % — même histoire.

## Verdict : NO ACTION

1. **Le filtre n'améliore rien** : médiane −1,3 % vs −1,0 % (écart 0,3 pt = bruit),
   win rate légèrement inférieur (45,5 % vs 47,4 %), MFE médian identique (x1,20 vs x1,21).
2. **Le bucket observationnel contredit la thèse de la vidéo** : les entrées verticales
   (n=154, échantillon concluant) affichent un MFE médian de x1,25 contre x1,20 pour les
   calmes. Le momentum à court terme persiste un peu — « acheter la verticale » n'est pas
   le désastre annoncé, du moins pas mesurable ainsi sur ces données.
3. Le filtre a bien exclu le ticket de loterie x49 398 — mais exclure un outlier
   (probablement un tick aberrant) n'est pas une amélioration de stratégie.

**Conséquence : pas de module `lab/signals/chase.ts`.** L'hypothèse reste en piste de
recherche ; si elle revient, ce sera avec une autre opérationnalisation
(ex. distance au plus-haut local plutôt que chase trailing, ou testée en paper
discrétionnaire dans le compte N).

## Notes latérales (hors verdict)

- Les deux médianes sont **négatives** (−1,0 % / −1,3 %) : le régime scalp à 1,3 % de
  coûts sur ces entrées perd légèrement au médian — cohérent avec les « médianes
  négatives » de H-EXIT. Le problème n'est pas l'entrée, c'est l'espérance du scalp.
- Le script `lab/backtest/run-chase-filter.ts` est conservé (outillage de recherche,
  mêmes conventions que `run-catalyst-migration.ts` / `run-exit-comparison.ts`).
  Aucune modification du Risk Engine, de l'exécuteur, de la politique ni des poids.
