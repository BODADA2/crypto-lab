# Red team — Risk Engine, exécuteur, kill switch

Date : 2026-09-24. Cible : `lab/risk/engine.ts`, `lab/exec/*`, `lab/ledger/ledger.ts`, `lab/swap/jupiter.ts`.
Preuves : `tests/redteam-risk.test.ts` — 61 tests, `npx vitest run tests/redteam-risk.test.ts` → 37 passent (défense
confirmée), 24 `it.fails` « CORRECTIF ATTENDU » (attaque réussie ; le test décrit la propriété à garantir et repassera en
`it` une fois corrigé). Rien n'a été modifié sous `lab/`.

## État des correctifs (2026-09-24, plan exécution)

`npx vitest run tests/redteam-risk.test.ts` → 60 `it` (défenses vérifiées), 1 `it.fails` restant.

- **Corrigés** : C1 (manifeste scellé `lab/exec/integrity.ts` + `seal.ts`, `codeRoot` injectable, clone séparé documenté),
  C2 (ledger local chaîné HMAC sous `~/.crypto-lab/ledger/`, export en écriture seule, import restrictif au premier
  lancement), C3/H3/H4/M3 (`lab/exec/verify.ts` : snapshot construit localement, `decimals` RPC, `priceImpactPct`,
  `fetchedAt` obligatoire), C4 (cliquet), H1 (SOL via devis Jupiter, FX injectable, vraisemblance ±20 %, borne en
  lamports), H2 (max(coût, marque), latent dans les pertes, `MARQUE_INCONNUE`, `allowAveragingDown`), M1 (reduce-only),
  M4 partiel (loyer ATA compté, produit de vente pessimiste — **pas** de confirmation on-chain ni de réconciliation),
  M5 (README + test sur `package.json`), B1 (ISO strict), B2 (mint validé avant tout accès), B3 (symlinks), B4, B5 (doc).
- **Non corrigé, volontairement** : M2 — le test exige que des ventes soient rejetées après la limite de perte, ce qui
  contredit M1 ; la perte latente compte désormais dans `PERTE_QUOTIDIENNE` (blocage des achats) et la perte maximale
  d'une journée (`maxDailyLossCad + exposition + frais`) est documentée honnêtement.

## Modèle de menace

L'attaquant est le plan analyse (Claude). Il peut écrire **n'importe quel fichier du dépôt** — `intents/`, `data/tokens/`,
`ledger/trades.jsonl`, `KILL`, `package.json`, **`lab/**` lui-même** — et rien sous `~/.crypto-lab/`. Hervé fait `git pull`
puis `npx tsx lab/exec/executor.ts …`. L'attaquant ne contrôle ni l'environnement du processus, ni la clé, ni l'horloge.

Le contrat d'`ARCHITECTURE.md` (« Claude ne peut pas contourner le Risk Engine parce qu'il n'a ni la clé, ni la politique,
ni la capacité de lancer l'exécuteur ») est **faux dans l'état actuel** : le Risk Engine est pur et solide, mais **toutes ses
entrées sauf la politique et l'horloge viennent du dépôt** (intent, snapshot, ledger) — et son propre code aussi.

## Synthèse par sévérité

| # | Sévérité | Trouvaille | Angle | Test |
|---|---|---|---|---|
| C1 | CRITIQUE | Le code exécuté (`lab/**`) est dans le dépôt modifiable : un commit qui remplace `evaluate()` par « toujours autorisé » est exécuté après `git pull`. Même chose pour `loadPolicy`, `isKilled`, `loadSigner`. | 6 | (6) intégrité du code |
| C2 | CRITIQUE | `ledger/trades.jsonl` est dans le dépôt : effacer les pertes réinitialise perte quotidienne/hebdo et drawdown ; une ligne SELL inventée (+1000 $) crée du cash fictif ; effacer les BUY fait disparaître les positions (4 positions / 200 $ contournés) ; effacer PENDING réarme cadence et doublon. | 3 | (3) ×4 |
| C3 | CRITIQUE | `data/tokens/<mint>.json` est dans le dépôt : un snapshot forgé (liquidité 999 999 $, autorités null, âge 6 ans, top10 1 %, `fetchedAt` = maintenant) fait exécuter un achat **live** d'un token gelable ou sans liquidité. Tous les contrôles « qualité du token » sont contournés. | 2 | (2) snapshot forgé |
| C4 | CRITIQUE | Le `KILL` du dépôt est « partagé, visible de Claude » — donc Claude peut le **retirer** par commit ; après `git pull`, l'exécution reprend sans intervention d'Hervé. | 5 | (5) KILL supprimé |
| H1 | HAUTE | `SOL_PRICE_USD` / `FX_CAD_PER_USD` sont des constantes d'environnement : un ordre « 50 CAD » envoie `50/1.37/150` SOL ; si SOL vaut 250 $, ce sont **83 CAD réels**. Le plafond par position n'est borné qu'en unités fictives. Le produit des ventes est valorisé au même prix fictif → perte réalisée sous-estimée. | 6, 8 | (6) paramètres de marché |
| H2 | HAUTE | Plafond par mint, exposition et drawdown sont calculés sur la **marque au marché**, elle-même lue du snapshot forgeable. Un prix mensonger ≈ 0 rouvre 50 $ de « place » par mint chaque heure (coût réel 99,99 $ prouvé, non borné) ; **supprimer** le snapshot marque la position au coût → drawdown aveugle. Même sans attaque, moyenner à la baisse porte le coût par mint à 95 $ (50 → 5 de marque, +45). | 2, 7 | (2) prix mensonger, snapshot supprimé ; (7) moyenner |
| H3 | HAUTE | `snapshot.decimals` forgé (0 au lieu de 6) → quantité journalisée ×10⁶ ; le SELL suivant envoie un montant absurde (échec) : la position devient **invendable via l'exécuteur**. | 2 | (2) decimals |
| H4 | HAUTE | `quote.priceImpactPct` de Jupiter n'est jamais vérifié : avec un snapshot forgé, un achat de 50 $ dans un pool de 100 $ passe (45 % d'impact). C'est pourtant la seule mesure de liquidité **non falsifiable** disponible avant envoi. | 8 | (8) priceImpact |
| M1 | MOYENNE | Après PERTE_QUOTIDIENNE / PERTE_HEBDO / DRAWDOWN_MAX et pendant la fenêtre 2 h–8 h, les **SELL sont bloqués** : on ne peut plus sortir d'une position qui s'effondre. Contraire au principe « on doit toujours pouvoir sortir ». | 7 | (7) SELL bloqué |
| M2 | MOYENNE | `maxDailyLossCad` (70 $) est un pré-contrôle sur le **réalisé** : 4 achats de 50 $ puis ventes à −100 % = −200 $ le même jour. Plafond réel d'une journée ≈ 70 + exposition (200) + frais. | 7 | (7) perte du jour |
| M3 | MOYENNE | `fetchedAt` absent → « aucun contrôle » de fraîcheur ; `fetchedAt` présent → chaîne libre (l'attaquant écrit « maintenant »). Le contrôle de fraîcheur est décoratif. | 2 | (2) fetchedAt ×2 |
| M4 | MOYENNE | Live : produit d'un SELL = `outAmount` du **devis**, pas le montant reçu ; aucune confirmation on-chain ; loyer ATA (≈ 0,002 SOL ≈ 0,42 CAD par nouveau token) et `prioritizationFeeLamports: "auto"` non comptés. Le cash du ledger dérive du portefeuille réel, toujours dans le sens optimiste. | 8 | (8) ATA, devis |
| M5 | MOYENNE | `package.json` est dans le dépôt : si Hervé lance via `npm run …`, Claude contrôle la ligne de commande et l'environnement (`EXECUTION_MODE=live … --live`, `RISK_POLICY_PATH=…`). Le README ne l'interdit pas. | 4, 6 | (4) package.json |
| B1 | BASSE | `Date.parse` accepte les dates **sans fuseau** (interprétées en heure locale de la machine) et les formats non ISO. | 1 | (1) dates sans fuseau |
| B2 | BASSE | `loadSnapshot(intent.mint)` et `loadSnapshot(position.mint)` sont appelés **avant** validation du mint : `../../.crypto-lab/…` ouvre un fichier hors de `data/tokens/`. Pas de fuite via les raisons aujourd'hui, mais accès disque piloté par l'attaquant. | 1, 10 | (1) traversée ; (10) mint de position |
| B3 | BASSE | Git versionne les liens symboliques : `intents/x.json → ~/.crypto-lab/risk.policy.json` est suivi et parsé (rejeté ensuite, sans fuite). `data/tokens/<mint>.json` idem. | 10 | (10) symlink |
| B4 | BASSE | `CRYPTO_LAB_KILL=oui` / `on` / `KILL` ne tuent pas (seuls `1`, `true`, `yes`). | 5 | (5) valeurs |
| B5 | BASSE | En `--watch`, l'environnement est figé : `CRYPTO_LAB_KILL` ne peut pas être ajouté à un processus en cours (les fichiers KILL restent efficaces). À documenter. | 5 | (5) env figé |

### Plafond de perte réel (politique d'exemple : capital 700, exposition 200, drawdown 35 % = 245)

- Sans attaque, marques honnêtes : ≈ 245 (drawdown) + 50 (dernier ordre avant blocage) ≈ **295 CAD** + frais. Pas 70/jour.
- Avec H2 (marques ≈ coût via snapshot forgé/supprimé) : ≈ 245 réalisés + 200 ouverts invisibles ≈ **445 CAD**.
- Avec C2 (ledger réécrit) ou C1 (code réécrit) : **la totalité du portefeuille**, sans limite de cadence ni de taille.
- Avec H1 (SOL réel ≠ constante) : chaque plafond en CAD est faux du même facteur (×1,67 dans l'exemple testé).

## Défenses confirmées (37 tests `it`)

- Intent : tailles négatives/nulles/NaN/Infinity/chaînes rejetées ; NaN littéral = JSON invalide ; `adjustedSizeCad` glissé
  dans l'intent ignoré ; clés dupliquées = dernière gagne et c'est elle qui est évaluée ; `createdAt` > 5 min futur rejeté ;
  `expiresAt` borné au TTL (35 min de vie max) ; SELL sans position, SELL paper d'une position live → rejet ; notionnel
  SELL énorme vend au plus la position ; `id` avec saut de ligne ne corrompt pas le JSONL ; `__proto__` sans effet.
- Politique : symlink fichier ou répertoire vers le dépôt, `RISK_POLICY_PATH` relatif, `repoRoot` via symlink → refus
  (`realpath`) ; champs manquants, chaînes numériques, NaN/Infinity (JSON invalide), version ≠ 1, bornes absurdes → refus ;
  `lab/risk/policy.example.json` modifié n'a aucun effet.
- Kill switch : KILL déposé entre deux intents d'un cycle → arrêt net, l'intent suivant n'est ni exécuté ni déplacé ;
  KILL répertoire/vide → tué.
- Live : `EXECUTION_MODE` ∈ {Live, LIVE, ' live', 1, true} → refus ; keypair `[]`, `{}`, 63 octets, JSON invalide → refus ;
  `EXECUTION_MODE=live` seul ne bascule pas un `--paper`.
- Fractionnement : 5 × 10 $ même mint → un seul passe (PENDING compte) ; renfort 40 + 10 OK, 40 + 10,01 refusé ;
  5 mints → 5ᵉ refusé ; fenêtre 1 h 59 / 2 h 00 / 7 h 59 / 8 h 00 correcte ; intent créé à 1 h 55 mort avant 8 h.
- Paper/live : PnL, positions et **pic d'équité** reconstruits par mode ; cadence et doublon tous modes confondus (sens
  conservateur) ; ledger corrompu → arrêt (DoS sûr) ; le pic ne descend jamais sous le capital initial.

## Correctifs (précis, dans l'ordre)

### C1 — Le code exécuté doit être hors de portée de Claude

Option A (recommandée) — **séparation des dépôts** : l'exécuteur vit dans un dépôt `crypto-lab-exec` (ou un tag signé)
cloné sous `~/.crypto-lab/exec/`, sans accès en écriture pour Claude ; le dépôt `crypto-lab` ne contient que données,
intents, ledger exporté, briefs. L'exécuteur est lancé avec `--repo ~/src/crypto-lab` et n'importe **rien** depuis ce chemin.

Option B — **scellement** dans le même dépôt : `npx tsx lab/exec/seal.ts` (lancé par Hervé après revue d'un diff) écrit
`~/.crypto-lab/code.manifest.json` = `{ commit, files: { "lab/…": sha256 } }` ; `runOnce` appelle `verifyCodeIntegrity()`
en premier (avant même le kill switch) : tout fichier `lab/**`, `package.json`, `package-lock.json`, `tsconfig.json` dont le
hash diffère → `result.error = "CODE_NON_SCELLE"`, rien n'est traité. Compléter par `git verify-commit HEAD` si Hervé signe
ses commits. Dans les deux options : **jamais `npm run`** pour lancer l'exécuteur (M5) — un script `~/.crypto-lab/bin/exec.sh`
hors dépôt fixe la commande et l'environnement.

### C2 — Ledger local, source de vérité

`~/.crypto-lab/ledger/trades.jsonl` devient le seul ledger lu (`pathsFor` → `home`, plus `repoRoot`). Chaque ligne porte
`seq` (n+1) et `hmac` = HMAC-SHA256(`~/.crypto-lab/ledger.key`, `seq|prevHmac|json`) ; `readLedger` vérifie la chaîne et
**refuse tout le cycle** (KILL cliquet, voir C4) si elle est rompue. Le fichier du dépôt est un **export** (copie après
chaque cycle, commité par Hervé ou par un script) : lu par Claude, jamais par l'exécuteur. Les tests (3) ×4 doivent passer.

### C3 + H3 + H4 + M3 — Re-vérification locale avant tout ordre

Avant `PENDING`, en **live comme en paper** (sinon le paper « prouve » n'importe quoi) :

1. `fetchMintInfo(rpc, mint)` (déjà dans `lab/collect/mintinfo.ts`, RPC depuis la machine d'Hervé) → `mintAuthority`,
   `freezeAuthority`, `decimals`, extensions Token-2022 (`RISKY_EXTENSIONS` → refus), `top10Pct`.
2. `createDexScreenerClient` → `/latest/dex/tokens/<mint>` → `liquidityUsd` (meilleure paire), `pairCreatedAt`, `priceUsd`.
3. Construire un `TokenSnapshot` **local** (`source: "local-verify"`, `fetchedAt: now()`) et appeler `evaluate()` avec
   **ce snapshot** ; celui du dépôt n'est qu'un indice (pré-filtre, ou comparé : écart de prix > 20 % → refus).
4. RPC ou DexScreener indisponible → rejet `VERIFICATION_IMPOSSIBLE`, jamais de repli sur le fichier du dépôt.
5. `decimals` uniquement depuis le RPC ; `quote.priceImpactPct * 100 > policy.maxSlippageBps` → `FAILED` avant signature.
6. Risk Engine : `fetchedAt` **obligatoire** (M3) ; conserver `maxSnapshotAgeMinutes` comme garde-fou secondaire.

### C4 — Kill switch à cliquet

Dans `isKilled` : si `repo:KILL` est présent, créer `~/.crypto-lab/KILL` (contenu : `latched from repo KILL at <ts>`).
Le retrait du KILL du dépôt ne réarme donc rien ; seul Hervé, à la main, supprime le fichier local. Même cliquet pour toute
anomalie d'intégrité (C1, C2) et pour l'écart de réconciliation (M4). B4 : `CRYPTO_LAB_KILL` = toute valeur non vide sauf
`0`/`false`/`no`.

### H1 — Cotations réelles, plafond en SOL borné

`market()` doit lire le prix SOL (devis Jupiter 1 SOL → USDC, ou Price API) et le taux CAD/USD (Banque du Canada
`FXUSDCAD`, cache ≤ 24 h) ; refus si absent ou si l'écart avec l'env dépasse 10 %. Garde-fou absolu dans `executeLive` :
`lamports ≤ maxPositionSizeCad / fx / solPriceUsd`, calculé avec les cotations **réelles**, et `sizeCad` re-dérivé du
SOL réellement engagé (c'est cette valeur qui va au ledger).

### H2 — Plafonds au max(coût, marché), positions sans marque = pas d'achat

- Plafond par mint et exposition : `Math.max(costCad, markCad)`.
- Drawdown : marque = `min(prix local vérifié, dernier prix connu)` ; une position ouverte sans marque récente (< 15 min)
  → rejet de tout nouvel achat `MARQUE_INCONNUE` (elle garde son dernier `markCad` dans le ledger local).
- Le renfort d'une position en perte doit être explicitement autorisé par la politique (`allowAveragingDown: false`).

### M1 — Sortie toujours possible (reduce-only)

Dans `evaluate`, pour `kind === "SELL"` : ne pas appliquer PERTE_QUOTIDIENNE, PERTE_HEBDO, DRAWDOWN_MAX ; décider dans
la politique si FENETRE_INTERDITE s'applique aux ventes (`forbiddenWindow.blockSells: false` recommandé). Restent
applicables : kill switch, doublon, cadence, expiration, snapshot, taille.

### M2 — Perte quotidienne incluant le latent

Définir `dailyLossCad = equityAtDayStart − equityNow` (latent inclus, marques locales) et bloquer les **achats** dès
`≥ maxDailyLossCad`. À défaut, documenter honnêtement : perte max d'une journée = `maxDailyLossCad + maxExposureCad + frais`.

### M4 — Confirmation on-chain et réconciliation

Après `sendTransaction` : `getSignatureStatuses` jusqu'à `confirmed` (timeout → `FAILED` + orphelin à réconcilier) ;
fill = delta réel de `getTokenAccountBalance` / `getBalance`. Ajouter `ataRentCad` aux frais (`getMinimumBalanceForRentExemption(165)`)
lorsque le compte n'existe pas. En début de cycle live : `getBalance(wallet)` vs cash du ledger local ; écart > 5 % → KILL cliquet.

### B1–B3 — Hygiène des entrées

- `parseIso` : regex stricte `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$` avant `Date.parse`.
- Valider `BASE58` sur `intent.mint` **et** sur chaque `position.mint` avant tout `loadSnapshot` ; `path.join` puis
  vérifier `isInside(tokensDir, file)`.
- `fs.lstatSync` sur chaque intent et snapshot : lien symbolique → `REJECTED: SYMLINK` sans ouvrir la cible.

## Conclusion — correctifs BLOQUANTS avant tout mode live

1. **C1** — code exécuté hors du dépôt modifiable (dépôt séparé ou manifeste scellé) + interdiction de `npm run` (M5).
2. **C2** — ledger local chaîné sous `~/.crypto-lab/ledger/`, export en écriture seule vers le dépôt.
3. **C3 / H3 / H4 / M3** — re-vérification locale RPC + DexScreener avant chaque ordre, `decimals` depuis le RPC,
   `priceImpactPct` contrôlé, `fetchedAt` obligatoire.
4. **C4** — kill switch à cliquet (le retrait du `KILL` du dépôt ne réarme jamais seul).
5. **H1** — cotations SOL/CAD réelles et borne dure en lamports.
6. **H2** — plafonds au max(coût, marché), refus d'achat si une position n'a pas de marque récente.
7. **M1** — les SELL ne sont pas bloqués par les limites de perte (reduce-only).
8. **M4** — confirmation on-chain + réconciliation solde réel / ledger avec KILL automatique.

Tant que 1 à 4 ne sont pas faits, la phrase « Claude ne peut pas contourner le Risk Engine » d'`ARCHITECTURE.md` ne tient
pas : Claude contrôle le code, le ledger, les données et l'un des trois kill switches. M2, B1–B5 peuvent suivre en paper.
