import { describe, expect, test } from "bun:test";
import { totalTextLength, transformToolResponse } from "./tool-output";

const upper = async (text: string) => text.toUpperCase();

describe("transformToolResponse", () => {
  test("Read : seul file.content est transformé, forme préservée", async () => {
    const response = {
      type: "text",
      file: {
        filePath: "/tmp/a.txt",
        content: "secret",
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    };
    const { response: out, touched } = await transformToolResponse("Read", response, upper);
    expect(touched).toBe(true);
    expect(out).toEqual({
      type: "text",
      file: {
        filePath: "/tmp/a.txt",
        content: "SECRET",
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    });
    // L'original n'est pas muté.
    expect(response.file.content).toBe("secret");
  });

  test("Bash : stdout et stderr transformés, flags intacts", async () => {
    const response = {
      stdout: "a",
      stderr: "b",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    };
    const { response: out } = await transformToolResponse("Bash", response, upper);
    expect(out).toEqual({
      stdout: "A",
      stderr: "B",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    });
  });

  test("Bash : stderr vide non transformé (pas d'appel inutile)", async () => {
    let calls = 0;
    const counting = async (t: string) => {
      calls++;
      return t;
    };
    await transformToolResponse("Bash", { stdout: "x", stderr: "" }, counting);
    expect(calls).toBe(1);
  });

  test("Edit : oldString, newString et originalFile transformés", async () => {
    const response = {
      filePath: "/tmp/a.txt",
      oldString: "avant",
      newString: "après",
      originalFile: "tout le fichier",
      replaceAll: false,
      structuredPatch: [],
      userModified: false,
    };
    const { response: out } = await transformToolResponse("Edit", response, upper);
    const o = out as Record<string, unknown>;
    expect(o.oldString).toBe("AVANT");
    expect(o.newString).toBe("APRÈS");
    expect(o.originalFile).toBe("TOUT LE FICHIER");
    expect(o.filePath).toBe("/tmp/a.txt");
  });

  test("Agent : les blocs text de content[] sont transformés", async () => {
    const response = {
      status: "completed",
      content: [{ type: "text", text: "rapport" }],
      totalTokens: 12,
    };
    const { response: out, touched } = await transformToolResponse("Agent", response, upper);
    expect(touched).toBe(true);
    expect((out as { content: { text: string }[] }).content[0]?.text).toBe("RAPPORT");
  });

  test("outil inconnu : feuilles longues transformées, micro-champs épargnés (MCP)", async () => {
    const response = {
      content: [{ type: "text", text: "rapport client" }],
      meta: { note: "note interne" },
      n: 3,
    };
    const { response: out } = await transformToolResponse("mcp__x__y", response, upper);
    expect(out).toEqual({
      content: [{ type: "text", text: "RAPPORT CLIENT" }],
      meta: { note: "NOTE INTERNE" },
      n: 3,
    });
  });

  test("réponse string brute transformée", async () => {
    const { response: out, touched } = await transformToolResponse("Weird", "texte", upper);
    expect(out).toBe("TEXTE");
    expect(touched).toBe(true);
  });

  test("réponse sans texte : touched false", async () => {
    const { touched } = await transformToolResponse("Grep", { numFiles: 0, filenames: [] }, upper);
    expect(touched).toBe(false);
  });
});

describe("totalTextLength", () => {
  test("somme des champs texte de l'outil", async () => {
    const response = { stdout: "12345", stderr: "678" };
    expect(await totalTextLength("Bash", response)).toBe(8);
  });
});
