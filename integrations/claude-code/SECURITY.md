# What PasteGuard does not protect

This document lists what is NOT protected by PasteGuard's Claude Code integration. It must be read and accepted BEFORE entrusting a real piece of sensitive data (real name, real email, real secret) to a project placed under this protection.

PasteGuard masks detected PII and secrets before they enter the context sent to the API, and restores them locally (screen, files). This document does not describe what works: it describes the gaps, known and measured, in this mechanism.

## Method note: how to read the labels

Each statement below carries a label:

- **MEASURED**: observed directly, through a test or an inspection described (date and method given). This is a fact, not an estimate.
- **ESTABLISHED**: deduced from reading the integration's source code or the official Claude Code harness documentation, not contradicted by the available tests, but not the subject of an independent measurement.
- **NOT VERIFIED**: never tested. The actual behavior is unknown. Do not read this as reassuring or alarming: it is a blind spot, not a verdict.

No line in this document should be read as a guarantee that has not been proven.

## 1. What leaves in clear text over the network (severe level)

This is the most important category: everything below can leave the machine and reach `api.anthropic.com` without going through masking.

### 1.1 The prompt typed by the user

**ESTABLISHED.** What the user types directly into the conversation window always goes out in clear text. This is not a limitation of masking: it is a limitation of the Claude Code hooks API. The `UserPromptSubmit` hook can block sending or warn, it CANNOT rewrite the prompt content.

A warning hook exists (`scripts/user-prompt-submit.ts`, driven by `PASTEGUARD_PROMPT_MODE`). In `warn` mode, it reports the types of PII/secrets detected in the prompt and still lets the message go out. In `off` mode (default on install), it does nothing. No mode truly prevents sending without making the session fail on every false positive (`block` mode, not selected by default).

Practical consequence: never type real PII or a real secret directly into the prompt. Refer to entities structurally ("the first client in the list", "the IP at the top of the file"), never by their value.

### 1.2 Tool error messages

**MEASURED** (POC, see PROGRESS.md item 5): when a tool fails (file not found on Read, non-zero exit code on Bash), the `PostToolUse` hook does NOT fire. The error message enters the context without going through masking. If this error message reproduces a sensitive value (a path containing a name, an excerpt of a failed command with a value in clear text), it goes out as is.

### 1.3 Detection misses

The masking engine relies on a statistical model (GLiNER) for PII, supplemented by deterministic checksum-based rules for certain types (IBAN, VAT, cards). Neither is infallible.

- **MEASURED on 2026-07-20**: the confidence score for the `PERSON` type erodes through a combination of factors (number of people mentioned in the document, heterogeneity of record formats, presence of other entities), not a single isolated criterion. For the same name: 0.997 on an isolated line, 0.974 in a heterogeneous format, 0.941 in a complete real document (2 people, mixed formats, IP/VAT/IBAN lines). The `PERSON` type's confidence floor was lowered from 0.95 to 0.90 on 2026-07-20 to catch this case. Benchmark after this change: 0 gating failures, `PERSON` recall at 100%, one new false positive observed (a job title in German wrongly detected as a person's name, with no leak consequence).
- Despite this calibration, detection remains a statistical model: it can miss a name, especially a compound name or a document format never seen during calibration. There is no way to obtain a guarantee of 100% recall with a statistical detector.
- **ESTABLISHED (code review, `detector/detector/deterministic.py`)**: the `VAT_CODE` type validates a checksum (FR key + SIREN Luhn) before treating a string as a VAT number. A VAT number fabricated with an invalid checksum (for example a demo fixture invented sequentially) IS NOT detected and goes out in clear text. This is an intentional choice to limit false positives on business references that resemble a VAT number. A real VAT number, valid by construction, is detected normally.
- The post-session control grep (section 6 below) is the only reliable measure of what actually escaped detection on a given real document. No promise of exhaustive detection is made here.

### 1.4 Bypassing via encoding

**MEASURED** (incident observed in POC, see PROGRESS.md item 13): faced with a failing Edit, a model (Claude Haiku, in this test) spontaneously reread a file via `od -c`. The output, formatted character by character with spaces, escaped detection: an email went out in clear text in the context.

A prohibition instruction (`od`, `xxd`, `hexdump`, `base64` and any other bypass encoding) was added to the protected project's `CLAUDE.md`. **This is not a technical guarantee**, it is a textual instruction addressed to the model: nothing mechanically prevents a model from improvising another encoding that escapes the detector (a character-by-character loop, a string rotation, an unusual command). The actual extent of this risk beyond the observed case is not measured.

### 1.5 Startup context sent by the Claude Code harness

**MEASURED on 2026-07-20**, method: passive mitmproxy interception of traffic to `api.anthropic.com`, over 4 scenarios (reading a PII file, reading secrets via Bash, modifying via Edit, searching via Bash grep), **headless** session (`claude -p`) in the test project `pasteguard-test/`. 119 requests captured, 4,297,399 bytes of outgoing body total.

Go out in clear text, no matter what, independent of PasteGuard masking:

- absolute filesystem paths (`/Users/jb/...`);
- the full content of the project's `CLAUDE.md`;
- the list of available skills;
- the model name in use;
- the project path.

Do NOT go out in clear text (contrary to what was anticipated before measurement):

- the Anthropic account email address;
- the git username.

**NOT VERIFIED**: behavior in an **interactive** session, in a real project. The measurement above covers only a headless session. In an interactive session, the harness is known to send more startup context (git status, `AGENTS.md` content, conversation history, etc. according to the Claude Code documentation): nothing guarantees this inventory is complete for that usage mode, which is the actual usage mode targeted by this project. This inventory will need to be redone in an interactive session before any use on real data.

Immediate practical consequence: **never put real PII or a real secret in the `CLAUDE.md` or `AGENTS.md` of a protected project.** These files go out in clear text, systematically.

### 1.6 Unmeasured risk: silent death of the hooks (upstream bug #16047)

**NOT VERIFIED.** An open issue on the `anthropics/claude-code` repository (#16047) reports that hooks can stop firing after about 2h30 of continuous session. If this bug occurs, `PostToolUse` no longer masks anything: tool outputs enter the context in clear text, WITHOUT a visible error, WITHOUT a warning message. This is a silent violation of the fail-closed principle, caused by the harness itself and outside PasteGuard's control.

This behavior has not been retested on the current version of the `claude` binary (2.1.215) at the time this document was written. No integrity marker (a systematic sign in masked outputs, whose absence would alert the user) is implemented to date.

Precautionary instruction, in the absence of verification: **restart the session regularly (roughly every 2 hours) on a project containing sensitive data.**

## 2. What remains in clear text on local disk (local exposure only)

This category covers what is NOT sent over the network, but exists in clear text on the machine's disk. The trust boundary here is the machine itself: if the machine is compromised, these elements are readable.

### 2.1 The session store (`~/.pasteguard/claude-sessions/`)

This directory contains the **real values** in clear text, in each session's placeholder-to-value mapping. It is necessary for the mechanism itself to work (it is what allows restoring the screen and files).

Protection: Unix permissions only (directory 700, files 600). No encryption at rest.

**MEASURED on 2026-07-20**: this directory is not picked up by any identified cloud backup on this machine. Verified: Syncthing does not sync any directory other than the one explicitly configured (`~/.pasteguard/` is not among them), no Time Machine destination is configured on this machine, the directory is neither in iCloud Drive nor in Dropbox. This finding is valid on this machine at this date; it is not guaranteed on another machine or after a backup configuration change.

### 2.2 The local session transcript (`~/.claude/projects/.../<session_id>.jsonl`)

**MEASURED on 2026-07-20**, same mitmproxy capture as section 1.5: hook outputs (notably `PreToolUse`) are logged IN CLEAR TEXT by Claude Code in the local transcript, as `attachment` entries of type `hook_success`, including when the hook's stdout contains a real restored value (for example a `sed` command restored with the real value to work around the Edit failure described in 3.2).

This fact was identified before measurement as a potential network leak risk (the transcript content could theoretically be reinjected on the next turn). The 2026-07-20 measurement confirms this risk did NOT materialize across the 119 requests observed: no `hook_success` or `updatedInput` string appears in any outgoing request body. **The exposure from the fact "transcript in clear text" is therefore strictly local (disk), confirmed by the network measurement, not merely assumed.**

This remains a real disk exposure: anyone with read access to the `~/.claude/projects/` folder (same user, another process, a non-excluded backup) can read the real values restored in these `attachment` entries.

### 2.3 The screen

The unmasked display (batch 5, `MessageDisplay`) shows the real values on screen, by design, that is the intended purpose. This is not a leak but a reminder: anyone watching the screen during a session sees the real values, not the placeholders.

## 3. What is functionally degraded (not leaked, but broken)

This category leaks nothing. It describes what the model can no longer do correctly because it is reasoning over placeholders (`[[TYPE_n]]`) rather than real values.

### 3.1 Correlation with the prompt

**MEASURED** (PROGRESS.md item 17): if the user names an entity in clear text in their prompt ("Jean Dupont's email"), but Claude only sees `[[PERSON_1]]` in the files, it CANNOT make the connection. Observed behavior: Claude asks for clarification rather than guessing, which is a safe behavior but interrupts the workflow. Entities must be designated **structurally** ("the first person listed", "the contact at the top of the file"), never by their name.

Any reasoning that requires the real value is degraded the same way: alphabetical sorting on masked names, format validation (a placeholder does not "look like" an email), matching between two documents that use different labels for the same entity.

### 3.2 Edit whose `old_string` contains a placeholder

**MEASURED** (PROGRESS.md item 12): the `old_string` validation of an Edit happens against the file's actual content on disk, BEFORE the `PreToolUse` hook is called. An Edit whose `old_string` contains a placeholder therefore ALWAYS fails ("String to replace not found"), the hook never being invoked. This is structurally impossible to fix on the hook side.

Workaround in place: an instruction in the protected project's `CLAUDE.md` asks the model to fall back to a `sed` command (whose Bash input will, in turn, be correctly restored by the `PreToolUse` hook) when an Edit fails for this reason. Proven to work end to end, but it is a workaround, not a native solution.

### 3.3 Rejection of values incompatible with a shell (Bash)

Unmasking of Bash inputs refuses to substitute a value if it is not made up of characters considered safe on a command line (alphanumeric and `@.-_+:/`). This is a deliberate security guard (to avoid a value containing `;`, quotes, or an injection character breaking or hijacking the command). Consequence: a legitimate command involving an "at risk" value (a secret containing spaces or special characters, for example) is refused rather than executed. Practical friction whose extent in real usage has not yet been measured.

### 3.4 Added latency

**MEASURED**: each call to the masking engine adds about 0.6 second per kilobyte of scanned text, on a cold cache. A 10 KB file adds about 6 seconds, 30 KB about 18 seconds; beyond 100 KB, the detector exceeds its timeout (30 s) and returns an error. Repeated scans of the same content are cached and become near-instant.

## 4. Measurement proof from 2026-07-20: method and results

This section details the measurement cited in sections 1.5 and 2.2, so the method is verifiable.

**Method**: passive interception (no content modification) of outgoing HTTPS traffic to `api.anthropic.com`, via a local mitmproxy, with the mitmproxy root certificate installed as an additional trusted authority for the `claude` session. Four scenarios replayed in the test project `pasteguard-test/`:

1. reading a file containing PII (Read);
2. reading secrets via Bash (`cat`);
3. modifying a file via Edit;
4. searching for a value via `grep` through Bash.

**Results**:

- 119 requests captured, 4,297,399 bytes of cumulative outgoing body.
- Zero occurrence, across the whole set of bodies, of the 21 sensitive test values (names, emails, phone numbers, IBAN, IP address, valid VAT number, `sk-ant` key, `ghp_` token, JWT, connection string, passwords).
- The corresponding `[[TYPE_n]]` placeholders are indeed present in place of the real values.
- None of the `hook_success` or `updatedInput` strings (which carry the real values restored locally, see section 2.2) appear in the 119 requests.

**Explicit limit of this measurement**: it was carried out in a **headless** session, in a test project with synthetic fixtures, on 4 scenarios only (out of the 16 scenarios planned by the validation plan). It covers neither the interactive session, nor a session longer than 2h30 (section 1.6), nor encoding-bypass attempts beyond the case already observed (section 1.4), nor MCP tools. A green measurement on 4 headless scenarios is a necessary condition, not a sufficient one, to conclude there is no network leak in full real-world usage.

## 5. Incident procedure

| Incident | Detection | Immediate action |
|---|---|---|
| PasteGuard engine stopped mid-session | The message `[PasteGuard unavailable: the tool output was withheld for safety...]` is shown instead of the tool result. | Restart the service (`bun run start`), resume the session: the session mapping survives the stop. |
| PII detector stopped | `curl localhost:3333/health` returns `detector: down`; `/api/mask` returns a 503 error. | `docker compose --profile dev up detector -d`, wait for healthy status (up to 1 minute if the model is cached). |
| Dead hooks (upstream bug #16047, section 1.6) | **NOT VERIFIED to date**: no integrity marker is implemented to signal this case. The only detection possible today is an after-the-fact control grep (section 6). | If a sign suggests masking is absent (outputs visibly not transformed): stop the session immediately, start a new session, treat the last turns as unprotected and handle the values they contained as potentially exposed. |
| Leak found after the fact (at control grep) | Occurrence of a known sensitive value in a JSONL transcript. | Log the incident (what, when, which scenario); if the value is an active secret (API key, password), revoke it immediately, independent of any root-cause analysis. |
| Corrupted session store | Restoration error, or placeholders that no longer resolve although they resolved before. | **MEASURED (code review, `lib/store.ts`)**: the current behavior, in case of an unreadable session file, is to rename it (`<file>.corrupt-<timestamp>`) and start over with a blank state. **No automatic backup (`.bak`) is implemented to date**: the current mapping is lost, not restored. A placeholder that becomes unresolved stays displayed as is (no leak, but no more unmasking possible for values already masked in that session). Recommendation: end the session and open a new one rather than continuing on a renumbered state. |

## 6. How to verify it yourself

Do not rely on this document alone. After each session on a protected project, verify with a control grep.

**Where transcripts are located**: Claude Code writes one JSONL file per session in `~/.claude/projects/<project-path-slug>/<session_id>.jsonl`, where `<project-path-slug>` is the project's absolute path with each `/` replaced by `-`. Example for a project located at `/Users/jb/Documents/MyProject`: `~/.claude/projects/-Users-jb-Documents-MyProject/`.

**Control grep command**: first build a list of the project's known sensitive values (one value per line, in an unversioned file), then:

```bash
grep -F -f sensitive-values.txt ~/.claude/projects/<project-slug>/<session_id>.jsonl
```

`-F` searches for literal strings (not regexes), which avoids false negatives due to special characters in values (email, IBAN, etc.). **No occurrence should be found.**

If an occurrence appears, examine the immediate context of the line in question before concluding there is a network leak: a `user`-type entry corresponding to the typed prompt (section 1.1) or an `attachment` entry of type `hook_success` (section 2.2) are already known, documented, local exposures, not new network leaks. An occurrence in an `assistant` entry other than the citation of a placeholder, on the other hand, deserves immediate investigation.

This grep on the local transcript does NOT prove the absence of a network leak by itself: only a traffic capture (like the one described in section 4) proves that. It is nonetheless the verification accessible to any user, to be done systematically.

## 7. Before entrusting a project to PasteGuard: checklist

1. **Reread the project's `CLAUDE.md` and `AGENTS.md`.** They go out in clear text to the API (section 1.5). No PII, no secret must appear there.
2. **Write the list of the project's known sensitive values** in an unversioned file (excluded from the git repo), to be able to run the control grep from section 6 after each session.
3. **Verify that the PasteGuard engine and the PII detector are running** before starting (`curl localhost:3333/health` must respond `detector: up`).
4. **Run a first control session**: request a Read of a file containing a known sensitive value, then run the control grep on the resulting transcript. Only begin real usage once this session is green.
5. **Designate entities structurally in prompts**, never by their real name or value (section 3.1), to avoid both a leak in the prompt and confusing the model.

## 8. Acknowledgement of reading

This document has been read and its content understood before any use of PasteGuard on real sensitive data, in particular the limitations of sections 1 (network leaks), 2 (local disk exposure) and 3 (functional degradation), and the points explicitly marked NOT VERIFIED.

To be dated and countersigned in `PROGRESS.md` (decisions log section) before the first session on a project containing real sensitive data:

`Read and accepted on [date], by [name].`
