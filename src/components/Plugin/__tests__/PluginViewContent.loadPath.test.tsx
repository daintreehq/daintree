// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeStatus, PluginWorkerStatus } from "@shared/types/plugin";
import type { PluginViewContentConfig } from "../PluginViewContent";

/**
 * The load path's relationship with React's Suspense reveal throttle.
 *
 * React holds a Suspense boundary's retry reveal until 300 ms after its
 * fallback committed. Every plugin panel open used to suspend on its load, so
 * even an open main answered at once took ~300 ms to show. These pin the
 * replacement: a load that settles into plain state (no throttle), and a warm
 * open that waits only on its activation round trip — never giving up
 * activate-before-render, since a status that still reads as the previous ready
 * backend is not proof the plugin has activated (#10523).
 */

vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
  SkeletonHint: () => null,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/Plugin/PluginViewRuntimeStatus", () => ({
  PluginViewRuntimeStatus: () => null,
}));
vi.mock("@/pluginUi", () => ({ whenPluginUiReady: () => Promise.resolve() }));
vi.mock("@/services/plugin/pluginStyleContract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/plugin/pluginStyleContract")>()),
  preparePluginStyles: () => Promise.resolve(),
  registerPluginStyleRoot: () => () => {},
}));
// A real error boundary, reporting through `componentDidCatch` in the commit
// phase exactly as the app's does, so the host's `onError` runs before any
// passive effect of the commit that rendered the throwing view.
vi.mock("@/components/ErrorBoundary", async () => {
  const { Component } = await import("react");
  class FakeBoundary extends Component<
    { children: React.ReactNode; onError?: (error: Error) => void },
    { failed: boolean }
  > {
    state = { failed: false };
    static getDerivedStateFromError(): { failed: true } {
      return { failed: true };
    }
    componentDidCatch(error: Error): void {
      this.props.onError?.(error);
    }
    render(): React.ReactNode {
      return this.state.failed ? <div data-testid="boundary-error" /> : this.props.children;
    }
  }
  return { ErrorBoundary: FakeBoundary };
});

const VIEW_MODULE = "plugin://acme/__dtv-1/dashboard.js";

function makeContentConfig(): PluginViewContentConfig {
  return {
    id: "acme.dashboard",
    name: "Dashboard",
    componentPath: VIEW_MODULE,
    extensionId: "acme",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function worker(overrides: Partial<PluginWorkerStatus> = {}): PluginWorkerStatus {
  return {
    generation: 1,
    state: "ready",
    stateSince: Date.now(),
    reason: null,
    detail: null,
    ...overrides,
  };
}

let activateForView: ReturnType<typeof vi.fn<(kindId: string) => Promise<undefined>>>;

const viewDouble = {
  throwOnRender: false,
  signals: [] as AbortSignal[],
};

beforeEach(() => {
  viewDouble.throwOnRender = false;
  viewDouble.signals = [];
  activateForView = vi.fn<(kindId: string) => Promise<undefined>>(() => Promise.resolve(undefined));
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: { onPanelKindsChanged: () => () => {}, activateForView } },
  });
  vi.doMock(VIEW_MODULE, () => ({
    default: function DashboardView({ disposeSignal }: { disposeSignal: AbortSignal }) {
      viewDouble.signals.push(disposeSignal);
      if (viewDouble.throwOnRender) throw new Error("view threw on its first render");
      return <div data-testid="plugin-view" />;
    },
  }));
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await vi.dynamicImportSettled();
  vi.doUnmock(VIEW_MODULE);
  vi.resetModules();
  Reflect.deleteProperty(window, "electron");
});

/**
 * Let a load's promise chain run without touching the (possibly fake) clock.
 * `setImmediate` is left real, so this drains microtasks and module loading
 * but can never fire a timer — which is where the reveal throttle and the
 * skeleton gate both live.
 */
async function drainWithoutTimers(until: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
}

async function loadModules() {
  const { makePluginViewContent } = await import("../PluginViewContent");
  const { usePluginRuntimeStatusStore } = await import("@/store/pluginRuntimeStatusStore");
  const setStatus = (w: PluginWorkerStatus | null, viewGeneration = 1): void => {
    const status: PluginRuntimeStatus = { pluginId: "acme", viewGeneration, worker: w, dev: null };
    usePluginRuntimeStatusStore.setState({ statusById: new Map([["acme", status]]) });
  };
  return { Content: makePluginViewContent(makeContentConfig()), setStatus };
}

const FROZEN_TIMERS: Array<
  "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval" | "Date"
> = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"];

/** React 19's `FALLBACK_THROTTLE_MS`. */
const REVEAL_THROTTLE_MS = 300;
const POLL_INTERVAL_MS = 2;
const POLL_GIVE_UP_MS = 2000;

/**
 * Real milliseconds from `settle` until the view is on screen, measured with
 * no `act()` around it: React's scheduler skips the reveal throttle while an
 * act queue is active, so only an unwrapped settle schedules the way
 * production does. Real timers, because the throttle is a timeout.
 */
async function msUntilViewOnScreen(settle: () => void): Promise<number> {
  const previous: unknown = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  const start = performance.now();
  try {
    settle();
    while (!viewOnScreen() && performance.now() - start < POLL_GIVE_UP_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return performance.now() - start;
  } finally {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  }
}

const viewOnScreen = (): boolean => screen.queryByTestId("plugin-view") !== null;

describe("plugin view load path", () => {
  it("shows the view as soon as its load resolves, not a throttle later", async () => {
    const activation = deferred<undefined>();
    activateForView.mockReturnValue(activation.promise);
    const { Content } = await loadModules();

    render(<Content panelId="panel-cold" />);
    await drainWithoutTimers(() => false);
    expect(viewOnScreen()).toBe(false);
    // Inside the skeleton gate, nothing is shown yet.
    expect(screen.queryByTestId("skeleton")).toBeNull();

    const elapsed = await msUntilViewOnScreen(() => activation.resolve(undefined));

    expect(elapsed).toBeLessThan(REVEAL_THROTTLE_MS / 2);
    expect(activateForView).toHaveBeenCalledWith("acme.dashboard");
  });

  it("control: the same harness sees a Suspense reveal held for the throttle", async () => {
    // What the test above would measure if the load still suspended: the
    // content used to wrap it in a fresh `lazy()` per open.
    const { Suspense, lazy } = await import("react");
    const chunk = deferred<{ default: () => React.ReactNode }>();
    const LazyView = lazy(() => chunk.promise);
    render(
      <Suspense fallback={<div data-testid="fallback" />}>
        <LazyView />
      </Suspense>
    );

    const elapsed = await msUntilViewOnScreen(() =>
      chunk.resolve({ default: () => <div data-testid="plugin-view" /> })
    );

    expect(elapsed).toBeGreaterThanOrEqual(REVEAL_THROTTLE_MS - 50);
  });

  it("shows the skeleton once a slow load outlasts the gate, then the view", async () => {
    vi.useFakeTimers({ toFake: FROZEN_TIMERS });
    const activation = deferred<undefined>();
    activateForView.mockReturnValue(activation.promise);
    const { Content } = await loadModules();

    render(<Content panelId="panel-slow" />);
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(screen.queryByTestId("skeleton")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("skeleton").textContent).toBe("Loading Dashboard");

    await act(async () => {
      activation.resolve(undefined);
    });
    await drainWithoutTimers(() => false);
    // Held for its floor once shown, so it cannot flash for a frame.
    expect(screen.getByTestId("skeleton")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(viewOnScreen()).toBe(true);
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("holds a warm open until its activation answers, then shows it without the throttle", async () => {
    const { Content, setStatus } = await loadModules();
    setStatus(worker({ generation: 3 }));

    const first = render(<Content panelId="panel-warm" />);
    await drainWithoutTimers(viewOnScreen);
    expect(viewOnScreen()).toBe(true);
    first.unmount();
    expect(activateForView).toHaveBeenCalledTimes(1);

    // The status can still read as the previous ready backend after a restart,
    // so a warm view must not mount (and run its effects) before activation.
    const activation = deferred<undefined>();
    activateForView.mockReturnValue(activation.promise);
    render(<Content panelId="panel-warm" />);
    expect(viewOnScreen()).toBe(false);
    await drainWithoutTimers(() => false);
    expect(viewOnScreen()).toBe(false);
    // Inside the skeleton gate: a warm open never flashes bones.
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(activateForView).toHaveBeenCalledTimes(2);

    const elapsed = await msUntilViewOnScreen(() => activation.resolve(undefined));
    expect(elapsed).toBeLessThan(REVEAL_THROTTLE_MS / 2);
  });

  it("shows a warm open within an IPC round trip and a frame, with the clock frozen", async () => {
    vi.useFakeTimers({ toFake: FROZEN_TIMERS });
    const { Content, setStatus } = await loadModules();
    setStatus(worker({ generation: 3 }));
    const first = render(<Content panelId="panel-warm-frozen" />);
    await drainWithoutTimers(viewOnScreen);
    first.unmount();

    render(<Content panelId="panel-warm-frozen" />);
    // No timer is advanced, so neither the reveal throttle nor the skeleton
    // gate can be what reveals it.
    await drainWithoutTimers(viewOnScreen);
    expect(viewOnScreen()).toBe(true);
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("records the warm open's activation time", async () => {
    const { pluginViewMetrics } = await import("@/services/plugin/pluginViewMetrics");
    const recordViewLoad = vi.spyOn(pluginViewMetrics, "recordViewLoad");
    const { Content, setStatus } = await loadModules();
    setStatus(worker({ generation: 3 }));
    const first = render(<Content panelId="panel-warm-timed" />);
    await drainWithoutTimers(viewOnScreen);
    first.unmount();

    const activation = deferred<undefined>();
    activateForView.mockReturnValue(activation.promise);
    const now = vi.spyOn(performance, "now");
    render(<Content panelId="panel-warm-timed" />);
    await drainWithoutTimers(() => false);
    const base = performance.now();
    now.mockReturnValue(base + 40);
    await act(async () => {
      activation.resolve(undefined);
    });
    await drainWithoutTimers(viewOnScreen);
    now.mockRestore();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    const sample = recordViewLoad.mock.calls.at(-1)?.[1];
    expect(sample?.activateMs).toBeGreaterThanOrEqual(40);
    recordViewLoad.mockRestore();
  });

  it("renders a warm open once under StrictMode's replayed effects", async () => {
    const { Content, setStatus } = await loadModules();
    setStatus(worker({ generation: 3 }));
    const first = render(<Content panelId="panel-strict" />);
    await drainWithoutTimers(viewOnScreen);
    first.unmount();
    activateForView.mockClear();

    render(
      <StrictMode>
        <Content panelId="panel-strict" />
      </StrictMode>
    );
    await drainWithoutTimers(viewOnScreen);
    expect(viewOnScreen()).toBe(true);
    // The replayed effect shares the attempt's one activation.
    expect(activateForView).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an idle dispose stopped the worker", worker({ state: "stopped", reason: "deactivated" })],
    ["a restart replaced the worker", worker({ generation: 4 })],
    ["the worker is still starting", worker({ generation: 3, state: "starting" })],
  ])("activates before the first render again when %s", async (_label, next) => {
    const { Content, setStatus } = await loadModules();
    setStatus(worker({ generation: 3 }));
    const first = render(<Content panelId="panel-gated" />);
    await drainWithoutTimers(viewOnScreen);
    first.unmount();

    setStatus(next);
    const activation = deferred<undefined>();
    activateForView.mockReturnValue(activation.promise);
    render(<Content panelId="panel-gated" />);

    expect(viewOnScreen()).toBe(false);
    await drainWithoutTimers(() => false);
    expect(viewOnScreen()).toBe(false);

    await act(async () => {
      activation.resolve(undefined);
    });
    await drainWithoutTimers(viewOnScreen);
    expect(viewOnScreen()).toBe(true);
  });

  it("does not render a warm open for a kind republished under a newer view generation", async () => {
    const { Content, setStatus } = await loadModules();
    setStatus(worker({ generation: 3 }));
    const first = render(<Content panelId="panel-stale" />);
    await drainWithoutTimers(viewOnScreen);
    first.unmount();

    // A reload published this plugin's kinds as `__dtv-2`; this factory's
    // module belongs to the load before it.
    setStatus(worker({ generation: 3 }), 2);
    activateForView.mockReturnValue(new Promise<never>(() => {}));
    render(<Content panelId="panel-stale" />);

    expect(viewOnScreen()).toBe(false);
  });

  it("forgets a warm backend whose activation was refused", async () => {
    const { Content, setStatus } = await loadModules();
    setStatus(worker({ generation: 3 }));
    const first = render(<Content panelId="panel-refused" />);
    await drainWithoutTimers(viewOnScreen);
    first.unmount();

    activateForView.mockRejectedValue(new Error("refused"));
    const second = render(<Content panelId="panel-refused" />);
    // The refusal reaches the boundary, as it would on a cold open, and the
    // view it refused never mounted.
    await drainWithoutTimers(() => screen.queryByTestId("boundary-error") !== null);
    expect(screen.getByTestId("boundary-error")).toBeTruthy();
    expect(viewOnScreen()).toBe(false);
    second.unmount();

    // With the backend in doubt, the next open waits on activation again.
    const activation = deferred<undefined>();
    activateForView.mockReturnValue(activation.promise);
    render(<Content panelId="panel-refused" />);
    expect(viewOnScreen()).toBe(false);
    await act(async () => {
      activation.resolve(undefined);
    });
    await drainWithoutTimers(viewOnScreen);
    expect(viewOnScreen()).toBe(true);
  });

  it("aborts a warm replacement's own signal when it throws on its first render", async () => {
    const { requestUserViewReload } = await import("@/services/plugin/pluginPanelLifecycle");
    const { Content, setStatus } = await loadModules();
    setStatus(worker({ generation: 3 }));
    render(<Content panelId="panel-throws" offerRequestReload />);
    await drainWithoutTimers(viewOnScreen);
    const outgoing = viewDouble.signals.at(-1)!;
    expect(outgoing.aborted).toBe(false);

    // A user reload of a healthy view on a live backend: a warm attempt.
    viewDouble.throwOnRender = true;
    await act(async () => {
      expect(requestUserViewReload("panel-throws")).toBe(true);
    });
    await drainWithoutTimers(() => screen.queryByTestId("boundary-error") !== null);
    expect(screen.getByTestId("boundary-error")).toBeTruthy();

    expect(outgoing.aborted).toBe(true);
    const failed = viewDouble.signals.filter((signal) => signal !== outgoing);
    expect(failed.length).toBeGreaterThan(0);
    // Every render of the failed attempt saw one signal, and it is aborted.
    expect(new Set(failed).size).toBe(1);
    expect(failed.every((signal) => signal.aborted)).toBe(true);
  });
});
