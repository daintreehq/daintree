// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { lazy, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelViewProps } from "@shared/types/plugin";
import { makePluginViewContent, type PluginViewContentConfig } from "../PluginViewContent";
import {
  __resetBuiltinRendererRegistryForTests,
  registerBuiltinView,
} from "@/registry/builtinRendererRegistry";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

/**
 * In-process resolution of built-in plugin panel views (#11244). Uses the real
 * `lazy` and the real registry — no React double — so a view that renders here
 * genuinely did not come from a `plugin://` import, which jsdom cannot load.
 */

const stylePrep = vi.hoisted(() => ({ calls: [] as string[] }));
const documentViews = vi.hoisted(() => ({ calls: [] as string[] }));

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
// The real boundary's reporting pipeline (Sentry, errorStore, notify) is out of
// scope; this double keeps the contract the content relies on — forward to
// `onError`, render the supplied fallback, and call `onReset` on retry.
interface FallbackProps {
  error: Error;
  resetError: () => void;
}
interface BoundaryProps {
  children: React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  onReset?: () => void;
  fallback?: React.ComponentType<FallbackProps>;
}
vi.mock("@/components/ErrorBoundary", async () => {
  const { Component } = await import("react");
  class FakeBoundary extends Component<BoundaryProps, { error: Error | null }> {
    state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error): { error: Error } {
      return { error };
    }
    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
      this.props.onError?.(error, errorInfo);
    }
    render(): React.ReactNode {
      const { error } = this.state;
      if (!error) return this.props.children;
      const Fallback = this.props.fallback;
      if (!Fallback) return null;
      return (
        <Fallback
          error={error}
          resetError={(): void => {
            this.setState({ error: null });
            this.props.onReset?.();
          }}
        />
      );
    }
  }
  return { ErrorBoundary: FakeBoundary };
});
vi.mock("@/services/plugin/pluginStyleContract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/plugin/pluginStyleContract")>();
  return {
    ...actual,
    preparePluginStyles: (path: string) => {
      stylePrep.calls.push(path);
      return Promise.resolve();
    },
  };
});
vi.mock("@/services/plugin/pluginDocumentRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/plugin/pluginDocumentRuntime")>();
  const runtime = actual.createPluginDocumentRuntime();
  runtime.registerView = (_pluginId: string, path: string) => {
    documentViews.calls.push(path);
  };
  return { ...actual, pluginDocumentRuntime: runtime };
});

const BUILTIN_ID = "daintree.sveltekit-builder";
const BUILTIN_KIND = `${BUILTIN_ID}.inspector`;

function builtinConfig(): PluginViewContentConfig {
  return {
    id: BUILTIN_KIND,
    name: "Site Inspector",
    componentPath: `plugin://${BUILTIN_ID}/__dtv-1/renderer/index.js`,
    extensionId: BUILTIN_ID,
  };
}

// Typed so `mock.calls` destructures without a cast (lint ratchet).
let activateForView: ReturnType<
  typeof vi.fn<(kindId: string, requestRecoveryPath?: boolean) => Promise<string | undefined>>
>;

beforeEach(() => {
  stylePrep.calls.length = 0;
  documentViews.calls.length = 0;
  activateForView = vi.fn<(kindId: string, requestRecoveryPath?: boolean) => Promise<undefined>>(
    () => Promise.resolve(undefined)
  );
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: { onPanelKindsChanged: vi.fn(() => () => {}), activateForView } },
  });
});

afterEach(() => {
  cleanup();
  __resetBuiltinRendererRegistryForTests();
  usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
});

describe("built-in panel views", () => {
  it("renders the registered slot with the full PanelViewProps and imports nothing", async () => {
    const seen: PanelViewProps[] = [];
    function Inspector(props: PanelViewProps) {
      seen.push(props);
      return <div data-testid="builtin-view" />;
    }
    registerBuiltinView(BUILTIN_KIND, Inspector, { pluginId: BUILTIN_ID, label: "Site Inspector" });

    const Content = makePluginViewContent(builtinConfig());
    const persistState = vi.fn(() => true);
    const panelRemovedSignal = new AbortController().signal;
    const initialArgs = { previewId: "p-1" };
    render(
      <Content
        panelId="panel-b"
        initialArgs={initialArgs}
        stateVersion={1}
        persistState={persistState}
        worktreeId="wt-1"
        panelRemovedSignal={panelRemovedSignal}
      />
    );

    await screen.findByTestId("builtin-view");
    const props = seen[seen.length - 1]!;
    expect(props.panelId).toBe("panel-b");
    expect(props.pluginId).toBe(BUILTIN_ID);
    expect(props.initialArgs).toBe(initialArgs);
    expect(props.stateVersion).toBe(1);
    expect(props.persistState).toBe(persistState);
    expect(props.worktreeId).toBe("wt-1");
    expect(props.panelRemovedSignal).toBe(panelRemovedSignal);
    expect(props.disposeSignal).toBeInstanceOf(AbortSignal);
    expect(props.disposeSignal.aborted).toBe(false);
    expect(props.styleRootAttributes).toBeTruthy();

    // Activation still runs, so the plugin's handlers are live at first render;
    // the plugin:// loader's own steps never do.
    expect(activateForView).toHaveBeenCalledWith(BUILTIN_KIND);
    expect(stylePrep.calls).toEqual([]);
    expect(documentViews.calls).toEqual([]);
  });

  // The Site Builder registers `lazy(() => import("./SiteInspectorView"))` to keep
  // its view out of the host bundle. Handing that straight back from the host's
  // own `lazy()` is a lazy resolving to a lazy, which React refuses (#306) — the
  // panel mounted and showed only the diagnostics fallback.
  it("renders a slot that was itself registered as a lazy component", async () => {
    function Inspector({ panelId }: PanelViewProps) {
      return <div data-testid="builtin-view">{panelId}</div>;
    }
    const LazyInspector = lazy(async () => ({ default: Inspector }));
    registerBuiltinView(BUILTIN_KIND, LazyInspector, {
      pluginId: BUILTIN_ID,
      label: "Site Inspector",
    });

    const Content = makePluginViewContent(builtinConfig());
    render(<Content panelId="panel-lazy" worktreeId="wt-1" />);

    expect((await screen.findByTestId("builtin-view")).textContent).toBe("panel-lazy");
    expect(screen.queryByText(/Something went wrong|Try again/)).toBeNull();
  });

  it("takes the plugin:// path when no slot is registered under the kind id", async () => {
    // A slot with the same id but a different owner must not hijack the kind.
    function Impostor() {
      return <div data-testid="builtin-view" />;
    }
    registerBuiltinView("acme.dashboard", Impostor, { pluginId: "daintree.github" });

    const Content = makePluginViewContent({
      id: "acme.dashboard",
      name: "Dashboard",
      componentPath: "plugin://acme/__dtv-1/dashboard.js",
      extensionId: "acme",
    });
    render(<Content panelId="panel-p" />);

    await waitFor(() =>
      expect(documentViews.calls).toEqual(["plugin://acme/__dtv-1/dashboard.js"])
    );
    expect(stylePrep.calls).toEqual(["plugin://acme/__dtv-1/dashboard.js"]);
    expect(activateForView).toHaveBeenCalledWith("acme.dashboard");
    expect(screen.queryByTestId("builtin-view")).toBeNull();
  });

  it("switches to a slot registered after the panel mounted", async () => {
    // Activation for the first (plugin://) attempt never settles, so nothing is
    // imported before the slot arrives.
    activateForView.mockImplementationOnce(() => new Promise<undefined>(() => {}));
    const Content = makePluginViewContent(builtinConfig());
    render(<Content panelId="panel-late" />);

    await waitFor(() => expect(activateForView).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("builtin-view")).toBeNull();

    function Inspector() {
      return <div data-testid="builtin-view" />;
    }
    act(() => {
      registerBuiltinView(BUILTIN_KIND, Inspector, { pluginId: BUILTIN_ID });
    });

    await screen.findByTestId("builtin-view");
    expect(documentViews.calls).toEqual([]);
  });

  it("renders no view, and activates nothing, while the owning plugin is disabled", async () => {
    function Inspector() {
      return <div data-testid="builtin-view" />;
    }
    registerBuiltinView(BUILTIN_KIND, Inspector, { pluginId: BUILTIN_ID });
    usePluginRuntimeStore.setState({ disabledPluginIds: new Set([BUILTIN_ID]) });

    const Content = makePluginViewContent(builtinConfig());
    render(<Content panelId="panel-off" />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("builtin-view")).toBeNull();
    expect(screen.queryByTestId("skeleton")).toBeNull();
    expect(activateForView).not.toHaveBeenCalled();
    expect(documentViews.calls).toEqual([]);

    act(() => {
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
    });
    await screen.findByTestId("builtin-view");
    // The attempt held while disabled was built for no slot; it must not render
    // for the one commit before the rebind replaces it.
    expect(documentViews.calls).toEqual([]);
    expect(stylePrep.calls).toEqual([]);
    expect(activateForView.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it("contains a throwing builtin view in the diagnostics fallback and retries without a recovery path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const signals: AbortSignal[] = [];
    let shouldThrow = true;
    function Inspector({ disposeSignal }: PanelViewProps) {
      signals.push(disposeSignal);
      // Thrown post-commit: a render-time throw trips React's concurrent
      // recovery replay, which makes the boundary's path nondeterministic.
      useEffect(() => {
        if (shouldThrow) throw new Error("inspector exploded");
      }, []);
      return <div data-testid="builtin-view" />;
    }
    registerBuiltinView(BUILTIN_KIND, Inspector, { pluginId: BUILTIN_ID });

    const Content = makePluginViewContent(builtinConfig());
    render(<Content panelId="panel-crash" />);

    await screen.findByTestId("plugin-view-diagnostics");
    expect(signals[signals.length - 1]!.aborted).toBe(true);

    shouldThrow = false;
    fireEvent.click(screen.getByTestId("plugin-view-diagnostics-retry"));

    await screen.findByTestId("builtin-view");
    expect(signals[signals.length - 1]!.aborted).toBe(false);
    // A builtin has no poisoned specifier to replace, so recovery is a plain
    // activation request every time.
    expect(activateForView.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(activateForView.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
