// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectSurfaceChoice,
  ProjectSurfaceChoiceUpdate,
  ProjectSurfaceChoices,
  ProjectSurfaceSlotState,
  ProjectSurfacesChangedEvent,
  ProjectSurfacesSnapshot,
} from "@shared/types/plugin";
import {
  _resetPluginProjectSurfacesStoreForTest,
  claimedSurfaceSlots,
  consentHostSlot,
  selectFailedSave,
  selectSurfaceChoice,
  selectSurfaceRefusals,
  surfaceAnswerUpdates,
  surfaceSlotChoice,
  usePluginProjectSurfacesStore,
} from "../pluginProjectSurfacesStore";
import { notifyHostResync } from "../hostResyncSignal";

const noticeBuildSkew = vi.hoisted(() => vi.fn());
vi.mock("@/components/Hosts/buildSkew", () => ({ noticeBuildSkew }));

const PROJECT = "p1";
const claim = { pluginId: "project__p1__acme.dash", panelKindId: "project:p1/acme.dash/overview" };

const record = (pluginId: string, choice: ProjectSurfaceChoice, decidedAt = 1) => ({
  pluginId,
  choice,
  decidedAt,
});

function ownedBy(pluginId = claim.pluginId, panelKindId = claim.panelKindId) {
  const state: ProjectSurfaceSlotState = {
    mode: "exclusive",
    options: [
      { pluginId, scope: "project", value: { kind: "view", viewId: "overview", panelKindId } },
    ],
    defaultOptionId: pluginId,
    refused: [],
  };
  return { emptyCanvas: state };
}

const snapshot = ({
  revision = 1,
  slots = {},
  choices = {},
  projectId = PROJECT,
}: {
  revision?: number;
  slots?: ProjectSurfacesSnapshot["slots"];
  choices?: ProjectSurfaceChoices | null;
  projectId?: string;
} = {}): ProjectSurfacesSnapshot => ({ projectId, revision, slots, choices });

type KindsCallback = () => void;
type SurfacesCallback = (payload: ProjectSurfacesChangedEvent) => void;
type Read = ProjectSurfacesSnapshot | null;

interface BridgeOptions {
  setChoice?: (
    slot: string,
    choice: ProjectSurfaceChoice | null
  ) => Promise<ProjectSurfacesSnapshot>;
}

function installBridge(read: Read | (() => Promise<Read>), options: BridgeOptions = {}) {
  const listeners: KindsCallback[] = [];
  const surfaceListeners: SurfacesCallback[] = [];
  const getProjectSurfaces = vi.fn(typeof read === "function" ? read : () => Promise.resolve(read));
  const onPanelKindsChanged = vi.fn((cb: KindsCallback) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  // Main records an answer against the slot's current owner; the renderer only
  // ever says which canvas it wants. Every answer travels as a batch, one slot
  // or several, so the default answers the batch's first slot.
  let saveRevision = 100;
  const setChoice =
    options.setChoice ??
    ((_slot: string, choice: ProjectSurfaceChoice | null) =>
      Promise.resolve(
        snapshot({
          revision: ++saveRevision,
          slots: ownedBy(),
          choices: choice === null ? {} : { emptyCanvas: record("acme.dash", choice) },
        })
      ));
  const setProjectSurfaceChoices = vi.fn((updates: ProjectSurfaceChoiceUpdate[]) =>
    setChoice(updates[0]!.slot, updates[0]!.choice)
  );
  const on = vi.fn((name: string, cb: SurfacesCallback) => {
    if (name === "plugin:project-surfaces-changed") surfaceListeners.push(cb);
    return () => {
      const i = surfaceListeners.indexOf(cb);
      if (i >= 0) surfaceListeners.splice(i, 1);
    };
  });
  // `defineProperty` rather than an assignment + cast: `window.electron` is a
  // full `ElectronAPI`, and every partial stub of it needs a type assertion the
  // lint ratchet counts. The descriptor takes the value untyped.
  Object.defineProperty(window, "electron", {
    value: {
      plugin: { getProjectSurfaces, onPanelKindsChanged, setProjectSurfaceChoices },
      events: { on },
    },
    configurable: true,
    writable: true,
  });
  return {
    getProjectSurfaces,
    onPanelKindsChanged,
    setProjectSurfaceChoices,
    on,
    listeners,
    surfaceListeners,
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
  noticeBuildSkew.mockReset();
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  _resetPluginProjectSurfacesStoreForTest();
});

describe("pluginProjectSurfacesStore", () => {
  it("reads the sender project's slots on init and derives the canvas owner", async () => {
    const bridge = installBridge(snapshot({ slots: ownedBy() }));

    state().init();
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
    expect(state().slots).toEqual(ownedBy());
    // The read carries no project id — main resolves it from the sender, which
    // is what makes reading another project's slots impossible from here.
    expect(bridge.getProjectSurfaces).toHaveBeenCalledWith();
  });

  it("derives no canvas owner from a claim that does not mount through a panel kind", async () => {
    const slots = ownedBy();
    slots.emptyCanvas.options[0] = {
      pluginId: claim.pluginId,
      scope: "project",
      value: { kind: "view", viewId: "overview" },
    };
    installBridge(snapshot({ slots }));

    state().init();
    await flush();

    expect(state().surfaces).toEqual({});
  });

  it("is idempotent", async () => {
    const bridge = installBridge(snapshot({ slots: ownedBy() }));

    state().init();
    state().init();
    await flush();

    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
    expect(bridge.onPanelKindsChanged).toHaveBeenCalledTimes(1);
    expect(bridge.on).toHaveBeenCalledTimes(1);
  });

  it("re-reads when main says the project's slots changed", async () => {
    let current = snapshot({ revision: 1 });
    const bridge = installBridge(() => Promise.resolve(current));

    state().init();
    await flush();
    expect(state().surfaces).toEqual({});

    // A release or a claim that is not also a panel-kind change still reaches
    // the canvas.
    current = snapshot({ revision: 2, slots: ownedBy() });
    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 2 });
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("skips a change signal it has already read past", async () => {
    const bridge = installBridge(snapshot({ revision: 5, slots: ownedBy() }));
    state().init();
    await flush();
    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);

    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 5 });
    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 3 });

    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
  });

  it("ignores a change signal naming a different project", async () => {
    const bridge = installBridge(snapshot({ revision: 1 }));
    state().init();
    await flush();

    bridge.surfaceListeners[0]?.({ projectId: "p2", revision: 9 });

    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
  });

  it("re-reads when panel kinds change", async () => {
    let current = snapshot({ revision: 1 });
    const bridge = installBridge(() => Promise.resolve(current));

    state().init();
    await flush();

    current = snapshot({ revision: 2, slots: ownedBy() });
    bridge.listeners[0]?.();
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("drops a read older than one already adopted", async () => {
    const resolvers: Array<(value: Read) => void> = [];
    const bridge = installBridge(() => new Promise<Read>((resolve) => resolvers.push(resolve)));

    state().init();
    bridge.listeners[0]?.();

    // Resolve the NEWER read first, then the stale one. The stale answer must
    // not roll the store back to a snapshot taken before the change.
    resolvers[1]?.(snapshot({ revision: 2, slots: ownedBy() }));
    await flush();
    resolvers[0]?.(snapshot({ revision: 1 }));
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("stays retryable and empty with no bridge", () => {
    state().init();
    expect(state().surfaces).toEqual({});

    // Not latched: a component test that renders before the bridge exists must
    // not wedge the store for the rest of the session.
    const bridge = installBridge(snapshot({ slots: ownedBy() }));
    state().init();
    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);
  });

  it("leaves the stock surface in place when the read fails", async () => {
    installBridge(() => Promise.reject(new Error("nope")));

    state().init();
    await flush();

    expect(state().surfaces).toEqual({});
  });

  it("says why when the host's build doesn't have the read, and forgets it once a read works", async () => {
    const why =
      "studio-01 runs Daintree 0.47.0 and this machine runs 0.46.0. This needs both on the same build.";
    let fail = true;
    const bridge = installBridge(() =>
      fail
        ? Promise.reject(
            // What the preload rebuilds from the Shell's account of the refusal.
            new Error(
              `[AppError|HOST_BUILD_SKEW|${encodeURIComponent(why)}] Channel plugin:project-surfaces-get is not classified: studio-01 runs 0.47.0, this machine runs 0.46.0`
            )
          )
        : Promise.resolve(snapshot({ slots: ownedBy() }))
    );

    state().init();
    await vi.waitFor(() => expect(noticeBuildSkew).toHaveBeenCalledTimes(1));

    expect(state().readFailure).toBe(why);
    expect(state().surfaces).toEqual({});
    expect(noticeBuildSkew).toHaveBeenCalledWith("Plugin setup unavailable", why);

    fail = false;
    bridge.listeners[0]?.();
    await flush();

    expect(state().readFailure).toBeNull();
    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("keeps any other read failure to the log", async () => {
    installBridge(() =>
      Promise.reject(new Error("[AppError|CHANNEL_NOT_REMOTABLE] Channel x is not classified"))
    );

    state().init();
    await flush();
    await flush();

    expect(state().readFailure).toBeNull();
    expect(noticeBuildSkew).not.toHaveBeenCalled();
  });

  it("reads again when the host link comes back", async () => {
    const bridge = installBridge(snapshot());

    state().init();
    await flush();
    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(1);

    notifyHostResync();
    await flush();
    expect(bridge.getProjectSurfaces).toHaveBeenCalledTimes(2);
  });

  it("clears a stale claim when a later read fails", async () => {
    // Keeping the last answer would outlive the plugin that made it: if the
    // same runtime kind id is re-registered later with no claim behind it, the
    // retained snapshot would resurrect a surface main no longer owns.
    let fail = false;
    const bridge = installBridge(() =>
      fail ? Promise.reject(new Error("nope")) : Promise.resolve(snapshot({ slots: ownedBy() }))
    );

    state().init();
    await flush();
    expect(state().surfaces).toEqual({ emptyCanvas: claim });

    fail = true;
    bridge.listeners[0]?.();
    await flush();

    expect(state().surfaces).toEqual({});
    expect(state().slots).toEqual({});
  });

  it("does not let a stale failure clear a newer successful read", async () => {
    const settlers: Array<{ resolve: (v: Read) => void; reject: (e: Error) => void }> = [];
    const bridge = installBridge(
      () =>
        new Promise<Read>((resolve, reject) => {
          settlers.push({ resolve, reject });
        })
    );

    state().init();
    bridge.listeners[0]?.();

    settlers[1]?.resolve(snapshot({ slots: ownedBy() }));
    await flush();
    settlers[0]?.reject(new Error("stale"));
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("applies the claims and their answers in one update, and records whose they are", async () => {
    const choices = { emptyCanvas: record("acme.dash", "stock") };
    installBridge(snapshot({ slots: ownedBy(), choices }));

    expect(state().choicesLoaded).toBe(false);
    state().init();
    await flush();

    expect(state().choices).toEqual(choices);
    expect(state().choicesLoaded).toBe(true);
    expect(state().choicesProjectId).toBe(PROJECT);
    expect(canvasChoice()).toBe("stock");
  });

  it("reads again once a sender main had not bound yet is told its slots changed", async () => {
    // A relaunch restores the last project before its view is registered, so
    // the first read comes from a sender main cannot name a project for.
    let bound = false;
    const bridge = installBridge(() =>
      Promise.resolve(
        bound
          ? snapshot({ slots: ownedBy(), choices: { emptyCanvas: record("acme.dash", "stock") } })
          : null
      )
    );

    state().init();
    await flush();
    // Unknown, not "never answered".
    expect(state().choicesLoaded).toBe(false);

    bound = true;
    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 1 });
    await flush();

    expect(state().choicesLoaded).toBe(true);
    expect(canvasChoice()).toBe("stock");
  });

  it("stays unloaded when main can't read the answers, and loads with the next read", async () => {
    let readable = false;
    const bridge = installBridge(() =>
      Promise.resolve(
        snapshot({ revision: readable ? 2 : 1, slots: ownedBy(), choices: readable ? {} : null })
      )
    );

    state().init();
    await flush();
    expect(state().surfaces).toEqual({ emptyCanvas: claim });
    expect(state().choicesLoaded).toBe(false);

    readable = true;
    bridge.listeners[0]?.();
    await flush();

    expect(state().choicesLoaded).toBe(true);
  });

  it("treats answers as unknown again when a newer read can't see them", async () => {
    let current = snapshot({
      revision: 1,
      slots: ownedBy(),
      choices: { emptyCanvas: record("acme.dash", "surface") },
    });
    const bridge = installBridge(() => Promise.resolve(current));
    state().init();
    await flush();
    expect(state().choicesLoaded).toBe(true);

    // Another view may have just answered; this read can't say. Keeping the
    // old answer would act on one that may be gone, so the canvas goes stock
    // and nobody is asked until a read works.
    current = snapshot({ revision: 2, slots: ownedBy(), choices: null });
    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 2 });
    await flush();

    expect(state().choicesLoaded).toBe(false);
    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("honours an answer only for the plugin that owns the slot now", () => {
    usePluginProjectSurfacesStore.setState({
      slots: ownedBy(),
      choices: { emptyCanvas: record("acme.dash", "stock") },
    });
    expect(canvasChoice()).toBe("stock");

    // The slot passed to a different plugin: the old answer was not about it.
    usePluginProjectSurfacesStore.setState({ slots: ownedBy("project__p1__acme.other") });
    expect(canvasChoice()).toBeNull();

    // Released: nothing to answer about, whatever is on record.
    usePluginProjectSurfacesStore.setState({ slots: {} });
    expect(canvasChoice()).toBeNull();
  });

  it("adopts an answer only once main has recorded it", async () => {
    const save = deferred<ProjectSurfacesSnapshot>();
    const bridge = installBridge(null, { setChoice: () => save.promise });
    usePluginProjectSurfacesStore.setState({
      slots: ownedBy(),
      surfaces: { emptyCanvas: claim },
      choicesLoaded: true,
    });

    const pending = state().setSurfaceChoice("emptyCanvas", "stock");

    expect(bridge.setProjectSurfaceChoices).toHaveBeenCalledWith([
      { slot: "emptyCanvas", choice: "stock", ownerId: claim.pluginId },
    ]);
    expect(canvasChoice()).toBeNull();

    save.resolve(
      snapshot({
        revision: 7,
        slots: ownedBy(),
        choices: { emptyCanvas: record("acme.dash", "stock", 42) },
      })
    );
    await pending;

    expect(canvasChoice()).toBe("stock");
    expect(state().choices.emptyCanvas?.decidedAt).toBe(42);
  });

  it("reports a failed save, leaves the canvas as it was, and clears the report on retry", async () => {
    let fail = true;
    installBridge(null, {
      setChoice: (_slot, choice) =>
        fail
          ? Promise.reject(new Error("ENOSPC"))
          : Promise.resolve(
              snapshot({
                slots: ownedBy(),
                choices: { emptyCanvas: record("acme.dash", choice ?? "surface") },
              })
            ),
    });
    usePluginProjectSurfacesStore.setState({
      slots: ownedBy(),
      surfaces: { emptyCanvas: claim },
      choicesLoaded: true,
    });

    await state().setSurfaceChoice("emptyCanvas", "stock");

    expect(state().failedSave).toEqual({
      updates: [{ slot: "emptyCanvas", choice: "stock", ownerId: claim.pluginId }],
      owners: { emptyCanvas: "acme.dash" },
    });
    expect(canvasChoice()).toBeNull();

    fail = false;
    await state().setSurfaceChoice("emptyCanvas", "stock");

    expect(state().failedSave).toBeNull();
    expect(canvasChoice()).toBe("stock");
  });

  it("drops a failed save once another view's answer arrives", async () => {
    let current = snapshot({ revision: 1, slots: ownedBy() });
    const bridge = installBridge(() => Promise.resolve(current), {
      setChoice: () => Promise.reject(new Error("ENOSPC")),
    });
    state().init();
    await flush();

    await state().setSurfaceChoice("emptyCanvas", "stock");
    expect(selectFailedSave(state(), "emptyCanvas")).not.toBeNull();

    // Retrying now would overwrite an answer newer than the one that failed.
    current = snapshot({
      revision: 2,
      slots: ownedBy(),
      choices: { emptyCanvas: record("acme.dash", "surface") },
    });
    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 2 });
    await flush();

    expect(selectFailedSave(state(), "emptyCanvas")).toBeNull();
    expect(canvasChoice()).toBe("surface");
  });

  it("keeps a failed save through a change that left the answers alone", async () => {
    let current = snapshot({ revision: 1, slots: ownedBy() });
    const bridge = installBridge(() => Promise.resolve(current), {
      setChoice: () => Promise.reject(new Error("ENOSPC")),
    });
    state().init();
    await flush();
    await state().setSurfaceChoice("emptyCanvas", "stock");

    // Another plugin's claim was refused: the slot state moved, the answer did not.
    current = snapshot({ revision: 2, slots: ownedBy() });
    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 2 });
    await flush();

    expect(selectFailedSave(state(), "emptyCanvas")?.updates).toEqual([
      { slot: "emptyCanvas", choice: "stock", ownerId: claim.pluginId },
    ]);
  });

  it("offers a failed save for retry only while the same plugin owns the slot", async () => {
    installBridge(null, { setChoice: () => Promise.reject(new Error("ENOSPC")) });
    usePluginProjectSurfacesStore.setState({
      slots: ownedBy(),
      surfaces: { emptyCanvas: claim },
      choicesLoaded: true,
    });

    await state().setSurfaceChoice("emptyCanvas", "stock");
    expect(selectFailedSave(state(), "emptyCanvas")?.updates).toEqual([
      { slot: "emptyCanvas", choice: "stock", ownerId: claim.pluginId },
    ]);

    usePluginProjectSurfacesStore.setState({ slots: ownedBy("project__p1__acme.other") });
    expect(selectFailedSave(state(), "emptyCanvas")).toBeNull();
  });

  it("forgets an answer with null", async () => {
    const bridge = installBridge(null);
    usePluginProjectSurfacesStore.setState({
      slots: ownedBy(),
      surfaces: { emptyCanvas: claim },
      choices: { emptyCanvas: record("acme.dash", "stock") },
      choicesLoaded: true,
    });

    await state().setSurfaceChoice("emptyCanvas", null);

    expect(bridge.setProjectSurfaceChoices).toHaveBeenCalledWith([
      { slot: "emptyCanvas", choice: null },
    ]);
    expect(state().choices).toEqual({});
  });

  it("lets an answer that lands mid-read beat what the read saw", async () => {
    const read = deferred<Read>();
    installBridge(() => read.promise);

    state().init();
    await state().setSurfaceChoice("emptyCanvas", "stock");

    // The read started before the save and saw what disk held then, under the
    // revision before the save's.
    read.resolve(snapshot({ revision: 1, slots: ownedBy() }));
    await flush();

    expect(canvasChoice()).toBe("stock");
  });

  it("drops a save answered after a newer read was adopted", async () => {
    const save = deferred<ProjectSurfacesSnapshot>();
    const bridge = installBridge(
      () =>
        Promise.resolve(
          snapshot({
            revision: 9,
            slots: ownedBy(),
            choices: { emptyCanvas: record("acme.dash", "surface", 9) },
          })
        ),
      { setChoice: () => save.promise }
    );
    state().init();
    const pending = state().setSurfaceChoice("emptyCanvas", "stock");
    await flush();
    expect(bridge.getProjectSurfaces).toHaveBeenCalled();

    save.resolve(
      snapshot({
        revision: 8,
        slots: ownedBy(),
        choices: { emptyCanvas: record("acme.dash", "stock", 8) },
      })
    );
    await pending;

    expect(canvasChoice()).toBe("surface");
  });

  it("never restores a claim from a read older than a change main announced", async () => {
    const first = deferred<Read>();
    let calls = 0;
    const bridge = installBridge(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.reject(new Error("nope"));
    });

    state().init();
    // The plugin unloads while the first read is in flight, and the read that
    // announcement triggers fails, leaving the canvas on stock.
    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 2 });
    await flush();
    expect(state().surfaces).toEqual({});

    // The first read lands late with the claim as it was before the release.
    first.resolve(snapshot({ revision: 1, slots: ownedBy() }));
    await flush();

    expect(state().surfaces).toEqual({});
  });

  it("keeps a save's snapshot when the read started before it fails", async () => {
    let failPending!: (error: Error) => void;
    const pending = new Promise<Read>((_resolve, reject) => {
      failPending = reject;
    });
    let calls = 0;
    const bridge = installBridge(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(snapshot({ revision: 1, slots: ownedBy() })) : pending;
    });
    state().init();
    await flush();

    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 2 });
    await state().setSurfaceChoice("emptyCanvas", "stock");
    expect(canvasChoice()).toBe("stock");

    // The save is at least as new as anything that read would have seen, so
    // its failure must not clear what the save just put on screen.
    failPending(new Error("nope"));
    await flush();

    expect(state().surfaces).toEqual({ emptyCanvas: claim });
    expect(canvasChoice()).toBe("stock");
  });

  it("ignores a read that settles after a reset", async () => {
    const read = deferred<Read>();
    installBridge(() => read.promise);
    state().init();

    _resetPluginProjectSurfacesStoreForTest();
    read.resolve(snapshot({ revision: 1, slots: ownedBy(), projectId: "p-old" }));
    await flush();

    expect(state().surfaces).toEqual({});
    expect(state().choicesProjectId).toBeNull();
  });

  it("lets another project's push before binding hold back nothing of this one's", async () => {
    let bound = false;
    const bridge = installBridge(() =>
      Promise.resolve(bound ? snapshot({ revision: 20, slots: ownedBy() }) : null)
    );
    state().init();
    await flush();

    // Main falls back to every view while none is registered, so a view that
    // doesn't know its project yet can hear another project's change.
    bridge.surfaceListeners[0]?.({ projectId: "p-other", revision: 100 });
    await flush();

    bound = true;
    bridge.listeners[0]?.();
    await flush();

    expect(state().choicesProjectId).toBe(PROJECT);
    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("ignores a save that settles after a reset, answered or failed", async () => {
    const answered = deferred<ProjectSurfacesSnapshot>();
    let failSave!: (error: Error) => void;
    const failed = new Promise<ProjectSurfacesSnapshot>((_resolve, reject) => {
      failSave = reject;
    });
    let saves = 0;
    installBridge(null, {
      setChoice: () => {
        saves += 1;
        return saves === 1 ? answered.promise : failed;
      },
    });
    usePluginProjectSurfacesStore.setState({ slots: ownedBy(), surfaces: { emptyCanvas: claim } });
    const first = state().setSurfaceChoice("emptyCanvas", "stock");
    const second = state().setSurfaceChoice("emptyCanvas", "surface");

    _resetPluginProjectSurfacesStoreForTest();
    answered.resolve(
      snapshot({
        revision: 5,
        slots: ownedBy(),
        choices: { emptyCanvas: record("acme.dash", "stock") },
      })
    );
    failSave(new Error("ENOSPC"));
    await Promise.all([first, second]);

    expect(state().choices).toEqual({});
    expect(state().choicesProjectId).toBeNull();
    expect(state().failedSave).toBeNull();
  });

  it("refuses a snapshot naming a different project", async () => {
    let current = snapshot({ revision: 1, slots: ownedBy() });
    const bridge = installBridge(() => Promise.resolve(current));
    state().init();
    await flush();
    expect(state().choicesProjectId).toBe(PROJECT);

    current = snapshot({
      revision: 2,
      projectId: "p2",
      choices: { emptyCanvas: record("acme.dash", "stock") },
    });
    bridge.listeners[0]?.();
    await flush();

    expect(state().choices).toEqual({});
    expect(state().surfaces).toEqual({ emptyCanvas: claim });
  });

  it("detaches every listener on reset", async () => {
    const bridge = installBridge(snapshot());
    state().init();
    await flush();

    _resetPluginProjectSurfacesStoreForTest();

    expect(bridge.listeners).toHaveLength(0);
    expect(bridge.surfaceListeners).toHaveLength(0);
  });
});

describe("selectSurfaceRefusals", () => {
  it("lists one plugin's refusals across slots, and none for an unknown plugin", () => {
    const slots = ownedBy();
    slots.emptyCanvas.refused = [
      {
        slot: "emptyCanvas",
        pluginId: "project__p1__other.dash",
        reason: "outranked",
        heldBy: claim.pluginId,
      },
    ];

    expect(selectSurfaceRefusals(slots, "project__p1__other.dash")).toEqual(
      slots.emptyCanvas.refused
    );
    expect(selectSurfaceRefusals(slots, claim.pluginId)).toEqual([]);
    expect(selectSurfaceRefusals(slots, undefined)).toEqual([]);
  });
});

describe("shared slot answers", () => {
  it("lists the slots a plugin set up, with the answer about each", () => {
    expect(claimedSurfaceSlots(ownedBy(), {})).toEqual([
      { slot: "emptyCanvas", pluginId: claim.pluginId, choice: null },
    ]);
    expect(claimedSurfaceSlots(ownedBy(), { emptyCanvas: record("acme.dash", "stock") })).toEqual([
      { slot: "emptyCanvas", pluginId: claim.pluginId, choice: "stock" },
    ]);
    // An answer about the slot's previous owner says nothing about this one.
    expect(claimedSurfaceSlots(ownedBy(), { emptyCanvas: record("acme.other", "stock") })).toEqual([
      { slot: "emptyCanvas", pluginId: claim.pluginId, choice: null },
    ]);
  });

  it("leaves out a slot nobody holds, even one with refused claims", () => {
    const slots = ownedBy();
    slots.emptyCanvas.options = [];
    slots.emptyCanvas.defaultOptionId = null;
    slots.emptyCanvas.refused = [
      { slot: "emptyCanvas", pluginId: "installed.dash", reason: "installed-exclusive" },
    ];

    expect(claimedSurfaceSlots(slots, {})).toEqual([]);
  });

  it("treats a selectable slot's answer as about the slot, whichever option is the default", () => {
    const selectable: ProjectSurfaceSlotState = {
      mode: "selectable",
      options: [
        {
          pluginId: "project__p1__acme.dash",
          scope: "project",
          value: { kind: "view", viewId: "tree" },
        },
        { pluginId: "installed.tree", scope: "installed", value: { kind: "view", viewId: "tree" } },
      ],
      defaultOptionId: "project__p1__acme.dash",
      refused: [],
    };

    expect(surfaceSlotChoice(selectable, undefined)).toBeNull();
    expect(surfaceSlotChoice(selectable, { pluginId: "", choice: "stock", decidedAt: 1 })).toBe(
      "stock"
    );
    // No project default: an installed option is offered, never applied, so
    // there is nothing set up to answer about.
    expect(
      surfaceSlotChoice(
        { ...selectable, defaultOptionId: null },
        { pluginId: "", choice: "stock", decidedAt: 1 }
      )
    ).toBeNull();
  });

  it("asks one plugin's question in the first of its unanswered slots on screen", () => {
    // Only `emptyCanvas` is catalogued, so the slots here are named rather
    // than added to the production catalogue: the election takes any names.
    const claimed = [
      { slot: "emptyCanvas", pluginId: "project__p1__acme", choice: "stock" as const },
      { slot: "sidebar", pluginId: "project__p1__acme", choice: null },
      { slot: "home", pluginId: "project__p1__acme", choice: null },
    ];

    // Answered slots never host it, and neither do slots with no frame up.
    expect(consentHostSlot(claimed, "project__p1__acme", new Set(["emptyCanvas"]))).toBeNull();
    expect(consentHostSlot(claimed, "project__p1__acme", new Set(["home"]))).toBe("home");
    // Two frames up: the first in catalogue order asks, the other stays quiet.
    expect(consentHostSlot(claimed, "project__p1__acme", new Set(["home", "sidebar"]))).toBe(
      "sidebar"
    );
    // Another plugin's frame never asks this plugin's question.
    expect(consentHostSlot(claimed, "project__p1__other", new Set(["sidebar", "home"]))).toBeNull();
  });

  it("records an exclusive answer without naming an option", () => {
    expect(
      surfaceAnswerUpdates(
        [{ slot: "emptyCanvas", pluginId: claim.pluginId, choice: null }],
        "surface"
      )
    ).toEqual([{ slot: "emptyCanvas", choice: "surface", ownerId: claim.pluginId }]);
  });

  it("records who an answer was about when it was sent, not when it failed", async () => {
    let fail!: (error: Error) => void;
    installBridge(null, {
      setChoice: () =>
        new Promise<ProjectSurfacesSnapshot>((_resolve, reject) => {
          fail = reject;
        }),
    });
    usePluginProjectSurfacesStore.setState({ slots: ownedBy(), choicesLoaded: true });

    const pending = state().setSurfaceChoice("emptyCanvas", "stock");
    // The slot passes to another plugin while the save is in flight.
    usePluginProjectSurfacesStore.setState({ slots: ownedBy("project__p1__acme.other") });
    fail(new Error("ENOSPC"));
    await pending;

    expect(state().failedSave?.owners).toEqual({ emptyCanvas: "acme.dash" });
    expect(selectFailedSave(state(), "emptyCanvas")).toBeNull();
  });
});

describe("a save that fails after something newer", () => {
  it("offers no retry once another view's answer has landed meanwhile", async () => {
    let current = snapshot({ revision: 1, slots: ownedBy() });
    let fail!: (error: Error) => void;
    const bridge = installBridge(() => Promise.resolve(current), {
      setChoice: () =>
        new Promise<ProjectSurfacesSnapshot>((_resolve, reject) => {
          fail = reject;
        }),
    });
    state().init();
    await flush();

    const pending = state().setSurfaceChoice("emptyCanvas", "stock");
    // Another view keeps the plugin's canvas while this save is in flight.
    current = snapshot({
      revision: 2,
      slots: ownedBy(),
      choices: { emptyCanvas: record("acme.dash", "surface") },
    });
    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 2 });
    await flush();
    fail(new Error("ENOSPC"));
    await pending;

    // Retrying "stock" now would overwrite the newer answer.
    expect(state().failedSave).toBeNull();
    expect(canvasChoice()).toBe("surface");
  });

  it("still offers the retry when only an unrelated change landed meanwhile", async () => {
    let current = snapshot({ revision: 1, slots: ownedBy() });
    let fail!: (error: Error) => void;
    const bridge = installBridge(() => Promise.resolve(current), {
      setChoice: () =>
        new Promise<ProjectSurfacesSnapshot>((_resolve, reject) => {
          fail = reject;
        }),
    });
    state().init();
    await flush();

    const pending = state().setSurfaceChoice("emptyCanvas", "stock");
    // Another plugin's claim was refused while the save was in flight: the
    // slot state moved, the answers did not.
    current = snapshot({ revision: 2, slots: ownedBy() });
    bridge.surfaceListeners[0]?.({ projectId: PROJECT, revision: 2 });
    await flush();
    fail(new Error("ENOSPC"));
    await pending;

    expect(selectFailedSave(state(), "emptyCanvas")?.updates).toEqual([
      { slot: "emptyCanvas", choice: "stock", ownerId: claim.pluginId },
    ]);
  });

  it("keeps the retry of the latest save when an earlier one fails after it", async () => {
    let failFirst!: (error: Error) => void;
    let saves = 0;
    installBridge(null, {
      setChoice: () => {
        saves += 1;
        if (saves === 1) {
          return new Promise<ProjectSurfacesSnapshot>((_resolve, reject) => {
            failFirst = reject;
          });
        }
        return Promise.reject(new Error("ENOSPC"));
      },
    });
    usePluginProjectSurfacesStore.setState({ slots: ownedBy(), choicesLoaded: true });

    const first = state().setSurfaceChoice("emptyCanvas", "stock");
    await state().setSurfaceChoice("emptyCanvas", "surface");
    failFirst(new Error("ENOSPC"));
    await first;

    // Nothing was recorded either way, so only the order of the saves can say
    // which retry still means what the user last asked for.
    expect(selectFailedSave(state(), "emptyCanvas")?.updates).toEqual([
      { slot: "emptyCanvas", choice: "surface", ownerId: claim.pluginId },
    ]);
  });
});
