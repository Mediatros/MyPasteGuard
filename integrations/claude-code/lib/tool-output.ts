/**
 * Transformation des tool_response par outil (lot 3 phase B).
 * Contrainte prouvée en phase A : updatedToolOutput doit reproduire la FORME
 * du tool_response (validation « does not match tool's output shape ») ; on
 * transforme donc les champs texte EN PLACE, sans toucher à la structure.
 * Formes capturées le 2026-07-19 (spy.jsonl), voir PROGRESS.md.
 */

type TransformFn = (text: string) => Promise<string>;

interface TransformResult {
  response: unknown;
  touched: boolean;
}

/** Champs porteurs de texte par outil connu (chemins depuis la racine du tool_response). */
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
 * En mode générique, une feuille plus courte ne peut pas porter une PII ou un
 * secret exploitable (emails, téléphones, IBAN, clés font tous 6+ caractères) :
 * on évite un appel de masquage par micro-champ ("type": "text", "mode"...).
 */
const MIN_DEEP_LEAF_LENGTH = 6;

/** Parcours générique : transforme les feuilles string (outils inconnus, MCP). */
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
 * Applique fn à chaque champ texte du tool_response, en préservant la forme.
 * Outil connu : champs ciblés. Outil inconnu (dont MCP) : toutes les feuilles
 * string. Agent/Task : les items text de content[].
 */
export async function transformToolResponse(
  toolName: string,
  toolResponse: unknown,
  fn: TransformFn,
): Promise<TransformResult> {
  // Sortie string brute (certains outils/MCP) : transformer directement.
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

/** Longueur totale du texte qui sera soumis au masquage (pour le plafond de taille). */
export async function totalTextLength(toolName: string, toolResponse: unknown): Promise<number> {
  let total = 0;
  await transformToolResponse(toolName, toolResponse, async (text) => {
    total += text.length;
    return text;
  });
  return total;
}
