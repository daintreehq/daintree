// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMetricsEvent } from "@shared/types/ipc/hostMetrics";
import type { HostDescriptor } from "@shared/types/remoteHosts";
import { _resetHostListForTesting } from "../../hostList";
import { _resetHostMetricsFeedForTesting } from "../hostMetricsFeed";
import { HostsOverviewMount } from "../HostsOverviewMount";
import { LazyOtherHostsWorktrees, LazyWorktreePlacementRow } from "../LazyHostOverviewParts";

/** The slice of main's HostMetricsClient this drives; its module graph is main-process only. */
interface ShellMetricsClient {
  start(): void;
  dispose(): void;
  getSnapshots(): unknown[];
  listWorktrees(payload: unknown): Promise<unknown>;
  listFleetTargets(payload: unknown): Promise<unknown>;
}
type ShellMetricsClientCtor = new (options: unknown) => ShellMetricsClient;

// Loaded by path at run time so the renderer's type-check never walks main's graph.
const MAIN_METRICS_CLIENT = "../../../../../electron/remote/metrics/client";

/**
 * Someone who never adds a host: every Remote Hosts surface in a view is
 * mounted, with the real Shell-side metrics client behind the bridge, and
 * nothing shows, nothing dials and nothing samples.
 */
describe("with no host added", () => {
  const registry: HostDescriptor[] = [];
  const connect = vi.fn();
  const subscribeLocalSampler = vi.fn(() => () => {});
  let client: ShellMetricsClient;
  let bridge: {
    remoteHosts: Record<string, ReturnType<typeof vi.fn>>;
    hostMetrics: Record<string, ReturnType<typeof vi.fn>>;
  };

  beforeEach(async () => {
    const { HostMetricsClient } = await vi.importActual<{
      HostMetricsClient: ShellMetricsClientCtor;
    }>(MAIN_METRICS_CLIENT);
    client = new HostMetricsClient({
      manager: {
        connect,
        get: () => undefined,
        connectionState: () => ({ status: "disconnected" }),
        onSessionOpened: () => () => {},
      },
      registry: { list: () => registry, get: () => null, onChange: () => () => {} },
      localLoop: { subscribe: subscribeLocalSampler },
      emit: () => {},
      deliverAttention: () => false,
      local: {
        listFleetTargets: async () => [],
        submitFleet: async () => {},
        listWorktrees: async () => [],
      },
    });
    client.start();
    bridge = {
      remoteHosts: {
        list: vi.fn(async () => []),
        isInUse: vi.fn(async () => registry.length > 0),
        onEvent: vi.fn(() => () => {}),
        connect: vi.fn(),
      },
      hostMetrics: {
        getSnapshots: vi.fn(async () => client.getSnapshots()),
        onEvent: vi.fn((_listener: (event: HostMetricsEvent) => void) => () => {}),
        listWorktrees: vi.fn(async (payload: unknown) => client.listWorktrees(payload)),
        listFleetTargets: vi.fn(async (payload: unknown) => client.listFleetTargets(payload)),
      },
    };
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: bridge,
    });
  });

  afterEach(() => {
    client.dispose();
    _resetHostListForTesting();
    _resetHostMetricsFeedForTesting();
    vi.clearAllMocks();
  });

  it("shows no overview or placement UI, dials nothing and samples nothing", async () => {
    const { container } = render(
      <>
        <HostsOverviewMount />
        <LazyWorktreePlacementRow projectId="p1" onLeave={() => {}} />
        <LazyOtherHostsWorktrees onNavigate={() => {}} />
      </>
    );
    // The overview's lazy host mounts and its summary feed asks whether hosts are in use.
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bridge.remoteHosts.isInUse).toHaveBeenCalled();

    expect(bridge.remoteHosts.list).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="worktree-host-select"]')).toBeNull();
    expect(container.querySelector('[data-testid="hosts-overview-grid"]')).toBeNull();
    expect(document.querySelector('[data-testid="hosts-overview-grid"]')).toBeNull();
    expect(container.textContent).toBe("");

    // No dialing: neither a summary link nor a worktree or fleet read to any host.
    expect(connect).not.toHaveBeenCalled();
    expect(bridge.remoteHosts.connect).not.toHaveBeenCalled();
    expect(bridge.hostMetrics.listWorktrees).not.toHaveBeenCalled();
    expect(bridge.hostMetrics.listFleetTargets).not.toHaveBeenCalled();

    // No sampling: this machine's sampler is never subscribed, and no summaries are read.
    expect(subscribeLocalSampler).not.toHaveBeenCalled();
    expect(bridge.hostMetrics.getSnapshots).not.toHaveBeenCalled();
    expect(client.getSnapshots()).toEqual([]);
  });
});
