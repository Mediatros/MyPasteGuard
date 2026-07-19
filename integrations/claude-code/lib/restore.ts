import type { SessionState } from "./types";

const PLACEHOLDER_PATTERN = /\[\[[A-Z][A-Z0-9_]*_\d+\]\]/g;

/**
 * Restauration locale (D3) : remplacement pur depuis le mapping, aucun réseau.
 * Un placeholder inconnu est laissé tel quel (ne jamais inventer de valeur).
 */
export function restoreText(state: SessionState, text: string): string {
  return text.replace(PLACEHOLDER_PATTERN, (match) => state.mapping[match] ?? match);
}

export function containsPlaceholders(text: string): boolean {
  return new RegExp(PLACEHOLDER_PATTERN.source).test(text);
}
