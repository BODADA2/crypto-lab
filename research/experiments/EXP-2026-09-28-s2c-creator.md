# EXP-2026-09-28-s2c-creator — Famille F : historique creator (H-S2C-F1)

- **hypothesis_id** : H-S2C-F1 (CREATOR_HISTORY_AS_OF_T0 : launch_count, taux de graduation/survie passés, âge du creator → outcome ; interaction CREATOR × EARLY_FLOW)
- **question** : peut-on reconstruire l'historique d'un creator (deployer) as-of-t0 depuis `data/scans` ?
- **method** : audit exhaustif de tous les fichiers `data/scans/*.json` — recherche d'un champ `creator`/`deployer` (regex `/creator|deployer|authority/i`, hors `mintAuthority`/`freezeAuthority`) non vide dans chaque token record ; distribution des valeurs `mintAuthority` dans `data/history/*.jsonl` (première ligne de chaque série).
- **data** : `data/scans/*.json` (tous les scans), `data/history/*.jsonl`.
- **n** : **35 339** token records audités.
- **leakage_status** : n/a (data-quality — aucun label, aucun modèle).
- **results** :
  - Token records avec champ creator/deployer exploitable : **0 / 35 339 (100 % absent)**. Champs contenant « creator|deployer|authority » trouvés : uniquement `mintAuthority` et `freezeAuthority`.
  - `mintAuthority` dans `data/history` : `UNKNOWN` sur **100 % des 2 926** séries.
  - Conclusion : CREATOR_HISTORY_AS_OF_T0 **non reconstructible** depuis les sources actuelles sans inventer de données. L'interaction CREATOR × EARLY_FLOW est bloquée.
- **verdict** : **DATA ISSUE** — champ creator absent à 100 % des scans ; `mintAuthority` = UNKNOWN partout. Source alternative possible (non testée) : la transaction de création du mint on-chain via Helius (deployer = signataire) — coût API à évaluer, et séquençage backfill→qualité→cron maintenu. Ne pas réintroduire l'artefact devBuy (late-discovery) : toute reconstruction future devra filtrer les creates tardifs.

## Fiche triage

- **HYPOTHESIS** : H-S2C-F1 — l'historique du creator (as-of-t0) prédit l'outcome ; interaction avec EARLY_FLOW.
- **N** : 35 339 token records (scans) ; séries history pour mintAuthority.
- **EFFECT** : n/a — feature non constructible.
- **P-VALUE** : n/a.
- **CI** : n/a.
- **OOS EFFECT** : n/a — holdout non concerné.
- **COHORT STABILITY** : n/a.
- **TIME STABILITY** : n/a.
- **COST SENSITIVITY** : n/a.
- **LEAKAGE STATUS** : n/a (audit data-quality, aucune donnée future utilisée).
- **VERDICT** : **DATA ISSUE** — 0/35 339 records avec creator ; mintAuthority UNKNOWN à 100 %.

## Suivi suggéré

- Si la famille F est priorisée : dériver le deployer depuis la transaction de création du mint (Helius `getTransaction` sur la signature de création) — mesurer le coût crédits d'abord, échantillon n=30, valider la qualité avant tout cron (règle de séquençage).
- Garder le garde-fou anti-artefact devBuy : exclure les creates tardifs (late-discovery) de toute reconstruction.
