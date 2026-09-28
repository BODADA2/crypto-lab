# EXP-2026-09-28-s2b-changepoint — Famille N (CHANGE POINT) : la rupture d'état contient-elle l'information ?

- **hypothesis_id** : H-S2B-N1
- **question** : Une rupture d'état détectée sur les premières observations (CUSUM / rupture de moyenne sur prix, pur TypeScript) prédit-elle la distribution future (Y@6h, ddMax24h, survie_50_24h) ?
- **method** :
  1. Détecteur `detectMeanShift` : scan des splits k ∈ [2, m−2] sur log-prix, d_k = mean(x[k:]) − mean(x[:k]) ; événement si max|d_k| ≥ seuil (primaire 0,35 log ≈ 42 %).
  2. Fenêtre de détection (t0, t0+W] ; m ≥ 5 ticks exigés (sinon non testable). W primaire = 2h (W=1h : 0/1445 testables — DATA_ISSUE pour « les premières minutes » littérales), robustesse W=3h, seuils {0,25 ; 0,35 ; 0,50}.
  3. Labels **depuis D = t0+W** (rupture connue à D) : Y@6h depuis D, ddMax depuis D sur 24h, survie_50 depuis D sur 24h (≥3 ticks). Ticks aberrants masqués.
  4. Event vs no-event : diff de médianes + IC95% bootstrap + p de permutation (2000 réps) ; taux de survie + p perm ; second-order |magnitude|~|Y@6h| (Spearman).
  5. Adversarial : horse race vs amplitude |log(p_D/p_t0)| et volatilité réalisée ; signe des ruptures (up vs down) ; winsorisation |Y|≤10 ; cohortes dex ; moitiés temporelles.
- **data** : `data/history/*.jsonl`, lecture seule ; discovery uniquement ; SKHY exclu. **Biais déclaré : tokens chauds → borne OPTIMISTE.**
- **n** : 238 testables (W=2h), 113 événements (47,5 %) ; Y@6h n=136 (48 ev / 88 no-ev) ; survie n=174.
- **leakage_status** : **PASS** — rupture déterminée à D ; tous les labels mesurés depuis D (aucun chevauchement détection/label) ; aberrantMask ; AUCUNE lecture du holdout.
- **results** :
  - **Y@6h depuis D : médiane event −0,41 vs no-event +0,01 ; diff −0,42, IC95% [−0,58 ; −0,28], pPerm ≈ 0,0005.** Stable sur seuils 0,25 (−0,43) / 0,35 (−0,42) / 0,50 (−0,40) et W=3h (−0,36/−0,38, pPerm=0,0005).
  - ddMax24h : −0,66 vs −0,36, diff −0,30, pPerm=0,06 (marginal) ; W=3h pPerm=0,01–0,02.
  - Survie_50 : 0,67 vs 0,46, diff +0,21, pPerm=0,012 — **mais instable** : early +0,44 (p=0,004) vs late +0,10 (p=0,34) ; pump +0,07 (p=0,44) vs rest +0,49 (p=0,0035) → non retenu.
  - **Stabilité du Y@6h** : pump diff −0,56 (p=0,0015), rest −0,10 (même direction, n=51) ; early −0,46 / late −0,44 (p=0,0005 les deux).
  - Second-order : |magnitude| ~ |Y@6h| : ρ=+0,44 (n=136) — les grosses ruptures annoncent de gros mouvements ultérieurs (la volatilité prédit la volatilité).
  - **Horse race (adversarial)** : amplitude |log(p_D/p_t0)| seule ~ Y@6h : ρ=−0,370 ; volatilité réalisée de la fenêtre ~ Y@6h : ρ=−0,474 ; terciles d'amplitude : bottom médiane Y@6h +0,002 vs top −0,431. **Le détecteur de rupture n'apporte pas d'information au-delà de l'amplitude/volatilité précoce** — c'est un proxy de volatilité, pas un signal de rupture spécifique.
  - Signe des ruptures : up (n=12) médiane Y@6h −0,415 ; down (n=36) −0,337 — la direction ne discrimine pas, seule l'agitation compte.
  - Winsorisation |Y|≤10 : diff inchangée (−0,4217, p=0,0005) — pas un artefact d'outliers.
- **verdict** : **PROMISING** — **candidat RISK FILTER** (l'agitation précoce prédit la dérive négative à 6h), pas un edge long. Réponse à la question : **oui, le changement d'état contient l'information, mais c'est de l'information de volatilité** — une feature d'amplitude simple fait aussi bien ou mieux. Effet survie : UNSTABLE, écarté.
- **second-order** : cohérent avec H-PRED-FLOW-01 (frénésie → pertes) et H-PRED-LIQ-01 (turnover → pertes) : un seul phénomène (l'agitation précoce prédit les pertes), troisième mesure indépendante.
- **contrefactuel** : si la rupture n'était qu'un proxy sans info, la permutation des labels donnerait p ~ 0,5 ; observé p≈0,0005 sur 6 configs → l'information est réelle, sa *spécificité* « rupture » ne l'est pas (horse race).

## Fiche triage

- **HYPOTHESIS** : H-S2B-N1 — une rupture de moyenne précoce (2h) prédit les rendements futurs.
- **N** : 238 testables discovery (113 événements ; Y@6h n=136).
- **EFFECT** : Y@6h médian −0,41 (event) vs +0,01 (no-event), diff −0,42.
- **P-VALUE** : pPerm ≈ 0,0005 (2000 réps), 6/6 configs seuil×fenêtre.
- **CI** : IC95% bootstrap de la diff [−0,58 ; −0,28].
- **OOS EFFECT** : non mesuré — holdout gelé.
- **COHORT STABILITY** : stable en direction — pump −0,56 (p=0,0015), rest −0,10 (n=51) ; early −0,46 / late −0,44 (p=0,0005).
- **TIME STABILITY** : stable (Y@6h) ; survie instable (écartée).
- **LEAKAGE STATUS** : PASS — détection à D, labels depuis D, holdout jamais lu. Borne optimiste (tokens chauds).
- **VERDICT** : **PROMISING** (RISK FILTER ; redondant avec l'amplitude — préférer la feature simple).

## Suivi suggéré

- Re-test sur `data/track-unbiased/` après 30 j : « amplitude 2h » (feature simple) vs détecteur de rupture — ne garder que la plus simple si équivalentes.
- Combiner avec turnover (H-PRED-LIQ-01) et frénésie (H-PRED-FLOW-01) dans un score de danger — après re-test propre uniquement.
- Ne pas construire de détecteur CUSUM plus sophistiqué : le horse race montre que la sophistication n'apporte rien ici.
