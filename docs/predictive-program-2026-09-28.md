# Programme prédictif — trouver la source d'une espérance positive (2026-09-28)

## Question centrale

La famille momentum/scalp est abandonnée (NO EVIDENCE OF EDGE, cf.
`docs/expectancy-decomposition-2026-09-28.md`). Nouvelle question : existe-t-il
une propriété observable **avant** le mouvement qui distingue les tokens à
rendement futur positif de ceux à rendement futur négatif ?

**Phase 1 (ce document) : NE PAS construire de stratégie.** Chercher d'abord une
relation prédictive stable entre variables à t0 et rendement futur Y.

## Méthode — protocole partagé

`lab/predictive/universe.ts` (committé, 9 tests verts) :

- **t0** = premier snapshot avec `liquidityUsd ≥ 20 000 $` et `priceUsd > 0`.
- **Y** = rendement futur (prix nettoyés) sur 1h / 6h / 24h ; `null` si l'horizon
  n'est pas couvert (pas d'extrapolation).
- **Filtre anti-tick-aberrant** : prix ≥100× (ou ≤1/100) des deux voisins =
  donnée corrompue (cf. glitch SKHY).
- **Univers DISJOINTS** par hash FNV du mint : discovery (<50), calibration
  (50–74), **holdout gelé** (≥75) — mesuré une seule fois, jamais recalibré après.
- Mesures : Spearman (rang, robuste), déciles top-vs-bottom, IC95 % bootstrap,
  stabilité temporelle (2 moitiés) et par cohorte, avec/sans outliers.
- Métriques obligatoires par hypothèse : moyenne, médiane, IC, distribution
  complète, drawdown, taux de pertes extrêmes, stabilités, n. **n ≥ 30.**
- Données `data/history/` (2926 mints, ~35k ticks, séries COURTES ~12
  ticks/mint) biaisées vers les tokens chauds → **toute mesure = borne
  OPTIMISTE**, déclarée partout. `data/track-unbiased/` jamais touché.

## Résultats par domaine

### 1. Wallet behavior + early buyers (PISTE PRIORITAIRE) — NON CONCLUANT (n=1)

Pipeline complet, 28/28 tests verts, grille anti-overfitting dure (holdout non
analysable par construction). État des données : 11 fichiers earlybuyers →
**8 lignes jointes : 1 discovery, 4 calibration, 3 holdout (gelé)**. Couverture
Y : 1h: 7, 6h: 0, 24h: 0 — séries de 1–10 ticks, le 24h est non mesurable.

H-PRED-WAL-01 à 09 : **toutes NON TESTABLES**. Descriptif seul (n=1) : token
avec 50 buyers dans la même seconde (gini 0,935, profil snipe/bundle), Y@1h
+45,2 %. Rétention (`walletsCovered = 0`, échecs Helius -32015) et historique
dev non mesurables. **La question prioritaire reste ouverte** : attendre n≥30
en discovery. Doc : `docs/predictive-wallets-2026-09-28.md`.

### 2. Flow structure — 1 relation survit (DÉCOUVERTE)

**H-PRED-FLOW-01 — frénésie d'activité à t0 ⇒ Y@1h négatif** : sells m5
(colinéaire à buys m5 ρ=0,83 et au volume — un seul phénomène « activité ») :
discovery ρ=−0,282 (p=2,2e-07, survit à Bonferroni), calibration ρ=−0,159
(p=0,030), **holdout ρ=−0,220, p=0,0029, IC95 % [−0,37 ; −0,06], n=182**.
Interprétation : acheter au pic de frénésie à t0, c'est acheter le sommet.
Bémols : effet « activité » pas « sells » spécifique ; monotonie des déciles
non répliquée en calibration ; données chaudes. **Reste DÉCOUVERTE** — re-test
requis sur collecte propre 30 j.

Le reste (accélération buys, inflexion m5/h1, divergences, flux net, taille
moyenne) : écarté ou non verrouillé. H-PRED-FLOW-02 (divergence prix/dominance
@6h, ρ=−0,291) : observation intéressante non calibrée. Leçon : 7 variables
« significatives » en discovery = un seul phénomène. Doc :
`docs/predictive-flows-2026-09-28.md`.

### 3. Liquidity structure — filtre d'exclusion confirmé directionnellement

| ID | Verdict |
|---|---|
| H-PRED-LIQ-01 — turnover élevé à t0 ⇒ Y futurs négatifs | **CONFIRMÉE directionnellement OOS** : holdout 6h sp=−0,410 (n=97) ; décile top médiane **−83,7 %**, 89 % de pertes <−50 % ; stable temporellement et par cohorte. **Filtre d'exclusion, pas edge long** (décile « bon » : médiane +1,5 %) |
| H-PRED-LIQ-02 — profondeur élevée évite les catastrophes | **PARTIELLE** : 6h tient (+0,271, top ~0 % vs bottom −66,8 %) ; **1h infirmée** (+0,008 ≈ 0). Forme « assurance », jamais de prédiction de gain |
| H-PRED-LIQ-03 — mcLiq élevé | **MIXTE** : direction 6h (+0,222) mais amplitude effondrée (+23 % → −0,0 %) ; 1h infirmée |
| H-PRED-LIQ-04 — croissance pré-t0 vs stagnation | **INTESTABLE** (34 tokens avec ≥2 snapshots pré-t0) — à retester après 30 j de collecte |
| H-PRED-LIQ-05 — 4 signaux indépendants | **FALSIFIÉE** : corrélations 0,37–0,79 → **une seule dimension** « profondeur relative à l'activité » |

24h : aucune conclusion (n=28 < 30). Doc : `docs/predictive-liquidity-2026-09-28.md`.

### 4. Distribution — NO DATA, pas NO SIGNAL

`top10Pct` = 100 (« inconnu ») sur 100 % des 35 339 ticks ; `holders` null
partout. Domaine **intestable** en l'état. Trouvaille méthodologique :
contamination temporelle des early buyers (métriques calculées à migration
+~60 min alors que t0 ≈ migration +9–26 min — X mesuré *après* le début de Y).
H-PRED-DIST-01 à 06 pré-enregistrées, en attente de données holders à t0
(Helius). Doc : `docs/predictive-distribution-2026-09-28.md`.

### 5. Temporal structure — 1 promotion prudente

| ID | Verdict |
|---|---|
| H-PRED-TEMP-LEVEL — niveau prix/liq à t0 ⇒ Y@6h | **PROMU avec réserves** : ρ ≈ 0,39→0,31→0,28 sur 3 univers disjoints, IC excluant 0 (n=97) ; **NO SIGNAL @1h** (ρ≈0,01) ; 24h non concluant. Réserves : 9 mesures holdout simultanées (p≈0,006 vs Bonferroni 0,0056 — limite), borne optimiste, biais de survie (couverture 6h conditionnée à la survie) |
| H-PRED-TEMP-AGE | FALSIFIÉE directionnellement puis NO SIGNAL |
| H-PRED-TEMP-GROWTH / ACCEL / ACTIVITY | NON CONCLUANTS (n trop faibles ; 87 % des mints ont t0 au premier snapshot → la « forme » est intestable) |
| H-PRED-TEMP-SESSION | PISTE FRAGILE (t0 vers minuit UTC → Y@1h pire, marge infime) |

Prix et liquidité à t0 = **un seul signal** (Spearman 0,977 entre eux).
Baseline confirmée : Y médian −0,6 % @1h → −20,5 % @24h. Doc :
`docs/predictive-temporal-2026-09-28.md`.

## Synthèse transversale — convergence

Trois résultats indépendants décrivent **le même phénomène** :

- FLOW-01 : frénésie d'activité à t0 → Y@1h négatif (ρ=−0,220 OOS)
- LIQ-01 : turnover élevé à t0 → Y@6h négatif (ρ=−0,410 OOS)
- TEMP-LEVEL : niveau prix/liquidité élevé à t0 → Y@6h moins négatif (ρ≈+0,3 OOS)

Lecture unifiée : **la frénésie à t0 prédit des pertes ; le calme relatif
(profondeur par rapport à l'activité) prédit des pertes moindres.** Côté
distribution, le ratio sells/(buys+sells) à t0 pointe dans le même sens
(ρ=−0,23 @1h, −0,33 @6h — annexe du domaine 4, à tester proprement).

**Aucune variable ne prédit des rendements futurs POSITIFS hors échantillon.**
Les « bons » déciles plafonnent à des médianes ≈ 0 % à +1,5 %. Dans un monde
à drift négatif, ce sont des **filtres d'exclusion** (où ne pas aller), pas
des edges long.

## Verdict Phase 1

**NO EVIDENCE OF PREDICTIVE SIGNAL pour une espérance positive.** Deux
filtres d'exclusion (H-PRED-FLOW-01, H-PRED-LIQ-01) + un signal faible
(H-PRED-TEMP-LEVEL @6h) montrent un pouvoir prédictif OOS **sur les pertes** —
ils restent en phase DÉCOUVERTE et doivent être re-testés sur la collecte
propre de 30 jours avant toute utilisation. La piste prioritaire (early
buyers → survie) est **non testable** aujourd'hui (n=1) : c'est la question
ouverte n°1 du programme.

## Caveats et prochaines étapes

1. **Early buyers** : laisser le backfill monter à n≥30 en discovery avant
   toute lecture ; corriger la contamination temporelle (métriques à la
   migration, pas +60 min) ; fiabiliser les sells (erreurs Helius -32015).
2. **Re-test** des 3 signaux survivants sur `data/track-unbiased/` après 30 j
   (seule validation qui comptera).
3. **Distribution** : collecter les holders à t0 via Helius (chaînon manquant).
4. **Forme temporelle** : exige des séries démarrant avant 20 k$ (collecte
   propre en cours).
5. **Horizons longs** : rien de concluant à 24h (n<30 partout) — la collecte
   continue allongera les séries.
6. Note technique : `spearman` du protocole partagé ne moyenne pas les
   ex-aequo (vecteur quasi-constant → ρ instable) ; le domaine wallets a ajouté
   une garde locale — à intégrer au protocole si le cas se reproduit.

## Fichiers

- Protocole : `lab/predictive/universe.ts` (+ `tests/predictive-universe.test.ts`)
- Domaines : `lab/predictive/{wallets,flows,liquidity,distribution,temporal}/`
- Docs : `docs/predictive-{wallets,flows,liquidity,distribution,temporal}-2026-09-28.md`
- Hypothèses : `docs/hypothesis-pred-{wallets,flows,liquidity,distribution,temporal}-2026-09-28.md`,
  consolidées dans `docs/hypothesis-registry.md` §9.
