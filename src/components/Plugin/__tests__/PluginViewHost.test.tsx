// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";

// Stub presentational deps — the skeleton and fade-in are incidental here. The
// host's contract is panel adaptation: mapping panel props onto ContentPanel and
// mounting the content component inside it. The lazy import and AbortController
// wiring moved to PluginViewContent and are covered by its own suite (#11240).
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

// The subset of ErrorBoundary's contract this suite observes. The boundary now
// lives inside PluginViewContent; what the host cares about is only that a
// crashed view still sits inside the chrome. Typed here rather than cast at each
// read site — a cast would regress the per-rule no-unsafe-type-assertion lint
// baseline.
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

// The fake records the props it was handed and renders a reset sentinel once it
// catches, which is how the chrome tests below observe a crashed view. The
// fallback's own wiring is asserted in the PluginViewContent suite, which owns
// the boundary.
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

  it("hands the content a close callback that forwards no arguments (#11301)", async () => {
    const captured = vi.hoisted(() => ({ onRequestClose: undefined as undefined | (() => void) }));
    vi.doMock("@/components/Plugin/PluginViewContent", () => ({
      makePluginViewContent: () => (props: { onRequestClose?: () => void }) => {
        captured.onRequestClose = props.onRequestClose;
        return <div data-testid="content-probe" />;
      },
    }));

    try {
      const { makePluginViewHost } = await import("../PluginViewHost");
      const Host = makePluginViewHost(makeConfig());
      const onClose = vi.fn();

      render(
        <Host
          id="panel-close"
          title="Dashboard"
          isFocused={false}
          onFocus={(): void => {}}
          onClose={onClose}
        />
      );

      expect(captured.onRequestClose).toBeTypeOf("function");
      captured.onRequestClose!();

      // `onClose(force?: boolean)`. Passing the panel's handler straight through
      // to a button would hand it the click event as a truthy `force`, turning
      // the fallback's recoverable close into a forced one.
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith();
    } finally {
      vi.doUnmock("@/components/Plugin/PluginViewContent");
    }
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

  it("passes the panel's extensionState to the mounted view as initialArgs", async () => {
    const capturedProps: Array<Record<string, unknown>> = [];
    // Replace React.lazy so the plugin view renders synchronously (the real
    // `plugin://` dynamic import rejects in jsdom — unsupported URL scheme —
    // so the real view could never mount here). The stub renders a
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

    try {
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
      const props = capturedProps[capturedProps.length - 1]!;
      expect(props.panelId).toBe("panel-args");
      expect(props.pluginId).toBe("acme");
      // The bag is forwarded by reference from extensionState, not reconstructed.
      expect(props.initialArgs).toBe(initialArgs);
    } finally {
      // Unmock in `finally`: a failed assertion above would otherwise leak the
      // capturing `lazy` into every later test in this file (`vi.resetModules`
      // clears the module cache but not the registered mock).
      vi.doUnmock("react");
    }
  });

  it("hands the content a recovery reader that reads the CURRENT accepted state (#12278)", async () => {
    // Recovery must not cost the user the work the view persisted since the
    // panel opened. `initialArgs` is frozen at mount by design, so restoring it
    // on a backend restart would silently roll the panel back to the bag it was
    // opened with — the reader is what closes that gap, and it has to read at
    // call time rather than capture at render time.
    //
    // The content layer is stubbed rather than the lazy view: `readRecoveryState`
    // is a prop the host hands the CONTENT, and the content never forwards it to
    // the plugin's own view (a plugin has no business reading panel persistence).
    const contentProps: Array<Record<string, unknown>> = [];
    vi.doMock("@/components/Plugin/PluginViewContent", () => ({
      makePluginViewContent: () =>
        function CapturingContent(props: Record<string, unknown>) {
          contentProps.push(props);
          return <div data-testid="plugin-content" />;
        },
    }));

    try {
      const { setPanelStoreAccessor } = await import("@/store/storeAccessors");
      const { makePluginViewHost } = await import("../PluginViewHost");
      const Host = makePluginViewHost(makeConfig());

      const panel = { extensionState: { tab: "overview" } };
      setPanelStoreAccessor(
        () =>
          ({ panelsById: { "panel-recover": panel }, panelIds: [], tabGroups: new Map() }) as never
      );

      render(
        <Host
          id="panel-recover"
          title="Dashboard"
          isFocused={false}
          onFocus={(): void => {}}
          onClose={(): void => {}}
          extensionState={{ tab: "overview" }}
        />
      );

      await waitFor(() => expect(screen.queryByTestId("plugin-content")).toBeTruthy());
      const read = contentProps[contentProps.length - 1]!.readRecoveryState as () => {
        state?: Record<string, unknown>;
      } | null;
      expect(read).toBeTypeOf("function");

      // The view persisted after mounting. The reader must see THAT, not the
      // bag the host rendered with.
      panel.extensionState = { tab: "logs" };
      expect(read()?.state).toEqual({ tab: "logs" });
    } finally {
      vi.doUnmock("@/components/Plugin/PluginViewContent");
    }
  });

  it("passes the panel's own worktreeId to the mounted view (#11297)", async () => {
    const capturedProps: Array<Record<string, unknown>> = [];
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

    try {
      const { makePluginViewHost } = await import("../PluginViewHost");
      const Host = makePluginViewHost(makeConfig());

      render(
        <Host
          id="panel-wt"
          title="Dashboard"
          isFocused={false}
          onFocus={(): void => {}}
          onClose={(): void => {}}
          worktreeId="wt-owning"
        />
      );

      await waitFor(() => expect(screen.queryByTestId("plugin-view")).toBeTruthy());
      // The value already rides the panel instance; before #11297 the host
      // dropped it on the floor, leaving a view opened from the generic New
      // Panel palette with no way to know which worktree it belonged to.
      expect(capturedProps[capturedProps.length - 1]!.worktreeId).toBe("wt-owning");
    } finally {
      vi.doUnmock("react");
    }
  });

  it("keeps the plugin view mounted across panel prop changes (#11240)", async () => {
    // The content component type must be created once, at factory-construction
    // scope. Constructing it during the host's render mints a new type per
    // render, so React unmounts and remounts the plugin view — restarting its
    // `plugin://` import and aborting its disposeSignal — every time a title or
    // focus prop changes. (A `useMemo` with a stable dep array would survive
    // ordinary rerenders, but it ties the component's identity to a hook that
    // silently remounts the view the moment a dep changes; construction belongs
    // outside the component entirely.) The signal identity is the observable:
    // a remount would hand the view a fresh, distinct controller.
    const signals: AbortSignal[] = [];
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: () =>
          function CapturingView(props: { disposeSignal: AbortSignal }) {
            signals.push(props.disposeSignal);
            return <div data-testid="plugin-view" />;
          },
      };
    });

    try {
      const { makePluginViewHost } = await import("../PluginViewHost");
      const Host = makePluginViewHost(makeConfig());

      const { rerender } = render(
        <Host
          id="panel-identity"
          title="Dashboard"
          isFocused={false}
          onFocus={(): void => {}}
          onClose={(): void => {}}
        />
      );

      await waitFor(() => expect(signals).not.toHaveLength(0));
      const first = signals[0]!;

      act(() => {
        rerender(
          <Host
            id="panel-identity"
            title="Renamed by the user"
            isFocused
            onFocus={(): void => {}}
            onClose={(): void => {}}
          />
        );
      });

      // Same controller instance, still live: the view was re-rendered, not
      // re-created.
      expect(signals[signals.length - 1]).toBe(first);
      expect(first.aborted).toBe(false);
    } finally {
      vi.doUnmock("react");
    }
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

    render(<Host {...hostProps} onFocus={onFocus} />);

    // The skeleton stands in for plugin content here — the point is that a click
    // inside the panel's body reaches ContentPanel's handler, which is exactly
    // what the bare host div swallowed.
    await waitFor(() => expect(screen.getByTestId("skeleton")).toBeTruthy());
    screen.getByTestId("skeleton").click();

    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("keeps the pane chrome mounted and closable while the plugin view is still loading", async () => {
    const { makePluginViewHost } = await import("../PluginViewHost");
    const Host = makePluginViewHost(makeConfig());
    const onClose = vi.fn<() => void>();

    const { container } = render(<Host {...hostProps} onClose={onClose} onFocus={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("skeleton")).toBeTruthy());
    expect(panelRoot(container)).toBeTruthy();
    expect(container.querySelector("[data-pane-chrome]")).toBeTruthy();

    // Not just present — operable. A loading view must stay dismissable.
    act(() => screen.getByTestId("panel-close").click());
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the pane chrome mounted and closable after the plugin view crashes", async () => {
    // The structural claim of the fix: ContentPanel sits OUTSIDE the error
    // boundary, so a thrown plugin view swaps only the content slot for the
    // boundary fallback while the header and close control stay live. Without
    // that, a crashed plugin view would be stranded open (#11228).
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: () =>
          function CrashingView(): never {
            throw new Error("plugin view exploded on render");
          },
      };
    });

    try {
      const { makePluginViewHost } = await import("../PluginViewHost");
      const Host = makePluginViewHost(makeConfig());
      const onClose = vi.fn<() => void>();

      const { container } = render(<Host {...hostProps} onClose={onClose} onFocus={() => {}} />);

      // The mocked ErrorBoundary renders its reset sentinel once it catches.
      await waitFor(() => expect(screen.getByTestId("reset")).toBeTruthy());
      // Chrome coexists with the fallback rather than being replaced by it.
      expect(panelRoot(container)).toBeTruthy();
      expect(container.querySelector("[data-pane-chrome]")).toBeTruthy();

      act(() => screen.getByTestId("panel-close").click());
      expect(onClose).toHaveBeenCalled();
    } finally {
      // A failed assertion above would otherwise leak the crashing `lazy` into
      // every later test in this file.
      vi.doUnmock("react");
    }
  });

  it("passes the plugin's own kind and the live panel title to the shell", async () => {
    // Resolve the registry from the SAME post-reset module graph as the host —
    // the suite calls vi.resetModules() between tests, so a statically imported
    // registerPanelKind would write to a different instance than the one the
    // dynamically imported ContentPanel reads (mirrors the focusPanelInput note
    // above). Register the kind so the real chrome derivation resolves it to the
    // panel branch, proving `kindId` (not a default or `props.kind`) reached
    // ContentPanel end-to-end, via `data-runtime-*` on the panel root.
    const { registerPanelKind, unregisterPanelKind } =
      await import("@shared/config/panelKindRegistry");
    registerPanelKind({
      id: "acme.dashboard",
      name: "Dashboard",
      iconId: "gauge",
      color: "#abcdef",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "acme",
    });
    try {
      const { makePluginViewHost } = await import("../PluginViewHost");
      const Host = makePluginViewHost(makeConfig());

      // `buildPanelProps` supplies no `kind`, so the host must source it from its
      // closure; the title has to be the instance's, not the kind's config name.
      const { container } = render(
        <Host {...hostProps} title="Renamed by the user" onFocus={() => {}} />
      );

      await waitFor(() => expect(screen.getByTestId("skeleton")).toBeTruthy());
      const root = panelRoot(container);
      // Non-PTY panel chrome, keyed off the plugin kind's registry entry — a
      // wrong or defaulted kind would derive a different runtime kind/icon.
      expect(root.getAttribute("data-runtime-kind")).toBe("panel");
      expect(root.getAttribute("data-runtime-icon-id")).toBe("gauge");
      // The header renders the title in more than one node (visible label plus
      // the rename editor's prefill), so match within the chrome, not globally.
      const chrome = container.querySelector<HTMLElement>("[data-pane-chrome]");
      expect(chrome).toBeTruthy();
      expect(within(chrome!).getAllByText("Renamed by the user").length).toBeGreaterThan(0);
    } finally {
      unregisterPanelKind("acme.dashboard");
    }
  });
});
