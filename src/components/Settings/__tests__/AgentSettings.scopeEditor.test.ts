import { describe, it, expect } from "vitest";
import {
  resolveScopeKind,
  isBoolModified,
  isStringModified,
  savedPresetStatus,
} from "../AgentScopeEditor/scopeUtils";

/**
 * Pure-logic tests for the unified scope editor used inside AgentSettings.
 * Imports canonical helpers from scopeUtils.ts so tests validate the same
 * logic as the production code.
 */

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
});

describe("saved preset status (#15025)", () => {
  const presets = [{ id: "user-a", name: "A" }];
  const loaded = { ccr: true, project: true };

  it("finds a preset on hand whatever has loaded", () => {
    expect(savedPresetStatus("user-a", presets, { ccr: false, project: false })).toBe("found");
    expect(savedPresetStatus(undefined, presets, loaded)).toBe("none");
  });

  it("keeps an id the unread project presets could still hold, whatever it looks like", () => {
    const unread = { ccr: true, project: false };
    expect(savedPresetStatus("team-opus", presets, unread)).toBe("loading");
    expect(savedPresetStatus("user-gone", presets, unread)).toBe("loading");
  });

  it("keeps a CCR id until the routes are read, but lets any other id go", () => {
    const unread = { ccr: false, project: true };
    expect(savedPresetStatus("ccr-opus", presets, unread)).toBe("loading");
    expect(savedPresetStatus("user-gone", presets, unread)).toBe("missing");
  });

  it("reports an id gone once everything that could hold it has loaded", () => {
    expect(savedPresetStatus("ccr-opus", presets, loaded)).toBe("missing");
    expect(savedPresetStatus("team-opus", presets, loaded)).toBe("missing");
  });
});
