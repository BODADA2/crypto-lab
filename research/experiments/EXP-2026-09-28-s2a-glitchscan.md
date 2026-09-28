# EXP-2026-09-28-s2a-glitchscan — BONUS : prévalence des glitches décimaux (M-003)

- **hypothesis_id** : H-S2A-GLITCH (résolution M-003)
- **question** : Les ticks aberrants type SKHY (+4 939 704 %) sont-ils un cas isolé ou un pattern récurrent ? Contaminent-ils les labels ?
- **method** : `aberrantMask` (prix ≥100× le max des deux voisins ou ≤1/100 du min) appliqué aux **2926 séries** `data/history/` — scan data-quality sur tous les univers (le holdout n'est scanné qu'à des fins diagnostiques, **aucune mesure prédictive** dessus). Impact labels : recalcul Y@1h/Y@6h/ddMax/dd50 avec vs sans masque sur les tokens discovery affectés.
- **data** : 35 262 ticks au total. SKHY exclu du comptage (cas connu).
- **results** :
  - **3 ticks masqués / 35 262 (0,0085 %)**, sur **3 mints / 2926 (0,10 %)** :
    - `4k3Dyjzv…` (raydium) : 2,10 $ → **10 400 $** → 2,08 $ (×4 974) ;
    - `6GmAFSYs…` (orca) : 0,299 $ → **1 460 $** → 0,297 $ (×4 922) ;
    - `taoC6xyv…` (meteora) : 302 $ → **0,0152 $** → 302 $ (÷19 949 — glitch baissier).
  - Signature : spike d'**un seul tick** avec **retour exact** au niveau antérieur, liquidité inchangée — impossible organiquement (un vrai ×5 000 ne se résorbe pas à l'identique en 13 min sans trace sur la liquidité). Tous sur des DEX non-pumpswap (raydium/orca/meteora) → erreur décimale d'agrégation DexScreener par venue, pas un phénomène de marché.
  - **Impact labels discovery : nul** — 2 tokens discovery affectés, 0 label modifié (0 flip de signe Y@1h, 0 flip dd50). Les ticks glitchés tombent hors des fenêtres de labels ou sont déjà neutralisés par le masque.
  - Limite : le masque ne détecte que les ticks intérieurs (voisins des deux côtés) ; premier/dernier tick non vérifiables ; un glitch persistant sur 2+ ticks consécutifs échapperait.
- **verdict** : **M-003 résolue — H1 confirmée (cas isolés)**. Prévalence négligeable, contamination des labels nulle sur discovery. Le masque `aberrantMask` reste une garde nécessaire mais le risque systémique est écarté.

## Fiche triage

- **HYPOTHESIS** : les glitches décimaux sont récurrents et contaminent les labels.
- **N** : 35 262 ticks / 2 926 mints.
- **EFFECT** : 0,0085 % des ticks, 0,10 % des mints ; ratios 4 922–19 949×.
- **P-VALUE** : n/a (recensement exhaustif, pas d'inférence).
- **CI** : n/a.
- **OOS EFFECT** : n/a.
- **COHORT STABILITY** : 3 venues distinctes (raydium, orca, meteora), 0 pumpswap.
- **TIME STABILITY** : 25, 27, 28 sept. — sporadique.
- **LEAKAGE STATUS** : n/a (diagnostic data-quality ; holdout scanné sans mesure prédictive).
- **VERDICT** : **KILLED** (l'hypothèse « pattern récurrent contaminant ») — cas isolés, impact nul.

## Suivi suggéré

- Garder `aberrantMask` dans le pipeline (coût nul, assurance).
- Si un jour un label semble tiré par un tick unique : vérifier tick intérieur vs bord de série.
