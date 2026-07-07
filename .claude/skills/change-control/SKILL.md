---
name: change-control
description: Comment les changements sont classés, gérés et livrés dans ce fork PasteGuard — état exact du fork et de la branche, ce qui est committable vs local-only, règles de commit/push, obligations de tests et de docs, territoires interdits. À charger avant tout commit, toute création de branche, toute PR (upstream ou origin), ou quand on se demande « ai-je le droit de modifier/committer ça ».
---

# Change control — fork PasteGuard

## Quand NE PAS utiliser cette skill

- Pour lancer les vérifications elles-mêmes → skill `validation-and-qa`.
- Pour savoir où écrire du nouveau code (src/ vs integrations/) → skill `architecture-contract`, section « Périmètre fork ».

## État du fork (relevé 2026-07-07, re-vérifier avant d'agir)

- `origin` = https://github.com/Mediatros/pasteguard.git (fork de JB) ; `upstream` = https://github.com/sgasser/pasteguard.git. [verified: executed]
- 144 commits, dernier `547e7c3` (Bump version to 0.7.5, 2026-07-03). Version 0.7.5, tag `v0.7.5`. [verified: executed]
- Branche courante `fix/claude-code-transparency` : AUCUN commit d'avance sur `main` — tout le travail vit dans l'arbre NON committé : 9 fichiers modifiés (652+/109-) sous `src/masking/`, `src/providers/anthropic/`, `src/routes/anthropic*`, plus `src/providers/anthropic/client.test.ts` non suivi. [verified: executed git status/diff]
- Ces modifications sont destinées à une future PR upstream (issue #139) : ne pas les jeter, ne pas les committer sans demande. Contexte complet : skill `failure-archaeology`.
- Branches remote-only sur origin : `check-new-issue`, `repoint-extension-beta-links` (anciennes, rôle non investigué — ne pas y toucher sans vérification). [verified: executed]

## Règles non négociables

1. **Jamais de commit ni de push sans demande explicite de l'utilisateur.** (AGENTS.md + règle globale JB.)
2. **Jamais committer** : `config.yaml`, `PROGRESS.md`, `data/`, `plans/`, `anatomy.md` — exclus via `.git/info/exclude`, donc git ne les protège que localement ; un `git add -f` les committerait. [verified: executed]
3. **Avant toute livraison de code** : `bun test` + `bun run typecheck` + `bun run check` verts (AGENTS.md). Commandes et états attendus : skill `validation-and-qa`.
4. **Tests obligatoires** quand on touche : masking, forwarding provider, logging, parsing de config, endpoints publics (AGENTS.md).
5. **Docs publiques obligatoires** quand on change : endpoints publics, config provider, étapes de setup → mettre à jour README et `docs/*.mdx` (site Mintlify pasteguard.com/docs, registre `docs/mint.json`). (AGENTS.md)
6. **Préférer les patterns existants** route/provider/extractor à toute nouvelle abstraction. (AGENTS.md)
7. **Ne jamais modifier `~/.claude/settings.json`** pour ce projet : les hooks de la campagne se déclarent dans le `.claude/settings.json` d'un projet de TEST dédié (décision D9, voir `hooks-mvp-campaign`). [read: from plans/PLAN.md]

## Classer un changement avant de coder

| Type de changement | Territoire | Destination |
|---|---|---|
| Correctif ou feature du moteur, utile à tous | `src/` + tests | candidat PR upstream (sur demande) |
| Travail campagne hooks Claude Code | `integrations/claude-code/` (lot 2+) | fork uniquement |
| Config/plan/état local | config.yaml, plans/, PROGRESS.md | jamais committé |
| Docs publiques | README, docs/*.mdx | suit le changement de code concerné |

## Hygiène de l'historique

Pas de revert dans les 144 commits ; le style upstream est « une PR = un sujet, message impératif court + numéro de PR ». Aucun TODO/FIXME dans `src/` ni `detector/` : ne pas en introduire, ouvrir une entrée dans PROGRESS.md à la place. [verified: executed greps 2026-07-07]

## Provenance et maintenance

Rédigé le 2026-07-07 par audit complet du dépôt. Re-vérifications :
- `git remote -v && git status --short && git log --oneline -3`
- `cat .git/info/exclude`
- `git diff main --stat | tail -3` (état de la branche)
