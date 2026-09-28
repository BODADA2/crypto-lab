# Hypothèses prédictives — LIQUIDITY STRUCTURE (2026-09-28)

**Statut : phase DÉCOUVERTE.** Aucune hypothèse n'est promue en test formel ;
les verdicts ci-dessous résument discovery → calibration → **une seule**
mesure holdout (univers disjoints, protocole `lab/predictive/universe.ts`).
Données `data/history/` biaisées tokens chauds → bornes OPTIMISTES partout.

| ID | Énoncé | Preuve pour | Preuve contre | Verdict |
|---|---|---|---|---|
| H-PRED-LIQ-01 | Un turnover (volume/liquidité) élevé à t0 prédit des rendements futurs négatifs (6h) | Discovery sp=−0.487 (n=178) ; calibration sp=−0.276 (n=106) ; **holdout sp=−0.410 (n=97)** ; décile top médiane −83.7 %, 89 % de pertes <−50 % ; stabilité temporelle et cohortes concordantes (pumpswap −0.32, raydium −0.56, meteora −0.60) ; médiane inchangée sans outliers | Signal plus faible à 1h (sp holdout −0.136) ; le décile « bon » (turnover bas) a une médiane de +1.5 %, pas d'espérance positive | **CONFIRMÉE directionnellement** — filtre d'exclusion, pas un edge long |
| H-PRED-LIQ-02 | Une profondeur absolue (liqT0) élevée à t0 évite les rendements catastrophiques futurs | Discovery sp=+0.408 ; calibration +0.278 ; **holdout 6h sp=+0.271 (n=97)** ; top décile 0–22 % de pertes extrêmes vs 70 % en bottom (médiane −66.8 %) | **1h infirmée au holdout (sp=+0.008 ≈ 0)** ; la médiane du top décile n'est jamais positive (~0 %) | **PARTIELLE** — forme « assurance » à 6h, pas de prédiction de gain ; 1h = bruit |
| H-PRED-LIQ-03 | Un ratio marketCap/liquidité élevé à t0 prédit de meilleurs rendements | Discovery sp=+0.396 (top décile médiane +22.9 %) ; calibration +0.280 (top +24.1 %) ; holdout 6h sp=+0.222, même direction | **1h infirmée (sp=−0.004)** ; amplitude effondrée au holdout 6h (top décile médiane +23 % → −0.0 %) ; corrélée +0.75 à liqT0 (même dimension, pas un signal indépendant) | **MIXTE** — direction 6h plausible, ampleur non fiable ; à retester sur données propres |
| H-PRED-LIQ-04 | Une liquidité qui CROÎT vite avant t0 prédit mieux Y qu'une liquidité haute mais stagnante | Aucune (n=12 en discovery, 34 au total : bruit d'échantillon) | Fenêtre pré-t0 quasi inexistante dans data/history (médiane 0 snapshot) | **INTESTABLE** — question sans réponse ; retester sur data/track-unbiased/ après 30 j de collecte |
| H-PRED-LIQ-05 | Les 4 variables (liqT0, turnoverM5/H1, mcLiq) sont des signaux indépendants | — | Corrélations de Spearman 0.37–0.79 entre elles au holdout (turnoverM5/turnoverH1 : +0.79 ; liqT0/mcLiq : +0.75) | **FALSIFIÉE** — une seule dimension « profondeur relative à l'activité » ; turnoverM5 porte le signal le plus fort |

## Notes de méthode

- Verrouillage (`lab/predictive/liquidity/lock-vars.json`) AVANT toute vue de
  calibration/holdout : |sp| ≥ 0.18 sur 1h et 6h, même signe, stabilité temporelle.
- 24h exclu du verrouillage (n=28 au holdout < 30) — résultats discovery
  rapportés comme exploratoires uniquement.
- liqPerVolH1 exclu comme redondant (inverse exact de turnoverH1).
- Résultat principal avec outliers valides ; ticks aberrants (glitch décimal
  type SKHY) déjà exclus de Y par `aberrantMask`.
