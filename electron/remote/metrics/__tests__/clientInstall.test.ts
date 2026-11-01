import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostAttentionEvent } from "../../../../shared/types/ipc/hostMetrics.js";

const mocks = vi.hoisted(() => ({
  clientOptions: null as null | { deliverAttention(event: unknown): boolean },
  windows: [] as unknown[],
  focusOrder: [] as unknown[],
  banner: vi.fn(),
}));

vi.mock("../client.js", () => ({
  HostMetricsClient: class {
    constructor(options: { deliverAttention(event: unknown): boolean }) {
      mocks.clientOptions = options;
    }
    start() {}
    dispose() {}
    observedAgents() {
      return [];
    }
  },
}));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: () => ({ all: () => mocks.windows, focusOrder: () => mocks.focusOrder }),
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({ getAllAppWebContents: () => [] }));
vi.mock("../../client/initClient.js", () => ({ setHostAgentsSource: vi.fn() }));
vi.mock("../../hybrid/notifications.js", () => ({ showHostAttentionBanner: mocks.banner }));
vi.mock("../localLoop.js", () => ({ getLocalSummaryLoop: () => ({}) }));
vi.mock("../hostOps.js", () => ({
  listLocalFleetTargets: vi.fn(),
  listLocalWorktrees: vi.fn(),
  onLocalProjectsChanged: vi.fn(),
  onLocalWorktreesMaybeChanged: vi.fn(),
  submitLocalFleet: vi.fn(),
}));

import { CHANNELS } from "../../../ipc/channels.js";
import { installHostMetricsClient, type HostNotice } from "../clientInstall.js";

interface FakeWindow {
  windowId: number;
  browserWindow: { isDestroyed(): boolean; isFocused(): boolean };
  services: { projectViewManager: { getActiveView(): { webContents: FakeView } | null } };
  view: FakeView;
}

interface FakeView {
  id: number;
  isDestroyed(): boolean;
  send: ReturnType<typeof vi.fn>;
}

function fakeWindow(windowId: number, viewId: number, focused = false): FakeWindow {
  const view: FakeView = { id: viewId, isDestroyed: () => false, send: vi.fn() };
  return {
    windowId,
    browserWindow: { isDestroyed: () => false, isFocused: () => focused },
    services: { projectViewManager: { getActiveView: () => ({ webContents: view }) } },
    view,
  };
}

const EVENT: HostAttentionEvent = {
  type: "attention",
  hostId: "build-box",
  hostName: "Build box",
  kind: "waiting",
  terminalId: "t1",
  projectId: "p1",
  projectName: "api",
  agentName: "Claude",
  quiet: false,
};

let viewHosts: Map<number, string>;
let hosts: Set<string>;
let openHostForNotice: Mock<(window: number | null, notice: HostNotice) => Promise<unknown>>;
let dispose: () => void;

function install(): void {
  dispose = installHostMetricsClient({
    manager: {} as never,
    registry: { get: (id: string) => (hosts.has(id) ? { id } : null) } as never,
    hostForView: (id) => viewHosts.get(id) ?? null,
    openHostForNotice,
  });
}

function deliver(event: HostAttentionEvent = EVENT): boolean {
  return mocks.clientOptions!.deliverAttention(event);
}

function clickBanner(): void {
  const onClick = mocks.banner.mock.calls.at(-1)![1] as () => void;
  onClick();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clientOptions = null;
  mocks.windows = [];
  mocks.focusOrder = [];
  viewHosts = new Map();
  hosts = new Set(["build-box"]);
  openHostForNotice = vi.fn(async (_window: number | null, _notice: HostNotice) => ({
    outcome: "switched",
  }));
  install();
});

afterEach(() => dispose());

describe("installHostMetricsClient attention delivery", () => {
  it("leaves a focused window's notice to its toast, with no banner", () => {
    const focused = fakeWindow(1, 11, true);
    const back = fakeWindow(2, 12);
    mocks.windows = [back, focused];
    expect(deliver()).toBe(true);
    expect(mocks.banner).not.toHaveBeenCalled();
    expect(focused.view.send).toHaveBeenCalledTimes(1);
    expect(focused.view.send).toHaveBeenCalledWith(CHANNELS.HOST_METRICS_EVENT, EVENT);
    expect(back.view.send).not.toHaveBeenCalled();
  });

  it("raises a banner with no window focused, and hands a view the notice for its inbox only", () => {
    const back = fakeWindow(1, 11);
    const other = fakeWindow(2, 12);
    mocks.windows = [back, other];
    expect(deliver()).toBe(true);
    expect(mocks.banner).toHaveBeenCalledTimes(1);
    expect(mocks.banner).toHaveBeenCalledWith(EVENT, expect.any(Function));
    expect(back.view.send).toHaveBeenCalledTimes(1);
    expect(back.view.send).toHaveBeenCalledWith(CHANNELS.HOST_METRICS_EVENT, {
      ...EVENT,
      pagedNatively: true,
    });
    expect(other.view.send).not.toHaveBeenCalled();
  });

  it("still raises the banner with no window open to keep it in an inbox", () => {
    expect(deliver()).toBe(true);
    expect(mocks.banner).toHaveBeenCalledTimes(1);
  });

  it("keeps a notice from the host's quiet hours to the inbox", () => {
    const back = fakeWindow(1, 11);
    mocks.windows = [back];
    const quiet = { ...EVENT, quiet: true };
    deliver(quiet);
    expect(mocks.banner).not.toHaveBeenCalled();
    expect(back.view.send).toHaveBeenCalledWith(CHANNELS.HOST_METRICS_EVENT, quiet);
  });

  it("raises no banner while a window shows that host, whose own notifications reach it", () => {
    const onHost = fakeWindow(1, 11);
    const other = fakeWindow(2, 12);
    viewHosts.set(11, "build-box");
    mocks.windows = [onHost, other];
    deliver();
    expect(mocks.banner).not.toHaveBeenCalled();
    expect(onHost.view.send).not.toHaveBeenCalled();
    expect(other.view.send).toHaveBeenCalledWith(CHANNELS.HOST_METRICS_EVENT, EVENT);
  });

  it("raises a banner for a notice with no project id", () => {
    deliver({ ...EVENT, projectId: null, projectName: null });
    expect(mocks.banner).toHaveBeenCalledTimes(1);
  });

  it("delivers nothing once torn down", () => {
    const back = fakeWindow(1, 11);
    mocks.windows = [back];
    dispose();
    expect(deliver()).toBe(false);
    expect(mocks.banner).not.toHaveBeenCalled();
    expect(back.view.send).not.toHaveBeenCalled();
  });
});

describe("installHostMetricsClient banner click", () => {
  it("opens the notice's project on its host in the window last in use when it's clicked", () => {
    const first = fakeWindow(1, 11);
    mocks.focusOrder = [first];
    deliver();
    // Used since the banner went up, and the window it would have picked closed.
    first.browserWindow.isDestroyed = () => true;
    mocks.focusOrder = [first, fakeWindow(2, 12)];
    clickBanner();
    expect(openHostForNotice).toHaveBeenCalledWith(2, {
      hostId: "build-box",
      projectId: "p1",
      terminalId: "t1",
    });
  });

  it("switches to the host for a notice with no project id, in a new window when none is open", () => {
    deliver({ ...EVENT, projectId: null });
    clickBanner();
    expect(openHostForNotice).toHaveBeenCalledWith(null, {
      hostId: "build-box",
      projectId: null,
      terminalId: "t1",
    });
  });

  it("does nothing for a host removed since, or once torn down", () => {
    deliver();
    hosts.clear();
    clickBanner();
    hosts.add("build-box");
    dispose();
    clickBanner();
    expect(openHostForNotice).not.toHaveBeenCalled();
  });

  it("swallows a switch that fails, which says so on the window's own screen", async () => {
    openHostForNotice.mockRejectedValueOnce(new Error("unreachable"));
    deliver();
    clickBanner();
    await Promise.resolve();
    expect(openHostForNotice).toHaveBeenCalledTimes(1);
  });
});
