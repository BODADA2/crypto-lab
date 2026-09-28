# H-DEVSUPPLY / H-BLOCKZERO — mesure sur le backfill Phase 2 (2026-09-28)

## Verdicts
- **H-DEVSUPPLY : DATA_ISSUE** (n=0 mesurable, banc n≥30 inapplicable)
- **H-BLOCKZERO : DATA_ISSUE** (n=0 mesurable, banc n≥30 inapplicable)

Aucune des deux hypothèses n'est falsifiée ni confirmée. Elles restent OPEN.

## Méthode (vérifications effectuées, lecture seule, 0 crédit Helius)
1. Définitions relues dans `research/hypotheses.yaml` : H-BLOCKZERO exige `block0_dev_linked_share`
   (part de supply captée au block 0 par des wallets **liés au dev**) ; H-DEVSUPPLY exige
   `dev_sol_extracted` / `dev_extraction_rate` (SOL net extrait par le wallet **dev**).
2. Scan exhaustif des clés de `data/earlybuyers/*.json` (180 fichiers) : **aucune clé**
   `dev` / `creator` / `feePayer` / `authority` / `supply`. Chaque cache ne contient que
   `buyers[]` = {wallet, signature, blockTime, slot, rank, amountRaw}.
3. Code du backfill relu (`lab/signals/run-earlybuyers.ts`, `lab/signals/earlybuyers.ts`,
   `lab/signals/devblocklist.ts`) : le run du 2026-09-28 utilisait **`--no-sells`** par design
   → aucune transaction de vente dans le set ; la dev-blocklist est un registre **manuel**,
   aucune identification automatique du dev n'existe.
4. Labels : `data/history/*.jsonl` (snapshots DexScreener : priceUsd, liquidityUsd,
   mintAuthority, freezeAuthority, top10Pct) couvrent ~123/127 tokens propres mais avec
   1 seul snapshot pour beaucoup → labels de drift faibles de toute façon.
5. Conclusion : l'identifiant pivot (wallet dev) est **INCONNU** pour les 119 tokens.
   Mesurer un proxy (ex. concentration des premiers acheteurs sans lien dev) testerait
   H-BUNDLE, pas ces hypothèses → refusé (ne pas présenter une hypothèse pour une autre).

## Donnée manquante exacte
- Les deux hypothèses : **l'identité du wallet dev** par token (le créateur = feePayer
  de la transaction de création du mint).
- H-BLOCKZERO en plus : **le set des wallets liés au dev** (cluster : wallets financés
  par / interagissant avec le dev **avant t0**).
- H-DEVSUPPLY en plus : **les sorties nettes de SOL du wallet dev** sur une fenêtre
  fixe post-t0 (ventes → absentes du backfill actuel).

## Plan d'acquisition sans biais (à exécuter, ~120 crédits, pas exécuté ici — ZÉRO dépense)
1. Pour chacun des 119 tokens : `getTransaction` sur la signature de rank 0 (déjà en cache)
   → extraire le feePayer = wallet dev candidat. Info **pré-t0** → pas de fuite.
2. H-BLOCKZERO : pour les acheteurs des premiers slots, vérifier les liens de funding
   pré-t0 vers le dev (1–2 hops, `getSignaturesForAddress` borné) → set dev-linked ;
   `block0_dev_linked_share` = somme amountRaw du set / supply totale (decimals via mint).
   Features horodatées ≤ t0 → FAIL THE RUN sinon.
3. H-DEVSUPPLY : historique du wallet dev (`getWalletTokenHistory` / deltas SOL) sur
   fenêtre fixe **t0→t0+24h** pré-enregistrée → `dev_sol_extracted`, `dev_extraction_rate`
   = SOL extrait / liquidité à t0 ; `liquidity_reinjected` = SOL re-déposé.
   Labels drift depuis snapshots DexScreener (prix t0+24h / prix t0), jamais l'inverse.
4. Garde-fou causalité : l'extraction précède la mesure du drift dans le temps ;
   enregistrer le sens avant de mesurer (un dev qui vend parce que le token meurt ≠
   un token qui meurt parce que le dev vend).
5. N≥30 avant tout verdict ; verdicts gelés (momentum/scalp, hedge, devBuy) non rouverts.

## Coût estimé
~119 `getTransaction` (dev ID) + ~119 historiques wallet bornés ≈ quelques centaines
de crédits Helius, à planifier dans un run dédié avec `--max-credits` explicite.
