// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { lazy, useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelViewProps } from "@shared/types/plugin";
import {
  makePluginViewContent,
  pluginViewHostContext,
  type PluginViewContentConfig,
} from "../PluginViewContent";
import {
  __resetBuiltinRendererRegistryForTests,
  registerBuiltinView,
} from "@/registry/builtinRendererRegistry";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { PluginKitOwnerContext } from "@/components/PluginKit/kitScope";
import { PluginStyleScope } from "@/components/PluginKit/kitProps";

/**
 * In-process resolution of built-in plugin panel views (#11244). Uses the real
 * load path and the real registry — no React double — so a view that renders here
 * genuinely did not come from a `plugin://` import, which jsdom cannot load.
 */

const stylePrep = vi.hoisted(() => ({ calls: [] as string[] }));
const documentViews = vi.hoisted(() => ({ calls: [] as string[] }));
const dispatch = vi.hoisted(() =>
  vi.fn<(id: string, args: unknown, options: unknown) => Promise<void>>(() => Promise.resolve())
);

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
  SkeletonHint: () => null,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// Observable rather than null: the host suppresses this layer for a disabled
// builtin, and "rendered nothing" and "never mounted" are different claims.
vi.mock("@/components/Plugin/PluginViewRuntimeStatus", () => ({
  PluginViewRuntimeStatus: () => <div data-testid="runtime-status" />,
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
// The kit chunk takes seconds to transform under jsdom; readiness is the kit's
// own suite's to prove.
vi.mock("@/pluginUi", () => ({ whenPluginUiReady: () => Promise.resolve() }));
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
  dispatch.mockClear();
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
    // A panel host names none, so the view hears it is in a panel.
    expect(props.hostContext).toEqual({ kind: "panel" });

    // Activation still runs, so the plugin's handlers are live at first render;
    // the plugin:// loader's own steps never do.
    expect(activateForView).toHaveBeenCalledWith(BUILTIN_KIND);
    expect(stylePrep.calls).toEqual([]);
    expect(documentViews.calls).toEqual([]);
  });

  // A built-in's file editor view (#17336) is a hosted view, keyed by its
  // hosted-view kind id rather than a panel kind, and has no bundle either.
  it("renders a built-in file editor view by its hosted-view id, handing it the document", async () => {
    const seen: PanelViewProps[] = [];
    function Table(props: PanelViewProps) {
      seen.push(props);
      return <div data-testid="builtin-view" />;
    }
    const kindId = `plugin-view:${BUILTIN_ID}/table`;
    registerBuiltinView(kindId, Table, { pluginId: BUILTIN_ID, label: "Table" });

    const Content = makePluginViewContent({
      id: kindId,
      name: "Table fileEditor",
      componentPath: `plugin://${BUILTIN_ID}/__dtv-1/renderer/index.js`,
      extensionId: BUILTIN_ID,
      standalone: true,
    });
    const fileDocument = {
      fileName: "users.csv",
      getDraft: () => "a,b",
    } as unknown as NonNullable<PanelViewProps["fileDocument"]>;
    render(
      <Content
        panelId="file-editor:panel-1"
        fileDocument={fileDocument}
        hostContext={pluginViewHostContext("fileEditor")}
      />
    );

    await screen.findByTestId("builtin-view");
    // The view's own hold on it (#17903): one object for the mount, reading
    // through to the host's document.
    expect(new Set(seen.map((props) => props.fileDocument)).size).toBe(1);
    expect(seen.at(-1)?.fileDocument?.fileName).toBe("users.csv");
    expect(seen.at(-1)?.fileDocument?.getDraft()).toBe("a,b");
    expect(seen.at(-1)?.hostContext).toEqual({ kind: "fileEditor" });
    expect(activateForView).toHaveBeenCalledWith(kindId);
    expect(stylePrep.calls).toEqual([]);
    expect(documentViews.calls).toEqual([]);
  });

  // A view replaced inside the same host (a crash and Try again, a reload, a
  // rebind) may still have a formatter or a debounced report in flight. Landing
  // on the draft its successor started, under the successor's base, it would
  // have the close prompt's Save write text that base never described (#17903).
  it("keeps a crashed file editor view's late writes off the document its retry edits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Recorded on commit: React's dev stack capture calls a throwing view
    // without props.
    const mounted: NonNullable<PanelViewProps["fileDocument"]>[] = [];
    let shouldThrow = true;
    function Editor({ fileDocument }: PanelViewProps) {
      useEffect(() => {
        if (fileDocument) mounted.push(fileDocument);
        return () => fileDocument?.setDraft("flushed on unmount", { baseRevision: "rev-a" });
      }, [fileDocument]);
      // Thrown post-commit, as in the retry test below.
      useEffect(() => {
        if (shouldThrow) throw new Error("editor exploded");
      }, []);
      return <div data-testid="builtin-view" />;
    }
    const kindId = `plugin-view:${BUILTIN_ID}/editor`;
    registerBuiltinView(kindId, Editor, { pluginId: BUILTIN_ID, label: "Editor" });

    const Content = makePluginViewContent({
      id: kindId,
      name: "Editor fileEditor",
      componentPath: `plugin://${BUILTIN_ID}/__dtv-1/renderer/index.js`,
      extensionId: BUILTIN_ID,
      standalone: true,
    });
    const setDraft = vi.fn();
    const setConflict = vi.fn();
    const save = vi.fn(() => Promise.resolve({ status: "saved", revision: "rev-c" }));
    const fileDocument = {
      fileName: "a.json",
      readOnly: false,
      setDraft,
      setConflict,
      save,
    } as unknown as NonNullable<PanelViewProps["fileDocument"]>;
    render(
      <Content
        panelId="file-editor:panel-1"
        fileDocument={fileDocument}
        hostContext={pluginViewHostContext("fileEditor")}
      />
    );
    await screen.findByTestId("plugin-view-diagnostics");
    expect(mounted).toHaveLength(1);
    const crashed = mounted[0]!;
    // Its unmount cleanup's flush still reaches the document.
    expect(setDraft).toHaveBeenCalledWith("flushed on unmount", { baseRevision: "rev-a" });
    await act(async () => {
      await Promise.resolve();
    });

    setDraft.mockClear();
    crashed.setDraft("formatted late", { baseRevision: "rev-a" });
    crashed.setConflict(true);
    await expect(crashed.save("formatted late", { expectedRevision: "rev-a" })).resolves.toEqual({ status: "refused", reason: "unavailable" });
    expect(setDraft).not.toHaveBeenCalled();
    expect(setConflict).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    shouldThrow = false;
    fireEvent.click(screen.getByTestId("plugin-view-diagnostics-retry"));
    await screen.findByTestId("builtin-view");
    expect(mounted).toHaveLength(2);
    const retried = mounted[1]!;
    expect(retried).not.toBe(crashed);
    retried.setDraft("edited", { baseRevision: "rev-b" });
    expect(setDraft).toHaveBeenCalledWith("edited", { baseRevision: "rev-b" });
    expect(retried.fileName).toBe("a.json");
  });

  it("tells a view mounted outside the grid where it is, with one object per render", async () => {
    const seen: PanelViewProps[] = [];
    function Inspector(props: PanelViewProps) {
      seen.push(props);
      return <div data-testid="builtin-view" />;
    }
    registerBuiltinView(BUILTIN_KIND, Inspector, { pluginId: BUILTIN_ID, label: "Site Inspector" });

    const Content = makePluginViewContent(builtinConfig());
    const { rerender } = render(
      <Content panelId="surface:b" hostContext={pluginViewHostContext("surface")} />
    );
    await screen.findByTestId("builtin-view");
    rerender(<Content panelId="surface:b" hostContext={pluginViewHostContext("surface")} />);

    expect(seen.at(-1)?.hostContext).toEqual({ kind: "surface" });
    // Stable identity, so a view memoising on it doesn't churn.
    expect(new Set(seen.map((p) => p.hostContext)).size).toBe(1);
  });

  it("shows a reopened builtin view as soon as its activation answers", async () => {
    // Main publishes no runtime status for a builtin with no worker, so an
    // absent status must not read as "backend unknown" for one. The reopen is
    // warm, but it still activates before it renders (#10523).
    function Inspector() {
      return <div data-testid="builtin-view" />;
    }
    registerBuiltinView(BUILTIN_KIND, Inspector, { pluginId: BUILTIN_ID, label: "Site Inspector" });
    const Content = makePluginViewContent(builtinConfig());

    const first = render(<Content panelId="panel-reopen" worktreeId="wt-1" />);
    await screen.findByTestId("builtin-view");
    first.unmount();

    let answer!: () => void;
    activateForView.mockReturnValue(
      new Promise<undefined>((resolve) => {
        answer = () => resolve(undefined);
      })
    );
    render(<Content panelId="panel-reopen" worktreeId="wt-1" />);
    await act(async () => {});
    expect(screen.queryByTestId("builtin-view")).toBeNull();
    expect(activateForView).toHaveBeenCalledTimes(2);

    await act(async () => {
      answer();
    });
    expect(screen.getByTestId("builtin-view")).toBeTruthy();
  });

  it("names the view's plugin to kit content it portals out of the view", async () => {
    function Inspector() {
      const owner = useContext(PluginKitOwnerContext);
      return (
        <PluginStyleScope>
          <span data-testid="builtin-view">{owner}</span>
        </PluginStyleScope>
      );
    }
    registerBuiltinView(BUILTIN_KIND, Inspector, { pluginId: BUILTIN_ID, label: "Site Inspector" });

    const Content = makePluginViewContent(builtinConfig());
    render(<Content panelId="panel-owner" worktreeId="wt-1" />);

    const view = await screen.findByTestId("builtin-view");
    expect(view.textContent).toBe(BUILTIN_ID);
    expect(view.parentElement?.getAttribute("data-daintree-plugin-owner")).toBe(BUILTIN_ID);
  });

  // SvelteKit Tools registers `lazy(() => import("./SiteInspectorView"))` to keep
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

    // Not an empty pane: the panel says why it is empty and where to undo it.
    // Worker chrome stays out of the way — a plugin nobody asked to run has no
    // running to report, and "Restart plugin" over this would be nonsense.
    expect(screen.getByText("Enable this plugin")).not.toBeNull();
    expect(screen.getByText(/This plugin's turned off/)).not.toBeNull();
    expect(screen.queryByTestId("runtime-status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Manage plugins" }));
    expect(dispatch.mock.calls).toEqual([["app.pluginManager", undefined, { source: "user" }]]);

    act(() => {
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
    });
    await screen.findByTestId("builtin-view");
    expect(screen.queryByText("Enable this plugin")).toBeNull();
    expect(screen.queryByTestId("runtime-status")).not.toBeNull();
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
