# research/results/ — Convention des résultats

Un résultat = **un fichier** `RES-YYYY-MM-DD-<slug>.json` par mesure.
Un fichier par mesure, jamais de regroupement : chaque ligne d'évidence est traçable
jusqu'à son expérience et son hypothèse.

## Schéma JSON

```json
{
  "result_id": "RES-2026-09-28-exemple",
  "hypothesis_id": "H-XXX (research/hypotheses.yaml)",
  "experiment": "EXP-2026-09-28-exemple (research/experiments/)",
  "date": "2026-09-28",
  "n": 0,
  "effect": 0.0,
  "p_value": null,
  "ci95": [null, null],
  "oos_effect": null,
  "cohort_stability": "stable | unstable | not_tested",
  "time_stability": "stable | unstable | not_tested",
  "leakage_status": "CLEAN | SUSPECT | LEAKAGE",
  "verdict": "PROMISING | RISK SIGNAL | NULL | UNSTABLE | DATA ISSUE | LEAKAGE | KILLED",
  "notes": "texte libre : ce que le résultat change ou ne change pas"
}
```

## Champs

| Champ | Règle |
|---|---|
| `n` | Taille d'échantillon effective. `n < 30` → le verdict ne peut pas être `PROMISING` ni `RISK SIGNAL` (sauf preuve explicite en `notes`). |
| `effect` | Effet mesuré dans l'unité de la métrique (Spearman ρ, Δ espérance, lift…). |
| `p_value` | Null si non calculé — ne jamais inventer. |
| `ci95` | Intervalle de confiance 95 % `[borne_inf, borne_sup]`, null si non calculé. |
| `oos_effect` | Effet sur holdout / univers disjoint. Null = non mesuré. Un `PROMISING` exige un `oos_effect` de même signe. |
| `cohort_stability` / `time_stability` | `stable` seulement si testé explicitement (cohortes, splits temporels). |
| `leakage_status` | `LEAKAGE` → verdict `LEAKAGE`, le résultat ne peut promouvoir aucun signal. |
| `verdict` | Mots interdits : `GOOD`, `BAD`, `BEST`, `WORST` et tout superlatif non quantifié. |

## Règles

1. Un résultat ne contredit jamais un verdict gelé : si la mesure semble contredire
   un `KILLED`/`RISK_ONLY`/`NULL` gelé, c'est la mesure qui est suspecte en premier
   (biais, fuite, snooping) — l'investiguer avant toute autre conclusion.
2. Les mesures sur `data/track-unbiased/` (holdout gelé) sont uniques par hypothèse :
   pas de re-mesure après ajustement.
3. `NO EVIDENCE OF EDGE` est un résultat valide et doit être enregistré comme tel.
