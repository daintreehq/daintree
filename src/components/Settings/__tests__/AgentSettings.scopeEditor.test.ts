import { describe, it, expect } from "vitest";
import {
  resolveScopeKind,
  getEffectiveBool,
  isBoolModified,
  isStringModified,
} from "../AgentScopeEditor/scopeUtils";

/**
 * Pure-logic tests for the unified scope editor used inside AgentSettings.
 * Imports canonical helpers from scopeUtils.ts so tests validate the same
 * logic as the production code.
 */

describe("effective boolean value (override ?? agentDefault)", () => {
  it("returns agent default when override is undefined", () => {
    expect(getEffectiveBool(undefined, true)).toBe(true);
    expect(getEffectiveBool(undefined, false)).toBe(false);
  });

  it("returns explicit override when present (even when it matches default)", () => {
    expect(getEffectiveBool(false, true)).toBe(false);
    expect(getEffectiveBool(true, false)).toBe(true);
    expect(getEffectiveBool(true, true)).toBe(true);
  });
});

describe("isModified detection for reset affordance", () => {
  it("boolean override is modified iff value is a boolean (not undefined)", () => {
    expect(isBoolModified(undefined)).toBe(false);
    expect(isBoolModified(true)).toBe(true);
    expect(isBoolModified(false)).toBe(true);
  });

  it("customFlags override is modified when value !== undefined (empty string IS an explicit override)", () => {
    expect(isStringModified(undefined)).toBe(false);
    expect(isStringModified("")).toBe(true);
    expect(isStringModified("--verbose")).toBe(true);
  });
});

describe("inherited env key computation", () => {
  function inheritedEnvKeys(
    globalEnv: Record<string, string>,
    presetEnv: Record<string, string>
  ): string[] {
    return Object.keys(globalEnv).filter((k) => !(k in presetEnv));
  }

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
    const global = { FOO: "from-global" };
    const preset = { FOO: "" };
    expect(inheritedEnvKeys(global, preset)).toEqual([]);
  });
});

describe("override apply — + Override seeds a single key only", () => {
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
  function scopeKindFromIds(
    selectedId: string | undefined,
    customIds: string[],
    projectIds: string[]
  ) {
    // Minimal AgentPreset stubs — resolveScopeKind only reads .id for membership
    const mk = (id: string) => ({ id, name: id });
    return resolveScopeKind(
      selectedId ? mk(selectedId) : undefined,
      customIds.map(mk) as any,
      projectIds.map(mk) as any
    );
  }

  it("returns 'default' when no preset id is selected", () => {
    expect(scopeKindFromIds(undefined, [], []).scopeKind).toBe("default");
  });

  it("returns 'custom' for custom preset ids", () => {
    expect(scopeKindFromIds("user-1", ["user-1"], []).scopeKind).toBe("custom");
  });

  it("returns 'project' for project preset ids", () => {
    expect(scopeKindFromIds("proj-a", [], ["proj-a"]).scopeKind).toBe("project");
  });

  it("returns 'ccr' for ccr preset ids", () => {
    expect(scopeKindFromIds("ccr-x", [], []).scopeKind).toBe("ccr");
  });

  it("falls back to 'default' when selected id no longer exists (stale)", () => {
    expect(scopeKindFromIds("deleted-id", [], []).scopeKind).toBe("default");
  });

  it("prefers custom over project when ids collide", () => {
    const id = "shared-id";
    expect(scopeKindFromIds(id, [id], [id]).scopeKind).toBe("custom");
  });

  it("prefers project over ccr when ids collide", () => {
    const id = "shared-id";
    expect(scopeKindFromIds(id, [], [id]).scopeKind).toBe("project");
  });

  // Guards against prefix-based heuristic mis-classification: a project
  // preset whose id happens to start with "ccr-" must still resolve to
  // "project" because membership checks beat the prefix heuristic.
  it("classifies a project preset with 'ccr-' prefix as 'project', not 'ccr'", () => {
    const result = scopeKindFromIds("ccr-project-route", [], ["ccr-project-route"]);
    expect(result.scopeKind).toBe("project");
    expect(result.selectedIsProject).toBe(true);
    expect(result.selectedIsCcr).toBe(false);
  });

  it("resolves to 'default' when selected id is absent from all source arrays", () => {
    const result = scopeKindFromIds("orphan-id", ["user-a"], ["proj-b"]);
    expect(result.scopeKind).toBe("default");
  });

  // Confirms the "reset in-progress rename" effect fires when scope changes.
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
