import { describe, it, expect } from "vitest";

/**
 * Unit tests for the preset-inherits-from-agent-defaults derivation logic used
 * inside AgentSettings' custom preset detail view. These are pure logic tests —
 * the rendering is exercised by the Settings integration tests.
 */

// Mirrors the inline helpers in AgentSettings.tsx. Kept local so the UI file
// stays a single export and these tests stay hermetic. The sentinel value
// `"__inherit__"` is required because Radix Select forbids `value=""` on
// SelectItem — see SettingsSelect / ui/select.tsx.
const boolToSelectValue = (v: boolean | undefined): string =>
  v === undefined ? "__inherit__" : v ? "true" : "false";

const selectValueToBool = (s: string): boolean | undefined =>
  s === "true" ? true : s === "false" ? false : undefined;

function effectiveBool(override: boolean | undefined, agentDefault: boolean): boolean {
  return override ?? agentDefault;
}

function inheritedEnvKeys(
  globalEnv: Record<string, string>,
  presetEnv: Record<string, string>
): string[] {
  return Object.keys(globalEnv).filter((k) => !(k in presetEnv));
}

describe("tri-state boolean serialization", () => {
  it('maps undefined → "__inherit__" sentinel (Radix Select forbids empty values)', () => {
    expect(boolToSelectValue(undefined)).toBe("__inherit__");
  });

  it('maps true → "true" and false → "false"', () => {
    expect(boolToSelectValue(true)).toBe("true");
    expect(boolToSelectValue(false)).toBe("false");
  });

  it('maps "__inherit__" → undefined (inherit)', () => {
    expect(selectValueToBool("__inherit__")).toBeUndefined();
  });

  it('maps "true" → true and "false" → false', () => {
    expect(selectValueToBool("true")).toBe(true);
    expect(selectValueToBool("false")).toBe(false);
  });

  it("falls back to undefined for unexpected strings (defensive)", () => {
    expect(selectValueToBool("yes")).toBeUndefined();
    expect(selectValueToBool("0")).toBeUndefined();
    expect(selectValueToBool(" ")).toBeUndefined();
  });

  it("round-trips boolean | undefined through the select mapping", () => {
    for (const v of [true, false, undefined] as const) {
      expect(selectValueToBool(boolToSelectValue(v))).toBe(v);
    }
  });
});

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

describe("inherit-label derivation for tri-state select", () => {
  // The "Inherit (X)" option label surfaces the agent-level default so users
  // can see what they'd inherit without leaving the form.
  const inheritLabel = (agentDefault: boolean): string =>
    `Inherit (${agentDefault ? "On" : "Off"})`;

  it('shows "On" when agent default is true', () => {
    expect(inheritLabel(true)).toBe("Inherit (On)");
  });

  it('shows "Off" when agent default is false', () => {
    expect(inheritLabel(false)).toBe("Inherit (Off)");
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
