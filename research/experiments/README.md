# research/experiments/ — Convention des expériences

Chaque expérience = **un fichier** `EXP-YYYY-MM-DD-<slug>.md`.
Un fichier par expérience, jamais de regroupement : l'historique doit être lisible
hypothèse par hypothèse.

## Sections obligatoires

| Section | Contenu |
|---|---|
| `hypothesis_id` | ID du registre (`research/hypotheses.yaml`). Une expérience = une hypothèse. |
| `question` | La question posée, en une phrase, falsifiable. |
| `method` | Protocole : entrées, sorties, coûts, métrique, seuils, critères de décision. |
| `data` | Sources exactes (fichiers, fenêtre, univers). |
| `n` | Taille d'échantillon par groupe/cohorte. `n < 30` = NON CONCLUANT sauf preuve contraire. |
| `leakage_status` | `CLEAN` / `SUSPECT` / `LEAKAGE` — avec la justification. Si `LEAKAGE`, l'expérience ne peut pas promouvoir un signal. |
| `results` | Tableau : métrique, valeur, IC 95 %, n, comparaison. |
| `verdict` | Un seul, parmi : `PROMISING` / `RISK SIGNAL` / `NULL` / `UNSTABLE` / `DATA ISSUE` / `LEAKAGE` / `KILLED`. |

## Mots interdits dans les verdicts

`GOOD`, `BAD`, `BEST`, `WORST` et tout superlatif non quantifié. Un verdict décrit
l'évidence, pas un jugement de valeur. Une expérience peut aussi conclure
`NO EVIDENCE OF EDGE` — c'est un résultat, pas un échec.

## Règles

1. Le protocole (method + critères) est écrit **avant** de voir les résultats.
2. Toute expérience hors batterie pré-enregistrée est **exploratoire** : elle ne peut
   pas promouvoir un signal au statut de validé.
3. `data/track-unbiased/` (holdout gelé) n'est lu qu'**une seule fois** par hypothèse,
   après verrouillage écrit (seuils, horizons, métrique).
4. Les verdicts gelés (`KILLED`, `RISK_ONLY`) des familles momentum/scalp, hedge,
   devBuy et Phase 1 sont **intangibles** : on ne rouvre pas, on ne réoptimise pas.
5. Compteur des comparaisons multiples : chaque nouvelle expérience sur la même
   fenêtre de données incrémente le compteur dans `research/hypotheses.yaml`.
