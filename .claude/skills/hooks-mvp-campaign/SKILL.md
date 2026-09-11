---
name: hooks-mvp-campaign
description: Decision runbook for the fork's current campaign — protecting subscription-based Claude Code via hooks (PostToolUse/PreToolUse/MessageDisplay) calling /api/mask. Batches 1 to 9, gates V1-V5 with expected outputs, decisions D1-D11, forbidden paths. Load for any work session on the hooks, the session store, integrations/claude-code/, or as soon as PROGRESS.md mentions a batch to execute.
---

# Claude Code Hooks Campaign — Runbook

**Detailed source of truth: `plans/PLAN.md` + `plans/01-…09-*.md` (local working notes, not committed; git-excluded: they only exist on this machine) and `PROGRESS.md`.** This skill is the entry map and the guardrails; the execution detail for each batch lives in its plan file. If this skill contradicts plans/PLAN.md or PROGRESS.md, THEY win (they are updated continuously).

## When NOT to use this skill

- Work on the upstream engine (src/) unrelated to hooks → `architecture-contract` and `change-control`.
- Understanding why the proxy was abandoned → `failure-archaeology` (entry K).

## Goal and architecture (summary)

Claude Code keeps its native OAuth auth (NO custom `ANTHROPIC_BASE_URL`). Hook scripts mask PII/secrets BEFORE they enter the context and restore them locally:

- `PostToolUse` → `updatedToolOutput`: masks tool outputs (calls `/api/mask`). Timeout 600 s.
- `PreToolUse` → `updatedInput`: restores tool inputs for LOCAL-effect tools (restore without network). Timeout 600 s.
- `MessageDisplay` → `displayContent`: restores the display only (restore without network). Timeout 10 s — this is THE constraint that forces restoration without a network call (D3).
- Session store: `~/.pasteguard/claude-sessions/<session_id>.json` (counters + placeholder→value mapping), lock + dedup.

Engine: local PasteGuard in engine-only mode (`bun run start` + Docker detector), `/api/mask` contract in `architecture-contract`.

## Critical path and status

Batches: 1 (environment) → 2 (session store + mask client) → 3 (PostToolUse) → 4 (PreToolUse) → 5 (MessageDisplay) → 7 (E2E) → 8 (plugin). Batch 6 (UserPromptSubmit): OPTIONAL, user decision pending. Batch 9 (MITM): unplanned reserve. Status as of 2026-07-19: batches 1-4 DONE, forward masking + local input restoration proven in subscription E2E; gates V1/V2/V5/V6 cleared, V7 cleared for resume. V2: `updatedInput` WITHOUT permissionDecision is honored (2.1.215), permissions preserved; BUT Edit's old_string validation happens against disk BEFORE PreToolUse → old_string restoration is impossible, workaround = sed instruction in the protected project's CLAUDE.md. The details and proven facts (11-17: od/-c bypass, nested-placeholder bug fixed, hook_success attachments in plaintext locally) are in PROGRESS.md, "Current state" section. [read: from PROGRESS.md]

Each batch has its own plan with goal, spec, tests, success criteria: `plans/0N-*.md`. Execute in order; do not industrialize before clearing batch 3's gates.

## Gates V1-V5 (to be cleared via a real POC, batch 3, spy hook first)

| Gate | Question | If the answer is NO |
|---|---|---|
| V1 | Actual shape of `tool_response` per tool (the docs say `{type, content}`; Read/Grep/Bash may differ) | Adapt per-tool parsing before any masking |
| V2 | `updatedInput` honored with `permissionDecision: "defer"`? | Decide between `"ask"` + updatedInput, document in the plan |
| V3 | MessageDisplay during streaming: placeholder split in two? | Display buffering to be designed (same bug family as #112, see `failure-archaeology` G) |
| V4 | Do `@file` mentions go through Read/PostToolUse? | Leak to document or cover otherwise |
| V5 | Do `updatedToolOutput`/`updatedInput`/`displayContent` work on claude 2.1.201? | STOP the campaign, reassess (docs vs reality) |

## Non-negotiable cross-cutting decisions (title + stakes; the DETAIL lives in plans/PLAN.md, do not copy it here)

- **D1-D2** — territory: everything in `integrations/claude-code/`, standalone scripts (no imports from src/, HTTP only); engine untouched.
- **D3** — restoration without network access (otherwise MessageDisplay's 10 s timeout trips).
- **D4** — mandatory lock on the session store (parallel hooks → placeholder collisions); mechanism mandated in PLAN.md.
- **D5** — CLIENT-side dedup in two passes; necessity explained by the `/api/mask` contract (owner: `architecture-contract`).
- **D6** — FAIL-CLOSED: masking failure → withhold everything (PostToolUse) or deny (PreToolUse deny); only MessageDisplay degrades cosmetically. Never let raw output through.
- **D7** — NEVER restore toward a tool with external reach (WebFetch, WebSearch, remote MCP); local only (Write/Edit/MultiEdit/NotebookEdit/Bash).
- **D8** — session files protected (600/700, atomic write).
- **D9** — hooks in the `.claude/settings.json` of a dedicated TEST project; NEVER `~/.claude/settings.json`.
- **D11** — each batch ships its tests + typecheck; Biome to be extended to `integrations/` (batch 2).

## Forbidden paths (already settled, do not reopen)

- `ANTHROPIC_BASE_URL` proxy / OAuth token injection → permanent ToS dead end (`failure-archaeology` K).
- Rewriting the prompt via UserPromptSubmit → impossible (official docs); the only option for batch 6: detection + blocking.
- iTerm2 / terminal wrapper → don't see API traffic.
- MITM (approach 3): DO NOT activate it as a solution without an explicit user decision (ToS grey area); its only intended use in the MVP is passive VERIFICATION in E2E (batch 7, mitmproxy in observation mode).

## Risk #1 identified

Mapping consistency under concurrency with a stateless `/api/mask`: lock + dedup (D4/D5) serialize all masking, under a 10 s MessageDisplay timeout, on top of a detector that only does ONE inference at a time (`failure-archaeology` H). Measure real-world latencies in batch 1 (step 5 of plans/01) before stacking further.

## Definition of "done" for a batch

Success criteria from the batch's plan file met AND demonstrated by execution (curl/test outputs pasted into PROGRESS.md), then PROGRESS.md updated. A batch without executed evidence is not done.

## Provenance and maintenance

Written on 2026-07-07 from a full repository audit. Volatile: re-read PROGRESS.md at EVERY session (batch status, pending decisions). Re-checks:
- `ls plans/` (the plans still exist)
- `grep -n "Travail en cours" -A5 PROGRESS.md` (actual status)
