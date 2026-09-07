// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedPluginInfo } from "@shared/types/plugin";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

const logErrorMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({
  logError: logErrorMock,
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

function makePlugin(opts: {
  id: string;
  displayName?: string;
  devMode?: boolean;
  disabled?: boolean;
  /** Project-owned instance: `id` stays the manifest id, the key gets qualified. */
  projectId?: string;
}): LoadedPluginInfo {
  const projectId = opts.projectId ?? null;
  const instanceId = projectId === null ? opts.id : `project__${projectId}__${opts.id}`;
  return {
    instanceId,
    origin: projectId === null ? "global" : "project",
    projectId,
    manifest: {
      name: opts.id,
      version: "1.0.0",
      ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        commands: [],
        views: [],
        mcpServers: [],
        skills: [],
        keybindings: [],
        contextMenus: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        agents: [],
        processTools: [],
        recipes: [],
      },
    },
    dir: `/plugins/${opts.id}`,
    loadedAt: 1,
    isBuiltin: false,
    disabled: opts.disabled ?? false,
    pendingRestart: false,
    source: "sideload",
    installedAt: 1,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    updateAvailable: null,
    devMode: opts.devMode ?? false,
    pluginDanger: "safe",
    blocklisted: false,
  };
}

const listMock = vi.fn<() => Promise<LoadedPluginInfo[]>>();
const onProvenanceChangedMock = vi.fn<(cb: () => void) => () => void>();

function installBridge(plugin: Record<string, unknown>): void {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin },
  });
}

beforeEach(() => {
  _resetPluginRuntimeStoreForTest();
  logErrorMock.mockReset();
  listMock.mockReset();
  onProvenanceChangedMock.mockReset();
  onProvenanceChangedMock.mockReturnValue(() => {});
  installBridge({ list: listMock, onProvenanceChanged: onProvenanceChangedMock });
});

afterEach(() => {
  // Reset in afterEach too: a failed case would otherwise leak its provenance
  // listener into the next one.
  _resetPluginRuntimeStoreForTest();
});

describe("usePluginRuntimeStore", () => {
  it("keys a project plugin's metadata by its instance id, not its manifest name", async () => {
    // The regression in #12211: every contribution carries the instance key, so
    // a map keyed by manifest name never matched and the raw key was rendered.
    listMock.mockResolvedValue([
      makePlugin({
        id: "gregpriday.video-manager",
        displayName: "Video Manager",
        projectId: "b6700c7a",
      }),
    ]);

    usePluginRuntimeStore.getState().init();

    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(1));
    const state = usePluginRuntimeStore.getState();
    expect(state.pluginMetaById.get("project__b6700c7a__gregpriday.video-manager")).toEqual({
      devMode: false,
      displayName: "Video Manager",
    });
    // The bare manifest name is deliberately NOT a second key.
    expect(state.pluginMetaById.has("gregpriday.video-manager")).toBe(false);
  });

  it("falls back to the manifest id, never the instance key, when no displayName is declared", async () => {
    listMock.mockResolvedValue([
      makePlugin({ id: "gregpriday.video-manager", projectId: "b6700c7a" }),
    ]);

    usePluginRuntimeStore.getState().init();

    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(1));
    expect(
      usePluginRuntimeStore
        .getState()
        .pluginMetaById.get("project__b6700c7a__gregpriday.video-manager")?.displayName
    ).toBe("gregpriday.video-manager");
  });

  it("keeps a project plugin and an installed plugin sharing a manifest id apart", async () => {
    // The reason the map is single-keyed on the instance id rather than also
    // aliased by manifest name: both of these are `acme.tool`, and a bare alias
    // would let whichever came last overwrite the other's name and disabled
    // state (`ProjectPluginInfo.collidesWithGlobal` exists for this case).
    listMock.mockResolvedValue([
      makePlugin({ id: "acme.tool", displayName: "Acme Tool (installed)" }),
      makePlugin({
        id: "acme.tool",
        displayName: "Acme Tool (project)",
        projectId: "b6700c7a",
        disabled: true,
      }),
    ]);

    usePluginRuntimeStore.getState().init();

    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(2));
    const state = usePluginRuntimeStore.getState();
    expect(state.pluginMetaById.get("acme.tool")?.displayName).toBe("Acme Tool (installed)");
    expect(state.pluginMetaById.get("project__b6700c7a__acme.tool")?.displayName).toBe(
      "Acme Tool (project)"
    );
    // Only the project copy is disabled — the global one is untouched.
    expect(state.disabledPluginIds.has("project__b6700c7a__acme.tool")).toBe(true);
    expect(state.disabledPluginIds.has("acme.tool")).toBe(false);
  });

  it("keys the disabled set by instance id so two projects' copies stay separate", async () => {
    listMock.mockResolvedValue([
      makePlugin({ id: "acme.tool", projectId: "proj-a", disabled: true }),
      makePlugin({ id: "acme.tool", projectId: "proj-b" }),
    ]);

    usePluginRuntimeStore.getState().init();

    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(2));
    const state = usePluginRuntimeStore.getState();
    expect(state.disabledPluginIds.has("project__proj-a__acme.tool")).toBe(true);
    expect(state.disabledPluginIds.has("project__proj-b__acme.tool")).toBe(false);
  });

  it("derives the disabled set and per-plugin metadata from one snapshot", async () => {
    listMock.mockResolvedValue([
      makePlugin({ id: "acme.dev", displayName: "Acme Dev", devMode: true }),
      makePlugin({ id: "acme.off", displayName: "Acme Off", disabled: true }),
      makePlugin({ id: "acme.plain", displayName: "Acme Plain" }),
    ]);

    usePluginRuntimeStore.getState().init();

    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(3));
    const state = usePluginRuntimeStore.getState();
    expect([...state.disabledPluginIds]).toEqual(["acme.off"]);
    expect(state.pluginMetaById.get("acme.dev")).toEqual({
      devMode: true,
      displayName: "Acme Dev",
    });
    expect(state.pluginMetaById.get("acme.plain")?.devMode).toBe(false);
  });

  it("falls back to the plugin id when the manifest declares no display name", async () => {
    listMock.mockResolvedValue([makePlugin({ id: "acme.nameless" })]);

    usePluginRuntimeStore.getState().init();

    await vi.waitFor(() =>
      expect(usePluginRuntimeStore.getState().pluginMetaById.get("acme.nameless")).toBeDefined()
    );
    expect(usePluginRuntimeStore.getState().pluginMetaById.get("acme.nameless")?.displayName).toBe(
      "acme.nameless"
    );
  });

  it("treats a blank displayName as absent rather than rendering an empty name", async () => {
    // `displayName` is `z.string().optional()` with no min length, so a blank
    // one is a well-formed manifest that would otherwise name the plugin "".
    listMock.mockResolvedValue([
      makePlugin({ id: "acme.blank", displayName: "" }),
      makePlugin({ id: "acme.spaces", displayName: "   " }),
    ]);

    usePluginRuntimeStore.getState().init();

    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(2));
    const state = usePluginRuntimeStore.getState();
    expect(state.pluginMetaById.get("acme.blank")?.displayName).toBe("acme.blank");
    expect(state.pluginMetaById.get("acme.spaces")?.displayName).toBe("acme.spaces");
  });

  it("re-pulls on a provenance change and drops metadata for removed plugins", async () => {
    let fire: (() => void) | undefined;
    onProvenanceChangedMock.mockImplementation((cb) => {
      fire = cb;
      return () => {};
    });
    listMock.mockResolvedValueOnce([makePlugin({ id: "acme.a" }), makePlugin({ id: "acme.b" })]);

    usePluginRuntimeStore.getState().init();
    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(2));

    listMock.mockResolvedValueOnce([makePlugin({ id: "acme.a", devMode: true })]);
    fire?.();

    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(1));
    const state = usePluginRuntimeStore.getState();
    expect(state.pluginMetaById.has("acme.b")).toBe(false);
    expect(state.pluginMetaById.get("acme.a")?.devMode).toBe(true);
  });

  it("ignores a stale in-flight response that resolves after a newer pull", async () => {
    let resolveFirst: ((v: LoadedPluginInfo[]) => void) | undefined;
    let resolveSecond: ((v: LoadedPluginInfo[]) => void) | undefined;
    listMock
      .mockReturnValueOnce(
        new Promise<LoadedPluginInfo[]>((r) => {
          resolveFirst = r;
        })
      )
      .mockReturnValueOnce(
        new Promise<LoadedPluginInfo[]>((r) => {
          resolveSecond = r;
        })
      );
    let fire: (() => void) | undefined;
    onProvenanceChangedMock.mockImplementation((cb) => {
      fire = cb;
      return () => {};
    });

    usePluginRuntimeStore.getState().init(); // pull 1
    fire?.(); // pull 2 — supersedes pull 1

    resolveSecond?.([makePlugin({ id: "acme.fresh", devMode: true })]);
    await vi.waitFor(() =>
      expect(usePluginRuntimeStore.getState().pluginMetaById.has("acme.fresh")).toBe(true)
    );

    // The superseded pull lands last; its snapshot must not roll the store back.
    resolveFirst?.([makePlugin({ id: "acme.stale", disabled: true })]);
    await Promise.resolve();
    await Promise.resolve();

    const state = usePluginRuntimeStore.getState();
    expect(state.pluginMetaById.has("acme.stale")).toBe(false);
    expect(state.pluginMetaById.has("acme.fresh")).toBe(true);
    // Both collections ride the same guard — checking only the metadata map
    // would still pass if a stale response could commit the disabled set.
    expect(state.disabledPluginIds.has("acme.stale")).toBe(false);
  });

  // Staleness is judged on what committed, not what started. React Strict Mode
  // replays mount effects, so same-tick pull pairs are routine — if the second
  // rejects, the first must still be allowed to land.
  it("keeps an in-flight snapshot that resolves after a newer pull rejected", async () => {
    let resolveFirst: ((v: LoadedPluginInfo[]) => void) | undefined;
    listMock
      .mockReturnValueOnce(
        new Promise<LoadedPluginInfo[]>((r) => {
          resolveFirst = r;
        })
      )
      .mockRejectedValueOnce(new Error("bridge down"));

    usePluginRuntimeStore.getState().refresh(); // pull 1 — succeeds, but slowly
    usePluginRuntimeStore.getState().refresh(); // pull 2 — supersedes, then fails

    await vi.waitFor(() => expect(logErrorMock).toHaveBeenCalled());
    resolveFirst?.([makePlugin({ id: "acme.a", devMode: true })]);

    await vi.waitFor(() =>
      expect(usePluginRuntimeStore.getState().pluginMetaById.get("acme.a")?.devMode).toBe(true)
    );
  });

  it("pulls and subscribes once across repeated init calls", async () => {
    listMock.mockResolvedValue([]);

    usePluginRuntimeStore.getState().init();
    usePluginRuntimeStore.getState().init();
    usePluginRuntimeStore.getState().init();

    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(onProvenanceChangedMock).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the plugin bridge is only partially stubbed", () => {
    installBridge({});

    expect(() => usePluginRuntimeStore.getState().init()).not.toThrow();
    expect(() => usePluginRuntimeStore.getState().refresh()).not.toThrow();
    expect(listMock).not.toHaveBeenCalled();
    expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(0);
  });

  // `daintree-plugin dev` attaches a plugin without broadcasting provenance, so
  // a store already initialized by some earlier consumer would never learn the
  // dev plugin's devMode and would redact its author's own stack forever. This
  // is the escape hatch for exactly that (#11207) — it must pull even though
  // the one-shot init() has already run.
  it("pulls on refresh even once initialized, picking up a plugin that never announced itself", async () => {
    listMock.mockResolvedValueOnce([makePlugin({ id: "acme.installed" })]);

    usePluginRuntimeStore.getState().init();
    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(1));

    // The dev plugin attaches now — no provenance event fires for it.
    listMock.mockResolvedValueOnce([
      makePlugin({ id: "acme.installed" }),
      makePlugin({ id: "acme.dev", displayName: "Acme Dev", devMode: true }),
    ]);
    usePluginRuntimeStore.getState().refresh();

    await vi.waitFor(() =>
      expect(usePluginRuntimeStore.getState().pluginMetaById.get("acme.dev")?.devMode).toBe(true)
    );
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  // refresh() subscribes on its own rather than leaning on a separate init()
  // call: two pulls in one tick would make `pullSeq` discard the first, so a
  // rejected second pull would throw away the only successful snapshot.
  it("subscribes and pulls exactly once when refresh is the first caller", async () => {
    listMock.mockResolvedValue([makePlugin({ id: "acme.a", devMode: true })]);

    usePluginRuntimeStore.getState().refresh();

    await vi.waitFor(() =>
      expect(usePluginRuntimeStore.getState().pluginMetaById.get("acme.a")?.devMode).toBe(true)
    );
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(onProvenanceChangedMock).toHaveBeenCalledTimes(1);

    // A later init() must not re-subscribe or re-pull on top of it.
    usePluginRuntimeStore.getState().init();
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(onProvenanceChangedMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good snapshot when a later pull rejects", async () => {
    let fire: (() => void) | undefined;
    onProvenanceChangedMock.mockImplementation((cb) => {
      fire = cb;
      return () => {};
    });
    listMock.mockResolvedValueOnce([
      makePlugin({ id: "acme.a", displayName: "Acme A", disabled: true, devMode: true }),
    ]);

    usePluginRuntimeStore.getState().init();
    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(1));

    // Starting from a populated store, not an empty one: asserting "still
    // empty" after a rejection would also pass if a transient failure wiped a
    // good snapshot.
    listMock.mockRejectedValueOnce(new Error("bridge down"));
    fire?.();

    await vi.waitFor(() => expect(logErrorMock).toHaveBeenCalled());
    const state = usePluginRuntimeStore.getState();
    expect(state.pluginMetaById.get("acme.a")).toEqual({ devMode: true, displayName: "Acme A" });
    expect(state.disabledPluginIds.has("acme.a")).toBe(true);
  });

  it("unsubscribes and clears every collection on test reset", async () => {
    const unsub = vi.fn();
    onProvenanceChangedMock.mockReturnValue(unsub);
    listMock.mockResolvedValue([makePlugin({ id: "acme.a", disabled: true, devMode: true })]);

    usePluginRuntimeStore.getState().init();
    await vi.waitFor(() => expect(usePluginRuntimeStore.getState().pluginMetaById.size).toBe(1));

    _resetPluginRuntimeStoreForTest();

    expect(unsub).toHaveBeenCalledTimes(1);
    const state = usePluginRuntimeStore.getState();
    expect(state.pluginMetaById.size).toBe(0);
    expect(state.disabledPluginIds.size).toBe(0);
  });
});
