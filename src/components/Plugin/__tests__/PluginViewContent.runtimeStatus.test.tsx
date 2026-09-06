// @vitest-environment jsdom
import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeStatus, PluginWorkerStatus } from "@shared/types/plugin";
import type { PluginViewContentConfig } from "../PluginViewContent";

/**
 * Host-owned backend health on a mounted plugin panel (#12278).
 *
 * The issue's premise is that a panel subscribes to nothing about the plugin
 * behind it, so these cover what a MOUNTED panel now learns: that its backend
 * died, that it can restart it, and that every panel of the same instance moves
 * together off one broadcast — no main-side panel registry involved.
 *
 * Separate file from `PluginViewContent.test.tsx` because that suite's fake
 * boundary deliberately swallows the fallback, and these need the real store
 * subscription rather than a stub.
 */

vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
  SkeletonHint: () => null,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({
    children,
    className,
    inert,
  }: {
    children: React.ReactNode;
    className?: string;
    inert?: boolean;
  }) => (
    <div data-testid="plugin-content" className={className} inert={inert}>
      {children}
    </div>
  ),
}));
/**
 * Records the callbacks the content hands the boundary, so a test can drive the
 * throw/reset pair the real `ErrorBoundary` would fire. Hoisted because the
 * factory below runs before the module body.
 */
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

type Listener = (payload: { pluginId: string; status: PluginRuntimeStatus | null }) => void;

let emit: Listener = () => {};
const restartWorkerMock = vi.fn();
const getRuntimeStatusesMock = vi.fn();

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

/** Push one runtime-status event the way `PluginService` broadcasts it. */
async function pushStatus(w: PluginWorkerStatus | null): Promise<void> {
  await act(async () => {
    emit({ pluginId: "acme", status: runtimeStatus(w) });
  });
}

beforeEach(() => {
  restartWorkerMock.mockReset().mockResolvedValue(null);
  getRuntimeStatusesMock.mockReset().mockResolvedValue([]);
  emit = () => {};
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
        restartWorker: restartWorkerMock,
        getRuntimeStatuses: getRuntimeStatusesMock,
      },
    },
  });
});

afterEach(async () => {
  const { _resetPluginRuntimeStatusStoreForTest } =
    await import("@/store/pluginRuntimeStatusStore");
  _resetPluginRuntimeStatusStoreForTest();
  vi.resetModules();
  Reflect.deleteProperty(window, "electron");
});

/** Mount the content layer with a trivially-resolving view module. */
async function mountContent(props: Record<string, unknown> = {}) {
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
    const utils = render(<Content panelId="panel-1" {...props} />);
    await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
    return utils;
  } finally {
    vi.doUnmock("react");
  }
}

describe("mounted panel learns its backend died (#12278)", () => {
  it("renders nothing host-owned while the backend is healthy", async () => {
    await mountContent();
    await pushStatus(worker({ state: "ready" }));

    // The plugin's own content is the whole panel when there is nothing wrong;
    // a banner over a healthy view would be noise on every panel.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("plugin-content").hasAttribute("inert")).toBe(false);
  });

  it("surfaces a terminal worker failure the plugin never reported", async () => {
    await mountContent();
    await pushStatus(worker({ state: "failed", reason: "crash-loop" }));

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Plugin keeps crashing");
    expect(screen.getByRole("button", { name: /Restart plugin/ })).toBeTruthy();
  });

  it("keeps stale content visible but stops it being interactive", async () => {
    await mountContent();
    await pushStatus(worker({ state: "failed", reason: "activation-failed" }));

    const content = screen.getByTestId("plugin-content");
    // Still there — it is the last thing the plugin produced, and blanking it
    // would lose context the user may want to read. `inert` rather than
    // `pointer-events-none`, which leaves every control tabbable.
    expect(screen.getByTestId("plugin-view")).toBeTruthy();
    expect(content.hasAttribute("inert")).toBe(true);
  });

  it("names the cause from the closed reason, never the free-form detail", async () => {
    await mountContent();
    await pushStatus(
      worker({
        state: "failed",
        reason: "protocol-violation",
        // Plugin-authored text. It must not reach a banner title unredacted.
        detail: "<script>alert(1)</script>",
      })
    );

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Plugin backend was stopped");
    expect(banner.textContent).not.toContain("alert(1)");
  });

  it("reports a respawn as an ambient reload rather than an error", async () => {
    await mountContent();
    // A backend that WAS working — otherwise this is a first activation, which
    // the Suspense skeleton already owns.
    await pushStatus(worker({ generation: 1, state: "ready" }));
    await pushStatus(worker({ generation: 2, state: "starting", reason: "crashed" }));

    const ambient = await screen.findByRole("status");
    expect(ambient.textContent).toContain("Reloading");
    // T1 ambient chrome: nothing is being asked of the user yet, so no banner
    // and no action.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /Restart plugin/ })).toBeNull();
  });

  it("asks main to restart the instance when the user acts on the banner", async () => {
    await mountContent();
    await pushStatus(worker({ state: "failed", reason: "crash-loop" }));

    const button = await screen.findByRole("button", { name: /Restart plugin/ });
    await act(async () => {
      button.click();
    });

    expect(restartWorkerMock).toHaveBeenCalledWith("acme");
  });

  it("rebinds the view when a different worker generation becomes ready", async () => {
    await mountContent();
    await pushStatus(worker({ generation: 1, state: "ready" }));
    const before = screen.getByTestId("plugin-view");

    await pushStatus(worker({ generation: 2, state: "starting" }));
    await pushStatus(worker({ generation: 2, state: "ready" }));

    // Every panel of the instance runs this off the SAME broadcast, which is
    // what makes them move together without a main-side panel registry.
    await waitFor(() => expect(screen.getByTestId("plugin-view")).not.toBe(before));
  });

  it("does not remount when the same generation reports ready again", async () => {
    await mountContent();
    await pushStatus(worker({ generation: 1, state: "ready" }));
    const before = screen.getByTestId("plugin-view");

    await pushStatus(worker({ generation: 1, state: "ready", detail: "unchanged" }));

    expect(screen.getByTestId("plugin-view")).toBe(before);
  });

  it("adopts the first ready generation it sees without remounting", async () => {
    // A panel mounting against an already-running backend must not read that
    // backend as a replacement and immediately throw its own view away.
    await mountContent();
    const before = screen.getByTestId("plugin-view");

    await pushStatus(worker({ generation: 7, state: "ready" }));

    expect(screen.getByTestId("plugin-view")).toBe(before);
  });

  it("restores the latest accepted panel state on a rebind, not the mount bag", async () => {
    const readRecoveryState = vi.fn(() => ({ state: { tab: "logs" }, version: 2 }));
    await mountContent({ initialArgs: { tab: "overview" }, readRecoveryState });
    await pushStatus(worker({ generation: 1, state: "ready" }));

    await pushStatus(worker({ generation: 2, state: "ready" }));

    // Recovery is not supposed to cost the user the work they persisted since
    // the panel opened.
    await waitFor(() => expect(readRecoveryState).toHaveBeenCalled());
  });

  it("remounts the view on a rebind rather than reusing the resolved component", async () => {
    // A fresh `lazy()` wrapper does NOT remount anything on its own: React
    // compares the RESOLVED type, so a wrapper resolving to the same module
    // export reuses the existing fiber. The view would keep its state and its
    // `deps: []` subscriptions while `replaceAttempt` had already aborted the
    // `disposeSignal` those subscriptions were tied to — resources torn down,
    // component never rebuilt. The boundary's `key` is what makes it real, so
    // this double returns ONE stable component identity across every wrapper.
    const mounts: string[] = [];
    function StableView() {
      useEffect(() => {
        mounts.push("mount");
      }, []);
      return <div data-testid="plugin-view" />;
    }
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      // ONE identity for every wrapper, which is the whole point.
      return { ...actual, lazy: () => StableView };
    });

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());
      render(<Content panelId="panel-rebind" />);
      await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
      await pushStatus(worker({ generation: 1, state: "ready" }));
      const mountsBefore = mounts.length;

      await pushStatus(worker({ generation: 2, state: "ready" }));

      await waitFor(() => expect(mounts.length).toBeGreaterThan(mountsBefore));
    } finally {
      vi.doUnmock("react");
    }
  });

  it("replaces a failed view when a healthy backend appears for the first time", async () => {
    // The initial activation is what failed, so this panel never observed a
    // `ready` at all. Treating "first observation" as "nothing to do" would
    // clear the banner and leave the user staring at the original error with a
    // healthy backend behind it.
    const lazyCalls = { count: 0 };
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      return {
        ...actual,
        lazy: () => {
          lazyCalls.count += 1;
          return function StubView() {
            return <div data-testid="plugin-view" />;
          };
        },
      };
    });

    try {
      const { makePluginViewContent } = await import("../PluginViewContent");
      const Content = makePluginViewContent(makeContentConfig());
      render(<Content panelId="panel-first-ready" />);
      await waitFor(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());

      act(() => boundaryCallbacks.onError?.(new Error("activation blew up")));
      const callsAfterThrow = lazyCalls.count;

      await pushStatus(worker({ generation: 4, state: "ready" }));

      await waitFor(() => expect(lazyCalls.count).toBeGreaterThan(callsAfterThrow));
    } finally {
      vi.doUnmock("react");
    }
  });

  it("leaves a first activation to the skeleton rather than reporting it twice", async () => {
    await mountContent();

    // This layer sits outside Suspense, so an ungated transient state would
    // paint "Reloading" beside the panel's own loading skeleton.
    await pushStatus(worker({ generation: 1, state: "activating" }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows no banner at all while nothing is known about the backend", async () => {
    await mountContent();

    // A missing status means "unknown, still hydrating", never "dead" — failing
    // the other way flashes a scary banner over every healthy panel for the
    // length of one IPC round trip.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
