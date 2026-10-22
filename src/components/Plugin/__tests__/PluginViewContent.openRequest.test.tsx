// @vitest-environment jsdom
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelViewProps } from "@shared/types/plugin";
import type { PluginViewContentConfig, PluginViewContentProps } from "../PluginViewContent";
import { settlePluginViewLoad } from "./settlePluginViewLoad";

/**
 * Arguments from an open that reused the panel reach its view as
 * `openRequest` (#13779): live while mounted, held for the next mount when it
 * isn't, and never replayed once a committed view has rendered them.
 */

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/pluginUi", () => ({ whenPluginUiReady: () => Promise.resolve() }));
vi.mock("@/services/plugin/pluginStyleContract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/plugin/pluginStyleContract")>()),
  preparePluginStyles: () => Promise.resolve(),
  registerPluginStyleRoot: () => () => {},
}));
vi.mock("@/components/ui/Skeleton", () => ({
  Skeleton: ({ label }: { label?: string }) => <div data-testid="skeleton">{label}</div>,
  SkeletonHint: () => null,
}));
// A settled load renders its view at once; the gate is loadPath's subject.
vi.mock("@/hooks/useDeferredLoading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDeferredLoading")>()),
  useSkeletonGate: () => false,
  useSkeletonFloor: (isShowing: boolean) => isShowing,
}));
vi.mock("@/components/ui/ContentFadeIn", () => ({
  ContentFadeIn: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/Plugin/PluginViewRuntimeStatus", () => ({
  PluginViewRuntimeStatus: () => null,
}));

// Catches a render throw and offers "Try again" the way the real boundary
// does, without its reporting pipeline.
vi.mock("@/components/ErrorBoundary", async () => {
  const { Component } = await import("react");
  class FakeBoundary extends Component<
    { children: ReactNode; onError?: (e: Error) => void; onReset?: () => void },
    { hasError: boolean }
  > {
    state = { hasError: false };
    static getDerivedStateFromError(): { hasError: true } {
      return { hasError: true };
    }
    componentDidCatch(error: Error): void {
      this.props.onError?.(error);
    }
    render(): ReactNode {
      if (!this.state.hasError) return this.props.children;
      return (
        <button
          data-testid="try-again"
          onClick={(): void => {
            this.setState({ hasError: false });
            this.props.onReset?.();
          }}
        >
          Try again
        </button>
      );
    }
  }
  return { ErrorBoundary: FakeBoundary };
});

const h = {
  renders: [] as PanelViewProps[],
  mounts: 0,
  /** The view throws while rendering a request for this path. */
  throwOnPath: null as string | null,
};

function RequestView(props: PanelViewProps) {
  const [instance] = useState(() => ({}));
  h.renders.push(props);
  useEffect(() => {
    h.mounts += 1;
  }, [instance]);
  if (h.throwOnPath !== null && props.openRequest?.args["path"] === h.throwOnPath) {
    throw new Error("can't open that");
  }
  return <div data-testid="plugin-view" />;
}

const VIEW_MODULE = "plugin://acme/dashboard.js";

function makeContentConfig(): PluginViewContentConfig {
  return {
    id: "acme.dashboard",
    name: "Dashboard",
    componentPath: VIEW_MODULE,
    extensionId: "acme",
  };
}

beforeEach(() => {
  h.renders = [];
  h.mounts = 0;
  h.throwOnPath = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      events: { on: () => () => {} },
      plugin: {
        onPanelKindsChanged: vi.fn(() => () => {}),
        restartWorker: vi.fn(() => Promise.resolve(null)),
        getRuntimeStatuses: vi.fn(() => Promise.resolve([])),
        reportPanelLifecycle: vi.fn(() => Promise.resolve()),
      },
    },
  });
});

afterEach(async () => {
  cleanup();
  await act(async () => {});
  vi.doUnmock(VIEW_MODULE);
  await vi.dynamicImportSettled();
  vi.resetModules();
  Reflect.deleteProperty(window, "electron");
});

/** The content factory plus the store instance it reads, both from this test's module graph. */
async function load() {
  vi.doMock(VIEW_MODULE, () => ({ default: RequestView }));
  const { makePluginViewContent } = await import("../PluginViewContent");
  const store = await import("@/store/pluginPanelOpenRequestStore");
  const Content = makePluginViewContent(makeContentConfig());
  const publish = (args: Record<string, unknown>, panelId = "panel-1") =>
    act(() => {
      store.usePluginPanelOpenRequestStore.getState().publish(panelId, args);
    });
  const seqOf = (panelId = "panel-1") =>
    store.usePluginPanelOpenRequestStore.getState().entriesByPanelId[panelId]?.request.seq;
  const delivered = (panelId = "panel-1") => store.readDeliveredOpenRequestSeq(panelId);
  return { Content, publish, seqOf, delivered };
}

async function mount(
  Content: Awaited<ReturnType<typeof load>>["Content"],
  props: Partial<PluginViewContentProps> = {}
) {
  const utils = render(<Content panelId="panel-1" {...props} />);
  await settlePluginViewLoad(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
  return utils;
}

function latest(panelId = "panel-1"): PanelViewProps {
  const props = h.renders.filter((p) => p.panelId === panelId).at(-1);
  if (!props) throw new Error(`the view for ${panelId} never rendered`);
  return props;
}

describe("PluginViewContent openRequest (#13779)", () => {
  it("hands a request made before the view mounted to its first attempt", async () => {
    const { Content, publish, seqOf, delivered } = await load();
    await publish({ path: "/a" });
    await publish({ path: "/b" });

    await mount(Content);

    expect(latest().openRequest).toEqual({ seq: seqOf(), args: { path: "/b" } });
    expect(delivered()).toBe(seqOf());
  });

  it("delivers to the mounted view without remounting it or touching initialArgs", async () => {
    const { Content, publish, seqOf, delivered } = await load();
    await mount(Content, { initialArgs: { path: "/start" } });
    const before = latest();
    expect(before.openRequest).toBeUndefined();

    await publish({ path: "/b" });

    const after = latest();
    expect(after.openRequest?.args).toEqual({ path: "/b" });
    expect(h.mounts).toBe(1);
    expect(after.disposeSignal).toBe(before.disposeSignal);
    expect(after.initialArgs).toBe(before.initialArgs);
    expect(delivered()).toBe(seqOf());

    // The same args again are a new request, not a no-op.
    const first = after.openRequest;
    await publish({ path: "/b" });
    expect(latest().openRequest).not.toBe(first);
    expect(latest().openRequest!.seq).toBeGreaterThan(first!.seq);
  });

  it("never replays a delivered request on a later mount, but hands over one made while unmounted", async () => {
    const { Content, publish } = await load();
    await publish({ path: "/a" });
    const first = await mount(Content);
    expect(latest().openRequest?.args).toEqual({ path: "/a" });
    first.unmount();

    const second = await mount(Content);
    expect(latest().openRequest).toBeUndefined();
    second.unmount();

    await publish({ path: "/b" });
    await mount(Content);
    expect(latest().openRequest?.args).toEqual({ path: "/b" });
  });

  it("keeps a request the view threw on waiting for the retry", async () => {
    const { Content, publish, seqOf, delivered } = await load();
    await mount(Content);
    h.throwOnPath = "/bad";
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await publish({ path: "/bad" });
      expect(screen.getByTestId("try-again")).toBeTruthy();
      expect(delivered()).toBe(0);

      h.throwOnPath = null;
      fireEvent.click(screen.getByTestId("try-again"));
      await settlePluginViewLoad(() => expect(screen.getByTestId("plugin-view")).toBeTruthy());
    } finally {
      quiet.mockRestore();
    }

    expect(latest().openRequest?.args).toEqual({ path: "/bad" });
    expect(delivered()).toBe(seqOf());
  });

  it("does not replay a delivered request into the attempt a reload builds", async () => {
    const { Content, publish } = await load();
    await mount(Content, { offerRequestReload: true });
    await publish({ path: "/a" });
    const before = latest();
    expect(before.openRequest?.args).toEqual({ path: "/a" });

    await act(async () => {
      before.requestReload?.();
    });
    await settlePluginViewLoad(() => expect(latest().disposeSignal).not.toBe(before.disposeSignal));

    expect(latest().openRequest).toBeUndefined();
  });

  it("delivers only to the panel the request names", async () => {
    const { Content, publish } = await load();
    await mount(Content);
    render(<Content panelId="panel-2" />);
    await settlePluginViewLoad(() => expect(latest("panel-2")).toBeTruthy());

    await publish({ path: "/a" }, "panel-2");

    expect(latest("panel-2").openRequest?.args).toEqual({ path: "/a" });
    expect(h.renders.some((p) => p.panelId === "panel-1" && p.openRequest)).toBe(false);
  });
});
