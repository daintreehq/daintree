import { describe, it, expect } from "vitest";
import type { RecipeTerminal } from "../../../shared/types/project.js";
import { matchRecipeSteps } from "../recipeStepMatching.js";

describe("matchRecipeSteps", () => {
  it.each<[string, RecipeTerminal, RecipeTerminal]>([
    ["type", { type: "terminal", title: "S" }, { type: "dev-preview", title: "S" }],
    [
      "title",
      { type: "terminal", title: "Old", command: "run" },
      { type: "terminal", title: "New", command: "run" },
    ],
    ["command", { type: "terminal", command: "run-a" }, { type: "terminal", command: "run-b" }],
    [
      "devCommand",
      { type: "dev-preview", devCommand: "dev-a" },
      { type: "dev-preview", devCommand: "dev-b" },
    ],
    ["args", { type: "claude", args: "--a" }, { type: "claude", args: "--b" }],
    [
      "initialPrompt",
      { type: "claude", initialPrompt: "a" },
      { type: "claude", initialPrompt: "b" },
    ],
    [
      "panelKindId",
      { type: "plugin-panel", panelKindId: "p.a" },
      { type: "plugin-panel", panelKindId: "p.b" },
    ],
  ])("a step whose %s changed is not matched", (_field, local, canonical) => {
    expect(matchRecipeSteps([canonical], [local])).toEqual([undefined]);
  });

  it("ignores fields and whitespace the canonical sanitizer drops", () => {
    const local: RecipeTerminal = {
      type: "terminal",
      title: "S",
      command: "  run-a ",
      args: "--stray",
      initialPrompt: "stray",
      env: { K: "v" },
    };
    const canonical: RecipeTerminal = {
      type: "terminal",
      title: "S",
      command: "run-a",
      env: { K: "" },
    };
    expect(matchRecipeSteps([canonical], [local])).toEqual([local]);
  });

  it("normalizes agent prompt line endings like the sanitizer", () => {
    const local: RecipeTerminal = { type: "claude", initialPrompt: "a\r\nb\n" };
    const canonical: RecipeTerminal = { type: "claude", initialPrompt: "a\nb" };
    expect(matchRecipeSteps([canonical], [local])).toEqual([local]);
  });

  it("checks every canonical duplicate's env keys before pairing moved duplicates", () => {
    const a1: RecipeTerminal = { type: "terminal", command: "a", env: { PORT: "1", TOKEN: "one" } };
    const a2: RecipeTerminal = { type: "terminal", command: "a", env: { PORT: "1", TOKEN: "two" } };
    const b: RecipeTerminal = { type: "terminal", command: "b", env: { K: "b" } };
    const result = matchRecipeSteps(
      [
        { type: "terminal", command: "b", env: { K: "" } },
        { type: "terminal", command: "a", env: { PORT: "" } },
        { type: "terminal", command: "a", env: { PORT: "", TOKEN: "" } },
      ],
      [a1, b, a2]
    );
    expect(result).toEqual([b, undefined, undefined]);
  });
});
