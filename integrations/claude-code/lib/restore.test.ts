import { describe, expect, test } from "bun:test";
import { containsPlaceholders, restoreText } from "./restore";
import { freshState } from "./types";

function stateWith(mapping: Record<string, string>) {
  const state = freshState();
  state.mapping = mapping;
  return state;
}

describe("restoreText", () => {
  test("placeholders multiples restaurés", () => {
    const state = stateWith({
      "[[PERSON_1]]": "Jean Dupont",
      "[[EMAIL_ADDRESS_1]]": "jean@exemple.fr",
    });
    expect(restoreText(state, "Contacter [[PERSON_1]] à [[EMAIL_ADDRESS_1]]")).toBe(
      "Contacter Jean Dupont à jean@exemple.fr",
    );
  });

  test("placeholder inconnu laissé intact", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreText(state, "[[PERSON_1]] et [[PERSON_9]]")).toBe("Jean et [[PERSON_9]]");
  });

  test("texte sans placeholder inchangé", () => {
    expect(restoreText(freshState(), "rien à restaurer")).toBe("rien à restaurer");
  });

  test("placeholders adjacents", () => {
    const state = stateWith({ "[[A_1]]": "x", "[[B_2]]": "y" });
    expect(restoreText(state, "[[A_1]][[B_2]]")).toBe("xy");
  });

  test("occurrences répétées du même placeholder", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreText(state, "[[PERSON_1]], encore [[PERSON_1]]")).toBe("Jean, encore Jean");
  });
});

describe("containsPlaceholders", () => {
  test("détecte un placeholder", () => {
    expect(containsPlaceholders("voici [[EMAIL_ADDRESS_3]]")).toBe(true);
  });

  test("faux pour un texte ordinaire", () => {
    expect(containsPlaceholders("rien ici, même [[pas_ça]] ni [PERSON_1]")).toBe(false);
  });

  test("appels répétés stables (pas d'état de regex partagé)", () => {
    expect(containsPlaceholders("[[A_1]]")).toBe(true);
    expect(containsPlaceholders("[[A_1]]")).toBe(true);
  });
});
