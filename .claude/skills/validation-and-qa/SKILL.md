---
name: validation-and-qa
description: What counts as evidence in PasteGuard — test/typecheck/lint commands with their exact expected states, CI jobs, PII precision benchmark, how to add tests. Load before declaring work "done", after any code change, or when CI fails.
---

# Validation and QA — PasteGuard

House rule: nothing is "done" without an executed command and observed output. "It should work" is not a state.

## When NOT to use this skill

- For commit rules and territories → skill `change-control`.
- To diagnose a test failing strangely → skill `debugging-playbook`.

## The mandatory triptych before delivery

```bash
bun test && bun run typecheck && bun run check
```

Expected states (measured on 2026-07-07 on branch `fix/claude-code-transparency`, including the modified working tree) [verified: executed]:

| Command | Expected |
|---|---|
| `bun test` | **430 pass, 1 skip, 0 fail** — 431 tests, 31 files, ~300 ms. The only skip is "Logger Postgres backend … against Postgres" (requires a real Postgres). |
| `bun run typecheck` | exit 0, no error output |
| `bun run typecheck:benchmarks` | exit 0 |
| `bun run check` | "Checked 83 files … No fixes applied." |

If `bun test` shows more than one skip or any fail at all: the work is not deliverable. If the global formatting hook shows Prettier/ESLint errors, that's noise — see `debugging-playbook`.

## GitHub CI (`.github/workflows/ci.yml`, push and PR on main)

| Job | Steps |
|---|---|
| `test` | `bun install --frozen-lockfile` → typecheck → typecheck:benchmarks → check → bun test |
| `detector` | Python 3.11 venv → torch CPU → `ruff check .` → `ruff format . --check` → `pyright` → `pytest -q` (in `detector/`) |
| `docker-build` | build of the all-in-one image `docker/Dockerfile` |

[read: from .github/workflows/ci.yml]

The detector's Python tests were NOT run locally (no venv present); only CI guarantees them. To run them locally, reproduce the `detector` job's steps. [inferred: unconfirmed locally]

Release: on tag `v*`, multi-arch build (amd64+arm64) pushed to ghcr.io `:latest` and `:<version>` (`release.yml`). `.github/secret_scanning.yml` excludes `src/**/*.test.ts` from secret scanning (deliberate fake secrets in the tests, #31) — do not "fix" this exclusion. [read: from .github/workflows/release.yml, .github/secret_scanning.yml]

## PII precision benchmark

```bash
bun run benchmark:accuracy   # requires the detector to be running (see build-and-env)
# filters: --suite core|precision|eval|hard, --languages fr,en, --url <detector>, --verbose
```

- YAML corpus in 9 languages (en, de, es, fr, it, nl, pl, pt, ro), `benchmarks/pii-accuracy/test-data/`.
- The `core` and `precision` suites are GATING (failure = run failure); `eval` and `hard` are report-only (overridable per case via `gate`).
- The runner strictly validates the corpus: unknown field, unsupported language/entity, duplicate ID, missing expected text → failure.
- Match modes: `exact`, `contains` (±2 characters), `overlap` (deliberately loose cases). The cases encode the INTENDED behavior, not what the current detector actually achieves.
[read: from benchmarks/pii-accuracy/README.md] [inferred: unconfirmed — not run on 2026-07-07, detector stopped]

⚠️ The benchmark README cites `http://localhost:3000/analyze` as the default target, but the detector listens on 5002; check the actual value in `benchmarks/pii-accuracy/run.ts` before use. [read: from benchmarks/pii-accuracy/README.md] [inferred: unconfirmed]

Any change to a GLiNER floor or threshold MUST be justified by a before/after benchmark run, not by eyeballing it (see `domain-reference`).

## Adding tests

- Colocated tests: `<module>.test.ts` next to the module (31 existing files as models).
- Mandatory for: masking, forwarding, logging, config, public endpoints (AGENTS.md, see `change-control`).
- Mock isolation pitfall between route test files: see `debugging-playbook`.
- Shared utilities: `src/test-utils/detection-results.ts`.

## Provenance and maintenance

Written on 2026-07-07 from a full repository audit. Re-checks:
- `bun test 2>&1 | tail -5` (reference count to re-date if it changes)
- `grep -n "url" benchmarks/pii-accuracy/run.ts | head -5` (resolve the uncertainty about the default target)
