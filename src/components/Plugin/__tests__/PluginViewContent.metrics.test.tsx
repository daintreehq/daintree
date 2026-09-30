// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginViewContentConfig } from "../PluginViewContent";

vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: () => <div data-testid="skeleton" />,
  SkeletonHint: () => null,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/Plugin/PluginViewRuntimeStatus", () => ({
  PluginViewRuntimeStatus: () => null,
}));
vi.mock("@/services/plugin/pluginStyleContract", () => ({
  PLUGIN_STYLE_ROOT_PROPS: {},
  pluginStyleRootPropsFor: () => ({}),
  preparePluginStyles: () => Promise.resolve(),
  registerPluginStyleRoot: () => () => {},
}));

interface CapturedBoundaryProps {
  children: React.ReactNode;
  onReset?: () => void;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}
const boundaryProps = vi.hoisted(() => ({ last: null as CapturedBoundaryProps | null }));

vi.mock("@/components/ErrorBoundary", async () => {
  const { Component } = await import("react");
  class FakeBoundary extends Component<CapturedBoundaryProps, { hasError: boolean }> {
    state = { hasError: false };
    static getDerivedStateFromError(): { hasError: true } {
      return { hasError: true };
    }
    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
      this.props.onError?.(error, errorInfo);
    }
    render(): React.ReactNode {
      boundaryProps.last = this.props;
      return this.state.hasError ? <div data-testid="boundary-error" /> : this.props.children;
    }
  }
  return { ErrorBoundary: FakeBoundary };
});

/** Long enough for any queued double rAF (stubbed onto setTimeout 0) to have fired. */
const FRAME_SETTLE_MS = 10;

const VIEW_MODULE = "data:text/javascript,export default () => null";
const THROWING_VIEW_MODULE =
  "data:text/javascript,export default () => { throw new Error('view exploded'); }";

function makeContentConfig(componentPath = VIEW_MODULE): PluginViewContentConfig {
  return {
    id: "acme.dashboard",
    name: "Dashboard",
    componentPath,
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

async function settleFrames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, FRAME_SETTLE_MS));
  });
}

beforeEach(() => {
  boundaryProps.last = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      plugin: {
        onPanelKindsChanged: () => () => {},
        activateForView: vi.fn(() => Promise.resolve(undefined)),
      },
    },
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0)
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(async () => {
  cleanup();
  await vi.dynamicImportSettled();
  vi.doUnmock("react");
  vi.resetModules();
  vi.unstubAllGlobals();
});

/**
 * Captures each attempt's real `lazy()` factory while rendering a stub, so the
 * test decides when a load resolves — the paint reporter must not record until
 * that has happened for real.
 */
function captureLazyFactories(): Array<() => Promise<unknown>> {
  const factories: Array<() => Promise<unknown>> = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      lazy: (factory: () => Promise<unknown>) => {
        factories.push(factory);
        return function StubView() {
          return <div data-testid="plugin-view" />;
        };
      },
    };
  });
  return factories;
}

describe("PluginViewContent load metrics", () => {
  it("records one view-load sample per open, after first paint, flagged cold", async () => {
    const factories = captureLazyFactories();
    const { makePluginViewContent } = await import("../PluginViewContent");
    const { pluginViewMetrics } = await import("@/services/plugin/pluginViewMetrics");
    const Content = makePluginViewContent(makeContentConfig());

    render(<Content panelId="panel-1" />);
    await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
    await act(async () => {
      await factories.at(-1)!();
    });

    await waitFor(() =>
      expect(pluginViewMetrics.getLocalSnapshot("acme")?.viewLoads).toHaveLength(1)
    );
    const [sample] = pluginViewMetrics.getLocalSnapshot("acme")!.viewLoads;
    expect(sample).toMatchObject({ kindId: "acme.dashboard", retry: false });
    for (const key of ["activateMs", "importMs", "stylesMs", "loadMs", "firstPaintMs"] as const) {
      expect(sample![key]).toBeGreaterThanOrEqual(0);
    }
    expect(sample!.firstPaintMs).toBeGreaterThanOrEqual(sample!.importMs);

    const reports = pluginViewMetrics.drainReports();
    expect(reports.find((r) => r.pluginId === "acme")?.viewLoads).toEqual([sample]);
  });

  it("puts the load on the user-timing track under one entry per phase", async () => {
    const factories = captureLazyFactories();
    const { makePluginViewContent } = await import("../PluginViewContent");
    const Content = makePluginViewContent(makeContentConfig());

    render(<Content panelId="panel-a" />);
    render(<Content panelId="panel-b" />);
    await waitFor(() => expect(factories.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      await Promise.all(factories.map((factory) => factory()));
    });

    for (const phase of ["activate", "import", "styles", "view-load"]) {
      expect(performance.getEntriesByName(`daintree:plugin:acme:${phase}`, "measure")).toHaveLength(
        1
      );
    }
  });

  it("flags the attempt that replaces a failed view as a retry", async () => {
    const factories = captureLazyFactories();
    const { makePluginViewContent } = await import("../PluginViewContent");
    const { pluginViewMetrics } = await import("@/services/plugin/pluginViewMetrics");
    const Content = makePluginViewContent(makeContentConfig());

    render(<Content panelId="panel-retry" />);
    await waitFor(() => expect(factories).not.toHaveLength(0));
    const countBeforeRetry = factories.length;
    act(() => boundaryProps.last!.onError!(new Error("view exploded"), { componentStack: "" }));
    act(() => boundaryProps.last!.onReset!());
    await waitFor(() => expect(factories.length).toBeGreaterThan(countBeforeRetry));
    await act(async () => {
      await factories.at(-1)!();
    });

    await waitFor(() =>
      expect(pluginViewMetrics.getLocalSnapshot("acme")?.viewLoads.some((s) => s.retry)).toBe(true)
    );
  });

  it("does not record a sample for a view that never resolved", async () => {
    captureLazyFactories();
    const { makePluginViewContent } = await import("../PluginViewContent");
    const { pluginViewMetrics } = await import("@/services/plugin/pluginViewMetrics");
    const Content = makePluginViewContent(makeContentConfig());

    const { unmount } = render(<Content panelId="panel-closed" />);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, FRAME_SETTLE_MS));
    expect(pluginViewMetrics.getLocalSnapshot("acme")?.viewLoads ?? []).toHaveLength(0);
  });

  it("records the view's React commits through a Profiler", async () => {
    captureLazyFactories();
    const { makePluginViewContent } = await import("../PluginViewContent");
    const { pluginViewMetrics } = await import("@/services/plugin/pluginViewMetrics");
    const Content = makePluginViewContent(makeContentConfig());

    render(<Content panelId="panel-commits" />);
    await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());

    const snapshot = pluginViewMetrics.getLocalSnapshot("acme");
    expect(snapshot?.viewCommits?.count).toBeGreaterThanOrEqual(1);
    const report = pluginViewMetrics.drainReports().find((r) => r.pluginId === "acme");
    expect(report?.commitDurationsMs.length).toBeGreaterThanOrEqual(1);
  });

  describe("with the real lazy and Suspense", () => {
    it("waits for the view to resolve before recording its first paint", async () => {
      const activation = deferred<undefined>();
      Object.defineProperty(window, "electron", {
        configurable: true,
        writable: true,
        value: {
          plugin: {
            onPanelKindsChanged: () => () => {},
            activateForView: () => activation.promise,
          },
        },
      });
      const { makePluginViewContent } = await import("../PluginViewContent");
      const { pluginViewMetrics } = await import("@/services/plugin/pluginViewMetrics");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-real" />);
      await settleFrames();
      expect(screen.getByTestId("skeleton")).toBeTruthy();
      expect(pluginViewMetrics.getLocalSnapshot("acme")?.viewLoads ?? []).toHaveLength(0);

      await act(async () => {
        activation.resolve(undefined);
      });
      await waitFor(() =>
        expect(pluginViewMetrics.getLocalSnapshot("acme")?.viewLoads).toHaveLength(1)
      );
      expect(screen.queryByTestId("skeleton")).toBeNull();
    });

    it("records no load for a view that throws while rendering", async () => {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const { pluginViewMetrics } = await import("@/services/plugin/pluginViewMetrics");
      const Content = makePluginViewContent(makeContentConfig(THROWING_VIEW_MODULE));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      render(<Content panelId="panel-throws" />);
      await waitFor(() => expect(screen.getByTestId("boundary-error")).toBeTruthy());
      await settleFrames();
      expect(pluginViewMetrics.getLocalSnapshot("acme")?.viewLoads ?? []).toHaveLength(0);
      consoleError.mockRestore();
    });

    it("waits for a builtin view's own nested chunk before recording first paint", async () => {
      const chunk = deferred<{ default: () => React.ReactNode }>();
      const { lazy } = await import("react");
      const BuiltinView = lazy(() => chunk.promise);
      vi.doMock("@/registry/builtinRendererRegistry", () => ({
        useBuiltinPanelView: () => ({ status: "ready", component: BuiltinView }),
      }));
      const { makePluginViewContent } = await import("../PluginViewContent");
      const { pluginViewMetrics } = await import("@/services/plugin/pluginViewMetrics");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-builtin" />);
      await settleFrames();
      expect(pluginViewMetrics.getLocalSnapshot("acme")?.viewLoads ?? []).toHaveLength(0);

      await act(async () => {
        chunk.resolve({ default: () => <div data-testid="builtin-view" /> });
      });
      await waitFor(() => expect(screen.getByTestId("builtin-view")).toBeTruthy());
      await waitFor(() =>
        expect(pluginViewMetrics.getLocalSnapshot("acme")?.viewLoads).toMatchObject([
          { importMs: 0, stylesMs: 0, retry: false },
        ])
      );
      vi.doUnmock("@/registry/builtinRendererRegistry");
    });
  });
});
