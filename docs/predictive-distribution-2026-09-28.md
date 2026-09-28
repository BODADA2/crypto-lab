# Domaine 4/5 — DISTRIBUTION (concentration des holders) : résultats de découverte

**Date :** 2026-09-28 · **Phase :** DÉCOUVERTE · **Branche :** `feat/deku-cupsey` (AUCUN push, AUCUN commit)
**Protocole :** `lab/predictive/universe.ts` — split discovery (<50) / calibration (50–74) / holdout gelé (≥75) par hash FNV du mint, univers DISJOINTS · t0 = premier snapshot avec `liquidityUsd ≥ 20 000` et `priceUsd > 0` · Y = rendement futur (prix nettoyés des ticks aberrants ≥100× vs voisins) sur 1h / 6h / 24h, null si horizon non couvert.
**Code :** `lab/predictive/distribution/distribution.ts` (pipeline) + `run.ts` (runner reproductible : `npx tsx lab/predictive/distribution/run.ts`) · **Tests :** `tests/predictive-distribution.test.ts` (15/15 verts) · **Typecheck :** propre.
**Données :** `data/history/` (2 926 mints, 35 339 ticks, ~12 ticks/mint — biaisées vers les tokens chauds → **toute mesure = borne OPTIMISTE**) · `data/tokens/` (dernier état par mint) · `data/earlybuyers/` (backfill en cours, n petit).
**Règle :** n ≥ 30 pour toute conclusion. Résultat principal AVEC les outliers valides ; sensibilité SANS outliers valides (Y hors [P1, P99], convention partagée avec le domaine temporal).
**Interdits respectés :** aucune stratégie construite · holdout (≥75) JAMAIS mesuré · `data/track-unbiased/` non touché · aucune modification hors `lab/predictive/distribution/`, `docs/predictive-distribution-2026-09-28.md`, `docs/hypothesis-pred-distribution-2026-09-28.md`, `tests/predictive-distribution.test.ts` · aucune transaction réelle.

---

## Question centrale

Une concentration ÉLEVÉE à t0 prédit-elle un Y futur **positif** (whales qui portent le token) ou **négatif** (dump coordonné) ? Les deux directions sont testées sans a priori, variable par variable, horizon par horizon.

## 1. Inventaire des données (au 2026-09-28 ~12h33 UTC)

| Source | Contenu | Utilisable pour X à t0 ? |
|---|---|---|
| `data/history/` — 2 926 fichiers, 35 339 ticks | `top10Pct` = **100 sur 100 % des ticks** (codage explicite « inconnu ») ; `holders` = **null sur 100 % des ticks** | NON — couverture 0 % |
| `data/tokens/` — 2 926 fichiers (dernier état) | `top10Pct` réel (< 100) sur 590 mints (min 0,33 / médiane 15,42 / max 96,72) ; `holders` null partout | NON à t0 — mesuré au **dernier** tick, pas à t0 |
| `data/earlybuyers/` — 11 fichiers, 10 avec métriques | `top5_share`, `gini`, `same_slot_max`, bloc `sells` (partiel) | Partiellement — n=10 < 30, descriptif seul |

Lignes t0 valides : **1 026 / 2 926** (1 900 mints sans aucun snapshot à liquidité ≥ 20 k$). Ticks aberrants exclus de Y : 8 / 27 560.

## 2. Couverture de Y par horizon (contexte — 1 026 lignes t0)

| Horizon | n (couverture) | Moyenne | Médiane | IC95 % (moyenne) | Pertes extrêmes (≤ −50 %) |
|---|---|---|---|---|---|
| 1h | 695 (67,7 %) | +3,47 % | −1,05 % | [−6,38 %, +13,80 %] | 36,8 % |
| 6h | 381 (37,1 %) | −7,53 % | −10,64 % | [−18,74 %, +5,13 %] | 40,2 % |
| 24h | 112 (10,9 %) | −6,74 % | −23,52 % | [−28,62 %, +18,81 %] | 42,0 % |

Séries courtes (médiane ~2h après t0) → l'horizon 24h est couvert à ~11 % seulement. Dérive négative médiane sur tous les horizons, cohérente avec les verdicts antérieurs (drift négatif des tokens).

## 3. Couverture des variables X par univers

Nombre de lignes avec **X non nul ET Y(h) non nul** :

| Variable X | Discovery X / 1h / 6h / 24h | Calibration | Holdout |
|---|---|---|---|
| `top10Pct` à t0 (history) | **0** / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| `holders` à t0 | **0** / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Δ `top10Pct` (pré-t0 → t0) | **0** / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| `top10Pct` aligné t0 (data/tokens) | 18 / **0** / **0** / **0** | 5 / 0 / 0 / 0 | 4 / 0 / 0 / 0 |
| `top5_share` / `gini` / `same_slot_max` (early buyers) | ≤2 avec Y 1h | ≤4 avec Y 1h | ≤4 avec Y 1h |

**Lecture :** aucune variable de distribution n'atteint n ≥ 30 avec Y mesurable, dans aucun univers. Le domaine 4 est **intestable en l'état des données**.

### Pourquoi la jointure data/tokens ne sauve rien

Sur les 590 mints avec `top10Pct` réel dans `data/tokens/`, la valeur est mesurée au **dernier tick observé**, pas à t0. L'utiliser comme X serait du *look-ahead bias*. Seuls 27 mints ont leur dernier tick exactement égal au tick t0 — et pour ces 27, **Y est nul sur tous les horizons** (la série s'arrête à t0 : ce sont des tokens morts ou jamais re-observés). Artefact de sélection pur : les seuls tokens où la concentration est mesurable à t0 sont ceux dont on ne connaît pas le futur. **Aucun n exploitable.**

## 4. Résultats par variable (univers discovery)

| Variable | 1h | 6h | 24h | Verdict |
|---|---|---|---|---|
| `top10Pct` à t0 | n=0 | n=0 | n=0 | **INMESURABLE** — 100 % inconnu (codage 100) sur 35 339 ticks |
| `holders` à t0 | n=0 | n=0 | n=0 | **INMESURABLE** — 100 % null (DexScreener ne fournit pas) |
| Δ `top10Pct` pré-t0 → t0 | n=0 | n=0 | n=0 | **INMESURABLE** — aucune borne connue |
| `top10Pct` aligné t0 (tokens) | n=0 (Y) | n=0 (Y) | n=0 (Y) | **INMESURABLE** — 27 mints alignés mais Y indéfini (séries mortes à t0) |
| Cluster (top10Pct élevé × sells élevés à t0) | — | — | — | **NON EXÉCUTABLE** — top10Pct inconnu à t0 |

Stabilité temporelle (deux moitiés de la fenêtre) et par cohorte : **non applicables** — aucune relation X→Y à stabiliser. À titre de contexte : médiane Y 6h = −0,8 % (1ʳᵉ moitié, n=105) vs −24,5 % (2ᵉ moitié, n=73) — le régime lui-même est instable.

## 5. Early buyers — descriptif uniquement (n=10 < 30 : AUCUNE conclusion)

Métriques mesurées au lancement/migration (`top5_share`, `gini`, `same_slot_max` = part max d'acheteurs dans le même slot, proxy de bundling/coordination). Backfill en cours par un autre agent (non relancé, utilisé tel quel).

| mint | Univ. | top5_share | gini | same_slot_max | sellers >50 % | t0 vs migration | Y 1h | Y 6h | Y 24h |
|---|---|---|---|---|---|---|---|---|---|
| 2nkmqh65 | calib. | 0,576 | 0,386 | 0,133 | 0 | +18 min | n/a | n/a | n/a |
| 9pKKVy9V | calib. | 0,438 | 0,747 | 0,040 | 0 | +13 min | +216,7 % | n/a | n/a |
| CHyPGNd9 | holdout | 0,381 | 0,709 | 0,100 | 0 | +21 min | +241,1 % | n/a | n/a |
| DAmv9Ckr | holdout | 1,000 | 0,972 | 0,100 | **1** | +9 min | +1,5 % | n/a | n/a |
| FiQD9v1B | holdout | 1,000 | 0,974 | 0,080 | n/a | n/a | n/a | n/a | n/a |
| FkByyaAx | calib. | 0,984 | 0,934 | 0,080 | 0 | +10 min | +110,2 % | n/a | n/a |
| KEaQzxaj | calib. | 0,645 | 0,818 | 0,068 | n/a | +11 min | +90,0 % | n/a | n/a |
| cJ4gL7BE | holdout | 0,128 | 0,108 | 0,100 | n/a | +9 min | +43,6 % | n/a | n/a |
| ieTA9nTM | disco. | 0,609 | 0,509 | 0,200 | n/a | n/a | n/a | n/a | n/a |
| pzCi3SmP | disco. | 0,988 | 0,935 | 0,400 | n/a | +26 min | +45,2 % | n/a | n/a |

(5QK1qDJ3Az : fichier sans métriques — échec de collecte.)

**Contamination temporelle — point bloquant méthodologique :** les métriques early buyers sont calculées à `fetchedAt ≈ migration + 60 min`, alors que t0 (liquidité ≥ 20 k$) survient à `migration + 9 à 26 min`. **X est donc mesuré APRÈS le début de la fenêtre Y 1h** — même avec n ≥ 30, cette mesure serait contaminée par du look-ahead partiel. Pour un test propre, il faudrait des métriques early buyers calculées à la migration (ou avant t0), pas une heure après.

**Bloc `sells` (5 fichiers) :** `sellersOver50` = 1 seul wallet (DAmv9Ckr) ; `coordinated_sells` = null partout ; `walletsCovered` = 0–1. Couverture trop faible pour toute analyse — et le backfill log montre des erreurs RPC Helius (-32015, version de transaction non supportée) qui expliquent les trous.

## 6. Annexe — proxy auxiliaire `sellRatio` à t0 (HORS DOMAINE, descriptif)

Le ratio `sells/(buys+sells)` (fenêtre h1 à t0, repli h24/m5) est mesurable sur 1 026/1 026 lignes. **Ce n'est PAS une variable de distribution** (c'est du flow) : il est rapporté ici uniquement parce que la question des clusters le mentionne, et il est **renvoyé au domaine flux/structure temporelle** — aucune hypothèse H-PRED-DIST n'en est tirée.

| Horizon | n (discovery) | Spearman | Médiane Y | IC95 % | Décile bas X (achats dominent) | Décile haut X (ventes dominent) |
|---|---|---|---|---|---|---|
| 1h | 328 | −0,231 | −0,6 % | [−10,4 %, +18,9 %] | médiane +9,1 % (n=33) | médiane −0,7 % (n=32) |
| 6h | 178 | −0,327 | −1,8 % | [−20,6 %, +6,4 %] | médiane +49,0 % (n=18) | médiane −5,7 % (n=17) |
| 24h | 46 | −0,141 | −20,5 % | [−38,0 %, +31,8 %] | médiane +55,5 % (n=5) | médiane −48,6 % (n=4) |

Sensibilité sans outliers P1/P99 : signes et ordres de grandeur inchangés (1h : −0,254 ; 6h : −0,367). Observation : une pression vendeuse élevée à t0 est associée à un Y futur plus faible — direction « dump » plutôt que « whales qui portent », **mais** : (a) hors domaine, (b) non pré-enregistré, (c) IC larges incluant 0 sur la moyenne, (d) borne optimiste. À tester proprement dans le bon domaine, pas ici.

## 7. Verdicts

1. **Aucune variable de distribution n'est prédictive hors échantillon — parce qu'aucune n'est mesurable.** Ce n'est pas un « NO SIGNAL », c'est un « NO DATA » : `top10Pct` inconnu à 100 %, `holders` null à 100 %, Δ pré-t0→t0 incalculable, jointure `data/tokens` inutilisable (look-ahead ou séries mortes), early buyers à n=10 avec contamination temporelle.
2. **La question centrale (concentration élevée → Y positif ou négatif ?) reste OUVERTE** — aucune donnée ne permet de trancher, dans un sens ou dans l'autre.
3. **Holdout gelé intact** : jamais mesuré, aucune calibration à verrouiller — le protocole est respecté par construction (rien ne passe la découverte).
4. **Aucune architecture de portefeuille / aucun hedge ne peut être justifié** depuis ce domaine.

## 8. Ce qu'il faudrait collecter (recommandations, pas d'action entreprise)

- **Concentration à t0** : mesurer `top10Pct` (ou la distribution complète des holders) **au moment de t0**, pas au dernier tick — c'est le chaînon manquant unique pour H-PRED-DIST-01/02/03/06. Sans ça, tout le domaine reste intestable.
- **Holders** : source on-chain (Helius) plutôt que DexScreener, qui ne fournit pas le champ.
- **Early buyers** : calculer les métriques **à la migration** (ou garantir `computedAt < t0`) pour éliminer la contamination temporelle ; fiabiliser le backfill (erreurs RPC -32015).
- Quand n ≥ 30 avec X propre et antérieur à t0 : rejouer `run.ts` (découverte → verrouillage → calibration → UNE mesure holdout).

## 9. Déclarations

- Données `data/history/` et `data/tokens/` biaisées vers les tokens chauds : toute mesure ci-dessus est une **borne OPTIMISTE**.
- `data/track-unbiased/` : non touché (holdout de 30 jours de collecte propre).
- AUCUN push, AUCUN commit, AUCUNE transaction réelle, AUCUNE modification hors du périmètre autorisé.
- Rapport reproductible : `npx tsx lab/predictive/distribution/run.ts` (lecture seule).
