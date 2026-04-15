import { describe, it, expect } from "vitest";
import { exportProfile, importProfile } from "../keybindingProfileIO.js";

describe("exportProfile", () => {
  it("produces valid JSON", () => {
    const json = exportProfile({ "terminal.new": ["Cmd+T"] });
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("includes required top-level fields", () => {
    const profile = JSON.parse(exportProfile({}));
    expect(profile.schemaVersion).toBe(1);
    expect(profile.app).toBe("daintree");
    expect(typeof profile.exportedAt).toBe("string");
    expect(profile.overrides).toBeDefined();
  });

  it("contains only the provided overrides", () => {
    const overrides = { "terminal.new": ["Cmd+T"], "app.settings": ["Cmd+,"] };
    const profile = JSON.parse(exportProfile(overrides));
    expect(profile.overrides).toEqual(overrides);
  });

  it("produces empty overrides object when none provided", () => {
    const profile = JSON.parse(exportProfile({}));
    expect(profile.overrides).toEqual({});
  });

  it("exportedAt is a valid ISO 8601 timestamp", () => {
    const profile = JSON.parse(exportProfile({}));
    const d = new Date(profile.exportedAt);
    expect(d.getTime()).not.toBeNaN();
  });
});

describe("importProfile", () => {
  function makeProfileJson(
    overrides: Record<string, unknown> = {},
    extra: Record<string, unknown> = {}
  ): string {
    return JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      app: "daintree",
      overrides,
      ...extra,
    });
  }

  it("parses a valid profile correctly", () => {
    const result = importProfile(makeProfileJson({ "terminal.new": ["Cmd+T"] }));
    expect(result.ok).toBe(true);
    expect(result.overrides["terminal.new"]).toEqual(["Cmd+T"]);
  });

  it("accepts unknown action IDs for plugin extensibility", () => {
    const result = importProfile(
      makeProfileJson({
        "terminal.new": ["Cmd+T"],
        "unknown.action": ["Cmd+X"],
        "plugin.myCustomAction": ["Cmd+Y"],
      })
    );
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.overrides["unknown.action"]).toEqual(["Cmd+X"]);
    expect(result.overrides["plugin.myCustomAction"]).toEqual(["Cmd+Y"]);
  });

  it("returns correct applied count for all entries", () => {
    const result = importProfile(
      makeProfileJson({
        "terminal.new": ["Cmd+T"],
        "terminal.close": ["Cmd+W"],
        "custom.action": ["Cmd+B"],
      })
    );
    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("rejects invalid JSON", () => {
    const result = importProfile("not valid json{{{");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe("Invalid JSON");
  });

  it("rejects unsupported schema version", () => {
    const json = JSON.stringify({
      schemaVersion: 99,
      app: "daintree",
      exportedAt: "",
      overrides: {},
    });
    const result = importProfile(json);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Unsupported schema version: 99");
  });

  it("rejects file exceeding 100KB", () => {
    const bigJson = "x".repeat(101 * 1024);
    const result = importProfile(bigJson);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("too large");
  });

  it("rejects structurally invalid profile (missing overrides)", () => {
    const json = JSON.stringify({ schemaVersion: 1, app: "daintree", exportedAt: "" });
    const result = importProfile(json);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles empty overrides as a no-op successfully", () => {
    const result = importProfile(makeProfileJson({}));
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.overrides).toEqual({});
  });

  it("strips whitespace-only combo strings from imported entries", () => {
    const result = importProfile(makeProfileJson({ "terminal.new": ["   ", "  "] }));
    expect(result.ok).toBe(true);
    expect(result.overrides["terminal.new"]).toEqual([]);
  });

  it("skips empty and whitespace-only action ID keys", () => {
    const result = importProfile(
      makeProfileJson({ "": ["Cmd+X"], "   ": ["Cmd+Y"], "terminal.new": ["Cmd+T"] })
    );
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.overrides[""]).toBeUndefined();
    expect(result.overrides["   "]).toBeUndefined();
    expect(result.overrides["terminal.new"]).toEqual(["Cmd+T"]);
  });

  it("preserves empty combo arrays (unbound overrides)", () => {
    const result = importProfile(makeProfileJson({ "terminal.new": [] }));
    expect(result.ok).toBe(true);
    expect(result.overrides["terminal.new"]).toEqual([]);
  });

  it("rejects profiles where overrides value is not an array", () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      app: "daintree",
      overrides: { "terminal.new": "Cmd+T" },
    });
    const result = importProfile(json);
    expect(result.ok).toBe(false);
  });

  it("round-trips through export → import with identical overrides", () => {
    const original: Record<string, string[]> = {
      "terminal.new": ["Cmd+T"],
      "app.settings": ["Cmd+,"],
      "panel.palette": ["Cmd+N"],
    };
    const json = exportProfile(original);
    const result = importProfile(json);
    expect(result.ok).toBe(true);
    expect(result.overrides).toEqual(original);
  });

  it("round-trips plugin-prefixed action IDs through export → import", () => {
    const original: Record<string, string[]> = {
      "plugin.example.run": ["Cmd+P"],
      "terminal.new": ["Cmd+T"],
    };
    const json = exportProfile(original);
    const result = importProfile(json);
    expect(result.ok).toBe(true);
    expect(result.overrides).toEqual(original);
  });
});
