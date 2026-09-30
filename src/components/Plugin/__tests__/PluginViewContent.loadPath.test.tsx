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
 * open that renders in the commit that mounts it — without giving up
 * activate-before-render when the backend is not known to be live (#10523).
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
vi.mock("@/components/ErrorBoundary", async () => {
  const { Component } = await import("react");
  class FakeBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError(): { failed: true } {
      return { failed: true };
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

beforeEach(() => {
  activateForView = vi.fn<(kindId: string) => Promise<undefined>>(() => Promise.resolve(undefined));
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: { onPanelKindsChanged: () => () => {}, activateForView } },
  });
  vi.doMock(VIEW_MODULE, () => ({
    default: function DashboardView() {
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

  it("renders a warm open in the commit that mounts it, and still activates", async () => {
    const { Content, setStatus } = await loadModules();
    setStatus(worker({ generation: 3 }));

    const first = render(<Content panelId="panel-warm" />);
    await drainWithoutTimers(viewOnScreen);
    expect(viewOnScreen()).toBe(true);
    first.unmount();
    expect(activateForView).toHaveBeenCalledTimes(1);

    // Activation is still sent — it stamps the plugin's idle-dispose activity —
    // but nothing waits on it.
    activateForView.mockReturnValue(new Promise<never>(() => {}));
    render(<Content panelId="panel-warm" />);
    expect(viewOnScreen()).toBe(true);
    await act(async () => {});
    expect(activateForView).toHaveBeenCalledTimes(2);
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
    expect(viewOnScreen()).toBe(true);
    await act(async () => {});
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
    expect(viewOnScreen()).toBe(true);
    // The refusal still reaches the boundary, as it would on a cold open.
    await drainWithoutTimers(() => screen.queryByTestId("boundary-error") !== null);
    expect(screen.getByTestId("boundary-error")).toBeTruthy();
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
});
