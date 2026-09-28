# Edge check — Tier 1 sur données réelles (2026-09-28)

**Nature :** mesure descriptive, PAS un backtest validé. Aucune donnée fabriquée,
aucun seuil modifié, aucune écriture dans le paper engine (cycle 2 en cours en parallèle).

**Méthode**
- Source : `data/scans/pump-2026-09-24…28.jsonl` — 68 466 creates, 2 229 migrates bruts.
- Après dédup par mint : **66 562 creates**, 1 549 migrates appariés → **taux de base 2,33 %**
  (IC 95 % : 2,21–2,44). (Le doc deep-edges annonçait 3,3 % sur un échantillon ; la mesure
  exhaustive donne 2,33 %.)
- Anti-censure : les taux par segment sont recalculés sur les creates **≤ 2026-09-26**
  (n = 41 619, base 2,37 %) pour laisser ≥ 1 jour de suivi. Le taux journalier est stable
  (2,24–2,72 %), pas de dérive temporelle qui fausserait les comparaisons.
- `devBuy` = `solAmount` de l'événement create (mesuré à la création : **pas de lookahead**).
- IC 95 % par approximation normale partout ; verdicts selon recouvrement des IC.

---

## E2 · H-TOOL — l'empreinte de l'outil : SIGNAL (double sens)

| Domaine d'URI | n | Taux migration | IC 95 % | vs base 2,37 % |
|---|---|---|---|---|
| ipfs.io (≈ déploiement manuel via pump.fun) | 27 478 | **2,70 %** | 2,51–2,89 | légèrement au-dessus |
| metadata.j7tracker.io (outil J7) | 7 214 | **1,36 %** | 1,09–1,63 | **nettement sous** |
| meta.uxento.io | 2 083 | **0,96 %** | 0,54–1,38 | **nettement sous** |
| pump.mypinata.cloud | 812 | 0,86 % | 0,23–1,50 | sous |
| gateway.pinata.cloud | 309 | 1,62 % | 0,21–3,02 | — |
| « ? » (pas d'URI) | 946 | **5,50 %** | 4,04–6,95 | **nettement au-dessus** |
| fast-ipfs.com | 182 | 5,49 % | 2,18–8,81 | au-dessus (petit n) |

- `is_mayhem_mode = true` : 1,54 % (n = 11 984) vs false : 2,70 % (n = 29 635) → **exclusion**.
- `pool = bonk` : **5,86 %** (n = 904) vs `pump` : 2,29 % (n = 40 715).

**Verdict : SIGNAL.** Les outils industrialisés (J7, uxento, pinata) migrent ~2× moins que
la base : ce sont des farms à tokens — **filtre d'exclusion**, pas d'inclusion. Le déploiement
manuel (ipfs.io) fait mieux que la base. Le segment « ? » (5,50 %) est une curiosité :
porté par des petits devBuys (8,28 % dans le quartile bas, n = 592) — à investiguer avant
tout usage, possible artefact de collecte.

---

## E3 · H-DEVBUY — la mise du dev : SIGNAL (le plus fort)

Quartiles de `devBuy` sur le flux complet (n = 41 619) :

| Quartile | devBuy (SOL) | n | Taux migration | IC 95 % |
|---|---|---|---|---|
| Q1 | 0 – 0,05 | 10 404 | 1,41 % | 1,19–1,64 |
| Q2 | 0,05 – 0,24 | 10 404 | 1,85 % | 1,59–2,10 |
| Q3 | 0,24 – 1,29 | 10 404 | 1,11 % | 0,90–1,31 |
| **Q4** | **≥ 1,29** | 10 407 | **5,10 %** | **4,68–5,53** |

**Interaction outil × mise (le vrai edge) :**

| | Q1–Q3 | Q4 (≥ 1,29 SOL) |
|---|---|---|
| ipfs.io (manuel) | 1,06–1,93 % | **10,45 %** (n = 3 636) |
| j7tracker.io (industriel) | 0–1,21 % | 2,09 % (n = 3 927) |
| uxento.io | 0–1,39 % | 1,58 % (n = 1 010) |

**Verdict : SIGNAL FORT.** Un dev qui met ≥ 1,3 SOL des siens au déploiement manuel
(ipfs.io) → **10,45 % de migration, soit 4,4× le taux de base** (n = 3 636, IC ne
recouvrant pas la base). Sur les outils industrialisés, même les grosses mises ne
sauvent pas le token (2,09 %) : la ferme reste une ferme. Note : l'échantillon
`data-snipe` (n = 265, 2 positifs) était trop petit/biaisé pour voir cet effet —
il est visible uniquement sur le flux exhaustif.

---

## E1 · H-CURVE — progression sur la courbe : NON CONCLUANT (v1) / REDONDANT (v2)

- **v1 (premier snapshot `data/history`, protocole du doc) : NON CONCLUANT.** Biais de
  sélection massif : **46,4 % des 2 727 mints suivis en history ont migré** contre 2,37 %
  de base — le collecteur history suit préférentiellement les tokens déjà chauds/migrés.
  Les taux par bucket (56 % / 12–21 % / 55 %) ne sont pas interprétables. Le test doit être
  refait sans ce biais.
- **v2 (marketCapSol au create, ce que le moteur voit à la détection) :** Q4 → 5,48 %
  vs 1,0–1,8 % pour Q1–Q3. **Mais** marketCapSol au create ≈ 30 + devBuy : c'est le même
  mécanisme que H-DEVBUY, pas un edge indépendant.

**Verdict :** la version « où en est la courbe à la détection » se réduit à H-DEVBUY.
La vraie question H-CURVE (progression mesurée en cours de vie) reste ouverte mais exige
un design sans biais de sélection.

*Note de calibration :* le seuil de graduation estimé empiriquement (médiane du
marketCapUsd du dernier snapshot pré-migration, 49 migrates) ≈ **23 500 $**, stable sur
4 jours — cohérent avec l'ordre de grandeur attendu. Utile pour de futurs buckets.

---

## E4 · H-POSTMIG — trajectoire ±60 min : DONNÉES INSUFFISANTES

58 migrates ont des snapshots des deux côtés de la migration, mais le côté pré-migration
est trop clairsemé (13–21 snapshots par tranche de 10 min) pour tracer un chemin fiable.
Côté post-migration, les snapshots sont concentrés dans les 10 premières minutes
(le collecteur suit les tokens à partir de la migration — même biais qu'E1).

**Verdict :** impossible de statuer. Requiert un suivi pré-migration systématique
(poll des tokens proches du seuil), pas un réexamen des mêmes données.

---

## E5 · H-CALLTRACK — palmarès des channels : FALSIFIÉ (par le timing)

- 40 calls Solana uniques (1 seul channel actif : `mad_apes_gambles`), 11 migrés → **27,5 %**
  brut contre 2,33 % de base. À première vue, un signal énorme.
- **Test du timing : sur les 11 migrés, 10 avaient DÉJÀ migré avant ou au moment du call,
  1 seul après.** Le channel appelle des tokens déjà gradués/chauds : c'est un indicateur
  **retardé**, pas un prédicteur.

**Verdict : NO SIGNAL comme prédicteur de migration.** Le 27,5 % est du pur biais de
sélection (survivorship). Piste résiduelle : mesurer si les calls post-migration prédisent
la *continuation* (pas la migration) — autre hypothèse, autre test.

---

## Biais et limites (honnêteté)

1. **Migration ≠ profit.** Tous les taux ci-dessus mesurent la graduation, pas la
   rentabilité nette. Le hurdle frais+MEV (6–10 % par round-trip à 50 $) n'est pas intégré :
   un filtre à 10 % de migration peut encore perdre de l'argent.
2. **Ce n'est pas un backtest walk-forward.** Mesure descriptive in-sample sur 5 jours.
   La priorité ci-dessous impose le protocole du labo (walk-forward, n≥30, médianes).
3. **Artefact détecté :** le champ `devBuy` des creates `pool=bonk` vaut 0 pour la moitié
   des tokens — structure de tx différente, pas des vrais zéros. Ne pas bucketer le devBuy
   sur bonk sans correction.
4. **Le segment « ? » (pas d'URI, 5,50 %)** n'est pas expliqué : ne pas en faire un filtre
   avant investigation.
5. **data-snipe (n = 265)** ne réplique pas H-DEVBUY : échantillon trop petit et sélectionné.
   Le signal n'existe que sur le flux exhaustif.

---

## Recommandation : priorité de backtest n≥30

**1er : le filtre combiné « manuel + skin in the game »**
`(domaine URI = ipfs.io) ET (devBuy ≥ ~1,3 SOL)` → 10,45 % in-sample (n = 3 636).
Protocole : walk-forward (entraînement 24–25, test 26–27–28 sept.), mesurer taux de
migration **et** MFE médian **et** P&L net après hurdle 6–10 %. Falsificateur : taux test
≤ base ou P&L net ≤ 0.

**2e : le filtre d'exclusion industriel** — rejeter
`j7tracker.io / uxento.io / pinata / mayhem=true` (1,36 % / 0,96 % / 0,86 % / 1,54 %) :
mesurer le lift du portefeuille restant, coût = runners filtrés par erreur.

**À ne pas poursuivre :** H-CALLTRACK (falsifié), H-CURVE v1 sur data/history (biais),
H-POSTMIG (données insuffisantes — d'abord améliorer la collecte pré-migration).
