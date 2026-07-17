// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";

// Stub presentational deps — the host's behavioral contract is the lazy
// import + AbortController wiring, not the skeleton or fade-in chrome.
vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
  SkeletonHint: () => null,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ContentPanel renders for real: it owns the click-to-focus wiring and the
// chrome this suite asserts on, so a stand-in would make those behaviors
// properties of the double instead of the host. Only its store/context graph is
// stubbed — the same scaffold ContentPanel.focus.test.tsx uses. `panelKindHasPty`
// and PanelHeader stay real so the focus gate and the close control are genuine.
vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));
vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));
vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));
vi.mock("@/components/Layout/useDockBlockedState", () => ({
  useDockBlockedState: () => null,
}));
vi.mock("@/utils/terminalAgentDisplayState", () => ({
  getTerminalAgentDisplayState: () => undefined,
}));
vi.mock("@/components/Terminal/TerminalHeaderContent", () => ({
  TerminalHeaderContent: () => null,
}));
vi.mock("@/store", () => ({
  usePreferencesStore: (
    selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: true }),
  usePanelStore: (selector: (s: { panelsById: Record<string, never> }) => unknown) =>
    selector({ panelsById: {} }),
}));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Count live focus-registry owners per panel id while delegating to the real
// registry — the duplicate-registration regression is invisible to the registry's
// own API (last writer just wins), so it can only be caught at the seam.
// `importOriginal` is spread back in: a bare factory would drop `focusPanelInput`
// and every other export the panel graph imports from here.
const focusRegistry = vi.hoisted(() => {
  const live = new Map<string, number>();
  return {
    live,
    liveCount: (id: string) => live.get(id) ?? 0,
    reset: () => live.clear(),
  };
});

vi.mock("@/components/Panel/panelFocusRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/Panel/panelFocusRegistry")>();
  return {
    ...actual,
    registerPanelFocusHandler: (id: string, handler: () => boolean) => {
      focusRegistry.live.set(id, (focusRegistry.live.get(id) ?? 0) + 1);
      const release = actual.registerPanelFocusHandler(id, handler);
      return () => {
        focusRegistry.live.set(id, Math.max(0, (focusRegistry.live.get(id) ?? 0) - 1));
        release();
      };
    },
  };
});

// The subset of ErrorBoundary's contract the host relies on. Typed here rather
// than cast at each read site — a cast would regress the per-rule
// no-unsafe-type-assertion lint baseline.
interface CapturedFallbackProps {
  error: Error;
  errorInfo?: React.ErrorInfo;
  resetError: () => void;
  incidentId?: string | null;
}
interface CapturedBoundaryProps {
  children: React.ReactNode;
  onReset?: () => void;
  resetKeys?: Array<string | number>;
  componentName?: string;
  fallback?: React.ComponentType<CapturedFallbackProps>;
}

// The fake records the props it was handed, so the tests can render the very
// fallback the host supplied. Asserting only that `fallback` is *a function*
// would be satisfied by `() => null`.
const boundaryProps = vi.hoisted(() => ({ last: null as CapturedBoundaryProps | null }));

// Stub the real ErrorBoundary with a minimal class — exercising the entire
// reporting pipeline (Sentry, errorStore, notify) is out of scope for the
// host's unit tests. The stub honors `resetKeys` and `onReset` so the reload
// path can be tested.
vi.mock("@/components/ErrorBoundary", async () => {
  const { Component } = await import("react");
  class FakeBoundary extends Component<
    CapturedBoundaryProps,
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
      boundaryProps.last = this.props;
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
  boundaryProps.last = null;
  focusRegistry.reset();
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

  it("hands the boundary a plugin-specific fallback and an undoubled component name (#11207)", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    render(
      <Host
        id="panel-fallback"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    await waitFor(() => expect(boundaryProps.last).not.toBeNull());
    // `kindId` already carries the plugin prefix, so re-prefixing it produced
    // `PluginView:acme.acme.dashboard` in the title and every log field.
    expect(boundaryProps.last!.componentName).toBe("PluginView:acme.dashboard");
  });

  // Closes the seam the fake boundary would otherwise hide: asserting that
  // `fallback` is merely a function is satisfied by `() => null`. Rendering the
  // very component the host handed the boundary proves the wiring reaches the
  // real diagnostics pane, carries this plugin's identity, and fails closed
  // when the runtime store holds no metadata for it.
  it("hands the boundary a fallback that renders this plugin's diagnostics (#11207)", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    render(
      <Host
        id="panel-fallback-render"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );
    await waitFor(() => expect(boundaryProps.last).not.toBeNull());

    const Fallback = boundaryProps.last!.fallback!;
    const error = new Error("view exploded");
    error.stack = "Error: view exploded\n    at View (/Users/alice/acme/dashboard.js:3:1)";

    render(
      <Fallback
        error={error}
        errorInfo={{ componentStack: "\n    at View" }}
        resetError={(): void => {}}
        incidentId={null}
      />
    );

    const pane = screen.getByTestId("plugin-view-diagnostics").textContent ?? "";
    expect(pane).toContain("view exploded");
    expect(pane).toContain("plugin://acme/dashboard.js");
    expect(pane).toContain("acme.dashboard");
    // This suite never seeds a runtime snapshot ⇒ unknown devMode ⇒ redacted.
    expect(screen.getByTestId("plugin-view-diagnostics-trace").textContent).not.toContain(
      "/Users/alice"
    );
  });

  // The metadata the pane needs may not exist at host-mount time: `loadPlugin`
  // registers the panel kind before the plugin is listable, and dev attach
  // never fires provenance. Reaching the fallback means the view already threw,
  // so the plugin is loaded — the pane must pull for itself at that point
  // rather than trust whatever the store happened to hold earlier (#11207).
  it("pulls a fresh plugin snapshot when the diagnostics pane mounts (#11207)", async () => {
    const list = vi.fn().mockResolvedValue([]);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        plugin: {
          onPanelKindsChanged: onPanelKindsChangedMock,
          onProvenanceChanged: vi.fn().mockReturnValue(() => {}),
          list,
        },
      },
    });

    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    render(
      <Host
        id="panel-refresh"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );
    await waitFor(() => expect(boundaryProps.last).not.toBeNull());
    const callsBeforeCrash = list.mock.calls.length;

    const Fallback = boundaryProps.last!.fallback!;
    render(<Fallback error={new Error("view exploded")} resetError={(): void => {}} />);

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(callsBeforeCrash));
  });

  // The dev-plugin snapshot can land *after* the view has already crashed (the
  // pull is async, and `daintree-plugin dev` never fires provenance). The pane
  // must upgrade in place rather than stay redacted until the user retries.
  it("upgrades a redacted trace to raw when the plugin's dev-mode snapshot lands late (#11207)", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    // Resolved from the same module graph as the host — the suite resets
    // modules between cases, so a static import would seed a different store.
    const { usePluginRuntimeStore } = await import("@/store/pluginRuntimeStore");
    const Host = makePluginViewHost(makeConfig());

    render(
      <Host
        id="panel-late-snapshot"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );
    await waitFor(() => expect(boundaryProps.last).not.toBeNull());

    const Fallback = boundaryProps.last!.fallback!;
    const error = new Error("view exploded");
    error.stack = "Error: view exploded\n    at View (/Users/alice/acme/dashboard.js:3:1)";
    render(<Fallback error={error} resetError={(): void => {}} />);

    const trace = () => screen.getByTestId("plugin-view-diagnostics-trace").textContent ?? "";
    expect(trace()).not.toContain("/Users/alice");

    act(() => {
      usePluginRuntimeStore.setState({
        pluginMetaById: new Map([["acme", { devMode: true, displayName: "Acme Tools" }]]),
      });
    });

    expect(trace()).toContain("/Users/alice");
    // The same snapshot carries the manifest display name, which the panel's
    // own `config.name` ("Dashboard") can't supply.
    expect(screen.getByTestId("plugin-view-diagnostics").textContent).toContain("Acme Tools");
  });
});

/** The panel root ContentPanel renders — the host no longer owns one (#11228). */
function panelRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('[data-panel-id="panel-1"]');
  if (!root) throw new Error("panel root not rendered");
  return root;
}

/**
 * Focus *delivery*: becoming the focused pane must move DOM focus, or the pane
 * paints as selected while keystrokes land wherever they were before (#11133).
 * ContentPanel now owns the focus target, so these assert against its root
 * rather than a host-owned div. Focusing that root claims the keyboard in the
 * parent document; it never pushes focus into the plugin's guest frame, and it
 * must never pull focus out of a plugin input the user is already typing in.
 */
describe("PluginViewHost reactive focus (#11133)", () => {
  it("claims DOM focus when the host becomes the focused pane", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const { container, rerender } = render(
      <Host
        id="panel-1"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );
    expect(document.activeElement).toBe(outside);

    act(() => {
      rerender(
        <Host
          id="panel-1"
          title="Dashboard"
          isFocused
          onFocus={(): void => {}}
          onClose={(): void => {}}
        />
      );
    });

    expect(document.activeElement).toBe(panelRoot(container));
    outside.remove();
  });

  it("leaves focus inside the plugin's own surface alone", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    // The suite resets modules between tests, so the registry must be resolved
    // from the same module graph as the host — a static import would hold a
    // stale Map and see none of the host's registrations.
    const { focusPanelInput } = await import("@/components/Panel/panelFocusRegistry");
    const Host = makePluginViewHost(makeConfig());

    const { container } = render(
      <Host
        id="panel-1"
        title="Dashboard"
        isFocused={false}
        onFocus={(): void => {}}
        onClose={(): void => {}}
      />
    );

    const guestInput = document.createElement("input");
    panelRoot(container).appendChild(guestInput);
    act(() => guestInput.focus());

    let accepted = false;
    act(() => {
      accepted = focusPanelInput("panel-1");
    });

    expect(accepted).toBe(true);
    expect(document.activeElement).toBe(guestInput);
  });

  it("registers exactly one focus handler for the panel id", async () => {
    // The host used to call usePanelRootFocus itself. Now that ContentPanel
    // wraps it, a surviving host-side call would be a second registration under
    // one id — and the registry is last-writer-wins, so the two would silently
    // clobber each other rather than fail loudly (#11132/#11150).
    const { focusPanelInput } = await import("@/components/Panel/panelFocusRegistry");
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

    // Count live registrations, not calls: a registration that is added and
    // released still nets to one owner, and counting this way stays correct if
    // Strict Mode ever double-invokes the effect.
    expect(focusRegistry.liveCount("panel-1")).toBe(1);
    expect(focusPanelInput("panel-1")).toBe(true);

    unmount();
    expect(focusRegistry.liveCount("panel-1")).toBe(0);
    expect(focusPanelInput("panel-1")).toBe(false);
  });
});

/**
 * The bug itself (#11228): a plugin panel rendered fine but never took part in
 * click-based selection, so `focusedId` stayed on the previously focused agent
 * and Cmd+W closed *that* instead. The chrome cases pin the other half — the
 * shell has to outlive the plugin's own loading and crash states, or a wedged
 * view is unclosable.
 */
describe("PluginViewHost panel integration (#11228)", () => {
  const hostProps = {
    id: "panel-1",
    title: "Dashboard",
    isFocused: false,
    onClose: (): void => {},
  };

  it("selects the panel when a click bubbles out of the plugin's content", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());
    const onFocus = vi.fn<() => void>();

    const { container } = render(<Host {...hostProps} onFocus={onFocus} />);

    // The skeleton stands in for plugin content here — the point is that a click
    // anywhere inside the panel's body reaches ContentPanel's handler, which is
    // exactly what the bare host div swallowed.
    await waitFor(() => expect(screen.getByTestId("skeleton")).toBeTruthy());
    screen.getByTestId("skeleton").click();

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(panelRoot(container)).toBeTruthy();
  });

  it("keeps the pane chrome mounted while the plugin view is still loading", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    const { container } = render(<Host {...hostProps} onFocus={(): void => {}} />);

    await waitFor(() => expect(screen.getByTestId("skeleton")).toBeTruthy());
    expect(panelRoot(container)).toBeTruthy();
    expect(container.querySelector("[data-pane-chrome]")).toBeTruthy();
    expect(screen.getByTestId("panel-close")).toBeTruthy();
  });

  it("passes the plugin's own kind and the live panel title to the shell", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());

    // `buildPanelProps` supplies no `kind`, so the host must source it from its
    // closure; the title has to be the instance's, not the kind's config name.
    const { container } = render(
      <Host {...hostProps} title="Renamed by the user" onFocus={() => {}} />
    );

    await waitFor(() => expect(screen.getByTestId("skeleton")).toBeTruthy());
    expect(panelRoot(container).getAttribute("data-panel-id")).toBe("panel-1");
    // The header renders the title in more than one node (visible label plus the
    // rename editor's prefill), so match within the chrome rather than globally.
    const chrome = container.querySelector<HTMLElement>("[data-pane-chrome]");
    expect(chrome).toBeTruthy();
    expect(within(chrome!).getAllByText("Renamed by the user").length).toBeGreaterThan(0);
    expect(screen.queryByText("Dashboard")).toBeNull();
  });
});
