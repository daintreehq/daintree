import { describe, it, expect } from "vitest";
import type { PluginCapability } from "../../../../shared/types/plugin.js";
import {
  buildPluginPermissionExecArgv,
  classifyPluginPermissionPaths,
  derivePluginPermissionCapabilities,
  isPluginPermissionModelSpikeEnabled,
  PLUGIN_PERMISSION_MODEL_SPIKE_ENV,
  type PluginPermissionRoot,
} from "../pluginPermissionFlags.js";

/** Collect the path payload of every `--allow-fs-<kind>=…` flag, in order. */
function pathsOf(flags: string[], kind: "read" | "write"): string[] {
  const prefix = `--allow-fs-${kind}=`;
  return flags.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
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

describe("classifyPluginPermissionPaths", () => {
  const projectRoot: PluginPermissionRoot = { path: "/proj", rootClass: "project" };
  const dataRoot: PluginPermissionRoot = { path: "/data", rootClass: "user-data" };

  it("always grants read on the bundle dir regardless of capabilities", () => {
    const { readPaths } = classifyPluginPermissionPaths([], [], "/bundle");
    expect(readPaths).toContain("/bundle");
  });

  it("gates project roots on fs:project-* capabilities", () => {
    const readOnly = classifyPluginPermissionPaths([projectRoot], ["fs:project-read"], "/bundle");
    expect(readOnly.readPaths).toContain("/proj");
    expect(readOnly.writePaths).not.toContain("/proj");

    const writeOnly = classifyPluginPermissionPaths([projectRoot], ["fs:project-write"], "/bundle");
    // Write-only must NOT imply read — mirrors the sanctioned host.fs boundary.
    expect(writeOnly.readPaths).not.toContain("/proj");
    expect(writeOnly.writePaths).toContain("/proj");
  });

  it("gates user-data roots (incl. the data dir) on fs:user-data-* capabilities", () => {
    const none = classifyPluginPermissionPaths([dataRoot], [], "/bundle");
    expect(none.readPaths).not.toContain("/data");
    expect(none.writePaths).not.toContain("/data");

    const both = classifyPluginPermissionPaths(
      [dataRoot],
      ["fs:user-data-read", "fs:user-data-write"],
      "/bundle"
    );
    expect(both.readPaths).toContain("/data");
    expect(both.writePaths).toContain("/data");
  });

  it("does not cross classes — a project cap never unlocks a user-data root", () => {
    const { readPaths, writePaths } = classifyPluginPermissionPaths(
      [dataRoot],
      ["fs:project-read", "fs:project-write"],
      "/bundle"
    );
    expect(readPaths).not.toContain("/data");
    expect(writePaths).not.toContain("/data");
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

  it("emits one repeated flag per read path (never comma-joined)", () => {
    const flags = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["/a", "/b"],
      writePaths: [],
    });
    expect(flags).toContain("--allow-fs-read=/a");
    expect(flags).toContain("--allow-fs-read=/b");
    // Comma-joining would grant neither path in Node's permission model.
    expect(flags.some((f) => f.includes(","))).toBe(false);
  });

  it("keeps read and write independent — a write path is not auto-readable", () => {
    const flags = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["/read-only"],
      writePaths: ["/writable"],
    });
    expect(pathsOf(flags, "read")).toEqual(["/read-only"]);
    expect(pathsOf(flags, "write")).toEqual(["/writable"]);
  });

  it("preserves a path that contains a comma as a single flag value", () => {
    const flags = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["/weird,dir"],
      writePaths: [],
    });
    expect(pathsOf(flags, "read")).toEqual(["/weird,dir"]);
  });

  it("dedupes and sorts paths for deterministic output regardless of input order", () => {
    const a = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["/z", "/a", "/z"],
      writePaths: [],
    });
    const b = buildPluginPermissionExecArgv({
      ...base,
      readPaths: ["/a", "/z"],
      writePaths: [],
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
