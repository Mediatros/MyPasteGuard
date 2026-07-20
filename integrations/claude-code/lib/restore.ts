import type { SessionState } from "./types";

const PLACEHOLDER_PATTERN = /\[\[[A-Z][A-Z0-9_]*_\d+\]\]/g;

/**
 * Segment `[[ ... ]]` large (R11) : capture tout ce qui peut apparaître entre
 * crochets une fois le modèle libre d'insérer espaces, retours à la ligne ou
 * backticks, pour normalisation avant recherche dans le mapping.
 */
const LOOSE_SEGMENT_PATTERN = /\[\[([^[\]]*)\]\]/g;

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

/**
 * Restauration tolérante (R11) : accepte les déformations courantes qu'un
 * modèle peut introduire à l'intérieur d'un placeholder (espaces, retours à
 * la ligne, backticks entre les caractères du nom), par exemple
 * `[[PERSON\n_1]]`, `[[PERSON_1 ]]`, `` [[`PERSON_1`]] ``. Chaque segment
 * `[[ ... ]]` est normalisé (suppression des espaces, retours à la ligne et
 * backticks) puis cherché dans le mapping ; s'il n'y correspond pas, le
 * segment est laissé INTACT (jamais de valeur inventée).
 */
export function restoreTextTolerant(state: SessionState, text: string): string {
  return text.replace(LOOSE_SEGMENT_PATTERN, (segment, inner: string) => {
    const normalized = `[[${inner.replace(/[\s`]/g, "")}]]`;
    const value = state.mapping[normalized];
    return value ?? segment;
  });
}
