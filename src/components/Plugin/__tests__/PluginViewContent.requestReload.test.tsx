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
// Forwards the focus handlers and the ref: they are how the content learns focus
// was inside the view, which decides whether a reload moves focus to the host.
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({
    children,
    onFocus,
    onBlur,
    ref,
  }: {
    children: React.ReactNode;
    onFocus?: React.FocusEventHandler<HTMLDivElement>;
    onBlur?: React.FocusEventHandler<HTMLDivElement>;
    ref?: React.Ref<HTMLDivElement>;
  }) => (
    <div data-testid="plugin-content" onFocus={onFocus} onBlur={onBlur} ref={ref}>
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

  it("does not take back focus the user moved elsewhere after an earlier reload", async () => {
    const { lifecycle } = await mountContent();
    // Focus inside the view, then let a reload remove the node that held it —
    // which delivers no blur, so nothing tells the content focus left.
    act(() => {
      screen.getByRole("button", { name: "Inside the view" }).focus();
    });
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    try {
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

describe("host.reloadPanel reaching a mounted view (#12610)", () => {
  async function hostReload(panelId = "panel-1"): Promise<string> {
    const { reloadRegisteredPanel } = await import("@/services/plugin/pluginPanelReload");
    let result = "";
    await act(async () => {
      result = await reloadRegisteredPanel(panelId);
    });
    return result;
  }

  it("remounts the view and acknowledges it as scheduled", async () => {
    await mountContent();
    const before = latest();

    await expect(hostReload()).resolves.toBe("scheduled");

    await waitFor(() => expect(h.mounts).toHaveLength(2));
    expect(before.disposeSignal.aborted).toBe(true);
    expect(latest().disposeSignal.aborted).toBe(false);
    expect(latest().panelRemovedSignal).toBe(before.panelRemovedSignal);
  });

  it("reloads only the targeted panel", async () => {
    const { Content } = await mountContent();
    render(<Content panelId="panel-2" offerRequestReload />);
    await waitFor(() => expect(h.mounts).toHaveLength(2));
    const sibling = h.renders.filter((props) => props.panelId === "panel-2").at(-1);

    await expect(hostReload("panel-1")).resolves.toBe("scheduled");

    await waitFor(() => expect(h.mounts).toHaveLength(3));
    expect(sibling?.disposeSignal.aborted).toBe(false);
  });

  it("shares the view's budget and answers rate-limited once it is spent", async () => {
    const { lifecycle } = await mountContent();
    await requestReload();
    for (let i = 1; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await expect(hostReload()).resolves.toBe("scheduled");
    }
    expect(blockedBanner()).toBeNull();

    await expect(hostReload()).resolves.toBe("rate-limited");
    expect(blockedBanner()).not.toBeNull();
    // A stopped view stays stopped; the backend cannot lift the block.
    await expect(hostReload()).resolves.toBe("rate-limited");
    expect(blockedBanner()).not.toBeNull();
  });

  it("answers unavailable while the view shows an error, leaving recovery to the user", async () => {
    const { lifecycle } = await mountContent();
    await act(async () => {
      boundaryCallbacks.onError?.(new Error("view threw"));
    });

    await expect(hostReload()).resolves.toBe("unavailable");
    expect(h.mounts).toHaveLength(1);
    expect(lifecycle.isViewReloadBlocked("panel-1")).toBe(false);
  });

  it("answers unavailable mid-restart without charging the budget", async () => {
    const { lifecycle } = await mountContent();
    await pushStatus(worker({ generation: 1 }));
    await pushStatus(worker({ generation: 2, state: "starting" }));

    await expect(hostReload()).resolves.toBe("unavailable");
    expect(attempts()).toHaveLength(1);

    // The restart's own rebind replaces the view, uncharged.
    await pushStatus(worker({ generation: 2 }));
    await waitFor(() => expect(attempts()).toHaveLength(2));
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await expect(hostReload()).resolves.toBe("scheduled");
    }
    expect(blockedBanner()).toBeNull();
  });

  it("folds a request landing while the replacement loads into it, uncharged", async () => {
    const { lifecycle } = await mountContent();
    const { reloadRegisteredPanel } = await import("@/services/plugin/pluginPanelReload");
    let results: string[] = [];
    await act(async () => {
      // The second request lands after the first was admitted but before its
      // replacement committed.
      const first = await reloadRegisteredPanel("panel-1");
      const second = await reloadRegisteredPanel("panel-1");
      results = [first, second];
    });
    expect(results).toEqual(["scheduled", "scheduled"]);
    await waitFor(() => expect(h.mounts).toHaveLength(2));

    for (let i = 1; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await expect(hostReload()).resolves.toBe("scheduled");
    }
    expect(blockedBanner()).toBeNull();
  });

  it("merges requests landing together into one charged reload", async () => {
    const { lifecycle } = await mountContent();
    const { reloadRegisteredPanel } = await import("@/services/plugin/pluginPanelReload");
    let results: string[] = [];
    await act(async () => {
      results = await Promise.all([
        reloadRegisteredPanel("panel-1"),
        reloadRegisteredPanel("panel-1"),
      ]);
    });
    expect(results).toEqual(["scheduled", "scheduled"]);
    await waitFor(() => expect(h.mounts).toHaveLength(2));

    for (let i = 1; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await expect(hostReload()).resolves.toBe("scheduled");
    }
    expect(blockedBanner()).toBeNull();
  });

  it("is not offered where the host withholds requestReload", async () => {
    const { Content } = await mountContent();
    render(<Content panelId="surface-1" />);
    await waitFor(() =>
      expect(h.renders.some((props) => props.panelId === "surface-1")).toBe(true)
    );
    await expect(hostReload("surface-1")).resolves.toBe("not-mounted");
  });

  it("answers not-mounted once the view has unmounted", async () => {
    const { unmount } = await mountContent();
    unmount();
    await act(async () => {});
    await expect(hostReload()).resolves.toBe("not-mounted");
  });

  it("does not move focus to the reloaded panel", async () => {
    await mountContent();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    await expect(hostReload()).resolves.toBe("scheduled");
    await waitFor(() => expect(h.mounts).toHaveLength(2));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe("the user's Reload panel (#12611)", () => {
  async function userReload(lifecycle: Awaited<ReturnType<typeof loadContent>>["lifecycle"]) {
    let handled = false;
    await act(async () => {
      handled = lifecycle.requestUserViewReload("panel-1");
    });
    return handled;
  }

  it("remounts a healthy view, uncharged, with the latest accepted state", async () => {
    const { lifecycle } = await mountContent({
      initialArgs: { page: 1 },
      readRecoveryState: () => ({ state: { page: 7 } }),
    });
    const first = latest();

    expect(await userReload(lifecycle)).toBe(true);

    await waitFor(() => expect(h.mounts).toHaveLength(2));
    expect(first.disposeSignal.aborted).toBe(true);
    expect(latest().initialArgs).toEqual({ page: 7 });
    // Free: the whole budget is still there afterwards.
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(blockedBanner()).toBeNull();
  });

  it("re-arms a view the loop breaker stopped", async () => {
    const { lifecycle } = await mountContent();
    for (let i = 0; i <= lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    expect(blockedBanner()).not.toBeNull();

    await userReload(lifecycle);

    await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
    expect(blockedBanner()).toBeNull();
    expect(lifecycle.isViewReloadBlocked("panel-1")).toBe(false);
  });

  it("is not offered by a host that offers no reload", async () => {
    const { Content, lifecycle } = await loadContent();
    render(<Content panelId="panel-1" />);
    await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());

    expect(await userReload(lifecycle)).toBe(false);
    expect(h.mounts).toHaveLength(1);
    expect(latest().setHasUnsavedChanges).toBeUndefined();
  });

  it("stops being reachable once the content unmounts", async () => {
    const { lifecycle, unmount } = await mountContent();
    unmount();
    await act(async () => {});

    expect(lifecycle.requestUserViewReload("panel-1")).toBe(false);
  });

  it("brings focus back to the host when it was inside the discarded view", async () => {
    const { lifecycle } = await mountContent();
    act(() => {
      screen.getByRole("button", { name: "Inside the view" }).focus();
    });
    const content = screen.getByTestId("plugin-content");

    await userReload(lifecycle);
    await waitFor(() => expect(h.mounts).toHaveLength(2));

    expect(document.activeElement).not.toBe(document.body);
    expect(content.contains(document.activeElement)).toBe(false);
    // The host-owned status wrapper, which sits beside the content it replaced.
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement?.nextElementSibling).toBe(screen.getByTestId("plugin-content"));
  });

  it("leaves focus alone when it was somewhere else", async () => {
    const { lifecycle } = await mountContent();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    try {
      elsewhere.focus();

      await userReload(lifecycle);
      await waitFor(() => expect(h.mounts).toHaveLength(2));

      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });
});

describe("setHasUnsavedChanges (#12611)", () => {
  it("raises and lowers the panel's unsaved-work flag", async () => {
    const { lifecycle } = await mountContent();

    act(() => latest().setHasUnsavedChanges?.(true));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(true);

    act(() => latest().setHasUnsavedChanges?.(false));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
  });

  it("keeps one setter per attempt", async () => {
    const { rerender, Content } = await mountContent();
    const first = latest().setHasUnsavedChanges;
    expect(typeof first).toBe("function");
    rerender(<Content panelId="panel-1" offerRequestReload />);
    expect(latest().setHasUnsavedChanges).toBe(first);
  });

  it("starts a new attempt clean, and ignores the old attempt's setter", async () => {
    const { lifecycle } = await mountContent();
    const stale = latest();
    act(() => stale.setHasUnsavedChanges?.(true));

    await requestReload();
    await waitFor(() => expect(h.mounts).toHaveLength(2));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);

    const current = latest();
    expect(current.setHasUnsavedChanges).not.toBe(stale.setHasUnsavedChanges);
    act(() => current.setHasUnsavedChanges?.(true));
    // The torn-down attempt can neither clear the replacement's flag nor raise
    // one of its own.
    act(() => stale.setHasUnsavedChanges?.(false));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(true);
    act(() => current.setHasUnsavedChanges?.(false));
    act(() => stale.setHasUnsavedChanges?.(true));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
  });

  it("does not hold up the view's own reload", async () => {
    await mountContent();
    act(() => latest().setHasUnsavedChanges?.(true));

    await requestReload();

    await waitFor(() => expect(h.mounts).toHaveLength(2));
  });

  it("is lowered when the backend's host.reloadPanel replaces the view", async () => {
    const { lifecycle } = await mountContent();
    const { reloadRegisteredPanel } = await import("@/services/plugin/pluginPanelReload");
    act(() => latest().setHasUnsavedChanges?.(true));

    await act(async () => {
      await reloadRegisteredPanel("panel-1");
    });

    await waitFor(() => expect(h.mounts).toHaveLength(2));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
  });

  it("is lowered when the content unmounts", async () => {
    const { lifecycle, unmount } = await mountContent();
    act(() => latest().setHasUnsavedChanges?.(true));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(true);
    const held = latest().setHasUnsavedChanges;

    unmount();
    await act(async () => {});

    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
    held?.(true);
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
  });

  it("is lowered when the loop breaker stops the view, and stays down", async () => {
    const { lifecycle } = await mountContent();
    for (let i = 0; i < lifecycle.VIEW_RELOAD_LIMIT; i++) {
      await requestReload();
    }
    const last = latest();
    act(() => last.setHasUnsavedChanges?.(true));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(true);

    await requestReload();

    expect(blockedBanner()).not.toBeNull();
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
    act(() => last.setHasUnsavedChanges?.(true));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
  });

  it("is lowered when the view crashes, and the crashed view cannot raise it", async () => {
    const { lifecycle } = await mountContent();
    const crashed = latest();
    act(() => crashed.setHasUnsavedChanges?.(true));

    await act(async () => {
      boundaryCallbacks.onError?.(new Error("view threw"));
    });

    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
    act(() => crashed.setHasUnsavedChanges?.(true));
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
  });

  it("survives a StrictMode replay and goes with the final unmount", async () => {
    h.onMountEffect = (props) => props.setHasUnsavedChanges?.(true);
    const { lifecycle, unmount } = await mountContent({}, { strict: true });
    await act(async () => {});

    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(true);
    expect(lifecycle.requestUserViewReload("panel-1")).toBe(true);

    unmount();
    await act(async () => {});
    expect(lifecycle.hasViewUnsavedChanges("panel-1")).toBe(false);
    expect(lifecycle.requestUserViewReload("panel-1")).toBe(false);
  });
});
