# Fiche de recherche — @hellojrus : la blocklist de devs (TikTok)

**Source :** vidéo TikTok `@hellojrus`, partagée par Hervé le 28 sept. 2026 (~50 s).
**Sujet :** ne plus se faire rug en blacklistant les wallets de devs.

## L'astuce de la vidéo
- Sur Axiom et Trojan (« the scope », le feed des nouveaux tokens), il existe une fonction
  **« hide tokens / blacklist wallets »**.
- Quand un chart est un rug : survoler le token → cliquer **« blacklist dev »**.
- Effet : plus aucun token déployé par ce wallet dev n'apparaît dans le scope.
- Justification : beaucoup de wallets devs déploient des rugs **en série sur le même wallet**.
- Règle dure assumée : on blackliste même si c'est le seul rug connu de ce wallet.
- Public visé : ceux qui ne savent pas identifier un rug chart — le filtre remplace le jugement.

## Hypothèse labo : H-BLOCK (face négative de H-DEV)
- H-DEV (Deku) = face positive : registre des devs dont les launches graduent.
- H-BLOCK = face négative : registre d'exclusion des devs qui rug.
- Les deux faces forment un seul registre dev à double entrée : allowlist / blocklist.
- Implémentation : fonctions pures (`isBlocklisted`, `blockDev`) + persistance locale
  (wallet → { motif, date, nombre de rugs observés }).

## Nuances honnêtes
- **Faux positifs possibles** : wallet compromis, dev qui « se rachète » avec un vrai projet.
  La règle dure de la vidéo maximise la protection, pas la précision.
- **À mesurer en backtest (n ≥ 30)** : rugs évités vs runners filtrés par erreur.
  Le backtest tranche entre bannissement dur et simple pénalité de score.
- **Limite de données** : avec les seuls événements `create` des scans (pas d'historique
  de prix), la détection automatique d'un rug est limitée. Le module doit exister avec
  ses tests, se remplir manuellement ou semi-auto, et documenter ce manque —
  sans inventer de détections.

## Lien avec les autres hypothèses
- Renforce H-BUNDLE : les devs qui bundlent en série sont exactement la population
  que la blocklist doit attraper.
- C'est la pièce « risque » qui manque aux 3 interviewés : eux gèrent le risque au
  feeling ; la blocklist le systématise (cf. note « ce qu'il manque à ces mecs »).
