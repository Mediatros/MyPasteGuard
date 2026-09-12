---
name: change-control
description: How changes are classified, managed, and delivered in this PasteGuard fork — exact state of the fork and the branch, what is committable vs local-only, commit/push rules, testing and documentation obligations, forbidden territories. Load before any commit, any branch creation, any PR (upstream or origin), or when wondering "am I allowed to modify/commit this".
---

# Change control — PasteGuard fork

## When NOT to use this skill

- To run the checks themselves → skill `validation-and-qa`.
- To know where to write new code (src/ vs integrations/) → skill `architecture-contract`, "Fork scope" section.

## Fork state (surveyed on 2026-07-07, re-verify before acting)

- `origin` = https://github.com/Mediatros/MyPasteGuard.git (JB's fork); `upstream` = https://github.com/sgasser/pasteguard.git. [verified: executed]
- 144 commits, latest `547e7c3` (Bump version to 0.7.5, 2026-07-03). Version 0.7.5, tag `v0.7.5`. [verified: executed]
- Current branch `fix/claude-code-transparency`: NO commits ahead of `main` — all the work lives in the UNCOMMITTED working tree: 9 files modified (652+/109-) under `src/masking/`, `src/providers/anthropic/`, `src/routes/anthropic*`, plus untracked `src/providers/anthropic/client.test.ts`. [verified: executed git status/diff]
- These changes are intended for a future upstream PR (issue #139): do not discard them, do not commit them without being asked. Full context: skill `failure-archaeology`.
- Remote-only branches on origin: `check-new-issue`, `repoint-extension-beta-links` (old, role not investigated — do not touch without checking). [verified: executed]

## Non-negotiable rules

1. **Never commit or push without an explicit user request.** (AGENTS.md + JB's global rule.)
2. **Never commit**: `config.yaml`, `PROGRESS.md`, `data/`, `plans/`, `anatomy.md` — excluded via `.git/info/exclude`, so git only protects them locally; a `git add -f` would commit them. [verified: executed]
3. **Before any code delivery**: `bun test` + `bun run typecheck` + `bun run check` green (AGENTS.md). Commands and expected states: skill `validation-and-qa`.
4. **Tests are mandatory** when touching: masking, provider forwarding, logging, config parsing, public endpoints (AGENTS.md).
5. **Public docs are mandatory** when changing: public endpoints, provider config, setup steps → update README and `docs/*.mdx` (Mintlify site pasteguard.com/docs, registry `docs/mint.json`). (AGENTS.md)
6. **Prefer existing** route/provider/extractor patterns over any new abstraction. (AGENTS.md)
7. **Never modify `~/.claude/settings.json`** for this project: the campaign's hooks are declared in the `.claude/settings.json` of a dedicated TEST project (decision D9, see `hooks-mvp-campaign`). [read: from plans/PLAN.md (local working notes, not committed)]

## Classifying a change before coding

| Change type | Territory | Destination |
|---|---|---|
| Engine fix or feature, useful to everyone | `src/` + tests | upstream PR candidate (on request) |
| Claude Code hooks campaign work | `integrations/claude-code/` (batch 2+) | fork only |
| Local config/plan/state | config.yaml, plans/, PROGRESS.md | never committed |
| Public docs | README, docs/*.mdx | follows the related code change |

## History hygiene

No revert among the 144 commits; the upstream style is "one PR = one topic, short imperative message + PR number". No TODO/FIXME in `src/` or `detector/`: do not introduce any, open an entry in PROGRESS.md instead. [verified: executed greps 2026-07-07]

## Provenance and maintenance

Written on 2026-07-07 following a full repository audit. Re-checks:
- `git remote -v && git status --short && git log --oneline -3`
- `cat .git/info/exclude`
- `git diff main --stat | tail -3` (branch state)
