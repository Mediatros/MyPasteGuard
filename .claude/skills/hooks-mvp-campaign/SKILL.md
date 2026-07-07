---
name: hooks-mvp-campaign
description: Runbook décisionnel de la campagne en cours du fork — protéger Claude Code en abonnement via les hooks (PostToolUse/PreToolUse/MessageDisplay) appelant /api/mask. Lots 1 à 9, gates V1-V5 avec sorties attendues, décisions D1-D11, chemins interdits. À charger pour toute session de travail sur les hooks, le session store, integrations/claude-code/, ou dès que PROGRESS.md mentionne un lot à exécuter.
---

# Campagne hooks Claude Code — runbook

**Source de vérité détaillée : `plans/PLAN.md` + `plans/01-…09-*.md` (LOCAL-ONLY, git-exclus : n'existent que sur cette machine) et `PROGRESS.md`.** Cette skill est la carte d'entrée et les garde-fous ; le détail d'exécution de chaque lot vit dans son fichier de plan. Si cette skill contredit plans/PLAN.md ou PROGRESS.md, ce sont EUX qui gagnent (ils sont mis à jour en continu).

## Quand NE PAS utiliser cette skill

- Travail sur le moteur amont (src/) sans lien avec les hooks → `architecture-contract` et `change-control`.
- Comprendre pourquoi le proxy a été abandonné → `failure-archaeology` (entrée K).

## Objectif et architecture (résumé)

Claude Code garde son auth OAuth native (AUCUN `ANTHROPIC_BASE_URL` custom). Des scripts de hooks masquent les PII/secrets AVANT entrée dans le contexte et démasquent localement :

- `PostToolUse` → `updatedToolOutput` : masque les sorties d'outils (appelle `/api/mask`). Timeout 600 s.
- `PreToolUse` → `updatedInput` : démasque les entrées des outils à effet LOCAL (restore sans réseau). Timeout 600 s.
- `MessageDisplay` → `displayContent` : démasque l'affichage seul (restore sans réseau). Timeout 10 s — c'est LA contrainte qui impose le démasquage sans appel réseau (D3).
- Session store : `~/.pasteguard/claude-sessions/<session_id>.json` (counters + mapping placeholder→valeur), verrou + dédup.

Moteur : PasteGuard local en mode moteur seul (`bun run start` + détecteur Docker), contrat `/api/mask` dans `architecture-contract`.

## Chemin critique et état

Lots : 1 (environnement) → 2 (session store + client mask) → 3 (PostToolUse) → 4 (PreToolUse) → 5 (MessageDisplay) → 7 (E2E) → 8 (plugin). Lot 6 (UserPromptSubmit) : OPTIONNEL, décision utilisateur pendante. Lot 9 (MITM) : réserve non planifiée. État au 2026-07-07 : AUCUN lot exécuté, rien ne tourne. [read: from PROGRESS.md]

Chaque lot a son plan avec objectif, spéc, tests, critères de succès : `plans/0N-*.md`. Exécuter dans l'ordre ; ne pas industrialiser avant d'avoir levé les gates du lot 3.

## Gates V1-V5 (à lever par POC réel, lot 3, hook espion d'abord)

| Gate | Question | Si la réponse est NON |
|---|---|---|
| V1 | Forme réelle de `tool_response` par outil (la doc dit `{type, content}` ; Read/Grep/Bash peuvent différer) | Adapter le parsing par outil avant tout masquage |
| V2 | `updatedInput` honoré avec `permissionDecision: "defer"` ? | Arbitrer `"ask"` + updatedInput, documenter dans le plan |
| V3 | MessageDisplay pendant le streaming : placeholder coupé en deux ? | Buffering d'affichage à concevoir (même famille de bug que #112, voir `failure-archaeology` G) |
| V4 | Les mentions `@fichier` passent-elles par Read/PostToolUse ? | Fuite à documenter ou couvrir autrement |
| V5 | `updatedToolOutput`/`updatedInput`/`displayContent` fonctionnent en claude 2.1.201 ? | STOP campagne, réévaluer (doc vs réalité) |

## Décisions transverses non négociables (intitulé + enjeu ; le DÉTAIL vit dans plans/PLAN.md, ne pas le recopier ici)

- **D1-D2** — territoire : tout dans `integrations/claude-code/`, scripts autonomes (aucun import de src/, HTTP seulement) ; moteur intouché.
- **D3** — démasquage sans réseau (sinon le timeout 10 s de MessageDisplay saute).
- **D4** — verrou obligatoire sur le session store (hooks parallèles → collisions de placeholders) ; mécanisme imposé dans PLAN.md.
- **D5** — dédup côté CLIENT en deux passes ; nécessité expliquée par le contrat `/api/mask` (propriétaire : `architecture-contract`).
- **D6** — FAIL-CLOSED : masquage en échec → tout retenir (PostToolUse) ou refuser (PreToolUse deny) ; seul MessageDisplay dégrade en cosmétique. Jamais laisser passer une sortie brute.
- **D7** — ne JAMAIS démasquer vers un outil à portée externe (WebFetch, WebSearch, MCP distants) ; locaux uniquement (Write/Edit/MultiEdit/NotebookEdit/Bash).
- **D8** — fichiers de session protégés (600/700, écriture atomique).
- **D9** — hooks dans le `.claude/settings.json` d'un projet de TEST dédié ; JAMAIS `~/.claude/settings.json`.
- **D11** — chaque lot livre ses tests + typecheck ; Biome à étendre à `integrations/` (lot 2).

## Chemins interdits (déjà tranchés, ne pas rouvrir)

- Proxy `ANTHROPIC_BASE_URL` / injection du token OAuth → impasse CGU définitive (`failure-archaeology` K).
- Réécrire le prompt via UserPromptSubmit → impossible (doc officielle) ; seule option lot 6 : détection + blocage.
- iTerm2 / wrapper terminal → ne voient pas le trafic API.
- MITM (approche 3) : NE PAS l'activer comme solution sans décision utilisateur explicite (zone grise CGU) ; son seul usage prévu au MVP est la VÉRIFICATION passive en E2E (lot 7, mitmproxy en observation).

## Risque n°1 identifié

La cohérence du mapping sous concurrence avec un `/api/mask` sans état : verrou + dédup (D4/D5) sérialisent tout le masquage, sous un timeout MessageDisplay de 10 s, au-dessus d'un détecteur qui ne fait qu'UNE inférence à la fois (`failure-archaeology` H). Mesurer les latences réelles au lot 1 (étape 5 de plans/01) avant d'empiler.

## Définition de « fait » pour un lot

Critères de succès du fichier de plan du lot atteints ET démontrés par exécution (sorties curl/tests collées dans PROGRESS.md), puis PROGRESS.md mis à jour. Un lot sans preuve exécutée n'est pas terminé.

## Provenance et maintenance

Rédigé le 2026-07-07 par audit complet du dépôt. Volatile : re-lire PROGRESS.md à CHAQUE session (état des lots, décisions pendantes). Re-vérifications :
- `ls plans/` (les plans existent toujours)
- `grep -n "Travail en cours" -A5 PROGRESS.md` (état réel)
