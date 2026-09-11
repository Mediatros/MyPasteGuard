---
name: failure-archaeology
description: Chronicle of PasteGuard's and the fork's investigations, dead ends, and major bugs — the Claude Code OAuth proxy dead end (401 x-api-key placeholder), the Presidio era, HTML-broken placeholders, broken prompt caching, AVX2 crashes, concurrent scans. Load when debugging stalls, before proposing an approach that may already have been tried, or when wondering "why is this code like this" or "have we already tried X". (To triage an active symptom, start with debugging-playbook.)
---

# Failure Archaeology — PasteGuard and Fork

Format: symptom → root cause → evidence → status. The invariants that follow from this live in `architecture-contract`; quick triage lives in `debugging-playbook`.

## When NOT to use this skill

- To triage an active symptom → `debugging-playbook` first (it points back here for history).
- For the CURRENT state of the hooks campaign → `hooks-mvp-campaign`.

## K. The OAuth proxy dead end (the fork's costliest failure) — 2026-07

- **Symptom**: `401 invalid x-api-key` as soon as `ANTHROPIC_BASE_URL` points anywhere other than api.anthropic.com.
- **Root cause**: the `claude` binary (2.1.201) only attaches the subscription OAuth token when talking DIRECTLY to api.anthropic.com; otherwise it sends `x-api-key: sk-ant-api03-placeholder` (hardcoded placeholder). The token exists (macOS keychain "Claude Code-credentials") but injecting it into a proxy = violation of Anthropic's Terms of Service (ToS) (third-party OAuth blocked since Feb 2026, issue anthropics/claude-code#28091) + risk of account suspension.
- **Evidence**: real E2E test documented in PROGRESS.md; approach 1 in full is recorded there.
- **Status**: proxy approach PERMANENTLY ABANDONED for subscription use. Never re-propose or "debug" this 401 again. Pivot → hooks (`hooks-mvp-campaign`).
- **To preserve**: the fixes in the uncommitted working tree remain valid for an upstream PR (API key usage, upstream issue #139): transparent headers (client.ts), tolerant Zod schemas (types.ts: free-form role since Claude Code sends `system`, unknown blocks, tool_result with no content, optional input_schema), recursive restoration of non-stream tool_use (extractors/anthropic.ts), streaming restoration of input_json_delta with per-block-index buffering (stream-transformer.ts). [read: from PROGRESS.md, branch diff]
- **Side dead ends ruled out along the way**: iTerm2/terminal wrapper (only see the TTY, API traffic never passes through it); "Claude Privacy Tool" which claims to rewrite the prompt via UserPromptSubmit — contradicts the official documentation (UserPromptSubmit can only block or add context, re-verified 2026-07-05).

## Upstream history (144 commits, no reverts) [verified: executed git log]

**A. Text corruption, overlapping entities (#33)**: Presidio returned "Eric" and "Eric's" at the same time → offset-based replacement got corrupted → two-phase resolver (`conflict-resolver.ts`, commits c8cc3cf, dbb221a, 2315371). Fixed.

**B. HTML-encoded placeholders (#36 → #38, d239944)**: `<TYPE_N>` got HTML-entity-encoded by clients → unrestorable → format changed to `[[TYPE_N]]`; the configurable `redact_placeholder` was removed (streaming hardcoded `[[`). Fixed, invariant 1.

**C. SIGILL crash without AVX2 (#70 → #71, cfe18e0)**: the Bun install script shipped an AVX2 binary → crash on modest CPUs → binary copied from `oven/bun:1-slim` (SSE4.2 baseline) instead. Fixed, permanent comment in the Dockerfile.

**D. Anthropic prompt caching broken (#74, 9e8006a)**: Zod schemas were stripping `cache_control` → `.passthrough()` applied broadly. Fixed. **Recurring theme: strict validation breaks proxy transparency** — the same theme recurs in issue #139 and the current branch work.

**E. The Presidio era (#62, #69, #100)**: multi-language startup timeouts, missing recognizers, a heavyweight image → full replacement by the in-house GLiNER + deterministic detector (08ddb1d, v0.5.0), an accuracy benchmark added just before (#99) to drive the migration. Closed; the in-house detector keeps the "Presidio drop-in" offset contract.

**F. Masked content not logged when secrets were detected (#91, c982e62)**: logging ignored `log_masked_content` as soon as a secret appeared → centralized into a pure `shouldLogMaskedContent` helper. Fixed.

**G. Streaming: SSE lines cut mid-stream (#84, #112)**: the transformer assumed chunks = lines → restoration broke → buffering rewritten. Fixed on the OpenAI side; the same work is being redone on the Anthropic side in the uncommitted branch work.

**H. Concurrent detector scans (#135, then #137)**: `Promise.all` over the spans while torch inference is serialized by `_infer_lock` → queuing → timeouts → sequential loop + configurable `detector_timeout`. Fixed. **Lesson: the detector = ONE inference at a time; any parallelization on the proxy side is a false good idea.**

**I. Role-scan doctrine: back and forth (#25 then #115)**: #25 fixed "only some roles get scanned" by scanning EVERYTHING; #115 reversed that: by default, only scan roles controlled by the user (user, tool, function, mcp) so as not to mask context injected by the harness. Not a revert, a refinement: know both halves before "fixing" it in either direction.

**J. Conductor: config.yaml polluted (#109, #110)**: automatic seeding was overwriting the config → conditional seeding, seeding stopped in workspace. Fixed.

**L. Mock leak between route tests (#85, ed7fb19)**: the detector mock was leaking across files → isolation fixed; this also forced `shouldLogMaskedContent` out into its own dedicated module (cf. F).

## Provenance and maintenance

Written on 2026-07-07 from a full repository audit. Re-checks:
- `git log --oneline -10` (new chapters to add)
- Entry K is re-checked against PROGRESS.md (local-only); if PROGRESS.md contradicts this skill, PROGRESS.md wins.
