// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePluginArchiveInstallIntent } from "../usePluginArchiveInstallIntent";
import {
  __resetPluginArchiveInstallStoreForTesting,
  usePluginArchiveInstallStore,
} from "@/store/pluginArchiveInstallStore";
import type { PluginArchiveInstallIntent } from "@shared/types/plugin";

type Listener = (intent: PluginArchiveInstallIntent) => void;

const listeners = new Set<Listener>();
const unsubscribe = vi.fn();
const onArchiveInstallIntent = vi.fn((cb: Listener) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    unsubscribe();
  };
});

function emit(intent: PluginArchiveInstallIntent) {
  act(() => {
    for (const listener of [...listeners]) listener(intent);
  });
}

function intent(overrides: Partial<PluginArchiveInstallIntent> = {}): PluginArchiveInstallIntent {
  return {
    intentId: "i1",
    archivePath: "/tmp/a.dntr",
    archiveFileName: "a.dntr",
    manifest: { name: "acme.tool", version: "1.0.0", authors: [], capabilities: [] },
    ...overrides,
  };
}

describe("usePluginArchiveInstallIntent", () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    __resetPluginArchiveInstallStoreForTesting();
    Object.assign(window, { electron: { plugin: { onArchiveInstallIntent } } });
  });

  afterEach(() => cleanup());

  it("subscribes on mount, before anything gates on hydration", () => {
    renderHook(() => usePluginArchiveInstallIntent());

    expect(onArchiveInstallIntent).toHaveBeenCalledOnce();
  });

  it("queues an intent that arrives before the dialog is mounted", () => {
    renderHook(() => usePluginArchiveInstallIntent());

    emit(intent());

    expect(usePluginArchiveInstallStore.getState().current?.archivePath).toBe("/tmp/a.dntr");
  });

  it("keeps every archive from a multi-file open, in arrival order", () => {
    renderHook(() => usePluginArchiveInstallIntent());

    emit(intent({ intentId: "i1", archivePath: "/tmp/1.dntr" }));
    emit(intent({ intentId: "i2", archivePath: "/tmp/2.dntr" }));
    emit(intent({ intentId: "i3", archivePath: "/tmp/3.dntr" }));

    const state = usePluginArchiveInstallStore.getState();
    expect(state.current?.archivePath).toBe("/tmp/1.dntr");
    expect(state.queue.map((i) => i.archivePath)).toEqual(["/tmp/2.dntr", "/tmp/3.dntr"]);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => usePluginArchiveInstallIntent());

    unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });
});
