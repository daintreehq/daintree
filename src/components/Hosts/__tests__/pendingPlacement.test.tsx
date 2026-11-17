// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import type {
  HostConnectionState,
  HostDescriptor,
  HostListEntry,
  PendingHostPlacement,
} from "@shared/types/remoteHosts";

const env = vi.hoisted(() => ({
  hosts: [] as HostListEntry[],
  projectId: "proj-1" as string | null,
  observable: true,
  viewHost: null as string | null,
  observers: new Set<(observable: boolean) => void>(),
}));
const update = vi.hoisted(() => vi.fn());
const requestHostUpdate = vi.hoisted(() => vi.fn());
const openHostsSettingsTab = vi.hoisted(() => vi.fn());

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: { update } }));
vi.mock("@/components/Settings/Hosts/hostUpdateRequests", () => ({ requestHostUpdate }));
vi.mock("@/components/Settings/Hosts/hostSettingsRequests", () => ({ openHostsSettingsTab }));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => env.viewHost }));
vi.mock("../hostList", () => ({ useHostList: () => ({ hosts: env.hosts, localSummary: null }) }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: env.projectId ? { id: env.projectId } : null }),
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: () => env.observable,
  subscribeProjectViewObservability: (listener: (observable: boolean) => void) => {
    env.observers.add(listener);
    return () => env.observers.delete(listener);
  },
}));

import {
  _resetHostSwitchRequestsForTesting,
  currentHostSwitchRequest,
  dismissHostSwitchRequest,
  registerHostSwitchDialogHost,
} from "@/components/HostSwitch/hostSwitchRequests";
import {
  CLOSE_SETTINGS_EVENT,
  _resetPendingPlacementsForTesting,
  cancelPlacement,
  holdHostSetup,
  holdPlacement,
  notePlacementFailure,
  placementForWorktree,
  resumePlacement,
  retryPlacementSetup,
} from "../pendingPlacement";
import { usePendingPlacementResume } from "../usePendingPlacementResume";

const request = {
  projectId: "proj-1",
  worktreeId: "/repo/wt/feature-x",
  worktreePath: "/repo/wt/feature-x",
  label: "feature-x",
};

function hostEntry(
  id: string,
  connection: HostConnectionState,
  pendingPlacement?: PendingHostPlacement
): HostListEntry {
  const descriptor: HostDescriptor = {
    id,
    name: id,
    connection: { kind: "ssh", target: id },
    platform: null,
    arch: null,
    lastHandshake: null,
    lastSeenAt: null,
    addedAt: 0,
    notificationsEnabled: false,
    assistantControlEnabled: true,
    ...(pendingPlacement ? { pendingPlacement } : {}),
  };
  return { descriptor, connection, summary: null };
}

const connected = {
  status: "connected",
  rttMs: null,
  handshake: {},
} as unknown as HostConnectionState;
const disconnected: HostConnectionState = { status: "disconnected" };

/** The view's switch dialog host: registered first, then the resume, as in HostSwitchDialogHost. */
function DialogHost() {
  useEffect(() => registerHostSwitchDialogHost(), []);
  usePendingPlacementResume();
  return null;
}

function show(hosts: HostListEntry[], view: ReturnType<typeof render> | null = null) {
  env.hosts = hosts;
  if (view) {
    view.rerender(<DialogHost />);
    return view;
  }
  return render(<DialogHost />);
}

beforeEach(() => {
  update.mockReset().mockResolvedValue({});
  requestHostUpdate.mockReset();
  openHostsSettingsTab.mockReset();
  env.hosts = [];
  env.projectId = "proj-1";
  env.observable = true;
  env.viewHost = null;
  env.observers.clear();
});

afterEach(() => {
  cleanup();
  _resetPendingPlacementsForTesting();
  _resetHostSwitchRequestsForTesting();
});

describe("pending placements", () => {
  it("keeps the placement on the host, and Retry opens that host's setup", async () => {
    const placement = await holdPlacement("box", request, 1_000);
    expect(placement).toEqual({ ...request, requestedAt: 1_000 });
    expect(update).toHaveBeenCalledWith({ hostId: "box", pendingPlacement: placement });

    retryPlacementSetup("box");
    expect(requestHostUpdate).toHaveBeenCalledWith("box", "setup");
    expect(openHostsSettingsTab).toHaveBeenCalled();
  });

  it("records a failure on the placement it names, replacing the last one", async () => {
    const placement = { ...request, requestedAt: 1_000, failure: { message: "old", at: 1 } };
    await notePlacementFailure("box", placement, "Host mode didn't start", 2_000);
    expect(update).toHaveBeenCalledWith({
      hostId: "box",
      pendingPlacement: {
        ...request,
        requestedAt: 1_000,
        failure: { message: "Host mode didn't start", at: 2_000 },
      },
    });
  });

  it("cancels by removing the placement from the host", async () => {
    await cancelPlacement("box");
    expect(update).toHaveBeenCalledWith({ hostId: "box", pendingPlacement: null });
  });

  it("finds the host a worktree waits on, in its own project only", () => {
    const placement = { ...request, requestedAt: 1 };
    const hosts = [hostEntry("studio", disconnected), hostEntry("box", disconnected, placement)];
    expect(placementForWorktree(hosts, "proj-1", request.worktreeId)?.host.descriptor.id).toBe(
      "box"
    );
    expect(placementForWorktree(hosts, "proj-2", request.worktreeId)).toBeNull();
    expect(placementForWorktree(hosts, "proj-1", "/repo/wt/other")).toBeNull();
  });

  it("leaves a placement held when no switch dialog host is mounted to take it", () => {
    expect(resumePlacement("box", { ...request, requestedAt: 1 })).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("usePendingPlacementResume", () => {
  it("places the worktree once its host's setup finishes, without asking again", async () => {
    const placement = await holdPlacement("box", request, 1_000);
    update.mockClear();
    const closed = vi.fn();
    window.addEventListener(CLOSE_SETTINGS_EVENT, closed);
    const setupDone = holdHostSetup("box");

    // Setup is running: Daintree isn't up there yet.
    const view = show([hostEntry("box", disconnected, placement)]);
    expect(currentHostSwitchRequest()).toBeNull();

    // An update reconnects the host while its setup dialog is still open.
    show([hostEntry("box", connected, placement)], view);
    expect(currentHostSwitchRequest()).toBeNull();

    act(() => setupDone());

    expect(currentHostSwitchRequest()).toMatchObject({
      toHostId: "box",
      projectId: "proj-1",
      worktreePath: request.worktreePath,
      askFirst: false,
    });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ hostId: "box", pendingPlacement: null });
    window.removeEventListener(CLOSE_SETTINGS_EVENT, closed);
  });

  it("asks first for a placement found after a restart, or one an agent asked for", async () => {
    // Never asked for in this view: it was waiting when Daintree started.
    const restored = { ...request, requestedAt: 1_000 };
    const view = show([hostEntry("box", connected, restored)]);
    expect(currentHostSwitchRequest()).toMatchObject({ toHostId: "box", askFirst: true });
    view.unmount();

    const asked = await holdPlacement("mini", { ...request, askFirst: true }, 2_000);
    show([hostEntry("mini", connected, asked)]);
    expect(currentHostSwitchRequest()).toMatchObject({ toHostId: "mini", askFirst: true });
  });

  it("hands a placement over once, even while the list still shows it", async () => {
    const placement = await holdPlacement("box", request, 1_000);
    const view = show([hostEntry("box", connected, placement)]);
    const first = currentHostSwitchRequest();
    expect(first).not.toBeNull();

    act(() => dismissHostSwitchRequest(first!.id));
    show([hostEntry("box", connected, { ...placement })], view);
    expect(currentHostSwitchRequest()).toBeNull();
  });

  it("never resumes a cancelled placement when its host comes up", async () => {
    const placement = await holdPlacement("box", request, 1_000);
    const view = show([hostEntry("box", disconnected, placement)]);
    await cancelPlacement("box");
    show([hostEntry("box", connected)], view);
    expect(currentHostSwitchRequest()).toBeNull();
  });

  it("waits until the view can be seen, and leaves other projects' placements alone", async () => {
    const placement = await holdPlacement("box", request, 1_000);
    const other = { ...request, projectId: "proj-2", requestedAt: 2_000 };
    env.observable = false;
    show([hostEntry("studio", connected, other), hostEntry("box", connected, placement)]);
    expect(currentHostSwitchRequest()).toBeNull();

    act(() => {
      env.observable = true;
      for (const listener of env.observers) listener(true);
    });
    expect(currentHostSwitchRequest()).toMatchObject({ toHostId: "box" });
  });

  it("does nothing in a window on another host", async () => {
    env.viewHost = "studio";
    const placement = await holdPlacement("box", request, 1_000);
    show([hostEntry("box", connected, placement)]);
    expect(currentHostSwitchRequest()).toBeNull();
  });
});
