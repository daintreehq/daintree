import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import os from "os";

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProject: vi.fn((): { path: string } | null => null),
  getProjectById: vi.fn((_id: string): { path: string } | null => null),
}));

vi.mock("../../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const { PluginSettingsManager } = await import("../PluginSettingsManager.js");

const PLUGIN_ID = "acme.settings-target";
const PLUGINS_ROOT = path.join(os.tmpdir(), "daintree-settings-target", "plugins");

function managerFor(): InstanceType<typeof PluginSettingsManager> {
  return new PluginSettingsManager({
    getPluginsRoot: () => PLUGINS_ROOT,
    getManifest: () => undefined,
  });
}

function projectSettingsFile(root: string): string {
  return path.join(root, ".daintree", "plugin-settings", `${PLUGIN_ID}.json`);
}

beforeEach(() => {
  projectStoreMock.getCurrentProject.mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PluginSettingsManager explicit project root", () => {
  it("resolves the supplied root and never consults the active project", () => {
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/active" });
    const mgr = managerFor();

    expect(mgr.resolveSettingsFilePath(PLUGIN_ID, "project", "/projects/bound")).toBe(
      projectSettingsFile("/projects/bound")
    );
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
  });

  it("does not track project switches once a root is supplied", () => {
    const mgr = managerFor();
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/a" });
    const first = mgr.resolveSettingsFilePath(PLUGIN_ID, "project", "/projects/bound");

    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/b" });
    expect(mgr.resolveSettingsFilePath(PLUGIN_ID, "project", "/projects/bound")).toBe(first);
  });

  it("still resolves the active project at call time when no root is supplied", () => {
    const mgr = managerFor();
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/a" });
    expect(mgr.resolveSettingsFilePath(PLUGIN_ID, "project")).toBe(
      projectSettingsFile("/projects/a")
    );

    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/b" });
    expect(mgr.resolveSettingsFilePath(PLUGIN_ID, "project")).toBe(
      projectSettingsFile("/projects/b")
    );
    expect(mgr.resolveSettingsFilePath(PLUGIN_ID, "project", null)).toBe(
      projectSettingsFile("/projects/b")
    );
  });

  it("fails closed on a supplied-but-empty root rather than falling back to the active project", () => {
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/active" });
    const mgr = managerFor();
    expect(mgr.resolveSettingsFilePath(PLUGIN_ID, "project", "")).toBeUndefined();
  });

  it("ignores the supplied root for user scope", () => {
    const mgr = managerFor();
    expect(mgr.resolveSettingsFilePath(PLUGIN_ID, "user", "/projects/bound")).toBe(
      path.join(path.dirname(PLUGINS_ROOT), "plugin-settings", `${PLUGIN_ID}.json`)
    );
  });

  it("gives two bound projects two stores and reuses one per root", () => {
    const mgr = managerFor();
    const a = mgr.resolveSettingsFilePath(PLUGIN_ID, "project", "/projects/a")!;
    const b = mgr.resolveSettingsFilePath(PLUGIN_ID, "project", "/projects/b")!;

    const storeA = mgr.getOrCreateSettingsStore(PLUGIN_ID, "project", a);
    const storeB = mgr.getOrCreateSettingsStore(PLUGIN_ID, "project", b);
    expect(storeB).not.toBe(storeA);
    expect(mgr.getOrCreateSettingsStore(PLUGIN_ID, "project", a)).toBe(storeA);
  });
});
