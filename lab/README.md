# Plan exécution — `lab/`

Ce dossier contient la seule partie du Crypto Lab qui peut toucher au capital. Elle tourne **uniquement sur la machine
d'Hervé**. Claude produit des *intents* (propositions) ; ce code les passe au Risk Engine et journalise tout dans un
ledger local. Voir `ARCHITECTURE.md` à la racine pour le contrat entre les trois plans et `docs/redteam-risk-engine.md`
pour le modèle de menace : **le plan analyse peut écrire n'importe quel fichier du dépôt, y compris ce code**. Tout ce
qui suit est conçu pour que rien de ce que contient le dépôt ne puisse, seul, déclencher ou grossir un ordre.

```
lab/
├── types.ts              types partagés (TokenSnapshot, Intent, LedgerEntry, RiskPolicy, PortfolioState…)
├── time.ts               fuseau horaire, clés jour / semaine ISO, dates ISO strictes (fuseau obligatoire)
├── risk/engine.ts        Risk Engine pur : evaluate(), loadPolicy(), validatePolicy() — politique v1 et v2
├── risk/types.ts         extensions v2 (RiskPolicyV2, IntentV2, LedgerEntryV2) en attendant la fusion dans types.ts
├── risk/policy.example.json   valeurs initiales (version 2) — à COPIER hors du dépôt, jamais lues d'ici
├── signals/crosscheck.ts cross-check multi-signal : convergence 0–5 = familles INDÉPENDANTES (causes racines distinctes)
├── signals/score.ts      score 0–100 explicable, 17 variables, poids publics dans signals/score.weights.json
├── redteam/checklist.ts  red team codé : 18 vérifications → OK/WARN/VETO/UNKNOWN, verdict NO_TRADE sur critère dur
├── decide/route.ts       MEMECOIN_TRADE | CRYPTO_TRADE | NO_TRADE | BUILD | TRADE_AND_BUILD
├── decide/tradeVsBuild.ts grille TRADE vs BUILD à 12 critères (1–5), seuils explicites
├── exec/integrity.ts     manifeste SHA-256 du code exécuté, comparé au manifeste scellé (C1)
├── exec/seal.ts          CLI de scellement, lancé par Hervé après relecture du diff
├── exec/killswitch.ts    isKilled() — 3 sources, cliquet local (C4)
├── exec/verify.ts        re-vérification locale d'un token : RPC + DexScreener, clients injectables (C3)
├── exec/paper.ts         simulateur (slippage, frais, PnL, marque-à-marché)
├── exec/executor.ts      boucle d'exécution + CLI
├── swap/jupiter.ts       client Jupiter (live), cotation SOL, signataire local, réseau injectable
├── ledger/ledger.ts      JSONL atomique, ledger local CHAÎNÉ (HMAC), export, reconstruction, drawdown, PnL
└── journal/journal.ts    hypothèses + rapport hebdomadaire (WHAT WORKED / FAILED / MISSED / TO CHANGE)
```

## 1. Installation sur la machine locale

Prérequis : Node 22+, `npm install` à la racine du dépôt.

```bash
mkdir -p ~/.crypto-lab && chmod 700 ~/.crypto-lab
cp lab/risk/policy.example.json ~/.crypto-lab/risk.policy.json   # puis éditer à la main si besoin
chmod 600 ~/.crypto-lab/risk.policy.json
```

Fichiers sous `~/.crypto-lab/` (aucun n'est dans le dépôt, Claude n'y a pas accès) :

| Fichier | Rôle | Créé par |
| --- | --- | --- |
| `risk.policy.json` | politique de risque | Hervé (copie de l'exemple) |
| `exec.manifest.json` | manifeste SHA-256 du code scellé | `npx tsx lab/exec/seal.ts` |
| `ledger/trades.jsonl` | **ledger local chaîné, source de vérité unique** | l'exécuteur |
| `ledger.key` | clé HMAC du ledger (32 octets, mode 600) | l'exécuteur, au premier lancement |
| `market.json` | dernières cotations acceptées (FX, SOL) pour les bornes de vraisemblance | l'exécuteur |
| `keypair.json` | clé du portefeuille (live uniquement) | Hervé (`solana-keygen`) |
| `KILL` | kill switch local (créé aussi par le cliquet) | Hervé ou l'exécuteur |

`~/.crypto-lab/risk.policy.json` est la **politique de risque locale**. Le code refuse de charger un fichier de politique
situé dans le dépôt (même via `RISK_POLICY_PATH`, même à travers un lien symbolique). Pour la placer ailleurs que dans
`~/.crypto-lab/`, exporter `RISK_POLICY_PATH=/chemin/hors/du/depot/risk.policy.json`.

Champs (voir `RiskPolicy` dans `types.ts`) : `tradingCapitalCad` (700), `maxPositionSizeCad` (50), `maxOpenPositions`
(4), `maxExposureCad` (200), `maxDailyLossCad` (70), `maxWeeklyLossCad` (140), `maxDrawdownPct` (35 % du capital de
trading), `maxSlippageBps` (300), `minLiquidityUsd` (20 000), `minTokenAgeMinutes` (10), `allowMintAuthority` /
`allowFreezeAuthority` (false), `maxTop10Pct` (40), `minOrderIntervalPerMintMinutes` (60), `forbiddenWindow`
(`{ startHour: 2, endHour: 8, timeZone: "America/Moncton", blockSells: false }`), `defaultIntentTtlMinutes` (30),
`maxSnapshotAgeMinutes` (15), `allowSizeAdjustment` (false : un BUY trop gros est rejeté plutôt que réduit),
`minOrderSizeCad` (10), `allowAveragingDown` (false : pas de renfort d'une position en perte).

**Politique v2** (`"version": 2`, quatre champs requis ; une politique v1 reste acceptée et n'applique aucune de ces
règles) — toutes ne bloquent que les **achats**, le reduce-only est intégralement préservé :

| Champ | Défaut | Règle | Raison de rejet |
| --- | --- | --- | --- |
| `maxCorrelatedPositions` | 2 | positions ouvertes (autres mints) partageant le `narrativeTag` **ou** le `sourceWallet` de l'intent, position demandée comprise ; exposition cumulée par tag/wallet ≤ `maxExposureCad / 2` | `CORRELATION_NARRATIF`, `CORRELATION_WALLET`, `EXPOSITION_NARRATIF`, `EXPOSITION_WALLET` |
| `maxConsecutiveLosses` | 3 | N ventes perdantes consécutives (PAPER/EXECUTED, tous modes, par `ts`) dont la dernière date de moins de 24 h ; un gain ou un PnL nul remet à zéro | `SERIE_DE_PERTES` (achats bloqués 24 h après la dernière perte) |
| `executionErrorBudget` | 3 | N lignes `FAILED` dans les 24 dernières heures | `BUDGET_ERREURS` |
| `maxSignalAgeMinutes` | 20 | `now − intent.signalTs` ; `signalTs` (ISO 8601 avec fuseau) devient **obligatoire** pour un BUY | `SIGNAL_PERIME`, `SIGNAL_TS_MANQUANT`, `SIGNAL_FUTUR` |

Validation : entiers ≥ 1 (sauf `maxSignalAgeMinutes` ≥ 0), `maxCorrelatedPositions ≤ maxOpenPositions`. Pour la
corrélation, l'exécuteur recopie `narrativeTag` / `sourceWallet` de l'intent dans la ligne de ledger (`PENDING`, puis
`PAPER`/`EXECUTED`) ; les étiquettes d'une position sont lues sur son achat rempli le plus récent. **Limite honnête** :
les étiquettes sont auto-déclarées par le plan analyse ; un intent sans étiquette, ou avec une étiquette inédite,
n'est corrélé à rien. La règle protège contre l'erreur (quatre thèses « IA » ouvertes sans s'en rendre compte), pas
contre un plan analyse qui voudrait la contourner — pour cela il reste `maxOpenPositions` et `maxExposureCad`.
Le fichier est validé au chargement : toute valeur manquante, hors bornes ou incohérente bloque l'exécuteur.
**Tout changement dans `lab/` (dont ces règles) modifie le manifeste : re-sceller avec `npx tsx lab/exec/seal.ts`
après relecture, sinon refus total en live.**

### Sceller le code (obligatoire avant tout live)

Le dépôt est modifiable par le plan analyse. Après chaque `git pull`, **relire le diff de `lab/`, `package.json`,
`package-lock.json` et `tsconfig.json`**, puis sceller :

```bash
git log -p --stat HEAD@{1}..HEAD -- lab package.json package-lock.json tsconfig.json   # relecture
npx tsx lab/exec/seal.ts            # écrit ~/.crypto-lab/exec.manifest.json
npx tsx lab/exec/seal.ts --check    # état : sealed / mismatch (liste des fichiers) / unsealed
```

L'exécuteur recalcule le manifeste **au début de chaque cycle, avant même le kill switch**. Tout écart (fichier modifié,
ajouté ou supprimé) ou l'absence de manifeste = **refus total en live** (`CODE_NON_SCELLE`), avertissement en paper.
Le manifeste couvre le code réellement chargé (le dossier `lab/` qui contient l'exécuteur), pas le dépôt de données
passé en `--repo`.

**Alternative recommandée — clone d'exécution séparé.** Garder une copie du code hors du dépôt de travail :

```bash
git clone <url> ~/.crypto-lab/exec          # clone dédié, mis à jour UNIQUEMENT à la main après relecture
cd ~/.crypto-lab/exec && npm ci && npx tsx lab/exec/seal.ts
npx tsx ~/.crypto-lab/exec/lab/exec/executor.ts --once --paper --repo ~/src/crypto-lab
```

`--repo` désigne le dépôt de données (intents, `data/`, export du ledger) ; le code exécuté et son manifeste restent sous
`~/.crypto-lab/exec/`, qu'aucun `git pull` du dépôt de travail ne touche. Claude n'a jamais d'accès à `~/.crypto-lab/`.

### Ne jamais lancer via `npm run` — script de lancement hors du dépôt

`package.json` est dans le dépôt : un script npm pourrait fixer `EXECUTION_MODE=live`, `RISK_POLICY_PATH` ou `--live` à
l'insu d'Hervé. La règle est donc : **jamais `npm run` pour l'exécuteur** ; `package.json` ne contient et ne doit jamais
contenir de script `exec`/`live`/`watch` (un test le vérifie). Fixer la commande et l'environnement dans un script de
lancement hors du dépôt, par exemple `~/.crypto-lab/bin/exec.sh` :

```bash
#!/usr/bin/env bash
set -euo pipefail
export SOLANA_RPC_URL="https://…"            # RPC utilisé pour la vérification locale (obligatoire)
# export EXECUTION_MODE=live                  # à décommenter en connaissance de cause
exec npx tsx ~/.crypto-lab/exec/lab/exec/executor.ts --once --paper --repo "$HOME/src/crypto-lab"
```

### Clé (mode live uniquement)

```bash
solana-keygen new --outfile ~/.crypto-lab/keypair.json   # ou copier une clé dédiée au lab
chmod 600 ~/.crypto-lab/keypair.json
```

Utiliser un portefeuille **dédié**, alimenté uniquement du capital de trading. La clé ne quitte jamais cette machine :
le signataire (`swap/jupiter.ts#loadSigner`) signe localement, Jupiter ne voit que la transaction signée.

## 2. Lancer l'exécuteur

```bash
# un cycle, simulation (défaut), avec vérification locale des tokens (SOLANA_RPC_URL requis)
SOLANA_RPC_URL=https://… npx tsx lab/exec/executor.ts --once --paper

# paper hors ligne, explicitement NON vérifié (aucune valeur probante ; les instantanés du dépôt sont pris tels quels)
PAPER_FX_CAD_PER_USD=1.37 PAPER_SOL_PRICE_USD=150 npx tsx lab/exec/executor.ts --once --paper --unverified

# en boucle toutes les 60 s (--watch 30 pour 30 s)
npx tsx lab/exec/executor.ts --paper

# live : les conditions sont TOUTES exigées, sinon refus total (rien n'est traité)
EXECUTION_MODE=live SOLANA_RPC_URL=https://… npx tsx lab/exec/executor.ts --once --live
#   1. code scellé et identique au manifeste
#   2. EXECUTION_MODE=live dans l'environnement ET --live sur la ligne de commande
#   3. ~/.crypto-lab/keypair.json présent et valide
#   4. vérificateur local disponible (SOLANA_RPC_URL)
#   5. aucun kill switch actif
```

Variables : `SOLANA_RPC_URL` (vérification locale + envoi), `JUPITER_API_KEY` (optionnel), `PRIORITY_FEE_SOL` (défaut
0.0005), `RISK_POLICY_PATH`, `CRYPTO_LAB_KILL`, `PAPER_FX_CAD_PER_USD` / `PAPER_SOL_PRICE_USD` (paper hors ligne
seulement). Il n'y a **aucune constante de marché** dans le code : le taux CAD/USD vient de la Banque du Canada
(`FXUSDCAD`) et le prix de SOL d'un devis Jupiter 1 SOL → USDC au moment du cycle ; en live, le prix de SOL vient
toujours du devis, quelle que soit la source injectée. Chaque cotation est comparée à la dernière valeur acceptée
(`market.json`) : écart > 20 % = refus du cycle (`MARCHE_INVRAISEMBLABLE`), à lever à la main en supprimant le fichier
après vérification.

Déroulé d'un cycle (`runOnce`) :

1. Intégrité du code (manifeste) → live : refus ; paper : avertissement.
2. Kill switch → si actif, sortie immédiate, rien n'est écrit ni déplacé. Si c'est le `KILL` du dépôt qui est vu,
   `~/.crypto-lab/KILL` est créé (cliquet).
3. Chargement et validation de la politique locale.
4. Vérificateur local ; en live : vérification des cinq conditions.
5. Ledger local : clé HMAC, import restrictif du ledger du dépôt au tout premier lancement (voir § 4), vérification de
   la chaîne. Chaîne rompue → refus du cycle **et** `KILL` local (revue humaine).
6. Cotations réelles + bornes de vraisemblance.
7. Clôture en `FAILED` des `PENDING` orphelins (cycle précédent interrompu).
8. Pour chaque `intents/*.json` (ordre alphabétique = chronologique) : lien symbolique → rejet sans lecture ; JSON ;
   mint validé (base58) **avant** tout accès disque ou réseau ; **instantané construit localement** (RPC : autorités,
   décimales, extensions Token-2022, top 10 ; DexScreener : prix, liquidité, âge de la paire ; `fetchedAt` = horloge de
   l'exécuteur) ; marques des positions ouvertes re-vérifiées de la même façon ; reconstruction du portefeuille depuis le
   ledger local ; `evaluate()` → si refus : ligne `REJECTED` avec toutes les raisons ; sinon ligne `PENDING` **avant**
   l'exécution, exécution (paper ou Jupiter), ligne `PAPER` / `EXECUTED` / `FAILED` **après** ; déplacement du fichier
   dans `intents/processed/`. Le kill switch est revérifié avant chaque intent.
9. Export du ledger local vers `ledger/trades.jsonl` du dépôt (écriture seule, jamais relu).

En live, avant signature : `priceImpactPct` du devis Jupiter comparé à `maxSlippageBps` (impact > slippage max =
`FAILED`, avant tout envoi), borne dure en lamports (`≤ maxPositionSizeCad / FX / SOL` avec les cotations réelles),
`decimals` lu du RPC. Comptabilité pessimiste tant qu'il n'y a pas de confirmation on-chain : produit d'une vente =
devis × (1 − slippage max) − frais ; loyer du compte de token (≈ 0,002 SOL) compté dans les frais d'une nouvelle position.

## 3. Activer / désactiver

| Action | Commande |
| --- | --- |
| Tout arrêter (local) | `touch ~/.crypto-lab/KILL` |
| Tout arrêter (partagé, visible de Claude et de GitHub) | `touch KILL` à la racine du dépôt et commit |
| Tout arrêter pour un lancement | `CRYPTO_LAB_KILL=1 npx tsx lab/exec/executor.ts --once` |
| Réactiver | supprimer **`~/.crypto-lab/KILL`** à la main (le retrait du `KILL` du dépôt ne suffit jamais), retirer la variable |
| Bloquer le live sans bloquer le paper | ne pas exporter `EXECUTION_MODE=live` (ou supprimer `keypair.json`) |

N'importe laquelle des trois sources suffit. `CRYPTO_LAB_KILL` tue pour toute valeur non vide sauf `0`, `false`, `no`,
`off`. Une erreur d'accès disque lors de la vérification vaut « kill actif ». Le cliquet : dès que le `KILL` du dépôt a
été vu une fois, `~/.crypto-lab/KILL` existe et seul Hervé peut le retirer. En `--watch`, l'environnement du processus
est figé : `CRYPTO_LAB_KILL` ne peut pas être ajouté après coup, mais les fichiers `KILL` restent efficaces.

## 4. Formats

### Intents

`intents/<ISO>-<id>.json` — une proposition, jamais un ordre :

```json
{
  "id": "2026-09-24T15-00-00Z-abc123",
  "createdAt": "2026-09-24T15:00:00Z",
  "kind": "BUY",
  "mint": "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs",
  "sizeCad": 40,
  "maxSlippageBps": 200,
  "thesis": "Volume 5 min ×8, migration Raydium il y a 25 min, 3 wallets suivis entrés",
  "signals": ["volume-spike-5m", "early-buyer-overlap"],
  "invalidation": "Prix < -30 % ou liquidité < 15 k$",
  "expiresAt": "2026-09-24T15:30:00Z",
  "signalTs": "2026-09-24T14:52:00Z",
  "narrativeTag": "ai-agents",
  "sourceWallet": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
}
```

- `kind` : `BUY`, `SELL` ou `NO_ACTION` (journalisé, jamais exécuté).
- `signalTs` : horodatage du signal à l'origine de l'intent — obligatoire pour un BUY avec une politique v2
  (`maxSignalAgeMinutes`). `narrativeTag` (thème de la thèse, normalisé trim + minuscules) et `sourceWallet` (base58)
  sont optionnels et servent à la corrélation entre positions. Un champ `humanOverride` dans un intent n'a **aucun**
  effet : le Risk Engine ne le lit pas.
- `sizeCad` : pour un BUY, cash engagé (frais inclus) ; pour un SELL, notionnel à vendre au prix courant — un montant
  supérieur à la valeur de la position vend tout.
- Dates ISO 8601 **avec fuseau** (`Z` ou `±HH:MM`) ; toute autre forme est rejetée. `expiresAt` est borné par
  `defaultIntentTtlMinutes` à partir de `createdAt` : un intent est de toute façon mort 30 min après sa création.
- Tous les champs sont obligatoires pour BUY/SELL ; un champ manquant ou mal typé = rejet. Un fichier qui est un lien
  symbolique = rejet sans lecture.
- Les fichiers `data/tokens/<mint>.json` du dépôt ne sont **jamais** la base d'une décision : l'exécuteur construit son
  propre instantané. Ils ne servent qu'en paper `--unverified` (hors ligne), sans valeur probante.

### Ledger

`~/.crypto-lab/ledger/trades.jsonl` (local, source de vérité) contient une ligne par décision : `{ ts, intentId, mint,
kind, decision, mode, reasons[], requestedSizeCad, sizeCad?, fill?, fees?, pnlCad?, equityAfterCad?, verified,
origin?, seq, prevHmac, hmac }`. `hmac` = HMAC-SHA256(`ledger.key`, `seq|prevHmac|json(ligne)`) : toute ligne modifiée,
insérée, supprimée au milieu ou réordonnée rompt la chaîne. `ledger/trades.jsonl` du dépôt en est une **copie exportée
à chaque cycle**, lue par Claude et jamais par l'exécuteur ; la modifier n'a aucun effet.

Au **tout premier lancement** (aucun ledger local), le fichier du dépôt est importé avec `origin: "repo-import"` : ces
lignes ne créent **ni cash ni position** (elles pourraient être inventées) et ne servent qu'à **restreindre** : pertes
(seuls les PnL négatifs comptent), cadence par mint, doublons d'id. Pour migrer d'une machine à l'autre, copier
`~/.crypto-lab/ledger/` et `ledger.key`, pas le fichier du dépôt.

Les remplissages `paper` et `live` cohabitent mais sont rejoués séparément (`rebuildPortfolio(..., { mode })`).

## 5. Garanties de sécurité et leurs conditions

| Garantie | Mécanisme | Condition / limite |
| --- | --- | --- |
| Le code exécuté est celui qu'Hervé a relu | manifeste SHA-256 de `lab/**` + fichiers racine, vérifié à chaque cycle | Hervé relit le diff avant `seal.ts` ; ne protège pas d'un `node_modules` altéré (utiliser `npm ci` depuis le lock scellé) ni de l'hôte compromis |
| Le ledger ne peut pas être réécrit depuis le dépôt | ledger local chaîné HMAC, export en écriture seule | la clé et le fichier sont sous `~/.crypto-lab` ; une troncature de fin de fichier n'est pas détectable par la chaîne seule |
| Les qualités du token ne peuvent pas être forgées | instantané construit par l'exécuteur (RPC + DexScreener), `fetchedAt` = maintenant, `decimals` RPC | dépend de la fiabilité du RPC et de DexScreener ; `priceImpactPct` du devis Jupiter est la seule mesure de liquidité non falsifiable avant envoi |
| Un kill ne se réarme pas seul | cliquet : `KILL` du dépôt → `~/.crypto-lab/KILL` | levée manuelle uniquement |
| Les plafonds sont en CAD réels | SOL via devis Jupiter, FX Banque du Canada, écart > 20 % vs dernière valeur = refus, borne dure en lamports | la première valeur acceptée n'a pas de référence ; `market.json` est local |
| Une marque basse ne libère pas de place | plafonds par mint et exposition au max(coût, marque) ; refus d'achat si une position n'a pas de marque récente ; pas de renfort en perte | — |
| On peut toujours sortir | reduce-only : pertes quotidienne/hebdo, drawdown et fenêtre 2 h–8 h ne bloquent pas les SELL | la cadence (1 ordre/mint/heure) et l'expiration s'appliquent encore aux ventes |
| Le Risk Engine est pur et déterministe | aucune E/S, jamais d'exception, toutes les raisons accumulées | ses entrées sont désormais locales (ledger, instantané, politique, horloge) |
| Journalisation avant et après chaque ordre | `PENDING` puis `PAPER`/`EXECUTED`/`FAILED`, ajout atomique, orphelins clôturés | — |
| Live triple opt-in | `--live` + `EXECUTION_MODE=live` + clé locale + vérificateur + pas de kill + code scellé | — |
| Un veto red team n'est pas levable depuis le dépôt | `redteam/checklist.ts` ne lève un `NO_TRADE` que par `humanOverride { by, reason, ts }` passé à l'appel (< 24 h, raison ≥ 10 caractères) et ne rend jamais `OK` après levée ; le Risk Engine local re-vérifie de toute façon autorités, extensions, top 10 et liquidité sur SON instantané et ignore tout override | la levée n'a d'effet que sur l'analyse ; exécuter malgré un critère dur exige de changer la politique locale à la main |
| Le système ralentit quand il perd ou casse | politique v2 : série de pertes (3 → achats bloqués 24 h), budget d'erreurs d'exécution (3 `FAILED`/24 h), corrélation par narratif et wallet source, âge du signal | étiquettes auto-déclarées (voir § 1) ; les ventes ne sont jamais bloquées |

### Limites connues (honnêtes)

- **Perte maximale d'une journée** : la limite de 70 $ compte le réalisé **et** la perte latente des positions marquées,
  et bloque les *achats* ; elle ne bloque jamais une vente. Une journée peut donc perdre jusqu'à
  `maxDailyLossCad + exposition ouverte + frais` si tout s'effondre d'un coup. Le drawdown (35 %) reste le dernier filet.
- Pas encore de **confirmation on-chain** : un `txid` journalisé peut correspondre à une transaction finalement rejetée ;
  le produit d'une vente est estimé de façon pessimiste (devis × (1 − slippage max)). Pas de réconciliation automatique
  solde réel / ledger : à faire à la main (`solana balance`) tant que ce n'est pas implémenté.
- Le mode paper simule au prix vérifié dégradé du slippage max ; il ne modélise ni l'impact de marché réel, ni l'échec
  de transaction, ni les tokens invendables. Un PnL paper positif n'est pas une preuve — et un paper `--unverified`
  ne prouve rien du tout.
- Le kill switch, la politique, le manifeste et la clé du ledger sont des fichiers locaux : quiconque a un accès en
  écriture à la machine peut les modifier. Ils protègent contre les erreurs de Claude et de l'automatisation, pas contre
  une compromission de la machine.
- L'exécuteur n'est pas conçu pour tourner en plusieurs instances simultanées (pas de verrou de fichier) : un seul
  processus à la fois.

## 6. Tests

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
```

`tests/risk.test.ts` (chaque règle acceptée et rejetée, fuseau, expiration, doublon, chargement de politique, règles v2 :
corrélation, série de pertes, budget d'erreurs, âge du signal, reduce-only préservé), `tests/crosscheck.test.ts`
(cause commune = 1 famille, couplage optimal, 5 familles = FORTE), `tests/score.test.ts` (déterminisme, bornes, `missing`,
poids versionnés, jamais le mot « probabilité »), `tests/redteam-checklist.test.ts` (chaque critère dur → VETO, UNKNOWN
dur → NO_TRADE, override humain), `tests/route.test.ts` (hiérarchie RISK > TRADING > STRATEGY, grille TRADE vs BUILD),
`tests/exec.test.ts` (kill switch ×3 + cliquet, paper trading, exécuteur de bout en bout sur dossier temporaire, refus du
live, live avec Jupiter mocké, intégrité, vérification locale, ledger local, import restrictif, marché, reduce-only),
`tests/ledger.test.ts` (JSONL, chaîne HMAC, reconstruction, drawdown, PnL, journal, rapport hebdomadaire avec la règle
n ≥ 10), `tests/redteam-risk.test.ts` (attaques du red team : chaque `it` est une défense vérifiée, chaque `it.fails`
une attaque encore ouverte).
