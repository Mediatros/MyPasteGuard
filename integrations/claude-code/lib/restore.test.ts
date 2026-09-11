import { describe, expect, test } from "bun:test";
import { containsPlaceholders, restoreText, restoreTextTolerant } from "./restore";
import { freshState } from "./types";

function stateWith(mapping: Record<string, string>) {
  const state = freshState();
  state.mapping = mapping;
  return state;
}

describe("restoreText", () => {
  test("multiple placeholders restored", () => {
    const state = stateWith({
      "[[PERSON_1]]": "Jean Dupont",
      "[[EMAIL_ADDRESS_1]]": "jean@exemple.fr",
    });
    expect(restoreText(state, "Contact [[PERSON_1]] at [[EMAIL_ADDRESS_1]]")).toBe(
      "Contact Jean Dupont at jean@exemple.fr",
    );
  });

  test("unknown placeholder left untouched", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreText(state, "[[PERSON_1]] et [[PERSON_9]]")).toBe("Jean et [[PERSON_9]]");
  });

  test("text without a placeholder unchanged", () => {
    expect(restoreText(freshState(), "nothing to restore")).toBe("nothing to restore");
  });

  test("adjacent placeholders", () => {
    const state = stateWith({ "[[A_1]]": "x", "[[B_2]]": "y" });
    expect(restoreText(state, "[[A_1]][[B_2]]")).toBe("xy");
  });

  test("repeated occurrences of the same placeholder", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreText(state, "[[PERSON_1]], encore [[PERSON_1]]")).toBe("Jean, encore Jean");
  });
});

describe("containsPlaceholders", () => {
  test("detects a placeholder", () => {
    expect(containsPlaceholders("voici [[EMAIL_ADDRESS_3]]")).toBe(true);
  });

  test("false for ordinary text", () => {
    expect(containsPlaceholders("nothing here, not even [[not_this]] nor [PERSON_1]")).toBe(false);
  });

  test("stable repeated calls (no shared regex state)", () => {
    expect(containsPlaceholders("[[A_1]]")).toBe(true);
    expect(containsPlaceholders("[[A_1]]")).toBe(true);
  });
});

describe("restoreTextTolerant", () => {
  test("3 known placeholders all restored (U1)", () => {
    const state = stateWith({
      "[[PERSON_1]]": "Jean Dupont",
      "[[EMAIL_ADDRESS_1]]": "jean@exemple.fr",
      "[[PHONE_NUMBER_1]]": "0102030405",
    });
    expect(
      restoreTextTolerant(state, "[[PERSON_1]], [[EMAIL_ADDRESS_1]], [[PHONE_NUMBER_1]]"),
    ).toBe("Jean Dupont, jean@exemple.fr, 0102030405");
  });

  test("empty message unchanged (U5)", () => {
    expect(restoreTextTolerant(freshState(), "")).toBe("");
  });

  test("placeholder cut off at end of text, never truncated (U7)", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "Bonjour [[PER")).toBe("Bonjour [[PER");
  });

  test("well-formed placeholder restored like restoreText", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean Dupont" });
    expect(restoreTextTolerant(state, "Voici [[PERSON_1]]")).toBe("Voici Jean Dupont");
  });

  test("newline inserted in the name", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[PERSON\n_1]]")).toBe("Jean");
  });

  test("trailing space in the name", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[PERSON_1 ]]")).toBe("Jean");
  });

  test("backticks around the name", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[`PERSON_1`]]")).toBe("Jean");
  });

  test("spaces around the name", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[ PERSON_1 ]]")).toBe("Jean");
  });

  test("unknown placeholder (even deformed) left untouched", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(restoreTextTolerant(state, "[[PERSON\n_9]]")).toBe("[[PERSON\n_9]]");
  });

  test("text without a placeholder unchanged", () => {
    expect(restoreTextTolerant(freshState(), "nothing to restore")).toBe("nothing to restore");
  });
});
