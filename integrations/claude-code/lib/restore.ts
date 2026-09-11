import type { SessionState } from "./types";

const PLACEHOLDER_PATTERN = /\[\[[A-Z][A-Z0-9_]*_\d+\]\]/g;

/**
 * Broad `[[ ... ]]` segment (R11): captures anything that can appear between
 * brackets once the model is free to insert spaces, newlines or backticks,
 * for normalization before looking it up in the mapping.
 */
const LOOSE_SEGMENT_PATTERN = /\[\[([^[\]]*)\]\]/g;

/**
 * Local restoration (D3): pure replacement from the mapping, no network calls.
 * An unknown placeholder is left untouched (never invent a value).
 */
export function restoreText(state: SessionState, text: string): string {
  return text.replace(PLACEHOLDER_PATTERN, (match) => state.mapping[match] ?? match);
}

export function containsPlaceholders(text: string): boolean {
  return new RegExp(PLACEHOLDER_PATTERN.source).test(text);
}

/**
 * Tolerant restoration (R11): accepts common deformations a model can
 * introduce inside a placeholder (spaces, newlines, backticks between the
 * name's characters), for example
 * `[[PERSON\n_1]]`, `[[PERSON_1 ]]`, `` [[`PERSON_1`]] ``. Each `[[ ... ]]`
 * segment is normalized (stripping spaces, newlines and backticks) then
 * looked up in the mapping; if it doesn't match, the segment is left INTACT
 * (never invent a value).
 */
export function restoreTextTolerant(state: SessionState, text: string): string {
  return text.replace(LOOSE_SEGMENT_PATTERN, (segment, inner: string) => {
    const normalized = `[[${inner.replace(/[\s`]/g, "")}]]`;
    const value = state.mapping[normalized];
    return value ?? segment;
  });
}
