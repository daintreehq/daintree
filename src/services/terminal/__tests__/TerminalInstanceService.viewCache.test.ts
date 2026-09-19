// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTerminal } from "../types";
import type { ProjectViewLifecyclePhase } from "@/lib/viewCacheState";
import { TerminalRefreshTier } from "@/types";

// Module mock rather than the preload-bridge stub: the service is re-imported
// under vi.resetModules() and subscribes to the lifecycle at construction, so
// the listener it registers has to be captured here.
const viewCache = vi.hoisted(() => ({
  cached: false,
  listeners: new Set<(phase: ProjectViewLifecyclePhase) => void>(),
}));

vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => viewCache.cached,
  subscribeProjectViewLifecycle: (listener: (phase: ProjectViewLifecyclePhase) => void) => {
    viewCache.listeners.add(listener);
    return () => viewCache.listeners.delete(listener);
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
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
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
    deps: {
      onTierApplied?: (id: string, tier: TerminalRefreshTier, managed: ManagedTerminal) => void;
    };
  };
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

function makeManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    isOpened: true,
    isFocused: false,
    terminal: {} as ManagedTerminal["terminal"],
    getRefreshTier: () => TerminalRefreshTier.VISIBLE,
    ...overrides,
  } as ManagedTerminal;
}

describe("TerminalInstanceService project-view cache lifecycle (#12514)", () => {
  let service: ViewCacheTestService;
  let applyPolicy: ReturnType<typeof vi.fn<(id: string, tier: TerminalRefreshTier) => void>>;
  let releaseContext: ReturnType<typeof vi.fn<(id: string) => void>>;
  let pinFocus: ReturnType<typeof vi.fn<(id: string, managed: ManagedTerminal) => void>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    viewCache.cached = false;
    viewCache.listeners.clear();
    renderSuspension.suspendXtermRender.mockClear();
    renderSuspension.resumeXtermRender.mockClear();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ViewCacheTestService;
      });
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
    const resend = vi
      .spyOn(service.rendererPolicy, "reassertBackgroundTier")
      .mockImplementation(() => {});
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

    viewCache.cached = false;
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

    emit("revealed");

    expect(renderSuspension.resumeXtermRender).toHaveBeenCalledTimes(1);
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
});
