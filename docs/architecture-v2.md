---
title: "Solana Crypto Lab — Cartographie et architecture d'intégration"
subtitle: "Première mission, étapes 1 à 9 : comprendre l'ensemble avant de coder"
author: "AI Crypto Research + Trading + Development Lab — pour Hervé Rakotoniaina"
date: "24 septembre 2026"
lang: fr-CA
---

# Résumé

Ce document exécute les étapes 1 à 9 de la première mission. Il cartographie ce qui existe, place chaque composant dans les six blocs demandés, dessine les flux de données, liste les doublons et les failles, et propose le plan d'intégration et les tests. Rien n'est codé ici.

Une chose manque pour aller au bout : **ton bot personnel**. Il n'est ni dans les fichiers de la conversation, ni accessible sur ton ordinateur (hors ligne au moment de la rédaction). L'étape 3 (audit) et l'étape 4 (point d'intégration) sont donc écrites comme un **protocole d'audit prêt à exécuter**, avec la liste exacte de ce dont j'ai besoin. Le reste de l'architecture est conçu pour que le bot se branche à un endroit précis — un générateur de signaux parmi d'autres, jamais une autorité — quelle que soit sa nature.

# Étape 1 — Architecture actuelle du Crypto Lab

Le laboratoire livré hier est organisé en trois plans, séparés par l'endroit où ils tournent et par ce qu'ils ont le droit de faire.

| Plan | Où | Peut | Ne peut pas |
|---|---|---|---|
| Données | GitHub Actions (15 min) ou ta machine | Lire les API publiques, écrire `data/` | Toucher au ledger, aux clés, aux intents |
| Analyse (Claude) | Sessions planifiées, lecture du dépôt | Écrire briefs, intents, journal, KILL | Lire la politique locale, la clé, le ledger local ; lever un KILL |
| Exécution | Ta machine uniquement | Re-vérifier, évaluer, exécuter, écrire le ledger local chaîné | Exécuter un code non scellé, un intent non conforme, sans réseau |

Chaîne actuelle : **COLLECTE → SIGNAUX → (Claude) INTENT → RE-VÉRIFICATION LOCALE → RISK ENGINE → EXÉCUTION (paper/live) → LEDGER → JOURNAL → BRIEF**. Ce qui manque par rapport à la chaîne demandée en douze étapes : la **normalisation** est implicite (deux formats de snapshot coexistent, voir étape 7), le **cross-check multi-signal** et le **scoring** n'existent pas comme composants (Claude les fait « à la main » dans le brief), le **red team avant chaque trade** est une règle écrite, pas un code, et l'**apprentissage** est un rapport hebdomadaire, pas encore une base de connaissances requêtable.

# Étape 2 — Inventaire des composants existants

## 2.1 Dépôt `crypto-lab` (222 tests, TypeScript strict, hors ligne)

| Composant | Fichier | Rôle | Entrées | Sorties | État |
|---|---|---|---|---|---|
| Collecteur DexScreener | `lab/collect/dexscreener.ts` | profils, boosts, paires, recherche | API (60 req/min) | `TokenSnapshot` (format collecte) | testé |
| Collecteur PumpPortal | `lab/collect/pumpportal.ts` | créations et migrations en temps réel | WebSocket gratuit | `data/scans/pump-*.jsonl` | testé (faux serveur WS) |
| Collecteur Helius | `lab/collect/helius.ts` | premiers acheteurs, historique de wallet | RPC (1 M crédits/mois) | listes de wallets | testé |
| Mint info | `lab/collect/mintinfo.ts` | autorités, extensions Token-2022, top 10 | RPC | champs du snapshot risque | testé |
| Reddit / GitHub | `lab/collect/reddit.ts`, `github.ts` | posts récents, repos en tendance | API publiques | textes, tickers, mints | testé |
| Pont | `lab/collect/bridge.ts` | collecte → format risque | snapshots | `TokenSnapshot` (format risque) | testé |
| Cycle | `lab/collect/run.ts` | orchestration d'un cycle de collecte | tous les collecteurs | `data/` | testé |
| Signal volume | `lab/signals/volume.ts` | z-score 5 min, accélération holders, vol/liq | historique | score 0–100 + raisons | testé |
| Signal early buyers | `lab/signals/earlybuyers.ts` | overlap de wallets sur tokens gradués | Helius | `data/wallets/*.json` | testé |
| Signal narratif | `lab/signals/narrative.ts` | termes en accélération 24 h vs 7 j | noms de tokens, Reddit, GitHub | top 10 termes | testé |
| Backtest | `lab/backtest/harness.ts` | TP/SL/time-stop, coûts, refus sous n < 30 | `data/history/` | win rate, espérance, drawdown | testé |
| Brief | `lab/brief/generate.ts` | 9 sections, chaque chiffre cite sa source | `data/`, `ledger/`, `journal/` | `briefs/*.md` | testé |
| Risk Engine | `lab/risk/engine.ts` | verdict pur, toutes les règles de la politique | intent, snapshot local, ledger local, politique locale | allowed + raisons | testé + red team |
| Vérification locale | `lab/exec/verify.ts` | snapshot construit sur ta machine avant tout ordre | RPC + DexScreener | snapshot fiable | testé |
| Intégrité | `lab/exec/integrity.ts`, `seal.ts` | manifeste SHA-256 du code scellé par toi | `lab/**` | refus si écart | testé |
| Kill switch | `lab/exec/killswitch.ts` | dépôt, local, env ; cliquet | fichiers | arrêt | testé |
| Exécuteur | `lab/exec/executor.ts` | boucle intents → verdict → paper/live | intents | ledger local chaîné + export | testé |
| Paper | `lab/exec/paper.ts` | slippage, frais, PnL | devis | portefeuille simulé | testé |
| Jupiter | `lab/swap/jupiter.ts` | devis, swap (live seulement) | API | transaction | stub testé |
| Ledger | `lab/ledger/ledger.ts` | jsonl, reconstruction, drawdown | ledger | `PortfolioState` | testé |
| Journal | `lab/journal/journal.ts` | hypothèses, rapport hebdo (n < 10 → pas de changement) | ledger, journal | `reports/` | testé |
| Workflows | `.github/workflows/*.yml` | collecte 15 min, brief quotidien | — | commits `data/`, `briefs/` | à activer |

## 2.2 Dépôt `memecoin-lab` (130 tests) — le bloc DEVELOPMENT

Pipeline de création Token-2022 (`src/lib/token.ts`), vérificateur anti-rug (`npm run verify`, utilisable sur n'importe quel mint), moniteur à 43 règles avec alertes Telegram/Make (`monitor/`), site, simulateur, docs de lancement et de transparence, red team en trois passes. Le vérificateur et le moniteur sont directement réutilisables par le bloc TRADING (voir doublons, étape 7).

## 2.3 Agents (sessions Claude) et automatisations

Brief du matin : tâche planifiée quotidienne (6 h 30 Atlantique). Agents de session utilisés pour construire : Researcher, Developer (données), Developer (exécution), Red Team. Aucun agent permanent n'a d'accès financier. Make.com et Airtable : envisagés pour MemeScan, non branchés.

## 2.4 Sources de données (vérifiées le 24/09/2026)

DexScreener (60 req/min), PumpPortal (créations/migrations gratuites), Helius (1 M crédits), Jupiter (1 req/s), Reddit (~100 req/min), GitHub (5 000 req/h), CoinGecko/CMC (macro), Banque du Canada (FX). Absents : X (payant à l'usage), Dune (lecture seule), Birdeye (quotas non confirmés), Google Trends, YouTube, flux RSS, données de dérivés (funding, open interest, liquidations).

## 2.5 Ton bot personnel

**Inconnu.** Ni code, ni description, ni historique de trades disponibles. Voir étape 3.

# Étape 3 — Protocole d'audit du bot (à exécuter dès réception)

Je ne présume ni qu'il est bon ni qu'il est mauvais. Voici exactement ce dont j'ai besoin, par ordre d'utilité.

1. **Le code** (ou le script Pine, ou la configuration si c'est un bot hébergé type Trojan/GMGN/Axiom/BullX) : je ne peux rien conclure d'une description orale.
2. **L'historique des trades** exporté (date, token, côté, taille, prix, frais, résultat), même court, même mauvais.
3. **La plateforme d'exécution** et le wallet (adresse publique seulement — jamais la clé), pour reconstruire les trades on-chain si l'export manque.
4. **Les paramètres** : indicateurs, périodes, seuils, taille de position, stop, take-profit, fréquence, données utilisées, heures d'activité.
5. **Ce que tu crois qu'il fait bien et mal**, en une phrase chacun — pour comparer avec les données.

L'audit répondra, avec les données et non avec des impressions, à chaque point demandé : stratégie et indicateurs, entrées et sorties, sizing, fréquence, performances, drawdown, frais et slippage réels, conditions de gain et de perte (régime de marché, heure, liquidité, âge du token). Il se terminera par une décision parmi : **A conserver / B modifier / C connecter / D supprimer / E générateur de signaux seulement**, avec la preuve chiffrée. Si l'historique compte moins de 30 trades, l'audit dira « non concluant » et proposera 30 jours de paper trading du bot à travers le Risk Engine avant tout verdict.

# Étape 4 — Où le bot s'intègre, quel qu'il soit

Le bot n'entre jamais dans le plan exécution. Il devient un **générateur de signaux** parmi d'autres, avec sa propre ligne dans le Strategy Engine :

BOT SIGNAL → adaptateur (`lab/strategies/bot-adapter.ts`) → `signals/` (format commun) → CROSS-CHECK (humain + marché + on-chain + projet + macro) → SCORING → RED TEAM → intent → RISK ENGINE (ta machine) → exécution paper/live.

Trois modes d'intégration, selon l'audit : **shadow** (le bot émet, rien n'est exécuté, on mesure sa valeur prédictive pendant 30 jours), **contributeur** (son signal compte dans le score avec un poids mesuré), **autonome encadré** (ses intents passent directement au Risk Engine, si et seulement si son espérance nette est prouvée sur n ≥ 30 en paper). Dans tous les cas, ses ordres passent par le même Risk Engine, le même ledger et le même kill switch que tout le reste. S'il exécute aujourd'hui avec sa propre clé, cette exécution parallèle doit s'arrêter ou être plafonnée dans la politique de risque : deux moteurs qui exécutent sans se voir, c'est une exposition non contrôlée.

# Étape 5 — Architecture en six blocs

| Bloc | Composants | Existant | À construire |
|---|---|---|---|
| **RESEARCH** | Researcher (sessions), collecteurs Reddit/GitHub, narratifs, recherche web, base de connaissances | collecteurs, `research-2026-09-24.md` | base de connaissances requêtable (`knowledge/`), veille RSS/YouTube/Google Trends |
| **MEMECOIN TRADING** | PumpPortal, DexScreener, mintinfo, signaux volume/early buyers/narratif, backtest, stratégies memecoin | tout sauf le Strategy Engine | Strategy Engine, Scoring, cross-check, adaptateur bot |
| **CRYPTO TRADING** | Données de dérivés (funding, open interest, liquidations), momentum BTC/SOL, rotation sectorielle | rien | collecteur dérivés (Binance/Bybit/Hyperliquid publics, gratuits), stratégies momentum/mean reversion, décision MEMECOIN / CRYPTO / NO TRADE |
| **DEVELOPMENT** | memecoin-lab (pipeline, vérificateur, moniteur, site), Tap Tap, launch-as-a-service | tout | moteur TRADE vs BUILD (grille de comparaison codée), robot Tap Tap |
| **RISK ENGINE** | politique locale, verdict pur, re-vérification, intégrité, ledger chaîné, kill à cliquet, reduce-only | tout | corrélation entre positions, exposition par narratif et par wallet source, série de pertes, budget d'erreurs d'exécution |
| **AUTOMATION** | GitHub Actions, sessions planifiées, exécuteur en `--watch`, alertes | collecte, brief, exécuteur | cross-check et scoring automatiques, red team codé (checklist exécutable), post-mortem automatique, learning loop |

Hiérarchie de décision demandée, respectée par construction : **RISK ENGINE > TRADING AGENT > STRATEGY AGENT > CLAUDE**. Claude propose des intents ; le Strategy Engine mesure ; le Trading Agent choisit MEMECOIN / CRYPTO / NO TRADE ; le Risk Engine a le dernier mot, sur ta machine, avec des entrées qu'il vérifie lui-même.

# Étape 6 — Flux de données

```
SOURCES            COLLECTE (15 min)         NORMALISATION            DÉTECTION
DexScreener ─┐                                                       ┌─ volume.ts
PumpPortal   ├─► lab/collect/run.ts ─► TokenSnapshot (un seul  ) ─►├─ earlybuyers.ts
Helius       │    data/scans, tokens,     format, voir étape 7)      ├─ narrative.ts
Reddit/GitHub┤    history, wallets                                   ├─ bot-adapter.ts   (à faire)
Dérivés (à faire)                                                    └─ derivatives.ts   (à faire)
                                                                              │
                     CROSS-CHECK ◄────────────────────────────────────────────┘
                     signals/crosscheck.ts : HUMAIN + MARKET + ON-CHAIN + PROJET + MACRO
                     → convergence (0–5 familles indépendantes)                (à faire)
                              │
                     SCORING  signals/score.ts : score 0–100, poids publics, explication   (à faire)
                              │
                     RED TEAM redteam/checklist.ts : 17 vérifications codées → veto/ok      (à faire)
                              │
                     DÉCISION (Claude / Trading Agent) → intents/*.json  (MEMECOIN | CRYPTO | NO TRADE | BUILD)
                              │
        ══════════ frontière : ta machine ══════════
                              │
                     RE-VÉRIFICATION LOCALE (verify.ts) → RISK ENGINE (engine.ts) → EXÉCUTION (paper | live)
                              │
                     LEDGER local chaîné → export ledger/ → MONITORING (moniteur memecoin-lab, 5 min)
                              │
                     POST-TRADE (journal/postmortem.ts, à faire) → LEARNING (knowledge/, à faire) → BRIEF (6 h 30)
```

Règles de flux : un composant ne lit que les fichiers du composant précédent ; aucun composant du haut n'écrit sous la frontière ; tout ce qui traverse la frontière est re-vérifié.

# Étape 7 — Doublons, failles et risques

## 7.1 Doublons

- **Deux formats `TokenSnapshot`** (`lab/collect/types.ts` et `lab/types.ts`) reliés par un pont. C'est la première chose à unifier : un seul type, avec les champs « inconnus » explicites.
- **Deux moniteurs** : `memecoin-lab/monitor` (43 règles, alertes Telegram, invariant k) et la surveillance implicite de l'exécuteur. Le moniteur de memecoin-lab doit devenir le bloc MONITORING du lab, pas être réécrit.
- **Deux vérificateurs d'autorités** : `memecoin-lab/src/lib/token.ts` (verifyMint) et `crypto-lab/lab/collect/mintinfo.ts`. Même layout décodé deux fois ; à fusionner dans un paquet partagé.
- **Deux dépôts** : garder les deux (le pipeline de création n'a rien à faire près d'un exécuteur), mais partager `verify` et `monitor` via un paquet commun.

## 7.2 Failles

- **Pas de cross-check ni de scoring codés** : la convergence multi-signal est aujourd'hui un jugement de Claude ; elle doit devenir une fonction testable, sinon elle n'est ni reproductible ni auditable.
- **Le red team avant chaque trade est une règle, pas un code** : les 17 vérifications de la section 9 du mandat doivent devenir une checklist exécutable avec veto automatique sur les critères durs (freeze/mint authority, top 10, wash trading détecté, honeypot).
- **Aucune donnée de dérivés ni d'order flow** : le bloc CRYPTO TRADING est vide ; sans funding, open interest et liquidations, « momentum » et « rotation » sont des mots. Les API publiques de Binance, Bybit et Hyperliquid fournissent ces données gratuitement (à vérifier au branchement, comme toutes les sources).
- **Pas de corrélation entre positions ni d'exposition par narratif/wallet** dans la politique : quatre positions sur le même thème ou le même wallet source = une seule position quatre fois plus grosse.
- **Pas de série de pertes** dans la politique : après trois pertes consécutives, rien ne ralentit le système.
- **Le learning loop n'a pas de base de connaissances** : le journal enregistre, personne ne requête. « Avions-nous détecté le signal, combien de temps avant ? » doit être calculable automatiquement à partir des scans et des mouvements observés.

## 7.3 Risques

- **Le bot inconnu** : s'il exécute aujourd'hui avec sa propre clé, il est hors de toute limite. Premier geste après réception : le mettre en mode signal seulement.
- **Sur-automatisation avant validation** : la chaîne en douze étapes est tentante ; chaque étape passe par READ-ONLY → PAPER → LIVE très petit, pas avant.
- **Fausses convergences** : cinq signaux qui viennent tous du même événement (un boost payé sur DexScreener fait monter volume, holders, mentions Reddit et « narratif » en même temps) ne sont pas cinq signaux indépendants. Le cross-check doit mesurer l'indépendance des sources, pas seulement leur nombre.
- **Coût des crédits Helius** : early buyers et mintinfo consomment ; le pré-filtre (liquidité ≥ 20 k$, âge ≥ 10 min) reste obligatoire.

# Étape 8 — Plan d'intégration

| Ordre | Chantier | Bloc | Livrable | Condition d'entrée |
|---|---|---|---|---|
| 1 | Unifier `TokenSnapshot` ; paquet partagé `verify` + `monitor` | tous | un type, un paquet, tests verts dans les deux dépôts | — |
| 2 | Strategy Engine : interface `Strategy { id, signals(snapshot, history) → Signal[] }`, métriques par stratégie (win rate, espérance, profit factor, drawdown, gain/perte moyens, frais, slippage, par régime) | TRADING | `lab/strategies/`, `lab/strategies/metrics.ts` | 1 |
| 3 | Adaptateur bot (mode shadow) | TRADING | `lab/strategies/bot-adapter.ts` + audit écrit | réception du bot |
| 4 | Cross-check + Scoring + Red team codé | TRADING | `signals/crosscheck.ts`, `signals/score.ts`, `redteam/checklist.ts` ; score explicable, poids dans un JSON versionné | 2 |
| 5 | Collecteur dérivés + décision MEMECOIN / CRYPTO / NO TRADE | CRYPTO | `lab/collect/derivatives.ts`, `lab/decide/route.ts` | 2 |
| 6 | Politique : corrélation, exposition par narratif/wallet, série de pertes, budget d'erreurs | RISK | `policy.example.json` v2 + règles + tests + re-scellement | 4 |
| 7 | Post-mortem automatique + base de connaissances + « détecté combien de temps avant ? » | AUTOMATION | `journal/postmortem.ts`, `knowledge/` | 4 |
| 8 | Moteur TRADE vs BUILD codé (grille à 12 critères, sortie TRADE / BUILD / TRADE+BUILD / NO ACTION) | DEV | `decide/tradeVsBuild.ts` | 4 |
| 9 | Sources « attention humaine » : RSS, YouTube (API Data v3, gratuite), Google Trends (non officiel, fragile) | RESEARCH | collecteurs + test statistique de valeur prédictive | 7 |
| 10 | Brief enrichi : score, convergence, verdicts red team, UNKNOWN OPPORTUNITIES | AUTOMATION | `brief/generate.ts` v2 | 4, 7 |

Chaque chantier passe par les trois paliers : read-only (collecte et calcul), paper (intents simulés), live très petit (une position, 10 $) uniquement si les données du paper le justifient, puis augmentation progressive écrite dans la politique — jamais dans le code.

# Étape 9 — Tests nécessaires

| Famille | Ce qu'on prouve | Méthode |
|---|---|---|
| Unification des types | aucun champ perdu, « inconnu » explicite | tests de conversion sur fixtures réelles |
| Strategy Engine | chaque stratégie est isolable, ses métriques sont reproductibles | fixtures d'historique, résultats figés |
| Adaptateur bot | le bot ne peut jamais exécuter ; ses signaux sont datés et immuables | test : un signal du bot sans cross-check ne produit aucun intent |
| Cross-check | cinq signaux issus d'une même cause comptent pour un | fixture « boost payé » → convergence = 1 |
| Scoring | même entrée, même score ; chaque point expliqué ; aucun score sans données | tests de déterminisme et d'explication |
| Red team codé | freeze authority, top 10 > seuil, honeypot → veto ; veto non levable par le dépôt | tests + red team adversarial |
| Politique v2 | corrélation, narratif, wallet, série de pertes bloquent ; reduce-only préservé | extension de `tests/risk.test.ts` et `redteam-risk.test.ts` |
| Dérivés | parsing des API publiques, gestion des pannes, aucune valeur inventée | fixtures aux vrais schémas |
| Post-mortem | « détecté X min avant » calculé sans hindsight (seules les données disponibles avant t) | test avec horloge injectée |
| Bout en bout | collecte → score → intent → refus/paper → ledger → post-mortem sur fixtures, hors ligne | scénario complet |
| Red team global | reprise des 10 angles d'hier sur les nouveaux composants | avant tout live |

# Étape 10 — Ce qui démarre l'implémentation

Deux choses, dans cet ordre. D'abord ton bot : son code, son historique de trades, sa plateforme, ses paramètres (étape 3) — sans lui, l'audit et le point d'intégration restent théoriques, et s'il exécute aujourd'hui avec sa propre clé, c'est la première chose à encadrer. Ensuite ton accord sur l'ordre du plan d'intégration ; les chantiers 1, 2, 4 et 6 peuvent commencer sans le bot, le chantier 3 l'attend.

Rien de ce qui précède ne promet un résultat. Le système livré hier sait déjà refuser ; celui décrit ici doit apprendre à détecter plus tôt, à expliquer ses scores et à mesurer, stratégie par stratégie, ce qui a une valeur prédictive et ce qui n'en a pas.
