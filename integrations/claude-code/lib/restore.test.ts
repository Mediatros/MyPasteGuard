import { describe, expect, test } from "bun:test";
import { containsPlaceholders, restoreText, restoreTextTolerant } from "./restore";
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

describe("restoreTextTolerant", () => {
  test("3 placeholders connus tous restaurés (U1)", () => {
    const state = stateWith({
      "[[PERSON_1]]": "Jean Dupont",
      "[[EMAIL_ADDRESS_1]]": "jean@exemple.fr",
      "[[PHONE_NUMBER_1]]": "0102030405",
    });
    expect(
      restoreTextTolerant(state, "[[PERSON_1]], [[EMAIL_ADDRESS_1]], [[PHONE_NUMBER_1]]"),
    ).toBe("Jean Dupont, jean@exemple.fr, 0102030405");
  });

  test("message vide inchangé (U5)", () => {
    expect(restoreTextTolerant(freshState(), "")).toBe("");
  });

  test("placeholder coupé en fin de texte, jamais tronqué (U7)", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "Bonjour [[PER")).toBe("Bonjour [[PER");
  });

  test("placeholder bien formé restauré comme restoreText", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean Dupont" });
    expect(restoreTextTolerant(state, "Voici [[PERSON_1]]")).toBe("Voici Jean Dupont");
  });

  test("retour à la ligne inséré dans le nom", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[PERSON\n_1]]")).toBe("Jean");
  });

  test("espace en fin de nom", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[PERSON_1 ]]")).toBe("Jean");
  });

  test("backticks autour du nom", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[`PERSON_1`]]")).toBe("Jean");
  });

  test("espaces autour du nom", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[ PERSON_1 ]]")).toBe("Jean");
  });

  test("placeholder inconnu (même déformé) laissé intact", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[PERSON\n_9]]")).toBe("[[PERSON\n_9]]");
  });

  test("texte sans placeholder inchangé", () => {
    expect(restoreTextTolerant(freshState(), "rien à restaurer")).toBe("rien à restaurer");
  });
});
