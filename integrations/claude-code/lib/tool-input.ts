import { restoreText } from "./restore";
import type { SessionState } from "./types";

/**
 * Restauration des entrées d'outils LOCAUX (lot 4, décision D7) : quels champs
 * texte de tool_input peuvent contenir des placeholders à restaurer avant
 * exécution. Les outils à portée externe (WebFetch, WebSearch, MCP) ne sont
 * JAMAIS listés ici.
 */

const PLACEHOLDER_PATTERN = /\[\[[A-Z][A-Z0-9_]*_\d+\]\]/g;

/**
 * Variante échappée pour regex shell (prouvé en E2E lot 4 : Claude écrit
 * `sed 's/\[\[EMAIL_ADDRESS_1\]\]/.../'`). Normalisée en placeholder brut
 * avant restauration, pour les commandes Bash uniquement.
 */
const ESCAPED_PLACEHOLDER_PATTERN = /\\\[\\\[([A-Z][A-Z0-9_]*_\d+)\\\]\\\]/g;

function unescapeShellPlaceholders(text: string): string {
  return text.replace(ESCAPED_PLACEHOLDER_PATTERN, "[[$1]]");
}

/** Champs de premier niveau à restaurer, par outil (plans/04, table). */
const FIELDS_BY_TOOL: Record<string, string[]> = {
  Write: ["content", "file_path"],
  Edit: ["old_string", "new_string", "file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["new_source", "notebook_path"],
  Bash: ["command"],
};

/**
 * R7 : une valeur restaurée injectée dans une commande shell doit être inerte.
 * Alphanumériques et @ . - _ + : / uniquement ; tout le reste (espaces, quotes,
 * $, ;, |, &...) est refusé : le démasquage ne doit jamais transformer une
 * commande en autre chose que ce que l'utilisateur a vu.
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
 * Restaure les placeholders des champs texte d'un tool_input local.
 * Fail-closed (D6) : placeholder absent du mapping, ou valeur non shell-safe
 * pour Bash → deny (l'exécution aurait corrompu le fichier ou la commande).
 * Retourne l'objet tool_input COMPLET (contrainte updatedInput).
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

  // MultiEdit : edits[i].old_string / new_string (structure imbriquée).
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
        `PasteGuard : placeholder(s) non résolu(s) dans ${toolName} : ` +
        `${[...unresolved].join(", ")}. L'exécution aurait écrit ces placeholders ` +
        "tels quels (fichier ou commande corrompus). Vérifier la session PasteGuard.",
    };
  }
  if (unsafe.size > 0) {
    return {
      action: "deny",
      reason:
        `PasteGuard : valeur(s) restaurée(s) non sûre(s) pour une commande shell : ` +
        `${[...unsafe].join(", ")}. Réécrire la commande sans ces valeurs ` +
        "(par exemple via un fichier), ou opérer manuellement.",
    };
  }
  if (!changed) return { action: "none" };
  return { action: "update", updatedInput };
}

/** Vrai si au moins un champ candidat de cet outil contient un placeholder. */
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
