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
const setProjectInstanceEnabled = vi.fn<(pluginId: string, enabled: boolean) => Promise<void>>();
const list = vi.fn<() => Promise<unknown[]>>();

function packageRow(instanceId: string, enabledInProjects: string[]) {
  return { instanceId, origin: "global", instanceMode: "project", enabledInProjects };
}

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
  setProjectInstanceEnabled.mockReset().mockResolvedValue(undefined);
  list.mockReset().mockResolvedValue([]);
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
        setProjectInstanceEnabled,
        list,
      },
    },
  });
});

afterEach(() => {
  __resetProjectPluginStoreForTesting();
  vi.unstubAllGlobals();
});

describe("projectPluginStore", () => {
  it("mirrors the project's application, and drops it when the view moves to another project", () => {
    const application = {
      status: "disabled" as const,
      ownerId: "acme.ledger",
      version: "1.0.0",
      application: { name: "Ledger", destination: "home" as const },
      reason: "muted" as const,
      fallback: "standard-workspace" as const,
    };
    const store = useProjectPluginStore.getState();
    store.setViewProjectId(PROJECT);
    store.applySnapshot({ projectId: PROJECT, plugins: [], trust: trust(), application });
    expect(useProjectPluginStore.getState().application).toEqual(application);

    // A main that predates the field sends no application: no application.
    store.applySnapshot({ projectId: PROJECT, plugins: [], trust: trust() });
    expect(useProjectPluginStore.getState().application).toBeNull();

    store.applySnapshot({ projectId: PROJECT, plugins: [], trust: trust(), application });
    useProjectPluginStore.getState().setViewProjectId(OTHER);
    expect(useProjectPluginStore.getState().application).toBeNull();
  });

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

  it("keeps the gate down when the watcher re-emits after a dismissal", () => {
    // Main re-emits from every watcher settle while a project is undecided, so
    // an agent writing into `.daintree/plugins/` would otherwise re-pop the
    // banner on every debounce cycle.
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });
    useProjectPluginStore.getState().dismissPrompt();

    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });

    expect(useProjectPluginStore.getState().prompt).toBeNull();
  });

  it("still raises the gate for a different project after a dismissal", () => {
    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });
    useProjectPluginStore.getState().dismissPrompt();

    useProjectPluginStore.getState().setViewProjectId(OTHER);
    useProjectPluginStore.getState().openPrompt({ projectId: OTHER, plugins: [] });

    expect(useProjectPluginStore.getState().prompt?.projectId).toBe(OTHER);
  });

  it("lets the gate come back when a decision made after a dismissal fails", async () => {
    setProjectPluginTrust.mockRejectedValueOnce(new Error("disk full"));
    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });
    useProjectPluginStore.getState().dismissPrompt();

    // The indicator is the way back in after a dismissal, and it calls `decide`
    // directly. A failed answer must not leave the banner permanently muted.
    await useProjectPluginStore.getState().decide("enabled");
    useProjectPluginStore.getState().openPrompt({ projectId: PROJECT, plugins: [] });

    expect(useProjectPluginStore.getState().prompt).not.toBeNull();
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

  it("marks a reload in flight so its button can show progress", async () => {
    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("a", "invalid")],
      trust: trust(),
    });

    let release!: () => void;
    reloadProjectPlugins.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const inFlight = useProjectPluginStore.getState().reload();
    expect(useProjectPluginStore.getState().reloading).toBe(true);

    // A second press while the first is still out would double-scan the folder.
    await useProjectPluginStore.getState().reload();
    expect(reloadProjectPlugins).toHaveBeenCalledTimes(1);

    release();
    await inFlight;
    expect(useProjectPluginStore.getState().reloading).toBe(false);
  });

  it("reports a failed reload and stops showing progress", async () => {
    useProjectPluginStore.getState().applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("a", "invalid")],
      trust: trust(),
    });
    reloadProjectPlugins.mockRejectedValue(new Error("folder vanished"));

    await useProjectPluginStore.getState().reload();

    const state = useProjectPluginStore.getState();
    expect(state.reloading).toBe(false);
    expect(state.error).toContain("folder vanished");
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

  it("records what failed, what it tried and main's reason, apart from the fallback", async () => {
    const store = useProjectPluginStore.getState();
    store.setViewProjectId(PROJECT);
    store.applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "active")],
      trust: trust({ decision: "enabled", enabled: true, persisted: true }),
    });
    setProjectPluginMuted.mockRejectedValueOnce(new Error("main said no"));
    await useProjectPluginStore.getState().setMuted("acme.dash", true);
    expect(useProjectPluginStore.getState().errorSource).toEqual({
      action: "mute",
      pluginId: "acme.dash",
      muted: true,
      reason: "main said no",
    });

    // No reason from main: the legacy message falls back, the reason stays empty.
    setProjectPluginMuted.mockRejectedValueOnce({});
    await useProjectPluginStore.getState().setMuted("acme.dash", false);
    expect(useProjectPluginStore.getState().errorSource?.reason).toBeNull();
    expect(useProjectPluginStore.getState().error).toContain("Couldn't turn on");
  });

  it("clears a failed visibility read once a read succeeds, and leaves other failures alone", async () => {
    getProjectPluginVisibility.mockRejectedValueOnce(new Error("store is read-only"));
    await useProjectPluginStore.getState().loadVisibility();
    expect(useProjectPluginStore.getState().errorSource?.action).toBe("loadVisibility");

    await useProjectPluginStore.getState().loadVisibility();
    expect(useProjectPluginStore.getState().error).toBeNull();
    expect(useProjectPluginStore.getState().errorSource).toBeNull();

    const store = useProjectPluginStore.getState();
    store.setViewProjectId(PROJECT);
    store.applySnapshot({
      projectId: PROJECT,
      plugins: [plugin("acme.dash", "active")],
      trust: trust({ decision: "enabled", enabled: true, persisted: true }),
    });
    setProjectPluginMuted.mockRejectedValueOnce(new Error("main said no"));
    await useProjectPluginStore.getState().setMuted("acme.dash", true);
    await useProjectPluginStore.getState().loadVisibility();
    expect(useProjectPluginStore.getState().errorSource?.action).toBe("mute");
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

  it("applies a per-project enable before main answers and keeps it once main agrees", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    let resolve!: () => void;
    setProjectInstanceEnabled.mockReturnValue(new Promise<void>((r) => (resolve = r)));

    const pending = useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", true);
    expect(useProjectPluginStore.getState().instanceEnabled).toEqual({ "acme.ledger": true });
    expect(useProjectPluginStore.getState().instanceToggling.has("acme.ledger")).toBe(true);
    list.mockResolvedValue([packageRow("acme.ledger", [PROJECT])]);
    resolve();
    await pending;
    await vi.waitFor(() => expect(list).toHaveBeenCalled());

    expect(setProjectInstanceEnabled).toHaveBeenCalledWith("acme.ledger", true);
    expect(useProjectPluginStore.getState().instanceEnabled).toEqual({ "acme.ledger": true });
    expect(useProjectPluginStore.getState().instanceToggling.size).toBe(0);
  });

  it("rolls a failed per-project enable back to the choice it replaced", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    list.mockResolvedValue([packageRow("acme.ledger", [PROJECT])]);
    await useProjectPluginStore.getState().loadInstanceProjection();
    setProjectInstanceEnabled.mockRejectedValue(new Error("main said no"));

    await useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", false);

    const state = useProjectPluginStore.getState();
    expect(state.instanceEnabled).toEqual({ "acme.ledger": true });
    expect(state.error).toBe("main said no");
    expect(state.errorSource).toEqual({
      action: "instanceEnabled",
      pluginId: "acme.ledger",
      enabled: false,
      reason: "main said no",
    });
  });

  it("drops a failed first choice entirely, so the list's record shows again", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    setProjectInstanceEnabled.mockRejectedValue(new Error(""));

    await useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", true);

    const state = useProjectPluginStore.getState();
    expect(state.instanceEnabled).toEqual({});
    expect(state.error).toBe("Couldn't turn on 'acme.ledger' in this project");
  });

  it("ignores a second toggle of the same package while the first is in flight", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    setProjectInstanceEnabled.mockReturnValue(new Promise<void>(() => {}));

    void useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", true);
    await useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", false);

    expect(setProjectInstanceEnabled).toHaveBeenCalledTimes(1);
    expect(useProjectPluginStore.getState().instanceEnabled).toEqual({ "acme.ledger": true });
  });

  it("reads this project's per-project packages from the plugin list", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    list.mockResolvedValue([
      packageRow("acme.ledger", [PROJECT, OTHER]),
      packageRow("acme.notes", [OTHER]),
      { instanceId: "acme.plain", origin: "global" },
    ]);

    await useProjectPluginStore.getState().loadInstanceProjection();

    expect(useProjectPluginStore.getState().instanceEnabled).toEqual({
      "acme.ledger": true,
      "acme.notes": false,
    });
  });

  it("keeps a pending toggle's value through a read, and takes the list's word once it settles", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    let resolve!: () => void;
    setProjectInstanceEnabled.mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const pending = useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", true);

    list.mockResolvedValue([packageRow("acme.ledger", [])]);
    await useProjectPluginStore.getState().loadInstanceProjection();
    expect(useProjectPluginStore.getState().instanceEnabled).toEqual({ "acme.ledger": true });

    resolve();
    await pending;
    // Another window turned it off since: the next read is the record.
    await useProjectPluginStore.getState().loadInstanceProjection();
    expect(useProjectPluginStore.getState().instanceEnabled).toEqual({ "acme.ledger": false });
  });

  it("drops a read taken before a toggle settled, and reads again after it", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    let resolveToggle!: () => void;
    setProjectInstanceEnabled.mockReturnValue(new Promise<void>((r) => (resolveToggle = r)));
    const toggle = useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", true);
    let resolveStale!: (rows: unknown[]) => void;
    list.mockReturnValueOnce(new Promise((r) => (resolveStale = r)));
    const stale = useProjectPluginStore.getState().loadInstanceProjection();

    list.mockResolvedValue([packageRow("acme.ledger", [PROJECT])]);
    resolveToggle();
    await toggle;
    resolveStale([packageRow("acme.ledger", [])]);
    await stale;
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    expect(useProjectPluginStore.getState().instanceEnabled).toEqual({ "acme.ledger": true });
  });

  it("keeps an older good read when a newer one fails, and leaves an action's error alone", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setProjectPluginMuted.mockRejectedValue(new Error("mute failed"));
    await useProjectPluginStore.getState().setMuted("acme.dash", true);
    let resolveOlder!: (rows: unknown[]) => void;
    list.mockReturnValueOnce(new Promise((r) => (resolveOlder = r)));
    const older = useProjectPluginStore.getState().loadInstanceProjection();
    list.mockRejectedValueOnce(new Error("list failed"));
    await useProjectPluginStore.getState().loadInstanceProjection();

    resolveOlder([packageRow("acme.ledger", [PROJECT])]);
    await older;

    const state = useProjectPluginStore.getState();
    expect(state.instanceEnabled).toEqual({ "acme.ledger": true });
    expect(state.error).toBe("mute failed");
    warn.mockRestore();
  });

  it("drops a projection read that an older pull answers last", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    let resolveOld!: (rows: unknown[]) => void;
    list.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
    const older = useProjectPluginStore.getState().loadInstanceProjection();
    list.mockResolvedValueOnce([packageRow("acme.ledger", [PROJECT])]);
    await useProjectPluginStore.getState().loadInstanceProjection();

    resolveOld([packageRow("acme.ledger", [])]);
    await older;

    expect(useProjectPluginStore.getState().instanceEnabled).toEqual({ "acme.ledger": true });
  });

  it("lets a call that settles after the view moved on leave the new project alone", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    list.mockResolvedValue([packageRow("acme.ledger", [])]);
    let reject!: (err: Error) => void;
    setProjectInstanceEnabled.mockReturnValueOnce(new Promise<void>((_, r) => (reject = r)));
    const pending = useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", true);

    useProjectPluginStore.getState().setViewProjectId(OTHER);
    await useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", false);
    reject(new Error("main said no"));
    await pending;

    const state = useProjectPluginStore.getState();
    expect(state.instanceEnabled).toEqual({ "acme.ledger": false });
    expect(state.instanceToggling.size).toBe(0);
    expect(state.error).toBeNull();
    expect(setProjectInstanceEnabled).toHaveBeenLastCalledWith("acme.ledger", false);
  });

  it("forgets this view's per-project choices when it switches to another project", async () => {
    useProjectPluginStore.getState().setViewProjectId(PROJECT);
    await useProjectPluginStore.getState().setInstanceEnabled("acme.ledger", true);

    useProjectPluginStore.getState().setViewProjectId(OTHER);

    expect(useProjectPluginStore.getState().instanceEnabled).toEqual({});
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
