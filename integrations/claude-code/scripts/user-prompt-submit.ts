/**
 * UserPromptSubmit hook: detects PII/secrets typed directly into the prompt
 * and warns (warn mode) or blocks (block mode) before it is sent.
 * Controlled by the `PASTEGUARD_PROMPT_MODE` env var (default "off").
 *
 * POLICY REVERSAL (opposite of D6, cf. post-tool-use.ts): this hook is NOT
 * fail-closed. An engine outage (down, timeout, unexpected payload) must
 * NEVER make the session unusable by preventing the user from talking to
 * Claude Code: any error → exit 0 with NO blocking AND NO warning. This
 * channel remains "best effort" by nature: the user controls what they
 * type, unlike tool outputs.
 *
 * This hook NEVER rewrites the prompt: `UserPromptSubmit` doesn't allow it
 * (official docs; no `updatedPrompt` field). In warn mode, the prompt is
 * therefore sent IN THE CLEAR regardless; the warning is educational.
 *
 * No write to the session store: the prompt is never masked here (blocked =
 * never sent, allowed = sent in the clear), so `/api/mask` is called
 * directly (bare fetch), WITHOUT going through `maskText` from
 * `lib/mask-client.ts`, which loads/writes session state under a lock: a
 * mapping created for this text would pollute the counters for nothing.
 *
 * Never display a detected value: only TYPES and their count appear in the
 * warning or the block reason.
 *
 * stdout = ONLY the hook response JSON (rule R12). Diagnostics on stderr.
 */

import { shouldRunHooks } from "../lib/auth-mode";

export type PromptMode = "off" | "warn" | "block";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_URL = "http://localhost:3333";
const NETWORK_TIMEOUT_MS = 2_000;

/** Escape-hatch prefix: forces the prompt to be sent without detection (stays in the text, harmless). */
const BYPASS_PREFIX = "!pg-off";

interface HookPayload {
  session_id?: string;
  prompt?: string;
}

interface MaskApiEntity {
  type: string;
  placeholder: string;
}

interface MaskApiResponse {
  entities?: MaskApiEntity[];
}

export interface EntitySummary {
  types: string[];
  total: number;
}

export interface AnalyseOptions {
  url?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export type HookOutcome =
  | { kind: "none" }
  | { kind: "warn"; systemMessage: string }
  | { kind: "block"; reason: string };

/** Reads PASTEGUARD_PROMPT_MODE; any unknown value falls back to "off" (safe default). */
export function readPromptMode(env: Record<string, string | undefined> = process.env): PromptMode {
  const raw = env.PASTEGUARD_PROMPT_MODE;
  if (raw === "warn" || raw === "block") return raw;
  return "off";
}

/** Summary of detected entities: unique types (order of first appearance) + total. */
export function summarizeEntities(entities: MaskApiEntity[]): EntitySummary {
  const types: string[] = [];
  for (const entity of entities) {
    if (!types.includes(entity.type)) types.push(entity.type);
  }
  return { types, total: entities.length };
}

/** Warning (warn mode): never a value, only types + count. */
export function buildWarningMessage(summary: EntitySummary): string {
  const entity = summary.total > 1 ? "entities" : "entity";
  return (
    `PasteGuard: your prompt contains ${summary.total} sensitive ${entity} ` +
    `(${summary.types.join(", ")}). The text you type is sent IN THE CLEAR, it is not masked.`
  );
}

/** Block reason (block mode): never a value, types + escape hatch. */
export function buildBlockReason(summary: EntitySummary): string {
  return (
    `PasteGuard: the prompt contains ${summary.types.join(", ")}. Rephrase without the value, ` +
    "or put it in a file and reference the file (its content will be masked). " +
    `To force sending anyway: prefix the prompt with ${BYPASS_PREFIX}.`
  );
}

/**
 * Analyzes the prompt according to the mode. Never throws: any network,
 * HTTP status, or payload error falls back to `{ kind: "none" }` (D6
 * reversal documented at the top of the file).
 */
export async function analysePrompt(
  mode: PromptMode,
  prompt: string | undefined,
  opts: AnalyseOptions = {},
): Promise<HookOutcome> {
  if (mode === "off") return { kind: "none" };
  if (!prompt || prompt.trim().length === 0) return { kind: "none" };
  if (prompt.startsWith(BYPASS_PREFIX)) return { kind: "none" };

  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${opts.url ?? process.env.PASTEGUARD_URL ?? DEFAULT_URL}/api/mask`;

  let response: MaskApiResponse;
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: prompt }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? NETWORK_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: "none" };
    response = (await res.json()) as MaskApiResponse;
  } catch {
    return { kind: "none" };
  }

  if (!Array.isArray(response.entities) || response.entities.length === 0) {
    return { kind: "none" };
  }

  const summary = summarizeEntities(response.entities);
  if (mode === "block") return { kind: "block", reason: buildBlockReason(summary) };
  return { kind: "warn", systemMessage: buildWarningMessage(summary) };
}

async function main(): Promise<void> {
  try {
    const mode = readPromptMode();
    if (mode === "off") process.exit(0);

    const payload = JSON.parse(await Bun.stdin.text()) as HookPayload;
    if (!(await shouldRunHooks())) process.exit(0);

    const outcome = await analysePrompt(mode, payload.prompt);

    if (outcome.kind === "none") process.exit(0);
    if (outcome.kind === "warn") {
      console.log(JSON.stringify({ systemMessage: outcome.systemMessage }));
      process.exit(0);
    }
    console.log(JSON.stringify({ decision: "block", reason: outcome.reason }));
    process.exit(0);
  } catch (err) {
    // D6 reversal: invalid stdin, engine down, timeout, unexpected payload
    // → exit 0 with NO blocking and NO warning.
    if (err instanceof Error) console.error(err.message);
    process.exit(0);
  }
}

if (import.meta.main) {
  await main();
}
