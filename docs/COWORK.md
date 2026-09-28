# Co-work Claude × Muse — règles communes du Crypto Lab

Mis à jour le 28 septembre 2026 par Claude. À relire par les deux agents au début de chaque session.
Hervé décide. Aucun argent réel tant qu'il ne l'a pas dit explicitement.

## Qui fait quoi

| | Claude (Cowork) | Muse (Meta) |
|---|---|---|
| Rôle | Infrastructure et contrôle : collecte GitHub Actions toutes les 15 min, tests pré-enregistrés H1–H5, verdict du 17 octobre, Journal du lab, brief du matin, page Honest Calls | Recherche : hypothèses nouvelles, backfills Helius, moteur paper, programme prédictif, red team |
| Où ça tourne | GitHub Actions (branche `main`) + cloud Claude | Machine de Muse |
| Écrit sur GitHub | `main` (petits commits vérifiés) | Branches `feat/*` seulement, livrées en bundle |

## Circuit d'échange

1. Muse prépare ses commits sur une branche `feat/<nom>` et les emballe dans un bundle git (`git bundle create`).
2. Hervé télécharge le bundle dans Téléchargements et double-clique `ENVOYER-MUSE-SUR-GITHUB.bat` : la branche arrive sur GitHub.
3. Claude relit la branche : secrets, tests, `tsc`, workflows, taille des données, fichiers existants modifiés. Il écrit un compte rendu dans `docs/cowork/revue-<branche>.md`.
4. Fusion dans `main` seulement avec le « oui » d'Hervé.

Aucun token GitHub n'est confié à un agent. Messages entre agents : ce fichier et `docs/cowork/`.

## Règles communes

- Les tests pré-enregistrés sont gelés jusqu'au verdict du 17 octobre 2026. Ne pas modifier : `docs/preregistration-memecoins.md`, `lab/backtest/preregistered*.ts`, `lab/collect/snipe.ts`, `.github/workflows/`.
- Un résultat se juge seulement à n ≥ 30, sur deux périodes, avec les coûts. Un artefact de données trouvé = le dire tout de suite (bon exemple : l'état figé `85.005359057` de l'audit late-discovery).
- Crédits Helius partagés : annoncer ici tout backfill de plus de 5 000 crédits avant de le lancer.
- Pas de fichier de plus de 5 Mo dans `main`.
- Aucun secret dans le dépôt (il est public).

## État au 28 septembre

- Lab `main` : H1/S1-S3 memecoins, H2 Robinhood, H3/H4 calls Telegram (Mad Apes + 14 canaux), H5 sniping pump.fun (~1 300 tokens suivis par jour, 7 % sans prix). Verdict automatique le 17 octobre à 13 h UTC.
- Muse (branche `feat/deku-cupsey`, 33 commits) :
  - décomposition de l'espérance momentum : NO EVIDENCE OF EDGE (−8,92 % réaliste, n = 242) ;
  - H-CHASE : NO ACTION ; filtre combiné et H-DEVBUY : falsifiés après l'audit late-discovery ;
  - programme prédictif phase 1 : pas de signal prédictif, seulement des filtres de risque (FLOW-01, LIQ-01, TEMP-LEVEL) ;
  - H-DEVSUPPLY / H-BLOCKZERO : DATA_ISSUE (n = 0) ;
  - moteur paper : cycles 1 à 4, tous les tokens éliminés, 0 trade.
- Les deux labs vont dans le même sens : acheter la vitesse ne paie pas, l'évitement des pièges est la seule piste vivante.

## À faire — Muse (avant toute fusion de `feat/deku-cupsey`)

1. `lab/signals/run-earlybuyers.ts` doit encore accepter `HELIUS_API_KEY` (variable d'environnement), sinon le job early-buyers de GitHub Actions s'arrête en silence.
2. Corriger les 45 erreurs `tsc` des nouveaux fichiers (`lab/decision-engine/*`, `run-combined-filter.ts`, `run-momentum-confirm.ts`, `characterize-winners.ts`, `audit-late-discovery.ts`).
3. Sortir de la branche les gros fichiers de `data/flip/` (klines 16 Mo) : les régénérer à la demande.
4. Le holdout `data/track-unbiased/` n'existe que sur ta machine. Publie chaque jour dans `docs/cowork/holdout-empreintes.md` l'empreinte SHA-256 de chaque fichier du holdout. Ainsi le verdict du ~28 octobre sera vérifiable par Claude et Hervé.
5. Le champ `lateDiscovery` devenu obligatoire sur `PumpEvent` : garder une valeur par défaut pour ne pas casser la collecte de `main`.

## À faire — Claude

1. Relire chaque branche livrée par Muse et publier la revue dans `docs/cowork/`.
2. Préparer une fusion partielle et propre de `feat/deku-cupsey` (docs, registre d'hypothèses, résultats) dès qu'Hervé dit oui.
3. Continuer la collecte H1–H5 sans y toucher jusqu'au 17 octobre.
