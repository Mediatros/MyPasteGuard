/**
 * Hook MessageDisplay : restaure à l'ÉCRAN les vraies valeurs des placeholders
 * `[[TYPE_n]]` (lot 5), sans toucher au transcript ni au contexte envoyé au
 * modèle. Timeout 10 s côté Claude Code : c'est ce qui impose une restauration
 * purement locale, AUCUN appel réseau (D3).
 *
 * Constat V3 (mesuré le 2026-07-20, headless `claude -p`) : MessageDisplay est
 * appelé UNE seule fois par message, avec `index: 0`, `final: true`, et
 * `delta` égal au message complet (pas de deltas incrémentaux). Le
 * comportement en session interactive avec streaming reste à confirmer ; ce
 * hook reste donc défensif face à un delta partiel.
 *
 * R10/R11 (coupure ou déformation d'un placeholder entre deltas) : stratégie
 * BEST-EFFORT, jamais de retenue de suffixe. Le texte affiché n'est JAMAIS
 * tronqué (les deltas ne sont pas cumulés ici : tronquer perdrait des
 * caractères). Un placeholder coupé (ex. `[[PER` en fin de delta) ou déformé
 * (retour à la ligne, espace, backtick insérés) reste affiché tel quel s'il
 * ne peut pas être résolu ; il sera corrigé au delta suivant ou au rendu
 * final. La restauration tolérante (R11) est gérée par `restoreTextTolerant`.
 *
 * Lecture de l'état SANS verrou (`loadState` direct, pas `withSessionLock`) :
 * une lecture en retard (état pas encore à jour) ne produit qu'un placeholder
 * non restauré à l'écran, jamais une fuite de valeur réelle. Le coût d'un
 * verrou (latence, contention avec PostToolUse/PreToolUse) n'est pas justifié
 * pour un hook purement cosmétique et à budget 10 s.
 *
 * D6 inversé : toute erreur (état illisible, payload imprévu, JSON invalide)
 * → `process.exit(0)` SANS aucune sortie ; l'affichage reste tel quel. On
 * n'émet jamais un `displayContent` partiellement restauré depuis un état
 * douteux.
 *
 * stdout = UNIQUEMENT le JSON de réponse du hook (règle R12). Les
 * diagnostics vont sur stderr.
 */

import { restoreTextTolerant } from "../lib/restore";
import { loadState } from "../lib/store";
import type { SessionState } from "../lib/types";

interface HookPayload {
  session_id?: string;
  message_text?: string;
  delta?: string;
}

/**
 * Calcule le contenu à afficher après restauration tolérante (R11), ou
 * `null` si rien ne doit être émis (texte vide, sans placeholder, ou aucune
 * correspondance résolue dans le mapping).
 */
export function computeDisplayContent(
  state: SessionState,
  text: string | undefined | null,
): string | null {
  if (!text?.includes("[[")) return null;
  const restored = restoreTextTolerant(state, text);
  return restored === text ? null : restored;
}

async function main(): Promise<void> {
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as HookPayload;
    const text = payload.message_text ?? payload.delta;

    // Chemin rapide : pas de placeholder → pas besoin de lire le store.
    if (!text?.includes("[[")) process.exit(0);

    const sessionId = payload.session_id;
    if (!sessionId) process.exit(0);

    const state = await loadState(sessionId);
    const displayContent = computeDisplayContent(state, text);
    if (displayContent === null) process.exit(0);

    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "MessageDisplay", displayContent },
      }),
    );
    process.exit(0);
  } catch (err) {
    // D6 inversé : erreur d'état, de payload ou de JSON → aucune sortie.
    if (err instanceof Error) console.error(err.message);
    process.exit(0);
  }
}

if (import.meta.main) {
  await main();
}
