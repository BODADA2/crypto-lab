# Crypto Lab — Architecture (contrat entre agents)

Objectif : un laboratoire qui collecte, analyse, propose, exécute dans des limites strictes et apprend.
Capital spéculatif : 1 000 $ CAD. Horizon 5 mois. La cible de 10 000 $ n'est pas une hypothèse du système.

## Trois plans séparés (et pourquoi)

1. **Plan données** — tourne là où le réseau est libre (GitHub Actions cron, ou la machine d'Hervé).
   Collecteurs → fichiers JSON dans `data/` (commités) et/ou Supabase. Aucun secret de trading ici.
2. **Plan analyse** — Claude (sessions planifiées) lit `data/`, `ledger/`, `journal/` via GitHub,
   produit `briefs/YYYY-MM-DD.md` et des **intents** dans `intents/` (propositions, jamais des ordres).
3. **Plan exécution** — uniquement sur la machine d'Hervé (`lab/exec`). Possède la seule clé.
   Lit `intents/`, re-vérifie chaque token localement (RPC + DexScreener), passe chaque intent par le **Risk Engine**
   (code déterministe, politique locale `risk.policy.json` jamais lue depuis le dépôt), exécute via Jupiter (ou en mode
   `paper`), écrit son **ledger local chaîné** sous `~/.crypto-lab/ledger/` et en exporte une copie dans `ledger/`.

## Modèle de menace et garanties (voir `docs/redteam-risk-engine.md`, `lab/README.md` § 5)

Le plan analyse (Claude) peut écrire **n'importe quel fichier du dépôt** : `intents/`, `data/`, `ledger/`, `KILL`,
`package.json` et `lab/**` lui-même. Il ne contrôle ni `~/.crypto-lab/`, ni l'environnement du processus, ni la clé,
ni l'horloge. Rien de ce qu'il écrit ne doit pouvoir, seul, déclencher ou grossir un ordre. Garanties exactes et leurs
conditions :

| Garantie | Mécanisme | Condition |
|---|---|---|
| Le code exécuté est celui qu'Hervé a relu | manifeste SHA-256 de `lab/**` + `package.json`/`package-lock.json`/`tsconfig.json`, scellé dans `~/.crypto-lab/exec.manifest.json` par `npx tsx lab/exec/seal.ts`, vérifié au début de chaque cycle ; écart = refus en live, avertissement en paper | Hervé relit le diff avant de sceller ; jamais `npm run` pour lancer l'exécuteur ; alternative : clone d'exécution séparé sous `~/.crypto-lab/exec/` |
| Le ledger ne peut pas être réécrit depuis le dépôt | source de vérité unique `~/.crypto-lab/ledger/trades.jsonl`, chaque ligne HMAC-SHA256 de la précédente (clé `~/.crypto-lab/ledger.key`) ; rupture = refus du cycle + KILL local ; `ledger/trades.jsonl` du dépôt = export en écriture seule | au premier lancement, le fichier du dépôt est importé comme restrictions seulement (pertes, cadence, doublons) — jamais comme cash ou positions |
| Les qualités d'un token ne peuvent pas être forgées | l'exécuteur construit son propre `TokenSnapshot` (autorités, `decimals`, extensions Token-2022, top 10 depuis le RPC ; prix, liquidité, âge depuis DexScreener), `fetchedAt` = sa propre horloge ; réseau indisponible = rejet ; `priceImpactPct` du devis Jupiter ≤ slippage max | dépend de la fiabilité du RPC et de DexScreener ; `data/tokens/` ne sert qu'au paper `--unverified` |
| Un kill ne se réarme pas seul | cliquet : `KILL` du dépôt vu une fois → `~/.crypto-lab/KILL`, levée manuelle | — |
| Les plafonds sont en CAD réels | SOL via devis Jupiter, CAD/USD via source FX injectable (Banque du Canada), écart > 20 % avec la dernière valeur locale = refus, borne dure en lamports | la première cotation acceptée n'a pas de référence |
| Une marque basse ne libère pas de place | plafonds au max(coût, marque re-vérifiée) ; perte quotidienne/hebdo = réalisé (frais et slippage inclus) + latent ; position sans marque = pas d'achat ; pas de renfort en perte | — |
| On peut toujours sortir | reduce-only : les SELL ne sont bloqués ni par les limites de perte, ni par le drawdown, ni par la fenêtre 2 h–8 h | cadence et expiration s'appliquent encore aux ventes |
| Un intent non conforme est rejeté et journalisé | Risk Engine pur, jamais d'exception, toutes les raisons | — |
| Un veto red team n'est pas levable depuis le dépôt | `lab/redteam/checklist.ts` : `NO_TRADE` sur critère dur (autorités, extensions, top 10, honeypot, liquidité) ou sur critère dur inconnu ; levée uniquement par `humanOverride { by, reason, ts }` passé à l'appel, et le Risk Engine local re-vérifie les critères durs en ignorant tout override | la levée ne concerne que l'analyse ; changer la politique locale reste le seul moyen d'exécuter malgré un critère dur |

Chaîne de décision du plan analyse (chantier 4, fonctions pures dans `lab/`) : `signals/crosscheck.ts` (convergence = nombre
de familles humain / marché / on-chain / projet / macro appuyées par des **causes racines distinctes** — un boost payé qui fait
monter volume, holders et mentions compte pour une famille ; 1 famille = conviction FAIBLE quelle que soit la force) →
`signals/score.ts` (score 0–100, 17 variables, poids publics dans `signals/score.weights.json`, variables absentes = 0 et
listées ; un classement explicable, jamais une chance de succès) → `redteam/checklist.ts` (18 vérifications) →
`decide/route.ts` (RISK > TRADING > STRATEGY > CLAUDE : le refus du Risk Engine en aperçu est définitif ; score ≥ 60,
conviction ≥ MOYENNE, red team ≠ NO_TRADE, couverture ≥ 50 %) avec `decide/tradeVsBuild.ts` (12 critères notés 1–5,
viable ≥ 60 %, préférence à 10 % d'écart, veto si « risque » ou « capital » = 1).

Ce qui reste hors de portée de ces garanties : une machine d'Hervé compromise, un RPC ou DexScreener menteur, l'absence
de confirmation on-chain (comptabilité pessimiste en attendant), et la perte d'une journée qui peut atteindre
`maxDailyLossCad + exposition ouverte + frais` en cas d'effondrement simultané.

## Formats (source de vérité)

- `data/tokens/<mint>.json` : snapshot d'un token (voir `lab/types.ts`).
- `data/scans/<ISO>.json` : sortie d'un cycle de collecte (nouveaux tokens, migrations, trending, volumes).
- `data/wallets/<address>.json` : profil d'un wallet suivi (early-buyer overlap, PnL estimé).
- `intents/<ISO>-<id>.json` : proposition d'action `{ id, createdAt, kind: "BUY"|"SELL"|"NO_ACTION", mint, sizeCad, maxSlippageBps, thesis, signals[], invalidation, expiresAt, signalTs, narrativeTag?, sourceWallet? }`.
- `~/.crypto-lab/ledger/trades.jsonl` (local, chaîné) : une ligne par décision `{ ts, intentId, mint, kind, decision: "PENDING"|"PAPER"|"EXECUTED"|"REJECTED"|"FAILED", mode, reasons[], fill?, fees?, pnlCad?, verified, origin?, seq, prevHmac, hmac }`. `ledger/trades.jsonl` du dépôt en est l'export (lecture seule pour tous les plans).
- `journal/hypotheses.jsonl` : `{ id, createdAt, hypothesis, signal, data, decision, result?, error?, return?, drawdown?, context }`.
- `briefs/YYYY-MM-DD.md` : brief du matin (MARKET / NARRATIVES / ON-CHAIN / OPPORTUNITIES / DEV / TRADING / RISKS / AUTOMATION / UNKNOWN).
- `KILL` (fichier à la racine du dépôt) OU `~/.crypto-lab/KILL` (local) OU `CRYPTO_LAB_KILL` : toute exécution s'arrête. Le `KILL` du dépôt, une fois vu, crée le `KILL` local (cliquet, levée manuelle).

## Politique de risque (valeurs initiales, modifiables uniquement à la main, localement)

- Capital de trading : 700 $ CAD (300 $ réservés aux opérations du lab : illustration, DexScreener, frais de lancement).
- Taille max par position : 50 $ CAD ; positions simultanées max : 4 ; exposition max : 200 $ CAD.
- Perte max quotidienne : 70 $ CAD (10 %) → blocage jusqu'au lendemain. Perte max hebdomadaire : 140 $ → blocage 7 jours.
- Drawdown max depuis le pic : 35 % du capital de trading → arrêt total, revue humaine obligatoire.
- Slippage max : 3 % ; liquidité min du pool : 20 000 $ ; âge min du token : 10 min ; pas de token avec freeze authority ou mint authority.
- Un seul ordre par mint par heure ; pas d'**achat** entre 2 h et 8 h (America/Moncton — personne ne surveille) ; les ventes restent possibles (reduce-only).
- Plafonds calculés au max(coût, marque) ; pas de renfort d'une position en perte ; perte quotidienne = réalisé + latent.
- Chaque intent expire (défaut 30 min). Chaque ordre est journalisé avant et après.
- **Politique v2** (`lab/risk/policy.example.json`, `"version": 2`) — règles qui ne bloquent que les achats :
  - corrélation : au plus 2 positions ouvertes partageant le même `narrativeTag` ou le même `sourceWallet` (intent
    compris), exposition cumulée par tag ou wallet ≤ `maxExposureCad / 2` (100 $) ;
  - série de pertes : 3 ventes perdantes consécutives → aucun achat pendant 24 h ;
  - budget d'erreurs : 3 exécutions `FAILED` en 24 h → aucun achat ;
  - âge du signal : un BUY dont `signalTs` a plus de 20 min (ou est absent) est rejeté.
  Les étiquettes (`narrativeTag`, `sourceWallet`, `signalTs`) sont portées par l'intent et recopiées dans le ledger local ;
  elles sont auto-déclarées par le plan analyse (limite documentée dans `lab/README.md`).
- **Toute modification de `lab/` — y compris de ces règles — exige de re-sceller le manifeste** (`npx tsx lab/exec/seal.ts`
  après relecture du diff), sinon refus total en live.
- Mode `paper` par défaut. Le mode `live` exige `--live` ET `EXECUTION_MODE=live` ET une clé locale ET un vérificateur local (RPC) ET l'absence de `KILL` ET un code scellé identique au manifeste.

## Conventions de code

TypeScript strict, ESM, Node 22 (fetch natif), zéro dépendance inutile, tests vitest, fixtures pour tout ce qui touche au réseau.
Chaque module expose des fonctions pures testables ; les appels réseau sont injectés.
Commentaires en français. Aucun agent n'écrit dans `risk.policy.json`.
