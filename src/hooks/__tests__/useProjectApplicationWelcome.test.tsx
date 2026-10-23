// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginLayoutConfig,
  ProjectApplicationState,
  ProjectWelcomeRecord,
} from "@shared/types/plugin";

const { tours, registryListeners, view, requestTour, notify, actions } = vi.hoisted(() => ({
  tours: new Map<string, { summary: { id: string; title: string; minutes: number } }>(),
  registryListeners: new Set<() => void>(),
  view: { observable: true, listeners: new Set<(observable: boolean) => void>() },
  requestTour: vi.fn(),
  notify: vi.fn(),
  actions: { snapshot: new Map<string, string>(), listeners: new Set<() => void>() },
}));

vi.mock("@/components/Tour/tourRegistry", () => ({
  getTour: (id: string) => tours.get(id),
  subscribeToTourRegistry: (listener: () => void) => {
    registryListeners.add(listener);
    return () => registryListeners.delete(listener);
  },
}));
vi.mock("@/components/Tour/tourRequests", () => ({ requestTour }));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: () => view.observable,
  subscribeProjectViewObservability: (listener: (observable: boolean) => void) => {
    view.listeners.add(listener);
    return () => view.listeners.delete(listener);
  },
}));
vi.mock("@/lib/notify", () => ({ notify }));
// The real module reaches the terminal services through the layout applier.
vi.mock("@/hooks/useProjectLayoutSeed", () => ({
  selectProjectDefaultLayout: (layouts: readonly PluginLayoutConfig[]) =>
    layouts.find((layout) => layout.projectDefault === true) ?? null,
}));
vi.mock("@/services/plugin/registeredPluginActions", () => ({
  getRegisteredPluginActionsSnapshot: () => actions.snapshot,
  subscribeToRegisteredPluginActions: (listener: () => void) => {
    actions.listeners.add(listener);
    return () => actions.listeners.delete(listener);
  },
}));

import {
  _resetProjectApplicationWelcomeForTest,
  dismissProjectWelcomeHandoff,
  skipProjectWelcome,
  startProjectWelcome,
  useProjectApplicationWelcome,
} from "../useProjectApplicationWelcome";
import { TOUR_COMPLETED_EVENT } from "@/components/Tour/tourEvents";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import {
  _resetProjectLayoutSeedStoreForTest,
  useProjectLayoutSeedStore,
} from "@/store/projectLayoutSeedStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import {
  _resetProjectWelcomeStoreForTest,
  useProjectWelcomeStore,
} from "@/store/projectWelcomeStore";
import { useUIStore } from "@/store/uiStore";

const INSTANCE = "project__p1__acme.ledger";
const TOUR_ID = `${INSTANCE}.welcome`;

let stored: ProjectWelcomeRecord | null;
const getProjectWelcome = vi.fn(async () => stored);
const setProjectWelcome = vi.fn(
  async (
    _owner: string,
    _tour: string,
    version: number,
    status: ProjectWelcomeRecord["status"]
  ) => {
    stored = { version, status, at: 1 };
    return stored;
  }
);

function application(overrides: Partial<ProjectApplicationState> = {}): ProjectApplicationState {
  return {
    status: "active",
    ownerId: "acme.ledger",
    version: "1.0.0",
    instanceId: INSTANCE,
    application: {
      name: "Ledger",
      destination: "home",
      welcomeTour: { id: "welcome", version: 2 },
      firstWorkflow: "record-transaction",
    },
    fallback: null,
    ...overrides,
  };
}

function defaultLayout(): PluginLayoutConfig {
  return {
    id: `${INSTANCE}.workbench`,
    pluginId: INSTANCE,
    pluginName: "Ledger",
    name: "Workbench",
    entries: [],
    projectDefault: true,
  };
}

function registerTour(): void {
  tours.set(TOUR_ID, { summary: { id: TOUR_ID, title: "Welcome Tour", minutes: 3 } });
  act(() => {
    for (const listener of [...registryListeners]) listener();
  });
}

function setObservable(observable: boolean): void {
  view.observable = observable;
  act(() => {
    for (const listener of [...view.listeners]) listener(observable);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function offer() {
  return useProjectWelcomeStore.getState().offer;
}

async function mountActive(): Promise<void> {
  useProjectPluginStore.setState({ application: application() });
  renderHook(() => useProjectApplicationWelcome(true));
  await flush();
}

describe("useProjectApplicationWelcome (#14106)", () => {
  beforeEach(() => {
    stored = null;
    tours.clear();
    registryListeners.clear();
    view.observable = true;
    view.listeners.clear();
    actions.snapshot = new Map([[`${INSTANCE}.record-transaction`, "Record a transaction"]]);
    actions.listeners.clear();
    vi.clearAllMocks();
    _resetProjectApplicationWelcomeForTest();
    _resetProjectWelcomeStoreForTest();
    _resetProjectLayoutSeedStoreForTest();
    useProjectLayoutSeedStore.setState({ status: "settled" });
    usePluginLayoutsStore.setState({ layouts: [] });
    useProjectPluginStore.setState({ application: null });
    useUIStore.setState({ overlayStack: [] });
    tours.set(TOUR_ID, { summary: { id: TOUR_ID, title: "Welcome Tour", minutes: 3 } });
    Object.defineProperty(window, "electron", {
      value: { plugin: { getProjectWelcome, setProjectWelcome } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "electron");
  });

  it("offers the welcome once the application is active, and only then", async () => {
    // Delayed trust: the application is disabled until the user trusts it.
    useProjectPluginStore.setState({
      application: application({
        status: "disabled",
        reason: "untrusted",
        fallback: "standard-workspace",
      }),
    });
    renderHook(() => useProjectApplicationWelcome(true));
    await flush();
    expect(offer()).toBeNull();
    expect(getProjectWelcome).not.toHaveBeenCalled();

    act(() => useProjectPluginStore.setState({ application: application() }));
    await flush();
    expect(getProjectWelcome).toHaveBeenCalledWith("acme.ledger", "welcome");
    expect(offer()).toEqual(
      expect.objectContaining({ tourId: TOUR_ID, appName: "Ledger", version: 2, minutes: 3 })
    );
    // Offered, never played.
    expect(requestTour).not.toHaveBeenCalled();
  });

  it("never offers in a background view, and offers when the view comes on screen", async () => {
    view.observable = false;
    await mountActive();
    expect(offer()).toBeNull();

    setObservable(true);
    expect(offer()?.tourId).toBe(TOUR_ID);

    // Once shown, going to the background doesn't withdraw it.
    setObservable(false);
    expect(offer()?.tourId).toBe(TOUR_ID);
  });

  it("waits behind an open dialog — host setup, trust, another tour", async () => {
    useUIStore.setState({ overlayStack: ["agent-setup"] });
    await mountActive();
    expect(offer()).toBeNull();

    act(() => useUIStore.setState({ overlayStack: [] }));
    expect(offer()?.tourId).toBe(TOUR_ID);
  });

  it("waits for the first-open layout to be applied, or for its failure to be dealt with", async () => {
    const layout = defaultLayout();
    usePluginLayoutsStore.setState({ layouts: [layout] });
    useProjectLayoutSeedStore.setState({ status: "pending" });
    await mountActive();
    expect(offer()).toBeNull();

    act(() => useProjectLayoutSeedStore.setState({ status: "applying" }));
    act(() => useProjectLayoutSeedStore.setState({ status: "failed" }));
    expect(offer()).toBeNull();

    act(() => useProjectLayoutSeedStore.setState({ status: "settled" }));
    expect(offer()?.tourId).toBe(TOUR_ID);
  });

  it("waits while the layout is offered, and steps aside for a layout that arrives late", async () => {
    await mountActive();
    expect(offer()?.tourId).toBe(TOUR_ID);

    // The plugin's default layout registers after its application went active.
    const layout = defaultLayout();
    act(() => {
      useProjectLayoutSeedStore.setState({ status: "offered" });
      usePluginLayoutsStore.setState({ layouts: [layout] });
    });
    expect(offer()).toBeNull();

    act(() => useProjectLayoutSeedStore.setState({ status: "settled" }));
    expect(offer()?.tourId).toBe(TOUR_ID);
  });

  it("doesn't wait on a pending seed when no layout is coming", async () => {
    useProjectLayoutSeedStore.setState({ status: "pending" });
    await mountActive();
    expect(offer()?.tourId).toBe(TOUR_ID);
  });

  it("stays quiet for a welcome answered at this revision — after a restart or in another window", async () => {
    stored = { version: 2, status: "skipped", at: 1 };
    await mountActive();
    expect(offer()).toBeNull();
  });

  it("offers again once the application raises its welcome revision", async () => {
    stored = { version: 1, status: "completed", at: 1 };
    await mountActive();
    expect(offer()?.version).toBe(2);
  });

  it("offers nothing for an unavailable application, or until its tour registers", async () => {
    useProjectPluginStore.setState({
      application: application({
        status: "unavailable",
        reason: "load-failed",
        fallback: "standard-workspace",
      }),
    });
    renderHook(() => useProjectApplicationWelcome(true));
    await flush();
    expect(offer()).toBeNull();

    tours.clear();
    act(() => useProjectPluginStore.setState({ application: application() }));
    await flush();
    expect(offer()).toBeNull();

    registerTour();
    expect(offer()?.tourId).toBe(TOUR_ID);

    // Withdrawn while on offer: nothing to start.
    tours.clear();
    act(() => {
      for (const listener of [...registryListeners]) listener();
    });
    expect(offer()).toBeNull();
  });

  it("offers nothing when reading the record fails, and reads again on coming back on screen", async () => {
    getProjectWelcome.mockRejectedValueOnce(new Error("EACCES"));
    await mountActive();
    expect(offer()).toBeNull();

    setObservable(false);
    setObservable(true);
    await flush();
    expect(offer()?.tourId).toBe(TOUR_ID);
  });

  it("withdraws the offer once another window answered it", async () => {
    await mountActive();
    expect(offer()?.tourId).toBe(TOUR_ID);

    // The other window skipped it; this one learns when it takes focus.
    stored = { version: 2, status: "skipped", at: 3 };
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(offer()).toBeNull();
    // Answered elsewhere: no hand-off here.
    expect(useProjectWelcomeStore.getState().handoff).toBeNull();
  });

  it("ignores a read that lands after the user answered here", async () => {
    await mountActive();
    let resolveRead: (record: ProjectWelcomeRecord | null) => void = () => {};
    getProjectWelcome.mockImplementationOnce(
      () => new Promise<ProjectWelcomeRecord | null>((resolve) => (resolveRead = resolve))
    );
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(() => skipProjectWelcome());
    resolveRead(null);
    await flush();
    expect(offer()).toBeNull();
  });

  it("records a skip and hands off to the first workflow", async () => {
    await mountActive();
    await act(() => skipProjectWelcome());

    expect(setProjectWelcome).toHaveBeenCalledWith("acme.ledger", "welcome", 2, "skipped");
    expect(offer()).toBeNull();
    expect(useProjectWelcomeStore.getState().handoff).toEqual({
      appName: "Ledger",
      actionId: `${INSTANCE}.record-transaction`,
      title: "Record a transaction",
      skipped: true,
      tourTitle: "Welcome Tour",
    });
  });

  it("records the tour played to the end, however it was opened", async () => {
    await mountActive();
    act(() => {
      window.dispatchEvent(new CustomEvent(TOUR_COMPLETED_EVENT, { detail: { tourId: "other" } }));
    });
    await flush();
    expect(setProjectWelcome).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new CustomEvent(TOUR_COMPLETED_EVENT, { detail: { tourId: TOUR_ID } }));
    });
    await flush();
    expect(setProjectWelcome).toHaveBeenCalledWith("acme.ledger", "welcome", 2, "completed");
    expect(offer()).toBeNull();
    expect(useProjectWelcomeStore.getState().handoff?.skipped).toBe(false);
  });

  it("follows the first workflow's registration, and stays dismissed", async () => {
    actions.snapshot = new Map();
    await mountActive();
    await act(() => skipProjectWelcome());
    expect(useProjectWelcomeStore.getState().handoff).toBeNull();

    const notifyActions = (): void =>
      act(() => {
        for (const listener of [...actions.listeners]) listener();
      });
    actions.snapshot = new Map([[`${INSTANCE}.record-transaction`, "Record a transaction"]]);
    notifyActions();
    expect(useProjectWelcomeStore.getState().handoff?.actionId).toBe(
      `${INSTANCE}.record-transaction`
    );

    // Withdrawn: no dead button.
    actions.snapshot = new Map();
    notifyActions();
    expect(useProjectWelcomeStore.getState().handoff).toBeNull();

    actions.snapshot = new Map([[`${INSTANCE}.record-transaction`, "Record a transaction"]]);
    notifyActions();
    act(() => dismissProjectWelcomeHandoff());
    notifyActions();
    expect(useProjectWelcomeStore.getState().handoff).toBeNull();
  });

  it("keeps the welcome on offer and says so when it can't start", async () => {
    await mountActive();
    requestTour.mockResolvedValueOnce({
      status: "unavailable",
      tourId: TOUR_ID,
      reason: "no-host",
    });
    await act(() => startProjectWelcome());

    expect(requestTour).toHaveBeenCalledWith([TOUR_ID]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't start welcome" })
    );
    expect(setProjectWelcome).not.toHaveBeenCalled();
    expect(offer()?.tourId).toBe(TOUR_ID);
  });

  it("leaves a tour that failed to load to the tour host's own report", async () => {
    await mountActive();
    requestTour.mockResolvedValueOnce({ status: "failed", tourId: TOUR_ID, reason: "import" });
    await act(() => startProjectWelcome());
    expect(notify).not.toHaveBeenCalled();
    expect(offer()?.tourId).toBe(TOUR_ID);
  });

  it("withdraws the offer and hand-off when the application stops being active", async () => {
    await mountActive();
    await act(() => skipProjectWelcome());
    act(() =>
      useProjectPluginStore.setState({
        application: application({
          status: "replaced",
          heldBy: "x",
          fallback: "standard-workspace",
        }),
      })
    );
    expect(useProjectWelcomeStore.getState().handoff).toBeNull();
  });
});
