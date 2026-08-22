import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  BUILT_IN_PANEL_KINDS,
  getPanelKindColor,
  getPanelKindConfig,
  getExtensionFallbackDefaults,
  getPanelKindIds,
  getPluginPanelKinds,
  onPanelKindRegistered,
  onPanelKindUnregistered,
  panelKindUsesTerminalUi,
  panelKindIsDockable,
  normalizeDockLocation,
  normalizeGroupDockLocation,
  registerPanelKind,
  unregisterPanelKind,
  unregisterPluginPanelKinds,
  clearPanelKindRegistry,
  subscribeToPanelKindRegistry,
  getPanelKindRegistrySnapshot,
  getBuiltInPanelKinds,
  getFirstRenderSeeds,
  getFirstRenderPreloadSeeds,
  FIRST_RENDER_ROOT_SEED,
  type PanelKindConfig,
} from "../panelKindRegistry.js";

describe("panelKindRegistry metadata", () => {
  it("extension fallback returns empty object", () => {
    const result = getExtensionFallbackDefaults();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("dev-preview does not use terminal UI", () => {
    expect(panelKindUsesTerminalUi("dev-preview")).toBe(false);
  });

  it("terminal uses terminal UI", () => {
    expect(panelKindUsesTerminalUi("terminal")).toBe(true);
  });

  it("browser does not use terminal UI", () => {
    expect(panelKindUsesTerminalUi("browser")).toBe(false);
  });

  it('legacy "agent" kind is unregistered (collapsed into terminal)', () => {
    expect(getPanelKindConfig("agent")).toBeUndefined();
  });

  it("returns config for all built-in kinds", () => {
    for (const kind of ["terminal", "browser", "dev-preview"]) {
      const config = getPanelKindConfig(kind);
      expect(config).toBeDefined();
      expect(config!.id).toBe(kind);
    }
  });

  it("returns undefined for unknown kind", () => {
    expect(getPanelKindConfig("unknown-kind")).toBeUndefined();
  });
});

describe("getBuiltInPanelKinds", () => {
  it("returns every built-in kind", () => {
    expect(getBuiltInPanelKinds().sort()).toEqual([...BUILT_IN_PANEL_KINDS].sort());
  });

  it("returns a fresh array — mutations do not leak into the SSOT", () => {
    const first = getBuiltInPanelKinds();
    first.length = 0;
    expect(getBuiltInPanelKinds()).toEqual([...BUILT_IN_PANEL_KINDS]);
  });

  // Structural invariant: the BUILT_IN_PANEL_KINDS SSOT must match every
  // entry in PANEL_KIND_REGISTRY that has no extensionId. If they ever drift,
  // isBuiltInPanelKind disagrees with the actual registry contents.
  it("matches the no-extensionId entries of PANEL_KIND_REGISTRY", () => {
    const registryBuiltIns = getPanelKindIds()
      .filter((id) => getPanelKindConfig(id)?.extensionId === undefined)
      .sort();
    expect(registryBuiltIns).toEqual([...BUILT_IN_PANEL_KINDS].sort());
  });
});

const BUILT_IN_KINDS = BUILT_IN_PANEL_KINDS;

const makeExtensionConfig = (id: string, extensionId: string): PanelKindConfig => ({
  id,
  name: `${extensionId}:${id}`,
  iconId: "puzzle",
  color: "#123456",
  hasPty: false,
  canRestart: false,
  canConvert: false,
  extensionId,
});

describe("unregisterPluginPanelKinds", () => {
  // Use afterEach so cleanup still runs when a test fails.
  afterEach(() => {
    unregisterPluginPanelKinds("ext-a");
    unregisterPluginPanelKinds("ext-b");
  });

  it("removes only entries owned by the target plugin", () => {
    registerPanelKind(makeExtensionConfig("ext-a.one", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-a.two", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.three", "ext-b"));

    unregisterPluginPanelKinds("ext-a");

    expect(getPanelKindConfig("ext-a.one")).toBeUndefined();
    expect(getPanelKindConfig("ext-a.two")).toBeUndefined();
    expect(getPanelKindConfig("ext-b.three")?.extensionId).toBe("ext-b");
  });

  it("never removes built-in panel kinds", () => {
    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));

    // Calling with any plugin ID (even matching no entries, empty string, or
    // a typecast undefined) must preserve built-ins. The input guard blocks the
    // dangerous `undefined` case where built-ins' extensionId is also undefined.
    unregisterPluginPanelKinds("ext-a");
    unregisterPluginPanelKinds("never-loaded");
    unregisterPluginPanelKinds("");
    unregisterPluginPanelKinds(undefined as unknown as string);

    for (const kind of BUILT_IN_KINDS) {
      const config = getPanelKindConfig(kind);
      expect(config, `built-in panel kind "${kind}" must survive unregister`).toBeDefined();
      expect(config!.id).toBe(kind);
      expect(config!.extensionId).toBeUndefined();
    }
  });

  it("is a no-op when unregistering an unknown pluginId", () => {
    const before = getPanelKindIds().length;
    expect(() => unregisterPluginPanelKinds("never-loaded")).not.toThrow();
    expect(getPanelKindIds()).toHaveLength(before);
  });

  it("is a no-op when unregistering the same plugin twice", () => {
    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    unregisterPluginPanelKinds("ext-a");
    expect(() => unregisterPluginPanelKinds("ext-a")).not.toThrow();
    expect(getPanelKindConfig("ext-a.viewer")).toBeUndefined();
  });

  it("supports register → unregister → re-register round-trip", () => {
    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    unregisterPluginPanelKinds("ext-a");
    expect(getPanelKindConfig("ext-a.viewer")).toBeUndefined();

    registerPanelKind({ ...makeExtensionConfig("ext-a.viewer", "ext-a"), name: "Refreshed" });
    expect(getPanelKindConfig("ext-a.viewer")?.name).toBe("Refreshed");
  });

  it("leaves other plugins' entries intact when one plugin is unregistered", () => {
    registerPanelKind(makeExtensionConfig("ext-a.panel", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.panel", "ext-b"));

    unregisterPluginPanelKinds("ext-a");

    expect(getPanelKindConfig("ext-a.panel")).toBeUndefined();
    expect(getPanelKindConfig("ext-b.panel")?.extensionId).toBe("ext-b");
  });
});

describe("clearPanelKindRegistry", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("removes extension-contributed panel kinds", () => {
    registerPanelKind({
      id: "ext-plugin.viewer",
      name: "Viewer",
      iconId: "eye",
      color: "#ff0000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "ext-plugin",
    });
    expect(getPanelKindConfig("ext-plugin.viewer")).toBeDefined();

    clearPanelKindRegistry();

    expect(getPanelKindConfig("ext-plugin.viewer")).toBeUndefined();
  });

  it("preserves all built-in panel kinds", () => {
    registerPanelKind({
      id: "ext-plugin.tmp",
      name: "Tmp",
      iconId: "eye",
      color: "#000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "ext-plugin",
    });

    clearPanelKindRegistry();

    for (const kind of getBuiltInPanelKinds()) {
      const config = getPanelKindConfig(kind);
      expect(config).toBeDefined();
      expect(config!.id).toBe(kind);
    }
  });

  it("is a no-op when no extension entries are registered", () => {
    expect(() => clearPanelKindRegistry()).not.toThrow();
    for (const kind of getBuiltInPanelKinds()) {
      expect(getPanelKindConfig(kind)).toBeDefined();
    }
  });
});

describe("getPluginPanelKinds", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("returns only entries with an extensionId", () => {
    expect(getPluginPanelKinds()).toEqual([]);

    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.viewer", "ext-b"));

    const kinds = getPluginPanelKinds();
    expect(kinds.map((k) => k.id).sort()).toEqual(["ext-a.viewer", "ext-b.viewer"]);
    for (const kind of kinds) {
      expect(kind.extensionId).toBeDefined();
    }
  });

  it("never returns built-in kinds even when no plugins are registered", () => {
    expect(getPluginPanelKinds()).toEqual([]);
    for (const builtIn of BUILT_IN_KINDS) {
      expect(getPluginPanelKinds().some((k) => k.id === builtIn)).toBe(false);
    }
  });
});

describe("registry event listeners", () => {
  let unsubscribers: Array<() => void> = [];

  beforeEach(() => {
    unsubscribers = [];
  });

  afterEach(() => {
    for (const off of unsubscribers) off();
    unsubscribers = [];
    clearPanelKindRegistry();
  });

  it("onPanelKindRegistered fires for plugin kinds", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindRegistered(listener));

    const config = makeExtensionConfig("ext-a.viewer", "ext-a");
    registerPanelKind(config);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(config);
  });

  it("onPanelKindRegistered does NOT fire for re-registering a built-in", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindRegistered(listener));

    // Re-register the terminal built-in (no extensionId) — must not emit
    registerPanelKind({
      id: "terminal",
      name: "Terminal",
      iconId: "terminal",
      color: "#fff",
      hasPty: true,
      canRestart: true,
      canConvert: true,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("onPanelKindUnregistered fires once per removed kind", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindUnregistered(listener));

    registerPanelKind(makeExtensionConfig("ext-a.one", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-a.two", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.three", "ext-b"));

    unregisterPluginPanelKinds("ext-a");

    expect(listener).toHaveBeenCalledTimes(2);
    const calledIds = listener.mock.calls.map((call) => call[0]).sort();
    expect(calledIds).toEqual(["ext-a.one", "ext-a.two"]);
  });

  it("onPanelKindUnregistered does not fire when no kinds are removed", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindUnregistered(listener));

    unregisterPluginPanelKinds("never-loaded");

    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const listener = vi.fn();
    const unsubscribe = onPanelKindRegistered(listener);
    unsubscribe();

    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));

    expect(listener).not.toHaveBeenCalled();
  });

  it("double-unsubscribe is safe", () => {
    const listener = vi.fn();
    const unsubscribe = onPanelKindRegistered(listener);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it("clearPanelKindRegistry fires unregister listeners for removed plugin kinds", () => {
    const listener = vi.fn();
    unsubscribers.push(onPanelKindUnregistered(listener));

    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-b.viewer", "ext-b"));

    clearPanelKindRegistry();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("a listener that throws does not block other listeners", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwingListener = vi.fn(() => {
      throw new Error("boom");
    });
    const goodListener = vi.fn();
    unsubscribers.push(onPanelKindRegistered(throwingListener));
    unsubscribers.push(onPanelKindRegistered(goodListener));

    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));

    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(goodListener).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("registerPanelKind collision guard", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("refuses to overwrite a built-in with a plugin config", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = vi.fn();
    const unsubscribe = onPanelKindRegistered(listener);

    const original = getPanelKindConfig("terminal");
    expect(original?.extensionId).toBeUndefined();

    registerPanelKind({
      id: "terminal",
      name: "Hijacked",
      iconId: "skull",
      color: "#ff0000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "evil-plugin",
    });

    const after = getPanelKindConfig("terminal");
    expect(after).toBe(original);
    expect(after?.name).toBe(original?.name);
    expect(after?.iconId).toBe(original?.iconId);
    expect(after?.color).toBe(original?.color);
    expect(after?.hasPty).toBe(original?.hasPty);
    expect(after?.canRestart).toBe(original?.canRestart);
    expect(after?.showInPalette).toBe(original?.showInPalette);
    expect(after?.extensionId).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    errorSpy.mockRestore();
  });

  it("allows built-in re-registration (init hook re-patching)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = vi.fn();
    const unsubscribe = onPanelKindRegistered(listener);

    registerPanelKind({
      id: "terminal",
      name: "Terminal",
      iconId: "terminal",
      color: "#000",
      hasPty: true,
      canRestart: true,
      canConvert: true,
    });

    expect(getPanelKindConfig("terminal")?.extensionId).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    errorSpy.mockRestore();
  });

  it("allows a plugin to re-register its own kind (reconciliation)", () => {
    const listener = vi.fn();
    const unsubscribe = onPanelKindRegistered(listener);

    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    registerPanelKind({ ...makeExtensionConfig("ext-a.viewer", "ext-a"), name: "Updated" });

    expect(getPanelKindConfig("ext-a.viewer")?.name).toBe("Updated");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});

describe("getPanelKindColor fallback", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("returns built-in brand color for known kinds", () => {
    const terminal = getPanelKindColor("terminal");
    expect(terminal).toBeDefined();
    expect(terminal).toBe(getPanelKindConfig("terminal")?.color);
  });

  it("returns a neutral text token for unrecognized kinds", () => {
    expect(getPanelKindColor("totally-unknown-kind")).toBe("var(--theme-text-secondary)");
  });

  it("returns the neutral fallback after a plugin kind is unregistered", () => {
    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    expect(getPanelKindColor("ext-a.viewer")).toBe("#123456");

    unregisterPluginPanelKinds("ext-a");
    expect(getPanelKindColor("ext-a.viewer")).toBe("var(--theme-text-secondary)");
  });
});

describe("getFirstRenderSeeds", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("returns the lazy import paths of every first-render built-in kind", () => {
    expect([...getFirstRenderSeeds()].sort()).toEqual([
      "src/components/Browser/BrowserPane.tsx",
      "src/components/DevPreview/DevPreviewPane.tsx",
      "src/panels/diff/DiffPane.tsx",
      "src/panels/file-browser/FileBrowserPane.tsx",
      "src/panels/file/FilePane.tsx",
      "src/panels/review/ReviewPane.tsx",
    ]);
  });

  it("includes the review pane — the seed that previously drifted (#8895)", () => {
    expect(getFirstRenderSeeds()).toContain("src/panels/review/ReviewPane.tsx");
  });

  it("emits no empty or non-string seeds", () => {
    for (const seed of getFirstRenderSeeds()) {
      expect(typeof seed).toBe("string");
      expect(seed.length).toBeGreaterThan(0);
    }
  });

  it("excludes the eager terminal kind (no lazy first-render chunk)", () => {
    expect(getFirstRenderSeeds()).not.toContain(getPanelKindConfig("terminal")?.id);
    // Terminal has no lazyImportPath, so its path can't appear regardless.
    expect(getPanelKindConfig("terminal")?.firstRenderRestore).toBeUndefined();
  });

  it("excludes plugin-registered kinds even when they set firstRenderRestore", () => {
    registerPanelKind({
      ...makeExtensionConfig("ext-a.lazy", "ext-a"),
      firstRenderRestore: true,
      lazyImportPath: "src/plugins/ext-a/LazyPane.tsx",
    });
    expect(getFirstRenderSeeds()).not.toContain("src/plugins/ext-a/LazyPane.tsx");
  });

  it("throws when a built-in sets firstRenderRestore without a lazyImportPath", () => {
    // clearPanelKindRegistry only removes extension entries, so overwriting a
    // built-in would corrupt state for sibling tests — save and restore it.
    const original = getPanelKindConfig("browser") as PanelKindConfig;
    const { lazyImportPath: _omitted, ...broken } = original;
    try {
      registerPanelKind(broken);
      expect(() => getFirstRenderSeeds()).toThrow(/lazyImportPath/);
    } finally {
      registerPanelKind(original);
    }
  });
});

describe("getFirstRenderPreloadSeeds", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("is the panel seeds plus the app root, without dropping or duplicating any seed", () => {
    const panelSeeds = getFirstRenderSeeds();
    const preloadSeeds = getFirstRenderPreloadSeeds();
    // Superset relationship: every panel seed survives, and exactly one extra
    // entry (the app root) is added — so the preload/budget closure can't silently
    // drop a panel chunk or balloon beyond the root.
    expect(preloadSeeds).toEqual(expect.arrayContaining(panelSeeds));
    expect(preloadSeeds).toContain(FIRST_RENDER_ROOT_SEED);
    expect(preloadSeeds).toHaveLength(panelSeeds.length + 1);
    expect(new Set(preloadSeeds).size).toBe(preloadSeeds.length);
  });

  it("does not leak the app root back into the registry's own seed contract", () => {
    // getFirstRenderSeeds stays panel-only; the app root lives solely in the
    // combined accessor so the registry contract test above keeps its exact shape.
    expect(getFirstRenderSeeds()).not.toContain(FIRST_RENDER_ROOT_SEED);
  });
});

describe("panelKindIsDockable", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("registered kinds are dockable by default (opt-out model)", () => {
    // PTY terminal and the non-PTY reading surfaces carry no `dockable` flag —
    // the default is dockable, not the old opt-in.
    expect(panelKindIsDockable("terminal")).toBe(true);
    expect(panelKindIsDockable("file")).toBe(true);
    expect(panelKindIsDockable("browser")).toBe(true);
    expect(panelKindIsDockable("file-browser")).toBe(true);
  });

  it("the three built-ins that opt out are not dockable", () => {
    for (const kind of ["dev-preview", "review", "diff"]) {
      expect(panelKindIsDockable(kind), `${kind} opts out via dockable:false`).toBe(false);
    }
  });

  it("a plugin kind without an explicit flag is dockable", () => {
    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    expect(panelKindIsDockable("ext-a.viewer")).toBe(true);
  });

  it("a plugin kind that declares dockable:false opts out", () => {
    registerPanelKind({ ...makeExtensionConfig("ext-a.viewer", "ext-a"), dockable: false });
    expect(panelKindIsDockable("ext-a.viewer")).toBe(false);
  });

  it("an explicit dockable:false wins even for a PTY kind", () => {
    // Predicate contract only: `hasPty` no longer forces dockability, so the
    // implementation must be `dockable !== false`, not `hasPty || …`. (At the
    // store boundary a spawned PTY panel collapses to kind `terminal`, so this
    // combination can't describe a live panel — this pins the pure function.)
    registerPanelKind({
      ...makeExtensionConfig("ext-a.pty", "ext-a"),
      hasPty: true,
      dockable: false,
    });
    expect(panelKindIsDockable("ext-a.pty")).toBe(false);
  });

  it("unknown kinds are not dockable", () => {
    expect(panelKindIsDockable("no-such-kind")).toBe(false);
  });
});

describe("normalizeDockLocation", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("passes a dock location through for a dockable kind", () => {
    expect(normalizeDockLocation("terminal", "dock")).toBe("dock");
    expect(normalizeDockLocation("browser", "dock")).toBe("dock");
  });

  it("redirects a dock location to grid for a non-dockable built-in", () => {
    expect(normalizeDockLocation("review", "dock")).toBe("grid");
    expect(normalizeDockLocation("diff", "dock")).toBe("grid");
  });

  it("redirects a dock location to grid for an unknown kind", () => {
    // An unregistered kind is never dockable — a dock request would strand it.
    expect(normalizeDockLocation("no-such-kind", "dock")).toBe("grid");
  });

  it("treats a missing kind as the always-dockable legacy terminal", () => {
    expect(normalizeDockLocation(undefined, "dock")).toBe("dock");
  });

  it("leaves non-dock locations untouched regardless of dockability", () => {
    for (const location of ["grid", "overlay", "trash", "background", "dialog"] as const) {
      expect(normalizeDockLocation("review", location)).toBe(location);
      expect(normalizeDockLocation("terminal", location)).toBe(location);
    }
  });

  it("follows a live dockable flip", () => {
    registerPanelKind({ ...makeExtensionConfig("ext-a.viewer", "ext-a"), dockable: true });
    expect(normalizeDockLocation("ext-a.viewer", "dock")).toBe("dock");
    registerPanelKind({ ...makeExtensionConfig("ext-a.viewer", "ext-a"), dockable: false });
    expect(normalizeDockLocation("ext-a.viewer", "dock")).toBe("grid");
  });
});

describe("normalizeGroupDockLocation", () => {
  it("keeps a dock target only when every member is dockable", () => {
    expect(normalizeGroupDockLocation(["terminal", "browser", "file"], "dock")).toBe("dock");
  });

  it("rescues the whole group to grid when any member is non-dockable", () => {
    // All-or-nothing: one non-dockable sibling redirects the entire group.
    expect(normalizeGroupDockLocation(["terminal", "review"], "dock")).toBe("grid");
    expect(normalizeGroupDockLocation(["diff", "terminal"], "dock")).toBe("grid");
  });

  it("treats an unknown or missing member kind as non-dockable (grid)", () => {
    expect(normalizeGroupDockLocation(["terminal", "no-such-kind"], "dock")).toBe("grid");
    expect(normalizeGroupDockLocation(["terminal", undefined], "dock")).toBe("dock");
  });

  it("passes a grid target through unchanged", () => {
    expect(normalizeGroupDockLocation(["review", "diff"], "grid")).toBe("grid");
  });

  it("an empty group trivially satisfies the dock target", () => {
    expect(normalizeGroupDockLocation([], "dock")).toBe("dock");
  });
});

describe("panel kind registry external store", () => {
  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("getSnapshot returns a stable reference until a mutation", () => {
    const first = getPanelKindRegistrySnapshot();
    expect(getPanelKindRegistrySnapshot()).toBe(first);
  });

  it("replaces the snapshot reference on register", () => {
    const before = getPanelKindRegistrySnapshot();
    registerPanelKind(makeExtensionConfig("ext-a.viewer", "ext-a"));
    const after = getPanelKindRegistrySnapshot();
    expect(after).not.toBe(before);
    expect(after["ext-a.viewer"]).toBeDefined();
  });

  it("notifies subscribers on register, flip, and unregister", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPanelKindRegistry(listener);

    registerPanelKind({ ...makeExtensionConfig("ext-a.viewer", "ext-a"), dockable: true });
    expect(listener).toHaveBeenCalledTimes(1);

    // A dockable-only flip re-registers the same id and must still notify.
    registerPanelKind({ ...makeExtensionConfig("ext-a.viewer", "ext-a"), dockable: false });
    expect(listener).toHaveBeenCalledTimes(2);

    unregisterPanelKind("ext-a.viewer");
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    registerPanelKind(makeExtensionConfig("ext-b.viewer", "ext-b"));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("emits once per batch unregister, not once per removed kind", () => {
    registerPanelKind(makeExtensionConfig("ext-a.one", "ext-a"));
    registerPanelKind(makeExtensionConfig("ext-a.two", "ext-a"));
    const listener = vi.fn();
    const unsubscribe = subscribeToPanelKindRegistry(listener);
    unregisterPluginPanelKinds("ext-a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not notify when a batch unregister removes nothing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPanelKindRegistry(listener);
    unregisterPluginPanelKinds("never-loaded");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
