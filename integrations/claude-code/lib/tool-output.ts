/**
 * Transformation of tool_response by tool (batch 3 phase B).
 * Constraint proven in phase A: updatedToolOutput must reproduce the SHAPE
 * of the tool_response ("does not match tool's output shape" validation);
 * text fields are therefore transformed IN PLACE, without touching the
 * structure. Shapes captured on 2026-07-19 (spy.jsonl), see PROGRESS.md.
 */

type TransformFn = (text: string) => Promise<string>;

interface TransformResult {
  response: unknown;
  touched: boolean;
}

/** Text-bearing fields per known tool (paths from the tool_response root). */
const KNOWN_TEXT_PATHS: Record<string, string[][]> = {
  Read: [["file", "content"]],
  Bash: [["stdout"], ["stderr"]],
  BashOutput: [["stdout"], ["stderr"]],
  WebFetch: [["result"]],
  Write: [["content"]],
  Edit: [["oldString"], ["newString"], ["originalFile"]],
  MultiEdit: [["originalFile"]],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function transformAtPath(
  node: Record<string, unknown>,
  path: string[],
  fn: TransformFn,
): Promise<boolean> {
  const [head, ...rest] = path;
  if (head === undefined) return false;
  if (rest.length === 0) {
    const value = node[head];
    if (typeof value === "string" && value.length > 0) {
      node[head] = await fn(value);
      return true;
    }
    return false;
  }
  const child = node[head];
  if (isRecord(child)) return transformAtPath(child, rest, fn);
  return false;
}

/**
 * In generic mode, a shorter leaf cannot carry an exploitable PII or secret
 * (emails, phone numbers, IBANs, keys are all 6+ characters): this avoids a
 * masking call per micro-field ("type": "text", "mode"...).
 */
const MIN_DEEP_LEAF_LENGTH = 6;

/** Generic traversal: transforms string leaves (unknown tools, MCP). */
async function transformDeep(
  value: unknown,
  fn: TransformFn,
): Promise<{ value: unknown; touched: boolean }> {
  if (typeof value === "string") {
    return value.length >= MIN_DEEP_LEAF_LENGTH
      ? { value: await fn(value), touched: true }
      : { value, touched: false };
  }
  if (Array.isArray(value)) {
    let touched = false;
    const out: unknown[] = [];
    for (const item of value) {
      const r = await transformDeep(item, fn);
      touched = touched || r.touched;
      out.push(r.value);
    }
    return { value: out, touched };
  }
  if (isRecord(value)) {
    let touched = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const r = await transformDeep(item, fn);
      touched = touched || r.touched;
      out[key] = r.value;
    }
    return { value: out, touched };
  }
  return { value, touched: false };
}

/**
 * Applies fn to each text field of the tool_response, preserving the shape.
 * Known tool: targeted fields. Unknown tool (including MCP): all string
 * leaves. Agent/Task: the text items of content[].
 */
export async function transformToolResponse(
  toolName: string,
  toolResponse: unknown,
  fn: TransformFn,
): Promise<TransformResult> {
  // Raw string output (some tools/MCP): transform directly.
  if (typeof toolResponse === "string") {
    return toolResponse.length > 0
      ? { response: await fn(toolResponse), touched: true }
      : { response: toolResponse, touched: false };
  }
  if (!isRecord(toolResponse)) return { response: toolResponse, touched: false };

  const clone = structuredClone(toolResponse) as Record<string, unknown>;

  if (toolName === "Agent" || toolName === "Task") {
    let touched = false;
    const content = clone.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          isRecord(block) &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.length > 0
        ) {
          block.text = await fn(block.text);
          touched = true;
        }
      }
    }
    return { response: clone, touched };
  }

  const paths = KNOWN_TEXT_PATHS[toolName];
  if (paths) {
    let touched = false;
    for (const path of paths) {
      touched = (await transformAtPath(clone, path, fn)) || touched;
    }
    return { response: clone, touched };
  }

  const deep = await transformDeep(clone, fn);
  return { response: deep.value, touched: deep.touched };
}

/** Total length of the text that will be submitted for masking (for the size cap). */
export async function totalTextLength(toolName: string, toolResponse: unknown): Promise<number> {
  let total = 0;
  await transformToolResponse(toolName, toolResponse, async (text) => {
    total += text.length;
    return text;
  });
  return total;
}
