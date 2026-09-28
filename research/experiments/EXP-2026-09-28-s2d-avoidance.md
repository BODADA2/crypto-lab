# EXP-2026-09-28-s2d-avoidance — SPRINT 2D, Famille A : valeur ÉCONOMIQUE des filtres d'évitement

**Règle :** `AVOID-S2D-v1` (gelée le 2026-09-28 AVANT mesure — `lab/research-sprint2/avoidance/rule.ts`).
**Données :** `data/history/` — univers **DISCOVERY uniquement** (hash mint < 50) ; holdout JAMAIS lu ; calibration non utilisée ; SKHY exclu.
**Résultats machine :** `research/results/res-s2d-avoidance.json`.
**Code :** `lab/research-sprint2/avoidance/` (`rule.ts`, `metrics.ts`, `run.ts`, tests vitest 26/26 verts).

## Règle pré-enregistrée (avant toute mesure)

| Filtre | Variable à t0 | Règle | Sensibilité (3 pts) | Hypothèse d'origine |
|---|---|---|---|---|
| F_FRENZY | sellsM5 | AVOID si ≥ P75 | P70 / **P75** / P80 | H-PRED-FLOW-01 (ρ=−0,220 OOS @1h) |
| F_TURNOVER | turnoverM5 = volM5/liqT0 | AVOID si ≥ P90 | P85 / **P90** / P95 | H-PRED-LIQ-01 (sp=−0,410 OOS @6h) |
| F_LIQT0 | liqT0 | AVOID si < P25 | P30 / **P25** / P20 | H-S1-E1 (HR=0,691/doublement) |
| COMBINED | — | AVOID si ≥1 filtre (OU) | combinaisons bas/principal/haut | valeur d'évitement globale |

Percentiles **intra-discovery** (interpolation linéaire type 7). Seuils au point principal :
sellsM5 ≥ **699**, turnoverM5 ≥ **3,81**, liqT0 < **27 948 $**.

**Métriques** (baseline « tout prendre » vs « éviter les flagged », proxy Y@1h/Y@6h) :
LOSS_AVOIDED = médiane(keep) − médiane(all) · TAIL_LOSS_AVOIDED = P10(keep) − P10(all) ·
DD_AVOIDED = médiane ddMax24h(keep) − médiane ddMax24h(all) ·
**coût du filtre** = % de gagnants (Y>0) et de runners (Y≥+100 %) filtrés par erreur.
Test : Mann-Whitney flagged vs kept (bilatéral). IC95 % bootstrap de la perte médiane évitée.

**Verdicts mécaniques pré-enregistrés :** n<30 → NON_CONCLUSIF ; signe instable sur 3 pts → UNSTABLE ;
p≥0,05 ou effet ≤0 → NULL ; significatif mais concentré (cohortes/temps) → NEAR_MISS ; sinon → RISK_ONLY.

## Tableau de triage (point principal, discovery, borne OPTIMISTE)

| Scope | Hor | n | % évités | Perte méd. évitée | P10 évitée | DD évité | Gagnants filtrés (coût) | p (MW) | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| F_FRENZY | 1h | 327 | 21,1 % | **+0,94 pt** | +0,91 pt | +6,15 pts | 20/156 (**12,8 %**) ; runners 15/35 (42,9 %) | 0,0006 | **NEAR_MISS** |
| F_FRENZY | 6h | 177 | 14,7 % | **+1,79 pt** | +1,66 pt | +16,33 pts | 3/75 (4,0 %) ; runners 2/8 (25 %) | <0,0001 | **NEAR_MISS** |
| F_TURNOVER | 1h | 327 | 8,6 % | **+0,71 pt** | −0,06 pt | +0,42 pt | 4/156 (**2,6 %**) ; runners 3/35 (8,6 %) | 0,0008 | **NEAR_MISS** |
| F_TURNOVER | 6h | 177 | 7,9 % | **+1,29 pt** | −0,40 pt | +4,19 pts | 2/75 (**2,7 %**) ; runners 1/8 (12,5 %) | 0,0079 | **NEAR_MISS** |
| F_LIQT0 | 1h | 327 | 22,6 % | +1,21 pt | −0,38 pt | −2,90 pts | 19/156 (12,2 %) | 0,1645 | **NULL** |
| F_LIQT0 | 6h | 177 | 24,3 % | **+1,88 pt** | −1,34 pt | +1,48 pt | 11/75 (14,7 %) ; runners 2/8 (25 %) | 0,0203 | **RISK_ONLY** ⚠️ |
| COMBINED | 1h | 327 | 42,2 % | **+3,34 pts** | +0,36 pt | −1,70 pt | 38/156 (**24,4 %**) ; runners 21/35 (**60 %**) | 0,0001 | **RISK_ONLY** |
| COMBINED | 6h | 177 | 36,2 % | **+6,45 pts** | −0,40 pt | **+24,60 pts** | 13/75 (**17,3 %**) ; runners 4/8 (**50 %**) | <0,0001 | **RISK_ONLY** |

⚠️ F_LIQT0 @6h : verdict mécanique RISK_ONLY mais **la queue (P10) se dégrade** (−1,34 pt) — le filtre aide la médiane, pas la queue.

## Expériences

### EXP-A — F_FRENZY seul (éviter la frénésie)
- **HYPOTHESIS :** H-PRED-FLOW-01 — les tokens en frénésie d'activité à t0 (sellsM5 ≥ P75) sous-performent ; les éviter réduit les pertes médianes.
- **N :** 327 (@1h), 177 (@6h). **EFFECT :** +0,94 pt @1h (médianes : all −0,67 % → keep +0,28 % ; flagged −81,19 %) ; +1,79 pt @6h (all −2,03 % → keep −0,25 % ; flagged −92,46 %).
- **P-VALUE :** 0,0006 @1h ; <0,0001 @6h (Mann-Whitney flagged vs kept). **CI :** [0,25 ; 16,48] pts @1h ; [0,29 ; 22,73] pts @6h.
- **OOS :** « holdout gelé » — NON MESURÉ (jamais lu). Re-test requis sur collecte propre 30 j.
- **COHORT STABILITY :** effet concentré sur **pumpswap** (+5,19 pts @1h, n=270) ; raydium ≈ 0 (−0,30 pt, n=42), « autre » = 0 (n=15). @6h : pumpswap +17,23 pts (n=134), raydium −0,16 pt (n=32).
- **TIME STABILITY :** direction concordante les deux moitiés (@1h : +5,01 / +0,73 pt ; @6h : +0,29 / +24,03 pts) — effet plus fort en 2e moitié.
- **LEAKAGE STATUS :** OK — sellsM5 lu sur le snapshot t0 (fenêtre m5 pré-t0) ; Y futurs nettoyés ; seuils intra-discovery ; SKHY exclu ; holdout jamais ouvert.
- **VERDICT : NEAR_MISS** — condition trouvée : **le filtre ne vaut que sur pumpswap** (launches frais pump.fun) ; nul sur raydium (n petit — possible manque de puissance, à re-tester). Coût élevé : **42,9 % des runners @1h filtrés par erreur**.

### EXP-B — F_TURNOVER seul (éviter le churn extrême)
- **HYPOTHESIS :** H-PRED-LIQ-01 — turnoverM5 ≥ P90 à t0 ⇒ Y négatifs ; l'éviter réduit les pertes.
- **N :** 327 (@1h), 177 (@6h). **EFFECT :** +0,71 pt @1h (flagged médiane −90,11 %) ; +1,29 pt @6h (flagged −90,52 %).
- **P-VALUE :** 0,0008 @1h ; 0,0079 @6h. **CI :** [0,14 ; 14,67] pts @1h ; [0,03 ; 19,73] pts @6h.
- **OOS :** « holdout gelé » — NON MESURÉ.
- **COHORT STABILITY :** pumpswap seul (+4,53 pts @1h / +11,63 pts @6h) ; raydium ≈ 0 ; autre = 0.
- **TIME STABILITY :** concordant (@1h : +4,61 / +0,72 ; @6h : +0,05 / +20,96).
- **LEAKAGE STATUS :** OK (idem EXP-A ; turnoverM5 = volM5/liqT0 au snapshot t0).
- **VERDICT : NEAR_MISS** — même condition venue : **pumpswap uniquement**. Filtre le moins cher : **2,6–2,7 % de gagnants filtrés par erreur**, 8,6–12,5 % des runners. Note : significatif aussi @1h alors que l'hypothèse était verrouillée @6h — convergence inter-horizons, pas une prédiction.

### EXP-C — F_LIQT0 seul (éviter la liquidité faible)
- **HYPOTHESIS :** H-S1-E1 — liqT0 < P25 ⇒ mauvaise survie ; l'éviter réduit pertes et drawdown.
- **N :** 327 (@1h), 177 (@6h). **EFFECT :** +1,21 pt @1h (p=0,16, NS) ; +1,88 pt @6h (p=0,0203).
- **P-VALUE :** 0,1645 @1h → **NULL** ; 0,0203 @6h. **CI @6h :** [0,23 ; 24,24] pts.
- **OOS :** « holdout gelé » — NON MESURÉ.
- **COHORT STABILITY @6h :** direction concordante (pumpswap +19,40 ; raydium +3,97 ; autre −0,13, n=11).
- **TIME STABILITY @6h :** concordant (+4,66 / +20,96).
- **LEAKAGE STATUS :** OK.
- **VERDICT : NULL @1h ; RISK_ONLY @6h avec réserve** — la médiane s'améliore mais **la queue P10 se dégrade (−1,34 pt)** et le DD à peine (+1,48 pt) : ce filtre déplace la masse centrale, il ne protège pas des catastrophes. Coût : 14,7 % des gagnants @6h filtrés par erreur.

### EXP-D — Règle combinée (OU des 3 filtres)
- **HYPOTHESIS :** la règle AVOID-S2D-v1 combinée a une valeur d'évitement globale supérieure à chaque filtre seul.
- **N :** 327 (@1h), 177 (@6h). **EFFECT :** **+3,34 pts @1h** (all −0,67 % → keep +2,67 % ; flagged −55,36 %) ; **+6,45 pts @6h** (all −2,03 % → keep +4,42 % ; flagged −73,14 %).
- **P-VALUE :** 0,0001 @1h ; <0,0001 @6h. **CI :** [1,86 ; 19,72] pts @1h ; [1,15 ; 30,55] pts @6h.
- **OOS :** « holdout gelé » — NON MESURÉ.
- **COHORT STABILITY :** concordant sur les 3 venues (pumpswap +8,38/+25,48 ; raydium +0,55/+3,60 ; autre 0/−0,13) — la combinaison lisse la condition venue des filtres seuls.
- **TIME STABILITY :** concordant les deux moitiés, effet croissant en 2e moitié.
- **LEAKAGE STATUS :** OK.
- **VERDICT : RISK_ONLY** — c'est le meilleur éviteur du sprint, mais le prix est brutal : **24,4 % des gagnants @1h et 17,3 % @6h filtrés par erreur ; 60 % des runners @1h et 50 % @6h perdus**. La règle achète de la sécurité médiane en sacrifiant l'asymétrie positive — exactement l'inverse d'un edge long.

## Sensibilité (3 points, pas d'optimisation fine)

Signe de la perte médiane évitée **stable sur les 3 points pour les 8 scopes** (aucun UNSTABLE).
Tendance monotone attendue : seuil agressif → plus de tokens évités + effet médian plus fort
(ex. COMBINED @6h : bas 39,0 % évités / +9,86 pts → haut 27,1 % / +2,17 pts).
F_TURNOVER @6h point haut (P95) : 2,3 % évités seulement — test MW impossible (n<8), effet toujours positif.

## Limites (à lire avant toute utilisation)

1. **Borne OPTIMISTE** : `data/history/` biaisée vers les tokens chauds (déclaré dans le protocole).
2. **OOS non mesuré** : holdout gelé, jamais lu — ces verdicts restent de la DÉCOUVERTE.
3. **Séries courtes** : n=327 @1h, n=177 @6h (couverture 24h quasi nulle → ddMax24h partiel).
4. **NEAR_MISS venue** : F_FRENZY et F_TURNOVER ne valent que sur pumpswap — possiblement un artefact de puissance (raydium n=32–42).
5. **Le coût en gagnants** est le chiffre qui tue l'usage « stratégie » : ces filtres sont des **exclusions**, jamais des signaux long.

## Prochaines étapes

- Re-test OBLIGATOIRE sur `data/track-unbiased/` après 30 j de collecte (holdout propre), en particulier la condition venue pumpswap vs raydium.
- Si confirmé : intégrer la règle combinée comme **garde-fou d'exclusion** (pas comme signal d'entrée) dans le paper-engine, avec suivi du taux de faux positifs en continu.
- Ne PAS baisser les seuils pour « attraper plus » sans n≥30 : le coût en runners croît plus vite que le gain médian.
