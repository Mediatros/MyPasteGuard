# Claude Code integration (PII/secret masking hooks)

Protection for Claude Code in subscription usage: hooks mask PII/secrets before they
enter the context (so before anything leaves toward the API) and restore them locally
(files written, display). Claude Code keeps its native OAuth authentication; the
PasteGuard engine runs locally and is only reached over HTTP on localhost.

The architecture decisions (D1-D11) and the batch-by-batch progress are described in the
repo skills (`.claude/skills/hooks-mvp-campaign`, `architecture-contract`); the detailed
plans and campaign status are internal working notes, not committed.

## Prerequisites

- PII detector: `docker compose --profile dev up detector -d` (port 5002).
- Engine: `bun run start`. The hooks reach the engine via the `PASTEGUARD_URL` env var
  (default `http://localhost:3333`): align it with the `port` in your `config.yaml`.

## Authentication mode detection

Claude Code can reach Anthropic through a subscription (OAuth) or through an API key, with
or without the PasteGuard proxy in front of it. The two masking layers are mutually
exclusive: an API key routed through the PasteGuard proxy (`ANTHROPIC_BASE_URL` pointing at
it) already gets everything masked at the HTTP layer, prompts included, so the hooks pause
to avoid double-masking their own `[[TYPE_n]]` placeholders. A subscription cannot go
through a proxy at all (OAuth credentials are not compatible with `ANTHROPIC_BASE_URL`), so
in that case the hooks are the only protection and stay active.

`lib/auth-mode.ts` implements the detection (`detectAuthMode`, `readAuthInputs`,
`describeAuthMode`, `shouldRunHooks`):

| Mode                                | Proxied? | Hooks   | Notice                                                        |
| ------------------------------------ | -------- | ------- | -------------------------------------------------------------- |
| Subscription (OAuth)                 | n/a      | Active  | -                                                                |
| API key, through the PasteGuard proxy | Yes      | Paused  | Proxy already masks all traffic, hooks would double-mask       |
| API key, no proxy                    | No       | Active  | Recommended: set `ANTHROPIC_BASE_URL` to also mask prompts     |
| Third-party (Bedrock/Vertex/Foundry)  | n/a      | Active  | The PasteGuard proxy does not support these backends           |
| Unknown                              | n/a      | Active  | Authentication method not detected, safe default               |

Detection sources, in priority order: `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`
(third-party), `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` (api-key, unless the key's
last 20 characters appear in `customApiKeyResponses.rejected`), `oauthAccount` (subscription).
The last two are read from `~/.claude.json` or `$CLAUDE_CONFIG_DIR/.claude.json`. Whether the
traffic is proxied is decided by comparing `ANTHROPIC_BASE_URL` against `PASTEGUARD_URL`
(same protocol/host/port, `localhost`/`127.0.0.1`/`::1` treated as one origin). Key material
is never logged: only types, counts, and the key's last 20 characters (for the rejection
lookup) are ever touched.

Fail-safe rule: any error while reading the environment or `.claude.json` makes
`shouldRunHooks()` return `true` (hooks stay active) — better an extra mask pass than a
leak. `post-tool-use.ts`, `pre-tool-use.ts`, and `user-prompt-submit.ts` all call
`shouldRunHooks()` right after draining stdin and before any masking, restoration, network,
or store work; when it resolves `false` they exit 0 with empty stdout, leaving the tool
input/output or the prompt untouched.

To surface the detected mode to the user at the start of a session, wire
`scripts/session-start.ts` as a `SessionStart` hook in the protected project's
`.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "timeout": 15,
            "command": "bun run /path/to/MyPasteGuard/integrations/claude-code/scripts/session-start.ts"
          }
        ]
      }
    ]
  }
}
```

For a human-readable check outside of a session, run:

```bash
bun run integrations/claude-code/scripts/doctor.ts
```

Limitations: `apiKeyHelper` (a script-based key provider) is not detected. `claude auth
status` is deliberately not used, since it ignores an API key set in the environment. As a
consequence, an environment API key rejected in interactive mode is reported as
`subscription`, even though a non-interactive run (`claude -p`) would still use it.

## `/api/mask` contract (proven at batch 1, 2026-07-19)

- Request: `{ text, startFrom?, detect? }` — `text` must not be empty (400 otherwise),
  `startFrom` resumes the session counters.
- Response: `{ masked, context, counters, entities }`.
- The engine does NOT deduplicate across calls (the same value gets a new placeholder on
  each call): deduplication is done here, client-side (`mask-client.ts`, two passes).
- Latencies measured on a cold cache (Docker CPU detector): ~0.6 s/KB; 100 KB exceeds the
  `detector_timeout` of 30 s -> 503.

## Placeholder format

`[[TYPE_n]]`, restoration regex: `\[\[[A-Z][A-Z0-9_]*_\d+\]\]`.

PII types: `PERSON`, `LOCATION`, `EMAIL_ADDRESS`, `PHONE_NUMBER`, `CREDIT_CARD`, `IBAN_CODE`,
`IP_ADDRESS`, `VAT_CODE`.

Secret types: `OPENSSH_PRIVATE_KEY`, `PEM_PRIVATE_KEY`, `API_KEY_SK`, `API_KEY_AWS`,
`API_KEY_GITHUB`, `JWT_TOKEN`, `BEARER_TOKEN`, `ENV_PASSWORD`, `ENV_SECRET`,
`CONNECTION_STRING`.

Note: it's `EMAIL_ADDRESS` (not `EMAIL`); the `startFrom` keys must use these exact types.

## Shared library (`lib/`)

- `types.ts`: `SessionState` (`version`, `counters`, `mapping`).
- `lock.ts`: lock via atomic `mkdir` (no `flock(1)` on macOS), `owner.json`
  (pid + timestamp), breaking of stale locks (> 30 s), `LockTimeoutError`.
- `store.ts`: session state in `~/.pasteguard/claude-sessions/<session_id>.json`
  (directory 700, file 600, atomic write via tmp+rename), `withSessionLock` (always
  rereads fresh state under lock), `linkSession` (resume/compact chaining, groundwork for
  V7), `PASTEGUARD_SESSION_DIR` env var to override the location.
- `mask-client.ts`: `maskText` — pre-replacement of known values (pass a, longest values
  first), call to `/api/mask` with `startFrom`, merge and deduplication of variants
  (pass b). The whole critical section runs under lock (D4/D5). Errors -> `MaskUnavailableError`
  (failure policy decided by each hook, D6).
- `restore.ts`: local restoration with no network call (D3), unknown placeholder left intact.
- `tool-output.ts`: transformation of `tool_response` while preserving its exact shape
  (the `updatedToolOutput` constraint, proven at batch 3).
- `tool-input.ts`: restoration of LOCAL tool inputs (batch 4) — field/tool table,
  escaped variant `\[\[X_n\]\]` for shell regexes, shell-safe guard (R7) on Bash.

## Hooks (`scripts/`)

- `post-tool-use.ts` (PostToolUse, matcher `*`): masks tool outputs via `/api/mask`.
  Fail-closed D6: engine unavailable -> output withheld. PII cap of 30,000 chars.
- `pre-tool-use.ts` (PreToolUse, matcher `Write|Edit|MultiEdit|NotebookEdit|Bash`): restores
  placeholders in local tool inputs via `updatedInput` WITHOUT `permissionDecision`
  (mode validated at V2 on claude 2.1.215: honored, permission flow preserved).
  Unresolved placeholder or value not shell-safe for Bash -> deny.
- `user-prompt-submit.ts` (UserPromptSubmit, no matcher): detects PII/secrets typed
  directly into the prompt and warns or blocks before sending. Driven by `PASTEGUARD_PROMPT_MODE`
  (default `off`, not wired up): `off` does nothing (no network call); `warn` warns via
  `systemMessage` (types + count, never the values) and still lets the prompt go out IN
  CLEAR TEXT (`UserPromptSubmit` cannot rewrite the prompt); `block` returns
  `{"decision":"block","reason":"..."}` listing the detected types. Reversal of D6:
  this hook is NOT fail-closed, any engine failure or timeout (2 s network) -> exit 0
  with no blocking or warning, so the session is never made unusable. Escape hatch:
  prefix the prompt with `!pg-off` to force sending without detection. Never writes to the
  session store (pure detection via `/api/mask` with no `startFrom`, without going through
  `maskText`).
- `spy.ts` / `spy-suffix.ts` / `pre-poc.ts`: POC instrumentation, never used outside the test project.

### Wiring into a project (test-only at this stage, decision D9)

In the `.claude/settings.json` of the project to protect (never in `~/.claude/settings.json`):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "timeout": 60,
            "command": "bun run /path/to/pasteguard/integrations/claude-code/scripts/post-tool-use.ts"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "timeout": 30,
            "command": "bun run /path/to/pasteguard/integrations/claude-code/scripts/pre-tool-use.ts"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "timeout": 10,
            "command": "PASTEGUARD_PROMPT_MODE=warn bun run /path/to/pasteguard/integrations/claude-code/scripts/user-prompt-submit.ts"
          }
        ]
      }
    ]
  }
}
```

`PASTEGUARD_PROMPT_MODE` defaults to `off` (hook inactive) if the variable is not set;
set it to `warn` or `block` depending on the desired posture.

Also add to the protected project's `CLAUDE.md` the model instruction: opaque placeholders
must be copied as-is; if an Edit fails on an `old_string` containing `[[...]]`, use `sed`
with the placeholder (restored at execution time); reading a file back via `od`, `xxd`,
`hexdump`, `base64` or any other encoding is forbidden.

### Proven limits (claude 2.1.215)

- The `old_string` validation of an Edit happens against DISK content, BEFORE PreToolUse:
  an Edit whose `old_string` contains a placeholder fails without the hook ever being
  called. Workaround: an instruction in the protected project's `CLAUDE.md` (use `sed`
  with the placeholder, which is restored at execution time; forbid re-reads via
  `od`/`xxd`/`base64` that bypass masking).
- Hook outputs are logged in clear text in the local transcript
  (`attachment` of type `hook_success`, `content` field empty so nothing is injected
  into context): local-disk exposure only, to be confirmed on the network side at
  batch 7 (mitmproxy).
- A model facing a failing Edit may attempt to reread the file in a form the detector
  does not recognize (`od -c` observed in practice: output spaced character by
  character, hence a clear-text leak). The `CLAUDE.md` instruction forbids it;
  residual risk documented, a model may improvise other encodings.

## Validation

```bash
bun test integrations/
bunx tsc --noEmit --project tsconfig.integrations.json
bunx biome check integrations
```
