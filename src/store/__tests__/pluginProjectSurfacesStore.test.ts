// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectSurfaceChoices,
  ProjectSurfaceChoicesChangedEvent,
  ProjectSurfaceSnapshot,
} from "@shared/types/plugin";
import {
  _resetPluginProjectSurfacesStoreForTest,
  selectSurfaceChoice,
  usePluginProjectSurfacesStore,
} from "../pluginProjectSurfacesStore";

const claim = { pluginId: "project__p1__acme.dash", panelKindId: "project:p1/acme.dash/overview" };

const record = (pluginId: string, choice: "surface" | "stock", decidedAt = 1) => ({
  pluginId,
  choice,
  decidedAt,
});

type KindsCallback = () => void;
type ChoicesCallback = (payload: ProjectSurfaceChoicesChangedEvent) => void;

interface BridgeOptions {
  choices?: ProjectSurfaceChoices | (() => Promise<ProjectSurfaceChoices>);
  setChoice?: (...args: unknown[]) => Promise<ProjectSurfaceChoices>;
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
  const { choices = {} } = options;
  const getProjectSurfaceChoices = vi.fn(
    typeof choices === "function" ? choices : () => Promise.resolve(choices)
  );
  const setProjectSurfaceChoice = vi.fn(
    options.setChoice ?? (() => Promise.resolve(usePluginProjectSurfacesStore.getState().choices))
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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

    usePluginProjectSurfacesStore.getState().init();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });
    // The pull carries no project id — main resolves it from the sender, which
    // is what makes reading another project's surfaces impossible from here.
    expect(bridge.getProjectSurfaces).toHaveBeenCalledWith();
  });

  it("is idempotent", async () => {
    const bridge = installBridge({ emptyCanvas: claim });

    usePluginProjectSurfacesStore.getState().init();
    usePluginProjectSurfacesStore.getState().init();
    await flush();

    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
    expect(bridge.onPanelKindsChanged).toHaveBeenCalledTimes(1);
  });

  it("re-pulls when panel kinds change", async () => {
    let current: ProjectSurfaceSnapshot = {};
    const bridge = installBridge(() => Promise.resolve(current));

    usePluginProjectSurfacesStore.getState().init();
    await flush();
    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({});

    // A claim can only appear alongside the panel kind it names, so the
    // kinds broadcast is the signal that a surface may have changed too.
    current = { emptyCanvas: claim };
    bridge.listeners[0]?.();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("drops a stale pull that resolves after a newer one", async () => {
    const resolvers: Array<(value: ProjectSurfaceSnapshot) => void> = [];
    const bridge = installBridge(
      () => new Promise<ProjectSurfaceSnapshot>((resolve) => resolvers.push(resolve))
    );

    usePluginProjectSurfacesStore.getState().init();
    bridge.listeners[0]?.();

    // Resolve the NEWER pull first, then the stale one. The stale answer must
    // not roll the store back to a snapshot taken before the change.
    resolvers[1]?.({ emptyCanvas: claim });
    await flush();
    resolvers[0]?.({});
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("stays retryable and empty with no bridge", () => {
    usePluginProjectSurfacesStore.getState().init();
    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({});

    // Not latched: a component test that renders before the bridge exists must
    // not wedge the store for the rest of the session.
    const bridge = installBridge({ emptyCanvas: claim });
    usePluginProjectSurfacesStore.getState().init();
    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
  });

  it("leaves the stock surface in place when the pull fails", async () => {
    installBridge(() => Promise.reject(new Error("nope")));

    usePluginProjectSurfacesStore.getState().init();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({});
  });

  it("clears a stale claim when a later pull fails", async () => {
    // Keeping the last answer would outlive the plugin that made it: if the
    // same runtime kind id is re-registered later with no claim behind it, the
    // retained snapshot would resurrect a surface main no longer owns.
    let fail = false;
    const bridge = installBridge(() =>
      fail ? Promise.reject(new Error("nope")) : Promise.resolve({ emptyCanvas: claim })
    );

    usePluginProjectSurfacesStore.getState().init();
    await flush();
    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });

    fail = true;
    bridge.listeners[0]?.();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({});
  });

  it("does not let a stale failure clear a newer successful pull", async () => {
    const settlers: Array<{ resolve: (v: never) => void; reject: (e: Error) => void }> = [];
    const bridge = installBridge(
      () =>
        new Promise<never>((resolve, reject) => {
          settlers.push({ resolve: resolve as (v: never) => void, reject });
        })
    );

    usePluginProjectSurfacesStore.getState().init();
    bridge.listeners[0]?.();

    settlers[1]?.resolve({ emptyCanvas: claim } as never);
    await flush();
    settlers[0]?.reject(new Error("stale"));
    await flush();

    expect(usePluginProjectSurfacesStore.getState().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("pulls the project's remembered answers on init and marks them loaded", async () => {
    const choices = { emptyCanvas: record("acme.dash", "stock") };
    const bridge = installBridge({ emptyCanvas: claim }, { choices });

    expect(usePluginProjectSurfacesStore.getState().choicesLoaded).toBe(false);
    usePluginProjectSurfacesStore.getState().init();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().choices).toEqual(choices);
    expect(usePluginProjectSurfacesStore.getState().choicesLoaded).toBe(true);
    // Like the surfaces pull, the project comes from the sender.
    expect(bridge.getProjectSurfaceChoices).toHaveBeenCalledWith();
  });

  it("stays unloaded when the answers cannot be read", async () => {
    // "Unread" must not become "never answered", or a project that answered
    // long ago would be asked again on a transient failure.
    installBridge({ emptyCanvas: claim }, { choices: () => Promise.reject(new Error("nope")) });

    usePluginProjectSurfacesStore.getState().init();
    await flush();

    expect(usePluginProjectSurfacesStore.getState().choicesLoaded).toBe(false);
    expect(usePluginProjectSurfacesStore.getState().choices).toEqual({});
  });

  it("honours an answer only for the plugin that owns the slot now", () => {
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: claim },
      choices: { emptyCanvas: record("acme.dash", "stock") },
    });
    expect(selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), "emptyCanvas")).toBe(
      "stock"
    );

    // The slot passed to a different plugin: the old answer was not about it.
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: { ...claim, pluginId: "project__p1__acme.other" } },
    });
    expect(selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), "emptyCanvas")).toBeNull();

    // Released: nothing to answer about, whatever is on record.
    usePluginProjectSurfacesStore.setState({ surfaces: {} });
    expect(selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), "emptyCanvas")).toBeNull();
  });

  it("applies an answer on the click, then adopts main's record", async () => {
    const save = deferred<ProjectSurfaceChoices>();
    const bridge = installBridge({}, { setChoice: () => save.promise });
    usePluginProjectSurfacesStore.setState({ surfaces: { emptyCanvas: claim } });

    const pending = usePluginProjectSurfacesStore.getState().setSurfaceChoice("emptyCanvas", "stock");

    expect(selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), "emptyCanvas")).toBe(
      "stock"
    );
    expect(bridge.setProjectSurfaceChoice).toHaveBeenCalledWith("emptyCanvas", "stock");

    save.resolve({ emptyCanvas: record("acme.dash", "stock", 42) });
    await pending;

    expect(usePluginProjectSurfacesStore.getState().choices.emptyCanvas?.decidedAt).toBe(42);
  });

  it("keeps the answer for the session when saving it fails", async () => {
    installBridge({}, { setChoice: () => Promise.reject(new Error("ENOSPC")) });
    usePluginProjectSurfacesStore.setState({ surfaces: { emptyCanvas: claim } });

    await usePluginProjectSurfacesStore.getState().setSurfaceChoice("emptyCanvas", "stock");

    expect(selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), "emptyCanvas")).toBe(
      "stock"
    );
  });

  it("does not answer for a slot nothing claims", async () => {
    const bridge = installBridge({});

    await usePluginProjectSurfacesStore.getState().setSurfaceChoice("emptyCanvas", "stock");

    expect(bridge.setProjectSurfaceChoice).not.toHaveBeenCalled();
    expect(usePluginProjectSurfacesStore.getState().choices).toEqual({});
  });

  it("forgets an answer with null", async () => {
    const bridge = installBridge({}, { setChoice: () => Promise.resolve({}) });
    usePluginProjectSurfacesStore.setState({
      surfaces: { emptyCanvas: claim },
      choices: { emptyCanvas: record("acme.dash", "stock") },
    });

    await usePluginProjectSurfacesStore.getState().setSurfaceChoice("emptyCanvas", null);

    expect(bridge.setProjectSurfaceChoice).toHaveBeenCalledWith("emptyCanvas", null);
    expect(usePluginProjectSurfacesStore.getState().choices).toEqual({});
  });

  it("lets an answer just given beat a choices pull already in flight", async () => {
    const pull = deferred<ProjectSurfaceChoices>();
    installBridge(
      { emptyCanvas: claim },
      {
        choices: () => pull.promise,
        setChoice: () => Promise.resolve({ emptyCanvas: record("acme.dash", "stock") }),
      }
    );

    usePluginProjectSurfacesStore.getState().init();
    await flush();
    await usePluginProjectSurfacesStore.getState().setSurfaceChoice("emptyCanvas", "stock");

    // The pull started before the click and answers with what disk held then.
    pull.resolve({});
    await flush();

    expect(selectSurfaceChoice(usePluginProjectSurfacesStore.getState(), "emptyCanvas")).toBe(
      "stock"
    );
  });

  it("adopts answers pushed from another view of the project", async () => {
    const bridge = installBridge({ emptyCanvas: claim });
    usePluginProjectSurfacesStore.getState().init();
    await flush();

    const choices = { emptyCanvas: record("acme.dash", "stock") };
    bridge.choiceListeners[0]?.({ projectId: "p1", choices });

    expect(usePluginProjectSurfacesStore.getState().choices).toEqual(choices);
    expect(usePluginProjectSurfacesStore.getState().choicesLoaded).toBe(true);
  });

  it("starts a fresh session with nothing loaded until main answers", async () => {
    const choices = { emptyCanvas: record("acme.dash", "stock") };
    installBridge({ emptyCanvas: claim }, { choices });
    usePluginProjectSurfacesStore.getState().init();
    await flush();
    expect(usePluginProjectSurfacesStore.getState().choicesLoaded).toBe(true);

    // The answer lives in main, not in this view: a reset view knows nothing
    // until it reads it back, and then it has it again.
    _resetPluginProjectSurfacesStoreForTest();
    expect(usePluginProjectSurfacesStore.getState().choicesLoaded).toBe(false);
    expect(usePluginProjectSurfacesStore.getState().choices).toEqual({});

    usePluginProjectSurfacesStore.getState().init();
    await flush();
    expect(usePluginProjectSurfacesStore.getState().choices).toEqual(choices);
  });
});
