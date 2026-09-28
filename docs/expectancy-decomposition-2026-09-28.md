# Décomposition économique de l'espérance négative — 2026-09-28

**Stratégie :** H-REF-MOM (V10) — entrées verticales (chase ≥ 0,5), sorties scalp.
**Code :** `lab/backtest/run-expectancy-decomposition.ts` (+ `tests/expectancy-decomposition.test.ts`, 21 verts).
**Données :** `data/history/`, snapshot 2026-09-28 12:23 UTC — 2 926 mints, 35 339 ticks, 242 trades.
**Biais :** données biaisées vers les tokens chauds → **toute mesure est une BORNE OPTIMISTE**.
**Holdout :** `data/track-unbiased/` jamais touché. Phase DÉCOUVERTE, aucun fit.

> Le répertoire `data/history/` est alimenté en continu par le scanner : le
> snapshot exact (comptes ci-dessus) est la référence de ce rapport.

## 0. Verdict

**NO EVIDENCE OF EDGE.** Même à l'échelon le plus favorable (entrée au prix du
signal, zéro coût), l'espérance winsorisée (+2,70 %, IC95 % [−4,52 ; +12,34])
n'est pas significativement positive et la médiane est négative (−14,21 %).
Tous les échelons réalisables sont négatifs (brut t+1 : −8,92 % ; net : −10,39 %).
**Il n'y a pas d'edge brut à détruire : le problème n'est pas l'exécution.**

Recommandation (règle d'arrêt pré-engagée) : **arrêter l'optimisation de cette
famille de stratégies** (entrées momentum/scalp sur tokens chauds suivis).
Les efforts doivent aller à la collecte (données propres, fast lane) et à des
familles de signaux différentes — pas à raffiner celle-ci.

## 1. Échelle counterfactual (question centrale)

Chaque trade est rejoué une fois à coûts nuls (le chemin de sortie ne dépend
que du prix) ; les échelons en dérivent algébriquement. Moyennes winsorisées
(p99), n=242.

| Échelon | Moy. wins. | IC 95 % | Médiane | Moy. brute |
|---|---|---|---|---|
| brutIdéal (entrée au signal, zéro coût) | **+2,70 %** | [−4,52 ; +12,34] | −14,21 % | +3,47 % |
| brutRéel (entrée t+1, zéro coût) | **−8,92 %** | significative*<0 | −21,71 % | +20 672 % |
| fraisSeuls (t+1, frais 1,3 %) | −10,10 % | — | −22,73 % | +20 402 % |
| slipSeul (t+1, slippage linéaire) | −9,21 % | — | −21,86 % | +20 671 % |
| **net (t+1, frais + slippage)** | **−10,39 %** | — | **−22,88 %** | +20 401 % |

\* IC bootstrap de la moyenne brute inutilisable (l'outlier +4 939 704 % explose
le rééchantillonnage : borne sup +62 040 %) — voir §5. L'analyse secondaire
sans l'outlier (§5) donne des IC propres : brutRéel −9,54 % [−16,24 ; −2,73],
net −11,01 % [−17,58 ; −4,30] — significativement négatifs.

**Lecture :** il n'y a pas de scénario « brut +4 % → coûts −7 % → net −3 % ».
Le brut réaliste est déjà à −8,92 %, et même l'idéal (+2,70 %) ne se distingue
pas de zéro. **Cas « brut −2 % → coûts −5 % → net −7 % »** : chercher un
meilleur hedge ou optimiser les entrées de cette famille, c'est raffiner une
stratégie sans edge démontré.

## 2. Décomposition par composante (points d'espérance winsorisée)

| # | Composante | Mesure | Points |
|---|---|---|---|
| 9 | **Drift négatif intrinsèque** (brutRéel avant tout coût) | moy. wins. −8,92 %, médiane −21,71 % | **−8,92** |
| 7 | **Timing d'entrée** (délai t→t+1 anti-lookahead) | brutIdéal − brutRéel | **−11,62** |
| 4 | **Frais** F1+F2 (1,3 % aller-retour) | brutRéel − fraisSeuls | −1,18 |
| 3 | **Slippage** (linéaire size/liq, cap 3 %, ticket 50 $) | brutRéel − slipSeul | −0,29 |
| 2 | Coût de sortie (½ frais + slipOut) | déduit du précédent | ≈ −0,74 |
| 1 | Coût d'entrée (½ frais + slipIn + délai) | déduit des précédents | ≈ −12,06 |
| 8 | **Timing de sortie** | stops traversés en gap : médiane réalisée −37,1 % vs seuil −20 % (gap médian −17,1 pts) ; MFE gap médian 0 | structurel |
| 6 | **Sélection des tokens** | médiane chaleur-froid −32,6 % vs chaleur-chaud −20,6 % → le biais hot-token rend la mesure optimiste d'~12 pts | biais +12 |
| 5 | **Impact de liquidité** | ticket 10 $ → 500 $ : −10,16 % → −12,63 % (linéaire, borne basse) ; cap 3 % touché par 24,8 % des trades à 500 $ | −2,5 max |
| 10 | **Biais d'intersection des mints** | univers validation : net +60 224 % entièrement porté par 1 mint aberrant (médiane −25,3 %) ; moyennes brutes inutilisables (+20 672 %) | fatal aux moyennes |

**Hiérarchie :** drift (−8,92) ≫ frais (−1,18) > slippage (−0,29). Les coûts
expliquent ~1,5 point sur ~10,4. **L'espérance est négative parce que les
tokens sélectionnés décroissent, pas à cause des coûts.**

Le timing d'entrée (−11,62) mérite lecture : le signal « vertical » (chase ≥ 0,5
= déjà +50 % sur 3 barres) arrive tard — entrer au prix du signal plutôt qu'une
barre après vaudrait +11,6 pts. Mais même cet idéal reste non significatif
(+2,70 % IC [−4,52 ; +12,34]) : un meilleur timing ne crée pas d'edge, il
réduit la perte.

## 3. Sensibilité au ticket (modèle linéaire officiel + variante sqrt exploratoire)

| Ticket | Net linéaire (wins.) | Net sqrt (explor.) | Cap 3 % touché | Ticket > 10 % liq. |
|---|---|---|---|---|
| 10 $ | −10,16 % | −10,23 % | 0,0 % | 0,0 % |
| 25 $ | −10,25 % | −10,31 % | 0,0 % | 0,0 % |
| 50 $ | −10,39 % | −10,39 % | 0,0 % | 0,0 % |
| 100 $ | −10,67 % | −10,51 % | 10,9 % | 0,0 % |
| 250 $ | −11,44 % | −10,75 % | 14,7 % | 0,4 % |
| 500 $ | −12,63 % | −11,01 % | 24,8 % | 0,8 % |

Même à 10 $ (coûts quasi nuls : 1,3 % + 0,24 % de slippage), le net est
**−10,16 %** : les coûts ne sont pas l'histoire. La variante sqrt (ancrée au
linéaire à 50 $, cap 15 %, **exploratoire non validée**) montre que si l'impact
réel est sur-linéaire, la dégradation est plus douce que le linéaire cappé —
dans tous les cas, le ticket n'inverse rien.

**Avertissement :** à 250–500 $, le modèle linéaire est une borne basse optimiste ;
l'impact réel sur des pools de ~20 k$ est probablement pire que modélisé. La
liquidité ne doit jamais être supposée supporter ces tailles.

## 4. Forensique de l'outlier +4 939 704 %

**Mint :** `SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3` — 73 observations.

| Heure (27 sept.) | Prix | Liquidité |
|---|---|---|
| 14:03 | 192,095 $ | 2 490 629 $ |
| 14:22 | **0,003832 $** | 1 960 274 $ |
| 14:35 | 192,48 $ | 2 497 794 $ |
| 14:48 | 192,095 $ | 2 625 768 $ |
| 15:03 | **0,003838 $** | 2 103 033 $ |
| 15:22 | 192,095 $ | 2 636 101 $ |

Le prix oscille entre ~192 $ et ~0,0038 $ (ratio ~50 000×) : **glitch décimal du
flux DexScreener**, pas un moonshot. Le trade est entré sur le tick aberrant
(0,0038 $) et sorti au retour à 192 $ → +4 939 704 % fictifs. **Incapturable en
réalité** : personne n'a pu acheter à 0,0038 $ quand le marché cotait 192 $.

**Fréquence :** 1 trade aberrant isolé sur 242 (0,4 %), mais il contribue
**+20 412 points** à la moyenne brute (brutRéel +20 672 % avec, −9,54 %
winsorisé sans — la moyenne brute est inutilisable). Autres mints à pattern
glitch identifié : `6GmAFSYs4gk3` (4 ticks ~×4 900), `4k3Dyjzvzp8e`,
`pumpCmXqMfrs`, `taoC6xyv2v8t` — aucun n'a produit de trade aberrant retenu.

**À ne pas confondre :** 31 trades (12,9 %) ont une MAE ≤ −90 % — ce sont de
**vraies morts** (le token va à zéro entre deux snapshots, écarts permanents
vérifiés), pas des glitches. Elles font partie de l'espérance réelle : le
stop-loss à −20 % est traversé en gap.

**Exercice secondaire (outlier retiré, n=241) — puis REMIS dans le résultat
principal :**

| Échelon | Moy. wins. | IC 95 % | Médiane |
|---|---|---|---|
| brutIdéal | +3,13 % | [−3,88 ; +12,01] | −14,21 % |
| brutRéel | −9,54 % | [−16,24 ; −2,73] | −22,02 % |
| net | −11,01 % | [−17,58 ; −4,30] | −23,24 % |

Sans l'outlier, le verdict est inchangé : l'idéal n'est pas significatif, tout
le réalisable est significativement négatif.

## 5. Univers de mints disjoints (découverte / calibration / validation)

Tiers chronologiques par première observation, **aucun mint en commun**.

| Univers | Mints | Trades | brutIdéal (wins.) | brutRéel (wins.) | Net (wins.) | Médiane net |
|---|---|---|---|---|---|---|
| découverte | 970 | 94 | +6,48 % | −6,38 % | −7,91 % | −21,6 % |
| calibration | 970 | 66 | +4,87 % | −7,29 % | −8,82 % | −25,7 % |
| validation | 971 | 82 | −1,12 % | +64 151 % | **+60 224 %** | **−25,3 %** |

L'univers « validation » affiche +60 224 % : c'est **entièrement l'artefact
SKHY** (tombé dans le troisième tiers chronologique), pendant que sa médiane
reste à −25,3 %. Démonstration par l'absurde : sans discipline sur les
outliers, n'importe quel découpage peut « valider » n'importe quoi. Découverte
et calibration convergent vers net ≈ −8 % : le résultat est stable, et négatif.

## 6. Analyse des sorties — le stop traversé en gap

| Sortie | n | Part | Médiane brut |
|---|---|---|---|
| take-profit | 77 | 32 % | +49,4 % |
| **stop-loss** | 127 | **53 %** | **−37,1 %** |
| time-stop | 26 | 11 % | +0,8 % |
| end-of-data | 8 | 3 % | −1,1 % |

Le stop à −20 % se réalise à **−37,1 % en médiane** (−17,1 pts de traversée) :
sur des barres de ~15 min, les memecoins gapent à travers le stop. Le « timing
de sortie » n'est pas un paramètre à optimiser — c'est une propriété de la
structure de marché : **la sortie d'urgence n'existe pas à l'échelle du tick
promis**. (Le MFE gap médian de 0 indique par ailleurs qu'il n'y a typiquement
rien de plus à capturer en sortie.)

## 7. Sélection et biais hot-token

| Bucket liquidité d'entrée | n | Moy. wins. brut | Médiane brut |
|---|---|---|---|
| liq-Q1 (≤ 25 k$) | 60 | +1,94 % | −22,6 % |
| liq-Q2 | 60 | −7,73 % | −22,0 % |
| liq-Q3 | 59 | −4,61 % | −21,1 % |
| liq-Q4 | 59 | **+848 %** (artefact glitch) | −21,7 % |

| Chaleur (nb d'observations) | n | Moy. wins. brut | Médiane brut |
|---|---|---|---|
| froid | 80 | −25,91 % | **−32,6 %** |
| tiède | 79 | −2,15 % | −20,5 % |
| chaud | 79 | +634 % (artefact glitch) | −20,6 % |

Deux constats : (a) les moyennes des buckets « riches » sont des artefacts
(le glitch SKHY à 2 M$ de liquidité et `6GmAFSYs4gk3` à 4,9 M$ trustent Q4) ;
(b) les médianes disent la vérité — **les tokens froids (peu suivis) perdent
plus (−32,6 %) que les chauds (−20,6 %)**. Le biais de `data/history/` vers les
tokens chauds rend donc toutes nos mesures **optimistes d'environ 12 points en
médiane**. Le vrai univers (tokens froids inclus) est pire que ce rapport.

## 8. Réponse à la question centrale

> Existe-t-il un edge brut entièrement détruit par les coûts, ou n'y a-t-il
> déjà aucun edge avant coûts ?

**Il n'y a déjà aucun edge avant coûts.** Le brut réaliste est à −8,92 %
(significativement négatif), et même le brut idéal (+2,70 %) ne se distingue
pas de zéro avec une médiane à −14,21 %. Les coûts (frais 1,18 pt + slippage
0,29 pt) sont un bruit de fond devant le drift (−8,92 pts). **Ce n'est pas un
problème d'exécution ni de structure de coûts — c'est l'absence de signal.**

## 9. Méthode, limites et invalideurs

- Sortie rejouée une fois à coûts nuls (le chemin TP/SL/time-stop ne dépend
  que du prix) ; échelons algébriques — aucune recalibration, aucun
  ré-échantillonnage stratégique.
- Winsorisation p99 bilatérale : ne cappe que ~2–3 trades sur 242 — suffisante
  ici (l'outlier est isolé), mais fragile par construction si les artefacts se
  multiplient. Les médianes sont la statistique de référence de ce rapport.
- L'échelon « idéal » (entrée au prix du signal) est une **borne supérieure
  non entièrement réalisable** (prix snapshot 15 min, pas d'intra-bar).
- Le découpage en univers disjoints est chronologique : les tiers portent aussi
  des différences de régime — documenté, pas corrigé.
- **Invalideurs :** (1) si le holdout 30 j (données propres) montre un brutIdéal
  significativement positif → rouvrir ; (2) si une famille de signaux différente
  (pas momentum/scalp) montre un edge brut sur données propres → ce verdict ne
  la concerne pas ; (3) si la fast lane (< 2 s) change le timing d'entrée d'un
  ordre de grandeur, refaire l'échelon idéal avec des données tick.

## 10. Recommandation

1. **Arrêter l'optimisation de la famille momentum/scalp** (règle d'arrêt
   déclenchée : NO EVIDENCE OF EDGE).
2. Garder la machinerie (échelle counterfactual, forensique glitch, univers
   disjoints) comme **standard de diagnostic** pour toute future famille.
3. Ajouter un **filtre anti-tick-aberrant** au pipeline de données (prix déviant
   ≥ 100× des deux voisins → observation rejetée) : 1 trade sur 242 a faussé
   toutes les moyennes brutes du labo pendant des semaines.
4. Priorité collecte : fast lane (timing d'entrée réel) + holdout 30 j —
   c'est là que le prochain edge potentiel se mesurera, pas dans ces données.
