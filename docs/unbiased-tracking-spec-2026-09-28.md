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
- Cap : max 200 tokens suivis simultanément ; file FIFO si dépassement.
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
