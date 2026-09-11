import { describe, expect, test } from "bun:test";
import { computeSessionStartOutput } from "./session-start";

describe("computeSessionStartOutput", () => {
  test("shape: single-key object with a systemMessage string", () => {
    const output = computeSessionStartOutput({
      mode: "subscription",
      proxied: false,
      hooksActive: true,
      notes: [],
    });
    const parsed = JSON.parse(output);
    expect(Object.keys(parsed)).toEqual(["systemMessage"]);
    expect(typeof parsed.systemMessage).toBe("string");
    expect(parsed.systemMessage).toContain("subscription");
  });

  test("notes are appended to the systemMessage", () => {
    const output = computeSessionStartOutput({
      mode: "third-party",
      proxied: false,
      hooksActive: true,
      notes: ["The PasteGuard proxy does not support Bedrock/Vertex/Foundry; hooks stay active."],
    });
    const parsed = JSON.parse(output);
    expect(parsed.systemMessage).toContain("Bedrock/Vertex/Foundry");
  });
});
