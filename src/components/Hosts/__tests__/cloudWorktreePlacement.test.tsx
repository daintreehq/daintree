// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import type {
  CloudAccountSummary,
  CloudHostStatus,
  CloudHostsSnapshot,
  CloudProviderInfo,
} from "@shared/types/cloudHosts";
import type {
  HostConnectionState,
  HostDescriptor,
  HostListEntry,
  PendingHostPlacement,
} from "@shared/types/remoteHosts";

const env = vi.hoisted(() => ({
  hosts: [] as HostListEntry[],
  snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot,
  projectId: "proj-1" as string | null,
  observable: true,
  viewHost: null as string | null,
}));
const cloud = vi.hoisted(() => ({
  createHostForWorktree: vi.fn(),
  retryCreate: vi.fn(),
  refreshHost: vi.fn(),
  deleteMachine: vi.fn(),
}));
const update = vi.hoisted(() => vi.fn());
const requestHostUpdate = vi.hoisted(() => vi.fn());
const openHostsSettingsTab = vi.hoisted(() => vi.fn());
const requestHostSettings = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());

vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: cloud }));
vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: { update } }));
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal: vi.fn() } }));
vi.mock("@/components/Settings/Hosts/hostUpdateRequests", () => ({ requestHostUpdate }));
vi.mock("@/components/Settings/Hosts/hostSettingsRequests", () => ({
  openHostsSettingsTab,
  requestHostSettings,
}));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => env.viewHost }));
vi.mock("@/lib/remoteHosts", () => ({ isRemoteShellSupported: () => true }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("../hostList", () => ({
  useHostList: () => ({ hosts: env.hosts, localSummary: null }),
  getHostListSnapshot: () => ({ hosts: env.hosts, localSummary: null }),
}));
vi.mock("../cloud/cloudHostsState", () => ({
  useCloudHosts: () => ({ snapshot: env.snapshot, loaded: true, loadError: null }),
  cloudStatusFor: (snapshot: CloudHostsSnapshot, hostId: string | null | undefined) =>
    snapshot.hosts.find((host) => host.hostId === hostId) ?? null,
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: env.projectId ? { id: env.projectId } : null }),
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: () => env.observable,
  subscribeProjectViewObservability: () => () => {},
}));

import {
  _resetHostSwitchRequestsForTesting,
  completeHostSwitchRequest,
  currentHostSwitchRequest,
  dismissHostSwitchRequest,
  registerHostSwitchDialogHost,
} from "@/components/HostSwitch/hostSwitchRequests";
import { BOAT_PROVIDER, provider as providerWith } from "../cloud/__tests__/cloudProviderFixtures";
import { _resetCloudPlacementSetupForTesting, CloudPlacementSetup } from "../CloudPlacementSetup";
import {
  _resetCloudWorktreePlacementForTesting,
  cloudMachineAccounts,
  cloudMachineName,
  cloudPlacementStage,
  hasArmedCloudSetup,
  startCloudWorktreePlacement,
} from "../cloudWorktreePlacement";
import {
  _resetPendingPlacementsForTesting,
  holdHostSetup,
  isHostSetupOpen,
  NOT_OPENED,
} from "../pendingPlacement";
import { usePendingPlacementResume } from "../usePendingPlacementResume";
import { CloudPlacementNotice } from "@/components/Worktree/WorktreeCard/CloudPlacementNotice";

const WORKTREE = "/Users/me/app-worktrees/feature-login";
const PLACEMENT: PendingHostPlacement = {
  projectId: "proj-1",
  worktreeId: WORKTREE,
  worktreePath: WORKTREE,
  label: "feature/login",
  requestedAt: 1_000,
  createdMachine: true,
};
const MACHINE = { accountId: "ca_0123456789", machineType: "default", lifetimeHours: 2 };

const ACCOUNT: CloudAccountSummary = {
  id: "ca_0123456789",
  providerId: "boat",
  providerUnavailable: null,
  displayName: "Personal",
  identity: "octocat",
  billingScope: { kind: "personal", id: "personal", name: "Personal" },
  validation: { status: "valid", checkedAt: 0 },
  hostCount: 0,
  addedAt: 0,
  keyHint: "abcd",
};

const connected: HostConnectionState = {
  status: "connected",
  rttMs: null,
  handshake: { version: "1", commit: "c", protocolVersion: 1, platform: "linux", arch: "x64" },
};
const disconnected: HostConnectionState = { status: "disconnected" };

function hostEntry(
  id: string,
  connection: HostConnectionState,
  pendingPlacement?: PendingHostPlacement
): HostListEntry {
  const descriptor: HostDescriptor = {
    id,
    name: id,
    connection: { kind: "cloud", bindingId: "cb_0123456789ab" },
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

function status(overrides: Partial<CloudHostStatus> = {}): CloudHostStatus {
  return {
    hostId: "feature-login",
    providerId: "boat",
    providerUnavailable: null,
    accountId: ACCOUNT.id,
    accountName: "Personal",
    resourceId: null,
    machineName: "feature-login",
    ownership: "created-by-daintree",
    createdFor: {
      hostId: null,
      projectId: "proj-1",
      worktreeId: WORKTREE,
      projectName: "app",
      worktreeName: "feature/login",
      hostName: null,
    },
    worktreeCleanup: null,
    provisioning: null,
    machine: "not-created",
    rawState: null,
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    hourlyDollars: 0.036,
    lifetime: { kind: "renewable" },
    autoStopAt: null,
    lifetimeSeconds: 7200,
    stoppedAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    operation: null,
    lastError: null,
    observedAt: Date.now(),
    lastEndpoint: null,
    hostKeyFingerprint: null,
    hostKeyReview: null,
    keptRunningAt: null,
    asleep: false,
    ...overrides,
  };
}

const creating = (stage = "Asking Boat for a machine") =>
  status({ operation: { id: "op", kind: "creating", startedAt: 0, stage } });
const running = () => status({ resourceId: "bx_23456789", machine: "running" });

function snapshotWith(
  host: CloudHostStatus | null,
  provider: CloudProviderInfo = BOAT_PROVIDER
): CloudHostsSnapshot {
  return { providers: [provider], accounts: [ACCOUNT], hosts: host ? [host] : [] };
}

/** One project view: its switch dialog host, the placement resume, and the armed setup watcher. */
function View() {
  useEffect(() => registerHostSwitchDialogHost(), []);
  usePendingPlacementResume();
  return hasArmedCloudSetup() ? <CloudPlacementSetup /> : null;
}

async function showView(view: ReturnType<typeof render> | null = null) {
  const shown = view ?? render(<View />);
  if (view) view.rerender(<View />);
  await act(async () => {});
  return shown;
}

beforeEach(() => {
  for (const mock of Object.values(cloud)) mock.mockReset();
  update.mockReset().mockResolvedValue({});
  requestHostUpdate.mockReset();
  openHostsSettingsTab.mockReset();
  requestHostSettings.mockReset();
  notify.mockReset();
  env.hosts = [];
  env.snapshot = snapshotWith(null);
  env.projectId = "proj-1";
  env.observable = true;
  env.viewHost = null;
});

afterEach(() => {
  cleanup();
  _resetCloudPlacementSetupForTesting();
  _resetCloudWorktreePlacementForTesting();
  _resetPendingPlacementsForTesting();
  _resetHostSwitchRequestsForTesting();
});

describe("naming and choosing a new machine", () => {
  it("names the machine after the branch, numbered past hosts already called that", () => {
    expect(cloudMachineName("feature/login", [])).toBe("feature-login");
    expect(cloudMachineName("feature/login", [hostEntry("Feature-Login", disconnected)])).toBe(
      "feature-login-2"
    );
    expect(cloudMachineName("//", [])).toBe("worktree");
    expect(cloudMachineName("x".repeat(80), []).length).toBe(64);
  });

  it("offers only accounts on a provider this machine can use", () => {
    const unusable = { ...providerWith({ name: "Gone" }), id: "gone", unsupportedReason: "No" };
    const accounts = cloudMachineAccounts({
      providers: [BOAT_PROVIDER, unusable],
      accounts: [ACCOUNT, { ...ACCOUNT, id: "ca_gone", providerId: "gone" }],
      hosts: [],
    });
    expect(accounts.map((entry) => entry.account.id)).toEqual([ACCOUNT.id]);
  });

  it("offers no account its provider may not be handed the credentials of now", () => {
    const accounts = cloudMachineAccounts({
      providers: [BOAT_PROVIDER],
      accounts: [
        ACCOUNT,
        {
          ...ACCOUNT,
          id: "ca_paused",
          providerUnavailable: "Its cloud provider comes from a plugin that isn't allowed.",
        },
      ],
      hosts: [],
    });
    expect(accounts.map((entry) => entry.account.id)).toEqual([ACCOUNT.id]);
  });

  it("offers no account whose provider's create goes through offers", () => {
    const offers = { ...providerWith({ name: "Akash" }), id: "akash", createMode: "offers" as const };
    const accounts = cloudMachineAccounts({
      providers: [BOAT_PROVIDER, offers],
      accounts: [{ ...ACCOUNT, id: "ca_offers", providerId: "akash" }, ACCOUNT],
      hosts: [],
    });
    expect(accounts.map((entry) => entry.account.id)).toEqual([ACCOUNT.id]);
  });

  it("reads where a waiting worktree stands from its machine and its placement", () => {
    expect(cloudPlacementStage(null, PLACEMENT).kind).toBe("waiting");
    expect(cloudPlacementStage(creating("Starting the machine"), PLACEMENT)).toEqual({
      kind: "busy",
      operation: "creating",
      step: "Starting the machine",
    });
    expect(
      cloudPlacementStage(
        status({ lastError: { code: "capacity", message: "No capacity in lhr", at: 1 } }),
        PLACEMENT
      )
    ).toEqual({ kind: "create-failed", message: "No capacity in lhr" });
    expect(
      cloudPlacementStage(status({ resourceId: "bx_1", machine: "stopped" }), PLACEMENT)
    ).toEqual({ kind: "machine", message: "Its machine is stopped." });
    expect(cloudPlacementStage(running(), PLACEMENT).kind).toBe("setup");
    expect(
      cloudPlacementStage(running(), { failure: { message: "Install failed", at: 2 } })
    ).toEqual({ kind: "failed", message: "Install failed" });
  });
});

describe("a new worktree on a new machine", () => {
  it("creates the machine, opens its setup once it runs, and opens the worktree there", async () => {
    cloud.createHostForWorktree.mockResolvedValue({ hostId: "feature-login", requestedAt: 1_000 });
    const hostId = await startCloudWorktreePlacement({
      projectId: "proj-1",
      worktreeId: WORKTREE,
      branch: "feature/login",
      machine: MACHINE,
    });
    expect(hostId).toBe("feature-login");
    expect(cloud.createHostForWorktree).toHaveBeenCalledWith({
      machine: { ...MACHINE, name: "feature-login" },
      worktree: { projectId: "proj-1", worktreeId: WORKTREE, worktreeName: "feature/login" },
    });

    // Coming up: nothing opens yet.
    env.hosts = [hostEntry("feature-login", disconnected, PLACEMENT)];
    env.snapshot = snapshotWith(creating());
    const view = await showView();
    expect(requestHostUpdate).not.toHaveBeenCalled();

    // Running: its setup opens, once.
    env.snapshot = snapshotWith(running());
    await showView(view);
    expect(requestHostUpdate).toHaveBeenCalledWith("feature-login", "setup");
    expect(openHostsSettingsTab).toHaveBeenCalledTimes(1);
    expect(hasArmedCloudSetup()).toBe(false);
    await showView(view);
    expect(requestHostUpdate).toHaveBeenCalledTimes(1);

    // Setup finishes and connects: the switch dialog takes the worktree, which this view asked for.
    const setupDone = holdHostSetup("feature-login");
    env.hosts = [hostEntry("feature-login", connected, PLACEMENT)];
    await showView(view);
    expect(currentHostSwitchRequest()).toBeNull();
    await act(async () => setupDone());
    const switchRequest = currentHostSwitchRequest();
    expect(switchRequest).toMatchObject({
      toHostId: "feature-login",
      projectId: "proj-1",
      worktreePath: WORKTREE,
      askFirst: false,
    });
    expect(update).not.toHaveBeenCalled();
    await act(async () => completeHostSwitchRequest(switchRequest!.id));
    // Held until the window has landed there with the worktree open.
    expect(update).not.toHaveBeenCalled();
    await act(async () => switchRequest!.onLanding!({ landed: true, worktreeOpened: true }));
    expect(update).toHaveBeenCalledWith({ hostId: "feature-login", pendingPlacement: null });
  });

  it("asks for no second machine for a worktree already waiting on one", async () => {
    // Another host waiting for the same worktree, for its resource's box, comes first.
    const { createdMachine: _made, ...boxPlacement } = PLACEMENT;
    env.hosts = [
      hostEntry("box", disconnected, boxPlacement),
      hostEntry("feature-login", disconnected, PLACEMENT),
    ];
    const hostId = await startCloudWorktreePlacement({
      projectId: "proj-1",
      worktreeId: WORKTREE,
      branch: "feature/login",
      machine: MACHINE,
    });
    expect(hostId).toBe("feature-login");
    expect(cloud.createHostForWorktree).not.toHaveBeenCalled();
  });

  it("asks once while a request for the same worktree is still out", async () => {
    let answer!: (value: { hostId: string; requestedAt: number }) => void;
    cloud.createHostForWorktree.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const input = {
      projectId: "proj-1",
      worktreeId: WORKTREE,
      branch: "feature/login",
      machine: MACHINE,
    };
    const first = startCloudWorktreePlacement(input);
    expect(await startCloudWorktreePlacement(input)).toBeNull();
    answer({ hostId: "feature-login", requestedAt: 1_000 });
    expect(await first).toBe("feature-login");
    expect(cloud.createHostForWorktree).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting to open setup until the host list has caught up with the new host", async () => {
    cloud.createHostForWorktree.mockResolvedValue({ hostId: "feature-login", requestedAt: 1_000 });
    await startCloudWorktreePlacement({
      projectId: "proj-1",
      worktreeId: WORKTREE,
      branch: "feature/login",
      machine: MACHINE,
    });
    // The answer came back before the list did.
    env.hosts = [];
    env.snapshot = snapshotWith(running());
    const view = await showView();
    expect(hasArmedCloudSetup()).toBe(true);
    env.hosts = [hostEntry("feature-login", disconnected, PLACEMENT)];
    await showView(view);
    expect(requestHostUpdate).toHaveBeenCalledWith("feature-login", "setup");
  });

  it("opens one machine's setup at a time when two come up together", async () => {
    const second: PendingHostPlacement = {
      ...PLACEMENT,
      worktreeId: "/w2",
      worktreePath: "/w2",
      requestedAt: 2_000,
    };
    cloud.createHostForWorktree
      .mockResolvedValueOnce({ hostId: "feature-login", requestedAt: 1_000 })
      .mockResolvedValueOnce({ hostId: "feature-two", requestedAt: 2_000 });
    for (const [worktreeId, branch] of [
      [WORKTREE, "feature/login"],
      ["/w2", "feature/two"],
    ] as const) {
      await startCloudWorktreePlacement({
        projectId: "proj-1",
        worktreeId,
        branch,
        machine: MACHINE,
      });
    }
    env.hosts = [
      hostEntry("feature-login", disconnected, PLACEMENT),
      hostEntry("feature-two", disconnected, second),
    ];
    env.snapshot = {
      ...snapshotWith(running()),
      hosts: [running(), { ...running(), hostId: "feature-two" }],
    };
    const view = await showView();
    expect(requestHostUpdate.mock.calls).toEqual([["feature-login", "setup"]]);
    // Its dialog opens, and closes once that setup is done: then the next.
    const firstSetup = holdHostSetup("feature-login");
    await showView(view);
    expect(requestHostUpdate).toHaveBeenCalledTimes(1);
    await act(async () => firstSetup());
    await showView(view);
    expect(requestHostUpdate.mock.calls).toEqual([
      ["feature-login", "setup"],
      ["feature-two", "setup"],
    ]);
  });

  it("asks for the next machine's setup once a setup asked for never opened", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const second: PendingHostPlacement = {
        ...PLACEMENT,
        worktreeId: "/w2",
        worktreePath: "/w2",
        requestedAt: 2_000,
      };
      cloud.createHostForWorktree
        .mockResolvedValueOnce({ hostId: "feature-login", requestedAt: 1_000 })
        .mockResolvedValueOnce({ hostId: "feature-two", requestedAt: 2_000 });
      for (const [worktreeId, branch] of [
        [WORKTREE, "feature/login"],
        ["/w2", "feature/two"],
      ] as const) {
        await startCloudWorktreePlacement({
          projectId: "proj-1",
          worktreeId,
          branch,
          machine: MACHINE,
        });
      }
      env.hosts = [
        hostEntry("feature-login", disconnected, PLACEMENT),
        hostEntry("feature-two", disconnected, second),
      ];
      env.snapshot = {
        ...snapshotWith(running()),
        hosts: [running(), { ...running(), hostId: "feature-two" }],
      };
      await showView();
      expect(requestHostUpdate).toHaveBeenCalledTimes(1);
      // Nothing else changes: the handoff running out is enough.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(requestHostUpdate.mock.calls.at(-1)).toEqual(["feature-two", "setup"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits while another host's setup is open rather than replacing it", async () => {
    cloud.createHostForWorktree.mockResolvedValue({ hostId: "feature-login", requestedAt: 1_000 });
    await startCloudWorktreePlacement({
      projectId: "proj-1",
      worktreeId: WORKTREE,
      branch: "feature/login",
      machine: MACHINE,
    });
    const otherSetup = holdHostSetup("studio");
    env.hosts = [hostEntry("feature-login", disconnected, PLACEMENT)];
    env.snapshot = snapshotWith(running());
    const view = await showView();
    expect(requestHostUpdate).not.toHaveBeenCalled();
    await act(async () => otherSetup());
    await showView(view);
    expect(requestHostUpdate).toHaveBeenCalledWith("feature-login", "setup");
  });

  it("waits to open setup until the worktree's view can be seen", async () => {
    cloud.createHostForWorktree.mockResolvedValue({ hostId: "feature-login", requestedAt: 1_000 });
    await startCloudWorktreePlacement({
      projectId: "proj-1",
      worktreeId: WORKTREE,
      branch: "feature/login",
      machine: MACHINE,
    });
    env.hosts = [hostEntry("feature-login", disconnected, PLACEMENT)];
    env.snapshot = snapshotWith(running());
    env.observable = false;
    const view = await showView();
    expect(requestHostUpdate).not.toHaveBeenCalled();
    env.observable = true;
    await showView(view);
    expect(requestHostUpdate).toHaveBeenCalledWith("feature-login", "setup");
  });

  it("opens no setup for a placement cancelled before its machine ran", async () => {
    cloud.createHostForWorktree.mockResolvedValue({ hostId: "feature-login", requestedAt: 1_000 });
    await startCloudWorktreePlacement({
      projectId: "proj-1",
      worktreeId: WORKTREE,
      branch: "feature/login",
      machine: MACHINE,
    });
    env.hosts = [hostEntry("feature-login", disconnected)];
    env.snapshot = snapshotWith(running());
    await showView();
    expect(requestHostUpdate).not.toHaveBeenCalled();
    expect(hasArmedCloudSetup()).toBe(false);
  });

  it("says why when no machine could be asked for, keeping the worktree, with Retry", async () => {
    cloud.createHostForWorktree.mockRejectedValueOnce(new Error("The account's key was revoked."));
    const input = {
      projectId: "proj-1",
      worktreeId: WORKTREE,
      branch: "feature/login",
      machine: MACHINE,
    };
    expect(await startCloudWorktreePlacement(input)).toBeNull();
    expect(hasArmedCloudSetup()).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    const toast = notify.mock.calls[0]![0] as {
      type: string;
      title: string;
      message: string;
      action: { label: string; onClick: () => void };
    };
    expect(toast).toMatchObject({ type: "error", title: "Couldn't create the machine" });
    expect(toast.message).toContain("The account's key was revoked.");
    expect(toast.message).toContain("feature/login was created on this machine.");

    cloud.createHostForWorktree.mockResolvedValueOnce({ hostId: "feature-login", requestedAt: 2 });
    toast.action.onClick();
    await waitFor(() => expect(hasArmedCloudSetup()).toBe(true));
    expect(cloud.createHostForWorktree).toHaveBeenCalledTimes(2);
  });
});

describe("the worktree card while it waits on its machine", () => {
  function showNotice(
    host: HostListEntry,
    placement: PendingHostPlacement = PLACEMENT
  ): ReturnType<typeof render> {
    return render(
      <CloudPlacementNotice
        hostId={host.descriptor.id}
        hostName={host.descriptor.name}
        connection={host.connection}
        placement={placement}
        inGutter={false}
      />
    );
  }
  const notice = () => screen.getByTestId("worktree-pending-placement");
  const button = (name: string | RegExp) => screen.getByRole("button", { name });

  it("follows the create and cancels it keeping the machine, still listed and marked", async () => {
    env.snapshot = snapshotWith(creating("Asking Boat for a machine"));
    showNotice(hostEntry("feature-login", disconnected));
    expect(notice().getAttribute("data-stage")).toBe("busy");
    expect(notice().textContent).toContain("Creating feature-login");
    expect(notice().textContent).toContain("Asking Boat for a machine");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(button("Cancel"));
    expect(screen.getByText("Stop opening 'feature/login' on feature-login?")).toBeTruthy();
    // Nothing carries on underneath while the choice is open.
    expect(isHostSetupOpen("feature-login")).toBe(true);
    fireEvent.click(button("Keep machine"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ hostId: "feature-login", pendingPlacement: null })
    );
    expect(cloud.deleteMachine).not.toHaveBeenCalled();
  });

  it("cancels mid-create deleting the machine, once its name is typed", async () => {
    cloud.deleteMachine.mockResolvedValue(undefined);
    env.snapshot = snapshotWith(creating());
    showNotice(hostEntry("feature-login", disconnected));
    fireEvent.click(button("Cancel"));
    fireEvent.click(screen.getByRole("radio", { name: /Delete the machine/ }));
    expect(screen.getByText("Delete 'feature-login'?")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature-login" } });
    fireEvent.click(button("Delete machine"));
    // Nothing was created when the dialog opened, so none is named: main looks for one.
    await waitFor(() => expect(cloud.deleteMachine).toHaveBeenCalledWith("feature-login", null));
    expect(update).not.toHaveBeenCalled();
  });

  it("offers Retry and Delete when the create failed, and Retry opens setup here once it runs", async () => {
    cloud.retryCreate.mockResolvedValue(undefined);
    cloud.deleteMachine.mockResolvedValue(undefined);
    env.snapshot = snapshotWith(
      status({ lastError: { code: "capacity", message: "No capacity in lhr", at: 1 } })
    );
    showNotice(hostEntry("feature-login", disconnected));
    expect(notice().getAttribute("data-stage")).toBe("create-failed");
    expect(notice().textContent).toContain("Couldn't create feature-login");
    expect(notice().textContent).toContain("No capacity in lhr");

    fireEvent.click(button("Retry"));
    await waitFor(() => expect(cloud.retryCreate).toHaveBeenCalledWith("feature-login"));
    expect(hasArmedCloudSetup()).toBe(true);

    fireEvent.click(button("Delete machine…"));
    expect(screen.getByText("Delete 'feature-login'?")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature-login" } });
    fireEvent.click(button("Delete machine"));
    await waitFor(() => expect(cloud.deleteMachine).toHaveBeenCalledWith("feature-login", null));
  });

  it("offers setup while the machine runs, and cancelling then deletes the machine it names", async () => {
    cloud.deleteMachine.mockResolvedValue(undefined);
    env.snapshot = snapshotWith(running());
    showNotice(hostEntry("feature-login", disconnected));
    expect(notice().getAttribute("data-stage")).toBe("setup");
    fireEvent.click(button("Set up…"));
    await waitFor(() => expect(requestHostUpdate).toHaveBeenCalledWith("feature-login", "setup"));

    fireEvent.click(button("Cancel"));
    fireEvent.click(screen.getByRole("radio", { name: /Delete the machine/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature-login" } });
    fireEvent.click(button("Delete machine"));
    await waitFor(() =>
      expect(cloud.deleteMachine).toHaveBeenCalledWith("feature-login", "bx_23456789")
    );
  });

  it("after a failed setup, Retry asks again and opens setup, and Delete stays offered", async () => {
    env.snapshot = snapshotWith(running());
    showNotice(hostEntry("feature-login", disconnected), {
      ...PLACEMENT,
      failure: { message: "Installing Daintree failed: disk full", at: 2 },
    });
    expect(notice().textContent).toContain("Couldn't set up feature-login");
    expect(notice().textContent).toContain("Installing Daintree failed: disk full");
    expect(button("Delete machine…")).toBeTruthy();
    fireEvent.click(button("Retry"));
    await waitFor(() => expect(requestHostUpdate).toHaveBeenCalledWith("feature-login", "setup"));
    const held = update.mock.calls[0]![0] as { pendingPlacement: PendingHostPlacement };
    expect(held.pendingPlacement.requestedAt).not.toBe(PLACEMENT.requestedAt);
    expect(held.pendingPlacement).not.toHaveProperty("failure");
  });

  it("after the switch dialog closed, Retry asks again and Cancel keeps the machine", async () => {
    env.snapshot = snapshotWith(running());
    showNotice(hostEntry("feature-login", connected), {
      ...PLACEMENT,
      failure: { message: NOT_OPENED, at: 3 },
    });
    expect(notice().textContent).toContain("Didn't open on feature-login");
    fireEvent.click(button("Retry"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const held = update.mock.calls[0]![0] as { pendingPlacement: PendingHostPlacement };
    const { requestedAt, ...rest } = held.pendingPlacement;
    expect(rest).toEqual({
      projectId: PLACEMENT.projectId,
      worktreeId: PLACEMENT.worktreeId,
      worktreePath: PLACEMENT.worktreePath,
      label: PLACEMENT.label,
      createdMachine: true,
    });
    expect(requestedAt).not.toBe(PLACEMENT.requestedAt);
    expect(requestHostUpdate).not.toHaveBeenCalled();

    update.mockClear();
    fireEvent.click(button("Cancel"));
    fireEvent.click(button("Keep machine"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ hostId: "feature-login", pendingPlacement: null })
    );
  });

  it("keeps the machine on Cancel before the cloud picture has arrived", async () => {
    env.snapshot = snapshotWith(null);
    showNotice(hostEntry("feature-login", disconnected));
    expect(notice().getAttribute("data-stage")).toBe("waiting");
    fireEvent.click(button("Cancel"));
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(button("Keep machine"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ hostId: "feature-login", pendingPlacement: null })
    );
  });

  it("still opens setup by itself when deleting the machine was refused", async () => {
    cloud.createHostForWorktree.mockResolvedValue({ hostId: "feature-login", requestedAt: 1_000 });
    await startCloudWorktreePlacement({
      projectId: "proj-1",
      worktreeId: WORKTREE,
      branch: "feature/login",
      machine: MACHINE,
    });
    cloud.deleteMachine.mockRejectedValueOnce(new Error("Boat refused the delete"));
    env.snapshot = snapshotWith(creating());
    showNotice(hostEntry("feature-login", disconnected));
    fireEvent.click(button("Cancel"));
    fireEvent.click(screen.getByRole("radio", { name: /Delete the machine/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature-login" } });
    fireEvent.click(button("Delete machine"));
    expect(await screen.findByText("Boat refused the delete")).toBeTruthy();
    expect(hasArmedCloudSetup()).toBe(true);
  });

  it("opens on a host that's already usable straight away, as a fresh ask", async () => {
    env.snapshot = snapshotWith(running());
    showNotice(hostEntry("feature-login", connected));
    expect(notice().textContent).toContain("Ready to open on feature-login");
    fireEvent.click(button("Open on feature-login"));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const held = update.mock.calls[0]![0] as { pendingPlacement: PendingHostPlacement };
    expect(held.pendingPlacement.requestedAt).not.toBe(PLACEMENT.requestedAt);
    expect(requestHostUpdate).not.toHaveBeenCalled();
  });

  it("deletes nothing until the host's name is typed exactly", async () => {
    env.snapshot = snapshotWith(running());
    showNotice(hostEntry("feature-login", disconnected));
    fireEvent.click(button("Cancel"));
    fireEvent.click(screen.getByRole("radio", { name: /Delete the machine/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature-log" } });
    fireEvent.click(button("Delete machine"));
    await act(async () => {});
    expect(cloud.deleteMachine).not.toHaveBeenCalled();
  });

  it("offers no Delete for a machine whose own record says it wasn't made for this worktree", () => {
    env.snapshot = snapshotWith(
      status({
        resourceId: "bx_1",
        machine: "running",
        createdFor: null,
        ownership: "imported",
      })
    );
    showNotice(hostEntry("feature-login", disconnected), {
      ...PLACEMENT,
      failure: { message: "Installing Daintree failed", at: 2 },
    });
    expect(screen.queryByRole("button", { name: "Delete machine…" })).toBeNull();
    fireEvent.click(button("Cancel"));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByTestId("cancel-cloud-placement-console").textContent).not.toContain(
      "marked as made for"
    );
  });

  it("asks about a machine in an unknown state again on Retry", async () => {
    cloud.refreshHost.mockResolvedValue(undefined);
    env.snapshot = snapshotWith(status({ resourceId: "bx_1", machine: "unknown" }));
    showNotice(hostEntry("feature-login", disconnected));
    expect(notice().getAttribute("data-stage")).toBe("machine");
    fireEvent.click(button("Retry"));
    await waitFor(() => expect(cloud.refreshHost).toHaveBeenCalledWith("feature-login"));
  });

  it("offers no Delete on a provider that can't delete, pointing to its console instead", () => {
    const consoleOnly = providerWith({ deletion: false });
    env.snapshot = snapshotWith(
      status({ providerId: consoleOnly.id, resourceId: "bx_1", machine: "error" }),
      consoleOnly
    );
    showNotice(hostEntry("feature-login", disconnected));
    expect(notice().getAttribute("data-stage")).toBe("machine");
    expect(screen.queryByRole("button", { name: "Delete machine…" })).toBeNull();
    fireEvent.click(button("Cancel"));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByTestId("cancel-cloud-placement-console").textContent).toContain(
      "Daintree can't delete machines on Acme."
    );
  });
});

describe("the switch stage", () => {
  it("leaves the placement failed when the switch dialog is closed without opening it", async () => {
    env.hosts = [hostEntry("feature-login", connected, PLACEMENT)];
    env.snapshot = snapshotWith(running());
    await showView();
    const switchRequest = currentHostSwitchRequest();
    expect(switchRequest).toMatchObject({ toHostId: "feature-login" });
    await act(async () => dismissHostSwitchRequest(switchRequest!.id));
    expect(update).toHaveBeenCalledWith({
      hostId: "feature-login",
      pendingPlacement: expect.objectContaining({
        failure: expect.objectContaining({ message: NOT_OPENED }),
      }),
    });
  });
});
