import { describe, expect, test } from "bun:test";
import { inputHasPlaceholders, restoreToolInput } from "./tool-input";
import { freshState } from "./types";

function stateWith(mapping: Record<string, string>) {
  const state = freshState();
  state.mapping = mapping;
  return state;
}

const MAPPING = {
  "[[EMAIL_ADDRESS_1]]": "jean.dupont@exemple.fr",
  "[[PERSON_1]]": "Jean Dupont",
  "[[IP_ADDRESS_1]]": "10.1.2.3",
};

describe("restoreToolInput — Write", () => {
  test("content and file_path restored, other fields untouched", () => {
    const state = stateWith(MAPPING);
    const result = restoreToolInput(state, "Write", {
      file_path: "/tmp/rapport-[[PERSON_1]].md",
      content: "Contacter [[EMAIL_ADDRESS_1]]",
    });
    expect(result.action).toBe("update");
    if (result.action !== "update") return;
    expect(result.updatedInput).toEqual({
      file_path: "/tmp/rapport-Jean Dupont.md",
      content: "Contacter jean.dupont@exemple.fr",
    });
  });

  test("unknown placeholder → deny, nothing is written", () => {
    const state = stateWith(MAPPING);
    const result = restoreToolInput(state, "Write", {
      file_path: "/tmp/x.md",
      content: "valeur [[PERSON_99]] perdue",
    });
    expect(result.action).toBe("deny");
    if (result.action !== "deny") return;
    expect(result.reason).toContain("[[PERSON_99]]");
  });
});

describe("restoreToolInput — Edit", () => {
  test("old_string and new_string restored, updatedInput complete", () => {
    const state = stateWith(MAPPING);
    const input = {
      file_path: "/tmp/f.txt",
      old_string: "email : [[EMAIL_ADDRESS_1]]",
      new_string: "email : contact@example.org ([[PERSON_1]])",
      replace_all: true,
    };
    const result = restoreToolInput(state, "Edit", input);
    expect(result.action).toBe("update");
    if (result.action !== "update") return;
    expect(result.updatedInput).toEqual({
      file_path: "/tmp/f.txt",
      old_string: "email : jean.dupont@exemple.fr",
      new_string: "email : contact@example.org (Jean Dupont)",
      replace_all: true,
    });
  });
});

describe("restoreToolInput — MultiEdit", () => {
  test("only edits with placeholders change, structure preserved", () => {
    const state = stateWith(MAPPING);
    const result = restoreToolInput(state, "MultiEdit", {
      file_path: "/tmp/f.txt",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "[[PERSON_1]]", new_string: "Personne" },
        { old_string: "c", new_string: "d", replace_all: true },
      ],
    });
    expect(result.action).toBe("update");
    if (result.action !== "update") return;
    expect(result.updatedInput.edits).toEqual([
      { old_string: "a", new_string: "b" },
      { old_string: "Jean Dupont", new_string: "Personne" },
      { old_string: "c", new_string: "d", replace_all: true },
    ]);
  });
});

describe("restoreToolInput — NotebookEdit", () => {
  test("new_source restored", () => {
    const state = stateWith(MAPPING);
    const result = restoreToolInput(state, "NotebookEdit", {
      notebook_path: "/tmp/n.ipynb",
      cell_id: "c1",
      new_source: "server = '[[IP_ADDRESS_1]]'",
    });
    expect(result.action).toBe("update");
    if (result.action !== "update") return;
    expect(result.updatedInput.new_source).toBe("server = '10.1.2.3'");
    expect(result.updatedInput.cell_id).toBe("c1");
  });
});

describe("restoreToolInput — Bash (R7 shell-safe)", () => {
  test("shell-safe value restored in command, description untouched", () => {
    const state = stateWith(MAPPING);
    const result = restoreToolInput(state, "Bash", {
      command: "grep '[[EMAIL_ADDRESS_1]]' clients.txt",
      description: "cherche [[EMAIL_ADDRESS_1]]",
    });
    expect(result.action).toBe("update");
    if (result.action !== "update") return;
    expect(result.updatedInput.command).toBe("grep 'jean.dupont@exemple.fr' clients.txt");
    expect(result.updatedInput.description).toBe("cherche [[EMAIL_ADDRESS_1]]");
  });

  test("value with a space (full name) → deny, command not executed", () => {
    const state = stateWith(MAPPING);
    const result = restoreToolInput(state, "Bash", {
      command: "grep '[[PERSON_1]]' clients.txt",
    });
    expect(result.action).toBe("deny");
    if (result.action !== "deny") return;
    expect(result.reason).toContain("[[PERSON_1]]");
  });

  test("escaped placeholder for sed restored (E2E bug batch 4)", () => {
    const state = stateWith(MAPPING);
    const result = restoreToolInput(state, "Bash", {
      command: "sed -i '' 's/\\[\\[EMAIL_ADDRESS_1\\]\\]/contact@example.org/' clients.txt",
    });
    expect(result.action).toBe("update");
    if (result.action !== "update") return;
    expect(result.updatedInput.command).toBe(
      "sed -i '' 's/jean.dupont@exemple.fr/contact@example.org/' clients.txt",
    );
  });

  test("unknown escaped placeholder → deny (no silent no-op sed)", () => {
    const state = stateWith(MAPPING);
    const result = restoreToolInput(state, "Bash", {
      command: "sed 's/\\[\\[EMAIL_ADDRESS_9\\]\\]/x/' f.txt",
    });
    expect(result.action).toBe("deny");
  });

  test("value with a shell metacharacter → deny", () => {
    const state = stateWith({ "[[ENV_PASSWORD_1]]": "p@ss;rm -rf" });
    const result = restoreToolInput(state, "Bash", {
      command: "echo [[ENV_PASSWORD_1]]",
    });
    expect(result.action).toBe("deny");
  });
});

describe("restoreToolInput — cross-cutting cases", () => {
  test("no placeholder → none", () => {
    const result = restoreToolInput(stateWith(MAPPING), "Write", {
      file_path: "/tmp/x",
      content: "rien",
    });
    expect(result.action).toBe("none");
  });

  test("out-of-scope tool (WebFetch) → none even with a placeholder", () => {
    const result = restoreToolInput(stateWith(MAPPING), "WebFetch", {
      url: "https://ex.com/[[PERSON_1]]",
      prompt: "[[EMAIL_ADDRESS_1]]",
    });
    expect(result.action).toBe("none");
  });

  test("single unknown placeholder among known ones → deny (fail-closed)", () => {
    const result = restoreToolInput(stateWith(MAPPING), "Write", {
      file_path: "/tmp/x",
      content: "[[PERSON_1]] et [[PERSON_2]]",
    });
    expect(result.action).toBe("deny");
    if (result.action !== "deny") return;
    expect(result.reason).toContain("[[PERSON_2]]");
    expect(result.reason).not.toContain("[[PERSON_1]],");
  });
});

describe("inputHasPlaceholders", () => {
  test("detects in a simple field", () => {
    expect(inputHasPlaceholders("Bash", { command: "echo [[A_1]]" })).toBe(true);
  });

  test("detects in MultiEdit edits", () => {
    expect(
      inputHasPlaceholders("MultiEdit", {
        file_path: "/tmp/f",
        edits: [{ old_string: "x", new_string: "[[B_2]]" }],
      }),
    ).toBe(true);
  });

  test("false if tool is out of scope or has no placeholder", () => {
    expect(inputHasPlaceholders("WebFetch", { url: "[[A_1]]" })).toBe(false);
    expect(inputHasPlaceholders("Bash", { command: "ls" })).toBe(false);
  });
});
