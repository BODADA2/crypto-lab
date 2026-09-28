# FLIP ENGINE — Spec Branch B (SOL-PERP event-driven microstructure)

Date : 2026-09-28 · Sprint 0 · Statut : SPEC — aucun test prédictif, aucun modèle, aucune transaction.
Branche : `feat/deku-cupsey` · Dossier code : `lab/flip/` · Données : `data/flip/`
Règles absolues : AUCUN push, AUCUNE transaction réelle, AUCUN secret, AUCUNE écriture via clé lecture seule.
Branch A (memecoin) intouchable : `lab/predictive/`, `lab/research-sprint1/`, `lab/research-sprint2/`,
`data/earlybuyers/`, `data/history/`, `data/scans/` — ni lecture opportuniste, ni écriture.

## 1. Mission

Chasser une asymétrie sur **SOL-PERP** via **EVENT-DRIVEN MICROSTRUCTURE** — jamais blind momentum,
jamais breakout, jamais high leverage. Séquence : détecter un événement de dislocation
(cascade de liquidations, funding extrême, spike/collapse d'OI, choc de basis spot/perp,
divergence prix/OI, retrait de liquidité) → fenêtre d'observation courte → confirmation/invalidation
→ distribution future (mean-revert, continuation ou accélération — **à distinguer, jamais présumer**).

Hypothèse centrale : les épisodes de déséquilibre du perp créent des dislocations détectables
avant résolution. Le levier ne crée pas d'edge : toute recherche se fait en **notionnel 1x** d'abord (§85).

## 2. Architecture

```
EVENT_DETECTION → OBSERVATION → CONFIRMATION → DISTRIBUTION
       │               │              │              │
       v               v              v              v
  12 événements   fenêtre 1s–60min  règles         Y@t (rendements,
  §66 (section 4) (H-FLIP-08)      invalidation    drawdowns, survie)
                                   explicites      par régime
```

- **EVENT_DETECTION** : fonctions pures sur séries point-in-time (prix, volume, taker imbalance, OI, funding, premium). Aucun lookahead : chaque feature à t n'utilise que ≤ t.
- **OBSERVATION** : après détection, fenêtre courte (1s à 60min, cf. H-FLIP-08) pendant laquelle on mesure sans agir — coût du délai vs gain d'information.
- **CONFIRMATION** : l'événement est confirmé si le critère d'absorption/invalidation est atteint (ex. imbalance contraire, retour basis) ; sinon invalidé. Jamais d'entrée sur événement non confirmé en phase de test.
- **DISTRIBUTION** : rendements forward à 15m/1h/6h/24h + drawdown max + probabilité de second événement, conditionnés par événement × régime. Les distributions sont estimées sur discovery, calibrées sur calibration, **jugées uniquement sur holdout**.

## 3. State machine

```
NORMAL → PRESSURE → DISLOCATION → LIQUIDATION → ABSORPTION → RESOLUTION
   ↑_________|__________|_____________|_____________|             |
             └────────────────── FAILURE ←───────────────────────┘
```

| État | Définition opérationnelle (paramètres INITIAUX, non validés) |
|---|---|
| NORMAL | funding ∈ [P25,P75] (7j glissants), ΔOI 1h ∈ [P25,P75], \|premium\| < P75 |
| PRESSURE | funding ≥ P99 ou ≤ P1, ou ΔOI 1h ≥ P99 (E3/E4/E5), ou divergence E8/E9 — le positionnement se tend |
| DISLOCATION | choc de basis E7, ou prix ±P90 avec OI convergent E10/E11 — le prix se disloque du positionnement |
| LIQUIDATION | cascade E1/E2 en cours (rendement 5m ≤ P1 + imbalance vendeur + volume ≥ P90) |
| ABSORPTION | après E1/E2 : imbalance acheteur ≥ P90 dans les 15 min (E12) — contre-flux absorbe |
| RESOLUTION | retour aux bornes NORMAL dans les 4h suivant l'événement |
| FAILURE | nouvelle cascade E1/E2 avant RESOLUTION, ou régime STRESS — la chaîne est invalidée |

Transitions mesurées empiriquement (matrice de transition Sprint 1) ; pour Sprint 0 on ne fait que
compter les événements et leurs durées.

## 4. Les 12 événements §66 — définitions opérationnelles

Conventions : Pxx = percentile sur fenêtre glissante 7j (paramètre initial) ; ΔOI sur `sum_open_interest`
(metrics 30m, forward-fill sur grille horaire) ; taker imbalance = `taker_buy_volume / volume` (klines 1m) ;
premium = premium index 1h (proxy basis) ; funding = Hyperliquid `fundingHistory` horaire.
Tous les seuils sont des **guesses initiales** — tuning éventuel sur discovery uniquement, jamais sur holdout.

| # | Événement | Définition opérationnelle |
|---|---|---|
| E1 | LIQ_CASCADE_DOWN | rendement 5m ≤ P1 **et** taker_buy_ratio 5m ≤ P10 **et** volume 5m ≥ P90 |
| E2 | LIQ_CASCADE_UP | rendement 5m ≥ P99 **et** taker_buy_ratio 5m ≥ P90 **et** volume 5m ≥ P90 |
| E3 | FUNDING_EXTREME_POS | funding horaire ≥ P99 (7j) **ET** funding ≥ 1e-4 absolu (10 bp/h ≈ 88 % APR ; plancher anti-artefact — cf. DATA ISSUE ci-dessous) |
| E4 | FUNDING_EXTREME_NEG | funding horaire ≤ P1 (7j) **ET** funding ≤ −1e-4 absolu |
| E5 | OI_EXPANSION | ΔOI 1h ≥ P99 |
| E6 | OI_COLLAPSE | ΔOI 1h ≤ P1 |
| E7 | BASIS_SHOCK | \|premium index\| 1h ≥ P99 |
| E8 | DIV_PX_UP_OI_DOWN | rendement 1h ≥ P90 **et** ΔOI 1h ≤ P10 |
| E9 | DIV_PX_DOWN_OI_UP | rendement 1h ≤ P10 **et** ΔOI 1h ≥ P90 |
| E10 | CONV_PX_UP_OI_UP | rendement 1h ≥ P90 **et** ΔOI 1h ≥ P90 |
| E11 | CONV_PX_DOWN_OI_DOWN | rendement 1h ≤ P10 **et** ΔOI 1h ≤ P10 |
| E12 | ABSORPTION | dans les 15 min après E1/E2 : taker_buy_ratio 5m > P90 (après E1) ou < P10 (après E2), **percentiles calculés sur la fenêtre pré-événement uniquement** (la barre de cascade ne doit pas contaminer le seuil — un simple retour à la normale ne compte pas comme absorption) |

Notes d'honnêteté :
- **DATA ISSUE (trouvée Sprint 0, corrigée dans la définition)** : le funding HL de SOL est quasi-constant
  par paliers (426/720 heures à exactement 0,0000125). Un seuil en percentile relatif seul générait
  296 faux « E3 » (le mode = le max de la fenêtre → rang 100). D'où la double condition percentile +
  plancher absolu. Sur 30j : funding ∈ [−2,9e-05 ; +3,3e-05] — **aucun extrême absolu**, E3=E4=0.
  H-FLIP-02 n'est pas testable sur cette fenêtre (n<30) ; l'historique funding HL remonte à 2023-05
  (pagination 500/req) → échantillon plus long requis.
- E1/E2 sont des **proxies** de cascades de liquidations : les prints de liquidation historiques ne sont
  accessibles sur aucune venue publique testée (Binance `forceOrders` requiert une clé ; `liquidationSnapshot`
  absent de data.vision ; Hyperliquid n'expose pas d'historique de liquidations). Le proxy
  (chute rapide + imbalance vendeur + volume) peut confondre cascade de liquidations et vente spot agressive —
  H-FLIP-10 (lead-lag inter-venues) aidera à séparer.
- E7 utilise le premium index comme proxy du basis spot/perp (funding = clamp du premium) — proxy, pas basis réel.
- Retrait de liquidité (profondeur de carnet historique) : **INCONNU** — aucune source publique gratuite testée
  ne fournit l'historique du carnet ; `bookDepth` existe sur data.vision en théorie mais non testé à ce stade.

## 5. Régime dérivés

Dérivé de (funding percentile, tendance OI 24h, |premium|, volatilité réalisée 24h) :

| Régime | Condition initiale |
|---|---|
| BALANCED | funding ∈ [P25,P75], OI stable, vol < P75 |
| LONG_CROWDED | funding ≥ P90 et ΔOI 24h > 0 |
| SHORT_CROWDED | funding ≤ P10 et ΔOI 24h > 0 |
| DELEVERAGING | ΔOI 24h ≤ P10 |
| RELEVERAGING | ΔOI 24h ≥ P90 après DELEVERAGING |
| STRESS | vol réalisée 24h ≥ P99 ou E1/E2 en cours |

Le régime est une variable de conditionnement, jamais un signal seul.

## 6. Sizing — research only, 1x

- Tous les backtests en notionnel **1x** (zéro levier). Le levier ne crée pas d'edge ; il ne fait
  qu'amplifier une espérance qui doit d'abord être prouvée > 0 nette (§85).
- Ticket de recherche : notionnel fixe (ex. 1 000 $ notionnel), exposition max 1 position à la fois
  en phase de test (pas de portefeuille avant OOS positif).
- Aucune optimisation de sizing (Kelly, etc.) avant un EXPECTED NET RETURN > 0 prouvé sur holdout.
- Règle fatigue du labo : aucune décision live après minuit (red team 2026-09-28).

## 7. Critère économique

```
NET = GROSS − FEES − SLIPPAGE − FUNDING − LATENCY − MARKET_IMPACT
```

| Composante | Estimation initiale | Statut |
|---|---|---|
| GROSS | rendement forward mesuré sur données | à mesurer |
| FEES | taker 5 bp/aller (Binance VIP0) ; 4,5 bp (Hyperliquid) — barème public | ESTIMÉ (barème public, à confirmer au moment du test) |
| SLIPPAGE | INCONNU — à estimer via taker imbalance × impact (Sprint 1+) | INCONNU |
| FUNDING | funding horaire réel × durée de tenue (payé/reçu selon le sens) | MESURABLE (HL fundingHistory) |
| LATENCY | INCONNU — coût du délai détection→exécution, à mesurer sur notre infra | INCONNU |
| MARKET_IMPACT | INCONNU — modèle type Almgren-Chriss calibré sur volume, Sprint 2+ | INCONNU |

Règle d'arrêt (héritée du pivot §90) : si NET ≤ 0 après coûts réalistes sur holdout → NO EVIDENCE OF EDGE,
arrêt de l'optimisation de cette famille d'événements. Un GROSS positif ne suffit jamais.

## 8. Discipline anti-leakage + holdout (définis AVANT tout test)

1. **Point-in-time strict** : toute feature à t calculée sur données ≤ t. Les percentiles glissants
   (Pxx 7j) sont calculés sur fenêtre causale. Audit anti-leakage obligatoire avant chaque expérience
   (même format que le pipeline Phase 2 : `LEAKAGE_STATUS` par run).
2. **Splits chronologiques gelés** (sur l'historique complet collecté) :
   - **discovery** : 60 % les plus anciens — exploration, définition des événements, tuning des seuils.
   - **calibration** : 20 % suivants — estimation des distributions, choix des paramètres.
   - **holdout** : 20 % les plus récents — **gelé, jamais touché** avant la fin de la calibration ; un seul
     passage de jugement par hypothèse (pas de "re-test après ajustement").
   - Sur l'échantillon Sprint 0 (2026-08-29 → 2026-09-27) : discovery 08-29→09-15, calibration 09-16→09-22,
     holdout 09-23→09-27 (gelé).
3. **n ≥ 30** événements par cellule (événement × régime) avant tout verdict ; sinon INCONNU.
4. **Verdicts** : mêmes statuts que le registre (`research/hypotheses.yaml`) : OPEN / TESTING / PROMISING /
   RISK_ONLY / NULL / UNSTABLE / NEAR_MISS / KILLED / VALIDATED. `RISK_ONLY` = filtre d'exclusion valide
   (ne pas confondre avec un edge long).
5. **Pas de deep learning** avant que les statistiques simples aient parlé (règle architecte §19).
6. **Mémoire des échecs** : tout KILL documenté dans `research/memory_of_failure.md` avec le falsifier qui a tranché.

## 9. Tableau §87 — MEMECOINS vs SOL-PERP

État des connaissances au 2026-09-28 (Sprint 0). INCONNU = non mesuré à ce jour, pas deviné.

| Dimension | MEMECOINS (Branch A) | SOL-PERP (Branch B) |
|---|---|---|
| DATA QUALITY | Faible : artefacts collecteur (creates tardifs), late-discovery, holders null — documenté | Moyenne-haute : données exchange-grade (klines/OI/funding) ; **mais** prints de liquidation historiques INACCESSIBLES, carnet historique INCONNU |
| LIQUIDITY | Très faible (slippage dominant) | Élevée (SOL perp top liquidité) — profondeur historique exacte INCONNUE |
| LATENCY | INCONNUE (non mesurée) | INCONNUE (non mesurée) |
| TAIL RISK | Extrême (rugs, −100 % instantanés) | Modérée (pas de rug ; gaps possibles en stress) — ampleur exacte INCONNUE |
| SIGNAL HALF-LIFE | INCONNUE | INCONNUE |
| TRADE FREQUENCY | Élevée (potentiellement, si edge) | INCONNUE (dépend des seuils d'événements — descriptifs Sprint 0 en cours) |
| COST | Élevé (frais + slippage + loyers ~6–10 % sur 50 $) | Frais connus (barème public) ; slippage INCONNU |
| SLIPPAGE | Dominant, mal mesuré | INCONNU |
| OOS STABILITY | INCONNUE (holdout 30j en collecte) | INCONNUE (holdout défini §8, jamais touché) |
| EXPECTED NET RETURN | NO EVIDENCE OF EDGE (famille momentum/scalp tuée : brut idéal +2,70 % non significatif, médiane −14,21 %) ; autres familles en test | INCONNU — aucun test prédictif à ce jour (Sprint 0 = descriptif uniquement) |

Lecture : Branch B part d'une meilleure qualité de données et d'une liquidité supérieure, mais **rien
n'est prouvé** — le tableau sert à empêcher les récits ("le perp est plus propre donc il y a un edge").

## 10. Inventaire données — testé le 2026-09-28 (curl réel)

| Source | Endpoint | Accès | Granularité | Historique | Rate limit | Coût |
|---|---|---|---|---|---|---|
| Hyperliquid | `POST /info` `metaAndAssetCtxs` | ✅ 200 | temps réel | — (snapshot) | 1200 poids/min/IP | 0 |
| Hyperliquid | `POST /info` `candleSnapshot` | ✅ 200 | 1m/5m/15m/1h/4h/1d… | 5000 bougies/req : ~3,5j en 1m, ~17j en 5m, ~208j en 1h | idem (poids 20) | 0 |
| Hyperliquid | `POST /info` `fundingHistory` | ✅ 200 | horaire (funding+premium) | 500 entrées/req, paginable depuis 2023-05 | idem | 0 |
| Hyperliquid | `POST /info` `allMids`, `l2Book` | ✅ 200 | temps réel | — | idem | 0 |
| Binance data.vision | `futures/um/daily/klines/SOLUSDT/1m` | ✅ 200 | 1m (avec en-têtes) | profond (testé 30j, plus dispo) | généreux (bulk) | 0 |
| Binance data.vision | `futures/um/daily/markPriceKlines/1h` | ✅ 200 | 1h | profond | idem | 0 |
| Binance data.vision | `futures/um/daily/premiumIndexKlines/1h` | ✅ 200 | 1h | profond | idem | 0 |
| Binance data.vision | `futures/um/daily/metrics` | ✅ 200 | **5m** (`sum_open_interest`, ratios long/short top traders, taker vol ratio) | profond | idem | 0 |
| Binance data.vision | `fundingRate` | ❌ 404 | — | non publié (testé BTC+SOL, daily+monthly) | — | — |
| Binance data.vision | `liquidationSnapshot` | ❌ 404 | — | non publié (testé BTC+SOL) | — | — |
| Binance fapi | `fapi/v1/*` (klines, fundingRate, openInterest hist, forceOrders) | ❌ 451 | géo-bloqué (IP US) | — | — | — |
| Bybit | `v5/market/*` | ❌ 403 | géo-bloqué | — | — | — |
| Binance.US | `api/v3` | ✅ 200 | spot uniquement (pas de perps) | — | — | 0 |

Notes :
- `candle` (sans Snapshot) retourne "Failed to deserialize" — le bon type est `candleSnapshot`.
- Les klines 1m incluent `taker_buy_volume` → proxy d'imbalance acheteur/vendeur à la minute. 
- `metrics` 30m inclut `sum_open_interest` (quantité et valeur), `count_toptrader_long_short_ratio`,
  `count_long_short_ratio`, `sum_taker_long_short_vol_ratio` — positionnement exploitable.
- Funding Binance : inaccessible (fapi bloqué + archive absente) → funding via Hyperliquid uniquement.
  Écart inter-venues du funding : INCONNU.
- Prints de liquidation historiques : **aucune source publique gratuite accessible** → E1/E2 restent des
  proxies jusqu'à preuve du contraire (DATA ISSUE documentée, pas contournée).

## 11. GUT initial (GUT_HYPOTHESIS, pas des faits)

- **OBSERVATION** : sur l'échantillon test, SOL ~118–122 $, funding HL ~0.0000125/h (faible, stable).
- **WHY_IT_FEELS_UNUSUAL** : funding quasi-constant alors que le prix bouge → le positionnement perp
  semble équilibré en ce moment = régime BALANCED, pauvre en événements. La chasse commence dans le calme.
- **H1** : les cascades sont rares mais très informatives (queues épaisses). **H2** : le funding extrême
  est un filtre d'exclusion (RISK_ONLY) plutôt qu'un signal long. **H3** : le lead-lag HL↔Binance contient
  l'info que les proxies de liquidation n'ont pas.
- **KILL_CRITERION** : si les descriptifs montrent < 30 événements/mois/venue pour E1–E12 combinés,
  la fréquence de trade ne justifie pas la suite → redéfinir les seuils ou KILL la branche événementielle.

## 12. Sprint 0 — livrables (cette spec §1–11 ; §12 coché au fil de l'eau)

- [x] Inventaire sources (§10) — curl réel, coûts = 0
- [x] Spec (ce document)
- [ ] 12 hypothèses H-FLIP-01..12 dans `research/hypotheses.yaml` (famille S)
- [ ] `lab/flip/` : collecte read-only + détecteurs d'événements + tests vitest
- [ ] Descriptifs 30j : fréquence, amplitude, durée des 12 événements (descriptif uniquement)
- [ ] Rapport : 3 hypothèses prioritaires

## 13. Règles héritées du mandat (rappel, non négociables)

- Event-driven microstructure uniquement ; jamais blind momentum / breakout / high leverage (§85).
- Comparaison memecoins vs SOL-PERP honnête (§87, tableau ci-dessus).
- Le directeur R&D peut réduire l'axe early buyers si ce n'est pas l'endroit (§90) — la même règle
  s'applique ici : si les descriptifs ne montrent rien, on tue, on ne tune pas.
- FLIP ≠ gambling : pas de trade sans EXPECTED NET RETURN > 0 prouvé OOS après coûts.

## 14. Sprint 1 — résultats discovery (2026-09-28)

Données : Binance perp+spot SOLUSDT 1m, 264 960 bougies (2026-03-28 → 2026-09-27, 0 gap).
Discovery < 2026-07-16 ; holdout ≥ 2026-08-22 GELÉ, jamais lu. Coûts 10/20 bp à 1x notional.

| Hypothèse | n | Verdict | Chiffre décisif |
|---|---|---|---|
| H-FLIP-01 cascade E1 → reversal | 49 | KILLED | médiane Y@1h signée −32,09 bp (IC95 strictement négatif) ; 81,6 % reversal indiscernable des big-down appariées (85,7 %, p=0,44) ; NET médian −52 bp |
| H-FLIP-06 absorption | 7/42 | TESTING | absorbé < 30 — intestable ; direction cohérente, bruit pur |
| H-FLIP-10 lead-lag | 113 | NULL | lag médian 0 s, pas de leader stable ; HL↔Binance intestable (DATA ISSUE : historique HL 5m < 17 j) |

Leçon : le taux de reversal absolu (81,6 %) n'est que du bruit de marché à l'échelle 5 min
(baseline inconditionnelle 94,9 %). D'où l'importance des baselines inconditionnelles.
Caveat : E1/E2 sont des proxies (aucune source publique de prints de liquidation) ;
seulement 32 % des cascades ont un collapse OI concurrent → la plupart sont des ventes
spot-like, pas des liquidations. 921 tests verts. Détails : research/experiments/EXP-2026-09-28-flip-s1-*.md.
