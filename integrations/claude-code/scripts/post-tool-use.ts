/**
 * PostToolUse hook: masks PII/secrets in tool outputs BEFORE they enter the
 * context (batch 3 phase B). Policy D6: fail-closed, never let a raw output
 * through if masking fails.
 * stdout = ONLY the hook response JSON (rule R12).
 */
import { shouldRunHooks } from "../lib/auth-mode";
import { maskText } from "../lib/mask-client";
import { totalTextLength, transformToolResponse } from "../lib/tool-output";

/** Above this volume, GLiNER is too slow (~0.6s/KB, measured in batch 1): secrets only. */
const PII_SCAN_CAP_CHARS = 30_000;

const RETENTION_MESSAGE =
  "[PasteGuard unavailable: the tool output was withheld for safety. " +
  "Start PasteGuard (bun run start) then rerun the tool.]";

const BIG_OUTPUT_NOTE =
  "[PasteGuard: large output, PII masking disabled for this output, secrets masked]\n";

interface HookPayload {
  session_id?: string;
  tool_name?: string;
  tool_response?: unknown;
}

/** Tools with no exploitable sensitive content: don't pay the masking cost. */
const SKIP_TOOLS = new Set(["TodoWrite", "AskUserQuestion", "ToolSearch", "ExitPlanMode"]);

function emit(updatedToolOutput: unknown, systemMessage?: string): void {
  const output: Record<string, unknown> = {
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput },
    suppressOutput: true,
  };
  if (systemMessage) output.systemMessage = systemMessage;
  console.log(JSON.stringify(output));
}

async function failClosed(toolName: string, toolResponse: unknown): Promise<void> {
  // Replace ALL text fields with the retention message, preserving the
  // shape (updatedToolOutput constraint).
  const { response } = await transformToolResponse(
    toolName,
    toolResponse,
    async () => RETENTION_MESSAGE,
  );
  emit(response, "PasteGuard unavailable: tool outputs withheld (fail-closed).");
}

let payload: HookPayload = {};
try {
  payload = JSON.parse(await Bun.stdin.text()) as HookPayload;
  if (!(await shouldRunHooks())) process.exit(0);

  const sessionId = payload.session_id;
  const toolName = payload.tool_name;
  const toolResponse = payload.tool_response;

  if (!sessionId || !toolName || toolResponse === undefined || toolResponse === null) {
    process.exit(0);
  }
  if (SKIP_TOOLS.has(toolName)) process.exit(0);

  const totalLength = await totalTextLength(toolName, toolResponse);
  if (totalLength === 0) process.exit(0);

  const secretsOnly = totalLength > PII_SCAN_CAP_CHARS;
  const detect = secretsOnly ? (["secrets"] as const) : undefined;

  let changed = false;
  let firstField = true;
  const { response } = await transformToolResponse(toolName, toolResponse, async (text) => {
    const result = await maskText(sessionId, text, detect ? { detect: [...detect] } : undefined);
    changed = changed || result.changed;
    if (firstField && secretsOnly) {
      firstField = false;
      return BIG_OUTPUT_NOTE + result.masked;
    }
    firstField = false;
    return result.masked;
  });

  if (!changed && !secretsOnly) process.exit(0);
  emit(response);
  process.exit(0);
} catch (err) {
  // D6: any error (PasteGuard down, lock, unexpected payload) → retention.
  try {
    await failClosed(payload.tool_name ?? "", payload.tool_response ?? RETENTION_MESSAGE);
  } catch {
    emit(RETENTION_MESSAGE, "PasteGuard: masking AND substitution both failed.");
  }
  if (err instanceof Error) console.error(err.message);
  process.exit(0);
}
