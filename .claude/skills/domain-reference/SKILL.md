---
name: domain-reference
description: PasteGuard PII/secrets detection semantics that a non-specialist engineer or model would not know — the detector's two layers (deterministic + GLiNER), per-label confidence floors, suppressor labels, windowing of long texts, cache, inference lock, denylist/allowlist merge, secret pattern registry. Load when an entity is misdetected, over-detected, or missed, or before tuning thresholds.
---

# Domain Reference — PII and Secrets Detection

## When NOT to use this skill

- To change a threshold in config.yaml → skill `config-and-flags` (the keys are there).
- For the overall flow and API contracts → skill `architecture-contract`.
- To measure accuracy → benchmark described in `validation-and-qa`.

## The detector's two layers (`detector/`)

1. **`deterministic.py`**: regex + checksums, emails, phone numbers (`phonenumbers` lib), credit cards, IBAN, IP, EU VAT (`python-stdnum`). Reliable, fast, no model.
2. **`gliner_layer.py`**: multilingual GLiNER NER (model `urchade/gliner_multi_pii-v1`) for person / location / address.

Both are merged by `merge.py`. [read: from detector/detector/*]

## GLiNER behaviors to know before "tuning" anything

- **Confidence floors PER LABEL**, calibrated against the benchmark: person 0.95, location 0.80, address 0.80. Overridable via env (`DETECTOR_FLOOR_PERSON|LOCATION|ADDRESS`). The request's `score_threshold` can only RAISE these floors, never lower them. [read: from detector/detector/gliner_layer.py]
- **Suppressor labels**: `customer` and `role` are predicted but never emitted. If the "role" reading is stronger than the "person" reading on the same span, the entity is dropped: this is the anti-false-positive mechanism (no per-language denylist). [read: from detector/detector/gliner_layer.py]
- **`address` is emitted as LOCATION.** [read: from detector/detector/gliner_layer.py]
- **Windowing**: GLiNER truncates beyond ~384 word-tokens (`DETECTOR_MAX_TOKENS`). Long text is split into overlapping windows (overlap 64), spans shifted back to absolute offsets, deduplicated at max score. LRU cache of 4096 windows. [read: from detector/detector/gliner_layer.py]
- **`_infer_lock`**: torch inference is serialized (not thread-safe). The detector's real capacity = ONE inference at a time; this is the reason for the "sequential scans" invariant on the proxy side (see `architecture-contract`, invariant 3). [read: from detector/detector/gliner_layer.py]

## Denylist/allowlist merge (proxy side, `src/pii/detect.ts`)

- Denylist matches at score 1.
- A match INSIDE an already-placed placeholder is ignored (re-masking the inside would corrupt the mask).
- Additive merge: a denylist span EXTENDS but never shrinks a detector span; on overlap, the detector's type wins.
- Allowlist regex anchored `^(?:pattern)$` on the detected text. [read: from src/pii/detect.ts]

## Secret patterns (`src/secrets/patterns/`)

Registry organized by family: `api-keys.ts`, `env-vars.ts`, `private-keys.ts`, `tokens.ts` (#18). `API_KEY_SK` generalizes the former `API_KEY_OPENAI` (#61). Secret placeholders no longer carry a `SECRET_MASKED_` prefix (#60). List of the 10 types active by default: see `config-and-flags`. [read: from src/secrets/patterns/, git history]

## Investigation heuristics

| Observation | Lead |
|---|---|
| Proper name not masked | person floor 0.95: score below it → raise via benchmark, not by guesswork |
| Job title/occupation masked as PERSON | check whether the `role` suppressor label should have won; a case for the benchmark corpus |
| Entity missed in a very long text | window effect: check the position vs ~384 tokens and the overlap |
| Slow detection on large payloads | many windows × serialized inference; see `max_scan_chars` and `detector_timeout` in `config-and-flags` |
| Legitimate value always masked | the config allowlist is made for that (`config-and-flags`) |

## Provenance and maintenance

Written on 2026-07-07 via a full repository audit. Re-checks:
- `grep -n "FLOOR\|suppress\|_infer_lock\|lru" detector/detector/gliner_layer.py`
- `grep -n "score: 1\|denylist" src/pii/detect.ts`
- `ls src/secrets/patterns/` (pattern families)
