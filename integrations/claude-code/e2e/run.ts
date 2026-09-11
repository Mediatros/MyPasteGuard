#!/usr/bin/env bun
/**
 * E2E harness batch 7 (plans/07-e2e.md, plans/11-deploiement.md §7): runs
 * headless `claude -p` scenarios in `pasteguard-test/`, then checks that NO
 * fixture value appears, literally, in the session's full JSONL transcript.
 * Binary criterion per value: zero occurrences.
 *
 * Does NOT replace the mitmproxy protocol (S11/S12, manual, see README.md):
 * this harness observes the LOCAL transcript, not the real network wire.
 *
 * Usage:
 *   bun run integrations/claude-code/e2e/run.ts [--only S1,S3] [--dry-run]
 *
 * Output: scenario / GREEN-RED / evidence table on stdout, JSON report in
 * e2e/results/<timestamp>.json. Non-zero exit code if a scenario is RED (or
 * if the harness itself fails to reach a conclusion on a scenario).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionsDir } from "../lib/store";
import type { SessionState } from "../lib/types";

const TEST_PROJECT_DIR =
  process.env.PASTEGUARD_E2E_PROJECT_DIR ?? "/Users/jb/Documents/MyProjects/LOCAL/pasteguard-test";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const DEFAULT_MODEL = "haiku";
const DEFAULT_TIMEOUT_MS = 120_000;
const E2E_DIR = import.meta.dir;
const VALUES_FILE = join(E2E_DIR, "sensitive-values.txt");
const RESULTS_DIR = join(E2E_DIR, "results");

/**
 * EXACT environment purge (PROGRESS.md, headless test recipe): without it,
 * the API key of a possible parent session overrides the subscription OAuth
 * and the call fails with a 401.
 */
const ENV_TO_UNSET = [
  "ANTHROPIC_API_KEY",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PID",
];

function projectSlug(absPath: string): string {
  return `-${absPath.split("/").filter(Boolean).join("-")}`;
}

const TRANSCRIPTS_DIR = join(homedir(), ".claude", "projects", projectSlug(TEST_PROJECT_DIR));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckResult {
  ok: boolean;
  label: string;
  detail: string;
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  sessionIdFromJson: string | null;
}

interface FileSnapshot {
  existed: boolean;
  content?: string;
}

interface ScenarioContext {
  cli: CliResult;
  transcriptPath: string | null;
  transcriptRaw: string | null;
  sessionId: string | null;
}

interface Scenario {
  id: string;
  description: string;
  prompt: string;
  allowedTools: string;
  maxTurns: number;
  model?: string;
  timeoutMs?: number;
  /** Paths relative to pasteguard-test/ that the scenario may create/modify: saved then restored. */
  filesToRestore?: string[];
  /** Checks specific to this scenario, in addition to the generic zero-leak grep (plans/07, plans/11 §7.2). */
  extraChecks?: (ctx: ScenarioContext) => Promise<CheckResult[]>;
}

interface ScenarioReport {
  id: string;
  description: string;
  status: "GREEN" | "RED";
  durationMs: number;
  sessionId: string | null;
  transcriptPath: string | null;
  checks: CheckResult[];
  cliExitCode: number | null;
  cliTimedOut: boolean;
  stderrExcerpt: string;
}

// ---------------------------------------------------------------------------
// Generic utilities
// ---------------------------------------------------------------------------

async function loadSensitiveValues(): Promise<string[]> {
  if (!existsSync(VALUES_FILE)) {
    throw new Error(
      `Missing sensitive values file: ${VALUES_FILE}. ` +
        "Run `bun run integrations/claude-code/e2e/build-sensitive-values.ts` first.",
    );
  }
  const raw = await readFile(VALUES_FILE, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 6 && !line.startsWith("#"));
}

interface PromptGuardViolation {
  scenarioId: string;
  value: string;
}

/**
 * Structural guard (not cosmetic): a scenario prompt must NEVER literally
 * name a fixture's sensitive value. Otherwise the model sees the value in
 * the clear in its own prompt (so it goes out anyway, from the very first
 * turn) AND cannot correlate it with the placeholder it sees in the masked
 * files (structural UX limitation, fact 17 of PROGRESS.md): the scenario
 * fails functionally (the targeted tool is never called) on top of skewing
 * the zero-leak check. Designate the entity STRUCTURALLY ("the first
 * client", "the second email address"...).
 */
function checkPromptsAgainstSensitiveValues(
  scenarios: Scenario[],
  values: string[],
): PromptGuardViolation[] {
  const violations: PromptGuardViolation[] = [];
  for (const scenario of scenarios) {
    for (const value of values) {
      if (scenario.prompt.includes(value)) violations.push({ scenarioId: scenario.id, value });
    }
  }
  return violations;
}

function wasToolUsed(transcriptRaw: string | null, toolName: string): boolean {
  if (!transcriptRaw) return false;
  for (const line of transcriptRaw.split("\n")) {
    if (line.length === 0 || !line.includes(`"name":"${toolName}"`)) continue;
    try {
      const obj = JSON.parse(line) as { message?: { content?: unknown } };
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "tool_use" &&
          (block as Record<string, unknown>).name === toolName
        ) {
          return true;
        }
      }
    } catch {
      // JSONL line not parseable in isolation: ignore, this isn't what makes the check fail.
    }
  }
  return false;
}

async function snapshotFile(relPath: string): Promise<FileSnapshot> {
  const abs = join(TEST_PROJECT_DIR, relPath);
  try {
    const content = await readFile(abs, "utf8");
    return { existed: true, content };
  } catch {
    return { existed: false };
  }
}

async function restoreFile(relPath: string, snapshot: FileSnapshot): Promise<void> {
  const abs = join(TEST_PROJECT_DIR, relPath);
  if (snapshot.existed && snapshot.content !== undefined) {
    await writeFile(abs, snapshot.content, "utf8");
  } else {
    await rm(abs, { force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI execution and transcript resolution
// ---------------------------------------------------------------------------

function buildArgs(scenario: Scenario): string[] {
  return [
    "-p",
    scenario.prompt,
    "--output-format",
    "json",
    "--allowedTools",
    scenario.allowedTools,
    "--max-turns",
    String(scenario.maxTurns),
    "--model",
    scenario.model ?? DEFAULT_MODEL,
  ];
}

/** Reproduces the `env -u X -u Y ... claude ...` command for display (--dry-run) and logs. */
function formatCommandForDisplay(scenario: Scenario): string {
  const unsets = ENV_TO_UNSET.map((k) => `-u ${k}`).join(" ");
  const args = buildArgs(scenario)
    .map((a) => (a.includes(" ") || a.includes('"') ? JSON.stringify(a) : a))
    .join(" ");
  return `(cd ${TEST_PROJECT_DIR} && env ${unsets} ${CLAUDE_BIN} ${args})`;
}

async function runClaude(scenario: Scenario): Promise<CliResult> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of ENV_TO_UNSET) delete env[key];

  const proc = Bun.spawn({
    cmd: [CLAUDE_BIN, ...buildArgs(scenario)],
    cwd: TEST_PROJECT_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const started = Date.now();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const durationMs = Date.now() - started;

  let sessionIdFromJson: string | null = null;
  try {
    const parsed = JSON.parse(stdout) as { session_id?: unknown };
    if (typeof parsed.session_id === "string") sessionIdFromJson = parsed.session_id;
  } catch {
    // --output-format json can fail to produce pure JSON (error before clean output,
    // timeout killed mid-stream...): fall back to the most recent .jsonl file below.
  }

  return { exitCode, stdout, stderr, durationMs, timedOut, sessionIdFromJson };
}

/**
 * Identifies the session's transcript: priority to the `session_id` returned
 * by `--output-format json` (reliable), fallback to the most recently
 * modified `.jsonl` file in the project directory, created after launch.
 */
async function resolveTranscriptPath(cli: CliResult, launchedAt: number): Promise<string | null> {
  if (cli.sessionIdFromJson) {
    const p = join(TRANSCRIPTS_DIR, `${cli.sessionIdFromJson}.jsonl`);
    if (existsSync(p)) return p;
  }
  try {
    const entries = await readdir(TRANSCRIPTS_DIR, { withFileTypes: true });
    let best: { path: string; mtimeMs: number } | null = null;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const p = join(TRANSCRIPTS_DIR, entry.name);
      const s = await stat(p);
      // 2s margin: process clock vs file mtime.
      if (s.mtimeMs >= launchedAt - 2000 && (!best || s.mtimeMs > best.mtimeMs)) {
        best = { path: p, mtimeMs: s.mtimeMs };
      }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Generic check: zero leak in the full JSONL transcript
// ---------------------------------------------------------------------------

interface LeakOccurrence {
  value: string;
  count: number;
  promptHits: number;
  contentHits: number;
  attachmentHits: number;
  otherHits: number;
}

function truncateValue(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/**
 * Literal grep (not regex) of each sensitive value in EVERY line of the
 * transcript. Classification per occurrence, PRIORITY to the prompt
 * category:
 *
 * - "user prompt": the value appears in the scenario's own prompt
 *   (`scenario.prompt`). Covers both the entries that carry the prompt as-is
 *   (`user`, `queue-operation`, `last-prompt` observed in practice) and any
 *   literal quoting of this value by the assistant: if the value was already
 *   in the clear from turn 0 (the typed prompt), THIS IS NOT a new masking
 *   leak, it's the project's structural limitation #1 (fact 17, PROGRESS.md:
 *   the typed prompt always goes out in the clear). Does NOT fail the
 *   scenario; counted and reported separately. The
 *   `checkPromptsAgainstSensitiveValues` guard already prevents a scenario of
 *   this harness from falling into this case; this category protects
 *   against a future prompt that would name an entity by mistake.
 * - "attachment" (fact 16): hook stdout logged locally in the clear, not a
 *   network send.
 * - "message CONTENT" (`user`/`assistant`, outside the prompt): potentially
 *   sent to the API, fails the scenario.
 * - "elsewhere": to be examined case by case, fails the scenario.
 */
function checkZeroLeak(transcriptRaw: string, values: string[], prompt: string): CheckResult {
  const lines = transcriptRaw.split("\n").filter((l) => l.length > 0);
  const occurrences: LeakOccurrence[] = [];

  for (const value of values) {
    const fromPrompt = prompt.includes(value);
    let count = 0;
    let promptHits = 0;
    let contentHits = 0;
    let attachmentHits = 0;
    let otherHits = 0;
    for (const line of lines) {
      if (!line.includes(value)) continue;
      const n = line.split(value).length - 1;
      count += n;
      if (fromPrompt) {
        promptHits += n;
        continue;
      }
      let type: string | undefined;
      try {
        type = (JSON.parse(line) as { type?: string }).type;
      } catch {
        type = undefined;
      }
      if (type === "attachment") attachmentHits += n;
      else if (type === "user" || type === "assistant") contentHits += n;
      else otherHits += n;
    }
    if (count > 0)
      occurrences.push({
        value,
        count,
        promptHits,
        contentHits,
        attachmentHits,
        otherHits,
      });
  }

  const failing = occurrences.filter((o) => o.contentHits + o.attachmentHits + o.otherHits > 0);
  const promptOnly = occurrences.filter(
    (o) => o.contentHits + o.attachmentHits + o.otherHits === 0 && o.promptHits > 0,
  );

  if (failing.length === 0) {
    const note =
      promptOnly.length > 0
        ? ` — limitation structurelle connue (prompt) sur ${promptOnly.length} valeur(s) : ${promptOnly
            .map((o) => `"${truncateValue(o.value)}"`)
            .join(", ")}`
        : "";
    return {
      ok: true,
      label: "transcript zero-leak",
      detail: `0 occurrence outside prompt across ${values.length} tested value(s)${note}`,
    };
  }

  const detail = failing
    .map((o) => {
      const parts: string[] = [];
      if (o.contentHits > 0) parts.push(`${o.contentHits}x in message CONTENT (potential leak)`);
      if (o.attachmentHits > 0)
        parts.push(`${o.attachmentHits}x in local hook attachment (fact 16, not network)`);
      if (o.otherHits > 0) parts.push(`${o.otherHits}x elsewhere (to examine)`);
      if (o.promptHits > 0) parts.push(`${o.promptHits}x in the prompt (out of scope)`);
      return `"${truncateValue(o.value)}" x${o.count} (${parts.join(", ")})`;
    })
    .join(" ; ");

  return { ok: false, label: "transcript zero-leak", detail };
}

// ---------------------------------------------------------------------------
// Scenario-specific checks (session store)
// ---------------------------------------------------------------------------

async function loadSessionState(sessionId: string): Promise<SessionState | null> {
  const p = join(sessionsDir(), `${sessionId}.json`);
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

/** S6: no value must be mapped under two different placeholders (dedup D5). */
async function checkMappingInjective(sessionId: string): Promise<CheckResult> {
  const state = await loadSessionState(sessionId);
  if (!state) {
    return {
      ok: false,
      label: "store consistency (dedup)",
      detail: `store not found for session ${sessionId} (${join(sessionsDir(), `${sessionId}.json`)})`,
    };
  }
  const byValue = new Map<string, string[]>();
  for (const [placeholder, value] of Object.entries(state.mapping)) {
    const list = byValue.get(value) ?? [];
    list.push(placeholder);
    byValue.set(value, list);
  }
  const collisions = [...byValue.entries()].filter(([, placeholders]) => placeholders.length > 1);
  if (collisions.length === 0) {
    return {
      ok: true,
      label: "store consistency (dedup)",
      detail: `${Object.keys(state.mapping).length} mapping entry(ies), all injective`,
    };
  }
  const detail = collisions
    .map(([value, placeholders]) => `"${value.slice(0, 30)}" -> ${placeholders.join(", ")}`)
    .join(" ; ");
  return {
    ok: false,
    label: "store consistency (dedup)",
    detail: `collision(s): ${detail}`,
  };
}

/** The store must not have been set aside as corrupted during/after the scenario (S14, concurrent lock). */
async function checkStoreNotCorrupted(sessionId: string): Promise<CheckResult> {
  const dir = sessionsDir();
  try {
    const entries = await readdir(dir);
    const corrupt = entries.filter((f) => f.startsWith(`${sessionId}.json.corrupt-`));
    if (corrupt.length === 0) {
      return {
        ok: true,
        label: "store integrity",
        detail: "no .corrupt-* file for this session",
      };
    }
    return {
      ok: false,
      label: "store integrity",
      detail: `corrupted file(s) detected: ${corrupt.join(", ")}`,
    };
  } catch (err) {
    return {
      ok: false,
      label: "store integrity",
      detail: `store directory unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Scenario table (S1-S6, S14 - plans/07-e2e.md, plans/11-deploiement.md §7.2)
// ---------------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  {
    id: "S1",
    description: "Read fixtures/clients.txt and summarize the clients",
    prompt:
      "Read fixtures/clients.txt and summarize who the clients are (only their names, no other detail).",
    allowedTools: "Read",
    maxTurns: 4,
    extraChecks: async (ctx) => [
      {
        ok: wasToolUsed(ctx.transcriptRaw, "Read"),
        label: "Read tool used",
        detail: wasToolUsed(ctx.transcriptRaw, "Read") ? "confirmed" : "no Read tool_use found",
      },
    ],
  },
  {
    id: "S2",
    description: "cat fixtures/env.fake via Bash (secrets)",
    prompt: 'Use Bash to run "cat fixtures/env.fake" and show me the content.',
    allowedTools: "Bash",
    maxTurns: 4,
    extraChecks: async (ctx) => [
      {
        ok: wasToolUsed(ctx.transcriptRaw, "Bash"),
        label: "Bash tool used",
        detail: wasToolUsed(ctx.transcriptRaw, "Bash") ? "confirmed" : "no Bash tool_use found",
      },
    ],
  },
  {
    id: "S3",
    description: "Edit: replace the first client's email (fixtures/clients.txt)",
    prompt:
      "In fixtures/clients.txt, replace only the email address of the first listed " +
      "client with contact@example.org, without touching the rest of the file.",
    allowedTools: "Read,Edit,Bash",
    maxTurns: 6,
    filesToRestore: ["fixtures/clients.txt"],
    extraChecks: async () => {
      const p = join(TEST_PROJECT_DIR, "fixtures/clients.txt");
      let content = "";
      try {
        content = await readFile(p, "utf8");
      } catch {
        // unreadable file: the check below will fail with empty content
      }
      const ok = content.includes("contact@example.org");
      return [
        {
          ok,
          label: "disk: real value written",
          detail: ok
            ? "fixtures/clients.txt does contain contact@example.org"
            : "contact@example.org missing from fixtures/clients.txt after the scenario",
        },
      ];
    },
  },
  {
    id: "S4",
    description: "Write: create note.md with the first client's phone number",
    prompt:
      "Create a note.md file at the project root containing only the phone number " +
      "of the first client listed in fixtures/clients.txt, a single line, nothing else.",
    allowedTools: "Read,Write",
    maxTurns: 5,
    filesToRestore: ["note.md"],
    extraChecks: async () => {
      const p = join(TEST_PROJECT_DIR, "note.md");
      let content = "";
      try {
        content = await readFile(p, "utf8");
      } catch {
        // missing file: the check below will fail with empty content
      }
      const ok = content.includes("06 12 34 56 78");
      return [
        {
          ok,
          label: "disk: real value written",
          detail: ok
            ? "note.md does contain the real phone number"
            : "the real phone number is missing from note.md after the scenario",
        },
      ];
    },
  },
  {
    id: "S5",
    description: "Bash grep: search for the first contact's email in fixtures/ (Bash unmasking)",
    prompt:
      "Read fixtures/clients.txt, find the email address of the first listed contact, then use " +
      "grep -F in Bash to search for it literally across the whole fixtures/ folder and show the result.",
    allowedTools: "Read,Bash",
    maxTurns: 6,
    extraChecks: async (ctx) => [
      {
        ok: wasToolUsed(ctx.transcriptRaw, "Read") && wasToolUsed(ctx.transcriptRaw, "Bash"),
        label: "Read + Bash tools used",
        detail: `Read=${wasToolUsed(ctx.transcriptRaw, "Read")} Bash=${wasToolUsed(ctx.transcriptRaw, "Bash")}`,
      },
    ],
  },
  {
    id: "S6",
    description: "Cross-tool consistency: two reads of clients.txt, same value -> same placeholder",
    prompt:
      "Read fixtures/clients.txt with the Read tool. Then read it again a second time with a NEW call " +
      "to the Read tool (don't reuse the previous result, really rerun the tool). Just confirm " +
      "that the two reads are identical, no other comment.",
    allowedTools: "Read",
    maxTurns: 5,
    extraChecks: async (ctx) => {
      const toolCheck: CheckResult = {
        ok: wasToolUsed(ctx.transcriptRaw, "Read"),
        label: "Read tool used",
        detail: wasToolUsed(ctx.transcriptRaw, "Read") ? "confirmed" : "no Read tool_use found",
      };
      if (!ctx.sessionId) {
        return [
          toolCheck,
          {
            ok: false,
            label: "store consistency (dedup)",
            detail: "unknown session_id, check impossible",
          },
        ];
      }
      return [toolCheck, await checkMappingInjective(ctx.sessionId)];
    },
  },
  {
    id: "S14",
    description: "5 parallel tool calls in the same turn (R4: no placeholder collision)",
    prompt:
      "Launch, in PARALLEL, in the same message (5 separate tool calls, not successive turns): " +
      '(1) Read fixtures/clients.txt, (2) Bash "cat fixtures/env.fake", ' +
      '(3) Bash "cat fixtures/clients.txt", (4) Read fixtures/env.fake, ' +
      '(5) Bash "wc -l fixtures/clients.txt fixtures/env.fake". ' +
      "Then summarize in one sentence that the 5 results came back.",
    allowedTools: "Read,Bash",
    maxTurns: 4,
    timeoutMs: 150_000,
    extraChecks: async (ctx) => {
      if (!ctx.sessionId) {
        return [
          {
            ok: false,
            label: "store integrity",
            detail: "unknown session_id, check impossible",
          },
          {
            ok: false,
            label: "store consistency (dedup)",
            detail: "unknown session_id, check impossible",
          },
        ];
      }
      return [
        await checkStoreNotCorrupted(ctx.sessionId),
        await checkMappingInjective(ctx.sessionId),
      ];
    },
  },
];

// ---------------------------------------------------------------------------
// Running a scenario
// ---------------------------------------------------------------------------

async function runScenario(scenario: Scenario, values: string[]): Promise<ScenarioReport> {
  const snapshots = new Map<string, FileSnapshot>();
  for (const rel of scenario.filesToRestore ?? []) {
    snapshots.set(rel, await snapshotFile(rel));
  }

  try {
    const launchedAt = Date.now();
    const cli = await runClaude(scenario);
    const transcriptPath = await resolveTranscriptPath(cli, launchedAt);
    const transcriptRaw = transcriptPath ? await readFile(transcriptPath, "utf8") : null;
    const sessionId = cli.sessionIdFromJson ?? extractSessionIdFromPath(transcriptPath);

    const checks: CheckResult[] = [];

    if (cli.timedOut) {
      checks.push({
        ok: false,
        label: "CLI execution",
        detail: `timeout exceeded (${scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`,
      });
    }
    if (!transcriptPath || !transcriptRaw) {
      checks.push({
        ok: false,
        label: "transcript located",
        detail: `no transcript found in ${TRANSCRIPTS_DIR} (CLI session_id: ${cli.sessionIdFromJson ?? "missing"})`,
      });
    } else {
      checks.push(checkZeroLeak(transcriptRaw, values, scenario.prompt));
    }

    const ctx: ScenarioContext = {
      cli,
      transcriptPath,
      transcriptRaw,
      sessionId,
    };
    if (scenario.extraChecks) {
      checks.push(...(await scenario.extraChecks(ctx)));
    }

    const status: ScenarioReport["status"] = checks.every((c) => c.ok) ? "GREEN" : "RED";

    return {
      id: scenario.id,
      description: scenario.description,
      status,
      durationMs: cli.durationMs,
      sessionId,
      transcriptPath,
      checks,
      cliExitCode: cli.exitCode,
      cliTimedOut: cli.timedOut,
      stderrExcerpt: cli.stderr.slice(0, 500),
    };
  } catch (err) {
    // The harness must never crash entirely on a scenario failure.
    return {
      id: scenario.id,
      description: scenario.description,
      status: "RED",
      durationMs: 0,
      sessionId: null,
      transcriptPath: null,
      checks: [
        {
          ok: false,
          label: "harness error",
          detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
      ],
      cliExitCode: null,
      cliTimedOut: false,
      stderrExcerpt: "",
    };
  } finally {
    for (const [rel, snapshot] of snapshots) {
      await restoreFile(rel, snapshot).catch(() => {});
    }
  }
}

function extractSessionIdFromPath(transcriptPath: string | null): string | null {
  if (!transcriptPath) return null;
  const base = transcriptPath.split("/").pop() ?? "";
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : null;
}

// ---------------------------------------------------------------------------
// CLI (parsing, dry-run, report, main)
// ---------------------------------------------------------------------------

interface CliOptions {
  only: Set<string> | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let only: Set<string> | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only") {
      const val = argv[++i] ?? "";
      only = new Set(
        val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg?.startsWith("--only=")) {
      only = new Set(
        arg
          .slice("--only=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }
  return { only, dryRun };
}

function printTable(reports: ScenarioReport[]): void {
  const idWidth = Math.max(...reports.map((r) => r.id.length), 4);
  const statusWidth = 6;
  console.log("");
  console.log(`${"ID".padEnd(idWidth)}  ${"STATUS".padEnd(statusWidth)}  DESCRIPTION`);
  console.log("-".repeat(idWidth + statusWidth + 60));
  for (const r of reports) {
    console.log(`${r.id.padEnd(idWidth)}  ${r.status.padEnd(statusWidth)}  ${r.description}`);
  }
  console.log("");
  for (const r of reports) {
    console.log(`## ${r.id} — ${r.status} (${r.durationMs}ms, session ${r.sessionId ?? "?"})`);
    for (const c of r.checks) {
      console.log(`   [${c.ok ? "ok" : "fail"}] ${c.label}: ${c.detail}`);
    }
    if (r.stderrExcerpt) console.log(`   stderr: ${r.stderrExcerpt.replace(/\n/g, " ")}`);
    console.log("");
  }
}

async function writeReport(reports: ScenarioReport[]): Promise<string> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(RESULTS_DIR, `${stamp}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    testProjectDir: TEST_PROJECT_DIR,
    valuesFile: VALUES_FILE,
    scenarios: reports,
  };
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

async function main(): Promise<void> {
  const { only, dryRun } = parseArgs(process.argv.slice(2));
  const scenarios = only ? SCENARIOS.filter((s) => only.has(s.id)) : SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`No scenario matches --only (${[...(only ?? [])].join(",")}).`);
    process.exit(1);
  }

  // Loaded BEFORE anything else (including --dry-run): the guard below
  // depends on it and must block startup, not just the actual run.
  let values: string[];
  try {
    values = await loadSensitiveValues();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const violations = checkPromptsAgainstSensitiveValues(scenarios, values);
  if (violations.length > 0) {
    console.error(
      "GUARD: one or more scenario prompts literally name a fixture's " +
        "sensitive value. This is structurally forbidden (fact 17, PROGRESS.md: " +
        "the model only sees a placeholder in the masked files and cannot correlate " +
        "it with a value named in the prompt: the scenario fails functionally on top " +
        'of skewing the zero-leak check). Designate the entity STRUCTURALLY ("the ' +
        'first client", "the second email address"...).',
    );
    for (const v of violations) {
      console.error(`  - ${v.scenarioId}: the prompt contains "${v.value}"`);
    }
    process.exit(1);
  }

  if (dryRun) {
    console.log("--dry-run mode: no claude session will be launched.\n");
    for (const s of scenarios) {
      console.log(`${s.id} - ${s.description}`);
      console.log(`  ${formatCommandForDisplay(s)}`);
      if (s.filesToRestore?.length) {
        console.log(`  saved/restored files: ${s.filesToRestore.join(", ")}`);
      }
      console.log("");
    }
    return;
  }

  if (!existsSync(TEST_PROJECT_DIR)) {
    console.error(`Test project directory not found: ${TEST_PROJECT_DIR}`);
    process.exit(1);
  }

  console.log(`${values.length} sensitive value(s) loaded from ${VALUES_FILE}.`);
  console.log(`${scenarios.length} scenario(s) to run in ${TEST_PROJECT_DIR}.\n`);

  const reports: ScenarioReport[] = [];
  for (const scenario of scenarios) {
    console.log(`-> ${scenario.id}: ${scenario.description}`);
    const report = await runScenario(scenario, values);
    reports.push(report);
    console.log(`  ${report.status}`);
  }

  printTable(reports);
  const reportPath = await writeReport(reports);
  console.log(`JSON report written to ${reportPath}`);

  const anyRed = reports.some((r) => r.status === "RED");
  process.exitCode = anyRed ? 1 : 0;
}

await main();
