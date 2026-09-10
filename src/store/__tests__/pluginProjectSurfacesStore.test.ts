// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectSurfaceChoice,
  ProjectSurfaceChoices,
  ProjectSurfaceChoicesSnapshot,
  ProjectSurfaceSnapshot,
} from "@shared/types/plugin";
import {
  _resetPluginProjectSurfacesStoreForTest,
  selectFailedSave,
  selectSurfaceChoice,
  usePluginProjectSurfacesStore,
} from "../pluginProjectSurfacesStore";

const PROJECT = "p1";
const claim = { pluginId: "project__p1__acme.dash", panelKindId: "project:p1/acme.dash/overview" };

const record = (pluginId: string, choice: ProjectSurfaceChoice, decidedAt = 1) => ({
  pluginId,
  choice,
  decidedAt,
});

const snapshot = (
  choices: ProjectSurfaceChoices = {},
  projectId = PROJECT
): ProjectSurfaceChoicesSnapshot => ({ projectId, choices });

type KindsCallback = () => void;
type ChoicesCallback = (payload: ProjectSurfaceChoicesSnapshot) => void;
type Answers = ProjectSurfaceChoicesSnapshot | null;

interface BridgeOptions {
  choices?: Answers | (() => Promise<Answers>);
  setChoice?: (
    slot: string,
    choice: ProjectSurfaceChoice | null
  ) => Promise<ProjectSurfaceChoicesSnapshot>;
}

function installBridge(
  surfaces: ProjectSurfaceSnapshot | (() => Promise<ProjectSurfaceSnapshot>),
  options: BridgeOptions = {}
) {
  const listeners: KindsCallback[] = [];
  const choiceListeners: ChoicesCallback[] = [];
  const getProjectSurfaces = vi.fn(
    typeof surfaces === "function" ? surfaces : () => Promise.resolve(surfaces)
  );
  const onPanelKindsChanged = vi.fn((cb: KindsCallback) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  const { choices = snapshot() } = options;
  const getProjectSurfaceChoices = vi.fn(
    typeof choices === "function" ? choices : () => Promise.resolve(choices)
  );
  // Main records an answer against the slot's current owner; the renderer only
  // ever says which canvas it wants.
  const setProjectSurfaceChoice = vi.fn(
    options.setChoice ??
      ((_slot: string, choice: ProjectSurfaceChoice | null) =>
        Promise.resolve(
          snapshot(choice === null ? {} : { emptyCanvas: record("acme.dash", choice) })
        ))
  );
  const on = vi.fn((name: string, cb: ChoicesCallback) => {
    if (name === "plugin:project-surface-choices-changed") choiceListeners.push(cb);
    return () => {
      const i = choiceListeners.indexOf(cb);
      if (i >= 0) choiceListeners.splice(i, 1);
    };
  });
  // `defineProperty` rather than an assignment + cast: `window.electron` is a
  // full `ElectronAPI`, and every partial stub of it needs a type assertion the
  // lint ratchet counts. The descriptor takes the value untyped.
  Object.defineProperty(window, "electron", {
    value: {
      plugin: {
        getProjectSurfaces,
        onPanelKindsChanged,
        getProjectSurfaceChoices,
        setProjectSurfaceChoice,
      },
      events: { on },
    },
    configurable: true,
    writable: true,
  });
  return {
    getProjectSurfaces,
    onPanelKindsChanged,
    getProjectSurfaceChoices,
    setProjectSurfaceChoice,
    listeners,
    choiceListeners,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = () => usePluginProjectSurfacesStore.getState();
const canvasChoice = () => selectSurfaceChoice(state(), "emptyCanvas");

beforeEach(() => {
  _resetPluginProjectSurfacesStoreForTest();
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  _resetPluginProjectSurfacesStoreForTest();
});

describe("pluginProjectSurfacesStore", () => {
  it("pulls the sender project's surfaces on init", async () => {
    const bridge = installBridge({ emptyCanvas: claim });

    state().init();
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
    // The pull carries no project id — main resolves it from the sender, which
    // is what makes reading another project's surfaces impossible from here.
    expect(bridge.getProjectSurfaces).toHaveBeenCalledWith();
  });

  it("is idempotent", async () => {
    const bridge = installBridge({ emptyCanvas: claim });

    state().init();
    state().init();
    await flush();

    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
    expect(bridge.onPanelKindsChanged).toHaveBeenCalledTimes(1);
  });

  it("re-pulls when panel kinds change", async () => {
    let current: ProjectSurfaceSnapshot = {};
    const bridge = installBridge(() => Promise.resolve(current));

    state().init();
    await flush();
    expect(state().surfaces).toEqual({});

    // A claim can only appear alongside the panel kind it names, so the
    // kinds broadcast is the signal that a surface may have changed too.
    current = { emptyCanvas: claim };
    bridge.listeners[0]?.();
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("drops a stale pull that resolves after a newer one", async () => {
    const resolvers: Array<(value: ProjectSurfaceSnapshot) => void> = [];
    const bridge = installBridge(
      () => new Promise<ProjectSurfaceSnapshot>((resolve) => resolvers.push(resolve))
    );

    state().init();
    bridge.listeners[0]?.();

    // Resolve the NEWER pull first, then the stale one. The stale answer must
    // not roll the store back to a snapshot taken before the change.
    resolvers[1]?.({ emptyCanvas: claim });
    await flush();
    resolvers[0]?.({});
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("stays retryable and empty with no bridge", () => {
    state().init();
    expect(state().surfaces).toEqual({});

    // Not latched: a component test that renders before the bridge exists must
    // not wedge the store for the rest of the session.
    const bridge = installBridge({ emptyCanvas: claim });
    state().init();
    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
  });

  it("leaves the stock surface in place when the pull fails", async () => {
    installBridge(() => Promise.reject(new Error("nope")));

    state().init();
    await flush();

    expect(state().surfaces).toEqual({});
  });

  it("clears a stale claim when a later pull fails", async () => {
    // Keeping the last answer would outlive the plugin that made it: if the
    // same runtime kind id is re-registered later with no claim behind it, the
    // retained snapshot would resurrect a surface main no longer owns.
    let fail = false;
    const bridge = installBridge(() =>
      fail ? Promise.reject(new Error("nope")) : Promise.resolve({ emptyCanvas: claim })
    );

    state().init();
    await flush();
    expect(state().surfaces).toEqual({ emptyCanvas: claim });

    fail = true;
    bridge.listeners[0]?.();
    await flush();

    expect(state().surfaces).toEqual({});
  });

  it("does not let a stale failure clear a newer successful pull", async () => {
    const settlers: Array<{ resolve: (v: never) => void; reject: (e: Error) => void }> = [];
    const bridge = installBridge(
      () =>
        new Promise<never>((resolve, reject) => {
          settlers.push({ resolve: resolve as (v: never) => void, reject });
        })
    );

    state().init();
    bridge.listeners[0]?.();

    settlers[1]?.resolve({ emptyCanvas: claim } as never);
    await flush();
    settlers[0]?.reject(new Error("stale"));
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("pulls the answers with the claims and records whose they are", async () => {
    const choices = { emptyCanvas: record("acme.dash", "stock") };
    const bridge = installBridge({ emptyCanvas: claim }, { choices: snapshot(choices) });

    expect(state().choicesLoaded).toBe(false);
    state().init();
    await flush();

    expect(state().choices).toEqual(choices);
    expect(state().choicesLoaded).toBe(true);
    expect(state().choicesProjectId).toBe(PROJECT);
    expect(bridge.getProjectSurfaceChoices).toHaveBeenCalledWith();
  });

  it("applies a claim and its answer in one update", async () => {
    const answers = deferred<Answers>();
    installBridge({ emptyCanvas: claim }, { choices: () => answers.promise });

    state().init();
    await flush();
    // The claim is back but its answer is not. Applying the claim alone would
    // draw the plugin's view in a project that chose the launcher.
    expect(state().surfaces).toEqual({});

    answers.resolve(snapshot({ emptyCanvas: record("acme.dash", "stock") }));
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
    expect(canvasChoice()).toBe("stock");
  });

  it("reads the answers again once a sender main had not bound yet gets its claim", async () => {
    // A relaunch restores the last project before its view is registered, so
    // the first pull comes from a sender main cannot name a project for.
    let bound = false;
    const bridge = installBridge(() => Promise.resolve(bound ? { emptyCanvas: claim } : {}), {
      choices: () =>
        Promise.resolve(bound ? snapshot({ emptyCanvas: record("acme.dash", "stock") }) : null),
    });

    state().init();
    await flush();
    // Unknown, not "never answered".
    expect(state().choicesLoaded).toBe(false);

    bound = true;
    bridge.listeners[0]?.();
    await flush();

    expect(state().choicesLoaded).toBe(true);
    expect(canvasChoice()).toBe("stock");
  });

  it("stays unloaded when the answers cannot be read, and retries with the next pull", async () => {
    let fail = true;
    const bridge = installBridge(
      { emptyCanvas: claim },
      { choices: () => (fail ? Promise.reject(new Error("EACCES")) : Promise.resolve(snapshot())) }
    );

    state().init();
    await flush();
    expect(state().surfaces).toEqual({ emptyCanvas: claim });
    expect(state().choicesLoaded).toBe(false);

    fail = false;
    bridge.listeners[0]?.();
    await flush();

    expect(state().choicesLoaded).toBe(true);
  });

  it("honours an answer only for the plugin that owns the slot now", () => {
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: claim },
      choices: { emptyCanvas: record("acme.dash", "stock") },
    });
    expect(canvasChoice()).toBe("stock");

    // The slot passed to a different plugin: the old answer was not about it.
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: { ...claim, pluginId: "project__p1__acme.other" } },
    });
    expect(canvasChoice()).toBeNull();

    // Released: nothing to answer about, whatever is on record.
    usePluginProjectSurfacesStore.setState({ surfaces: {} });
    expect(canvasChoice()).toBeNull();
  });

  it("adopts an answer only once main has recorded it", async () => {
    const save = deferred<ProjectSurfaceChoicesSnapshot>();
    const bridge = installBridge({}, { setChoice: () => save.promise });
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: claim },
      choicesLoaded: true,
    });

    const pending = state().setSurfaceChoice("emptyCanvas", "stock");

    expect(bridge.setProjectSurfaceChoice).toHaveBeenCalledWith("emptyCanvas", "stock");
    expect(canvasChoice()).toBeNull();

    save.resolve(snapshot({ emptyCanvas: record("acme.dash", "stock", 42) }));
    await pending;

    expect(canvasChoice()).toBe("stock");
    expect(state().choices.emptyCanvas?.decidedAt).toBe(42);
  });

  it("reports a failed save, leaves the canvas as it was, and clears the report on retry", async () => {
    let fail = true;
    installBridge(
      {},
      {
        setChoice: (_slot, choice) =>
          fail
            ? Promise.reject(new Error("ENOSPC"))
            : Promise.resolve(snapshot({ emptyCanvas: record("acme.dash", choice ?? "surface") })),
      }
    );
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: claim },
      choicesLoaded: true,
    });

    await state().setSurfaceChoice("emptyCanvas", "stock");

    expect(state().failedSave).toEqual({
      slot: "emptyCanvas",
      choice: "stock",
      pluginId: "acme.dash",
    });
    expect(canvasChoice()).toBeNull();

    fail = false;
    await state().setSurfaceChoice("emptyCanvas", "stock");

    expect(state().failedSave).toBeNull();
    expect(canvasChoice()).toBe("stock");
  });

  it("drops a failed save once another view's answer arrives", async () => {
    const bridge = installBridge(
      { emptyCanvas: claim },
      { setChoice: () => Promise.reject(new Error("ENOSPC")) }
    );
    state().init();
    await flush();

    await state().setSurfaceChoice("emptyCanvas", "stock");
    expect(selectFailedSave(state(), "emptyCanvas")).not.toBeNull();

    // Retrying now would overwrite an answer newer than the one that failed.
    bridge.choiceListeners[0]?.(snapshot({ emptyCanvas: record("acme.dash", "surface") }));

    expect(selectFailedSave(state(), "emptyCanvas")).toBeNull();
    expect(canvasChoice()).toBe("surface");
  });

  it("offers a failed save for retry only while the same plugin owns the slot", async () => {
    installBridge({}, { setChoice: () => Promise.reject(new Error("ENOSPC")) });
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: claim },
      choicesLoaded: true,
    });

    await state().setSurfaceChoice("emptyCanvas", "stock");
    expect(selectFailedSave(state(), "emptyCanvas")?.choice).toBe("stock");

    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: { ...claim, pluginId: "project__p1__acme.other" } },
    });
    expect(selectFailedSave(state(), "emptyCanvas")).toBeNull();
  });

  it("forgets an answer with null", async () => {
    const bridge = installBridge({});
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: claim },
      choices: { emptyCanvas: record("acme.dash", "stock") },
      choicesLoaded: true,
    });

    await state().setSurfaceChoice("emptyCanvas", null);

    expect(bridge.setProjectSurfaceChoice).toHaveBeenCalledWith("emptyCanvas", null);
    expect(state().choices).toEqual({});
  });

  it("lets an answer that lands mid-pull beat what the pull read", async () => {
    const answers = deferred<Answers>();
    installBridge({ emptyCanvas: claim }, { choices: () => answers.promise });

    state().init();
    await state().setSurfaceChoice("emptyCanvas", "stock");

    // The pull started before the save and read what disk held then.
    answers.resolve(snapshot());
    await flush();

    expect(canvasChoice()).toBe("stock");
  });

  it("adopts answers pushed from another view of the same project", async () => {
    const bridge = installBridge({ emptyCanvas: claim });
    state().init();
    await flush();

    bridge.choiceListeners[0]?.(snapshot({ emptyCanvas: record("acme.dash", "stock") }));

    expect(canvasChoice()).toBe("stock");
  });

  it("refuses a push naming a different project", async () => {
    const bridge = installBridge({ emptyCanvas: claim });
    state().init();
    await flush();
    expect(state().choicesProjectId).toBe(PROJECT);

    bridge.choiceListeners[0]?.(snapshot({ emptyCanvas: record("acme.dash", "stock") }, "p2"));

    expect(state().choices).toEqual({});
  });

  it("starts a fresh session with nothing loaded until main answers", async () => {
    const choices = { emptyCanvas: record("acme.dash", "stock") };
    const bridge = installBridge({ emptyCanvas: claim }, { choices: snapshot(choices) });
    state().init();
    await flush();
    expect(state().choicesLoaded).toBe(true);

    // The answer lives in main, not in this view: a reset view knows nothing
    // until it reads it back, and then it has it again.
    _resetPluginProjectSurfacesStoreForTest();
    expect(state().choicesLoaded).toBe(false);
    expect(state().choices).toEqual({});
    expect(bridge.choiceListeners).toHaveLength(0);

    state().init();
    await flush();
    expect(state().choices).toEqual(choices);
  });
});
