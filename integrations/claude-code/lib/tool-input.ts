import { restoreText } from "./restore";
import type { SessionState } from "./types";

/**
 * Restoration of LOCAL tool inputs (batch 4, decision D7): which tool_input
 * text fields may contain placeholders to restore before execution. Tools
 * with external scope (WebFetch, WebSearch, MCP) are NEVER listed here.
 */

const PLACEHOLDER_PATTERN = /\[\[[A-Z][A-Z0-9_]*_\d+\]\]/g;

/**
 * Escaped variant for shell regex (proven in E2E batch 4: Claude writes
 * `sed 's/\[\[EMAIL_ADDRESS_1\]\]/.../'`). Normalized to a raw placeholder
 * before restoration, for Bash commands only.
 */
const ESCAPED_PLACEHOLDER_PATTERN = /\\\[\\\[([A-Z][A-Z0-9_]*_\d+)\\\]\\\]/g;

function unescapeShellPlaceholders(text: string): string {
  return text.replace(ESCAPED_PLACEHOLDER_PATTERN, "[[$1]]");
}

/** Top-level fields to restore, per tool (plans/04, table). */
const FIELDS_BY_TOOL: Record<string, string[]> = {
  Write: ["content", "file_path"],
  Edit: ["old_string", "new_string", "file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["new_source", "notebook_path"],
  Bash: ["command"],
};

/**
 * R7: a restored value injected into a shell command must be inert.
 * Alphanumerics and @ . - _ + : / only; everything else (spaces, quotes,
 * $, ;, |, &...) is refused: restoration must never turn a command into
 * something other than what the user saw.
 */
const SHELL_SAFE_VALUE = /^[A-Za-z0-9@.\-_+:/]+$/;

export type RestoreInputResult =
  | { action: "none" }
  | { action: "update"; updatedInput: Record<string, unknown> }
  | { action: "deny"; reason: string };

function placeholdersIn(text: string): string[] {
  return text.match(PLACEHOLDER_PATTERN) ?? [];
}

/**
 * Restores placeholders in the text fields of a local tool_input.
 * Fail-closed (D6): placeholder missing from the mapping, or value not
 * shell-safe for Bash → deny (execution would have corrupted the file or
 * command). Returns the COMPLETE tool_input object (updatedInput constraint).
 */
export function restoreToolInput(
  state: SessionState,
  toolName: string,
  toolInput: unknown,
): RestoreInputResult {
  const fields = FIELDS_BY_TOOL[toolName];
  if (!fields || typeof toolInput !== "object" || toolInput === null) return { action: "none" };
  const input = toolInput as Record<string, unknown>;

  const unresolved = new Set<string>();
  const unsafe = new Set<string>();
  let changed = false;
  const shellSafeOnly = toolName === "Bash";

  const restoreField = (raw: string): string => {
    const text = shellSafeOnly ? unescapeShellPlaceholders(raw) : raw;
    for (const placeholder of placeholdersIn(text)) {
      const value = state.mapping[placeholder];
      if (value === undefined) {
        unresolved.add(placeholder);
      } else if (shellSafeOnly && !SHELL_SAFE_VALUE.test(value)) {
        unsafe.add(placeholder);
      }
    }
    const restored = restoreText(state, text);
    changed = changed || restored !== raw;
    return restored;
  };

  const updatedInput: Record<string, unknown> = { ...input };
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string") updatedInput[field] = restoreField(value);
  }

  // MultiEdit: edits[i].old_string / new_string (nested structure).
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    updatedInput.edits = input.edits.map((edit) => {
      if (typeof edit !== "object" || edit === null) return edit;
      const e = edit as Record<string, unknown>;
      const out = { ...e };
      for (const field of ["old_string", "new_string"]) {
        if (typeof e[field] === "string") out[field] = restoreField(e[field] as string);
      }
      return out;
    });
  }

  if (unresolved.size > 0) {
    return {
      action: "deny",
      reason:
        `PasteGuard: unresolved placeholder(s) in ${toolName}: ` +
        `${[...unresolved].join(", ")}. Execution would have written these ` +
        "placeholders as-is (corrupted file or command). Check the PasteGuard session.",
    };
  }
  if (unsafe.size > 0) {
    return {
      action: "deny",
      reason:
        `PasteGuard: unsafe restored value(s) for a shell command: ` +
        `${[...unsafe].join(", ")}. Rewrite the command without these values ` +
        "(for example via a file), or operate manually.",
    };
  }
  if (!changed) return { action: "none" };
  return { action: "update", updatedInput };
}

/** True if at least one candidate field of this tool contains a placeholder. */
export function inputHasPlaceholders(toolName: string, toolInput: unknown): boolean {
  const fields = FIELDS_BY_TOOL[toolName];
  if (!fields || typeof toolInput !== "object" || toolInput === null) return false;
  const input = toolInput as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of fields) {
    if (typeof input[field] !== "string") continue;
    const value = input[field] as string;
    parts.push(toolName === "Bash" ? unescapeShellPlaceholders(value) : value);
  }
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (typeof edit === "object" && edit !== null) {
        const e = edit as Record<string, unknown>;
        if (typeof e.old_string === "string") parts.push(e.old_string);
        if (typeof e.new_string === "string") parts.push(e.new_string);
      }
    }
  }
  return placeholdersIn(parts.join("\n")).length > 0;
}
