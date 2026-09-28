# Hypothèses prédictives — FLOW STRUCTURE (2026-09-28)

Phase : **DÉCOUVERTE** pour toutes les hypothèses ci-dessous. Aucune n'est un
signal validé. Détail des mesures : `docs/predictive-flows-2026-09-28.md`.
Code : `lab/predictive/flows/`. Rappel : données `data/history/` biaisées vers
les tokens chauds ⇒ bornes OPTIMISTES partout.

---

## H-PRED-FLOW-01 — Frénésie d'activité à t0 ⇒ rendement 1h négatif

- **Énoncé** : le nombre de sells (fenêtre m5) mesuré à t0 — colinéaire à
  l'activité totale (ρ=+0.83 avec buys m5, +0.52 avec volume m5) — prédit
  négativement le rendement à 1h. Interprétation : acheter au moment où
  l'activité (achats comme ventes) est maximale à t0, c'est acheter le sommet
  de la frénésie.
- **Statut** : DÉCOUVERTE — seule hypothèse ayant franchi discovery →
  calibration → **une mesure holdout** :
  - discovery (n=328) : ρ=−0.282, p=2.2e-07, IC95 % [−0.39,−0.16]
    (survit à Bonferroni sur 42 tests) ;
  - calibration (n=185) : ρ=−0.159, p=0.030, IC95 % [−0.30,−0.00] ;
  - holdout (n=182, mesure unique) : **ρ=−0.220, p=0.0029, IC95 % [−0.37,−0.06]**.
  - 6h (sans mesure holdout) : discovery ρ=−0.529 (p=3.4e-14),
    calibration ρ=−0.240 (p=0.013) — même sens.
- **Bémols bloquants avant toute calibration** :
  1. ce n'est pas un effet « sells » spécifique mais un effet **activité**
     (buys m5 ρ=−0.197 et volume m5 ρ=−0.201 racontent la même histoire) ;
  2. cohorte « autres dex » quasi-nulle en discovery (−0.004) — effet
     possiblement concentré sur pumpswap (cohérent en calibration : −0.147/−0.107) ;
  3. monotonie des déciles non répliquée en calibration (D9 : médiane +2.7 %) —
     relation monotone en rang, pas en déciles ;
  4. données chaudes = borne optimiste.
- **Test d'invalidation** : re-test sur la collecte propre 30 jours
  (`data/track-unbiased/`, JAMAIS utilisée pour fitter) — univers disjoints,
  même protocole ; si ρ_holdout_propre ≥ 0 ou IC inclut 0 ⇒ hypothèse rejetée.
  Vérifier aussi la robustesse hors pumpswap (n ≥ 30).

## H-PRED-FLOW-02 — Divergence prix/dominance ⇒ rendement 6h négatif

- **Énoncé** : quand le prix monte sur m5 alors que les sells dominent
  (ou l'inverse) — `divPriceDominance = −sign(priceChgM5)·(dominance−0.5) > 0` —
  le rendement à 6h est plus faible (le mouvement prix non confirmé par le flux
  se retourne).
- **Statut** : DÉCOUVERTE pure — observation discovery uniquement :
  6h : ρ=−0.291, p=8.5e-05, IC95 % [−0.43,−0.13], n=177,
  moitiés temporelles (−0.314/−0.249) et cohortes dex (−0.302/−0.273) cohérentes.
  À 1h : ρ=−0.138 (sous le seuil de verrouillage |ρ|≥0.15) ; à 24h : nul.
  **Non calibrée, jamais mesurée hors discovery.**
- **Test d'invalidation** : calibration sur univers 50–74 (protocole gelé) puis
  une mesure holdout ; rejet si signe non préservé ou p ≥ 0.10 en calibration.

## H-PRED-FLOW-03 — Réversion du pump m5 (contrôle prix)

- **Énoncé** : `priceChange.m5` à t0 prédit négativement Y (réversion à court
  terme du mouvement des 5 dernières minutes) : 1h ρ=−0.198 (p=3.0e-04,
  moitiés −0.197/−0.199, dex −0.213/−0.135 — la plus stable par cohorte),
  6h ρ=−0.251, 24h ρ=−0.415 (n=46, indicatif).
- **Statut** : DÉCOUVERTE — **non verrouillée** (échec au critère décile
  top−bottom en discovery). Variable de contrôle, pas une variable de flux.
- **Test d'invalidation** : même protocole que H-PRED-FLOW-02 ; surveiller la
  colinéarité avec l'activité (ρ=+0.27–0.33 avec sells/buys/volume m5).

## H-PRED-FLOW-04 — Structure relative acheteuse ⇒ Y positif

- **Énoncé** : ratio buys/sells (m5 : ρ=+0.206 ; h1 : ρ=+0.230) et dominance
  acheteuse (ρ=+0.213) à t0 prédisent positivement Y 1h — la structure
  *relative* compte en sens inverse de l'activité *absolue*.
- **Statut** : DÉCOUVERTE — **non verrouillées** : signe instable dans la
  cohorte « autres dex » en discovery (−0.027 à −0.069), calibration affaiblie
  (ρ ≈ +0.08–0.10). ratio m5 et dominance m5 sont redondantes (ρ=1.00).
- **Test d'invalidation** : calibration gelée ; rejet si la cohorte non-pumpswap
  (n ≥ 30) ne préserve pas le signe.

---

## Hypothèses écartées ou non testables (DÉCOUVERTE)

| Hypothèse | Verdict discovery |
|---|---|
| Accélération des buys (m5 vs h1) | Nulle (ρ=−0.047, p=0.39 à 1h) — le rythme relatif des buys ne prédit rien. ÉCARTÉE. |
| Inflexion structure m5 vs h1 | Nulle (p > 0.08). ÉCARTÉE. |
| Divergence prix / accélération | Nulle partout (p > 0.2). ÉCARTÉE. |
| Flux net m5 (buys−sells) | Nul à 1h (ρ=+0.011) — le niveau absolu compte, pas la différence brute. ÉCARTÉ. |
| Taille moyenne implicite / trade | Nulle (p≈0.10, signe instable) — proxy trop bruité sans tailles individuelles. ÉCARTÉE (re-tester quand les tailles par trade seront collectées). |
| Changement de structure pré-t0 | **Non testable** : n=38 (87 % des mints sans snapshot pré-t0). PARKÉE — re-tester sur séries plus longues. |

---

## Règle de promotion

Aucune hypothèse ne passe en CALIBRATION sur la base de ce document sans :
univers disjoints frais (ou la collecte propre 30 jours), critères de
verrouillage écrits AVANT la mesure, et une seule mesure holdout. Le holdout
`data/track-unbiased/` reste gelé jusqu'au re-test de H-PRED-FLOW-01.
