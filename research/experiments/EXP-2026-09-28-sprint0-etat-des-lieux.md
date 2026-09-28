# EXP-2026-09-28-sprint0-etat-des-lieux

- **hypothesis_id** : n/a (état des lieux technique — spec §19, SPRINT 0 du directeur R&D)
- **question** : L'existant technique (collecte, pipelines, données, docs) est-il sain et prêt pour la Phase 2 (early buyers + survival), et que faut-il changer au minimum ?
- **method** : Audit de l'existant contre la spec §1–§18, sans modifier le pipeline. Verdicts scientifiques gelés rappelés comme intangibles. Changements proposés = AJOUTS (nouveaux modules) + câblage minimal uniquement.
- **data** : `docs/architecture-etat-des-lieux-2026-09-28.md` (28/09/2026) — synthèse ci-dessous.
- **n** : n/a
- **leakage_status** : CLEAN (document d'audit, pas une expérience statistique)
- **verdict** : NULL (pas un test d'hypothèse — inventaire)

## Résumé de l'état des lieux

**Question scientifique (Phase 2)** : « La composition des early buyers d'un memecoin Solana à t0 contient-elle une information statistiquement stable sur sa distribution future (rendement, drawdown, graduation, survie) ? »

**Verdicts gelés — ne pas rouvrir, ne pas réoptimiser :**
- Momentum/scalp : ABANDONNÉ (`NO EVIDENCE OF EDGE`, commit 40a091c5a).
- Hedge : NO_TRADE définitif.
- Phase 1 prédictive : NO EVIDENCE OF PREDICTIVE SIGNAL (espérance positive) ; 3 signaux de perte OOS = FILTRES DE RISQUE.
- devBuy ≥ 1,3 SOL : FALSIFIÉE.
- Revue littérature (37 papiers) : aucun papier ne régresse la survie des memecoins Solana sur la composition des early buyers (gap = notre ouverture) ; Kamat 2026 (AUROC 0,86 → 0,46 sur holdout temporel) valide la discipline anti-overfitting ; Liu et al. 2025 : clusteriser les wallets en entités AVANT tout calcul de concentration ; MELT : 36,5 % de la supply tenue par comptes coordonnés.

**Architecture (conforme, séparation respectée)** : collecte (`lab/collect/`) → signaux (`lab/signals/`) → recherche (`lab/predictive/`). Le moteur de recherche ne touche ni au Risk Engine, ni à l'exécuteur, ni aux seuils paper.

**Données disponibles (28/09)** : `data/earlybuyers/` (~35 fichiers, backfill en cours — 5 fichiers `truncated:true` + 0 buyer pré-t0 = INUTILISABLES, re-fetch en cours) · `data/history/` (2926 séries, biais tokens chauds = borne OPTIMISTE) · `data/scans/pump-*.jsonl` (352 fichiers, labels graduation) · `data/fastlane/` (t0 on-chain, p50 ~140 ms) · `data/track-unbiased/` (HOLDOUT GELÉ — jamais lu).

**Pipeline Phase 2** (`lab/predictive/earlybuyers/`, 719 tests verts) : snapshot → features → audit anti-fuite (FAIL THE RUN) → labels → stats → modèles → compare → run. Dernier run : NON_CONCLUSIF (n=1 snapshot valide — backfill incomplet, attendu).

**Audit contre la spec — écarts à combler** : 🔴 manquants = fenêtres early buyers séparées (§3), WALLET ≠ ENTITY / clustering traçable (§4, priorité littérature), objet standardisé par token (§16) ; 🟡 partiels = feature store (§5), labels graduation/mort multiples (§6), exclusions pré-enregistrées (§7), Cox PH + stabilité par cohorte (§8), splits temporels/deployer (§9), logique de décision 3 états (§17) ; 🟢 conformes = snapshot point-in-time + anti-fuite (§2, §10), outliers (§11), collecte live (§12), holdout gelé (§13), paper-trading (§14), contraintes absolues (§15), conception du code (§18).

**Risques de leakage identifiés** : features sells post-migration Phase 1 (🔴 CORRIGÉ — interdites en Phase 2) · overlapFrac sur tout l'univers (🟠 CORRIGÉ) · fichiers backfill tronqués (🟠 EN COURS — re-fetch agent backfill) · cache wallet-histories fenêtre 1000 signatures (🟡 ACCEPTÉ, fetchedAt stocké) · t0 = premier scan DexScreener (🟡 CONNU — fastlane pour le futur).

**10 changements minimaux ordonnés** : 1. `clusters.ts` (clustering wallet→entité) · 2. `windows.ts` (fenêtres séparées) · 3. `features.ts` (étendre : HHI, entité, coordination) · 4. `labels.ts` (graduation on-chain, morts multiples) · 5. `exclusions.ts` (règles pré-enregistrées) · 6. `survival.ts` (Cox PH, Kaplan-Meier) · 7. `score.ts` (objet standardisé §16) · 8. `decide.ts` (3 états §17) · 9. `run.ts` (câblage minimal) · 10. Docs (phase2, registre H-PRED-EARLY-*, état des lieux).

**HORS SCOPE honnête** : P&L historique wallets pré-t0 (pas de prix historiques), common funder / fan-in-out (deltas SOL non capturés), deployer link (CreateEvent non parsé), activité on-chain post-t0 au niveau tx.

**Règle de séquençage (directive d'Hervé)** : valider le backfill → valider la qualité des early buyers → seulement ensuite proposer le cron. Le cron ne précède jamais la qualité des données.

**Principe directeur** : ne pas réécrire le pipeline (sain, testé, audit anti-fuite fonctionnel). Le succès = répondre correctement à la question, pas trouver un edge. NO DATA ≠ NO SIGNAL / NO EVIDENCE ≠ EDGE. PROVE IT OUT-OF-SAMPLE OR DO NOT TRADE IT.

## Results

| Item | Statut |
|---|---|
| Pipeline Phase 2 | sain, 719 tests verts, audit anti-fuite fonctionnel |
| Backfill early buyers | en cours (agent dédié) — NE PAS TOUCHER à ses écritures |
| Écarts spec | 3 manquants, 7 partiels, 8 conformes |
| Verdicts scientifiques | gelés, intangibles |
| Prochaine étape | changements 1–9 (ordonnés), puis backfill → qualité → cron |
