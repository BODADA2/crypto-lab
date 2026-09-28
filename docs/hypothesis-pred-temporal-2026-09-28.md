# Hypothèses prédictives — TEMPORAL STRUCTURE (domaine 5/5)

**Date :** 2026-09-28 · **Phase :** DÉCOUVERTE · **Branche :** `feat/deku-cupsey` (aucun push)
**Protocole :** `lab/predictive/universe.ts` (split discovery <50 / calibration 50–74 / holdout ≥75, disjoints par hash FNV du mint) · t0 = premier snapshot liquidityUsd ≥ 20 000 et priceUsd > 0 · Y = rendement futur (prix nettoyés des ticks aberrants) sur 1h / 6h / 24h, null si horizon non couvert.
**Pré-enregistrement :** OUI — ce document (prédictions, variables, critères de passage) est rédigé AVANT toute exécution de `lab/predictive/temporal/run.ts`.
**Données :** `data/history/` (2 926 mints, ~35 339 ticks, séries courtes ~12 ticks/mint, cadence irrégulière) — biaisées vers les tokens chauds → **toute mesure = borne OPTIMISTE** (déclaré dans chaque résultat).
**Règle n≥30** pour toute conclusion. Résultat principal AVEC les outliers valides (ticks aberrants ≥100× vs voisins toujours exclus ; outliers valides = Y hors [P1, P99], analysés avec et sans).
**Interdit :** aucune stratégie construite en phase découverte — relation prédictive uniquement. Holdout : UNE SEULE mesure par survivant, jamais de re-calibrage après.

---

## Question centrale

Ce qui prédit le rendement futur Y, est-ce le **NIVEAU** (prix haut, liquidité haute, croissance forte avant t0) ou la **FORME** (accélération/décélération en arrivant à t0, jeunesse du token, rythme d'activité, session horaire) ? Les deux familles sont testées séparément, variable par variable, horizon par horizon.

## Variables X (toutes mesurables à t0 ou avant, en temps réel ms)

| Famille | Variable | Définition | Hypothèse ID |
|---|---|---|---|
| NIVEAU | `priceAtT0` | prix à t0 | H-PRED-TEMP-LEVEL |
| NIVEAU | `liqAtT0` | liquidité à t0 | H-PRED-TEMP-LEVEL |
| NIVEAU | `growthPreT0PerH` | pente log-prix/heure, premier snapshot valide → t0 | H-PRED-TEMP-GROWTH |
| FORME | `agePairMs` | t0 − pairCreatedAt (jeunesse ; null si pairCreatedAt null) | H-PRED-TEMP-AGE |
| FORME | `ageTokenMs` | t0 − createdAt | H-PRED-TEMP-AGE |
| FORME | `accelPerH2` | pente 2e moitié − pente 1re moitié (log-prix/h), pré-t0→t0 | H-PRED-TEMP-ACCEL |
| FORME | `accelSign` | signe de `accelPerH2` | H-PRED-TEMP-ACCEL |
| FORME | `interSnapMeanMs` | durée moyenne entre snapshots pré-t0 (activité) | H-PRED-TEMP-ACTIVITY |
| FORME | `hourSin` / `hourCos` | heure UTC de t0, encodage cyclique (effet session, sans a priori) | H-PRED-TEMP-SESSION |

Note : « time-to-liquidity » (create→t0) = `agePairMs` par définition — une seule variable, pas deux (vérifié sur les données : corrélation âge paire / âge token rapportée dans la fiche résultats).

## Hypothèses

### H-PRED-TEMP-AGE — la jeunesse prédit Y
**Prédiction :** les tokens jeunes à t0 (âge faible) ont un Y médian supérieur aux tokens vieux. Direction attendue : ρ(âge, Y) < 0.
**Falsificateur :** ρ ≥ 0 ou IC95 % incluant 0 sur discovery, ou signe instable entre moitiés/cohortes.

### H-PRED-TEMP-GROWTH — la croissance pré-t0 prédit Y (NIVEAU)
**Prédiction :** une pente de croissance forte avant t0 prédit un Y supérieur (momentum). Direction : ρ > 0.
**Falsificateur :** ρ ≤ 0 sur discovery. Note : n réduit (t0 au premier snapshot ⇒ pas de pré-t0) — si n < 30, verdict NON CONCLUANT, pas NO SIGNAL.

### H-PRED-TEMP-ACCEL — l'accélération prédit Y (FORME)
**Prédiction :** une croissance qui ACCÉLÈRE en arrivant à t0 (accel > 0) prédit un Y supérieur à une croissance qui décélère — à pente égale, la forme domine le niveau. Direction : ρ(accel, Y) > 0.
**Falsificateur :** ρ ≤ 0, ou `growthPreT0PerH` prédit mais pas `accelPerH2` (auquel cas c'est le niveau, pas la forme).

### H-PRED-TEMP-ACTIVITY — le rythme pré-t0 prédit Y
**Prédiction :** des snapshots rapprochés avant t0 (activité intense) prédisent un Y supérieur. Direction : ρ(interSnapMeanMs, Y) < 0.
**Falsificateur :** ρ ≥ 0. Même réserve n que H-PRED-TEMP-GROWTH.

### H-PRED-TEMP-SESSION — l'heure de t0 prédit Y
**Prédiction :** effet session horaire (direction non fixée — test sans a priori via encodage cyclique sin/cos + médianes par tranche de 4h).
**Falsificateur :** |ρ| < 0,1 sur les deux composantes et écarts inter-tranches dans le bruit.

### H-PRED-TEMP-LEVEL — le niveau à t0 prédit Y
**Prédiction :** prix ou liquidité élevés à t0 prédisent Y (direction non fixée : « prix haut = force » ρ > 0 vs « prix haut = top local » ρ < 0 — le signe observé tranche).
**Falsificateur :** |ρ| < 0,1 avec IC incluant 0.

## Critères de passage (gelés)

**Discovery → calibration** (les 6 conditions) :
1. n ≥ 30 ; 2. |ρ| ≥ 0,10 ; 3. IC95 % bootstrap de ρ exclut 0 ;
4. même signe de ρ sur les 2 moitiés temporelles ET les 2 cohortes (hash pair/impair) ;
5. déciles : médiane Y du décile top − médiane Y du décile bottom de même signe que ρ ;
6. résultat principal AVEC outliers valides (ticks aberrants exclus d'office).

**Calibration → holdout :** n ≥ 30, même signe que discovery, |ρ| ≥ 0,07.

**Holdout (UNE mesure) :** succès si même signe et IC95 % exclut 0 avec n ≥ 30 → hypothèse PROMUE en phase calibration-avancée ; sinon NO SIGNAL (documenté, pas de re-test).

## Statuts (mis à jour après exécution — 2026-09-28 ~12h35)

| ID | Discovery | Calibration | Holdout | Verdict |
|---|---|---|---|---|
| H-PRED-TEMP-AGE | ρ=+0,406 stable @24h (direction prédite ρ<0 **falsifiée**) | ρ=0,082, IC inclut 0 | ρ=0,103, IC inclut 0, n=28 | **FALSIFIÉE puis NO SIGNAL** — l'âge ne prédit rien ; agePair ≡ ageToken (ρ=1,0) |
| H-PRED-TEMP-GROWTH | n=38/27/5 ; @6h ρ=−0,445 IC[−0,699;−0,088] mais n=27 | — | — | **NON CONCLUANT** (n<30 ; structurellement sous-alimenté) |
| H-PRED-TEMP-ACCEL | n=16/12/3 | — | — | **NON CONCLUANT** (pas mesurable sur ces séries) |
| H-PRED-TEMP-ACTIVITY | n=21/16/4 | — | — | **NON CONCLUANT** (pas mesurable sur ces séries) |
| H-PRED-TEMP-SESSION | hourSin : rien ; hourCos@1h ρ=−0,170 IC[−0,269;−0,068] stable | hourCos@1h ρ=−0,207 IC[−0,343;−0,071] | hourCos@1h ρ=−0,138 IC[−0,279;**−0,004**], n=182 | **PISTE FRAGILE** — passe les critères de justesse, non robuste au multiple-testing |
| H-PRED-TEMP-LEVEL | price/liq = un signal (ρ=0,977) ; @6h ρ≈0,39–0,41 stables | @6h ρ=0,305/0,278 | @6h ρ=0,278/0,271 IC excluant 0, n=97 ; @1h ρ≈0,01 ; @24h n=28 | **PROMU @6h** (réserves : 9 tests, borne optimiste, biais de survie) · **NO SIGNAL @1h** · **NON CONCLUANT @24h** |

Résultats détaillés : `docs/predictive-temporal-2026-09-28.md` · Code : `lab/predictive/temporal/` · Tests : `tests/predictive-temporal.test.ts` (18 verts).
