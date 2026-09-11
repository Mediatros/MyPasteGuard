/**
 * POC V2 (batch 4, throwaway): tests whether PreToolUse's `updatedInput` is
 * honored by claude 2.1.215, per tool and per permissionDecision mode.
 * Replaces [[POC_1]] with POCVALUE_RESTORED in every string leaf of
 * tool_input, emits updatedInput according to the mode (argv[2]: plain |
 * defer | ask | allow), and logs payload + output to
 * ~/.pasteguard/poc-v2.jsonl.
 * Never wire this outside the test project.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKER = "[[POC_1]]";
const VALUE = "POCVALUE_RESTORED";

function rewriteLeaves(value: unknown, hit: { found: boolean }): unknown {
  if (typeof value === "string") {
    if (value.includes(MARKER)) {
      hit.found = true;
      return value.replaceAll(MARKER, VALUE);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteLeaves(v, hit));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteLeaves(v, hit);
    return out;
  }
  return value;
}

async function log(entry: Record<string, unknown>): Promise<void> {
  const dir = join(homedir(), ".pasteguard");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(
    join(dir, "poc-v2.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    { mode: 0o600 },
  );
}

try {
  const mode = process.argv[2] ?? "plain";
  const payload = JSON.parse(await Bun.stdin.text()) as {
    session_id?: string;
    tool_name?: string;
    tool_input?: unknown;
  };
  const hit = { found: false };
  const updatedInput = rewriteLeaves(payload.tool_input, hit);

  if (!hit.found) {
    await log({ mode, tool: payload.tool_name, marker: false });
    process.exit(0);
  }

  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: "PreToolUse",
    updatedInput,
  };
  if (mode === "defer") hookSpecificOutput.permissionDecision = "defer";
  if (mode === "ask") hookSpecificOutput.permissionDecision = "ask";
  if (mode === "allow") hookSpecificOutput.permissionDecision = "allow";
  const output = { hookSpecificOutput, suppressOutput: true };

  await log({
    mode,
    tool: payload.tool_name,
    marker: true,
    input: payload.tool_input,
    output,
  });
  console.log(JSON.stringify(output));
  process.exit(0);
} catch (err) {
  await log({ error: err instanceof Error ? err.message : String(err) }).catch(() => {});
  process.exit(0);
}
