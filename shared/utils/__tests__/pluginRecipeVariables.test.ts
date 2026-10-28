import { describe, expect, it } from "vitest";
import {
  PLUGIN_RECIPE_VARIABLE_MAX_LENGTH,
  PLUGIN_RECIPE_VARIABLES_MAX_TOTAL,
  pluginVariableReferences,
  validatePluginRecipeVariables,
} from "../pluginRecipeVariables.js";

describe("pluginVariableReferences", () => {
  it("lists each plugin variable a template uses once, ignoring host variables", () => {
    expect(
      pluginVariableReferences(
        "{{plugin.record_id}} on {{branch_name}}, again {{plugin.record_id}} and {{plugin.Title}}"
      )
    ).toEqual(["record_id", "title"]);
  });
});

describe("validatePluginRecipeVariables", () => {
  it("accepts declared names and returns a copy with no prototype", () => {
    const result = validatePluginRecipeVariables({ record_id: "42" }, ["record_id", "title"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({ ...result.values }).toEqual({ record_id: "42" });
    expect(Object.getPrototypeOf(result.values)).toBeNull();
  });

  it("treats no variables as none", () => {
    const result = validatePluginRecipeVariables(undefined, ["record_id"]);
    expect(result.ok && Object.keys(result.values)).toEqual([]);
  });

  it.each([
    ["an undeclared name", { other: "x" }, ["record_id"]],
    ["a name when none are declared", { record_id: "x" }, []],
    ["a non-string value", { record_id: 42 }, ["record_id"]],
    ["control characters", { record_id: "a\u0000b" }, ["record_id"]],
    [
      "a value over the cap",
      { record_id: "x".repeat(PLUGIN_RECIPE_VARIABLE_MAX_LENGTH + 1) },
      ["record_id"],
    ],
    ["an array", ["x"], ["record_id"]],
    ["null", null, ["record_id"]],
  ])("refuses %s", (_label, raw, declared) => {
    expect(validatePluginRecipeVariables(raw, declared).ok).toBe(false);
  });

  it("refuses values over the total cap even when each is within its own", () => {
    const names = ["a", "b", "c", "d", "e"];
    const each = "x".repeat(Math.ceil(PLUGIN_RECIPE_VARIABLES_MAX_TOTAL / 4));
    const raw = Object.fromEntries(names.map((name) => [name, each]));
    expect(validatePluginRecipeVariables(raw, names).ok).toBe(false);
  });

  it("never admits __proto__, even from parsed JSON", () => {
    const raw: unknown = JSON.parse('{"__proto__": "x"}');
    expect(validatePluginRecipeVariables(raw, ["record_id"]).ok).toBe(false);
  });

  it("keeps lines in a value", () => {
    const result = validatePluginRecipeVariables({ notes: "one\ntwo" }, ["notes"]);
    expect(result.ok && result.values.notes).toBe("one\ntwo");
  });
});
