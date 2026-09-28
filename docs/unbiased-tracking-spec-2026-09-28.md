# Spec — suivi non biaisé dès le create + fix late-discovery

**Date :** 2026-09-28 (nuit) · **Statut :** spécification, non implémentée.
**Contexte :** l'audit late-discovery (`docs/audit-late-discovery-2026-09-28.md`) et le backtest
momentum-confirm (`docs/second-filter-2026-09-28.md`) montrent que le blocage est désormais
**données, pas seuils** : (1) le flux `create` mélange observations à la création et découvertes
tardives ; (2) `data/history` ne suit que des tokens chauds avec des snapshots clairsemés ;
(3) aucun P&L n'est mesurable honnêtement dans ces conditions.
**Principe de non-régression :** ne rien casser au collecteur existant — tout ce qui suit est
un **process séparé**, rejouable, supprimable sans effet sur le collecteur ni le cron.

## 1. Fix late-discovery (collecteur existant — changement minimal, flag seulement)

Ajouter au pipeline `create` une détection sans changer le stockage existant :

```
late_discovery = (vSolInBondingCurve >= 85)
              OU (solAmount, vSol, vTokens, mcapSol) == tuple_constant_85.005359057
```

Si `late_discovery` : `devBuy := INCONNU` (ne pas utiliser `solAmount`), conserver l'événement
avec le flag. Re-jouer tout backtest create-time avec `WHERE NOT late_discovery` avant
réutilisation de ses chiffres. Effort estimé : ~30 lignes + re-run des scripts d'audit.

## 2. Suivi non biaisé — protocole `track-unbiased`

### 2.1 Univers et échantillonnage
- À chaque `create` genuine (flag ci-dessus appliqué) : tirage aléatoire **sans remise par
  fenêtre**, probabilité d'inclusion `p = 5 %` (seed journalier fixé, ex. `seed = YYYYMMDD`,
  pour rejouabilité exacte).
- Cap : max 800 tokens suivis simultanément (recalibré §6/F8 : ~525 concurrents
  attendus à 21 000 creates/jour) ; si dépassement : nouveaux refusés avec motif
  `dropped[]`, jamais de troncature des courbes en cours.
- **Strates conservées** : `late_discovery` / genuine, outil (domaine), heure — pour audits,
  pas pour le filtrage.

### 2.2 Cadence de snapshots (par token suivi)
- **Pré-migration** (depuis le create) : 1 snapshot / 5 min pendant 12h (ou jusqu'à migration).
- **Post-migration** : 1 snapshot / 2 min pendant 60 min, puis 1 / 15 min pendant 48h.
- Chaque snapshot : `mint, ts, priceUsd, mcapUsd, buys/sells m5+m15+m30, volume m5,
  vSolInBondingCurve (si dispo), liquidityUsd (si dispo)`.

### 2.3 Stockage
- Nouveau répertoire `data/track-unbiased/YYYY-MM-DD/<mint>.jsonl` — jamais mélangé à
  `data/history/` (qui reste le flux "chaud" historique).
- Manifest journalier : `data/track-unbiased/YYYY-MM-DD/manifest.json`
  `{seed, p, sampled_mints[], started_at, dropped[]}`.

### 2.4 Ce que ça ne fait PAS
- Pas de filtre sur le social, le narratif ou la chaleur : **l'échantillon est aléatoire**,
  c'est le point.
- Pas de décision de trading : écriture seule.
- Pas de modification du collecteur existant, du cron, du paper-engine ni du Risk Engine.

## 3. Ce que ça débloque (dans l'ordre)

1. **P&L honnête** des stratégies create→migration et migration→continuation, avec entrées
   exécutables (snapshots denses) et univers non sélectionné sur la chaleur.
2. **Re-test de momentum-confirm** (`docs/second-filter-2026-09-28.md` §3) avec entrée dans
   les minutes du signal — la question reste ouverte, les données actuelles ne permettaient
   pas d'y répondre.
3. **H-POSTMIG** (mouvements ±60 min autour de la migration) avec des courbes complètes,
   pas des points clairsemés.
4. **H-DEV** (comportement dev) si un jour les wallets sont suivis : le cadre d'échantillonnage
   est déjà en place.

## 4. Critères d'arrêt / de succès

- Succès : 30 jours de collecte → n ≥ 500 tokens suivis avec courbes complètes → re-run
  des backtests create-time et momentum-confirm sur cet univers.
- Arrêt : coût API/rate-limit > budget, ou doublon avec une source existante équivalente.
- Le collecteur existant et le cron continuent inchangés pendant toute la phase.

## 5. Effort estimé

- Fix §1 : ~0.5 jour (flag + re-run).
- §2 : 2–4 jours (process isolé + manifest + tests n≥30 sur le pipeline lui-même).
- Ne pas implémenter de nuit sans revue : toucher au pipeline de données en production
  (collecteur auto actif) exige une relecture à tête reposée.

---
*Spécification rédigée le 2026-09-28. Aucune ligne de production modifiée.*

## 6. Relecture critique (2026-09-28, nuit) — verdict : VALIDÉE AVEC AJUSTEMENTS

Aucun risque bloquant trouvé. La règle de détection a été validée empiriquement sur 5 jours
(68 466 creates) : `vSolInBondingCurve >= 85` à la première observation donne **0 faux positif**
sur 67 845 creates genuine (max genuine observé : vSol = 84,32, devBuy max = 54,32 SOL) et
capture 14 late-discoveries supplémentaires que le tuple exact ne voyait pas. Le test du
tuple est subsumé par `vSol >= 85` (tuple ⇒ vSol = 115) et est abandonné par simplification.
Aucune implémentation n'a été refusée ; les ajustements ci-dessous sont appliqués.

### Failles cherchées → décisions

- **F1 — Contradiction spec** (§1 titre « flag seulement » vs corps « devBuy := INCONNU ») :
  **flag-only**. Le `solAmount` brut est conservé (c'est une donnée réelle reçue ; la détruire
  serait irréversible). Les consommateurs filtrent avec `WHERE NOT late_discovery`.
- **F2 — Source des snapshots non nommée** : **DexScreener `getSnapshots`** (batch de 30,
  client existant, limiteur 60 req/min intégré ; besoin estimé < 10 req/min).
- **F3 — Règle « une seule connexion » PumpPortal ignorée** (bannissement 1 h sinon) :
  le tracker **n'ouvre aucun websocket**. Il consomme les scan files via un git worktree
  détaché en sparse-checkout (`data/scans` uniquement) + `git fetch` périodique (lecture
  seule). Zéro risque pour le collecteur prod.
- **F4 — Supervision du process 24/7 non adressée** : le tracker tourne en **mode borné
  `--duration-min`** (boucle interne à 30 s, façon `runPump`), relancé par cron ; reprise
  idempotente via manifests ; verrou PID (`.lock`) contre les chevauchements.
- **F5 — Sémantique d'échantillonnage floue** (« sans remise par fenêtre » + p = 5 %) :
  **inclusion déterministe** `sha256("track-unbiased:"+dateUTC+":"+mint) < 5 %`.
  Reproductible, idempotente au redémarrage, sans état. Date UTC pinnée (les scans sont UTC).
- **F6 — Détection de migration non spécifiée** : double mécanisme — (a) événements
  `migrate` du flux (lag ~10-15 min, backfill/vérification), (b) **snapshot** : le `dexId`
  de la paire la plus liquide n'est plus `pumpfun` (cf. `snipe.ts:pickSolPair`). Le snapshot
  de détection (≤ 5 min après migration) devient le premier point post-migration.
- **F7 — Reprise au redémarrage** : manifests du jour J et J-1 rechargés ; `nextDue`
  dérivé du dernier snapshot ; `receivedAt` (flux) ET `discoveredAt` (tracker) enregistrés.
- **F8 — Biais du cap 200 + FIFO** : à l'état stable ~106 tokens concurrents < 200, le cap
  ne déclenchera quasiment jamais. En cas de dépassement : **nouveaux refusés**
  (courbes en cours gardées complètes), `dropped[]` avec motif au manifest. Le biais
  (sous-échantillonnage des périodes chargées) est documenté pour l'analyse.
  **Recalibrage empirique (bootstrap 2026-09-28)** : ~21 000 creates/jour observés
  (vs ~13 700/jour sur la fenêtre d'audit) → 5 % ≈ 1 050 tokens/jour → ~525 concurrents
  en fenêtre pré-migration (12 h) + ~30 en post-migration. Le cap de 200 était déjà
  insuffisant avec les hypothèses de la spec (325 concurrents) — l'estimation « ~106 »
  de la relecture initiale était fausse. **Cap porté à 800** (~50 % de marge ;
  coût API < 6 req/min pour un limiteur à 60/min). En cas de dépassement persistant :
  nouveaux refusés, `dropped[]` avec motif, sans troncature des en-cours.
- **F9 — `chainregime.ts` contaminé** (somme des `solAmount` incluant les 85.005) :
  **hors scope** — le corriger changerait les entrées du paper engine, ça exige sa propre
  validation. Suivi à part.
- **F10 — Lignes historiques sans le flag** : helper `lateDiscoveryOf(ev)` =
  `ev.lateDiscovery ?? detectLateDiscovery(ev)` ; détecteur pur exporté et partagé.
- **F11 — Frontière minuit UTC** : le seed est la date UTC **du create**, pas du jour
  courant ; les tokens en cours restent rattachés à leur manifest d'origine.
- **F12 — Rétention disque** : ~360 Mo / 30 j estimés — accepté, pas de purge (c'est le
  but de la collecte).
- **F13 — Lag ~10-15 min sur les creates** (cadence des commits data) : le manifest
  l'enregistre honnêtement ; le P&L mesuré sera celui **exécutable avec la latence du
  lab** (entrée ≥ discoveredAt) — c'est d'ailleurs la bonne question pour le paper engine.
- **F14 — Zone grise 80–85 SOL** : un token découvert à vSol = 84 reste compté genuine
  (un vrai whale à 54 SOL de devBuy existe : max observé 54,32). Conservateur par design ;
  noté comme limite.
- **F15 — Interférence avec le cron 08h23** : le tracker n'écrit QUE dans
  `data/track-unbiased/` et lit le worktree ; le `git fetch` ne touche pas à la branche
  de travail. Aucun fichier partagé.
- **F16 — Tokens `pool: "bonk"`** : jamais de `vSol` → la règle ne peut pas se déclencher
  (ni faux positif, ni détection — limite documentée) ; inclus dans l'échantillonnage
  au prorata, snapshots DexScreener identiques.
- **F17 — Doublons de creates** : dédupliqué par mint (premier create gagne, comme l'audit).
- **F18 — Cadence effective** : tick interne 30 s ; snapshots dus par batch ; erreurs
  réseau/API non fatales (réessayées au tick suivant), jamais de crash sur un token.
