import { withSessionLock } from "./store";
import type { SessionState } from "./types";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class MaskUnavailableError extends Error {
  constructor(cause: string) {
    super(`PasteGuard /api/mask unavailable: ${cause}`);
    this.name = "MaskUnavailableError";
  }
}

export function pasteguardUrl(): string {
  return process.env.PASTEGUARD_URL ?? "http://localhost:3333";
}

interface MaskApiResponse {
  masked: string;
  context: Record<string, string>;
  counters: Record<string, number>;
  entities: { type: string; placeholder: string }[];
}

export interface MaskOptions {
  detect?: ("pii" | "secrets")[];
  url?: string;
  dir?: string;
  timeoutMs?: number;
  fetchFn?: FetchLike;
}

export interface MaskResult {
  masked: string;
  changed: boolean;
}

/** A detected "value" that already contains a placeholder is an artifact. */
const PLACEHOLDER_IN_VALUE = /\[\[[A-Z][A-Z0-9_]*_\d+\]\]/;

/**
 * Pass A of de-duplication (D5): replace values already known in the mapping
 * with their existing placeholder, longest values first (a value can be a
 * substring of another, e.g. "Dupont" within "Jean Dupont").
 */
function preReplace(state: SessionState, text: string): { text: string; count: number } {
  const entries = Object.entries(state.mapping).sort((a, b) => b[1].length - a[1].length);
  let out = text;
  let count = 0;
  for (const [placeholder, value] of entries) {
    if (value.length === 0) continue;
    const parts = out.split(value);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(placeholder);
    }
  }
  return { text: out, count };
}

async function callMaskApi(
  text: string,
  startFrom: Record<string, number>,
  opts?: MaskOptions,
): Promise<MaskApiResponse> {
  const url = `${opts?.url ?? pasteguardUrl()}/api/mask`;
  const fetchFn = opts?.fetchFn ?? fetch;
  const body: Record<string, unknown> = { text, startFrom };
  if (opts?.detect) body.detect = opts.detect;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 25_000),
    });
  } catch (err) {
    throw new MaskUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new MaskUnavailableError(`HTTP ${res.status}`);
  return (await res.json()) as MaskApiResponse;
}

/**
 * Masks a text for the given session. The entire critical section (re-reading
 * the state, pre-substitution, API call, merge, write) runs under the session
 * lock (D4). Network errors propagate as MaskUnavailableError: the
 * fail-open/fail-closed policy belongs to the hooks (D6), not to this library.
 */
export async function maskText(
  sessionId: string,
  text: string,
  opts?: MaskOptions,
): Promise<MaskResult> {
  if (text.trim().length === 0) return { masked: text, changed: false };

  return withSessionLock(
    sessionId,
    async (state) => {
      const pre = preReplace(state, text);
      const response = await callMaskApi(pre.text, state.counters, opts);

      // Pass B of de-duplication (D5): the detector may have found a variant of a
      // value already mapped under another placeholder; reuse the existing one.
      const valueToPlaceholder = new Map<string, string>();
      for (const [placeholder, value] of Object.entries(state.mapping)) {
        if (!valueToPlaceholder.has(value)) valueToPlaceholder.set(value, placeholder);
      }
      let masked = response.masked;
      for (const [placeholder, value] of Object.entries(response.context)) {
        if (PLACEHOLDER_IN_VALUE.test(value)) {
          // The detector re-detected a placeholder from the pre-substitution
          // step (e.g. GLiNER sees "[[PERSON_2]]" as a person): cancel this
          // masking, otherwise the mapping becomes an unrecoverable nested-placeholder bug.
          masked = masked.split(placeholder).join(value);
          continue;
        }
        const existing = valueToPlaceholder.get(value);
        if (existing !== undefined && existing !== placeholder) {
          masked = masked.split(placeholder).join(existing);
        } else {
          state.mapping[placeholder] = value;
          valueToPlaceholder.set(value, placeholder);
        }
      }
      state.counters = response.counters;

      return { masked, changed: masked !== text };
    },
    { dir: opts?.dir },
  );
}
