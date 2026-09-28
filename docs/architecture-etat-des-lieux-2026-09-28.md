# État des lieux technique — Crypto Lab (architecte)
Date : 2026-09-28. Auteur : Muse (architecte logiciel principal).
Objet : §19 de la spec — auditer l'existant AVANT toute modification majeure, puis changements minimaux.

## 1. Question scientifique et verdicts gelés (rappel intangible)

Question : « La composition des early buyers d'un memecoin Solana à t0 contient-elle une information statistiquement stable sur sa distribution future (rendement, drawdown, graduation, survie) ? »

Verdicts gelés — ne pas rouvrir, ne pas réoptimiser :
- Momentum/scalp : ABANDONNÉ (NO EVIDENCE OF EDGE, commit 40a091c5a).
- Hedge : NO_TRADE définitif.
- Phase 1 prédictive : NO EVIDENCE OF PREDICTIVE SIGNAL (espérance positive) ; 3 signaux de perte OOS = FILTRES DE RISQUE.
- devBuy ≥ 1,3 SOL : FALSIFIÉE.
- Revue littérature (37 papiers, mémoire 28/09) : aucun papier ne régresse la survie des memecoins Solana sur la composition des early buyers (gap = notre ouverture) ; Kamat 2026 (AUROC 0,86 → 0,46 sur holdout temporel) valide notre discipline ; Liu et al. 2025 : clusteriser les wallets en entités AVANT tout calcul de concentration ; MELT : 36,5 % de la supply tenue par comptes coordonnés.

## 2. Architecture actuelle

```
Collecte (lab/collect/)            Signaux (lab/signals/)           Recherche (lab/predictive/)
─────────────────────              ────────────────────             ──────────────────────────
helius.ts (RPC, -32015 tolerant)    run-earlybuyers.ts ──► data/earlybuyers/<mint>.json
track-unbiased.ts (cron /15min) ──► data/track-unbiased/  earlybuyers.ts (bundle metrics)
fastlane*.ts (Helius WS,           phase1: flows/liquidity/temporal/distribution/wallets/
  p50 détection ~140 ms) ──► data/fastlane/               phase2: earlybuyers/ (NOUVEAU)
dexscreener.ts ──► data/history/  │                        universe.ts (t0, anti-glitch, splits)
                                    ▼
                          data/earlybuyers/wallet-histories/<wallet>.json (cache brut)

lab/predictive/earlybuyers/ (pipeline Phase 2, 719 tests verts) :
  snapshot.ts → features.ts → audit.ts (FAIL THE RUN si fuite)
      → labels.ts → stats.ts → models.ts → compare.ts → run.ts
```

Séparation respectée : le moteur de recherche ne touche ni au Risk Engine, ni à l'exécuteur, ni aux seuils paper (lab/paper-engine/, lab/risk/, lab/exec/).

## 3. Données disponibles

| Source | Volume (28/09) | Usage Phase 2 | Biais / limites |
|---|---|---|---|
| data/earlybuyers/<mint>.json | ~35 fichiers (backfill en cours, agent dédié) | EARLY_BUYER_SET(t0) | 5 fichiers `truncated:true` + 0 buyer pré-t0 = INUTILISABLES (re-fetch en cours) |
| data/earlybuyers/wallet-histories/ | en remplissage | historiques wallets pré-t0 | limite 1000 signatures ; fenêtre glissante (reproductibilité : fetchedAt stocké) |
| data/history/ | 2926 séries | t0 (findT0), Y, DD, survie | biais tokens chauds → borne OPTIMISTE |
| data/scans/pump-*.jsonl | 352 fichiers | événements migrate (labels graduation) | idem |
| data/fastlane/ | creates live, p50 ~140 ms | ancrage t0 on-chain futur | pas de deployer parsé actuellement |
| data/track-unbiased/ | 6 fichiers | HOLDOUT GELÉ — jamais lu | collecte J+1 |

## 4. Pipelines existants

- **Backfill early buyers** (lab/signals/run-earlybuyers.ts) : idempotent, garde-fous crédits (15 k/run, 400 k/mois ; 24 k consommés). En cours par un agent séparé — NE PAS TOUCHER à ses écritures.
- **Pipeline Phase 2** (lab/predictive/earlybuyers/run.ts --phase discovery|calibration) : snapshots → audit anti-fuite (fail fast) → labels → stats (Spearman + permutation + bootstrap + déciles) → modèles (logistique, RF) → ALL/EXCLUS/RETENUS → secondaire WITH_VALID_EXTREME_EVENTS. Holdout jamais lu (garde FAIL). Dernier run : NON_CONCLUSIF (n=1 snapshot valide — backfill incomplet, attendu).

## 5. Audit du pipeline contre la spec (§1–§18)

| § Spec | Statut | Écart |
|---|---|---|
| §1 objectif / 3 états | 🟡 partiel | verdicts NON_CONCLUSIF/AUCUN_SIGNAL/CANDIDAT_A_VERIFIER présents mais critères §17 non formalisés |
| §2 snapshot point-in-time | 🟢 conforme | tsMs ≤ t0ms, audit FAIL THE RUN, contamination Phase 1 (sells post-migration) interdite et documentée |
| §3 fenêtres early buyers séparées | 🔴 manquant | UNE seule définition (set pré-t0) ; first block / N slots / N secondes / N minutes / X% bonding curve non séparées |
| §4 WALLET ≠ ENTITY | 🔴 manquant | concentration calculée sur adresses brutes (giniAmt, top1/5Share) ; aucun clustering traçable ; littérature (Liu 2025) exige l'inverse |
| §5 feature store | 🟡 partiel | 15 features fixes ; manquent : HHI, concentration entité, coordination (funder, fan-in/out), état du lancement (SOL locked, bonding curve, frénésie — existent en Phase 1 flows/liquidity, non câblés), manipulation ; P&L historique pré-t0 indisponible (pas de prix historiques wallets — honnête) |
| §6 labels | 🟡 partiel | Y_1H/6H/24H ✓, DD30/50/80 ✓ ; manquent : graduation/migration on-chain (données dispo dans scans), définitions de mort multiples + sensibilité, activité J+1/7/30/90 (séries trop courtes — honnête) |
| §7 ALL/EXCLUS/RETENUS | 🟡 partiel | compare.ts existe mais règle d'exclusion = « top tercile giniAmt » (placeholder arbitraire, pas de règles pré-enregistrées) |
| §8 méthode statistique | 🟡 partiel | ordre respecté, pas de deep learning, règle SUSPECT ✓ ; manquent : Cox PH / random survival forest (littérature), stabilité par cohorte non câblée dans run.ts |
| §9 splits | 🟡 partiel | hash 50/25/25 gelé ✓ ; séparation temporelle et par deployer/entité manquantes (délibéré : ne pas churner le protocole gelé — ajouter en analyse secondaire) |
| §10 anti-overfitting | 🟢 conforme | holdout jamais lu, hypothèses pré-enregistrées, aucune re-calibration |
| §11 outliers / data quality | 🟢 conforme | DATA_ERROR_MINTS (SKHY), aberrantMask ≥100×, analyse secondaire séparée ; 5 fichiers cache inutilisables remontés (re-fetch en cours) |
| §12 collecte live | 🟢 conforme | Helius source principale, trace brute immuable, features recalculables |
| §13 holdout gelé | 🟢 conforme | track-unbiased/ jamais lu par le pipeline |
| §14 paper-trading | 🟢 conforme | untouched |
| §15 contraintes absolues | 🟢 conforme | aucune transaction réelle, aucun push |
| §16 output structuré | 🔴 manquant | aucun objet standardisé par token (TOKEN_ID…LEAKAGE_STATUS…) |
| §17 logique de décision | 🟡 partiel | 3 états approximés, checklist de promotion non formalisée |
| §18 conception du code | 🟢 conforme | tests, logs, timestamps, tests de leakage, reproductibilité ; versioning modèle à ajouter (MODEL_VERSION) |

## 6. Risques de leakage identifiés

| Risque | Sévérité | Statut |
|---|---|---|
| Features sells post-migration (Phase 1) | 🔴 critique | CORRIGÉ — interdites en Phase 2, documenté |
| overlapFrac calculé sur tout l'univers (Phase 1) | 🟠 haute | CORRIGÉ — discovery+calibration uniquement, observations ≤ t0ms |
| Fichiers backfill tronqués (buyers post-t0 présentés comme « first ») | 🟠 haute | EN COURS — re-fetch avec anti-troncature par l'agent backfill ; fichiers marqués dans le rapport data quality |
| Cache wallet-histories : fenêtre des 1000 signatures les plus récentes AU MOMENT DU FETCH | 🟡 moyenne | ACCEPTÉ — fetchedAt stocké, filtrage ≤ t0ms refait à chaque lecture ; wallets très actifs sous-échantillonnés (documenté) |
| t0 = premier scan DexScreener (pas la naissance on-chain) | 🟡 moyenne | CONNU — fastlane fournit l'ancrage on-chain (p50 ~140 ms) pour les futurs tokens ; le pipeline garde findT0 comme définition reproductible actuelle |
| overlap inter-tokens : un wallet vu sur un token discovery+calibration dont le t0 est APRÈS le t0 courant | 🟢 faible | CORRIGÉ — seules les observations ≤ t0ms comptent |

## 7. Modules réutilisables (ne pas réécrire)

- lab/predictive/universe.ts : findT0, aberrantMask, futureReturns, spearman, bootstrapCI, splitUniverse, deciles.
- lab/predictive/wallets/features.ts : giniOf, topNAmountShare (purs, testés).
- lab/predictive/wallets/analysis.ts : cohortStability, temporalStability, decileTopBottom (à câbler dans run.ts).
- lab/signals/earlybuyers.ts : computeBundleMetrics (top5_share, gini, same_slot_max).
- lab/collect/helius.ts : getEarlyBuyers, getSignaturesForAddress, getTransaction (tolérant -32015 après fix agent backfill).
- lab/predictive/earlybuyers/ : snapshot, features (15), audit, labels, stats, models, compare, run — base saine, étendre par ajout.

## 8. Changements minimaux nécessaires (ordonnés)

1. **clusters.ts** (nouveau) : clustering wallet→entité avec niveaux de preuve (`same_slot`, `temporal_sync`, `persistent_cooccurrence`) ; vocabulaire wallet/cluster/entity-like group/coordinated set ; `hhi()`, concentration par entité. (§4 — priorité littérature)
2. **windows.ts** (nouveau) : définitions séparées `pre_t0_set` (défaut, comportement inchangé), `first_block`, `first_5_slots`, `first_60s`, `first_300s` ; chaque fenêtre = FeatureSet séparé et comparable. (§3)
3. **features.ts** (étendre) : HHI wallet + entité, gini/top1 par entité, `entityCount`, `coordinatedSetFrac`, `sniperShare` ; tsMs inchangé. (§4, §5)
4. **labels.ts** (étendre) : `graduated_7d`/`migrated_7d` depuis data/scans (readMigrations), définitions de mort multiples (`death_liq`, `death_price`, `death_dd80`) + table de sensibilité. (§6)
5. **exclusions.ts** (nouveau) : règles PRÉ-ENREGISTRÉES (DATA_ERROR, TRUNCATED, SMALL_SET, SNIPE_DOMINATED) avec raisons ; remplace le placeholder gini-tercile dans compare. (§7, §10)
6. **survival.ts** (nouveau) : Cox PH (vraisemblance partielle, Breslow, Newton-Raphson, pure TS) + Kaplan-Meier par groupe + indice de concordance. (§8)
7. **score.ts** (nouveau) : objet standardisé §16 par token ; champs indisponibles = null + raison ; MODEL_VERSION, FEATURE_CUTOFF, DATA_TIMESTAMP_AUDIT, LEAKAGE_STATUS, COHORT, SPLIT, CONFIDENCE_INTERVAL, EXCLUSION_REASON. (§16)
8. **decide.ts** (nouveau) : les 3 états §17 avec checklist explicite (OOS, holdout gelé, time split, univers non biaisé, multi-horizons, multi-cohortes, définitions, tests simples, modèles concurrents, coûts, outliers, stabilité) ; état 3 = « candidate predictive relation », jamais « guaranteed edge ». (§17)
9. **run.ts** (câblage minimal) : stabilité par cohorte (réutiliser wallets/analysis.ts), Cox PH, compare avec exclusions pré-enregistrées, score par token, état de décision ; flag `--windows` optionnel (défaut = comportement actuel).
10. **Docs** : phase2 mis à jour, registre H-PRED-EARLY-*, le présent état des lieux.

HORS SCOPE honnête (indisponible, documenté) : P&L historique wallets pré-t0 (pas de prix historiques), common funder / fan-in-out (deltas SOL non capturés dans le cache — prévoir extension du cache), deployer link (CreateEvent non parsé pour le deployer), activité on-chain post-t0 au niveau tx (labels de mort par prix/liquidité uniquement).

## 10. Addendum fast-lane (28/09 ~13h20 UTC)

Run d'observation 60 min terminé : 0 reconnexion, 582 893 notifications, 1 294 creates détectés, latence p50/p95/p99 = 132/313/384 ms (objectif <2 s atteint — l'ancrage t0 on-chain est viable techniquement).
VERDICT COÛT : firehose brut `logsSubscribe` = ~14 M crédits/mois → économiquement exclu sur le plan gratuit (1 M/mois). Option viable : flux parsé filtré par événement (~39 000 crédits/mois estimés). Décision : ne pas industrialiser le firehose brut ; le t0 on-chain reste disponible à la demande (runs bornés).
Commits locaux 9b6243850 (auth Helius sécurisée via skill, WSS via proxy, 20 tests) et 9e1b4a8c5 (docs), aucun push.

## 11. Règle de séquençage (directive d'Hervé, 28/09)

**Valider le backfill → valider la qualité des early buyers → seulement ensuite proposer le cron.** Le cron ne précède jamais la qualité des données. Le plan de cron sera soumis pour décision, jamais créé unilatéralement. Transmis à l'agent backfill : rapport de validation en deux sections (VALIDATION BACKFILL : complétude, non-troncation, couverture premières signatures, tolérance -32015 ; VALIDATION QUALITÉ : buyers pré-t0 réels vs artefacts, cohérence rank/chronologie, proximité rank-0 vs plus ancienne signature).

## 9. Principe directeur

Ne pas réécrire le pipeline : il est sain, testé (719 verts), et l'audit anti-fuite fonctionne. Les changements ci-dessus sont des AJOUTS (nouveaux modules) + câblage minimal. Le succès = répondre correctement à la question, pas trouver un edge. NO DATA ≠ NO SIGNAL / NO EVIDENCE ≠ EDGE. PROVE IT OUT-OF-SAMPLE OR DO NOT TRADE IT.

## 12. Addendum Master R&D (28/09 ~14h UTC, directive d'Hervé)

Passage en MASTER R&D MODE : EDGE HUNTING + GUT ENGINE. Early buyers devient la famille B parmi 18 (A-R) : A Avoidance, B Early Flow, C Capital Velocity, D Organicity, E Actors/Entity, F Creator History, G Regime, H Transitions, I Post-graduation, J Microstructure, K Divergence, L Wait, M Sequences, N Change point, O Anomaly, P Survival, Q Graduation, R Danger.
Registre migré vers A-R (87 hypothèses, `family_legacy` conservé). Nouveaux artefacts : `research/gut_engine.md` (GUT = priorité de recherche, jamais preuve), `research/mystery_queue.md` (4 anomalies : M-001 décile D1, M-002 sets pré-t0 vides, M-003 glitches décimaux, M-004 paradoxe H-HEDGE-EXPOSURE), `research/memory_of_failure.md` (21 tuées). Statut NEAR_MISS ajouté.
Sprint 1 (4 expériences) : E1 PROMISING (liqT0→survie, HR=0,691), E2 NULL (régime), E3 KILLED (danger binaire), E4 PROMISING (fenêtres ; first_60s/300s à déprécier). Sprint 2 lancé en parallèle : 2A Divergence+Anomaly, 2B Wait+Change point, 2C Actors+Creator, 2D Avoidance (valeur économique des filtres).
Inchangé : spec architecte, séquençage backfill→qualité→cron, verdicts gelés, holdout sacré, contraintes absolues.
