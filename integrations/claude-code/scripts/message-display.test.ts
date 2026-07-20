import { describe, expect, test } from "bun:test";
import { freshState } from "../lib/types";
import { computeDisplayContent } from "./message-display";

function stateWith(mapping: Record<string, string>) {
  const state = freshState();
  state.mapping = mapping;
  return state;
}

describe("computeDisplayContent", () => {
  test("placeholders connus restaurés", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean Dupont" });
    expect(computeDisplayContent(state, "Bonjour [[PERSON_1]]")).toBe("Bonjour Jean Dupont");
  });

  test("message sans placeholder : aucune sortie (U2)", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(computeDisplayContent(state, "rien à restaurer ici")).toBeNull();
  });

  test("état de session vide/corrompu (mapping vide) : aucune sortie (U4)", () => {
    expect(computeDisplayContent(freshState(), "Bonjour [[PERSON_1]]")).toBeNull();
  });

  test("texte undefined : aucune sortie", () => {
    expect(computeDisplayContent(freshState(), undefined)).toBeNull();
  });

  test("texte vide : aucune sortie", () => {
    expect(computeDisplayContent(freshState(), "")).toBeNull();
  });
});
