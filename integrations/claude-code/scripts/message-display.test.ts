import { describe, expect, test } from "bun:test";
import { freshState } from "../lib/types";
import { computeDisplayContent } from "./message-display";

function stateWith(mapping: Record<string, string>) {
  const state = freshState();
  state.mapping = mapping;
  return state;
}

describe("computeDisplayContent", () => {
  test("known placeholders restored", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean Dupont" });
    expect(computeDisplayContent(state, "Hello [[PERSON_1]]")).toBe("Hello Jean Dupont");
  });

  test("message without placeholder: no output (U2)", () => {
    const state = stateWith({ "[[PERSON_1]]": "Jean" });
    expect(computeDisplayContent(state, "nothing to restore here")).toBeNull();
  });

  test("empty/corrupted session state (empty mapping): no output (U4)", () => {
    expect(computeDisplayContent(freshState(), "Hello [[PERSON_1]]")).toBeNull();
  });

  test("undefined text: no output", () => {
    expect(computeDisplayContent(freshState(), undefined)).toBeNull();
  });

  test("empty text: no output", () => {
    expect(computeDisplayContent(freshState(), "")).toBeNull();
  });
});
