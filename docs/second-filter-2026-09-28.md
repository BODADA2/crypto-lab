# Second filtre — caractérisation des gagnants + backtest momentum-confirm : ABANDON

**Date :** 2026-09-28 (nuit) · **Contexte :** après l'invalidation du filtre combiné par
l'audit late-discovery (`docs/audit-late-discovery-2026-09-28.md`), on cherche un second
filtre qui sépare, parmi les migrés, les gagnants (continuation ≥ x2 post-migration) des autres.
**Scripts :** `lab/backtest/characterize-winners.ts` (première passe, contaminée PH — sections
prix C/D/E restant valides), `lab/backtest/audit-late-discovery.ts` (re-mesure genuine),
`lab/backtest/run-momentum-confirm.ts` (backtest walk-forward).
**Données :** `data/backtests/winners-characterization-2026-09-28.json`,
`data/backtests/momentum-confirm-2026-09-28.json`.
Aucun seuil du moteur modifié, aucune transaction réelle, commits locaux uniquement.

## 1. Caractérisation des gagnants (migrés GENUINE, 24–27, suivi 12h complet)

- Migrés genuine : **n=733**, suivis avec proxy de prix : **n=558**.
- Gagnants (continuation ≥ x2 depuis le 1er snapshot post-migration) : **45 (8.06 %)**.
- Gros gagnants (≥ x5) : **11 (1.97 %)**. Continuation médiane : **x1.00** (la moitié des
  migrés ne re-dépasse jamais leur premier print post-migration).

Features create-time → taux de gagnants (IC 95 %) :

| Feature | Résultat | Lecture |
|---|---|---|
| devBuy (<1 / 1–1.3 / 1.3–2 / 2–3 / ≥3 SOL) | 6.5 % / 15.0 % / 10.0 % / 15.8 % / 10.2 %, IC qui se recouvrent | **aucun signal** |
| Dev répété vs nouveau | 5.4 % vs 9.9 %, IC quasi-joints | indice faible, non concluant |
| Heure UTC (tranches 6h) | 4.7 % – 10.9 %, IC qui se recouvrent | aucun signal |
| Délai create→migrate | <15min 7.4 %, 15–60min 14.5 % (n=62) | indice faible, n insuffisant |

**Aucune feature create-time ne sépare nettement les gagnants.** Le problème n'est pas le
taux de migration — c'est la taille des gagnants, et rien au create ne la prédit ici.

## 2. Signal précoce post-migration (1er snapshot ≤ 60 min après migration, genuine)

| Signal | Taux de gagnants | IC 95 % |
|---|---|---|
| Imbalance acheteurs m5 > +0.2 (n=87) | **25.3 %** | 16.2–34.4 |
| Imbalance neutre (n=221) | 12.2 % | 7.9–16.5 |
| Imbalance vendeurs < −0.2 (n=94) | **3.2 %** | 0.0–6.7 |
| priceChange m5 +10..+50 % (n=79) | 20.3 % | 11.4–29.1 |
| priceChange m5 −10..+10 % (n=188) | 5.3 % | 2.1–8.5 |

Un signal différentiel **réel** : l'order-flow acheteur précoce sépare les continuations
(25 % vs 3 %, CIs disjoints). Candidat naturel de "second filtre" : n'entrer qu'avec
confirmation momentum.

## 3. Backtest walk-forward — momentum-confirm : ABANDON

**Stratégie :** sur migrés genuine — signal = 1er snapshot ≤60min post-migration avec
imbalance > +0.2 (≥10 txns m5) ; **entrée au 1er snapshot APRÈS le signal** (pas de lookahead) ;
sortie TP+100 % / SL-50 % / time-stop 48h ; hurdle 8 % par round-trip.
Baseline = même chose SANS signal (acheter tous les migrés au proxy).

| | Train (24–25) | Test (26–27) |
|---|---|---|
| SANS signal | n=52, net médian −58.6 %, wins 17 % | n=182, net médian −17.6 %, wins 11.5 % |
| AVEC signal | n=18, net médian −56.3 % | **n=43, net médian −75.8 %**, wins 18.6 % |

**Falsificateur déclenché : net médian test = −75.78 % ≤ 0 → ABANDON propre.**

Pourquoi le signal ne se trade pas : l'imbalance acheteuse identifie la chaleur, mais avec
des snapshots clairsemés l'entrée (snapshot suivant, délai médian ~30 min) **achète le top** —
MFE médian 0.00 % sur test : la moitié des trades ne revoit jamais son prix d'entrée.
Le signal prédit la continuation *depuis le proxy*, pas depuis un prix d'entrée exécutable.
La baseline "acheter la migration" est elle aussi profondément négative.

## 4. Conclusion

- **Pas de second filtre validé.** Ni en create-time (aucune feature), ni en confirmation
  post-migration (signal réel mais inexécutable avec la densité actuelle des snapshots).
- Le falsificateur a fait son travail : on abandonne au lieu de sur-ajuster.
- **Ce qui débloquerait :** des snapshots denses et non biaisés dès le create
  (→ `docs/unbiased-tracking-spec-2026-09-28.md`). Avec une entrée exécutable dans les
  minutes du signal, la question momentum-confirm mériterait d'être re-testée — pas avant.

---
*Exécuté le 2026-09-28, données réelles du collecteur 24–28 sept. 2026.
Aucune donnée fabriquée, aucun seuil modifié, aucune transaction réelle.*
