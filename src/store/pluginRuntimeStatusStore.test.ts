// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeStatus } from "@shared/types/plugin";
import {
  usePluginRuntimeStatusStore,
  _resetPluginRuntimeStatusStoreForTest,
} from "./pluginRuntimeStatusStore";

type Listener = (payload: { pluginId: string; status: PluginRuntimeStatus | null }) => void;

/** Install a preload stand-in without asserting over the real bridge type. */
function setBridge(value: unknown): void {
  Object.defineProperty(window, "electron", { value, configurable: true, writable: true });
}

interface BridgeHandles {
  emit: Listener;
  off: ReturnType<typeof vi.fn>;
  /** Settle the hydration pull the store fires after subscribing. */
  resolvePull: (statuses: PluginRuntimeStatus[]) => void;
  rejectPull: (error: Error) => void;
  getRuntimeStatuses: ReturnType<typeof vi.fn>;
}

function installBridge(opts: { withPull?: boolean } = {}): BridgeHandles {
  let listener: Listener = () => {};
  const off = vi.fn();
  let resolvePull: (statuses: PluginRuntimeStatus[]) => void = () => {};
  let rejectPull: (error: Error) => void = () => {};
  const pending = new Promise<PluginRuntimeStatus[]>((resolve, reject) => {
    resolvePull = resolve;
    rejectPull = reject;
  });
  const getRuntimeStatuses = vi.fn(() => pending);
  setBridge({
    events: {
      on: (name: string, cb: Listener) => {
        if (name === "plugin:runtime-status-changed") listener = cb;
        return off;
      },
    },
    plugin: opts.withPull === false ? {} : { getRuntimeStatuses },
  });
  return { emit: (payload) => listener(payload), off, resolvePull, rejectPull, getRuntimeStatuses };
}

function status(overrides: Partial<PluginRuntimeStatus> = {}): PluginRuntimeStatus {
  return {
    pluginId: "acme.dev",
    viewGeneration: 3,
    worker: { generation: 1, state: "ready", stateSince: 1_000, reason: null, detail: null },
    dev: { reloadCount: 1, watcher: "watching", detail: null },
    ...overrides,
  };
}

afterEach(() => {
  _resetPluginRuntimeStatusStoreForTest();
  Reflect.deleteProperty(window, "electron");
});

describe("pluginRuntimeStatusStore", () => {
  it("stores the whole snapshot each event carries, replacing any prior one", () => {
    const { emit } = installBridge();
    usePluginRuntimeStatusStore.getState().init();

    emit({ pluginId: "acme.dev", status: status({ viewGeneration: 3 }) });
    expect(usePluginRuntimeStatusStore.getState().statusById.get("acme.dev")?.viewGeneration).toBe(
      3
    );

    emit({ pluginId: "acme.dev", status: status({ viewGeneration: 4 }) });
    expect(usePluginRuntimeStatusStore.getState().statusById.get("acme.dev")?.viewGeneration).toBe(
      4
    );
  });

  it("carries production worker health for a plugin with no dev session", () => {
    const { emit } = installBridge();
    usePluginRuntimeStatusStore.getState().init();

    emit({
      pluginId: "acme.prod",
      status: status({
        pluginId: "acme.prod",
        dev: null,
        worker: {
          generation: 7,
          state: "failed",
          stateSince: 2_000,
          reason: "crash-loop",
          detail: "crashed a lot",
        },
      }),
    });

    const stored = usePluginRuntimeStatusStore.getState().statusById.get("acme.prod");
    expect(stored?.dev).toBe(null);
    expect(stored?.worker?.state).toBe("failed");
    expect(stored?.worker?.reason).toBe("crash-loop");
    expect(stored?.worker?.generation).toBe(7);
  });

  it("removes an instance on a null status", () => {
    const { emit } = installBridge();
    usePluginRuntimeStatusStore.getState().init();

    emit({ pluginId: "acme.dev", status: status() });
    emit({ pluginId: "acme.dev", status: null });
    expect(usePluginRuntimeStatusStore.getState().statusById.has("acme.dev")).toBe(false);
  });

  it("keeps instances independent of one another", () => {
    const { emit } = installBridge();
    usePluginRuntimeStatusStore.getState().init();

    emit({ pluginId: "a", status: status({ pluginId: "a", viewGeneration: 1 }) });
    emit({ pluginId: "b", status: status({ pluginId: "b", viewGeneration: 2 }) });
    emit({ pluginId: "a", status: null });

    const map = usePluginRuntimeStatusStore.getState().statusById;
    expect(map.has("a")).toBe(false);
    expect(map.get("b")?.viewGeneration).toBe(2);
  });

  it("subscribes only once across repeated init calls", () => {
    const { getRuntimeStatuses } = installBridge();
    const state = usePluginRuntimeStatusStore.getState();
    state.init();
    state.init();
    expect(getRuntimeStatuses).toHaveBeenCalledTimes(1);
  });

  it("stays retryable when the bridge is not there yet", () => {
    setBridge({});
    usePluginRuntimeStatusStore.getState().init();
    expect(usePluginRuntimeStatusStore.getState().statusById.size).toBe(0);

    const { emit } = installBridge();
    usePluginRuntimeStatusStore.getState().init();
    emit({ pluginId: "acme.dev", status: status() });
    expect(usePluginRuntimeStatusStore.getState().statusById.has("acme.dev")).toBe(true);
  });

  it("hydrates from the pull for instances no push has spoken for", async () => {
    const { resolvePull } = installBridge();
    usePluginRuntimeStatusStore.getState().init();

    resolvePull([status({ pluginId: "cold", viewGeneration: 9 })]);
    await vi.waitFor(() =>
      expect(usePluginRuntimeStatusStore.getState().statusById.has("cold")).toBe(true)
    );
    expect(usePluginRuntimeStatusStore.getState().statusById.get("cold")?.viewGeneration).toBe(9);
  });

  it("does not let a late pull response roll back a push that landed during it", async () => {
    const { emit, resolvePull } = installBridge();
    usePluginRuntimeStatusStore.getState().init();

    // The worker died inside the round trip. Main answered before that.
    emit({
      pluginId: "acme.dev",
      status: status({
        worker: {
          generation: 2,
          state: "failed",
          stateSince: 5_000,
          reason: "crash-loop",
          detail: null,
        },
      }),
    });
    resolvePull([status({ pluginId: "acme.dev" })]);
    await vi.waitFor(() => expect(usePluginRuntimeStatusStore.getState().statusById.size).toBe(1));

    expect(usePluginRuntimeStatusStore.getState().statusById.get("acme.dev")?.worker?.state).toBe(
      "failed"
    );
  });

  it("does not let a late pull response resurrect an instance a push removed", async () => {
    const { emit, resolvePull } = installBridge();
    usePluginRuntimeStatusStore.getState().init();

    emit({ pluginId: "gone", status: null });
    // A second instance the pull DOES own, so there is a positive signal to wait
    // on — waiting for "still absent" would pass before the pull even settled.
    resolvePull([status({ pluginId: "gone" }), status({ pluginId: "other" })]);
    await vi.waitFor(() =>
      expect(usePluginRuntimeStatusStore.getState().statusById.has("other")).toBe(true)
    );

    expect(usePluginRuntimeStatusStore.getState().statusById.has("gone")).toBe(false);
  });

  it("leaves pushed state intact when the hydration pull rejects", async () => {
    const { emit, rejectPull } = installBridge();
    usePluginRuntimeStatusStore.getState().init();

    emit({ pluginId: "acme.dev", status: status() });
    rejectPull(new Error("no service"));
    await vi.waitFor(() => expect(usePluginRuntimeStatusStore.getState().statusById.size).toBe(1));

    expect(usePluginRuntimeStatusStore.getState().statusById.has("acme.dev")).toBe(true);
  });

  it("still subscribes when the bridge exposes no snapshot pull", () => {
    const { emit } = installBridge({ withPull: false });
    usePluginRuntimeStatusStore.getState().init();

    emit({ pluginId: "acme.dev", status: status() });
    expect(usePluginRuntimeStatusStore.getState().statusById.has("acme.dev")).toBe(true);
  });
});
