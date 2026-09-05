// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginDevStatus } from "@shared/types/plugin";
import { usePluginDevStatusStore, _resetPluginDevStatusStoreForTest } from "./pluginDevStatusStore";

type Listener = (payload: { pluginId: string; status: PluginDevStatus | null }) => void;

/** Install a preload stand-in without asserting over the real bridge type. */
function setBridge(value: unknown): void {
  Object.defineProperty(window, "electron", { value, configurable: true, writable: true });
}

function installBridge(): { emit: Listener; off: ReturnType<typeof vi.fn> } {
  let listener: Listener = () => {};
  const off = vi.fn();
  setBridge({
    events: {
      on: (name: string, cb: Listener) => {
        if (name === "plugin:dev-status-changed") listener = cb;
        return off;
      },
    },
  });
  return { emit: (payload) => listener(payload), off };
}

function status(overrides: Partial<PluginDevStatus> = {}): PluginDevStatus {
  return {
    pluginId: "acme.dev",
    viewGeneration: 3,
    reloadCount: 1,
    watcher: "watching",
    detail: null,
    ...overrides,
  };
}

afterEach(() => {
  _resetPluginDevStatusStoreForTest();
  Reflect.deleteProperty(window, "electron");
});

describe("pluginDevStatusStore", () => {
  it("stores the whole snapshot each event carries, replacing any prior one", () => {
    const { emit } = installBridge();
    usePluginDevStatusStore.getState().init();

    emit({ pluginId: "acme.dev", status: status({ viewGeneration: 3 }) });
    expect(usePluginDevStatusStore.getState().statusById.get("acme.dev")?.viewGeneration).toBe(3);

    emit({ pluginId: "acme.dev", status: status({ viewGeneration: 4, reloadCount: 2 }) });
    const current = usePluginDevStatusStore.getState().statusById.get("acme.dev");
    expect(current?.viewGeneration).toBe(4);
    expect(current?.reloadCount).toBe(2);
  });

  it("drops the session when the status is null", () => {
    const { emit } = installBridge();
    usePluginDevStatusStore.getState().init();

    emit({ pluginId: "acme.dev", status: status() });
    emit({ pluginId: "acme.dev", status: null });

    expect(usePluginDevStatusStore.getState().statusById.has("acme.dev")).toBe(false);
  });

  it("keeps sessions for other plugins independent", () => {
    const { emit } = installBridge();
    usePluginDevStatusStore.getState().init();

    emit({ pluginId: "acme.dev", status: status() });
    emit({ pluginId: "other.dev", status: status({ pluginId: "other.dev", viewGeneration: 9 }) });
    emit({ pluginId: "acme.dev", status: null });

    const { statusById } = usePluginDevStatusStore.getState();
    expect(statusById.has("acme.dev")).toBe(false);
    expect(statusById.get("other.dev")?.viewGeneration).toBe(9);
  });

  it("carries the degraded state, which is what makes a dead watcher visible", () => {
    const { emit } = installBridge();
    usePluginDevStatusStore.getState().init();

    emit({
      pluginId: "acme.dev",
      status: status({ watcher: "degraded", detail: "Watcher stopped reporting changes" }),
    });

    const current = usePluginDevStatusStore.getState().statusById.get("acme.dev");
    expect(current?.watcher).toBe("degraded");
    expect(current?.detail).toBe("Watcher stopped reporting changes");
  });

  it("stays retryable when the bridge is not there yet", () => {
    // Leaf components call init() before the preload bridge is guaranteed; a
    // no-bridge call must not latch the guard and lock the store out forever.
    usePluginDevStatusStore.getState().init();
    const { emit } = installBridge();
    usePluginDevStatusStore.getState().init();

    emit({ pluginId: "acme.dev", status: status() });
    expect(usePluginDevStatusStore.getState().statusById.has("acme.dev")).toBe(true);
  });

  it("subscribes once across repeated init calls", () => {
    const on = vi.fn(() => vi.fn());
    setBridge({ events: { on } });

    usePluginDevStatusStore.getState().init();
    usePluginDevStatusStore.getState().init();
    usePluginDevStatusStore.getState().init();

    expect(on).toHaveBeenCalledTimes(1);
  });
});
