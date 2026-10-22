import { describe, expect, it } from "vitest";
import { findPromptTemplatePlaceholders, renderPromptTemplate } from "../pluginPromptTemplates.js";

describe("renderPromptTemplate", () => {
  it("fills every reference, tolerating inner whitespace", () => {
    expect(renderPromptTemplate("{{a}} and {{ b }} and {{a}}", { a: "1", b: "2" })).toBe(
      "1 and 2 and 1"
    );
  });

  it("turns a reference with no value into empty text", () => {
    expect(renderPromptTemplate("Hi {{name}}!", {})).toBe("Hi !");
  });

  it("inserts values literally and never expands them again", () => {
    expect(renderPromptTemplate("{{a}}|{{b}}", { a: "{{b}}", b: "$& $1" })).toBe("{{b}}|$& $1");
  });

  it("does not read inherited properties as values", () => {
    expect(renderPromptTemplate("{{constructor}}", {})).toBe("");
  });
});

describe("findPromptTemplatePlaceholders", () => {
  it("lists the trimmed reference text in order", () => {
    expect(findPromptTemplatePlaceholders("{{ a }} x {{b}} {{a}} {{}}")).toEqual([
      "a",
      "b",
      "a",
      "",
    ]);
  });
});
