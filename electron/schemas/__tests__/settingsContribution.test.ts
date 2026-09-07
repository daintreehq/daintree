import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

type SettingInput = Record<string, unknown>;

function parseSettings(settings: SettingInput[], origin: PluginOrigin = "user") {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.settings-test",
    version: "1.0.0",
    contributes: { settings },
  });
}

function settingsOf(result: ReturnType<typeof parseSettings>) {
  if (!result.success) throw new Error("expected manifest to parse");
  return result.data.contributes.settings ?? [];
}

describe("contributes.settings schema (#9301)", () => {
  it("accepts every field type", () => {
    const result = parseSettings([
      { id: "name", type: "string" },
      { id: "count", type: "number" },
      { id: "enabled", type: "boolean" },
      { id: "mode", type: "enum", options: ["a", "b"] },
      { id: "config", type: "json" },
      { id: "token", type: "secret" },
      { id: "dir", type: "directory" },
      { id: "loc", type: "path" },
      { id: "doc", type: "file" },
    ]);
    expect(result.success).toBe(true);
    expect(settingsOf(result).map((s) => s.id)).toEqual([
      "name",
      "count",
      "enabled",
      "mode",
      "config",
      "token",
      "dir",
      "loc",
      "doc",
    ]);
  });

  it("accepts a path/directory/file field with mustExist", () => {
    const result = parseSettings([
      { id: "store", type: "directory", mustExist: true },
      { id: "loc", type: "path", mustExist: false },
    ]);
    expect(result.success).toBe(true);
    expect(settingsOf(result)[0].mustExist).toBe(true);
  });

  it("accepts a file field with an extensions filter", () => {
    const result = parseSettings([{ id: "doc", type: "file", extensions: ["json", "md"] }]);
    expect(result.success).toBe(true);
    expect(settingsOf(result)[0].extensions).toEqual(["json", "md"]);
  });

  it("rejects extensions on a non-file type", () => {
    const result = parseSettings([{ id: "dir", type: "directory", extensions: ["json"] }]);
    expect(result.success).toBe(false);
  });

  it("rejects an empty extensions array", () => {
    const result = parseSettings([{ id: "doc", type: "file", extensions: [] }]);
    expect(result.success).toBe(false);
  });

  it("defaults scope to user when omitted", () => {
    const result = parseSettings([{ id: "name", type: "string" }]);
    expect(result.success).toBe(true);
    expect(settingsOf(result)[0].scope).toBe("user");
  });

  it("preserves an explicit project scope", () => {
    const result = parseSettings([{ id: "name", type: "string", scope: "project" }]);
    expect(settingsOf(result)[0].scope).toBe("project");
  });

  it("treats an omitted type as valid (renders as text)", () => {
    const result = parseSettings([{ id: "name" }]);
    expect(result.success).toBe(true);
    expect(settingsOf(result)[0].type).toBeUndefined();
  });

  it("coerces the legacy secret:true flag to type:secret", () => {
    const result = parseSettings([{ id: "token", secret: true }]);
    expect(result.success).toBe(true);
    expect(settingsOf(result)[0].type).toBe("secret");
  });

  it("rejects an enum without options", () => {
    const result = parseSettings([{ id: "mode", type: "enum" }]);
    expect(result.success).toBe(false);
  });

  it("rejects an enum with an empty options array", () => {
    const result = parseSettings([{ id: "mode", type: "enum", options: [] }]);
    expect(result.success).toBe(false);
  });

  it("accepts number min/max bounds", () => {
    const result = parseSettings([{ id: "count", type: "number", min: 0, max: 10 }]);
    expect(result.success).toBe(true);
    const def = settingsOf(result)[0];
    expect(def.min).toBe(0);
    expect(def.max).toBe(10);
  });

  it("rejects a number whose min exceeds max", () => {
    const result = parseSettings([{ id: "count", type: "number", min: 10, max: 0 }]);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field key (strict)", () => {
    const result = parseSettings([{ id: "name", type: "string", bogus: true }]);
    expect(result.success).toBe(false);
  });

  it("rejects a setting with no id", () => {
    const result = parseSettings([{ type: "string" }]);
    expect(result.success).toBe(false);
  });

  it("defaults contributes.settings to an empty array when absent", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.no-settings",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contributes.settings).toEqual([]);
  });
});
