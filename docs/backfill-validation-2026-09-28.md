# Validation backfill + qualité early buyers — 2026-09-28

## VALIDATION BACKFILL : PASS
- 180 fichiers cache, **119 tokens propres** (buyers ≥ 10, truncated=false, t0 valide).
- Troncature : truncated=false ⟺ pagination allée au bout (dernière page < 1000 sigs). Aucun non-tronqué n'atteint 60000 sigs. Les 53 tronqués sont exclus du set propre.
- Erreur -32015 : **0 skip / 22904 tx (0,00 %)**. Aucun token > 30 %. Retries v1/v2 jamais nécessaires.
- 8 fichiers inutilisables : 4 réparés (9pKK, CHyP, FkBy, KEaQ), 4 exclus (>60000 sigs avant t0 — même 60 pages insuffisent : 2nkm, JVNT, cJ4g, pzCi).
- Budget : 24382 crédits ce run, 48704 cumulés mois. Pré-filtre t0 : 1503 mints écartés gratuitement.

## VALIDATION QUALITÉ : PASS (échantillon 12 tokens propres)
- Q1 blockTime ≤ t0 (100 %) : PASS 12/12.
- Q2 montants > 0 : PASS 12/12.
- Q3 wallets distincts : PASS 12/12.
- Q4 ranks 0..n-1, blockTime/slot croissants : PASS 12/12.
- Q5 rank 0 à ≤ 5 min de la plus ancienne signature (vérifié live Helius) : PASS 12/12.
- Anomalies : aucune. Exclus : 53 tronqués + <10 buyers.

## Dataset Phase 2 prêt pour la modélisation
119 tokens propres, 0 % de skip, qualité vérifiée. Le holdout `data/track-unbiased/` reste gelé.

## CRON : aucun créé
Plan proposé (création soumise à validation explicite d'Hervé) :
- 1×/jour, mints migrés des dernières 24h, `--require-history-t0 --no-sells --max-pages 60`.
- Garde-fous : `--max-credits 5000`/run, pré-filtre t0 gratuit, `--skip-overlap` idempotent.
- Alertes : stop si skip > 30 % sur un token ou > 50 % de tronqués sur un run.
