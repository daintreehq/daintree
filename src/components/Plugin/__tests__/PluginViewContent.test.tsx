// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import type { PluginViewContentConfig } from "../PluginViewContent";

// Stub presentational deps — the content's behavioral contract is the lazy
// import + AbortController wiring, not the skeleton or fade-in.
vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
  SkeletonHint: () => null,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Note what is absent: this suite mocks none of the worktree/preferences/tooltip
// graph that ContentPanel needs, because the content layer renders no panel
// chrome at all. Reintroducing a ContentPanel wrap here would throw on render
// (it reaches useWorktreeStore with no provider) rather than quietly pass —
// which is the point (#11240).

// The subset of ErrorBoundary's contract the content relies on. Typed here
// rather than cast at each read site — a cast would regress the per-rule
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
// fallback the content supplied. Asserting only that `fallback` is *a function*
// would be satisfied by `() => null`.
const boundaryProps = vi.hoisted(() => ({ last: null as CapturedBoundaryProps | null }));

// Stub the real ErrorBoundary with a minimal class — exercising the entire
// reporting pipeline (Sentry, errorStore, notify) is out of scope for these
// unit tests. The stub honors `resetKeys` and `onReset` so the reload path can
// be tested.
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
        // Deliberately does NOT render `props.fallback`. Tests here reach the
        // error state incidentally — `#11207` lets the real `lazy` attempt a
        // `plugin://` import that jsdom cannot resolve — and rendering the
        // fallback would paint a diagnostics pane alongside the one those tests
        // render explicitly, so `getByTestId` finds two. The close-action seam,
        // which does need a rendered fallback, lives in
        // `PluginViewContent.closeAction.test.tsx` with its own stub.
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

function makeContentConfig(
  overrides: Partial<PluginViewContentConfig> = {}
): PluginViewContentConfig {
  return {
    id: "acme.dashboard",
    name: "Dashboard",
    componentPath: "plugin://acme/dashboard.js",
    extensionId: "acme",
    ...overrides,
  };
}

const onPanelKindsChangedMock = vi.fn();

beforeEach(() => {
  boundaryProps.last = null;
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

describe("makePluginViewContent", () => {
  it("renders the plugin view with no panel chrome around it (#11240)", async () => {
    // The decoupling contract itself: whatever presentation a host chooses, the
    // content layer contributes none of it. A dialog host (#11239) mounting this
    // must not inherit a grid pane's root, chrome, or close control.
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: () =>
          function StubView() {
            return <div data-testid="plugin-view" />;
          },
      };
    });

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      const { container } = render(<Content panelId="panel-1" />);

      await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
      expect(container.querySelector("[data-panel-id]")).toBeNull();
      expect(container.querySelector("[data-pane-chrome]")).toBeNull();
      expect(screen.queryByTestId("panel-close")).toBeNull();
    } finally {
      vi.doUnmock("react");
    }
  });

  it("hands the plugin view its panel id, plugin id, dispose signal, and initial args", async () => {
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
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      const initialArgs = { path: "/repo/src/index.ts", line: 12 };
      render(<Content panelId="panel-args" initialArgs={initialArgs} worktreeId="wt-7" />);

      await waitFor(() => expect(screen.queryByTestId("plugin-view")).toBeTruthy());
      const props = capturedProps[capturedProps.length - 1]!;
      expect(props.panelId).toBe("panel-args");
      expect(props.pluginId).toBe("acme");
      // The bag is forwarded by reference, not reconstructed.
      expect(props.initialArgs).toBe(initialArgs);
      // #11297: the owning worktree reaches the view so it can reconstruct its
      // own context instead of dispatching worktree.getCurrent, which resolves
      // the *visible* worktree rather than the panel's.
      expect(props.worktreeId).toBe("wt-7");
      expect(props.disposeSignal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.doUnmock("react");
    }
  });

  it("subscribes to plugin:panel-kinds-changed on mount and unsubscribes on unmount", async () => {
    const cleanupSpy = vi.fn();
    onPanelKindsChangedMock.mockReturnValue(cleanupSpy);

    const { makePluginViewContent } = await import("../PluginViewContent");
    const Content = makePluginViewContent(makeContentConfig());

    const { unmount } = render(<Content panelId="panel-1" />);

    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalledTimes(1));
    unmount();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts only when a panel-kinds push drops its kind, not on every push", async () => {
    // The disposeSignal is the observable, not "didn't throw": an implementation
    // that aborted on *every* broadcast would tear down a healthy plugin view
    // whenever any unrelated plugin was installed, enabled, or removed — and a
    // no-throw assertion would happily pass while it did.
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation((cb) => {
      emit = cb;
      return () => {};
    });

    const signals: AbortSignal[] = [];
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: () =>
          function CapturingView(props: { disposeSignal: AbortSignal }) {
            if (!signals.includes(props.disposeSignal)) signals.push(props.disposeSignal);
            return <div data-testid="plugin-view" />;
          },
      };
    });

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-7" />);

      await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());
      await waitFor(() => expect(signals).not.toHaveLength(0));
      const signal = signals[0]!;

      const registered: PanelKindConfig[] = [
        {
          id: "acme.dashboard",
          name: "Dashboard",
          iconId: "gauge",
          color: "#abcdef",
          hasPty: false,
          canRestart: false,
          canConvert: false,
          extensionId: "acme",
        },
      ];

      // A push that still lists this kind must leave the live view untouched.
      act(() => emit!({ kinds: registered }));
      expect(signal.aborted).toBe(false);

      // Dropping the kind is what disposes it.
      act(() => emit!({ kinds: [] }));
      expect(signal.aborted).toBe(true);

      // A duplicate removal is idempotent — the broadcast can repeat, and
      // aborting an already-aborted controller must stay a no-op.
      expect(() => act(() => emit!({ kinds: [] }))).not.toThrow();
      expect(signal.aborted).toBe(true);
    } finally {
      vi.doUnmock("react");
    }
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
    // `plugin://` import rejects in jsdom with an unsupported-scheme error.
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

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-act" />);

      await waitFor(() => expect(capturedFactory).toBeDefined());
      // Activation rejects, so the awaited call short-circuits before `import()`.
      // Awaiting to settlement also lets the factory's `finally` clear the 10s
      // timeout rather than leaking an open timer into the next test.
      await expect(capturedFactory!()).rejects.toThrow("ACTIVATION_FAILED");
      expect(activateForView).toHaveBeenCalledWith("acme.dashboard");
    } finally {
      vi.doUnmock("react");
    }
  });

  it("surfaces the real activation cause when activateForView rejects, before import (#10618)", async () => {
    // The #10618 contract: on activation failure the activate-for-view IPC call
    // REJECTS with the real cause (the handler throws an AppError), carrying the
    // plugin's own message. The `await` rethrows it before `import()`, so the
    // ErrorBoundary surfaces why activation failed instead of a generic import
    // timeout. (Distinct from the #10523 gating test above, which only proves
    // the await ordering with a sentinel.)
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

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-act-fail" />);

      await waitFor(() => expect(capturedFactory).toBeDefined());
      // The factory rejects with the real activation error and never reaches the
      // `plugin://` import.
      await expect(capturedFactory!()).rejects.toThrow(/boom/);
      expect(activateForView).toHaveBeenCalledWith("acme.dashboard");
    } finally {
      vi.doUnmock("react");
    }
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

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-noact" />);

      await waitFor(() => expect(capturedFactory).toBeDefined());

      // The factory still rejects here — jsdom can't resolve a `plugin://` URL —
      // so "did it reject" proves nothing. What matters is the *cause*: with the
      // optional chaining intact the missing binding is skipped and the failure
      // comes from the import. Drop the `?.` and the factory instead dies on
      // "activateForView is not a function" before reaching `import()`.
      // Awaiting to settlement also lets the factory's `finally` clear the
      // import timeout instead of leaking a live timer into the next test.
      const cause: unknown = await capturedFactory!().then(
        () => null,
        (e: unknown) => e
      );
      expect(String(cause)).not.toMatch(/is not a function/);
      // The content still mounted its (stubbed) view rather than crashing.
      expect(screen.getByTestId("plugin-view")).toBeTruthy();
    } finally {
      vi.doUnmock("react");
    }
  });

  it("aborts the outgoing signal on retry and the post-retry signal on kind removal", async () => {
    // Regression guard for the renderer-first teardown contract (#9501/#10512).
    // Two failure modes, both invisible to a "doesn't throw" assertion: (1) a
    // retry that swaps controllers without aborting the outgoing one leaks the
    // discarded view's fetches and subscriptions; (2) an effect that captured
    // `controllerRef.current` at setup would abort the *prior* controller on a
    // kind-removed push, leaving the live signal armed forever. Capturing both
    // generations' signals and asserting each aborts at its own moment is the
    // only way to see either.
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation((cb) => {
      emit = cb;
      return () => {};
    });

    // Collect distinct controllers rather than counting renders: React may
    // render a given generation more than once, and only the identity of the
    // signal handed to the view is contractual.
    const signals: AbortSignal[] = [];
    // Count wrapper constructions: each `lazy()` caches its import result on its
    // own payload, so a retry that reuses the old wrapper replays the cached
    // *failed* result and never re-imports. Only a fresh construction proves the
    // reload actually happens (#9501).
    const lazyCalls = { count: 0 };
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: () => {
          lazyCalls.count += 1;
          return function CapturingView(props: { disposeSignal: AbortSignal }) {
            if (!signals.includes(props.disposeSignal)) signals.push(props.disposeSignal);
            return <div data-testid="plugin-view" />;
          };
        },
      };
    });

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-9" />);

      await waitFor(() => expect(signals).not.toHaveLength(0));
      const first = signals[0]!;
      expect(first.aborted).toBe(false);
      const callsBeforeReset = lazyCalls.count;
      const resetKeyBeforeReset = boundaryProps.last!.resetKeys?.[0];

      // Drive the very callback the boundary's "Try again" invokes. Going
      // through `onReset` rather than a thrown render keeps this deterministic:
      // a synchronously throwing view double is incompatible with React's
      // concurrent initial-mount recovery, which discards the uncommitted tree
      // and re-runs the `useState` initializer, so a call-count-keyed double
      // ends up mounting the generation it meant to skip. The wiring from the
      // boundary to this handler is asserted separately, where the boundary's
      // captured props are checked.
      const onReset = boundaryProps.last!.onReset;
      expect(onReset).toBeTypeOf("function");
      act(() => onReset!());

      // The retry mints a genuinely fresh controller for the replacement view.
      await waitFor(() => expect(signals.length).toBeGreaterThan(1));
      const second = signals[1]!;
      expect(second).not.toBe(first);
      // The discarded view's signal aborted at swap time, not at unmount.
      expect(first.aborted).toBe(true);
      expect(second.aborted).toBe(false);
      // ...and the module is genuinely re-imported rather than the controller
      // merely being swapped: a fresh `lazy()` ref, and a bumped reset key so
      // the boundary clears its error state.
      expect(lazyCalls.count).toBeGreaterThan(callsBeforeReset);
      expect(boundaryProps.last!.resetKeys?.[0]).not.toBe(resetKeyBeforeReset);

      // Kind removal must abort the CURRENT controller, resolved through the ref
      // at call time rather than the one captured when the effect was set up.
      act(() => emit!({ kinds: [] }));
      expect(second.aborted).toBe(true);
    } finally {
      vi.doUnmock("react");
    }
  });

  it("aborts the dispose signal when the content unmounts", async () => {
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
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      const { unmount } = render(<Content panelId="panel-unmount" />);
      await waitFor(() => expect(signals).not.toHaveLength(0));
      const signal = signals[signals.length - 1]!;
      expect(signal.aborted).toBe(false);

      unmount();
      expect(signal.aborted).toBe(true);
    } finally {
      vi.doUnmock("react");
    }
  });

  it("gives the view a panel-scoped removal signal that a temporary unmount does not abort (#11301)", async () => {
    interface LifecycleProps {
      disposeSignal: AbortSignal;
      panelRemovedSignal: AbortSignal;
    }
    const captured: LifecycleProps[] = [];
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: () =>
          function CapturingView(props: LifecycleProps) {
            captured.push(props);
            return <div data-testid="plugin-view" />;
          },
      };
    });

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      const { unmount } = render(<Content panelId="panel-removal-signal" />);
      await waitFor(() => expect(captured).not.toHaveLength(0));
      const { disposeSignal, panelRemovedSignal } = captured[captured.length - 1]!;

      expect(panelRemovedSignal).toBeInstanceOf(AbortSignal);
      expect(panelRemovedSignal).not.toBe(disposeSignal);

      // The whole point of the split: maximizing a sibling pane unmounts this
      // subtree, which must not read as "the panel was deleted". A plugin that
      // ties a running process to `panelRemovedSignal` keeps it alive here.
      unmount();
      expect(disposeSignal.aborted).toBe(true);
      expect(panelRemovedSignal.aborted).toBe(false);
    } finally {
      vi.doUnmock("react");
    }
  });

  it("keeps the removal signal identical across a retry while the dispose signal is replaced", async () => {
    interface LifecycleProps {
      disposeSignal: AbortSignal;
      panelRemovedSignal: AbortSignal;
    }
    const captured: LifecycleProps[] = [];
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: () =>
          function CapturingView(props: LifecycleProps) {
            captured.push(props);
            return <div data-testid="plugin-view" />;
          },
      };
    });

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-removal-retry" />);
      await waitFor(() => expect(captured).not.toHaveLength(0));
      const first = captured[0]!;

      act(() => boundaryProps.last!.onReset!());
      await waitFor(() =>
        expect(captured.some((p) => p.disposeSignal !== first.disposeSignal)).toBe(true)
      );
      const second = captured.find((p) => p.disposeSignal !== first.disposeSignal)!;

      expect(second.disposeSignal).not.toBe(first.disposeSignal);
      // Identity across attempts is the contract — a plugin holding this signal
      // from its first mount must still see the same object after a retry.
      expect(second.panelRemovedSignal).toBe(first.panelRemovedSignal);
      expect(second.panelRemovedSignal.aborted).toBe(false);
    } finally {
      vi.doUnmock("react");
    }
  });

  it("hands the boundary a plugin-specific fallback and an undoubled component name (#11207)", async () => {
    const { makePluginViewContent } = await import("../PluginViewContent");
    const Content = makePluginViewContent(makeContentConfig());

    render(<Content panelId="panel-fallback" />);

    await waitFor(() => expect(boundaryProps.last).not.toBeNull());
    // `kindId` already carries the plugin prefix, so re-prefixing it produced
    // `PluginView:acme.acme.dashboard` in the title and every log field.
    expect(boundaryProps.last!.componentName).toBe("PluginView:acme.dashboard");
  });

  // Closes the seam the fake boundary would otherwise hide: asserting that
  // `fallback` is merely a function is satisfied by `() => null`. Rendering the
  // very component the content handed the boundary proves the wiring reaches the
  // real diagnostics pane, carries this plugin's identity, and fails closed
  // when the runtime store holds no metadata for it.
  it("hands the boundary a fallback that renders this plugin's diagnostics (#11207)", async () => {
    const { makePluginViewContent } = await import("../PluginViewContent");
    const Content = makePluginViewContent(makeContentConfig());

    render(<Content panelId="panel-fallback-render" />);
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

  // The metadata the pane needs may not exist at mount time: `loadPlugin`
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

    const { makePluginViewContent } = await import("../PluginViewContent");
    const Content = makePluginViewContent(makeContentConfig());

    render(<Content panelId="panel-refresh" />);
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
    const { makePluginViewContent } = await import("../PluginViewContent");
    // Resolved from the same module graph as the content — the suite resets
    // modules between cases, so a static import would seed a different store.
    const { usePluginRuntimeStore } = await import("@/store/pluginRuntimeStore");
    const Content = makePluginViewContent(makeContentConfig());

    render(<Content panelId="panel-late-snapshot" />);
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
