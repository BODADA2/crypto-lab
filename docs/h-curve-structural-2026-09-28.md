# H-CURVE structurel — forme de la progression de bonding curve depuis t=0

**Date :** 2026-09-28 · **Nature :** analyse descriptive, PAS un backtest, PAS de P&L,
aucun seuil optimisé. **Données :** `data/scans/pump-2026-09-24…28.jsonl` (66 562 creates,
2 106 migrates) + `data/history/` (2 727 tokens). **Population : creates GENUINE
uniquement** (`vSolInBondingCurve < 85` au create — 621 late-discovery exclus).
**Anti-censure :** creates ≤ 2026-09-26 (≥ 1 jour de suivi).

**Question :** les futurs migrés ont-ils une courbe de prix/mcap différente des non-migrés
dans les premières minutes/heures ?

## 1. Au create : aucune différence (mesure propre)

| Groupe | n | mcapSol médian | p25 | p75 |
|---|---|---|---|---|
| Migrés (genuine) | 602 | **28,43** | 28,07 | 33,75 |
| Non-migrés (genuine) | 40 633 | **28,42** | 28,07 | 30,43 |

Les médianes sont **identiques au centième près** sur l'univers exhaustif (n = 41 236,
aucun biais de sélection — tous les creates portent `marketCapSol`). La position initiale
sur la courbe ne distingue pas les futurs migrés. Résultat structurel net : **H-CURVE
au create est un nul propre**, cohérent avec la falsification de H-DEVBUY
(`marketCapSol@create ≈ 30 + devBuy`, même mécanisme).

## 2. Le fait structurel qui vide la question : les migrations sont quasi immédiates

| Statistique | Délai create → migrate (genuine, n = 594) |
|---|---|
| Médiane | **0,05 h (3 min)** |
| p25 / p75 | 0,00 h / 0,24 h (14 min) |
| p90 / p95 | 7,38 h / 18,96 h |
| Part ≤ 15 min | **75,6 %** |

**Lecture :** pour trois quarts des tokens qui migrent, il n'existe quasiment **pas de
courbe pré-migration à observer** — la graduation survient dans les minutes qui suivent
la création. La question « quelle forme prend la courbe avant migration » est largement
vide sur ces données : le phénomène à étudier est un sprint de quelques minutes, pas une
progression en heures.

## 3. Trajectoires précoces : mesure contaminée par le post-traitement

Médiane par token du mcapUsd médian, par bucket de temps depuis t=0 (IC 95 % de la médiane).
Seuil de graduation empirique : ~23 500 $ (`prog` = médiane / 23 500).

| Bucket | Migrés | Non-migrés | Lecture |
|---|---|---|---|
| 0–15 min | n=140, **$34 592** IC[19 196–49 988], prog **1,47** | n=99, **$9 760** IC[7 663–11 857], prog 0,42 | IC disjoints — MAIS voir §4 |
| 15–60 min | n=228, $10 594 IC[1 157–20 031], prog 0,45 | n=190, $4 348 IC[3 402–5 294], prog 0,19 | IC recouvrants → non concluant |
| 60–180 min | n=187, $4 386 IC[1 290–7 482], prog 0,19 | n=100, $4 564 IC[2 622–6 507], prog 0,19 | **identiques** |
| 180–720 min | n=137, $6 233 IC[1 195–11 271] | n=22 (< 30) | non-migrés : n insuffisant |

## 4. Pourquoi le bucket 0–15 min ne prouve rien (biais post-traitement)

La différence apparente à 0–15 min ($34,6k vs $9,8k, IC disjoints) est **mécanique**,
pas prédictive :
- 75,6 % des migrations surviennent dans les 15 premières minutes (§2) : les snapshots
  « migrés » de ce bucket sont majoritairement **post-migration** (liquidité réelle
  post-graduation, prog médian 1,47 > 1), tandis que les « non-migrés » sont encore sur
  la bonding curve. On compare un après à un avant.
- L'utiliser comme signal d'entrée serait du **biais post-traitement** pur : au moment
  où la différence est mesurable, l'événement a déjà eu lieu.
- Au-delà de 15 min, les trajectoires sont indiscernables (60–180 min : $4 386 vs
  $4 564, IC largement recouvrants).

## 5. Couverture : l'échantillon non-migré est lui-même sélectionné

| Bucket | Migrés avec ≥ 1 snapshot | Non-migrés avec ≥ 1 snapshot |
|---|---|---|
| 0–15 min | 140/603 = **23,2 %** | 99/40 633 = **0,2 %** |
| 15–60 min | 228/603 = **37,8 %** | 190/40 633 = **0,5 %** |
| 60–180 min | 187/603 = **31,0 %** | 100/40 633 = **0,2 %** |

Fichiers history trouvés : 472/603 migrés (78 %) contre 226/40 633 non-migrés (0,6 %).
Les 226 non-migrés suivis ont été sélectionnés par le collecteur **parce qu'ils
semblaient chauds** : ce n'est pas un échantillon représentatif des 40 633. Toute
comparaison de trajectoires sur ces données compare des migrés à des « presque-migrés »,
pas à la population.

Premier snapshot : médiane 38,1 min (migrés) / 16,2 min (non-migrés) après t=0 —
trop tardif et trop clairsemé pour la question posée.

## 6. Verdict H-CURVE structurel

| Sous-question | Verdict |
|---|---|
| La position initiale sur la courbe distingue-t-elle les futurs migrés ? | **NON** — médianes identiques (28,43 vs 28,42 SOL, n=41k, mesure propre) |
| Existe-t-il une forme de courbe pré-migration caractéristique ? | **NON MESURABLE ici** — 75,6 % des migrations ≤ 15 min : il n'y a presque pas de « pré » à observer |
| Les trajectoires 0–15 min diffèrent-elles ? | Différence **mécanique** (post-migration vs bonding curve), pas un signal |
| Les trajectoires > 15 min diffèrent-elles ? | **NON** — $4 386 vs $4 564 à 60–180 min, IC recouvrants |

**H-CURVE reste ouverte comme question, mais elle exige le suivi non biaisé**
(`data/track-unbiased/`, cadence 5 min dès t=0) : c'est exactement le test
**T-CURVE-CLEAN** de la batterie pré-enregistrée, avec snapshots strictement
pré-migration. Sur les données historiques, la réponse honnête est : *on ne peut pas
répondre proprement, et voici pourquoi*.

## 7. Ce qui manque (checklist pour la version propre)

1. Snapshots dès t=0 à cadence ≤ 5 min sur un échantillon non sélectionné → en cours
   (`track-unbiased`, 5 % des creates genuine).
2. `migrateAt` fiable par token pour exclure le post-traitement → le tracker l'enregistre
   (double mécanisme : événement `migrate` + bascule `dexId`).
3. Couverture des non-migrés comparable à celle des migrés → l'échantillonnage 5 %
   aveugle la garantit par construction.
4. Délai create→découverte documenté (`discoveredAt`) pour quantifier la latence
   exécutable → enregistré par le tracker.

---
*Analyse exécutée le 2026-09-28 sur données réelles du collecteur 24–28 sept. 2026.
Méthode : scripts `/tmp/hcurve_struct.py`, `/tmp/hcurve_v2.py` (médianes par token,
IC 95 % ≈ 1,57·IQR/√n). Aucun seuil optimisé, aucun P&L simulé, aucune transaction.*
