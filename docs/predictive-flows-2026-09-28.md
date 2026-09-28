# DOMAINE 2/5 — FLOW STRUCTURE : rapport discovery (2026-09-28)

Phase DÉCOUVERTE uniquement. Aucune stratégie construite. Recherche d'une relation
prédictive stable entre variables de flux à t0 et rendement futur Y.

## 1. Cadre et méthode

- **Protocole partagé** : `lab/predictive/universe.ts` (déjà commité) — importé, non modifié.
  - Univers DISJOINTS par hash FNV du mint : discovery (<50), calibration (50–74),
    holdout gelé (≥75). Le holdout n'a servi qu'à **UNE SEULE mesure**, sur la seule
    variable promue par la calibration. Aucune re-calibration après le holdout.
  - t0 = premier snapshot avec `liquidityUsd ≥ 20 000` et `priceUsd > 0`.
  - Y = `futureReturns` sur [1h, 6h, 24h], prix nettoyés (`aberrantMask`) ; horizon
    non couvert ⇒ Y null (pas d'extrapolation).
- **Variables X** (14) : voir `lab/predictive/flows/features.ts`. Ratios lissés +0.5
  contre les divisions par zéro ; `structChgPre` null quand t0 est le premier snapshot.
- **Méthode par variable × horizon** : Spearman(X,Y) + p-value (approx. t) + IC95 %
  bootstrap (1000 réplicats) ; déciles de X → médiane de Y par décile, écart
  top−bottom avec IC95 % bootstrap ; stabilité temporelle (2 moitiés par date t0) ;
  stabilité par cohorte (pumpswap vs autres dex) ; sensibilité winsorisée p1/p99.
  Résultat principal **AVEC** les outliers valides (post-aberrantMask).
- **Critères de verrouillage** (déclarés AVANT exécution, dans le code) :
  sur 1h : n ≥ 100, |ρ| ≥ 0.15, p < 0.05, signe stable (2 moitiés + 2 cohortes),
  écart décile top−bottom de même signe avec IC95 % excluant 0.
  Calibration : signe préservé, p < 0.10, n ≥ 30 ⇒ promotion holdout.
- **Code** : `lab/predictive/flows/` (`features.ts`, `stats.ts`, `analyze.ts`),
  tests `tests/predictive-flows.test.ts` (14 tests verts).

## 2. Données et limites (à déclarer partout)

- Source : `data/history/` — 2926 mints, 35 339 snapshots. Séries COURTES
  (médiane 3 ticks/mint, moyenne 12.1). **Biais vers les tokens chauds** : toutes les
  mesures sont des bornes OPTIMISTES.
- t0 trouvé pour **1026 mints** (discovery 504 / calibration 268 / holdout 254).
- **Couverture Y par horizon × univers** (n avec Y non null) :

| Univers | 1h | 6h | 24h |
|---|---|---|---|
| discovery | 328 | 178 | 46 |
| calibration | 185 | 106 | 38 |
| holdout | 182 | 97 | 28 |

- Le 24h est sous le seuil n ≥ 30 en calibration/holdout : **aucune conclusion OOS
  possible à 24h**.
- **Limite structurelle** : les tailles de transactions individuelles ne sont PAS
  disponibles dans ces séries (agrégats DexScreener uniquement : comptes
  buys/sells + volumes par fenêtre). Aucune variable de distribution des tailles
  n'a pu être testée — c'est une limite explicite du domaine avec ces données.
- `structChgPre` (changement de structure pré-t0) : null pour ~87 % des mints
  (t0 = premier snapshot) ⇒ n=38 en discovery 1h : **non testable ici**.

## 3. Taux de base (Y)

| Univers | Horizon | n | moyenne | médiane | q05 | q95 | pertes ≤ −50 % |
|---|---|---|---|---|---|---|---|
| discovery | 1h | 328 | +2.9 % | −0.6 % | −99.6 % | +218.3 % | 35 % |
| discovery | 6h | 178 | −8.3 % | −1.8 % | −98.8 % | +92.5 % | 37 % |
| discovery | 24h | 46 | −8.6 % | −20.5 % | −97.0 % | +152.8 % | 39 % |
| holdout | 1h | 182 | +3.9 % | −7.6 % | −99.7 % | +240.5 % | 42 % |

Médiane négative, ~35–42 % de pertes extrêmes : le drift de base est négatif,
cohérent avec les verdicts antérieurs du labo.

## 4. Résultats discovery — Spearman(X, Y) par horizon

ρ = Spearman, IC95 % bootstrap ; « ρ wins. » = sensibilité winsorisée p1/p99 ;
« moitiés » = 2 moitiés temporelles (date t0) ; « dex » = cohorte pumpswap / autres.

### Horizon 1h — discovery

| Variable | n | ρ | p | IC95% | ρ wins. | moitiés (ρ1/ρ2) | dex pump/autre |
|---|---|---|---|---|---|---|---|
| sells m5 | 328 | -0.282 | 2.2e-07 | [-0.39,-0.16] | -0.282 | -0.316/-0.236 | -0.274/-0.004 |
| ratio buys/sells h1 | 328 | +0.230 | 2.5e-05 | [+0.14,+0.33] | +0.231 | +0.279/+0.179 | +0.247/-0.027 |
| dominance acheteuse m5 | 327 | +0.213 | 1.0e-04 | [+0.12,+0.31] | +0.213 | +0.249/+0.176 | +0.229/-0.069 |
| ratio buys/sells m5 | 328 | +0.206 | 1.7e-04 | [+0.10,+0.31] | +0.206 | +0.235/+0.176 | +0.230/-0.063 |
| volume m5 USD | 328 | -0.201 | 2.4e-04 | [-0.31,-0.09] | -0.202 | -0.327/-0.083 | -0.174/-0.035 |
| priceChange m5 (contrôle) | 328 | -0.198 | 3.0e-04 | [-0.30,-0.09] | -0.198 | -0.197/-0.199 | -0.213/-0.135 |
| buys m5 | 328 | -0.197 | 3.2e-04 | [-0.31,-0.07] | -0.197 | -0.214/-0.167 | -0.207/-0.070 |
| changement structure pré-t0 | 38 | -0.181 | 2.8e-01 | [-0.45,+0.11] | -0.181 | -0.049/-0.307 | -0.224/-0.314 |
| divergence prix / dominance | 327 | -0.138 | 1.3e-02 | [-0.25,-0.03] | -0.138 | -0.139/-0.129 | -0.136/-0.110 |
| taille moyenne implicite / trade m5 | 327 | -0.092 | 9.7e-02 | [-0.22,+0.02] | -0.092 | -0.220/+0.011 | -0.090/-0.002 |
| divergence prix / accélération | 328 | +0.068 | 2.2e-01 | [-0.05,+0.17] | +0.068 | +0.063/+0.057 | +0.080/-0.091 |
| inflexion structure m5 vs h1 | 328 | +0.056 | 3.2e-01 | [-0.05,+0.16] | +0.055 | +0.063/+0.039 | +0.068/+0.000 |
| accélération buys (m5 vs h1) | 328 | -0.047 | 3.9e-01 | [-0.16,+0.05] | -0.047 | -0.086/-0.036 | -0.052/-0.092 |
| flux net m5 (buys−sells) | 328 | +0.011 | 8.4e-01 | [-0.11,+0.12] | +0.011 | -0.025/+0.053 | +0.013/+0.053 |

### Horizon 6h — discovery

| Variable | n | ρ | p | IC95% | ρ wins. | moitiés (ρ1/ρ2) | dex pump/autre |
|---|---|---|---|---|---|---|---|
| sells m5 | 178 | -0.529 | 3.4e-14 | [-0.65,-0.39] | -0.529 | -0.382/-0.638 | -0.549/-0.085 |
| buys m5 | 178 | -0.398 | 3.9e-08 | [-0.53,-0.25] | -0.398 | -0.194/-0.556 | -0.479/-0.059 |
| volume m5 USD | 178 | -0.377 | 2.2e-07 | [-0.51,-0.23] | -0.377 | -0.384/-0.344 | -0.358/-0.074 |
| ratio buys/sells h1 | 178 | +0.327 | 8.4e-06 | [+0.17,+0.48] | +0.327 | +0.311/+0.354 | +0.402/-0.064 |
| dominance acheteuse m5 | 177 | +0.321 | 1.3e-05 | [+0.16,+0.46] | +0.321 | +0.286/+0.372 | +0.389/-0.048 |
| ratio buys/sells m5 | 178 | +0.310 | 2.5e-05 | [+0.17,+0.46] | +0.310 | +0.272/+0.371 | +0.387/-0.037 |
| divergence prix / dominance | 177 | -0.291 | 8.5e-05 | [-0.43,-0.13] | -0.291 | -0.314/-0.249 | -0.302/-0.273 |
| priceChange m5 (contrôle) | 178 | -0.251 | 7.4e-04 | [-0.40,-0.09] | -0.251 | -0.141/-0.288 | -0.275/-0.078 |
| inflexion structure m5 vs h1 | 178 | +0.132 | 7.9e-02 | [-0.00,+0.25] | +0.132 | +0.081/+0.191 | +0.201/-0.022 |
| taille moyenne implicite / trade m5 | 177 | -0.123 | 1.0e-01 | [-0.29,+0.04] | -0.123 | -0.292/-0.023 | -0.144/-0.011 |
| flux net m5 (buys−sells) | 178 | -0.108 | 1.5e-01 | [-0.27,+0.06] | -0.108 | -0.018/-0.120 | -0.134/-0.102 |
| accélération buys (m5 vs h1) | 178 | -0.098 | 1.9e-01 | [-0.24,+0.03] | -0.098 | -0.038/-0.106 | -0.085/-0.062 |
| changement structure pré-t0 | 27 | +0.095 | 6.4e-01 | [-0.31,+0.45] | +0.095 | +0.181/+0.073 | +0.064/+0.400 |
| divergence prix / accélération | 178 | +0.075 | 3.2e-01 | [-0.07,+0.22] | +0.075 | -0.078/+0.130 | +0.057/+0.053 |

### Horizon 24h — discovery (n=46 : indicatif uniquement)

| Variable | n | ρ | p | IC95% | ρ wins. | moitiés (ρ1/ρ2) | dex pump/autre |
|---|---|---|---|---|---|---|---|
| priceChange m5 (contrôle) | 46 | -0.415 | 4.1e-03 | [-0.59,-0.14] | -0.415 | -0.283/-0.460 | -0.369/-0.326 |
| volume m5 USD | 46 | -0.405 | 5.2e-03 | [-0.68,-0.06] | -0.405 | -0.144/-0.634 | -0.360/-0.081 |
| sells m5 | 46 | -0.383 | 8.5e-03 | [-0.66,-0.06] | -0.383 | -0.101/-0.709 | -0.402/+0.213 |
| buys m5 | 46 | -0.356 | 1.5e-02 | [-0.62,-0.05] | -0.356 | -0.134/-0.681 | -0.371/-0.044 |
| accélération buys (m5 vs h1) | 46 | -0.347 | 1.8e-02 | [-0.57,-0.06] | -0.347 | -0.392/-0.453 | -0.265/-0.458 |
| flux net m5 (buys−sells) | 46 | -0.325 | 2.8e-02 | [-0.62,+0.01] | -0.325 | -0.203/-0.488 | -0.171/-0.593 |
| changement structure pré-t0 | 5 | +0.300 | 6.2e-01 | n/a | +0.300 | n/a/+1.000 | +0.300/n/a |
| taille moyenne implicite / trade m5 | 46 | -0.276 | 6.3e-02 | [-0.56,+0.03] | -0.276 | -0.200/-0.355 | -0.403/-0.150 |
| divergence prix / accélération | 46 | +0.258 | 8.3e-02 | [-0.03,+0.52] | +0.258 | -0.142/+0.463 | +0.267/-0.164 |
| ratio buys/sells h1 | 46 | +0.141 | 3.5e-01 | [-0.21,+0.45] | +0.141 | +0.136/+0.262 | +0.403/+0.012 |
| inflexion structure m5 vs h1 | 46 | -0.133 | 3.8e-01 | [-0.44,+0.20] | -0.133 | -0.212/-0.163 | +0.069/-0.485 |
| divergence prix / dominance | 46 | -0.069 | 6.5e-01 | [-0.37,+0.25] | -0.069 | -0.158/+0.016 | -0.074/+0.005 |
| dominance acheteuse m5 | 46 | -0.038 | 8.0e-01 | [-0.40,+0.31] | -0.038 | -0.198/+0.010 | +0.223/-0.603 |
| ratio buys/sells m5 | 46 | -0.033 | 8.3e-01 | [-0.40,+0.32] | -0.033 | -0.177/+0.010 | +0.232/-0.600 |

À 24h les moitiés temporelles divergent fortement (ex. sells m5 : −0.101 vs −0.709)
et les cohortes dex aussi : **aucune variable n'est stable à 24h, verdict nul**.

## 5. Verrouillage → calibration → holdout

Sur 14 variables × 3 horizons (42 tests discovery), **une seule** a satisfait les
critères de verrouillage sur 1h : **sells m5**.

| Étape | n | ρ (sells m5 → Y 1h) | p | IC95 % |
|---|---|---|---|---|
| discovery | 328 | −0.282 | 2.2e-07 | [−0.39, −0.16] |
| calibration | 185 | −0.159 | 3.0e-02 | [−0.30, −0.00] |
| **holdout (mesure unique)** | 182 | **−0.220** | **2.9e-03** | **[−0.37, −0.06]** |

- Tests multiples : 42 tests discovery ⇒ seuil Bonferroni 0.0012 ; sells m5
  (p = 2.2e-07) y survit.
- Winsorisation p1/p99 : ρ identique (−0.282) ⇒ pas tiré par des outliers de Y.
- Cohortes : discovery dex pump/autre = −0.274 / −0.004 (cohorte « autres »
  quasi-nulle — effet possiblement concentré sur pumpswap) ; calibration
  −0.147 / −0.107 (cohérent) ; moitiés temporelles stables aux deux étapes.
- Déciles de sells m5 → médiane Y 1h (discovery) :
  D0 +8.1 %, D1 +2.4 %, D2 +4.1 %, D3 +0.5 %, D4 +0.2 %, D5 −55.6 %,
  D6 −23.9 %, D7 −61.5 %, D8 −81.2 %, D9 −87.9 %.
  Écart top−bottom : −96.0 pts, IC95 % [−107.1, −61.2].
- **Bémol honnête** : en calibration, la monotonie des déciles casse au dernier
  décile (D9 : médiane +2.7 %, écart top−bottom +0.6 pt, IC [−40.4, +40.0]) —
  la relation est monotone en rang, pas en déciles. Le holdout confirme le rang
  (ρ = −0.220), pas la forme exacte.
- Contexte 6h (pas de mesure holdout, protocole 1h) : discovery ρ = −0.529
  (p = 3.4e-14), calibration ρ = −0.240 (p = 0.013, IC [−0.42, −0.04]) — même sens.
  24h : calibration ρ = −0.116 (p = 0.49, n = 38) — non concluant.

Les autres candidats discovery (ratio h1 +0.230, dominance +0.213, ratio m5
+0.206, volume m5 −0.201, priceChgM5 −0.198, buys m5 −0.197) ont **tous échoué**
au verrouillage : signe instable entre cohortes dex en discovery (la cohorte
« autres dex », petite, annule l'effet) et/ou écart décile non concluant, puis
calibration affaiblie (ρ ≈ ±0.08–0.16). Verdict : **non verrouillés**.

## 6. Colinéarité : un seul phénomène, pas sept signaux

Spearman inter-features (discovery, paires complètes) — extraits :

| paire | ρ |
|---|---|
| sells m5 ↔ buys m5 | **+0.83** |
| ratio m5 ↔ dominance m5 | **+1.00** (redondantes par construction) |
| sells m5 ↔ volume m5 | +0.52 |
| buys m5 ↔ volume m5 | +0.50 |
| priceChgM5 ↔ accelBuys | +0.46 |

`sells m5` et `buys m5` mesurent à 83 % la même chose : **l'activité à t0**.
Le tableau discovery ne montre donc pas 7 signaux indépendants mais **un seul
phénomène** : la frénésie d'activité à t0 (comptes élevés, volume élevé, pump
m5 élevé) prédit des rendements 1h **négatifs** — acheter le sommet de la
frénésie perd ; tandis que la structure *relative* (ratio/dominance acheteuse)
prédit positivement. Rappel du principe d'Hervé : cinq stratégies qui perdent
pour la même raison = une seule stratégie déguisée en cinq — ici, sept
variables qui prédisent pour la même raison = un seul phénomène.

## 7. Verdicts par variable (phase DÉCOUVERTE)

| Variable | Verdict |
|---|---|
| sells m5 → Y 1h | **Candidat unique** : discovery → calibration → holdout positif (ρ=−0.220, p=0.0029). Reste une hypothèse de phase DÉCOUVERTE (H-PRED-FLOW-01), pas un signal validé. Bémols : colinéaire à buys_m5/vol_m5 (activité, pas « sells » spécifique) ; cohorte non-pumpswap faible en discovery ; monotonie des déciles non répliquée en calibration. |
| buys m5, volume m5, priceChgM5 (contrôle) | Signaux discovery (ρ ≈ −0.20, stables en moitiés) mais **non verrouillés** (cohortes dex / déciles). priceChgM5 = réversion du pump m5 — piste, pas preuve. |
| ratio m5, dominance m5, ratio h1 | Discovery positifs (ρ ≈ +0.21–0.23) mais signe instable hors pumpswap ⇒ **non verrouillés**. |
| divergence prix / dominance | Discovery 1h ρ=−0.138 (sous le seuil) ; 6h ρ=−0.291 avec cohortes cohérentes (−0.302/−0.273) — **observation discovery, non calibrée** (H-PRED-FLOW-02). |
| divergence prix / accélération | Nul partout (ρ ≈ +0.07, p > 0.2). |
| accélération buys, inflexion m5 vs h1 | Nuls (p > 0.19). L'accélération du rythme des buys à t0 ne prédit rien. |
| flux net m5 (buys−sells) | Nul à 1h (ρ=+0.011) — le niveau absolu compte, pas la différence brute. |
| taille moyenne implicite / trade | Nul (p ≈ 0.10, signe instable). Proxy trop bruité sans tailles individuelles. |
| changement structure pré-t0 | **Non testable** (n=38, 87 % des mints sans pré-t0). |

## 8. Verdict global

**Une seule relation survit au protocole complet** : l'activité de vente (colinéaire
à l'activité totale) dans les 5 minutes à t0 prédit négativement le rendement à
1h, avec une mesure holdout unique positive (ρ = −0.220, p = 0.0029, n = 182).
Tout le reste est nul ou non verrouillé. Vu les bémols (colinéarité,
concentration pumpswap possible, déciles non monotones en calibration, données
biaisées vers les tokens chauds = borne optimiste), ceci reste une **hypothèse
de phase DÉCOUVERTE**, pas un signal validé : elle devra être re-testée sur la
collecte propre de 30 jours (`data/track-unbiased/`) avant toute calibration de
seuil ou usage.

## 9. Reproductibilité

- `lab/predictive/flows/features.ts` — extraction des 14 variables à t0.
- `lab/predictive/flows/stats.ts` — p-value Spearman, IC bootstrap (Spearman,
  médiane, écart de médianes), résumés, winsorisation.
- `lab/predictive/flows/analyze.ts` — pipeline complet :
  `npx tsx lab/predictive/flows/analyze.ts` → `/tmp/flows-results.json`.
- `tests/predictive-flows.test.ts` — 14 tests verts.
- Aucune modification hors des chemins autorisés ; aucun commit ; aucun push ;
  `data/track-unbiased/` jamais touché.
