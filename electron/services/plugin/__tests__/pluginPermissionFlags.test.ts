import { describe, it, expect } from "vitest";
import type { PluginCapability } from "../../../../shared/types/plugin.js";
import {
  buildPluginPermissionExecArgv,
  derivePluginPermissionCapabilities,
  isPluginPermissionModelSpikeEnabled,
  PLUGIN_PERMISSION_MODEL_SPIKE_ENV,
} from "../pluginPermissionFlags.js";

/** Extract the comma-separated payload of a single `--allow-fs-*=…` flag. */
function pathsOf(flags: string[], kind: "read" | "write"): string[] {
  const prefix = `--allow-fs-${kind}=`;
  const flag = flags.find((f) => f.startsWith(prefix));
  return flag ? flag.slice(prefix.length).split(",") : [];
}

describe("derivePluginPermissionCapabilities", () => {
  it("maps shell:exec onto --allow-child-process", () => {
    expect(derivePluginPermissionCapabilities(["shell:exec"]).allowChildProcess).toBe(true);
  });

  it("withholds child-process when shell:exec is absent", () => {
    const caps: PluginCapability[] = ["fs:project-read", "network:fetch"];
    expect(derivePluginPermissionCapabilities(caps).allowChildProcess).toBe(false);
  });

  it("always allows native addons (no capability distinguishes them)", () => {
    expect(derivePluginPermissionCapabilities([]).allowNativeAddons).toBe(true);
    expect(derivePluginPermissionCapabilities(["shell:exec"]).allowNativeAddons).toBe(true);
  });
});

describe("buildPluginPermissionExecArgv", () => {
  const base = { allowChildProcess: false, allowNativeAddons: false } as const;

  it("always engages the permission model as the first flag", () => {
    const flags = buildPluginPermissionExecArgv({ ...base, readPaths: [], writePaths: [] });
    expect(flags[0]).toBe("--permission");
  });

  it("emits no fs flags when there are no paths", () => {
    const flags = buildPluginPermissionExecArgv({ ...base, readPaths: [], writePaths: [] });
    expect(flags.some((f) => f.startsWith("--allow-fs-"))).toBe(false);
  });

  it("emits read paths under --allow-fs-read", () => {
    const flags = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["/a", "/b"],
      writePaths: [],
    });
    expect(pathsOf(flags, "read")).toEqual(["/a", "/b"]);
    expect(flags.some((f) => f.startsWith("--allow-fs-write"))).toBe(false);
  });

  it("also grants read for every write path (Node write does not imply read)", () => {
    const flags = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["/read-only"],
      writePaths: ["/writable"],
    });
    expect(pathsOf(flags, "read")).toEqual(["/read-only", "/writable"]);
    expect(pathsOf(flags, "write")).toEqual(["/writable"]);
  });

  it("dedupes and sorts paths for deterministic output regardless of input order", () => {
    const a = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["/z", "/a", "/z"],
      writePaths: ["/a"],
    });
    const b = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["/a", "/z"],
      writePaths: ["/a", "/a"],
    });
    expect(a).toEqual(b);
    expect(pathsOf(a, "read")).toEqual(["/a", "/z"]);
  });

  it("drops empty-string paths", () => {
    const flags = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["", "/real"],
      writePaths: [""],
    });
    expect(pathsOf(flags, "read")).toEqual(["/real"]);
    expect(flags.some((f) => f.startsWith("--allow-fs-write"))).toBe(false);
  });

  it("appends --allow-child-process and --allow-addons only when requested", () => {
    const none = buildPluginPermissionExecArgv({
      readPaths: [],
      writePaths: [],
      allowChildProcess: false,
      allowNativeAddons: false,
    });
    expect(none).not.toContain("--allow-child-process");
    expect(none).not.toContain("--allow-addons");

    const both = buildPluginPermissionExecArgv({
      readPaths: [],
      writePaths: [],
      allowChildProcess: true,
      allowNativeAddons: true,
    });
    expect(both).toContain("--allow-child-process");
    expect(both).toContain("--allow-addons");
  });
});

describe("isPluginPermissionModelSpikeEnabled", () => {
  it("is off for absent / empty / disabled values", () => {
    expect(isPluginPermissionModelSpikeEnabled({})).toBe(false);
    for (const value of ["", "0", "false"]) {
      expect(
        isPluginPermissionModelSpikeEnabled({ [PLUGIN_PERMISSION_MODEL_SPIKE_ENV]: value })
      ).toBe(false);
    }
  });

  it("is on for any other truthy value", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      expect(
        isPluginPermissionModelSpikeEnabled({ [PLUGIN_PERMISSION_MODEL_SPIKE_ENV]: value })
      ).toBe(true);
    }
  });
});
