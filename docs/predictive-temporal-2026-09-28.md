# TEMPORAL STRUCTURE — résultats phase DÉCOUVERTE (2026-09-28)

**Domaine 5/5 du programme prédictif.** Protocole : `docs/hypothesis-pred-temporal-2026-09-28.md` (pré-enregistré OUI, rédigé avant exécution) + `lab/predictive/universe.ts`. Code : `lab/predictive/temporal/` · résultats bruts : `lab/predictive/temporal/results-2026-09-28.json` · tests : `tests/predictive-temporal.test.ts` (18 verts).

**Biais (à lire avant tout chiffre) :** `data/history/` est biaisée vers les tokens chauds (late-discovery) → **toute mesure = borne OPTIMISTE**. Séries courtes (~12 ticks/mint), cadence irrégulière (travail en temps réel ms). **87 % des mints (896/1 026) ont t0 au premier snapshot** → les variables pré-t0 (croissance, accélération, activité) sont structurellement sous-alimentées : leurs n sont < 30, donc NON CONCLUANT (pas « no signal »).

## 1. Données et couverture

| | mints | Y@1h | Y@6h | Y@24h |
|---|---|---|---|---|
| discovery (<50) | 504 | 328 (65,1 %) | 178 (35,3 %) | 46 (9,1 %) |
| calibration (50–74) | 268 | 185 (69,0 %) | 106 (39,6 %) | 38 (14,2 %) |
| holdout (≥75) | 254 | 182 (71,7 %) | 97 (38,2 %) | 28 (11,0 %) |

1 900 mints sans t0 (jamais ≥ 20 k$ de liquidité observée). Y = rendement simple depuis t0, prix nettoyés des ticks aberrants ; null si horizon non couvert (pas d'extrapolation).

**Baseline Y (discovery) :** médiane −0,6 % @1h, −1,8 % @6h, −20,5 % @24h ; P(perte) 52→67 % ; P(Y ≤ −50 %) 35→50 %. Le drift négatif déjà documenté se confirme — le niveau de Y est une borne optimiste.

**Redondances constatées (pas supposées) :** Spearman(priceAtT0, liqAtT0) = **0,977** → un seul signal « niveau ». Spearman(agePairMs, ageTokenMs) = **1,000** → une seule variable « âge » (pairCreatedAt ≈ createdAt dans ces données).

## 2. Discovery — 10 variables × 3 horizons

ρ = Spearman(X, Y) ; IC95 bootstrap ; « ss-out » = sans outliers valides (Y hors P1–P99) ; déciles : médiane Y décile top vs bottom de X ; stab T/C = signe de ρ sur 2 moitiés temporelles / 2 cohortes (hash pair/impair). Résultat principal AVEC outliers valides.

| variable (famille) | hor | n | ρ | IC95 ρ | ρ ss-out | déc top méd | déc bot méd | stab T | stab C |
|---|---|---|---|---|---|---|---|---|---|
| priceAtT0 (NIVEAU) | 1h | 328 | 0,182 | [0,087 ; 0,271] | 0,208 | 0,6 % | −27,6 % | +/+ | +/+ |
| priceAtT0 (NIVEAU) | 6h | 178 | 0,388 | [0,264 ; 0,497] | 0,406 | −0,2 % | −35,2 % | +/+ | +/+ |
| priceAtT0 (NIVEAU) | 24h | 46 | 0,369 | [0,103 ; 0,572] | 0,369 | 0,2 % | −24,5 % | +/+ | +/+ |
| liqAtT0 (NIVEAU) | 1h | 328 | 0,188 | [0,094 ; 0,279] | 0,215 | 0,9 % | −22,8 % | +/+ | +/+ |
| liqAtT0 (NIVEAU) | 6h | 178 | 0,408 | [0,293 ; 0,520] | 0,427 | −0,1 % | −35,2 % | +/+ | +/+ |
| liqAtT0 (NIVEAU) | 24h | 46 | 0,378 | [0,157 ; 0,553] | 0,378 | −1,0 % | −69,8 % | +/+ | +/+ |
| growthPreT0 (NIVEAU) | 1h | 38 | −0,198 | [−0,544 ; 0,193] | −0,198 | −73,9 % | 15,2 % | −/− | −/− |
| growthPreT0 (NIVEAU) | 6h | 27 | −0,445 | [−0,699 ; −0,088] | −0,445 | — | — | −/− | −/− |
| growthPreT0 (NIVEAU) | 24h | 5 | −0,300 | — | −0,300 | — | — | ·/· | ·/· |
| âge (FORME) | 1h | 328 | 0,088 | [−0,012 ; 0,187] | 0,073 | −0,0 % | −10,0 % | +/+ | +/+ |
| âge (FORME) | 6h | 178 | 0,129 | [−0,007 ; 0,263] | 0,115 | −0,3 % | −21,4 % | +/+ | +/+ |
| âge (FORME) | 24h | 46 | 0,406 | [0,162 ; 0,590] | 0,406 | 0,2 % | −69,8 % | +/+ | +/+ |
| accelPerH2 (FORME) | 1h | 16 | −0,318 | [−0,715 ; 0,218] | −0,318 | — | — | ·/· | ·/· |
| accelPerH2 (FORME) | 6h | 12 | −0,133 | [−0,657 ; 0,538] | −0,133 | — | — | ·/· | ·/· |
| accelSign (FORME) | 1h | 16 | −0,129 | [−0,571 ; 0,388] | −0,129 | — | — | ·/· | ·/· |
| interSnapMean (FORME) | 1h | 21 | −0,044 | [−0,474 ; 0,434] | −0,044 | — | — | −/− | −/+ |
| interSnapMean (FORME) | 6h | 16 | 0,035 | [−0,544 ; 0,576] | 0,035 | — | — | ·/· | ·/· |
| hourSin (FORME) | 1h | 328 | −0,045 | [−0,154 ; 0,070] | −0,039 | 3,6 % | 0,0 % | −/+ | −/− |
| hourSin (FORME) | 6h | 178 | 0,000 | [−0,150 ; 0,143] | −0,000 | 8,9 % | −14,2 % | +/− | −/+ |
| hourCos (FORME) | 1h | 328 | −0,170 | [−0,269 ; −0,068] | −0,173 | −50,6 % | −0,1 % | −/− | −/− |
| hourCos (FORME) | 6h | 178 | −0,088 | [−0,242 ; 0,077] | −0,091 | −36,0 % | −1,4 % | −/− | −/− |
| hourCos (FORME) | 24h | 46 | −0,063 | [−0,354 ; 0,225] | −0,063 | −63,0 % | −2,0 % | −/− | −/+ |

**Candidats discovery → calibration (critères gelés) :** priceAtT0@{1h,6h,24h}, liqAtT0@{1h,6h,24h}, âge@24h (×2 redondant), hourCos@1h — 9 au total.

Note : H-PRED-TEMP-AGE prédisait ρ < 0 (jeunesse) ; discovery montre ρ = **+0,406** stable → direction prédite **falsifiée** ; le motif inverse (vieux → mieux @24h) est retenu comme candidat mécanique.

## 3. Calibration — re-mesure des 9 candidats (univers disjoint)

| variable | hor | n | ρ | IC95 ρ | déc top méd | déc bot méd | Δmoy [IC] | stab T | stab C | → holdout |
|---|---|---|---|---|---|---|---|---|---|---|
| priceAtT0 | 1h | 185 | 0,218 | [0,098 ; 0,339] | 0,7 % | −26,4 % | 0,116 [−0,289 ; 0,482] | +/+ | +/+ | oui |
| priceAtT0 | 6h | 106 | 0,305 | [0,127 ; 0,483] | 1,6 % | −73,4 % | 0,484 [0,060 ; 0,831] | +/+ | +/+ | oui |
| priceAtT0 | 24h | 38 | 0,555 | [0,217 ; 0,784] | 0,5 % | −57,7 % | — | +/+ | +/+ | oui |
| liqAtT0 | 1h | 185 | 0,206 | [0,081 ; 0,325] | 1,6 % | −20,6 % | 0,075 [−0,352 ; 0,429] | +/+ | +/+ | oui |
| liqAtT0 | 6h | 106 | 0,278 | [0,090 ; 0,446] | 1,5 % | −73,4 % | 0,507 [0,053 ; 0,840] | +/+ | +/+ | oui |
| liqAtT0 | 24h | 38 | 0,443 | [0,120 ; 0,702] | 2,3 % | −8,3 % | — | +/+ | +/+ | oui |
| âge | 24h | 38 | 0,082 | [−0,281 ; 0,438] | −6,6 % | 57,9 % | — | +/− | +/+ | oui (mécanique) |
| hourCos | 1h | 185 | −0,207 | [−0,343 ; −0,071] | −94,4 % | 0,0 % | −0,543 [−0,808 ; −0,238] | −/− | −/− | oui |

Les 9 passent le filtre calibration (même signe, |ρ| ≥ 0,07, n ≥ 30). L'âge@24h s'effondre déjà (0,406 → 0,082, IC incluant 0, déciles inversés).

## 4. Holdout — UNE SEULE mesure par survivant (univers jamais touché)

| variable | hor | n | ρ | IC95 ρ | ρ ss-out | déc top méd | déc bot méd | stab T | stab C | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| priceAtT0 | 1h | 182 | 0,009 | [−0,130 ; 0,138] | 0,034 | 0,2 % | −42,7 % | +/− | −/+ | **NO SIGNAL** |
| priceAtT0 | 6h | 97 | 0,278 | [0,068 ; 0,460] | 0,278 | 0,3 % | −66,8 % | +/+ | +/+ | **PROMU** (critères gelés) |
| priceAtT0 | 24h | 28 | 0,618 | [0,388 ; 0,767] | 0,618 | — | — | +/+ | +/+ | **NON CONCLUANT** (n < 30) |
| liqAtT0 | 1h | 182 | 0,008 | [−0,130 ; 0,144] | 0,032 | 0,5 % | −43,2 % | +/− | −/+ | **NO SIGNAL** |
| liqAtT0 | 6h | 97 | 0,271 | [0,070 ; 0,457] | 0,271 | −0,0 % | −66,8 % | +/+ | +/+ | **PROMU** (critères gelés) |
| liqAtT0 | 24h | 28 | 0,658 | [0,413 ; 0,812] | 0,658 | — | — | +/+ | +/+ | **NON CONCLUANT** (n < 30) |
| âge | 24h | 28 | 0,103 | [−0,332 ; 0,595] | 0,103 | — | — | +/+ | +/− | **NO SIGNAL** (n < 30 de toute façon) |
| hourCos | 1h | 182 | −0,138 | [−0,279 ; **−0,004**] | −0,148 | −24,7 % | 0,0 % | −/− | −/− | **PISTE FRAGILE** |

## 5. Verdicts par hypothèse

| ID | Verdict | Justification |
|---|---|---|
| H-PRED-TEMP-LEVEL | **PROMU @6h** (avec réserves) · NO SIGNAL @1h · NON CONCLUANT @24h | prix/liq à t0 = un seul signal (ρ=0,977). @6h : ρ≈0,39→0,31→0,28 sur 3 univers disjoints, CIs excluent 0, déciles cohérents (top ≈ 0 %, bottom ≈ −67/−73 %), robuste sans outliers. @1h : ρ≈0,01 sur holdout → falsifié à cet horizon. @24h : n=28 < 30. **Réserves :** 9 mesures holdout simultanées (p≈0,006 vs Bonferroni 0,0056 — limite) ; borne optimiste (biais hot tokens) ; couverture @6h conditionnée à la survie ≥6h (biais de survie) ; effet nul à 1h — à confirmer sur les 30 j de collecte propre (data/track-unbiased) avant tout usage. |
| H-PRED-TEMP-AGE | **FALSIFIÉE** (direction) puis **NO SIGNAL** | Prédiction ρ<0 (jeunesse) ; discovery@24h : ρ=+0,406 stable → direction falsifiée. Le motif inverse ne survit pas : calibration 0,082, holdout 0,103 (IC [−0,33 ; 0,60]). Rien ne prédit via l'âge. |
| H-PRED-TEMP-GROWTH | **NON CONCLUANT** | n=38/27/5. @6h : ρ=−0,445 IC[−0,699 ; −0,088] mais n=27 < 30 → piste (croissance forte pré-t0 → moins bon Y ?), pas une conclusion. Structurellement sous-alimenté (t0 au 1er snapshot dans 87 % des cas). |
| H-PRED-TEMP-ACCEL | **NON CONCLUANT** | n=16/12/3. La question « niveau vs forme » ne peut pas être tranchée avec ces séries : l'accélération n'est mesurable que sur 130 mints. |
| H-PRED-TEMP-ACTIVITY | **NON CONCLUANT** | n=21/16/4. Même cause. |
| H-PRED-TEMP-SESSION | **PISTE FRAGILE** (hourCos@1h) · rien (hourSin) | hourCos@1h passe les critères gelés de justesse (IC [−0,279 ; −0,004]) : t0 proche de minuit UTC (cos≈1) → Y@1h médian −24,7 % vs 0,0 % à midi. Mais marge infime + 9 tests simultanés → pas de promotion nette. À re-tester sur données propres. |

## 6. Synthèse : niveau vs forme

- **Le NIVEAU prédit** (un peu) : à liquidité ≥ 20 k$, un prix / une liquidité plus élevés à t0 prédisent un meilleur rendement à 6h — pas à 1h. Direction « prix haut = force », pas « top local ». Effet modeste (ρ≈0,27), à confirmer hors biais.
- **La FORME n'est pas testable ici** : 87 % des séries n'ont aucun point pré-t0 (t0 = premier snapshot). Accélération, croissance pré-t0, activité : NON CONCLUANT par manque de données, pas par absence d'effet. Trancher « niveau vs forme » exige des séries qui commencent AVANT 20 k$ de liquidité (collecte propre en cours : data/track-unbiased).
- **La jeunesse ne prédit rien** (et le sens prédit était inversé) ; **l'heure de t0** montre au mieux un faible effet session nocturne, fragile.

## 7. Limites et honnêteté

1. Borne optimiste partout (biais hot tokens / late-discovery).
2. 9 mesures holdout → risque de faux positif familial ≈ 37 % à α=5 % ; les « promotions » restent limites après correction Bonferroni.
3. Couverture @6h/@24h = conditionnée à la survie du token (biais de survie) ; @24h : n=28 < 30.
4. t0 = premier snapshot ≥ 20 k$ : pour 87 % des mints c'est le premier point observé — le « pré-t0 » est un artefact de la cadence du collecteur, pas une fenêtre d'observation contrôlée.
5. Drawdown diagnostique (courbe cumulative des Y triés par X) : non rapporté en table car non interprétable sans stratégie — médianes, P(perte) et P(≤−50 %) ci-dessus portent l'information de risque.
6. Aucune stratégie construite ; aucune transaction ; aucun push (branche feat/deku-cupsey, commits locaux uniquement).

**Prochaines étapes proposées (pas engagées) :** re-mesure du signal « niveau @6h » et de la piste « session nocturne » sur les 30 j de collecte propre (data/track-unbiased) une fois disponibles ; collecte de séries démarrant avant 20 k$ pour trancher la famille FORME (accélération vs niveau).
