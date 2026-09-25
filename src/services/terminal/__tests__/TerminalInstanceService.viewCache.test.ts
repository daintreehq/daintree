// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTerminal } from "../types";
import type { ProjectViewLifecyclePhase } from "@/lib/viewCacheState";
import { TerminalRefreshTier } from "@/types";

// Module mock rather than the preload-bridge stub: the service is re-imported
// under vi.resetModules() and subscribes to the lifecycle at construction, so
// the listener it registers has to be captured here.
// Cached and hidden are independent inputs, combined the way the real
// observability helper combines them.
const viewCache = vi.hoisted(() => ({
  cached: false,
  hidden: false,
  listeners: new Set<(phase: ProjectViewLifecyclePhase) => void>(),
  visibilityListeners: new Set<() => void>(),
}));

vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => viewCache.cached,
  isProjectViewObservable: () => !viewCache.cached && !viewCache.hidden,
  subscribeProjectViewLifecycle: (listener: (phase: ProjectViewLifecyclePhase) => void) => {
    viewCache.listeners.add(listener);
    return () => viewCache.listeners.delete(listener);
  },
  // Edge-triggered like the real helper: fires only when the combined answer
  // flips, from either a lifecycle phase or a visibilitychange.
  subscribeProjectViewObservability: (listener: (observable: boolean) => void) => {
    const observable = () => !viewCache.cached && !viewCache.hidden;
    let last = observable();
    const check = () => {
      const next = observable();
      if (next === last) return;
      last = next;
      listener(next);
    };
    viewCache.listeners.add(check);
    viewCache.visibilityListeners.add(check);
    return () => {
      viewCache.listeners.delete(check);
      viewCache.visibilityListeners.delete(check);
    };
  },
}));

const renderSuspension = vi.hoisted(() => ({
  suspendXtermRender: vi.fn(() => true),
  resumeXtermRender: vi.fn(),
}));

vi.mock("../xtermRenderSuspension", () => renderSuspension);

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    onReset: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    getPortAckGeneration: vi.fn(() => 0),
    discardPortAcks: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

type ViewCacheTestService = {
  instances: Map<string, ManagedTerminal>;
  rendererPolicy: {
    applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
    reassertBackgroundTier: (id: string) => void;
    getLastBackendTier: (id: string) => "active" | "background" | undefined;
    deps: {
      onTierApplied?: (id: string, tier: TerminalRefreshTier, managed: ManagedTerminal) => void;
    };
  };
  webGLPolicy: {
    wantsWebGLAtTier: (
      managed: ManagedTerminal,
      tier: TerminalRefreshTier | undefined,
      opts?: { trustDomVisibility?: boolean }
    ) => boolean;
  };
  burstController: { onPtyWrite: (id: string) => void };
  scheduleWhySlowReport: () => void;
  webGLManager: {
    releaseContext: (id: string) => void;
    pinFocus: (id: string, managed: ManagedTerminal) => void;
  };
  dispose: () => void;
};

// Swallows per-listener errors like the real emitter: the service's sibling
// controllers subscribe too, and a stub instance may not satisfy them.
function emit(phase: ProjectViewLifecyclePhase): void {
  viewCache.cached = phase === "cached";
  for (const listener of Array.from(viewCache.listeners)) {
    try {
      listener(phase);
    } catch {
      // ignore
    }
  }
}

function setHidden(hidden: boolean): void {
  viewCache.hidden = hidden;
  for (const listener of Array.from(viewCache.visibilityListeners)) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

function makeManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    isOpened: true,
    isFocused: false,
    terminal: {} as ManagedTerminal["terminal"],
    getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    ...overrides,
  } as ManagedTerminal;
}

describe("TerminalInstanceService project-view cache and window visibility (#12514, #12798)", () => {
  let service: ViewCacheTestService;
  let applyPolicy: ReturnType<typeof vi.fn<(id: string, tier: TerminalRefreshTier) => void>>;
  let releaseContext: ReturnType<typeof vi.fn<(id: string) => void>>;
  let pinFocus: ReturnType<typeof vi.fn<(id: string, managed: ManagedTerminal) => void>>;

  beforeEach(async () => {
    vi.resetModules();
    viewCache.cached = false;
    viewCache.hidden = false;
    viewCache.listeners.clear();
    viewCache.visibilityListeners.clear();
    renderSuspension.suspendXtermRender.mockClear();
    renderSuspension.resumeXtermRender.mockClear();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ViewCacheTestService;
      });
    // Only after the import: a frozen clock on the module loader path can
    // stall the import in CI (fakeTimersImportOrder contract). Nothing here
    // needs a load-time timer faked — the cache dwell is armed per test.
    vi.useFakeTimers();
    service.instances.clear();
    applyPolicy = vi.fn();
    releaseContext = vi.fn();
    pinFocus = vi.fn();
    vi.spyOn(service.rendererPolicy, "applyRendererPolicy").mockImplementation(applyPolicy);
    vi.spyOn(service.webGLManager, "releaseContext").mockImplementation(releaseContext);
    vi.spyOn(service.webGLManager, "pinFocus").mockImplementation(pinFocus);
  });

  afterEach(() => {
    service.instances.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Each test imports a fresh singleton whose watchdog and reflow heartbeat
    // armed real intervals at construction.
    service.dispose();
  });

  it("suspends painting and demotes every terminal when the view is cached", () => {
    const opened = makeManaged();
    const unopened = makeManaged({ isOpened: false });
    service.instances.set("a", opened);
    service.instances.set("b", unopened);

    emit("cached");

    expect(renderSuspension.suspendXtermRender).toHaveBeenCalledTimes(1);
    expect(renderSuspension.suspendXtermRender).toHaveBeenCalledWith(opened.terminal);
    expect(applyPolicy).toHaveBeenCalledWith("a", TerminalRefreshTier.BACKGROUND);
    expect(applyPolicy).toHaveBeenCalledWith("b", TerminalRefreshTier.BACKGROUND);
  });

  it("re-asserts the background cadence for a pane that was already background", () => {
    // Another window showing this project may have raised the host cadence
    // since this view last sent it; the policy alone would send nothing.
    // Called through: the reassert records the background baseline, so the
    // suppression pass that follows does not send it twice.
    const resend = vi.spyOn(service.rendererPolicy, "reassertBackgroundTier");
    service.instances.set(
      "hidden",
      makeManaged({ lastAppliedTier: TerminalRefreshTier.BACKGROUND })
    );
    service.instances.set("shown", makeManaged({ lastAppliedTier: TerminalRefreshTier.VISIBLE }));

    emit("cached");

    expect(resend.mock.calls).toEqual([["hidden"]]);
    expect(applyPolicy.mock.calls).toEqual([["shown", TerminalRefreshTier.BACKGROUND]]);
  });

  it("keeps measured sizes through a cache-driven demotion but not an ordinary one", () => {
    // Background window resizes scale a cached view's panes from lastWidth /
    // lastHeight; zeroing them on the cache demotion would skip every pane.
    vi.spyOn(service, "scheduleWhySlowReport").mockImplementation(() => {});
    const onTierApplied = service.rendererPolicy.deps.onTierApplied;
    const managed = makeManaged({
      isVisible: true,
      lastWidth: 800,
      lastHeight: 600,
      terminal: { options: {} } as ManagedTerminal["terminal"],
    });

    viewCache.cached = true;
    onTierApplied?.("a", TerminalRefreshTier.BACKGROUND, managed);
    expect([managed.lastWidth, managed.lastHeight]).toEqual([800, 600]);

    // Hidden windows scale from them too.
    viewCache.cached = false;
    viewCache.hidden = true;
    onTierApplied?.("a", TerminalRefreshTier.BACKGROUND, managed);
    expect([managed.lastWidth, managed.lastHeight]).toEqual([800, 600]);

    viewCache.hidden = false;
    onTierApplied?.("a", TerminalRefreshTier.BACKGROUND, managed);
    expect([managed.lastWidth, managed.lastHeight]).toEqual([0, 0]);
  });

  it("keeps WebGL contexts through the dwell and releases them once it lapses", () => {
    service.instances.set("a", makeManaged());
    emit("cached");

    vi.advanceTimersByTime(19_999);
    expect(releaseContext).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(releaseContext).toHaveBeenCalledWith("a");
  });

  it("keeps WebGL contexts for a view reactivated inside the dwell", () => {
    service.instances.set("a", makeManaged());
    emit("cached");
    vi.advanceTimersByTime(5_000);

    emit("active");
    vi.advanceTimersByTime(60_000);

    expect(releaseContext).not.toHaveBeenCalled();
  });

  it("resumes painting, re-derives tiers and re-pins focus on reactivation", () => {
    const focused = makeManaged({
      isFocused: true,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    });
    const other = makeManaged();
    service.instances.set("focused", focused);
    service.instances.set("other", other);
    emit("cached");
    applyPolicy.mockClear();

    emit("active");

    expect(renderSuspension.resumeXtermRender).toHaveBeenCalledWith(focused.terminal);
    expect(renderSuspension.resumeXtermRender).toHaveBeenCalledWith(other.terminal);
    expect(applyPolicy).toHaveBeenCalledWith("focused", TerminalRefreshTier.FOCUSED);
    expect(applyPolicy).toHaveBeenCalledWith("other", TerminalRefreshTier.VISIBLE);
    expect(pinFocus).toHaveBeenCalledTimes(1);
    expect(pinFocus).toHaveBeenCalledWith("focused", focused);
  });

  it("treats a lone revealed as reactivation", () => {
    service.instances.set("a", makeManaged());
    emit("cached");

    applyPolicy.mockClear();
    emit("revealed");

    expect(renderSuspension.resumeXtermRender).toHaveBeenCalledTimes(1);
    expect(applyPolicy).toHaveBeenCalledWith("a", TerminalRefreshTier.VISIBLE);
    vi.advanceTimersByTime(60_000);
    expect(releaseContext).not.toHaveBeenCalled();
  });

  it("stops listening and cancels the release on dispose", () => {
    emit("cached");
    service.dispose();
    renderSuspension.suspendXtermRender.mockClear();
    releaseContext.mockClear();

    // An instance added after dispose would be swept by a surviving timer or
    // suspended by a surviving listener.
    service.instances.set("late", makeManaged());
    vi.advanceTimersByTime(60_000);
    emit("cached");

    expect(releaseContext).not.toHaveBeenCalled();
    expect(renderSuspension.suspendXtermRender).not.toHaveBeenCalled();
  });
  it("demotes every terminal without suspending painting when the window hides", () => {
    service.instances.set("a", makeManaged({ getRefreshTier: () => TerminalRefreshTier.FOCUSED }));
    service.instances.set("b", makeManaged());

    setHidden(true);

    expect(applyPolicy.mock.calls).toEqual([
      ["a", TerminalRefreshTier.BACKGROUND],
      ["b", TerminalRefreshTier.BACKGROUND],
    ]);
    expect(renderSuspension.suspendXtermRender).not.toHaveBeenCalled();
  });

  it("releases WebGL once the dwell lapses in a hidden window", () => {
    service.instances.set("a", makeManaged());
    setHidden(true);

    vi.advanceTimersByTime(19_999);
    expect(releaseContext).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(releaseContext).toHaveBeenCalledWith("a");
  });

  it("restores tiers and the focus pin on reveal without touching painting", () => {
    const focused = makeManaged({
      isFocused: true,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    });
    service.instances.set("focused", focused);
    service.instances.set("other", makeManaged());
    setHidden(true);
    vi.advanceTimersByTime(5_000);
    applyPolicy.mockClear();

    setHidden(false);

    expect(applyPolicy.mock.calls).toEqual([
      ["focused", TerminalRefreshTier.FOCUSED],
      ["other", TerminalRefreshTier.VISIBLE],
    ]);
    expect(pinFocus.mock.calls).toEqual([["focused", focused]]);
    expect(renderSuspension.resumeXtermRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(releaseContext).not.toHaveBeenCalled();
  });

  it("gives a second hide its own full dwell", () => {
    service.instances.set("a", makeManaged());
    setHidden(true);
    vi.advanceTimersByTime(15_000);
    setHidden(false);
    setHidden(true);

    vi.advanceTimersByTime(19_999);
    expect(releaseContext).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(releaseContext).toHaveBeenCalledWith("a");
  });

  it("keeps a cached view suppressed when its window is shown", () => {
    service.instances.set("a", makeManaged());
    setHidden(true);
    emit("cached");
    applyPolicy.mockClear();

    setHidden(false);

    expect(applyPolicy).not.toHaveBeenCalled();
    expect(pinFocus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(releaseContext).toHaveBeenCalledWith("a");
  });

  it("does not restart the dwell when a hidden window's view is cached", () => {
    service.instances.set("a", makeManaged());
    setHidden(true);
    vi.advanceTimersByTime(15_000);

    emit("cached");
    // The cache still owns painting, whatever the window is doing.
    expect(renderSuspension.suspendXtermRender).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    expect(releaseContext).toHaveBeenCalledWith("a");
  });

  it("resumes painting but stays demoted when reactivated in a hidden window", () => {
    const focused = makeManaged({ isFocused: true });
    service.instances.set("a", focused);
    emit("cached");
    setHidden(true);
    applyPolicy.mockClear();

    emit("active");

    expect(renderSuspension.resumeXtermRender).toHaveBeenCalledWith(focused.terminal);
    expect(applyPolicy).not.toHaveBeenCalled();
    expect(pinFocus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(releaseContext).toHaveBeenCalledWith("a");

    setHidden(false);
    expect(applyPolicy).toHaveBeenCalledWith("a", TerminalRefreshTier.VISIBLE);
    expect(pinFocus).toHaveBeenCalledWith("a", focused);
  });

  it("vetoes WebGL wants and write bursts while the window is hidden", () => {
    const managed = makeManaged({ isVisible: true });
    service.instances.set("a", managed);
    expect(service.webGLPolicy.wantsWebGLAtTier(managed, TerminalRefreshTier.FOCUSED)).toBe(true);

    setHidden(true);
    applyPolicy.mockClear();

    expect(service.webGLPolicy.wantsWebGLAtTier(managed, TerminalRefreshTier.FOCUSED)).toBe(false);
    expect(
      service.webGLPolicy.wantsWebGLAtTier(managed, TerminalRefreshTier.FOCUSED, {
        trustDomVisibility: true,
      })
    ).toBe(false);
    service.burstController.onPtyWrite("a");
    expect(applyPolicy).not.toHaveBeenCalled();
  });

  it("tells the host a hidden window's already-background panes are background", () => {
    // A cold-created BACKGROUND pane records its backend tier as "active".
    const resend = vi
      .spyOn(service.rendererPolicy, "reassertBackgroundTier")
      .mockImplementation(() => {});
    vi.spyOn(service.rendererPolicy, "getLastBackendTier").mockImplementation((id) =>
      id === "seeded" ? "active" : "background"
    );
    service.instances.set(
      "seeded",
      makeManaged({ lastAppliedTier: TerminalRefreshTier.BACKGROUND })
    );
    service.instances.set(
      "settled",
      makeManaged({ lastAppliedTier: TerminalRefreshTier.BACKGROUND })
    );
    service.instances.set("shown", makeManaged({ lastAppliedTier: TerminalRefreshTier.VISIBLE }));

    setHidden(true);

    expect(resend.mock.calls).toEqual([["seeded"]]);
    expect(applyPolicy.mock.calls).toEqual([["shown", TerminalRefreshTier.BACKGROUND]]);
  });

  it("restores tiers once for a cached view that goes active then revealed", () => {
    const focused = makeManaged({
      isFocused: true,
      getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    });
    service.instances.set("a", focused);
    emit("cached");
    applyPolicy.mockClear();

    emit("active");
    emit("revealed");

    expect(applyPolicy.mock.calls).toEqual([["a", TerminalRefreshTier.FOCUSED]]);
    expect(pinFocus).toHaveBeenCalledTimes(1);
  });

  it("stops following window visibility after dispose", () => {
    service.instances.set("a", makeManaged());
    setHidden(true);
    // dispose() destroys every instance, and these stubs have no DOM.
    service.instances.clear();
    service.dispose();
    service.instances.set("a", makeManaged());
    applyPolicy.mockClear();

    vi.advanceTimersByTime(60_000);
    setHidden(false);

    expect(releaseContext).not.toHaveBeenCalled();
    expect(applyPolicy).not.toHaveBeenCalled();
  });
});
