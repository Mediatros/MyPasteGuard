/**
 * PreToolUse hook: restores the real values in tool inputs with a LOCAL
 * effect before execution (batch 4). Mode validated in V2 (claude 2.1.215):
 * `updatedInput` WITHOUT permissionDecision, honored, permission flow
 * preserved.
 * Policy D6: unresolved placeholder or store error → deny, never let a
 * corrupted input execute.
 * Proven limitation (V2): an Edit whose old_string doesn't match the disk
 * fails BEFORE this hook; this case is handled by instruction on the
 * protected project side (Bash sed).
 * stdout = ONLY the hook response JSON (rule R12).
 */
import { shouldRunHooks } from "../lib/auth-mode";
import { withSessionLock } from "../lib/store";
import { inputHasPlaceholders, restoreToolInput } from "../lib/tool-input";

interface HookPayload {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
}

function emitDeny(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
      suppressOutput: true,
    }),
  );
}

let payload: HookPayload = {};
try {
  payload = JSON.parse(await Bun.stdin.text()) as HookPayload;
  if (!(await shouldRunHooks())) process.exit(0);

  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput } = payload;
  if (!toolName || toolInput === undefined || toolInput === null) process.exit(0);

  // Overwhelming majority case: no placeholder in the candidate fields.
  if (!inputHasPlaceholders(toolName, toolInput)) process.exit(0);

  if (!sessionId) {
    emitDeny(
      "PasteGuard: placeholders present but session_id missing from payload, restoration impossible.",
    );
    process.exit(0);
  }

  // Short lock: consistent state read while other hooks are writing.
  const result = await withSessionLock(sessionId, (state) =>
    restoreToolInput(state, toolName, toolInput),
  );

  if (result.action === "deny") {
    emitDeny(result.reason);
  } else if (result.action === "update") {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: result.updatedInput,
        },
        suppressOutput: true,
      }),
    );
  }
  process.exit(0);
} catch (err) {
  // D6: lock, store, or unexpected payload error → deny execution.
  emitDeny(
    "PasteGuard: placeholder restoration failed (session state unreachable). " +
      "Check the PasteGuard session then retry.",
  );
  if (err instanceof Error) console.error(err.message);
  process.exit(0);
}
