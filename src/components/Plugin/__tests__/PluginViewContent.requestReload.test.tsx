// @vitest-environment jsdom
import { StrictMode, useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PanelViewProps,
  PluginPanelLifecycleEvent,
  PluginRuntimeStatus,
  PluginWorkerStatus,
} from "@shared/types/plugin";
import type { PluginViewContentConfig, PluginViewContentProps } from "../PluginViewContent";

/**
 * A plugin view asking the host to remount it (#12609).
 *
 * Every view here is ONE component identity across every `lazy()` wrapper the
 * content builds. A double that minted a new component per wrapper would
 * remount on its own and hide a reload that only re-rendered — the boundary's
 * `key` is the thing under test.
 */

vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
  SkeletonHint: () => null,
}));
// Forwards the focus handlers: they are how the content learns focus was inside
// the view, which decides whether a reload block moves focus to the host.
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({
    children,
    onFocus,
    onBlur,
  }: {
    children: React.ReactNode;
    onFocus?: React.FocusEventHandler<HTMLDivElement>;
    onBlur?: React.FocusEventHandler<HTMLDivElement>;
  }) => (
    <div data-testid="plugin-content" onFocus={onFocus} onBlur={onBlur}>
      {children}
    </div>
  ),
}));

const boundaryCallbacks = vi.hoisted(
  () => ({}) as { onError?: (e: Error) => void; onReset?: () => void }
);

vi.mock("@/components/ErrorBoundary", async () => {
  const { Component } = await import("react");
  class FakeBoundary extends Component<{
    children: React.ReactNode;
    onError?: (e: Error) => void;
    onReset?: () => void;
  }> {
    render(): React.ReactNode {
      boundaryCallbacks.onError = this.props.onError;
      boundaryCallbacks.onReset = this.props.onReset;
      return this.props.children;
    }
  }
  return { ErrorBoundary: FakeBoundary };
});

// The status layer lazy-loads its banner, and this suite stubs React's `lazy`
// wholesale — so mount the real banner directly. It renders nothing unless
// there is something to report.
vi.mock("@/components/Plugin/PluginViewRuntimeStatus", async () => {
  const { PluginViewRuntimeBanner } = await import("../PluginViewRuntimeBanner");
  type Props = Parameters<typeof PluginViewRuntimeBanner>[0];
  return { PluginViewRuntimeStatus: (props: Props) => <PluginViewRuntimeBanner {...props} /> };
});

type Listener = (payload: { pluginId: string; status: PluginRuntimeStatus | null }) => void;

interface Mount {
  seq: number;
  signal: AbortSignal;
  /** Read in the view's own effect setup, which is where replay bites. */
  abortedAtSetup: boolean;
}

const h = {
  seq: 0,
  renders: [] as PanelViewProps[],
  mounts: [] as Mount[],
  /** Called from the view's render body, for the render-phase case. */
  onRender: null as ((props: PanelViewProps) => void) | null,
  /** Called from the view's mount effect, for the StrictMode replay case. */
  onMountEffect: null as ((props: PanelViewProps) => void) | null,
};

/** The one component identity every attempt resolves to. */
function StableView(props: PanelViewProps) {
  const [seq] = useState(() => ++h.seq);
  // Pinned per instance so the mount effect runs once per mount: a reload has
  // to remount this component, not hand the old instance new props.
  const [mountProps] = useState(props);
  h.renders.push(props);
  h.onRender?.(props);
  useEffect(() => {
    h.mounts.push({
      seq,
      signal: mountProps.disposeSignal,
      abortedAtSetup: mountProps.disposeSignal.aborted,
    });
    h.onMountEffect?.(mountProps);
  }, [seq, mountProps]);
  return (
    <div data-testid="plugin-view" data-seq={seq}>
      <button type="button">Inside the view</button>
    </div>
  );
}

let emit: Listener = () => {};
const reportPanelLifecycle = vi.fn<(events: PluginPanelLifecycleEvent[]) => Promise<void>>(() =>
  Promise.resolve()
);

function makeContentConfig(): PluginViewContentConfig {
  return {
    id: "acme.dashboard",
    name: "Dashboard",
    componentPath: "plugin://acme/dashboard.js",
    extensionId: "acme",
  };
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

function runtimeStatus(w: PluginWorkerStatus | null): PluginRuntimeStatus {
  return { pluginId: "acme", viewGeneration: 1, worker: w, dev: null };
}

async function pushStatus(w: PluginWorkerStatus | null): Promise<void> {
  await act(async () => {
    emit({ pluginId: "acme", status: runtimeStatus(w) });
  });
}

beforeEach(() => {
  h.seq = 0;
  h.renders = [];
  h.mounts = [];
  h.onRender = null;
  h.onMountEffect = null;
  emit = () => {};
  reportPanelLifecycle.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      events: {
        on: (name: string, cb: Listener) => {
          if (name === "plugin:runtime-status-changed") emit = cb;
          return () => {};
        },
      },
      plugin: {
        onPanelKindsChanged: vi.fn(() => () => {}),
        restartWorker: vi.fn(() => Promise.resolve(null)),
        getRuntimeStatuses: vi.fn(() => Promise.resolve([])),
        reportPanelLifecycle,
      },
    },
  });
});

afterEach(async () => {
  // Unmount while the bridge still exists, and let the deferred dispose abort
  // land, before any of it is torn out from under the content.
  cleanup();
  await act(async () => {});
  boundaryCallbacks.onError = undefined;
  boundaryCallbacks.onReset = undefined;
  const { _resetPluginRuntimeStatusStoreForTest } =
    await import("@/store/pluginRuntimeStatusStore");
  _resetPluginRuntimeStatusStoreForTest();
  vi.resetModules();
  Reflect.deleteProperty(window, "electron");
});

/**
 * Load the content with `lazy` resolving straight to {@link StableView}, plus
 * the lifecycle module instance that content shares — the budget lives there.
 */
async function loadContent() {
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return { ...actual, lazy: () => StableView };
  });
  try {
    const { makePluginViewContent } = await import("../PluginViewContent");
    const lifecycle = await import("@/services/plugin/pluginPanelLifecycle");
    return { Content: makePluginViewContent(makeContentConfig()), lifecycle };
  } finally {
    vi.doUnmock("react");
  }
}

async function mountContent(
  props: Partial<PluginViewContentProps> = {},
  { strict = false }: { strict?: boolean } = {}
) {
  const loaded = await loadContent();
  const { Content } = loaded;
  const element = <Content panelId="panel-1" offerRequestReload {...props} />;
  const utils = render(strict ? <StrictMode>{element}</StrictMode> : element);
  await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
  return { ...loaded, ...utils };
}

function latest(): PanelViewProps {
  const props = h.renders[h.renders.length - 1];
  if (!props) throw new Error("the view never rendered");
  return props;
}

/** Ask for a reload the way a view would, and let the host act on it. */
async function requestReload(from: PanelViewProps = latest()): Promise<void> {
  await act(async () => {
    from.requestReload?.();
  });
}

/** Every distinct attempt the view has been rendered for, in order. */
function attempts(): AbortSignal[] {
  return [...new Set(h.renders.map((props) => props.disposeSignal))];
}

function blockedBanner(): HTMLElement | null {
  return screen.queryByText("Panel kept reloading itself");
}

describe("requestReload (#12609)", () => {
  it("is handed to a panel host's view and withheld when the host doesn't offer it", async () => {
    const { Content } = await mountContent();
    expect(typeof latest().requestReload).toBe("function");

    render(<Content panelId="surface-1" />);
    await waitFor(() =>
      expect(h.renders.some((props) => props.panelId === "surface-1")).toBe(true)
    );
    const surfaceProps = h.renders.filter((props) => props.panelId === "surface-1");
    expect(surfaceProps.every((props) => props.requestReload === undefined)).toBe(true);
  });

  it("keeps one callback per attempt", async () => {
    const { rerender, Content } = await mountContent();
    const first = latest().requestReload;
    rerender(<Content panelId="panel-1" offerRequestReload />);
    expect(latest().requestReload).toBe(first);
  });

  it("remounts the exported root: new instance, DOM and dispose signal, same panel", async () => {
    await mountContent();
    const before = latest();
    const oldNode = screen.getByTestId("plugin-view");

    await requestReload();

    await waitFor(() => expect(h.mounts).toHaveLength(2));
    const after = latest();
    const newNode = screen.getByTestId("plugin-view");
    // A new component instance, not a re-render of the old one.
    expect(newNode.dataset.seq).not.toBe(oldNode.dataset.seq);
    expect(oldNode.isConnected).toBe(false);
    // The outgoing attempt is finished; the new one starts live.
    expect(before.disposeSignal.aborted).toBe(true);
    expect(after.disposeSignal).not.toBe(before.disposeSignal);
    expect(after.disposeSignal.aborted).toBe(false);
    // The panel itself is untouched.
    expect(after.panelRemovedSignal).toBe(before.panelRemovedSignal);
    expect(after.panelRemovedSignal.aborted).toBe(false);
    expect(after.panelId).toBe(before.panelId);
  });

  it("restores the latest accepted state and version rather than the mount bag", async () => {
    // What the panel record holds, which moves on as the view persists.
    let accepted = { state: { tab: "overview" } as Record<string, unknown>, version: 2 };
    const readRecoveryState = vi.fn(() => accepted);
    await mountContent({ initialArgs: { tab: "overview" }, stateVersion: 2, readRecoveryState });
    expect(latest().initialArgs).toEqual({ tab: "overview" });

    accepted = { state: { tab: "logs" }, version: 3 };
    await requestReload();

    await waitFor(() => expect(h.mounts).toHaveLength(2));
    // Read when the reload ran, not cached from the mount.
    expect(latest().initialArgs).toEqual({ tab: "logs" });
    expect(latest().stateVersion).toBe(3);
  });

  it("merges a burst of requests into one reload, charged once", async () => {
    const { lifecycle } = await mountContent();

    await act(async () => {
      const props = latest();
      props.requestReload?.();
      props.requestReload?.();
      props.requestReload?.();
    });
    await waitFor(() => expect(h.mounts).toHaveLength(2));

    // The burst cost exactly one unit: the rest of the budget is still there,
    // and not a unit more.
    for (let i = 1; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(h.mounts).toHaveLength(lifecycle.VIEW_RELOAD_LIMIT + 1);
    expect(blockedBanner()).toBeNull();
    await requestReload();
    expect(blockedBanner()).not.toBeNull();
  });

  it("ignores a callback held by an attempt that has been replaced", async () => {
    const { lifecycle } = await mountContent();
    const stale = latest();

    await requestReload();
    await waitFor(() => expect(h.mounts).toHaveLength(2));

    await requestReload(stale);
    await requestReload(stale);
    expect(h.mounts).toHaveLength(2);

    // The stale calls charged nothing: the whole remaining budget is intact.
    for (let i = 1; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(h.mounts).toHaveLength(lifecycle.VIEW_RELOAD_LIMIT + 1);
    expect(lifecycle.isViewReloadBlocked("panel-1")).toBe(false);
  });

  it("acts on a request made while the view renders only after that render", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let asked = false;
      h.onRender = (props) => {
        if (asked) return;
        asked = true;
        props.requestReload?.();
      };
      await mountContent();

      await waitFor(() => expect(h.mounts).toHaveLength(2));
      // Setting host state from inside the view's render is exactly what React
      // warns about.
      const renderPhaseUpdates = consoleError.mock.calls.filter((args) =>
        String(args[0]).includes("while rendering a different component")
      );
      expect(renderPhaseUpdates).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("stops the view when the budget runs out and offers Reload panel", async () => {
    const { lifecycle } = await mountContent();
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(h.mounts).toHaveLength(lifecycle.VIEW_RELOAD_LIMIT + 1);
    const last = latest();

    await requestReload();

    // Discarded as asked, but nothing mounted in its place.
    expect(screen.queryByTestId("plugin-view")).toBeNull();
    expect(last.disposeSignal.aborted).toBe(true);
    expect(h.mounts).toHaveLength(lifecycle.VIEW_RELOAD_LIMIT + 1);
    expect(blockedBanner()).not.toBeNull();
    // Its worker hears the panel has no working view, through an existing phase.
    await act(async () => {});
    const phases = reportPanelLifecycle.mock.calls.flatMap(([events]) =>
      events.map((event) => event.phase)
    );
    expect(phases[phases.length - 1]).toBe("render-failed");

    fireEvent.click(screen.getByRole("button", { name: "Reload panel" }));

    await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
    expect(blockedBanner()).toBeNull();
    expect(latest().disposeSignal.aborted).toBe(false);
    // The user's reload is free and starts the budget over.
    const mountsAfterUserReload = h.mounts.length;
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(h.mounts).toHaveLength(mountsAfterUserReload + lifecycle.VIEW_RELOAD_LIMIT);
    expect(blockedBanner()).toBeNull();
  });

  it("stays stopped across a temporary unmount", async () => {
    const { lifecycle, Content, unmount } = await mountContent();
    for (let i = 0; i <= lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(blockedBanner()).not.toBeNull();
    const mountsWhenBlocked = h.mounts.length;

    // A sibling maximize tears the whole content down, then brings it back.
    unmount();
    render(<Content panelId="panel-1" offerRequestReload />);

    expect(blockedBanner()).not.toBeNull();
    expect(screen.queryByTestId("plugin-view")).toBeNull();
    expect(h.mounts).toHaveLength(mountsWhenBlocked);
  });

  it("does not let a backend restart lift the block", async () => {
    const { lifecycle } = await mountContent();
    await pushStatus(worker({ generation: 1 }));
    for (let i = 0; i <= lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    const mountsWhenBlocked = h.mounts.length;

    await pushStatus(worker({ generation: 2, state: "starting" }));
    await pushStatus(worker({ generation: 2 }));

    expect(blockedBanner()).not.toBeNull();
    expect(screen.queryByTestId("plugin-view")).toBeNull();
    expect(h.mounts).toHaveLength(mountsWhenBlocked);
    // The block lives in the lifecycle service, not just in this component's
    // state: the latch a remount reads is intact, and the panel still reports
    // as failed.
    expect(lifecycle.isViewReloadBlocked("panel-1")).toBe(true);
    await act(async () => {});
    const phases = reportPanelLifecycle.mock.calls.flatMap(([events]) =>
      events.map((event) => event.phase)
    );
    expect(phases[phases.length - 1]).toBe("render-failed");
  });

  it("treats the user's Try again as a reload that starts the budget over", async () => {
    const { lifecycle } = await mountContent();
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }

    await act(async () => {
      boundaryCallbacks.onError?.(new Error("view threw"));
      boundaryCallbacks.onReset?.();
    });
    await waitFor(() => expect(h.mounts).toHaveLength(lifecycle.VIEW_RELOAD_LIMIT + 2));

    // A whole fresh budget, then a block.
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(h.mounts).toHaveLength(2 * lifecycle.VIEW_RELOAD_LIMIT + 2);
    expect(blockedBanner()).toBeNull();
    await requestReload();
    expect(blockedBanner()).not.toBeNull();
  });

  it("moves focus to the host when a block takes away the view that held it", async () => {
    const { lifecycle } = await mountContent();
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    act(() => {
      screen.getByRole("button", { name: "Inside the view" }).focus();
    });

    await requestReload();

    expect(blockedBanner()).not.toBeNull();
    // Onto the host-owned status wrapper, rather than stranded on the body.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.contains(blockedBanner())).toBe(true);
  });

  it("leaves focus alone when it was somewhere else", async () => {
    const { lifecycle } = await mountContent();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    try {
      for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
        await requestReload();
      }
      elsewhere.focus();

      await requestReload();

      expect(blockedBanner()).not.toBeNull();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it("refuses a request from a view that has failed, leaving recovery to the user", async () => {
    const { lifecycle } = await mountContent();
    const failed = latest();

    await act(async () => {
      boundaryCallbacks.onError?.(new Error("view threw"));
    });
    await requestReload(failed);

    expect(h.mounts).toHaveLength(1);
    expect(lifecycle.isViewReloadBlocked("panel-1")).toBe(false);
  });
});

describe("requestReload under StrictMode (#12609, 1db069bf4d)", () => {
  it("mounts the first attempt with a live dispose signal", async () => {
    await mountContent({}, { strict: true });
    await act(async () => {});

    // The replayed setup used to find the signal its own cleanup had aborted.
    expect(h.mounts.length).toBeGreaterThan(0);
    expect(h.mounts.every((mount) => !mount.abortedAtSetup)).toBe(true);
    expect(latest().disposeSignal.aborted).toBe(false);
  });

  it("reloads once, and charges once, for a request the replay makes twice", async () => {
    let calls = 0;
    h.onMountEffect = (props) => {
      // Only the first attempt asks — StrictMode runs its effect twice.
      if (props.disposeSignal !== attempts()[0]) return;
      calls++;
      props.requestReload?.();
    };
    const { lifecycle } = await mountContent({}, { strict: true });

    await waitFor(() => expect(attempts()).toHaveLength(2));
    await act(async () => {});
    expect(calls).toBe(2);
    expect(attempts()).toHaveLength(2);
    expect(latest().disposeSignal.aborted).toBe(false);

    // One unit spent, so the rest of the budget remains.
    for (let i = 1; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(attempts()).toHaveLength(lifecycle.VIEW_RELOAD_LIMIT + 1);
    expect(blockedBanner()).toBeNull();
  });

  it("still aborts the dispose signal when the content really unmounts", async () => {
    const { unmount } = await mountContent({}, { strict: true });
    const signal = latest().disposeSignal;

    unmount();
    await Promise.resolve();

    expect(signal.aborted).toBe(true);
  });
});

describe("requestReload racing a backend restart (#12609)", () => {
  it("remounts once, uncharged, when a new backend lands before the reload runs", async () => {
    const { lifecycle } = await mountContent();
    await pushStatus(worker({ generation: 1 }));

    await act(async () => {
      latest().requestReload?.();
      emit({ pluginId: "acme", status: runtimeStatus(worker({ generation: 2 })) });
    });

    await waitFor(() => expect(attempts()).toHaveLength(2));
    await act(async () => {});
    expect(attempts()).toHaveLength(2);

    // The rebind replaced the view; the plugin's budget is untouched.
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(attempts()).toHaveLength(lifecycle.VIEW_RELOAD_LIMIT + 2);
    expect(blockedBanner()).toBeNull();
  });

  it("leaves a reload requested mid-restart to the rebind the restart ends in", async () => {
    const { lifecycle } = await mountContent();
    await pushStatus(worker({ generation: 1 }));
    await pushStatus(worker({ generation: 2, state: "starting" }));

    await requestReload();
    expect(attempts()).toHaveLength(1);

    await pushStatus(worker({ generation: 2 }));

    await waitFor(() => expect(attempts()).toHaveLength(2));
    await act(async () => {});
    expect(attempts()).toHaveLength(2);

    // Refused, so uncharged: the whole budget is still there.
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(attempts()).toHaveLength(lifecycle.VIEW_RELOAD_LIMIT + 2);
    expect(blockedBanner()).toBeNull();
  });

  it("still rebinds when the backend is replaced after a reload finished", async () => {
    await mountContent();
    await pushStatus(worker({ generation: 1 }));

    await requestReload();
    await waitFor(() => expect(attempts()).toHaveLength(2));

    await pushStatus(worker({ generation: 2 }));

    await waitFor(() => expect(attempts()).toHaveLength(3));
  });
});
