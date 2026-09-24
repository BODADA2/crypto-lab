# Plan données — collecte, signaux, backtest, brief

Ce dossier (et `lab/signals/`, `lab/backtest/`, `lab/brief/`) constitue le **plan données** décrit dans
`ARCHITECTURE.md` : il tourne là où le réseau est libre (GitHub Actions ou la machine d'Hervé), écrit des
fichiers dans `data/` et ne détient **aucun secret de trading**. Tout appel réseau est injecté (`fetch` en
paramètre) et testé hors ligne avec les fixtures de `tests/fixtures/`.

> **Un seul `TokenSnapshot`** (chantier 1, `lab/types.ts`) pour les trois plans : champs riches de la collecte
> (fenêtres `volume`/`priceChange`/`txns` m5/h1/h6/h24, `pairAddress`, `pairCreatedAt`, `boostsActive`, `pairCount`,
> `source`, `fetchedAt`) + champs on-chain (`top10Pct`, `mintAuthority`, `freezeAuthority`, `decimals`,
> `riskyExtensions`) + vues plates dérivées `volume5m/1h/24h`. Les inconnus sont explicites et conservateurs :
> `holders: null`, `top10Pct: 100`, autorités `"UNKNOWN"`, prix/liquidité `0`, `pairCreatedAt: null`
> (⇒ `createdAt = fetchedAt`). `lab/collect/types.ts` ré-exporte le type et fournit `makeSnapshot()` (construction
> avec défauts), `normalizeSnapshot()` (lecture tolérante des anciens fichiers, plats ou riches) et `syncVolumeViews()`.
> `lab/collect/bridge.ts → enrichSnapshot()` (alias `toRiskSnapshot`) applique un `MintInfo` (autorités réelles,
> top 10, décimales, extensions) ; sans lui, le Risk Engine refuse.

## Sources, limites gratuites et coût

Chiffres vérifiés le 24/09/2026 (`docs/research-2026-09-24.md`), sauf mention ⚠️.

| Source | Module | Ce qu'on prend | Limite gratuite | Coût observé par cycle |
|---|---|---|---|---|
| DexScreener | `dexscreener.ts` | `token-profiles/latest/v1`, `token-boosts/top/v1`, `latest/dex/tokens/{30 mints}`, `token-pairs/v1`, `latest/dex/search` | 60 req/min par endpoint, sans clé | 2 listes + 1 requête par lot de 30 mints ≈ 3–4 req ; limiteur glissant + cache disque `data/cache/` (TTL 30–60 s) |
| PumpPortal | `pumpportal.ts` | WebSocket `subscribeNewToken` + `subscribeMigration` **uniquement** | Gratuit. Les flux de trades coûtent 0,01 SOL / 10 000 événements → jamais souscrits | 1 connexion unique (règle PumpPortal : plusieurs connexions = ban 1 h), reconnexion exponentielle, job borné à 5 min |
| Helius | `helius.ts` | `getSignaturesForAddress` + `getTransaction` (jsonParsed) | 1 M crédits/mois, 10 req/s | ≈ 1 crédit par appel RPC standard (table ajustable) ; `getEarlyBuyers` ≤ ~210 crédits/token (10 pages max + 200 tx) ; compteur `client.credits` et `data/meta.json → heliusCreditsMonth` |
| Helius (mint) | `mintinfo.ts` | `getAccountInfo` base64 + `getTokenSupply` + `getTokenLargestAccounts` + `getMultipleAccounts` | idem | 4 crédits/token, uniquement pour les tokens qui passent le pré-filtre liquidité ≥ 20 k$ et âge ≥ 10 min, max 20/cycle, cache `data/mintinfo/` TTL 1 h → ≤ 80 crédits/cycle, ≈ 230 k/mois au pire |
| Reddit | `reddit.ts` | `r/solana`, `r/CryptoMoonShots`, `r/memecoins` → `new.json?limit=100` | ⚠️ ≈ 100 req/min sans authentification (source secondaire) ; User-Agent obligatoire | 3 req |
| GitHub | `github.ts` | `search/repositories` « solana » créés < 7 j et poussés < 2 j | 60 req/h anonyme, 5 000 req/h avec `GITHUB_TOKEN` (celui d'Actions suffit) | 2 req |
| Jupiter Price API | — (plan exécution) | — | 1 req/s | non utilisé ici |
| Solana Tracker | — | — | 10 000 req/mois, 3 req/s | réservé pour `holders` (DexScreener ne les fournit pas) ; non branché |

Budget quotidien avec le cron 15 min : ≈ 96 cycles × (4 DexScreener + 3 Reddit + 2 GitHub) ≈ 860 requêtes/jour,
loin des limites. Helius n'est sollicité que par le job quotidien early-buyers (≈ 4 000 crédits/jour pour 20 tokens).

## Fichiers produits

| Chemin | Contenu |
|---|---|
| `data/scans/<ISO>.json` | `ScanResult` : profils, boosts, snapshots, posts Reddit, dépôts GitHub, erreurs, compteurs de requêtes |
| `data/scans/pump-<YYYY-MM-DD>.jsonl` | un `PumpEvent` par ligne (`create` / `migrate`) |
| `data/tokens/<mint>.json` | dernier snapshot **au format `lab/types.ts`** (Risk Engine / exécuteur) : autorités réelles, `top10Pct`, `decimals` si enrichi, sinon valeurs conservatrices |
| `data/mintinfo/<mint>.json` | `MintInfo` : programme (SPL / Token-2022), autorités, extensions TLV, top comptes avec exclusions, `riskyExtensions` |
| `data/history/<mint>.jsonl` | série de snapshots (max 2 016 lignes = 7 j à 5 min) → signal volume et backtest |
| `data/signals/volume-<ISO>.json` | scores du signal volume avec explication par token |
| `data/narratives/<date>.json` + `docs.jsonl` | top 10 termes en accélération + corpus archivé (8 j) |
| `data/earlybuyers/<mint>.json` | cache des premiers acheteurs (ne jamais repayer un token) |
| `data/wallets/<address>.json` | `WalletProfile` : récurrence, score, apparitions |
| `data/meta.json` | compteurs (dernier cycle, crédits Helius du mois, dernier job PumpPortal) |
| `briefs/YYYY-MM-DD.md` | brief en 9 sections, chaque chiffre cite son fichier |

## Signaux

- **Volume anormal** (`signals/volume.ts`) : z-score du volume 5 min vs les 12 fenêtres précédentes,
  accélération des holders (quand une source les fournit), ratio volume/liquidité, pression acheteuse ;
  filtres durs âge ≥ 10 min et liquidité ≥ 20 000 $ (politique de risque). Score 0–100 + `reasons[]`.
- **Early-buyer overlap** (`signals/earlybuyers.ts`, job `signals/run-earlybuyers.ts`) : wallets présents
  dans les 50 premiers acheteurs d'au moins K tokens migrés. Produit des **candidats à suivre**, pas des
  signaux d'achat — aucune étude publique ne prouve que ces wallets restent rentables (research §D).
- **Narratifs** (`signals/narrative.ts`) : termes Reddit + GitHub + noms de tokens sur 24 h vs moyenne 7 j.

## Backtest

`npx tsx lab/backtest/example.ts` (fixtures synthétiques) ou `npx tsx lab/backtest/example.ts data/history`.
Entrée à t+1 (pas de lookahead), take-profit / stop / time-stop, frais 1,3 % aller-retour + slippage
`taille / liquidité` plafonné à 3 % par côté. **Refuse de conclure si n < 30** (message explicite, code de
sortie 2). Les fixtures de `tests/fixtures/history/` sont **synthétiques** (générateur `backtest/synth.ts`) :
elles valident la mécanique, pas une stratégie.

## Ce qui manque (et pourquoi)

- **X/Twitter** : plus de palier gratuit en 2026 (pay-per-use) → non collecté ; section NARRATIVES sans X.
- **Dune** : comptes gratuits en lecture seule depuis le 10/09/2026 → aucune requête SQL possible.
- **Flux de trades PumpPortal / Bitquery / Birdeye trending** : payants ou quotas non confirmés.
- **Holders** : DexScreener ne les expose pas et `mintinfo.ts` ne les calcule pas (il faudrait
  `getProgramAccounts` — 10 crédits et lourd — ou Helius DAS `getTokenAccounts` paginé). Brancher Solana Tracker
  (10 k req/mois) ou DAS quand le budget sera arbitré. En attendant `holders = null` côté collecte (→ `0` dans
  `data/tokens/`) et la composante « accélération holders » du signal volume vaut 0.
- **top10Pct** : calculé sur les 20 plus gros comptes de token renvoyés par `getTokenLargestAccounts`, hors comptes
  dont le propriétaire est la paire DexScreener (vault LP). Les vaults d'autres pools ou l'ATA d'une bonding curve
  pump.fun non listée restent comptés (valeur donc plutôt pessimiste, jamais optimiste).
- **Webhooks Helius** : plans payants seulement → on interroge (polling) au lieu d'être notifié.
- **Données historiques** : `data/history/` ne se remplit qu'à partir du premier cycle ; il faut ≥ 13
  observations (≈ 1 h) par token avant que le signal volume soit éligible, et plusieurs jours pour un
  backtest à n ≥ 30.

## Activer les workflows

1. Pousser le dépôt sur GitHub ; vérifier dans *Settings → Actions → General* que les workflows peuvent
   écrire (`Workflow permissions: Read and write`).
2. Secrets optionnels (*Settings → Secrets and variables → Actions*) :
   - `HELIUS_API_KEY` : active le job early-buyers quotidien (sinon il s'ignore proprement).
   - `PUMPPORTAL_API_KEY` : recommandé pour le WebSocket (les créations/migrations sont gratuites, mais la clé
     identifie la connexion) ; sans clé le job tente la connexion anonyme.
   - `GITHUB_TOKEN` est fourni automatiquement par Actions.
3. `collect.yml` : cron `*/15 * * * *` → job `collect` (DexScreener + Reddit + GitHub, commit `data/`) puis
   job `pumpportal` (5 min d'écoute, commit). Lancement manuel : *Actions → collect → Run workflow*.
4. `brief.yml` : crons `0 10 * * *` et `0 11 * * *` UTC ; une étape ne laisse passer que l'exécution où il est
   6 h à `America/New_York` (EDT ou EST). Génère `briefs/<date>.md`, lance le job early-buyers et le backtest
   informatif, puis commit `briefs/` et `data/`.
5. En local : `DATA_DIR=data npx tsx lab/collect/run.ts`, `npx tsx lab/collect/run.ts pump 120`,
   `npx tsx lab/brief/generate.ts .`

## Tests

`npx vitest run tests/collect.test.ts tests/signals.test.ts tests/backtest.test.ts tests/brief.test.ts` —
tout est hors ligne : faux `fetch` routé vers `tests/fixtures/`, faux serveur WebSocket (`tests/helpers/wsServer.ts`,
RFC 6455 minimal sur `node:http`, le module `ws` n'est pas une dépendance directe), répertoires temporaires.
