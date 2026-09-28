# DOMAINE 3/5 — LIQUIDITY STRUCTURE : rapport de découverte (2026-09-28)

**Phase : DÉCOUVERTE uniquement.** Aucune stratégie construite, aucune transaction,
aucun push. Protocole partagé : `lab/predictive/universe.ts`.

## 1. Protocole

- **t0** = premier snapshot avec `liquidityUsd ≥ 20 000` et `priceUsd > 0`.
- **Y** = rendement futur depuis t0 sur 1h / 6h / 24h (prix nettoyés des ticks
  aberrants via `aberrantMask` ; horizon non couvert → `null`, pas d'extrapolation).
- **Univers disjoints** par hash FNV du mint : discovery (<50), calibration (50–74),
  holdout gelé (≥75). Verrouillage des variables APRÈS discovery, AVANT toute vue
  de calibration/holdout (`lab/predictive/liquidity/lock-vars.json`).
- **Règle n≥30** pour toute conclusion. Résultat principal **avec** les outliers
  valides ; médiane du top décile aussi rapportée sans outliers (|Y|>10).
- **Biais des données** : `data/history/` (2926 mints, ~35k ticks, ~12 ticks/mint)
  est biaisée vers les tokens chauds → **toutes les mesures sont des bornes
  OPTIMISTES**, déclarées comme telles. `data/track-unbiased/` (holdout) n'a
  JAMAIS été touché (ni lu, ni fitté).

## 2. Couverture (métrique obligatoire)

| Univers | tokens avec t0 | Y 1h | Y 6h | Y 24h |
|---|---|---|---|---|
| discovery | 505 | 328 | 178 | 46 |
| calibration | 287 | 185 | 106 | 38 |
| holdout | 234 | 182 | 97 | 28 |

- 1026/2926 mints ont un t0 (35 %). Les autres n'atteignent jamais 20 k$ de liquidité.
- **24h : n < 50 partout, 28 au holdout** → aucune conclusion possible (rapporté
  comme exploratoire uniquement, exclu du verrouillage).
- **Fenêtre pré-t0 quasi inexistante** : médiane 0 snapshot pré-t0 ; seuls
  34 tokens (tous univers) ont ≥2 snapshots pré-t0, 22 ont une pente calculable.
  → les variables d'évolution pré-t0 sont **intestables** avec ces données.

## 3. Discovery — Spearman(X, Y) par horizon

| Variable | 1h (n) | 6h (n) | 24h (n) | Verrouillée ? |
|---|---|---|---|---|
| liqT0 (profondeur) | +0.188 (328) | +0.408 (178) | +0.378 (46) | oui |
| turnoverM5 (vol m5 / liq) | −0.252 (328) | −0.487 (178) | −0.476 (46) | oui |
| turnoverH1 (vol h1 / liq) | −0.219 (328) | −0.393 (178) | −0.428 (46) | oui |
| liqPerVolH1 (= 1/turnoverH1) | +0.219 (328) | +0.393 (178) | +0.428 (46) | non (redondant) |
| mcLiq (mcap / liq) | +0.183 (327) | +0.396 (177) | +0.162 (45) | oui |
| preGrowthRel | −0.371 (12) | — | — | non (n≪30) |
| liqCVPre | −0.217 (12) | — | — | non (n≪30) |
| addsPre | −0.084 (12) | — | — | non (n≪30) |
| removesPre | +0.301 (12) | — | — | non (n≪30) |
| liqSlopePre | — (n<10) | — | — | non (n≪30) |

Règle de verrouillage : |sp| ≥ 0.18 sur 1h **et** 6h, même signe, stabilité
temporelle (même signe sur les deux moitiés de la fenêtre t0).

## 4. Variables verrouillées — déciles top vs bottom (médianes de Y)

### 4a. turnoverM5 — le signal le plus fort et le plus stable

| Phase | Horizon | n | sp | top décile (turnover élevé) médiane Y | bottom décile médiane Y |
|---|---|---|---|---|---|
| discovery | 1h | 328 | −0.252 | −83.4 % (69 % pertes <−50 %) | +3.4 % (9 %) |
| discovery | 6h | 178 | −0.487 | −89.5 % (82 %) | +13.2 % (0 %) |
| calibration | 1h | 185 | −0.243 | −77.1 % (56 %) | +1.8 % (0 %) |
| calibration | 6h | 106 | −0.276 | −82.6 % (60 %) | +4.6 % (18 %) |
| **holdout** | 1h | 182 | **−0.136** | −86.0 % (78 %) | +1.3 % (16 %) |
| **holdout** | 6h | 97 | **−0.410** | −83.7 % (89 %) | +1.5 % (10 %) |

Distribution holdout 6h : top décile min −98 %, max −32 % (tout le décile perd) ;
bottom décile min −96 %, max +84 %. Sans outliers (|Y|≤10) : médiane top −83.7 %
inchangée. Stabilité temporelle holdout : signe identique sur les deux moitiés.
Cohortes holdout 6h : pumpswap −0.32, raydium −0.56, meteora −0.60 (même signe).

### 4b. turnoverH1

| Phase | Horizon | n | sp | top médiane Y | bottom médiane Y |
|---|---|---|---|---|---|
| discovery | 6h | 178 | −0.393 | −76.6 % (65 %) | +0.1 % (0 %) |
| calibration | 6h | 106 | −0.332 | −61.2 % (60 %) | +0.0 % (9 %) |
| **holdout** | 6h | 97 | **−0.371** | −70.0 % (67 %) | +0.6 % (10 %) |
| **holdout** | 1h | 182 | **−0.110** | −57.5 % (56 %) | +0.9 % (0 %) |

6h confirmé OOS ; 1h affaibli (sp −0.11, stabilité temporelle non concordante).

### 4c. mcLiq (marketCap / liquidité)

| Phase | Horizon | n | sp | top médiane Y | bottom médiane Y |
|---|---|---|---|---|---|
| discovery | 6h | 177 | +0.396 | +22.9 % (6 % pertes <−50 %) | −2.2 % (22 %) |
| calibration | 6h | 106 | +0.280 | +24.1 % (0 %) | −26.4 % (45 %) |
| **holdout** | 6h | 97 | **+0.222** | −0.0 % (22 %) | −28.2 % (50 %) |
| **holdout** | 1h | 182 | **−0.004** | +1.1 % | −24.3 % |

**Signal 1h mort au holdout (sp ≈ 0) → le +0.18 de discovery à 1h était du bruit.**
À 6h la direction tient mais l'amplitude s'effondre (top décile médiane +23 %
→ −0.0 %). Verdict : directionnel à 6h, ampleur non fiable.

### 4d. liqT0 (profondeur absolue)

| Phase | Horizon | n | sp | top médiane Y | bottom médiane Y |
|---|---|---|---|---|---|
| discovery | 6h | 178 | +0.408 | −0.1 % (0 % pertes <−50 %) | −35.2 % (44 %) |
| calibration | 6h | 106 | +0.278 | +1.5 % (0 %) | −73.4 % (73 %) |
| **holdout** | 6h | 97 | **+0.271** | −0.0 % (22 %) | −66.8 % (70 %) |
| **holdout** | 1h | 182 | **+0.008** | +0.5 % | −43.2 % |

Même lecture que mcLiq : **1h mort au holdout**, 6h directionnel. Le décile top
liquidité n'est jamais positif en médiane (~0 %) : la profondeur **évite les
catastrophes** (0–22 % de pertes extrêmes vs 44–73 % en bas de décile), elle ne
prédit pas des gagnants.

## 5. Redondance : 4 variables, UNE dimension

Corrélations de Spearman entre variables verrouillées (holdout, n=97) :

| | turnoverM5 | turnoverH1 | mcLiq |
|---|---|---|---|
| liqT0 | −0.470 | −0.504 | +0.750 |
| turnoverM5 | — | +0.791 | −0.391 |
| turnoverH1 | — | — | −0.374 |

Ce n'est pas 4 signaux indépendants : c'est la dimension unique
**« profondeur relative à l'activité »**. turnoverM5 porte le signal le plus
fort et le plus stable ; les autres n'ajoutent pas d'information démontrée.

## 6. La question croissance-vs-stagnation : SANS RÉPONSE

« Une liquidité qui CROÎT vite avant t0 vs une liquidité haute mais STAGNANTE —
laquelle prédit Y ? » — **impossible à trancher** : seuls 34 tokens (tous
univers confondus) ont ≥2 snapshots pré-t0, 12 en discovery à 1h. Les valeurs
observées (preGrowthRel sp=−0.371, n=12) sont du bruit d'échantillon. À retester
sur `data/track-unbiased/` après 30 jours de collecte propre (holdout gelé,
jamais utilisé ici).

## 7. Verdicts (phase DÉCOUVERTE, bornes optimistes)

1. **turnover élevé à t0 → rendements futurs négatifs** : CONFIRMÉ hors
   échantillon (sp holdout −0.41 à 6h, −0.14 à 1h ; décile top : médiane −84 %
   à 6h, 89 % de pertes <−50 %, stable temporellement et par cohorte).
   **C'est un filtre d'exclusion, pas un edge long** : le décile bottom a une
   médiane de +1.5 %, pas une espérance positive.
2. **Profondeur absolue élevée → évite les catastrophes** : PARTIEL (6h tient,
   1h morte au holdout). Forme « assurance », pas « prédiction de gain ».
3. **mcLiq élevé → meilleurs rendements** : MIXTE (direction 6h confirmée mais
   amplitude divisée par ~∞ ; 1h infirmée). À retester sur données propres.
4. **Croissance pré-t0 vs stagnation** : INTESTABLE (données insuffisantes).
5. **24h** : aucune conclusion (n=28 au holdout < 30).

## 8. Reproductibilité

- Code : `lab/predictive/liquidity/` — `features.ts` (X, Y), `analysis.ts`
  (Spearman, déciles, IC95 % bootstrap, stabilités), `run.ts` (CLI),
  `lock-vars.json` (verrouillage).
- `npx tsx lab/predictive/liquidity/run.ts --phase discovery|calibration|holdout
  [--lock lab/predictive/liquidity/lock-vars.json]` — déterministe
  (vérifié : deux runs calibration identiques).
- Tests : `tests/predictive-liquidity.test.ts` — 10 tests verts.
- Fichiers NON touchés : Risk Engine, exécuteur, seuils paper, docs cycle-*,
  `data/track-unbiased/`. Aucun commit, aucun push.
