import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetProjectPluginStoreForTesting,
  hasBlockedProjectPlugins,
  stagedProjectPlugins,
  useProjectPluginStore,
} from "../projectPluginStore";
import type {
  ProjectPluginInfo,
  ProjectPluginState,
  ProjectPluginTrustState,
} from "@shared/types/plugin";

const PROJECT = "proj-a";
const OTHER = "proj-b";

const setProjectPluginTrust = vi.fn<(decision: string) => Promise<void>>();
const activateStagedProjectPlugin = vi.fn<(pluginId: string) => Promise<void>>();
const reloadProjectPlugins = vi.fn<() => Promise<void>>();
const setProjectPluginMuted = vi.fn<(pluginId: string, muted: boolean) => Promise<void>>();
const setProjectPluginVisibility =
  vi.fn<(pluginId: string, visible: boolean | null) => Promise<void>>();
const setPluginVisibilityDefault = vi.fn<(pluginId: string, hidden: boolean) => Promise<void>>();
const getProjectPluginVisibility = vi.fn<() => Promise<unknown>>();

function plugin(id: string, state: ProjectPluginState): ProjectPluginInfo {
  return {
    projectId: PROJECT,
    id,
    displayName: id,
    version: "1.0.0",
    capabilities: [],
    dirName: id,
    state,
    muted: false,
    collidesWithGlobal: false,
  };
}

function trust(overrides: Partial<ProjectPluginTrustState> = {}): ProjectPluginTrustState {
  return {
    projectId: PROJECT,
    decision: null,
    enabled: false,
    persisted: false,
    ...overrides,
  };
}

beforeEach(() => {
  setProjectPluginTrust.mockReset().mockResolvedValue(undefined);
  activateStagedProjectPlugin.mockReset().mockResolvedValue(undefined);
  reloadProjectPlugins.mockReset().mockResolvedValue(undefined);
  setProjectPluginMuted.mockReset().mockResolvedValue(undefined);
  setProjectPluginVisibility.mockReset().mockResolvedValue(undefined);
  setPluginVisibilityDefault.mockReset().mockResolvedValue(undefined);
  getProjectPluginVisibility
    .mockReset()
    .mockResolvedValue({ defaultHiddenPluginIds: [], overrides: {} });
  vi.stubGlobal("window", {
    electron: {
      plugin: {
        setProjectPluginTrust,
        activateStagedProjectPlugin,
        reloadProjectPlugins,
        setProjectPluginMuted,
        setProjectPluginVisibility,
        setPluginVisibilityDefault,
        getProjectPluginVisibility,
      },
    },
  });
});

afterEach(() => {
  __resetProjectPluginStoreForTesting();
  vi.unstubAllGlobals();
});

describe("projectPluginStore", () => {
  it("raises the gate only from the trust prompt, never from an inventory snapshot", () => {
    const store = useProjectPluginStore.getState();
    store.applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "blocked")],
      trust: trust(),
    });

    // A folder full of blocked plugins with no decision on record is exactly
    // the state that tempts a renderer to prompt for itself. It must not.
    expect(useProjectPluginStore.getState().prompt).toBeNull();
    expect(useProjectPluginStore.getState().plugins).toHaveLength(1);

    store.openPrompt({ projectId: PROJECT, plugins: [{ id: "acme.dash", displayName: "Dash" }] });
    expect(useProjectPluginStore.getState().prompt?.projectId).toBe(PROJECT);
  });

  it("does not reopen the gate when a later snapshot arrives after a decision", async () => {
    const store = useProjectPluginStore.getState();
    store.openPrompt({ projectId: PROJECT, plugins: [{ id: "acme.dash", displayName: "Dash" }] });
    await useProjectPluginStore.getState().decide("disabled");
    expect(useProjectPluginStore.getState().prompt).toBeNull();

    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "blocked"), plugin("acme.deploy", "blocked")],
      trust: trust({ decision: "disabled", persisted: true }),
    });

    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("sends the decision the button carries and clears the gate only after main accepts", async () => {
    for (const decision of ["disabled", "session", "enabled"] as const) {
      useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });
      await useProjectPluginStore.getState().decide(decision);
      expect(setProjectPluginTrust).toHaveBeenLastCalledWith(decision);
      expect(useProjectPluginStore.getState().prompt).toBeNull();
    }
    expect(setProjectPluginTrust).toHaveBeenCalledTimes(3);
  });

  it("keeps the gate up and reports the failure when the decision cannot be saved", async () => {
    setProjectPluginTrust.mockRejectedValueOnce(new Error("store is read-only"));
    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });

    await useProjectPluginStore.getState().decide("enabled");

    const state = useProjectPluginStore.getState();
    expect(state.prompt).not.toBeNull();
    expect(state.error).toContain("store is read-only");
    expect(state.deciding).toBeNull();
  });

  it("refuses a prompt for a project this view is not showing", () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    useProjectPluginStore
      .getState()
      .openPrompt({ projectId: OTHER, plugins: [{ id: "x.y", displayName: "X" }] });

    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("drops a queued prompt when the view resolves to a different project", () => {
    useProjectPluginStore.getState().openPrompt({ projectId: OTHER, plugins: [] });
    expect(useProjectPluginStore.getState().prompt).not.toBeNull();

    useProjectPluginStore.getState().setViewProjectId(PROJECT);

    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("refuses to send a decision for a foreign project", async () => {
    useProjectPluginStore.getState().applySnapshot({
      projectId: OTHER,
      plugins: [plugin("x.y", "blocked")],
      trust: trust({ projectId: OTHER }),
    });
    // Set the view id directly, past `setViewProjectId`'s own cleanup, so what
    // is under test is `decide`'s guard rather than the state it would have
    // discarded first.
    useProjectPluginStore.setState({ viewProjectId: PROJECT });

    await useProjectPluginStore.getState().decide("enabled");

    expect(setProjectPluginTrust).not.toHaveBeenCalled();
  });

  it("ignores a second decision while the first is still in flight", async () => {
    let release: (() => void) | undefined;
    setProjectPluginTrust.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const first = useProjectPluginStore.getState().decide("enabled");
    await useProjectPluginStore.getState().decide("disabled");
    expect(setProjectPluginTrust).toHaveBeenCalledTimes(1);

    release?.();
    await first;
    expect(setProjectPluginTrust).toHaveBeenCalledTimes(1);
  });

  it("tracks activation per plugin id and never double-fires", async () => {
    let release: (() => void) | undefined;
    activateStagedProjectPlugin.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const inFlight = useProjectPluginStore.getState().activateStaged("acme.dash");
    expect(useProjectPluginStore.getState().activating.has("acme.dash")).toBe(true);
    await useProjectPluginStore.getState().activateStaged("acme.dash");
    expect(activateStagedProjectPlugin).toHaveBeenCalledTimes(1);

    release?.();
    await inFlight;
    expect(useProjectPluginStore.getState().activating.has("acme.dash")).toBe(false);
  });

  it("closes a replayed prompt when the snapshot says a decision is already on record", () => {
    // The preload buffers the prompt for a late subscriber, so a second view of
    // the same project can replay a question the first view already answered.
    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });
    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "blocked")],
      trust: trust({ decision: "disabled", persisted: true }),
    });

    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("leaves an undecided project's prompt standing when its snapshot lands", () => {
    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });
    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "blocked")],
      trust: trust(),
    });

    expect(useProjectPluginStore.getState().prompt).not.toBeNull();
  });

  it("refuses a straggler prompt for a project that already has a decision", () => {
    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "blocked")],
      trust: trust({ decision: "disabled", persisted: true }),
    });

    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });

    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("holds the gate open while a decision is still on the wire", async () => {
    let release: (() => void) | undefined;
    setProjectPluginTrust.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });

    const inFlight = useProjectPluginStore.getState().decide("enabled");
    useProjectPluginStore.getState().dismissPrompt();
    expect(useProjectPluginStore.getState().prompt).not.toBeNull();

    release?.();
    await inFlight;
    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("ignores a snapshot describing a project this view is not showing", () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    useProjectPluginStore.getState().applySnapshot({
      projectId: OTHER,
      plugins: [plugin("x.y", "blocked")],
      trust: trust({ projectId: OTHER }),
    });

    expect(useProjectPluginStore.getState().plugins).toEqual([]);
    expect(useProjectPluginStore.getState().trust).toBeNull();
  });

  it("drops foreign rows when the view resolves to a different project", () => {
    useProjectPluginStore.getState().applySnapshot({
      projectId: OTHER,
      plugins: [plugin("x.y", "blocked")],
      trust: trust({ projectId: OTHER }),
    });
    useProjectPluginStore.getState().setViewProjectId(PROJECT);

    expect(useProjectPluginStore.getState().plugins).toEqual([]);
    expect(useProjectPluginStore.getState().projectId).toBeNull();
  });

  it("refuses to activate or reload for a foreign project", async () => {
    useProjectPluginStore.getState().applySnapshot({
      projectId: OTHER,
      plugins: [plugin("x.y", "staged")],
      trust: trust({ projectId: OTHER, decision: "enabled", enabled: true }),
    });
    // Set the view id without going through setViewProjectId's own cleanup, so
    // the guard inside the mutators is what is under test.
    useProjectPluginStore.setState({ viewProjectId: PROJECT });

    await useProjectPluginStore.getState().activateStaged("x.y");
    await useProjectPluginStore.getState().reload();

    expect(activateStagedProjectPlugin).not.toHaveBeenCalled();
    expect(reloadProjectPlugins).not.toHaveBeenCalled();
  });

  it("separates blocked plugins from staged ones for the indicator", () => {
    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT,
      plugins: [
        plugin("a", "active"),
        plugin("b", "staged"),
        plugin("c", "blocked"),
        plugin("d", "invalid"),
      ],
      trust: trust({ decision: "enabled", enabled: true }),
    });

    const state = useProjectPluginStore.getState();
    expect(hasBlockedProjectPlugins(state)).toBe(true);
    expect(stagedProjectPlugins(state).map((p) => p.id)).toEqual(["b"]);
  });
});

describe("projectPluginStore mute and visibility", () => {
  it("tracks a mute in flight and clears it once the call settles", async () => {
    const store = useProjectPluginStore.getState();
    store.setViewProjectId(PROJECT);
    store.applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "active")],
      trust: trust({ decision: "enabled", enabled: true, persisted: true }),
    });

    let release: (() => void) | undefined;
    setProjectPluginMuted.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      })
    );

    const pending = useProjectPluginStore.getState().setMuted("acme.dash", true);
    expect(useProjectPluginStore.getState().muting.has("acme.dash")).toBe(true);

    release!();
    await pending;
    expect(useProjectPluginStore.getState().muting.has("acme.dash")).toBe(false);
  });

  it("surfaces a failed mute and does not leave the row stuck pending", async () => {
    const store = useProjectPluginStore.getState();
    store.setViewProjectId(PROJECT);
    store.applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "active")],
      trust: trust({ decision: "enabled", enabled: true, persisted: true }),
    });
    setProjectPluginMuted.mockRejectedValue(new Error("main said no"));

    await useProjectPluginStore.getState().setMuted("acme.dash", true);

    expect(useProjectPluginStore.getState().error).toBe("main said no");
    expect(useProjectPluginStore.getState().muting.has("acme.dash")).toBe(false);
  });

  it("names no project on the wire — main resolves it from the sender", async () => {
    const store = useProjectPluginStore.getState();
    store.setViewProjectId(PROJECT);
    store.applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "active")],
      trust: trust({ decision: "enabled", enabled: true, persisted: true }),
    });

    await useProjectPluginStore.getState().setMuted("acme.dash", true);

    // Targeting another project is not expressible, which is the guarantee —
    // not a renderer-side id check that a compromised renderer could skip.
    expect(setProjectPluginMuted).toHaveBeenCalledWith("acme.dash", true);
  });

  it("applies a visibility change optimistically and rolls it back on failure", async () => {
    const store = useProjectPluginStore.getState();
    store.setViewProjectId(PROJECT);
    store.applyVisibility({
      projectId: PROJECT,
      visibility: { defaultHiddenPluginIds: [], overrides: {} },
    });
    setProjectPluginVisibility.mockRejectedValue(new Error("main said no"));

    await useProjectPluginStore.getState().setVisibility("acme.tools", false);

    expect(useProjectPluginStore.getState().visibility.overrides).toEqual({});
    expect(useProjectPluginStore.getState().error).toBe("main said no");
  });

  it("rolls back a failed default change too", async () => {
    const store = useProjectPluginStore.getState();
    store.setViewProjectId(PROJECT);
    store.applyVisibility({
      projectId: PROJECT,
      visibility: { defaultHiddenPluginIds: [], overrides: {} },
    });
    setPluginVisibilityDefault.mockRejectedValue(new Error("main said no"));

    await useProjectPluginStore.getState().setVisibilityDefault("acme.tools", true);

    expect(useProjectPluginStore.getState().visibility.defaultHiddenPluginIds).toEqual([]);
  });

  it("ignores a visibility push addressed to another project", () => {
    const store = useProjectPluginStore.getState();
    store.setViewProjectId(PROJECT);
    store.applyVisibility({
      projectId: OTHER,
      visibility: { defaultHiddenPluginIds: ["acme.tools"], overrides: {} },
    });

    expect(useProjectPluginStore.getState().visibility.defaultHiddenPluginIds).toEqual([]);
  });

  it("drops another project's visibility when the view names itself", () => {
    const store = useProjectPluginStore.getState();
    store.applySnapshot({
      projectId: OTHER,
      plugins: [],
      trust: { ...trust(), projectId: OTHER },
    });
    store.applyVisibility({
      projectId: OTHER,
      visibility: { defaultHiddenPluginIds: ["acme.tools"], overrides: {} },
    });

    useProjectPluginStore.getState().setViewProjectId(PROJECT);

    expect(useProjectPluginStore.getState().visibility.overrides).toEqual({});
    expect(useProjectPluginStore.getState().visibility.defaultHiddenPluginIds).toEqual([]);
  });
});
