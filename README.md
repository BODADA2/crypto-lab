# Crypto Lab

Laboratoire autonome : **RESEARCH → DISCOVERY → VALIDATION → DEV → LAUNCH → TRACTION → TRADING → MONITORING → LEARNING**.

Capital spéculatif : 1 000 $ CAD (700 trading, 300 opérations). Horizon 5 mois. La cible n'entre dans aucun calcul du système : les portes de décision portent sur l'espérance mesurée, le drawdown et le rapport revenu/heures.

Lire d'abord : `docs/blueprint.md` (stratégie, ce que nous avons raté, agents, plan 5 mois), puis `ARCHITECTURE.md` (contrat technique et garanties), puis `lab/README.md` (exécuteur) et `lab/collect/README.md` (données).

## Trois plans

| Plan | Où | Quoi |
|---|---|---|
| Données | GitHub Actions (15 min) ou ta machine | `lab/collect/run.ts` → `data/` ; PumpPortal → `data/scans/pump-*.jsonl` |
| Analyse | Claude (sessions planifiées) | lit `data/`, `ledger/`, `journal/` → `briefs/`, `intents/` (propositions) |
| Exécution | **ta machine seulement** | `lab/exec/executor.ts` : re-vérifie, Risk Engine, paper/live, ledger local chaîné |

## Démarrer

```bash
npm install
npm test                                  # 222 tests hors ligne
npx tsx lab/brief/generate.ts .           # brief à partir de l'état du dépôt
npx tsx lab/backtest/example.ts           # harnais de backtest sur fixtures synthétiques
```

Sur ta machine (paper, sans clé) :

```bash
mkdir -p ~/.crypto-lab && cp lab/risk/policy.example.json ~/.crypto-lab/risk.policy.json   # relis chaque ligne
npx tsx lab/exec/seal.ts                  # scelle le code que tu viens de relire
npx tsx lab/exec/executor.ts --watch --paper
```

Le mode live exige, en plus : un wallet dédié `~/.crypto-lab/keypair.json` financé du montant de la politique, `EXECUTION_MODE=live`, `--live`, un RPC (HELIUS_API_KEY), l'absence de `KILL`, un code scellé identique. Voir `lab/README.md`.

## Sécurité (voir `docs/redteam-risk-engine.md`)

Claude peut écrire n'importe quoi dans ce dépôt ; il ne contrôle ni `~/.crypto-lab/`, ni la clé, ni l'horloge de ta machine. Les quatre contournements critiques trouvés par le red team (code du dépôt exécuté, ledger réécrit, snapshot forgé, kill retiré) sont corrigés : manifeste scellé, ledger local HMAC, re-vérification on-chain locale, kill à cliquet. Ce qui reste hors de portée : une machine compromise, un RPC menteur, et une perte d'une journée qui peut atteindre perte quotidienne + exposition ouverte + frais.

## Dossiers

```
lab/collect/    collecteurs (DexScreener, PumpPortal, Helius, Reddit, GitHub, mintinfo)
lab/signals/    volume anormal, early-buyer overlap, narratifs
lab/backtest/   harnais (refuse de conclure sous n < 30)
lab/brief/      brief du matin (9 sections, chaque chiffre cite sa source)
lab/risk/       Risk Engine pur + politique d'exemple
lab/exec/       exécuteur, intégrité, kill switch, vérification locale, paper
lab/ledger/     ledger jsonl, reconstruction du portefeuille, drawdown
lab/journal/    hypothèses, rapport hebdomadaire
docs/           blueprint, recherche datée, rapport red team
.github/        workflows collecte (15 min) et brief (quotidien)
```

## Règles

Aucune promesse de résultat. Aucun faux chiffre : une donnée absente s'écrit « aucune donnée ». Aucune stratégie ne passe en live sans backtest n ≥ 30, 30 jours de paper positifs et un red team écrit. Un résultat isolé ne change jamais une stratégie. Si les données ne justifient aucune action : NO ACTION.
