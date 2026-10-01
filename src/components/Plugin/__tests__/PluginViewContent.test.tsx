// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import type { PluginViewContentConfig } from "../PluginViewContent";
import { settlePluginViewLoad } from "./settlePluginViewLoad";

// Stub presentational deps — the content's behavioral contract is the view
// import + AbortController wiring, not the skeleton or fade-in.
vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
  SkeletonHint: () => null,
}));
// The kit chunk and the Tailwind runtime are real host code with their own
// suites; loading them per test would only slow the load path down here.
vi.mock("@/pluginUi", () => ({ whenPluginUiReady: () => Promise.resolve() }));
vi.mock("@/services/plugin/pluginStyleContract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/plugin/pluginStyleContract")>()),
  preparePluginStyles: () => Promise.resolve(),
  registerPluginStyleRoot: () => () => {},
}));
// A settled load renders its view at once; the gate is loadPath's subject.
// See settlePluginViewLoad for why it is off here.
vi.mock("@/hooks/useDeferredLoading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDeferredLoading")>()),
  useSkeletonGate: () => false,
  useSkeletonFloor: (isShowing: boolean) => isShowing,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// Its lazy banner is not what these tests are about. Runtime-status behavior
// has a dedicated suite.
vi.mock("@/components/Plugin/PluginViewRuntimeStatus", () => ({
  PluginViewRuntimeStatus: () => null,
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
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  resetKeys?: Array<string | number>;
  componentName?: string;
  fallback?: React.ComponentType<CapturedFallbackProps>;
}

// The fake records the props it was handed, so the tests can render the very
// fallback the content supplied. Asserting only that `fallback` is *a function*
// would be satisfied by `() => null`.
const boundaryProps = vi.hoisted(() => ({
  last: null as CapturedBoundaryProps | null,
  caught: [] as unknown[],
}));

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
    // Forwards to `onError` like the real boundary does — the content classifies
    // the error there to decide whether "Try again" needs a fresh module
    // specifier, so a stub that swallowed it would hide that branch (#11728).
    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
      boundaryProps.caught.push(error);
      this.props.onError?.(error, errorInfo);
    }
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
        // error state incidentally — `#11207` lets the real load attempt a
        // `plugin://` import no test mocked — and rendering the
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

/**
 * The view module every test's content imports. Tests stand a view in for it
 * with `vi.doMock`, which is how the load path's real `import()` resolves to a
 * test double; an unmocked `plugin://` specifier fails to load, as it would for
 * a missing bundle.
 */
const VIEW_MODULE = "plugin://acme/dashboard.js";

function makeContentConfig(
  overrides: Partial<PluginViewContentConfig> = {}
): PluginViewContentConfig {
  return {
    id: "acme.dashboard",
    name: "Dashboard",
    componentPath: VIEW_MODULE,
    extensionId: "acme",
    ...overrides,
  };
}

const onPanelKindsChangedMock = vi.fn();

beforeEach(() => {
  boundaryProps.last = null;
  boundaryProps.caught = [];
  onPanelKindsChangedMock.mockReset();
  onPanelKindsChangedMock.mockReturnValue(() => {});
  vi.stubGlobal("electron", undefined);
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: { onPanelKindsChanged: onPanelKindsChangedMock } },
  });
});

afterEach(async () => {
  cleanup();
  // A late dependency import can refill the module cache with the previous
  // test's view module after resetModules, leaking it into the next test.
  await vi.dynamicImportSettled();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("makePluginViewContent", () => {
  it("renders the plugin view with no panel chrome around it (#11240)", async () => {
    // The decoupling contract itself: whatever presentation a host chooses, the
    // content layer contributes none of it. A dialog host (#11239) mounting this
    // must not inherit a grid pane's root, chrome, or close control.
    vi.doMock(VIEW_MODULE, () => ({
      default: function StubView() {
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      const { container } = render(<Content panelId="panel-1" />);

      await settlePluginViewLoad(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
      expect(container.querySelector("[data-panel-id]")).toBeNull();
      expect(container.querySelector("[data-pane-chrome]")).toBeNull();
      expect(screen.queryByTestId("panel-close")).toBeNull();
    } finally {
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("hands the plugin view its panel id, plugin id, dispose signal, and initial args", async () => {
    const capturedProps: Array<Record<string, unknown>> = [];
    vi.doMock(VIEW_MODULE, () => ({
      default: function CapturingView(props: Record<string, unknown>) {
        capturedProps.push(props);
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      const initialArgs = { path: "/repo/src/index.ts", line: 12 };
      render(<Content panelId="panel-args" initialArgs={initialArgs} worktreeId="wt-7" />);

      await settlePluginViewLoad(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
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
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("freezes initialArgs for the life of a mount even as the prop changes", async () => {
    const capturedProps: Array<Record<string, unknown>> = [];
    vi.doMock(VIEW_MODULE, () => ({
      default: function CapturingView(props: Record<string, unknown>) {
        capturedProps.push(props);
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      const spawned = { root: "src" };
      const { rerender } = render(<Content panelId="panel-frozen" initialArgs={spawned} />);
      await settlePluginViewLoad(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());

      // `extensionState` reaches this component straight off the panel record,
      // so once a view can WRITE that record through `persistState` the prop
      // changes underneath it on every save. Re-rendering with a new bag stands
      // in for exactly that.
      const persisted = { root: "src", selected: "src/index.ts" };
      rerender(<Content panelId="panel-frozen" initialArgs={persisted} />);

      // Same mount, so the view keeps the snapshot it was given. Forwarding the
      // new bag would turn a documented "what you were opened with" value into
      // a live channel, and hand any view that persists state derived from
      // `initialArgs` a render loop.
      const latest = capturedProps[capturedProps.length - 1]!;
      expect(latest.initialArgs).toBe(spawned);
      expect(capturedProps.every((props) => props.initialArgs === spawned)).toBe(true);
    } finally {
      vi.doUnmock(VIEW_MODULE);
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
    vi.doMock(VIEW_MODULE, () => ({
      default: function CapturingView(props: { disposeSignal: AbortSignal }) {
        if (!signals.includes(props.disposeSignal)) signals.push(props.disposeSignal);
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-7" />);

      await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());
      await settlePluginViewLoad(() => expect(signals).not.toHaveLength(0));
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
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("awaits plugin.activateForView with the kind id before importing the view module (#10523)", async () => {
    // Reject activation with a sentinel so we can prove the import is *gated*
    // on activation, not merely fired alongside it: if the `await` were dropped
    // the view module would be imported, and the boundary would see whatever
    // that produced instead of this sentinel.
    const activateForView = vi.fn().mockRejectedValue(new Error("ACTIVATION_FAILED"));
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { onPanelKindsChanged: onPanelKindsChangedMock, activateForView } },
    });
    const importViewModule = vi.fn(() => ({
      default: function StubView() {
        return <div data-testid="plugin-view" />;
      },
    }));
    vi.doMock(VIEW_MODULE, importViewModule);

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-act" />);

      // Activation rejects, so the load short-circuits before `import()` and
      // the boundary receives the activation's own error.
      await settlePluginViewLoad(() => expect(boundaryProps.caught).toHaveLength(1));
      expect(String(boundaryProps.caught[0])).toMatch("ACTIVATION_FAILED");
      expect(activateForView).toHaveBeenCalledWith("acme.dashboard");
      expect(importViewModule).not.toHaveBeenCalled();
      expect(screen.queryByTestId("plugin-view")).toBeNull();
    } finally {
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("surfaces the real activation cause when activateForView rejects, before import (#10618)", async () => {
    // The #10618 contract: on activation failure the activate-for-view IPC call
    // REJECTS with the real cause (the handler throws an AppError), carrying the
    // plugin's own message. The `await` rethrows it before `import()`, so the
    // ErrorBoundary surfaces why activation failed instead of a generic import
    // timeout. (Distinct from the #10523 gating test above, which only proves
    // the await ordering with a sentinel.)
    const activationError = new Error('Plugin failed to activate for view "acme.dashboard": boom');
    const activateForView = vi.fn().mockRejectedValue(activationError);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { onPanelKindsChanged: onPanelKindsChangedMock, activateForView } },
    });

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-act-fail" />);

      // The very error main rejected with reaches the boundary — not a wrapper,
      // and not the `plugin://` import failure the unmocked module would give.
      await settlePluginViewLoad(() => expect(boundaryProps.caught).toEqual([activationError]));
      expect(activateForView).toHaveBeenCalledWith("acme.dashboard");
    } finally {
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("tolerates a missing activateForView binding without throwing (#10523)", async () => {
    // beforeEach installs window.electron.plugin without activateForView, so the
    // optional-chained call must no-op and the import must still proceed. Drop
    // the `?.` and the load instead dies on "activateForView is not a function"
    // before reaching `import()`.
    vi.doMock(VIEW_MODULE, () => ({
      default: function StubView() {
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-noact" />);

      await settlePluginViewLoad(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
      expect(boundaryProps.caught).toEqual([]);
    } finally {
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("retries an import failure on a main-minted specifier, and a render failure in place (#11728)", async () => {
    // The bug: a rejected dynamic import is permanent for its specifier — the
    // module map never evicts a failed entry — so the old "Try again", which
    // re-imported the SAME url, could never recover. Recovery has to come from
    // main as a new view generation. But it must be requested only for import
    // failures: a view that threw while rendering, or an activation that
    // failed, would fail identically on a new specifier, and minting one per
    // retry would grow the module map without bound.
    //
    // The original specifier is left unmocked, so it genuinely fails to load,
    // and the replacement is a mocked module on a different specifier. A view
    // on screen after the retry proves the load imported the path main
    // returned rather than the original.
    const recoveryPath = "plugin://acme/__dtv-2/dashboard.js";
    vi.doMock(recoveryPath, () => ({
      default: function RecoveredView() {
        return <div data-testid="plugin-view" />;
      },
    }));
    const activateForView = vi.fn((_kindId: string, recover?: boolean) =>
      Promise.resolve(recover === true ? recoveryPath : undefined)
    );
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { onPanelKindsChanged: onPanelKindsChangedMock, activateForView } },
    });

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-recover" />);

      // First attempt: plain activation (no recovery flag), then an import that
      // cannot resolve — exactly the shape of the bug.
      await settlePluginViewLoad(() => expect(boundaryProps.caught).toHaveLength(1));
      expect(boundaryProps.caught[0]).toBeInstanceOf(Error);
      expect(activateForView.mock.calls).toEqual([["acme.dashboard"]]);

      // Click through the boundary's "Try again".
      act(() => boundaryProps.last!.onReset!());

      // The retry asks main for a replacement specifier...
      await settlePluginViewLoad(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
      expect(activateForView.mock.calls.at(-1)).toEqual(["acme.dashboard", true]);

      // Now the other half of the classification. A view that throws during
      // render is not a poisoned specifier, so its retry must stay on the path
      // it has rather than burning a second namespace.
      const callsBeforeRenderRetry = activateForView.mock.calls.length;
      act(() => boundaryProps.last!.onError!(new Error("view exploded"), { componentStack: "" }));
      act(() => boundaryProps.last!.onReset!());
      await settlePluginViewLoad(() =>
        expect(activateForView.mock.calls.length).toBeGreaterThan(callsBeforeRenderRetry)
      );
      expect(activateForView.mock.calls.at(-1)).toEqual(["acme.dashboard"]);
      await settlePluginViewLoad(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
    } finally {
      vi.doUnmock(recoveryPath);
    }
  });

  it("classifies a module that rejects with a non-object value as import-stage (#11728)", async () => {
    // A plugin module is free to `throw "boom"` at evaluation, and `import()`
    // rejects with that exact primitive — which cannot key the WeakSet the
    // classification uses. That failure still poisons the specifier, so it must
    // still earn a fresh generation; the primitive is wrapped in a real Error
    // (preserving the original as `cause`) rather than silently misclassified.
    const recoveryPath = "data:text/javascript,export default () => null";
    const activateForView = vi.fn((_kindId: string, recover?: boolean) =>
      Promise.resolve(recover === true ? recoveryPath : undefined)
    );
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { onPanelKindsChanged: onPanelKindsChangedMock, activateForView } },
    });

    const { makePluginViewContent } = await import("../PluginViewContent");
    // A real module that throws a bare string on evaluation.
    const Content = makePluginViewContent(
      makeContentConfig({ componentPath: 'data:text/javascript,throw "boom"' })
    );

    render(<Content panelId="panel-primitive" />);

    await settlePluginViewLoad(() => expect(boundaryProps.caught).toHaveLength(1));
    const thrown = boundaryProps.caught[0];
    // Wrapped, not passed through raw — a bare string would also render badly
    // in the diagnostics fallback.
    if (!(thrown instanceof Error)) throw new Error("the load did not fail with an Error");
    expect(thrown.cause).toBe("boom");

    act(() => boundaryProps.last!.onReset!());

    // The classification survived the wrap, so recovery is requested, and the
    // replacement module loads without another failure.
    await settlePluginViewLoad(() =>
      expect(activateForView.mock.calls.at(-1)).toEqual(["acme.dashboard", true])
    );
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(boundaryProps.caught).toHaveLength(1);
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
    // Count loads: each attempt's load is sticky for that attempt, so a retry
    // that reused the old one would replay its cached *failed* result and never
    // re-import. Only a fresh load — which activates again — proves the reload
    // actually happens (#9501).
    const activateForView = vi.fn(() => Promise.resolve(undefined));
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: { onPanelKindsChanged: onPanelKindsChangedMock, activateForView } },
    });
    vi.doMock(VIEW_MODULE, () => ({
      default: function CapturingView(props: { disposeSignal: AbortSignal }) {
        if (!signals.includes(props.disposeSignal)) signals.push(props.disposeSignal);
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-9" />);

      await settlePluginViewLoad(() => expect(signals).not.toHaveLength(0));
      const first = signals[0]!;
      expect(first.aborted).toBe(false);
      const callsBeforeReset = activateForView.mock.calls.length;

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
      await settlePluginViewLoad(() => expect(signals.length).toBeGreaterThan(1));
      const second = signals[1]!;
      expect(second).not.toBe(first);
      // The discarded view's signal aborted at swap time, not at unmount.
      expect(first.aborted).toBe(true);
      expect(second.aborted).toBe(false);
      // ...and the view is genuinely reloaded rather than the controller
      // merely being swapped: a fresh attempt with its own load. The boundary
      // clears its error state by being remounted on a new `key` (#12278)
      // rather than through `resetKeys`, which it no longer takes — a fresh
      // attempt alone does not remount a view whose component is unchanged.
      expect(activateForView.mock.calls.length).toBeGreaterThan(callsBeforeReset);

      // Kind removal must abort the CURRENT controller, resolved through the ref
      // at call time rather than the one captured when the effect was set up.
      act(() => emit!({ kinds: [] }));
      expect(second.aborted).toBe(true);
    } finally {
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("aborts the outgoing signal the moment the view throws, not when retry is clicked", async () => {
    // #12278: `handleRenderError` reported the failure but left the controller
    // armed, so between the throw and the user clicking Try again or Close,
    // anything the plugin tied to `disposeSignal` kept running — fetches,
    // subscriptions, timers. `handleReset` already aborted correctly on retry,
    // which is exactly what made the gap easy to miss: the leak is only visible
    // in the window BEFORE any recovery action, so asserting on the state right
    // after `onError` is the only way to see it.
    const signals: AbortSignal[] = [];
    vi.doMock(VIEW_MODULE, () => ({
      default: function CapturingView(props: { disposeSignal: AbortSignal }) {
        if (!signals.includes(props.disposeSignal)) signals.push(props.disposeSignal);
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-abort-on-error" />);

      await settlePluginViewLoad(() => expect(signals).not.toHaveLength(0));
      const signal = signals[0]!;
      expect(signal.aborted).toBe(false);

      // The boundary's own `onError`, driven directly for the same reason the
      // retry test drives `onReset`: a synchronously throwing view double fights
      // React's concurrent initial-mount recovery.
      const onError = boundaryProps.last!.onError;
      expect(onError).toBeTypeOf("function");
      act(() => onError!(new Error("view blew up"), { componentStack: "" }));

      // No retry, no close, no unmount — just the throw.
      expect(signal.aborted).toBe(true);
    } finally {
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("aborts the dispose signal when the content unmounts", async () => {
    const signals: AbortSignal[] = [];
    vi.doMock(VIEW_MODULE, () => ({
      default: function CapturingView(props: { disposeSignal: AbortSignal }) {
        signals.push(props.disposeSignal);
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      const { unmount } = render(<Content panelId="panel-unmount" />);
      await settlePluginViewLoad(() => expect(signals).not.toHaveLength(0));
      const signal = signals[signals.length - 1]!;
      expect(signal.aborted).toBe(false);

      unmount();
      // One microtask late on purpose: a StrictMode replay re-runs setup right
      // after the cleanup and has to be able to call the abort off (#12609).
      await Promise.resolve();
      expect(signal.aborted).toBe(true);
    } finally {
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("gives the view a panel-scoped removal signal that a temporary unmount does not abort (#11301)", async () => {
    interface LifecycleProps {
      disposeSignal: AbortSignal;
      panelRemovedSignal: AbortSignal;
    }
    const captured: LifecycleProps[] = [];
    vi.doMock(VIEW_MODULE, () => ({
      default: function CapturingView(props: LifecycleProps) {
        captured.push(props);
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      const { unmount } = render(<Content panelId="panel-removal-signal" />);
      await settlePluginViewLoad(() => expect(captured).not.toHaveLength(0));
      const { disposeSignal, panelRemovedSignal } = captured[captured.length - 1]!;

      expect(panelRemovedSignal).toBeInstanceOf(AbortSignal);
      expect(panelRemovedSignal).not.toBe(disposeSignal);

      // The whole point of the split: maximizing a sibling pane unmounts this
      // subtree, which must not read as "the panel was deleted". A plugin that
      // ties a running process to `panelRemovedSignal` keeps it alive here.
      unmount();
      await Promise.resolve();
      expect(disposeSignal.aborted).toBe(true);
      expect(panelRemovedSignal.aborted).toBe(false);
    } finally {
      vi.doUnmock(VIEW_MODULE);
    }
  });

  it("keeps the removal signal identical across a retry while the dispose signal is replaced", async () => {
    interface LifecycleProps {
      disposeSignal: AbortSignal;
      panelRemovedSignal: AbortSignal;
    }
    const captured: LifecycleProps[] = [];
    vi.doMock(VIEW_MODULE, () => ({
      default: function CapturingView(props: LifecycleProps) {
        captured.push(props);
        return <div data-testid="plugin-view" />;
      },
    }));

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());

      render(<Content panelId="panel-removal-retry" />);
      await settlePluginViewLoad(() => expect(captured).not.toHaveLength(0));
      const first = captured[0]!;

      act(() => boundaryProps.last!.onReset!());
      await settlePluginViewLoad(() =>
        expect(captured.some((p) => p.disposeSignal !== first.disposeSignal)).toBe(true)
      );
      const second = captured.find((p) => p.disposeSignal !== first.disposeSignal)!;

      expect(second.disposeSignal).not.toBe(first.disposeSignal);
      // Identity across attempts is the contract — a plugin holding this signal
      // from its first mount must still see the same object after a retry.
      expect(second.panelRemovedSignal).toBe(first.panelRemovedSignal);
      expect(second.panelRemovedSignal.aborted).toBe(false);
    } finally {
      vi.doUnmock(VIEW_MODULE);
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
