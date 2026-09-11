/**
 * MessageDisplay hook: restores the real values of `[[TYPE_n]]` placeholders
 * ON SCREEN (batch 5), without touching the transcript or the context sent
 * to the model. Claude Code enforces a 10s timeout, which is why restoration
 * must be purely local, with NO network call (D3).
 *
 * V3 finding (measured 2026-07-20, headless `claude -p`): MessageDisplay is
 * called ONCE per message, with `index: 0`, `final: true`, and `delta` equal
 * to the full message (no incremental deltas). Behavior in an interactive
 * session with streaming remains to be confirmed; this hook therefore stays
 * defensive against a partial delta.
 *
 * R10/R11 (a placeholder split or garbled across deltas): BEST-EFFORT
 * strategy, never withhold a suffix. The displayed text is NEVER truncated
 * (deltas are not accumulated here: truncating would lose characters). A
 * placeholder cut short (e.g. `[[PER` at the end of a delta) or garbled
 * (newline, space, backtick inserted) is displayed as-is if it cannot be
 * resolved; it will be fixed on the next delta or in the final render.
 * Tolerant restoration (R11) is handled by `restoreTextTolerant`.
 *
 * State read WITHOUT a lock (direct `loadState`, not `withSessionLock`): a
 * stale read (state not yet updated) only produces an unrestored placeholder
 * on screen, never a leak of a real value. The cost of a lock (latency,
 * contention with PostToolUse/PreToolUse) isn't justified for a purely
 * cosmetic hook on a 10s budget.
 *
 * Reversed D6: any error (unreadable state, unexpected payload, invalid
 * JSON) → `process.exit(0)` with NO output at all; the display stays as-is.
 * A partially restored `displayContent` from a doubtful state is never
 * emitted.
 *
 * stdout = ONLY the hook response JSON (rule R12). Diagnostics go to
 * stderr.
 */

import { restoreTextTolerant } from "../lib/restore";
import { loadState } from "../lib/store";
import type { SessionState } from "../lib/types";

interface HookPayload {
  session_id?: string;
  message_text?: string;
  delta?: string;
}

/**
 * Computes the content to display after tolerant restoration (R11), or
 * `null` if nothing should be emitted (empty text, no placeholder, or no
 * match resolved in the mapping).
 */
export function computeDisplayContent(
  state: SessionState,
  text: string | undefined | null,
): string | null {
  if (!text?.includes("[[")) return null;
  const restored = restoreTextTolerant(state, text);
  return restored === text ? null : restored;
}

async function main(): Promise<void> {
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as HookPayload;
    const text = payload.message_text ?? payload.delta;

    // Fast path: no placeholder → no need to read the store.
    if (!text?.includes("[[")) process.exit(0);

    const sessionId = payload.session_id;
    if (!sessionId) process.exit(0);

    const state = await loadState(sessionId);
    const displayContent = computeDisplayContent(state, text);
    if (displayContent === null) process.exit(0);

    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "MessageDisplay", displayContent },
      }),
    );
    process.exit(0);
  } catch (err) {
    // Reversed D6: state, payload, or JSON error → no output.
    if (err instanceof Error) console.error(err.message);
    process.exit(0);
  }
}

if (import.meta.main) {
  await main();
}
