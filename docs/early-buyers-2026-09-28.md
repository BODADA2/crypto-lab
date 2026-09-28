# Collecte H-BUNDLE (early buyers) — mise en production 2026-09-28

## Objectif
Granularité wallet des premiers acheteurs pour les tokens migrés, afin d'alimenter le
test pré-enregistré **T-BUNDLE** (docs/preregistered-addendum-2026-09-28.md) : la question
« top5_share ≥ 40 % prédit-il l'échec ? » est GELÉE — ce document et le code ne concluent
**aucun signal**, ils collectent seulement.

## Architecture

| Élément | Fichier | Rôle |
|---|---|---|
| Client Helius (existant, inchangé) | `lab/collect/helius.ts` | `getEarlyBuyers(mint, 50)`, `getWalletTokenHistory`, compteur `credits` |
| Métriques pures (nouveau) | `lab/signals/earlybuyers.ts` | `computeBundleMetrics`, `computeCoordinatedSells` — sans I/O, testées |
| Job (étendu) | `lab/signals/run-earlybuyers.ts` | backfill + continu, garde-fous crédits, cache |
| Tests | `tests/earlybuyers-bundle.test.ts` (12), `tests/earlybuyers-job.test.ts` (6) | métriques + orchestration (client simulé) |

### Les 4 métriques (par token, sur les 50 premiers acheteurs)
- **top5_share** : part des achats captée par les 5 plus gros wallets (0–1).
- **gini** : coefficient de Gini des montants (0 = égalité, →1 = concentration).
- **same_slot_max** : part max d'achats dans le même slot — proxy de coordination temporelle.
- **coordinated_sells** : parmi les top 10 acheteurs (par montant) dont l'historique remonte
  jusqu'à la migration (« couverts »), part de ceux ayant vendu > 50 % dans les 5 min
  post-migration. `null` si couverture < 5 wallets (pas de faux zéro). Calculée seulement
  quand la fenêtre est écoulée (migration + 15 min de grâce).

### Stockage
`data/earlybuyers/<mint>.json` — format existant conservé, champs ajoutés : `metrics`,
`sells`, `migratedAt`, `fetchedAt`. Le cache évite de repayer un token déjà lu.

## Budget crédits Helius — chiffres réels

| Poste | Spec (borne haute) | Mesuré |
|---|---|---|
| Acheteurs/token (`getEarlyBuyers`, n=50) | ~210 | **61** (token de référence : 10 pages signatures + 51 tx lues ; `truncated: true` car > 10 000 signatures) |
| Ventes/token (10 wallets × 41) | ~410 | non mesuré en live (voir § Connectivité) |
| Mois de septembre (compteur `data/meta.json`) | — | **17 731 / 1 000 000** |
| Cible 50 tokens/jour | ~315 k/mois | ~95 k/mois au coût mesuré (sans ventes) |

Garde-fous implémentés (`--max-credits 15000` par run, `--monthly-cap 400000` par mois,
borne haute 650 crédits/token avant d'engager un token, arrêt propre avec motif).
Le job refuse de démarrer si le plafond mensuel est atteint.

## Validation du pipeline

- **18 nouveaux tests verts** (12 métriques + 6 orchestration : cache, plafonds,
  arrêt propre, phase ventes, reprise sur erreur Helius).
- **Suite complète : 527 passés + 1 échec attendu** (pré-existant).
- **tsc : 0 erreur** sur les fichiers touchés (32 pré-existantes dans `lab/backtest/`).
- **Métriques sur le token réel en cache** (`5QK1qDJ3…`, 50 acheteurs) :
  top5_share = 0,129, gini = 0,108, same_slot_max = 0,160 — pipeline de calcul validé
  de bout en bout sur données réelles.
- Test existant `tests/signals.test.ts` (« job early-buyers ») mis à jour pour la
  phase ventes (7 → 35 crédits sur le fixture : 7 acheteurs + 28 ventes).

## Connectivité Helius — blocage environnemental (à lire)

Le backfill live (~50 derniers migrés ; **2 106 migrés uniques** disponibles 24–28 sept.,
1 seul en cache) **n'a pas pu tourner depuis ce contexte** :
- `mainnet.helius-rpc.com` : timeout TCP (15 s), aucune réponse — 2 sondes indépendantes.
- Même contexte, `api.dexscreener.com` : **200 OK en 0,7 s** — l'egress général fonctionne.
- Le framework signale `userConfirmationRequired: true` → `timed_out` pour l'hôte Helius :
  l'accès réseau à Helius semble soumis à approbation dans cet environnement.

**Commande de backfill prête** (à exécuter depuis un contexte où Helius est joignable) :
```
HELIUS_API_KEY=... npx tsx lab/signals/run-earlybuyers.ts --tokens 50 --max-credits 15000
```
Coût estimé au réel mesuré : ~50 × 61 ≈ **3 050 crédits** (sans ventes) ou ~50 × 470 ≈
**23 500 crédits** (avec ventes) — très inférieur au plafond mensuel.

**Continu** : le cache rend chaque run incrémental ; la cadence recommandée est le job
quotidien existant avec `--tokens 50` (les nouveaux migrés sont détectés via
`data/scans/pump-*.jsonl`). Aucun cron créé ici — à brancher par l'orchestrateur.

## Conformité
Aucun push. Aucune transaction (réelle ou paper), aucun ordre — lectures chain uniquement.
Risk Engine, exécuteur, seuils du moteur paper, `docs/paper-engine-cycle-*.md` intacts.
Holdout `data/track-unbiased/` non touché. Clé Helius lue depuis `HELIUS_API_KEY`
(jamais en clair dans le code ni les docs).
