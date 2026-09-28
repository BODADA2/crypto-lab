# EXP-2026-09-28-e1-survival — Survival baseline (famille F)

- **hypothesis_id** : H-S1-E1
- **question** : Existe-t-il une baseline de survie pré-t0 ? Le niveau de liquidité à t0 prédit-il la survie (pas de passage sous −50 % dans les 24 h post-t0) ?
- **method** :
  1. Kaplan-Meier global sur survival_50_24h (durée = heures jusqu'au premier tick post-t0 non-aberrant à ≤ −50 % du prix t0 ; censure au min(24 h, dernier tick) ; ≥ 3 ticks post-t0 exigés, même garde que `labels.ts`).
  2. Déciles de log2(liqT0) → S(24 h) par décile (descriptif).
  3. « Log-rank approximatif » : Cox PH univarié, X = log2(liqT0) → HR par doublement de liquidité, p de Wald.
  4. Stabilité : cohortes dex (pumpswap / raydium / autres) + moitiés temporelles (split au 2026-09-26).
- **data** : `data/history/*.jsonl` (2926 séries, 2026-09-24 → 2026-09-28), lecture seule ; mint SKHY (glitch DexScreener) exclu. **Biais déclaré : tokens chauds → borne OPTIMISTE.**
- **n** : 452 tokens discovery avec info de survie fiable (349 événements, 103 censurés).
- **leakage_status** : **PASS** — features (liqT0, dexId, jour t0) mesurées à t0 (≤ t0ms) ; labels de survie sur ticks post-t0 avec `aberrantMask` ; censure standard ; AUCUNE lecture du holdout (hash ≥ 75 jamais touché).
- **results** :
  - Kaplan-Meier global : **S(24 h) = 0,137** ; survie médiane **1,47 h** ; 77,2 % des tokens passent sous −50 % en 24 h.
  - Cox univarié log2(liqT0) : **HR = 0,691 par doublement de liquidité**, IC95 % [0,640 ; 0,746], **p ≈ 3×10⁻²¹** (le `pWald: 0` du JSON est un underflow de l'approximation erf ; valeur dérivée de l'IC : z ≈ −9,5). Converged, n = 452.
  - Déciles log2(liqT0) — S(24 h) : D1 0,228 · D2 0,040 · D3 0,035 · D4 0,000 · D5 0,070 · D6 0,029 · D7 0,044 · D8 0,109 · D9 0,237 · **D10 0,584**. Relation monotone en rang (Cox) mais **non monotone en déciles** (anomalie D1 ; D10 nettement au-dessus).
  - Stabilité cohortes : pumpswap (n=389) HR 0,715 p=8,4×10⁻¹⁵ ; raydium (n=47) HR 0,523 p=3,1×10⁻⁴ — même direction, deux dex. « other » n=16 < 30 → non conclusif.
  - Stabilité temporelle : 1re moitié (n=244) HR 0,696 p=9,4×10⁻¹² ; 2e moitié (n=208) HR 0,671 p=2,9×10⁻¹¹ — stable.
- **verdict** : **PROMISING** — baseline de survie mesurable et fortement prédite par la liquidité à t0, stable across cohortes et temps. **Nature : RISK FILTER** (prédit la survie / les pertes), pas un edge long — cohérent avec H-PRED-LIQ-02 (forme « assurance »).

## Fiche triage

- **HYPOTHESIS** : H-S1-E1 — la liquidité à t0 prédit la survie à 24 h (survival_50_24h).
- **N** : 452 (discovery ; 349 événements).
- **EFFECT** : HR = 0,691 par doublement de liqT0 (S(24 h) global = 0,137 ; médiane 1,47 h).
- **P-VALUE** : ≈ 3×10⁻²¹ (Wald, Cox univarié convergé).
- **CI** : IC95 % HR [0,640 ; 0,746].
- **OOS EFFECT** : non mesuré — holdout gelé.
- **COHORT STABILITY** : stable — pumpswap HR 0,715 (p=8,4×10⁻¹⁵), raydium HR 0,523 (p=3,1×10⁻⁴) ; other n=16 non conclusif.
- **TIME STABILITY** : stable — HR 0,696 puis 0,671, p < 10⁻¹⁰ dans les deux moitiés.
- **COST SENSITIVITY** : non évaluée (aucune stratégie construite).
- **LEAKAGE STATUS** : PASS — features ≤ t0ms, labels post-t0 nettoyés, holdout jamais lu. Biais « tokens chauds » = borne optimiste déclarée.
- **VERDICT** : **PROMISING** (candidat RISK FILTER, pas un edge long).

## Suivi suggéré

- Re-test sur `data/track-unbiased/` après 30 j de collecte propre (même protocole, univers disjoints).
- Creuser l'anomalie D1 (survie 0,228 vs D2–D8 < 0,11) : artefact ou structure réelle ?
- Combiner avec turnover (H-PRED-LIQ-01) dans un score de danger multivarié — seulement après le re-test propre.
