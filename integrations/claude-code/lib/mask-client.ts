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

/** Une « valeur » détectée qui contient déjà un placeholder est un artefact. */
const PLACEHOLDER_IN_VALUE = /\[\[[A-Z][A-Z0-9_]*_\d+\]\]/;

/**
 * Passe a de la dédup (D5) : remplacer les valeurs déjà connues du mapping par
 * leur placeholder existant, valeurs les plus longues d'abord (une valeur peut
 * être sous-chaîne d'une autre, ex. « Dupont » dans « Jean Dupont »).
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
 * Masque un texte pour la session donnée. Toute la section critique (relecture
 * de l'état, pré-remplacement, appel API, fusion, écriture) est sous verrou de
 * session (D4). Les erreurs réseau remontent en MaskUnavailableError : la
 * politique fail-open/fail-closed appartient aux hooks (D6), pas à cette lib.
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

      // Passe b de la dédup (D5) : le détecteur a pu trouver une variante d'une
      // valeur déjà mappée sous un autre placeholder ; réutiliser l'ancien.
      const valueToPlaceholder = new Map<string, string>();
      for (const [placeholder, value] of Object.entries(state.mapping)) {
        if (!valueToPlaceholder.has(value)) valueToPlaceholder.set(value, placeholder);
      }
      let masked = response.masked;
      for (const [placeholder, value] of Object.entries(response.context)) {
        if (PLACEHOLDER_IN_VALUE.test(value)) {
          // Le détecteur a re-détecté un placeholder issu du pré-remplacement
          // (ex. GLiNER voit « [[PERSON_2]] » comme une personne) : annuler ce
          // masquage, sinon le mapping devient une poupée russe irrécupérable.
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
