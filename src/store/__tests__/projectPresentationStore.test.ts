// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresentationLevel, PresentationLevels } from "@shared/config/presentationProfile";
import type { ProjectPresentationSnapshot } from "@shared/types/ipc/projectPresentation";
import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "../projectPresentationStore";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);

const snapshot = (
  levels: PresentationLevels = {},
  overrides: Partial<ProjectPresentationSnapshot> = {}
): ProjectPresentationSnapshot => ({
  projectId: PROJECT,
  levels,
  suggestion: null,
  suggestionAnswer: null,
  useProjectToolbar: null,
  promotedPluginButtons: [],
  launcherGroupOrder: [],
  featuredLaunchEntry: null,
  revision: 0,
  ...overrides,
});

type ChangedCallback = (payload: ProjectPresentationSnapshot) => void;

function installBridge(
  options: {
    get?: () => Promise<ProjectPresentationSnapshot | null>;
    setLevel?: (
      feature: string,
      level: PresentationLevel | null
    ) => Promise<ProjectPresentationSnapshot>;
    /** Further bridge methods, beside the four every test gets. */
    extra?: Record<string, unknown>;
  } = {}
) {
  const listeners: ChangedCallback[] = [];
  let revision = 0;
  const get = vi.fn(options.get ?? (() => Promise.resolve(snapshot())));
  const setLevel = vi.fn(
    options.setLevel ??
      ((_feature: string, level: PresentationLevel | null) =>
        Promise.resolve(
          snapshot(level === null ? {} : { forgeStats: level }, { revision: ++revision })
        ))
  );
  const answerSuggestion = vi.fn(() => Promise.resolve(snapshot()));
  const onChanged = vi.fn((cb: ChangedCallback) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  // `defineProperty` rather than an assignment + cast: a partial stub of the
  // full `ElectronAPI` would need a type assertion the lint ratchet counts.
  Object.defineProperty(window, "electron", {
    value: {
      projectPresentation: { get, setLevel, answerSuggestion, onChanged, ...options.extra },
    },
    configurable: true,
    writable: true,
  });
  return { get, setLevel, answerSuggestion, onChanged, listeners };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = () => useProjectPresentationStore.getState();

beforeEach(() => {
  _resetProjectPresentationStoreForTest();
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  _resetProjectPresentationStoreForTest();
});

describe("projectPresentationStore", () => {
  it("pulls the sender project's profile once, without naming a project", async () => {
    const bridge = installBridge({
      get: () => Promise.resolve(snapshot({ forgeStats: "hidden" })),
    });

    state().init();
    state().init();
    await flush();

    expect(bridge.get).toHaveBeenCalledTimes(1);
    expect(bridge.get).toHaveBeenCalledWith();
    expect(state()).toMatchObject({
      loaded: true,
      projectId: PROJECT,
      levels: { forgeStats: "hidden" },
    });
  });

  it("stays unloaded while main has no project for the sender, and reads again", async () => {
    vi.useFakeTimers();
    try {
      const bridge = installBridge();
      bridge.get.mockResolvedValueOnce(null);

      state().init();
      await vi.advanceTimersByTimeAsync(0);
      expect(state().loaded).toBe(false);

      // Main binds the view a moment later; the retry finds it.
      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.get).toHaveBeenCalledTimes(2);
      expect(state().loaded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up re-reading an unbound sender after a few tries", async () => {
    vi.useFakeTimers();
    try {
      const bridge = installBridge({ get: () => Promise.resolve(null) });
      state().init();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.get).toHaveBeenCalledTimes(4);
      expect(state()).toMatchObject({ loaded: false, loadFailed: true });

      // The view learning its project asks once more, with fresh retries.
      bridge.get.mockResolvedValueOnce(snapshot({ forgeStats: "hidden" }));
      state().ensureLoaded();
      await vi.advanceTimersByTimeAsync(0);
      expect(state()).toMatchObject({ loaded: true, loadFailed: false });
      state().ensureLoaded();
      expect(bridge.get).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a read that failed outright, not just one that came back unbound", async () => {
    vi.useFakeTimers();
    try {
      const bridge = installBridge();
      bridge.get.mockRejectedValueOnce(new Error("host restarting"));
      state().init();
      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.get).toHaveBeenCalledTimes(2);
      expect(state().loaded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a pending re-read once a push has delivered the profile", async () => {
    vi.useFakeTimers();
    try {
      const bridge = installBridge({ get: () => Promise.resolve(null) });
      state().init();
      await vi.advanceTimersByTimeAsync(0);

      bridge.listeners[0]!(snapshot({ forgeStats: "demoted" }, { revision: 1 }));
      await vi.advanceTimersByTimeAsync(10_000);

      expect(bridge.get).toHaveBeenCalledTimes(1);
      expect(state().levels).toEqual({ forgeStats: "demoted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays retryable when the bridge is missing", () => {
    state().init();
    const bridge = installBridge();
    state().init();
    expect(bridge.get).toHaveBeenCalledTimes(1);
  });

  it("refuses a push addressed to another project", async () => {
    const bridge = installBridge();
    state().init();
    await flush();

    bridge.listeners[0]!(snapshot({ forgeStats: "hidden" }, { projectId: OTHER }));
    expect(state().levels).toEqual({});

    bridge.listeners[0]!(snapshot({ forgeStats: "demoted" }));
    expect(state().levels).toEqual({ forgeStats: "demoted" });
  });

  it("never lets a slow pull roll back a push that landed while it was in flight", async () => {
    const pending = deferred<ProjectPresentationSnapshot | null>();
    const bridge = installBridge({ get: () => pending.promise });
    state().init();

    bridge.listeners[0]!(snapshot({ forgeStats: "demoted" }, { revision: 1 }));
    pending.resolve(snapshot());
    await flush();

    expect(state().levels).toEqual({ forgeStats: "demoted" });
  });

  it("drops a snapshot older than the one it holds, whichever lane it came on", async () => {
    const bridge = installBridge();
    state().init();
    await flush();

    // A remote view's push and invoke reply travel separately; the reply for a
    // newer write can land first.
    await state().setLevel("forgeStats", "hidden");
    expect(state().revision).toBe(1);
    bridge.listeners[0]!(snapshot({ forgeStats: "demoted" }, { revision: 0 }));
    expect(state().levels).toEqual({ forgeStats: "hidden" });
  });

  it("adopts what main recorded, and keeps a failed write for a retry", async () => {
    const bridge = installBridge();
    state().init();
    await flush();

    await state().setLevel("forgeStats", "hidden");
    expect(bridge.setLevel).toHaveBeenCalledWith("forgeStats", "hidden");
    expect(state().levels).toEqual({ forgeStats: "hidden" });

    bridge.setLevel.mockRejectedValueOnce(new Error("disk full"));
    await state().setLevel("forgeStats", "demoted");
    expect(state().levels).toEqual({ forgeStats: "hidden" });
    expect(state().failedSave).toEqual({ kind: "level", feature: "forgeStats", level: "demoted" });

    // A plain read records nothing, so the Retry stays — and the read did land.
    bridge.get.mockResolvedValue(
      snapshot({ forgeStats: "hidden" }, { revision: 1, suggestion: { levels: {}, hash: "s" } })
    );
    state().refresh();
    await flush();
    expect(state().suggestion?.hash).toBe("s");
    expect(state().failedSave).not.toBeNull();

    // A push for the write that already landed says nothing about the later
    // failure, even though it arrives after it.
    bridge.listeners[0]!(snapshot({ forgeStats: "hidden" }, { revision: 1 }));
    expect(state().failedSave).not.toBeNull();

    // Any write main records afterwards is newer than the one that failed.
    bridge.listeners[0]!(snapshot({ forgeStats: "shown" }, { revision: 5 }));
    expect(state().failedSave).toBeNull();
  });

  it("lets a read nothing overtook move the revision down, so a reset store can't wedge a view", async () => {
    const bridge = installBridge({
      get: () => Promise.resolve(snapshot({ forgeStats: "hidden" }, { revision: 9 })),
    });
    state().init();
    await flush();
    expect(state().revision).toBe(9);

    // Main's store was reset; its count starts again.
    bridge.get.mockResolvedValue(snapshot({}, { revision: 0 }));
    state().refresh();
    await flush();

    expect(state()).toMatchObject({ revision: 0, levels: {} });
  });

  it("re-reads after a refused answer and drops a Retry that could never succeed", async () => {
    const stale = { levels: { forgeStats: "hidden" as const }, hash: "old" };
    const current = { levels: { forgeStats: "demoted" as const }, hash: "new" };
    const bridge = installBridge({
      get: () => Promise.resolve(snapshot({}, { suggestion: stale })),
    });
    state().init();
    await flush();

    bridge.get.mockResolvedValue(snapshot({}, { suggestion: current }));
    bridge.answerSuggestion.mockRejectedValueOnce(new Error("suggestion has changed"));
    await state().answerSuggestion("old", "accepted");
    await flush();

    expect(bridge.get).toHaveBeenCalledTimes(2);
    expect(state().suggestion).toEqual(current);
    expect(state().failedSave).toBeNull();
  });

  it("holds the notice still while an answer is in flight", async () => {
    const pending = deferred<ProjectPresentationSnapshot>();
    const bridge = installBridge();
    bridge.answerSuggestion.mockImplementationOnce(() => pending.promise);
    state().init();
    await flush();

    const answering = state().answerSuggestion("hash", "declined");
    expect(state().answering).toBe("declined");
    pending.resolve(snapshot());
    await answering;
    expect(state().answering).toBeNull();
  });
});

describe("projectPresentationStore toolbar writes (#13783)", () => {
  it("adopts the toolbar fields main records, and retries a failed promotion as it was", async () => {
    const promote = vi
      .fn<(buttonId: string, promoted: boolean) => Promise<ProjectPresentationSnapshot>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        snapshot({}, { revision: 5, promotedPluginButtons: ["p.run"], useProjectToolbar: true })
      );
    installBridge({ extra: { setPluginButtonPromoted: promote } });
    state().init();
    await flush();

    await state().setPluginButtonPromoted("p.run", true);
    expect(state().failedSave).toEqual({
      kind: "pluginPromotion",
      buttonId: "p.run",
      promoted: true,
    });
    expect(state().promotedPluginButtons).toEqual([]);

    state().retryFailedSave();
    await flush();
    expect(promote).toHaveBeenLastCalledWith("p.run", true);
    expect(state().failedSave).toBeNull();
    expect(state().promotedPluginButtons).toEqual(["p.run"]);
    expect(state().useProjectToolbar).toBe(true);
  });

  it("reads a snapshot from a main without toolbar fields as never set", async () => {
    const legacy = {
      projectId: PROJECT,
      levels: {},
      suggestion: null,
      suggestionAnswer: null,
      revision: 3,
    };
    Object.defineProperty(window, "electron", {
      value: {
        projectPresentation: {
          get: vi.fn(() => Promise.resolve(legacy)),
          onChanged: () => () => {},
        },
      },
      configurable: true,
      writable: true,
    });
    state().init();
    await flush();
    expect(state().loaded).toBe(true);
    expect(state().useProjectToolbar).toBeNull();
    expect(state().promotedPluginButtons).toEqual([]);
    expect(state().launcherGroupOrder).toEqual([]);
    expect(state().featuredLaunchEntry).toBeNull();
  });
});

describe("projectPresentationStore launcher writes (#13791)", () => {
  it("adopts the launcher fields main records, and retries a failed write as it was", async () => {
    const setOrder = vi
      .fn<(order: string[]) => Promise<ProjectPresentationSnapshot>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(snapshot({}, { revision: 4, launcherGroupOrder: ["recipes"] }));
    const setFeatured = vi.fn<(ref: string | null) => Promise<ProjectPresentationSnapshot>>(() =>
      Promise.resolve(
        snapshot({}, { revision: 5, launcherGroupOrder: ["recipes"], featuredLaunchEntry: "a.b.c" })
      )
    );
    installBridge({
      extra: { setLauncherGroupOrder: setOrder, setFeaturedLaunchEntry: setFeatured },
    });
    state().init();
    await flush();

    expect(await state().setLauncherGroupOrder(["recipes"])).toBe(false);
    expect(state().failedSave).toEqual({ kind: "launcherGroupOrder", order: ["recipes"] });
    expect(state().launcherGroupOrder).toEqual([]);

    state().retryFailedSave();
    await flush();
    expect(setOrder).toHaveBeenLastCalledWith(["recipes"]);
    expect(state().failedSave).toBeNull();
    expect(state().launcherGroupOrder).toEqual(["recipes"]);

    expect(await state().setFeaturedLaunchEntry("a.b.c")).toBe(true);
    expect(setFeatured).toHaveBeenCalledWith("a.b.c");
    expect(state().featuredLaunchEntry).toBe("a.b.c");
  });
});
