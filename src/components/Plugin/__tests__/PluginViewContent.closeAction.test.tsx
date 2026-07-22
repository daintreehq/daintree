// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginViewContentConfig } from "../PluginViewContent";

/**
 * The close-action seam (#11301), deliberately in its own file.
 *
 * Proving it requires a plugin view that actually reaches the error boundary,
 * which means a `lazy` double that THROWS. A throwing double is not safe to mix
 * into the main suite: `vi.doUnmock("react")` does not invalidate the already
 * imported `PluginViewContent` graph that closed over it, so a later test's
 * dynamic import can still resolve the thrower and paint a second diagnostics
 * pane — which is exactly how it broke shard 1/4 while passing locally. A
 * separate file gets a separate module registry, so the hazard cannot escape.
 */

vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
  SkeletonHint: () => null,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

interface CapturedFallbackProps {
  error: Error;
  errorInfo?: React.ErrorInfo;
  resetError: () => void;
  incidentId?: string | null;
}
interface CapturedBoundaryProps {
  children: React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  onReset?: () => void;
  fallback?: React.ComponentType<CapturedFallbackProps>;
}

// Minimal boundary stub: catch, then render the supplied fallback the way the
// real one does. Exercising the real ErrorBoundary's reporting pipeline
// (Sentry, errorStore, notify) is out of scope for this seam.
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
      if (!this.state.hasError) return this.props.children;
      const Fallback = this.props.fallback;
      if (!Fallback) return null;
      return (
        <Fallback
          error={new Error("view exploded")}
          resetError={(): void => {
            this.setState({ hasError: false });
            this.props.onReset?.();
          }}
        />
      );
    }
  }
  return { ErrorBoundary: FakeBoundary };
});

// A view that throws from an effect rather than from render: a render-time
// throw trips React's concurrent-mount recovery, which discards the uncommitted
// tree and replays it. A post-commit throw reaches the boundary deterministically.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    lazy: () =>
      function ThrowingView() {
        actual.useEffect(() => {
          throw new Error("view exploded");
        }, []);
        return <div data-testid="plugin-view" />;
      },
  };
});

function makeContentConfig(): PluginViewContentConfig {
  return {
    id: "acme.dashboard",
    name: "Dashboard",
    componentPath: "plugin://acme/__dtv-1/dashboard.js",
    extensionId: "acme",
  };
}

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: { onPanelKindsChanged: vi.fn(() => () => {}) } },
  });
});

describe("plugin view close action", () => {
  it("routes the diagnostics pane's Close panel to the host's callback", async () => {
    const { makePluginViewContent } = await import("../PluginViewContent");
    const Content = makePluginViewContent(makeContentConfig());
    const onRequestClose = vi.fn();

    render(<Content panelId="panel-close" onRequestClose={onRequestClose} />);

    // The fallback is factory-scoped for identity stability, so the callback
    // reaches it by context — a closure over it would change the component type
    // on every render and remount the diagnostics pane. Driving the real button
    // proves that whole path, not just one prop hop.
    fireEvent.click(await screen.findByTestId("plugin-view-diagnostics-close"));

    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(onRequestClose).toHaveBeenCalledWith();
  });

  it("renders no close affordance when the host supplies none", async () => {
    const { makePluginViewContent } = await import("../PluginViewContent");
    const Content = makePluginViewContent(makeContentConfig());

    render(<Content panelId="panel-no-close" />);

    // A host-less embedding must not offer a button that closes nothing.
    await screen.findByTestId("plugin-view-diagnostics");
    expect(screen.queryByTestId("plugin-view-diagnostics-close")).toBeNull();
    expect(screen.getByTestId("plugin-view-diagnostics-retry")).toBeTruthy();
  });

  it("reports the render failure to the panel lifecycle service", async () => {
    const { resetPluginPanelLifecycleForTests, syncPluginPanels } =
      await import("@/services/plugin/pluginPanelLifecycle");
    // Typed rather than bare: an untyped `vi.fn` infers zero parameters, so
    // `mock.calls` comes back as `[][]` and destructuring it needs a cast that
    // regresses the no-unsafe-type-assertion lint baseline.
    const report = vi.fn<(events: { phase: string }[]) => Promise<void>>(() => Promise.resolve());
    resetPluginPanelLifecycleForTests();
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        plugin: {
          onPanelKindsChanged: vi.fn(() => () => {}),
          reportPanelLifecycle: report,
        },
      },
    });

    const { makePluginViewContent } = await import("../PluginViewContent");
    const Content = makePluginViewContent(makeContentConfig());
    syncPluginPanels([
      { panelId: "panel-failed", kindId: "acme.dashboard", pluginId: "acme", location: "grid" },
    ]);

    render(<Content panelId="panel-failed" />);
    await screen.findByTestId("plugin-view-diagnostics");
    await Promise.resolve();

    // A worker that only ever hears `mounted` cannot tell a wedged panel from a
    // working one, so the boundary has to surface the failure too.
    const phases = report.mock.calls.flatMap(([events]) => events.map((e) => e.phase));
    expect(phases).toContain("render-failed");
    resetPluginPanelLifecycleForTests();
  });
});
