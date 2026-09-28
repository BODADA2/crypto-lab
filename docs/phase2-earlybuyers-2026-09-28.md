# Phase 2 — Early buyers, early flow, survival — 2026-09-28

## Question
« La composition des early buyers d'un memecoin Solana à t0 contient-elle une information statistiquement stable sur sa distribution future : rendement, drawdown, graduation et survie ? »

## Statut : NON_CONCLUSIF (backfill en cours de validation)
Verdict final après : validation backfill → validation qualité → run discovery complet → OOS + holdout gelé. Les trois états possibles : `NO EVIDENCE OF EARLY-BUYER SIGNAL` / `EARLY-BUYER RISK FILTER` / `POSITIVE PREDICTIVE RELATION` (candidate, jamais « guaranteed edge »).

## Architecture
Pipeline `lab/predictive/earlybuyers/` (16 modules) : snapshot strict t0, audit anti-leakage fail-fast (`feature_timestamp ≤ t0`, FAIL THE RUN sinon), features 22 (15 + 7 entités/clustering : entityCount, hhiWallet, hhiEntity, giniEntity, top1EntityShare, coordinatedSetFrac, sniperShare), labels Y_1H/Y_6H/Y_24H + DD30/50/80 + survie, exclusions pré-enregistrées (DATA_ERROR, TRUNCATED, SMALL_SET, SNIPE_DOMINATED), Cox PH + Kaplan-Meier, score §16 par token, décision §17. 785+ tests verts.

Fenêtres séparées et comparables : `pre_t0_set`, `first_block`, `first_5_slots`, `first_60s`, `first_300s` (+ first_10_blocks, 30s, 120s en backlog).

## Résultat E4 (sprint 1, n=61 mints) — fenêtres
- `first_block`/`first_5_slots` : matériellement distinctes (snipers stricts ≈ 3 wallets ; Jaccard pre_t0↔first_block = 0,10).
- `first_60s`/`first_300s` : quasi-redondantes avec le set pré-t0 (Jaccard 0,92/0,98) → **à déprécier** des analyses Phase 2.
- 14/61 sets pré-t0 vides → qualité on-chain à surveiller (cf M-002).

## Contamination corrigée
`sellersOver50` / `medianSoldFrac` (Phase 1) : calculés post-migration → interdits en Phase 2 (features DEPRECATED au registre). H-PRED-WAL-07 tuée en l'état.

## Données
- `data/earlybuyers/` : backfill Helius en cours (RUN --tokens 100 --no-sells --skip-overlap --max-pages 60, pré-filtre history+t0, tolérance -32015 v0→v1→v2).
- 5 fichiers « truncated: true » historiques : re-fetch ciblé en cours.
- `data/track-unbiased/` : gelé, jamais lu avant la fin du gel (30 j).
- Biais : `data/history/` + `data/scans/` favorisent les tokens chauds → toute mesure = borne optimiste.

## Validation requise (directive d'Hervé : backfill → qualité → cron)
1. VALIDATION BACKFILL : complétude (≥30 tokens propres), non-troncation, couverture premières signatures, tolérance -32015.
2. VALIDATION QUALITÉ : buyers pré-t0 réels vs artefacts (blockTime ≤ t0, cohérence rank/chronologie, rank-0 proche de la plus ancienne signature).
3. Seulement ensuite : proposition de plan de cron (jamais créé unilatéralement).

## Verdicts gelés (non rouverts)
Momentum/scalp : NO EVIDENCE OF EDGE. Hedge : NO_TRADE. devBuy ≥1,3 SOL : falsifié. Phase 1 : NO EVIDENCE OF PREDICTIVE SIGNAL (3 RISK FILTERS : frénésie, turnover, niveau liq).
