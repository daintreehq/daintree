// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalConfig, TerminalConfigChange } from "@shared/types";
import type { ProjectViewLifecyclePhase } from "@/lib/viewCacheState";

const bootMock = vi.hoisted(() => ({ getSafeBootPromise: vi.fn() }));
vi.mock("@/lib/bootPromise", () => bootMock);

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

const lifecycle = vi.hoisted(() => {
  const listeners = new Set<(phase: ProjectViewLifecyclePhase) => void>();
  return {
    subscribeProjectViewLifecycle: vi.fn((listener: (phase: ProjectViewLifecyclePhase) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit: (phase: ProjectViewLifecyclePhase) => listeners.forEach((listener) => listener(phase)),
  };
});
vi.mock("@/lib/viewCacheState", () => lifecycle);

const client = vi.hoisted(() => {
  let listener: ((change: TerminalConfigChange) => void) | null = null;
  return {
    get: vi.fn<() => Promise<Partial<TerminalConfig>>>(),
    onChanged: vi.fn((cb: (change: TerminalConfigChange) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    setScrollback: vi.fn(),
    setResourceMonitoring: vi.fn(),
    setHybridInputAutoFocus: vi.fn(),
    setColorScheme: vi.fn(),
    setRecentSchemeIds: vi.fn(),
    push: (change: TerminalConfigChange) => listener?.(change),
    hasListener: () => listener !== null,
  };
});
vi.mock("@/clients/terminalConfigClient", () => ({ terminalConfigClient: client }));

import {
  __resetTerminalConfigSyncForTests,
  applyBootTerminalConfig,
  beginTerminalConfigRead,
  initTerminalConfigSync,
} from "../terminalConfigSync";
import { notifyHostResync, type HydratedSettings } from "@/store/hostResyncSignal";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { selectHomeFocusTarget, useTerminalInputStore } from "@/store/terminalInputStore";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useCachedProjectViewsStore } from "@/store/cachedProjectViewsStore";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import {
  DEFAULT_AUTO_RESTART_THRESHOLD_MB,
  useMemoryLeakConfigStore,
} from "@/store/memoryLeakConfigStore";

type Config = Partial<TerminalConfig>;

const scheme = (id: string) => ({
  id,
  name: id,
  type: "dark" as const,
  builtin: false,
  colors: { background: "#000000" },
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function boot(terminalConfig?: Config) {
  bootMock.getSafeBootPromise.mockResolvedValue({ ok: true, result: { terminalConfig } });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const device = (config: Config): TerminalConfigChange => ({ owner: "device", config });
const host = (config: Config): TerminalConfigChange => ({ owner: "host", config });

function snapshot() {
  return {
    scrollbackLines: useScrollbackStore.getState().scrollbackLines,
    performanceMode: usePerformanceModeStore.getState().performanceMode,
    fontSize: useTerminalFontStore.getState().fontSize,
    resourceMonitoring: useResourceMonitoringStore.getState().enabled,
    leakDetection: useMemoryLeakConfigStore.getState().enabled,
    leakThreshold: useMemoryLeakConfigStore.getState().autoRestartThresholdMb,
  };
}

describe("terminalConfigSync (#14699)", () => {
  let dispose: () => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    __resetTerminalConfigSyncForTests();
    Object.defineProperty(window, "electron", {
      value: { terminalConfig: { onChanged: client.onChanged } },
      configurable: true,
      writable: true,
    });
    useScrollbackStore.setState({ scrollbackLines: 1000 });
    usePerformanceModeStore.setState({ performanceMode: false });
    useTerminalInputStore.setState({ hybridInputEnabled: true, hybridInputAutoFocus: true });
    useScreenReaderStore.setState({ screenReaderMode: "auto" });
    useTerminalFontStore.setState({ fontSize: 13, fontFamily: "Menlo" });
    useTerminalColorSchemeStore.setState({
      selectedSchemeId: "daintree",
      customSchemes: [],
      recentSchemeIds: [],
      previewSchemeId: null,
    });
    useCachedProjectViewsStore.setState({ cachedProjectViews: 1 });
    useResourceMonitoringStore.setState({ enabled: false });
    useMemoryLeakConfigStore.setState({
      enabled: false,
      autoRestartThresholdMb: DEFAULT_AUTO_RESTART_THRESHOLD_MB,
    });
  });

  afterEach(() => {
    dispose();
    dispose = () => {};
  });

  it("seeds every store from the boot payload without saving anything", async () => {
    boot({
      scrollbackLines: 5000,
      performanceMode: true,
      hybridInputEnabled: false,
      screenReaderMode: "on",
      fontSize: 15,
      fontFamily: "Iosevka",
      colorSchemeId: "dracula",
      customSchemes: [scheme("mine")],
      recentSchemeIds: ["dracula", "mine"],
      cachedProjectViews: 3,
      resourceMonitoringEnabled: true,
      memoryLeakAutoRestartThresholdMb: 4096,
    });
    dispose = initTerminalConfigSync();
    await settle();

    expect(snapshot()).toEqual({
      scrollbackLines: 5000,
      performanceMode: true,
      fontSize: 15,
      resourceMonitoring: true,
      // Follows monitoring when it was never set on its own.
      leakDetection: true,
      leakThreshold: 4096,
    });
    expect(useTerminalInputStore.getState().hybridInputEnabled).toBe(false);
    expect(useScreenReaderStore.getState().screenReaderMode).toBe("on");
    expect(useTerminalFontStore.getState().fontFamily).toBe("Iosevka");
    expect(useTerminalColorSchemeStore.getState()).toMatchObject({
      selectedSchemeId: "dracula",
      customSchemes: [scheme("mine")],
      recentSchemeIds: ["dracula", "mine"],
    });
    expect(useCachedProjectViewsStore.getState().cachedProjectViews).toBe(3);
    expect(client.get).not.toHaveBeenCalled();
    for (const setter of [
      client.setScrollback,
      client.setResourceMonitoring,
      client.setHybridInputAutoFocus,
      client.setColorScheme,
      client.setRecentSchemeIds,
    ]) {
      expect(setter).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["boot failed", { ok: false, error: new Error("boot") }],
    ["boot carried no config", { ok: true, result: { terminalConfig: undefined } }],
  ])("reads the config when the %s", async (_case, bootResult) => {
    bootMock.getSafeBootPromise.mockResolvedValue(bootResult);
    client.get.mockResolvedValue({ scrollbackLines: 2500, resourceMonitoringEnabled: true });
    dispose = initTerminalConfigSync();
    await settle();

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(snapshot()).toMatchObject({ scrollbackLines: 2500, resourceMonitoring: true });
  });

  it("reads rather than reusing the boot payload when restarted before boot answered", async () => {
    const pendingBoot = deferred<unknown>();
    bootMock.getSafeBootPromise.mockReturnValue(pendingBoot.promise);
    dispose = initTerminalConfigSync();
    dispose();
    client.get.mockResolvedValue({ fontSize: 20 });

    dispose = initTerminalConfigSync();
    pendingBoot.resolve({ ok: true, result: { terminalConfig: { fontSize: 13 } } });
    await settle();

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(useTerminalFontStore.getState().fontSize).toBe(20);
  });

  it("reads rather than reusing the boot payload when started again", async () => {
    boot({ fontSize: 13 });
    dispose = initTerminalConfigSync();
    await settle();
    dispose();
    // Saved while nothing was listening; the boot payload still says 13.
    client.get.mockResolvedValue({ fontSize: 20 });

    dispose = initTerminalConfigSync();
    await settle();

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(useTerminalFontStore.getState().fontSize).toBe(20);
  });

  it("applies each owner's push to that owner's fields alone", async () => {
    boot({ scrollbackLines: 1000, resourceMonitoringEnabled: true, fontSize: 13 });
    dispose = initTerminalConfigSync();
    await settle();

    // A remote view hears the host's half from the host, which knows nothing
    // of this machine's scrollback.
    client.push(host({ resourceMonitoringEnabled: false, scrollbackLines: 9999 }));
    expect(snapshot()).toMatchObject({ resourceMonitoring: false, scrollbackLines: 1000 });

    client.push(device({ fontSize: 18, resourceMonitoringEnabled: true }));
    expect(snapshot()).toMatchObject({ fontSize: 18, resourceMonitoring: false });
  });

  it("keeps a push that beat the boot payload, for that owner only", async () => {
    const pendingBoot = deferred<unknown>();
    bootMock.getSafeBootPromise.mockReturnValue(pendingBoot.promise);
    dispose = initTerminalConfigSync();

    client.push(device({ scrollbackLines: 7000 }));
    pendingBoot.resolve({
      ok: true,
      result: { terminalConfig: { scrollbackLines: 1000, resourceMonitoringEnabled: true } },
    });
    await settle();

    expect(snapshot()).toMatchObject({ scrollbackLines: 7000, resourceMonitoring: true });
  });

  it("drops the half of a read that a push overtook and keeps the other", async () => {
    boot({});
    dispose = initTerminalConfigSync();
    await settle();
    const answer = deferred<Config>();
    client.get.mockReturnValueOnce(answer.promise);

    notifyHostResync();
    client.push(host({ resourceMonitoringEnabled: true }));
    answer.resolve({ scrollbackLines: 3000, resourceMonitoringEnabled: false });
    await settle();

    expect(snapshot()).toMatchObject({ scrollbackLines: 3000, resourceMonitoring: true });
  });

  it("takes a fresh session's config from the resync's hydrate answer, less a half a push overtook", async () => {
    boot({});
    dispose = initTerminalConfigSync();
    await settle();
    const hydrated = deferred<HydratedSettings | null>();

    notifyHostResync({ hydrated: hydrated.promise });
    client.push(host({ resourceMonitoringEnabled: true }));
    hydrated.resolve({
      terminalConfig: { scrollbackLines: 3000, resourceMonitoringEnabled: false } as TerminalConfig,
      agentSettings: undefined,
      agentDefaults: undefined,
    });
    await settle();

    expect(snapshot()).toMatchObject({ scrollbackLines: 3000, resourceMonitoring: true });
    expect(client.get).not.toHaveBeenCalled();
  });

  it("reads the config itself when the resync's hydrate came to nothing", async () => {
    boot({});
    dispose = initTerminalConfigSync();
    await settle();
    client.get.mockResolvedValue({ scrollbackLines: 4000 });

    notifyHostResync({ hydrated: Promise.resolve(null) });
    await settle();

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(snapshot().scrollbackLines).toBe(4000);
  });

  it("never lets an earlier read that answers late undo a later one", async () => {
    const first = beginTerminalConfigRead();
    const second = beginTerminalConfigRead();

    second({ scrollbackLines: 4000 });
    first({ scrollbackLines: 2000 });

    expect(useScrollbackStore.getState().scrollbackLines).toBe(4000);
  });

  it("ranks the boot payload below every other read, so hydrating it again changes nothing", async () => {
    beginTerminalConfigRead()({ scrollbackLines: 4000 });
    applyBootTerminalConfig({ scrollbackLines: 1000 });

    expect(useScrollbackStore.getState().scrollbackLines).toBe(4000);
  });

  it("reads again after the host link comes back", async () => {
    boot({ resourceMonitoringEnabled: false });
    dispose = initTerminalConfigSync();
    await settle();
    client.get.mockResolvedValue({
      resourceMonitoringEnabled: true,
      memoryLeakDetectionEnabled: false,
    });

    notifyHostResync();
    await settle();

    expect(snapshot()).toMatchObject({ resourceMonitoring: true, leakDetection: false });
  });

  it("reads again when a cached view comes back, and only then", async () => {
    boot({ fontSize: 13 });
    dispose = initTerminalConfigSync();
    await settle();
    client.get.mockResolvedValue({ fontSize: 20 });

    lifecycle.emit("cached");
    lifecycle.emit("revealed");
    await settle();
    expect(client.get).not.toHaveBeenCalled();

    lifecycle.emit("active");
    await settle();
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(useTerminalFontStore.getState().fontSize).toBe(20);
  });

  it("keeps what it had when a read fails", async () => {
    boot({ scrollbackLines: 5000 });
    dispose = initTerminalConfigSync();
    await settle();
    client.get.mockRejectedValue(new Error("host unreachable"));

    notifyHostResync();
    await settle();

    expect(useScrollbackStore.getState().scrollbackLines).toBe(5000);
  });

  it("moves every agent pane's home only when autofocus actually changes", async () => {
    boot({ hybridInputAutoFocus: true });
    dispose = initTerminalConfigSync();
    await settle();
    const homeOf = () => selectHomeFocusTarget(useTerminalInputStore.getState());
    const homes: string[] = [];
    const unsubscribe = useTerminalInputStore.subscribe((state) =>
      homes.push(selectHomeFocusTarget(state))
    );

    try {
      client.push(device({ hybridInputAutoFocus: true, fontSize: 16 }));
      expect(homeOf()).toBe("hybridInput");

      client.push(device({ hybridInputAutoFocus: false }));
      expect(homeOf()).toBe("xterm");
    } finally {
      unsubscribe();
    }
    expect(homes).toEqual(["xterm"]);
  });

  it("replaces the custom schemes, dropping a removed scheme's preview, and leaves recents to the saved list", async () => {
    boot({ customSchemes: [scheme("a"), scheme("b")], recentSchemeIds: ["a"] });
    dispose = initTerminalConfigSync();
    await settle();
    useTerminalColorSchemeStore.setState({ previewSchemeId: "b" });

    client.push(
      device({ customSchemes: [scheme("a")], colorSchemeId: "a", recentSchemeIds: ["a"] })
    );

    expect(useTerminalColorSchemeStore.getState()).toMatchObject({
      customSchemes: [scheme("a")],
      previewSchemeId: null,
      selectedSchemeId: "a",
      recentSchemeIds: ["a"],
    });
  });

  // The picker selects locally, saves the scheme, then saves the recents it
  // reads back from the store; the scheme's push lands in between.
  it("keeps an edit this view hasn't saved yet when another field's change arrives", async () => {
    boot({ colorSchemeId: "a", recentSchemeIds: ["a"] });
    dispose = initTerminalConfigSync();
    await settle();

    useTerminalColorSchemeStore.getState().setSelectedSchemeId("b");
    client.push(device({ colorSchemeId: "b", recentSchemeIds: ["a"] }));
    expect(useTerminalColorSchemeStore.getState().recentSchemeIds).toEqual(["b", "a"]);

    client.push(device({ colorSchemeId: "b", recentSchemeIds: ["b", "a"] }));
    client.push(device({ colorSchemeId: "c", recentSchemeIds: ["c", "b", "a"] }));
    expect(useTerminalColorSchemeStore.getState()).toMatchObject({
      selectedSchemeId: "c",
      recentSchemeIds: ["c", "b", "a"],
    });
  });

  it("puts every field back to what's saved when it reads again", async () => {
    boot({ fontSize: 13, scrollbackLines: 1000 });
    dispose = initTerminalConfigSync();
    await settle();
    // A failed save rolled this view back to a value that's no longer saved.
    useScrollbackStore.setState({ scrollbackLines: 4000 });
    client.push(device({ fontSize: 13, scrollbackLines: 1000 }));
    expect(useScrollbackStore.getState().scrollbackLines).toBe(4000);
    client.get.mockResolvedValue({ fontSize: 17, scrollbackLines: 1000 });

    lifecycle.emit("active");
    await settle();

    expect(useTerminalFontStore.getState().fontSize).toBe(17);
    expect(useScrollbackStore.getState().scrollbackLines).toBe(1000);
  });

  it("takes another view's pick without adding it to this view's recents", async () => {
    boot({ colorSchemeId: "a", recentSchemeIds: ["a"] });
    dispose = initTerminalConfigSync();
    await settle();

    client.push(device({ colorSchemeId: "b", recentSchemeIds: ["a"] }));

    expect(useTerminalColorSchemeStore.getState()).toMatchObject({
      selectedSchemeId: "b",
      recentSchemeIds: ["a"],
    });
  });

  it("stops listening and ignores a read still in flight once disposed", async () => {
    boot({});
    dispose = initTerminalConfigSync();
    await settle();
    const answer = deferred<Config>();
    client.get.mockReturnValueOnce(answer.promise);
    notifyHostResync();

    dispose();
    answer.resolve({ scrollbackLines: 6000 });
    await settle();

    expect(client.hasListener()).toBe(false);
    expect(useScrollbackStore.getState().scrollbackLines).toBe(1000);
  });

  it("does nothing without the bridge", () => {
    Object.defineProperty(window, "electron", { value: {}, configurable: true, writable: true });

    dispose = initTerminalConfigSync();

    expect(client.onChanged).not.toHaveBeenCalled();
    expect(bootMock.getSafeBootPromise).not.toHaveBeenCalled();
  });
});
