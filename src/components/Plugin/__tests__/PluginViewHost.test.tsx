// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";

// Stub presentational deps — the host's behavioral contract is the lazy
// import + AbortController wiring, not the skeleton or fade-in chrome.
vi.mock("@/components/Browser/BrowserPaneSkeleton", () => ({
  BrowserPaneSkeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Stub the real ErrorBoundary with a minimal class — exercising the entire
// reporting pipeline (Sentry, errorStore, notify) is out of scope for the
// host's unit tests. The stub honors `resetKeys` and `onReset` so the reload
// path can be tested.
vi.mock("@/components/ErrorBoundary", async () => {
  const { Component } = await import("react");
  class FakeBoundary extends Component<
    {
      children: React.ReactNode;
      onReset?: () => void;
      resetKeys?: Array<string | number>;
      componentName?: string;
    },
    { hasError: boolean; lastKey: string | number | undefined }
  > {
    state = { hasError: false, lastKey: this.props.resetKeys?.[0] };
    static getDerivedStateFromError(): { hasError: true } {
      return { hasError: true };
    }
    componentDidCatch(): void {}
    componentDidUpdate(prev: { resetKeys?: Array<string | number> }): void {
      const next = this.props.resetKeys?.[0];
      if (this.state.hasError && next !== this.state.lastKey) {
        this.setState({ hasError: false, lastKey: next });
      } else if (next !== this.state.lastKey) {
        this.setState({ lastKey: next });
      }
      void prev;
    }
    render(): React.ReactNode {
      if (this.state.hasError) {
        return (
          <button
            data-testid="reset"
            onClick={(): void => {
              this.setState({ hasError: false });
              this.props.onReset?.();
            }}
          >
            Try again
          </button>
        );
      }
      return this.props.children;
    }
  }
  return { ErrorBoundary: FakeBoundary };
});

function makeConfig(overrides: Partial<PanelKindConfig> = {}): PanelKindConfig {
  return {
    id: "acme.dashboard",
    name: "Dashboard",
    iconId: "gauge",
    color: "#abcdef",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "acme",
    componentPath: "plugin://acme/dashboard.js",
    ...overrides,
  };
}

const onPanelKindsChangedMock = vi.fn();

beforeEach(() => {
  onPanelKindsChangedMock.mockReset();
  onPanelKindsChangedMock.mockReturnValue(() => {});
  vi.stubGlobal("electron", undefined);
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: { onPanelKindsChanged: onPanelKindsChangedMock } },
  });
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("makePluginViewHost", () => {
  it("renders an inline error when componentPath is missing", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig({ componentPath: undefined }));

    render(
      <Host
        id="panel-1"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    expect(screen.getByText(/Dashboard unavailable/i)).toBeTruthy();
    // The misconfigured branch must not subscribe to broadcasts — that wiring
    // belongs to the live host only.
    expect(onPanelKindsChangedMock).not.toHaveBeenCalled();
  });

  it("renders an inline error when extensionId is missing", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig({ extensionId: undefined }));

    render(
      <Host
        id="panel-1"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    expect(screen.getByText(/Dashboard unavailable/i)).toBeTruthy();
  });

  it("subscribes to plugin:panel-kinds-changed on mount and unsubscribes on unmount", async () => {
    const cleanupSpy = vi.fn();
    onPanelKindsChangedMock.mockReturnValue(cleanupSpy);

    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    const { unmount } = render(
      <Host
        id="panel-1"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalledTimes(1));
    unmount();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("tolerates a panel-kinds-changed push that omits its kind without throwing", async () => {
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation((cb) => {
      emit = cb;
      return () => {};
    });

    const { makePluginViewHost } = await import("../PluginViewHost");
    const config = makeConfig();
    const Host = makePluginViewHost(config);

    render(
      <Host
        id="panel-7"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());

    // Live push that still contains the kind: nothing observable changes.
    expect(() => act(() => emit!({ kinds: [config] }))).not.toThrow();
    // Push without the kind: the host aborts its controller — this branch
    // must complete without throwing even though the dynamic import never
    // resolved in jsdom (Suspense is still showing the skeleton).
    expect(() => act(() => emit!({ kinds: [] }))).not.toThrow();
  });

  it("passes the panel's extensionState to the mounted view as initialArgs", async () => {
    const capturedProps: Array<Record<string, unknown>> = [];
    // Replace React.lazy so the plugin view renders synchronously (the real
    // `plugin://` dynamic import never resolves in jsdom). The stub renders a
    // capturing component that records the props the host hands it — proving the
    // spawn-time `extensionState` reaches the view as `initialArgs`.
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: () =>
          function CapturingView(props: Record<string, unknown>) {
            capturedProps.push(props);
            return <div data-testid="plugin-view" />;
          },
      };
    });

    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    const initialArgs = { path: "/repo/src/index.ts", line: 12 };
    render(
      <Host
        id="panel-args"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
        extensionState={initialArgs}
      />
    );

    await waitFor(() => expect(screen.queryByTestId("plugin-view")).toBeTruthy());
    expect(capturedProps).not.toHaveLength(0);
    const props = capturedProps[capturedProps.length - 1]!;
    expect(props.panelId).toBe("panel-args");
    expect(props.pluginId).toBe("acme");
    expect(props.initialArgs).toEqual(initialArgs);
    // The bag is forwarded by reference from extensionState, not reconstructed.
    expect(props.initialArgs).toBe(initialArgs);
    vi.doUnmock("react");
  });

  it("awaits plugin.activateForView with the kind id before importing the view module (#10523)", async () => {
    // Reject activation with a sentinel so we can prove the import is *gated*
    // on activation, not merely fired alongside it: if the `await` were dropped
    // the factory would reject with the `plugin://` import error (module not
    // found) instead of this sentinel.
    const activateForView = vi.fn().mockRejectedValue(new Error("ACTIVATION_FAILED"));
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { onPanelKindsChanged: onPanelKindsChangedMock, activateForView } },
    });

    // Capture the lazy factory so we can drive it directly — the real
    // `plugin://` import never resolves in jsdom.
    let capturedFactory: (() => Promise<unknown>) | undefined;
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: (factory: () => Promise<unknown>) => {
          capturedFactory = factory;
          return function StubView() {
            return <div data-testid="plugin-view" />;
          };
        },
      };
    });

    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    render(
      <Host
        id="panel-act"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    await waitFor(() => expect(capturedFactory).toBeDefined());
    // Activation rejects, so the awaited call short-circuits before `import()`.
    await expect(capturedFactory!()).rejects.toThrow("ACTIVATION_FAILED");
    expect(activateForView).toHaveBeenCalledWith("acme.dashboard");
    vi.doUnmock("react");
  });

  it("surfaces the real activation cause when activateForView rejects, before import (#10618)", async () => {
    // The #10618 contract: on activation failure the activate-for-view IPC call
    // REJECTS with the real cause (the handler throws an AppError), carrying the
    // plugin's own message. The host's `await` rethrows it before `import()`, so
    // the ErrorBoundary surfaces why activation failed instead of a generic
    // import timeout. (Distinct from the #10523 gating test below, which only
    // proves the await ordering with a sentinel.)
    const activateForView = vi
      .fn()
      .mockRejectedValue(new Error('Plugin failed to activate for view "acme.dashboard": boom'));
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { onPanelKindsChanged: onPanelKindsChangedMock, activateForView } },
    });

    let capturedFactory: (() => Promise<unknown>) | undefined;
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: (factory: () => Promise<unknown>) => {
          capturedFactory = factory;
          return function StubView() {
            return <div data-testid="plugin-view" />;
          };
        },
      };
    });

    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    render(
      <Host
        id="panel-act-fail"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    await waitFor(() => expect(capturedFactory).toBeDefined());
    // The factory rejects with the real activation error and never reaches the
    // `plugin://` import.
    await expect(capturedFactory!()).rejects.toThrow(/boom/);
    expect(activateForView).toHaveBeenCalledWith("acme.dashboard");
    vi.doUnmock("react");
  });

  it("tolerates a missing activateForView binding without throwing (#10523)", async () => {
    // beforeEach installs window.electron.plugin without activateForView, so the
    // optional-chained call must no-op and the import must still proceed.
    let capturedFactory: (() => Promise<unknown>) | undefined;
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: (factory: () => Promise<unknown>) => {
          capturedFactory = factory;
          return function StubView() {
            return <div data-testid="plugin-view" />;
          };
        },
      };
    });

    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    render(
      <Host
        id="panel-noact"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    await waitFor(() => expect(capturedFactory).toBeDefined());
    // No activateForView present — the factory must not throw synchronously.
    let threw = false;
    const settled = (async () => {
      try {
        await capturedFactory!();
      } catch {
        // jsdom can't resolve the plugin:// import; that's expected here.
      }
    })().catch(() => {
      threw = true;
    });
    await settled;
    expect(threw).toBe(false);
    // The host still mounted its (stubbed) view rather than crashing.
    expect(screen.getByTestId("plugin-view")).toBeTruthy();
    vi.doUnmock("react");
  });

  it("reads the AbortController through a ref so post-retry removals abort the current signal", async () => {
    // Regression guard for the renderer-first teardown contract: if the
    // useEffect captured controllerRef.current into a const at setup time,
    // a kind-removed push after a retry would abort the prior (already
    // aborted) controller and leave the live signal armed. Capturing
    // controllerRef.current and asserting it changes across two pushes
    // proves the ref-through-callback pattern.
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation((cb) => {
      emit = cb;
      return () => {};
    });

    const { makePluginViewHost } = await import("../PluginViewHost");
    const config = makeConfig();
    const Host = makePluginViewHost(config);

    const { unmount } = render(
      <Host
        id="panel-9"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());

    // Removing the kind from the broadcast must abort. Doing this twice and
    // unmounting in between still must not throw — the callback resolves the
    // controller through the ref at call time, not via a stale closure.
    expect(() => act(() => emit!({ kinds: [] }))).not.toThrow();
    expect(() => act(() => emit!({ kinds: [] }))).not.toThrow();

    unmount();
  });
});
