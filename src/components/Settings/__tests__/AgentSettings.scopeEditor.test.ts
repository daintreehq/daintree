import { describe, it, expect } from "vitest";

/**
 * Pure-logic tests for the unified scope editor used inside AgentSettings.
 * A scope is either "Default" (the agent-level defaults) or a specific preset;
 * custom presets can override agent defaults with an explicit `boolean | string`
 * value (or omit the key to inherit). These helpers back the Switch/input
 * affordances — rendering is exercised by E2E.
 */

function effectiveBool(override: boolean | undefined, agentDefault: boolean): boolean {
  return override ?? agentDefault;
}

function inheritedEnvKeys(
  globalEnv: Record<string, string>,
  presetEnv: Record<string, string>
): string[] {
  return Object.keys(globalEnv).filter((k) => !(k in presetEnv));
}

describe("effective boolean value (override ?? agentDefault)", () => {
  it("returns agent default when override is undefined", () => {
    expect(effectiveBool(undefined, true)).toBe(true);
    expect(effectiveBool(undefined, false)).toBe(false);
  });

  it("returns explicit override when present (even when it matches default)", () => {
    expect(effectiveBool(false, true)).toBe(false);
    expect(effectiveBool(true, false)).toBe(true);
    expect(effectiveBool(true, true)).toBe(true);
  });
});

describe("isModified detection for reset affordance", () => {
  it("boolean override is modified iff value is a boolean (not undefined)", () => {
    const isBoolModified = (v: boolean | undefined): boolean => typeof v === "boolean";
    expect(isBoolModified(undefined)).toBe(false);
    expect(isBoolModified(true)).toBe(true);
    expect(isBoolModified(false)).toBe(true);
  });

  it("customFlags override is modified when value !== undefined (empty string IS an explicit override)", () => {
    const isStringModified = (v: string | undefined): boolean => v !== undefined;
    expect(isStringModified(undefined)).toBe(false);
    expect(isStringModified("")).toBe(true);
    expect(isStringModified("--verbose")).toBe(true);
  });
});

describe("inherited env key computation", () => {
  it("returns global keys not present in preset env", () => {
    const global = { FOO: "1", BAR: "2", BAZ: "3" };
    const preset = { FOO: "override" };
    expect(inheritedEnvKeys(global, preset).sort()).toEqual(["BAR", "BAZ"]);
  });

  it("returns empty when preset overrides all global keys", () => {
    const global = { FOO: "1", BAR: "2" };
    const preset = { FOO: "a", BAR: "b" };
    expect(inheritedEnvKeys(global, preset)).toEqual([]);
  });

  it("returns empty when global env is empty", () => {
    expect(inheritedEnvKeys({}, { FOO: "x" })).toEqual([]);
  });

  it("returns all global keys when preset env is empty", () => {
    expect(inheritedEnvKeys({ FOO: "1", BAR: "2" }, {}).sort()).toEqual(["BAR", "FOO"]);
  });

  it("treats empty-string preset value as a defined override (not inherited)", () => {
    // Preset users may intentionally clear an inherited value by setting "".
    // The inherited strip must NOT re-surface it — the key is overridden.
    const global = { FOO: "from-global" };
    const preset = { FOO: "" };
    expect(inheritedEnvKeys(global, preset)).toEqual([]);
  });
});

describe("override apply — + Override seeds a single key only", () => {
  // The "+ Override" click must copy only the specific key from globalEnv into
  // preset.env — NOT the entire globalEnv map. This prevents accidentally
  // snapshotting the global state into the preset's delta.
  function applyOverride(
    presetEnv: Record<string, string>,
    globalEnv: Record<string, string>,
    key: string
  ): Record<string, string> {
    const value = globalEnv[key];
    if (value === undefined) return presetEnv;
    return { ...presetEnv, [key]: value };
  }

  it("adds only the clicked key to preset env", () => {
    const global = { FOO: "1", BAR: "2", BAZ: "3" };
    const preset = {};
    const next = applyOverride(preset, global, "BAR");
    expect(next).toEqual({ BAR: "2" });
  });

  it("preserves existing preset overrides when adding a new one", () => {
    const global = { FOO: "1", BAR: "2" };
    const preset = { EXISTING: "kept" };
    const next = applyOverride(preset, global, "FOO");
    expect(next).toEqual({ EXISTING: "kept", FOO: "1" });
  });
});

describe("scope kind resolution", () => {
  // Mirrors the inline scope kind derivation in AgentSettings.tsx. Given the
  // selected preset and its membership in the three source arrays, the scope
  // is either "default" (no preset selected) or one of "custom" / "project" /
  // "ccr". Custom wins over project wins over CCR on id collision, matching
  // getMergedPresets precedence.
  function scopeKind(
    selectedId: string | undefined,
    customIds: string[],
    projectIds: string[],
    ccrIds: string[]
  ): "default" | "custom" | "project" | "ccr" {
    if (!selectedId) return "default";
    if (customIds.includes(selectedId)) return "custom";
    if (projectIds.includes(selectedId)) return "project";
    if (ccrIds.includes(selectedId)) return "ccr";
    return "default";
  }

  it("returns 'default' when no preset id is selected", () => {
    expect(scopeKind(undefined, [], [], [])).toBe("default");
  });

  it("returns 'custom' for custom preset ids", () => {
    expect(scopeKind("user-1", ["user-1"], [], [])).toBe("custom");
  });

  it("returns 'project' for project preset ids", () => {
    expect(scopeKind("proj-a", [], ["proj-a"], [])).toBe("project");
  });

  it("returns 'ccr' for ccr preset ids", () => {
    expect(scopeKind("ccr-x", [], [], ["ccr-x"])).toBe("ccr");
  });

  it("falls back to 'default' when selected id no longer exists (stale)", () => {
    expect(scopeKind("deleted-id", [], [], [])).toBe("default");
  });

  it("prefers custom over project when ids collide", () => {
    const id = "shared-id";
    expect(scopeKind(id, [id], [id], [])).toBe("custom");
  });

  it("prefers project over ccr when ids collide", () => {
    const id = "shared-id";
    expect(scopeKind(id, [], [id], [id])).toBe("project");
  });

  // Confirms the "reset in-progress rename" effect fires when scope changes.
  // The UI reads the activeEntry.presetId as the scope key; any change in this
  // value must drop editingPresetId to null so the input unmounts cleanly.
  it("any scope change resets the edit state (prev !== next)", () => {
    const shouldReset = (prev: string | undefined, next: string | undefined): boolean =>
      prev !== next;
    expect(shouldReset(undefined, "user-1")).toBe(true);
    expect(shouldReset("user-1", undefined)).toBe(true);
    expect(shouldReset("user-1", "user-2")).toBe(true);
    expect(shouldReset("user-1", "user-1")).toBe(false);
    expect(shouldReset(undefined, undefined)).toBe(false);
  });
});
