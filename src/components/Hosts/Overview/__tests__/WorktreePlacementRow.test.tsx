// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { CloudCatalog, CloudHostsSnapshot } from "@shared/types/cloudHosts";
import { HANDSHAKE, makeCapacitySummary } from "./fixtures";

const { hostList, dispatch, cloud, getCatalog } = vi.hoisted(() => ({
  cloud: {
    snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot,
  },
  getCatalog: vi.fn(),
  hostList: { hosts: [] as HostListEntry[], localSummary: null as unknown },
  dispatch: vi.fn(
    async (..._args: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: unknown }> => ({
      ok: true,
    })
  ),
}));

vi.mock("../../hostList", () => ({
  useHostList: () => hostList,
  useHostFigures: () => hostList,
  hasRemoteHosts: (state: { hosts: unknown[] }) => state.hosts.length > 0,
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("../../cloud/cloudHostsState", () => ({
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: { getCatalog } }));

import { useHostMetricsStore } from "@/store/hostMetricsStore";
import { clientPlatform, localHostLabel } from "../../hostModel";
import {
  _resetHostSwitchRequestsForTesting,
  completeHostSwitchRequest,
  currentHostSwitchRequest,
  dismissHostSwitchRequest,
  registerHostSwitchDialogHost,
  requestHostSwitch,
} from "@/components/HostSwitch/hostSwitchRequests";
import {
  WorktreePlacementRow,
  placedRelativePath,
  type CloudMachineCommit,
  type PlacementCommit,
  type PlacementDraft,
} from "../WorktreePlacementRow";
import {
  BOAT_PROVIDER,
  provider as providerWith,
  DELETE_ONLY_PROVIDER,
} from "../../cloud/__tests__/cloudProviderFixtures";

const ROOT = "/Users/greg/Projects/daintree";
const DRAFT: PlacementDraft = {
  newBranch: "feature/placed",
  baseBranch: "develop",
  fromRemote: false,
  useExistingBranch: false,
  path: "/Users/greg/Projects/daintree-worktrees/feature-placed",
  recipeId: "setup",
};
const getDraft = () => DRAFT;

/** What the real action does with the args: open the switch dialog, answer with its id. */
async function openOnHostLikeTheAction(
  _id: unknown,
  args: unknown
): Promise<{ ok: boolean; result?: unknown }> {
  const { hostId, projectId, worktree, newWindow } = args as {
    hostId: string;
    projectId: string;
    worktree: unknown;
    newWindow?: boolean;
  };
  const requestId = requestHostSwitch({
    toHostId: hostId,
    projectId,
    worktreePath: null,
    worktree: worktree as never,
    newWindow,
  });
  return { ok: true, result: { requestId } };
}

const GB = 1024 ** 3;

function entry(id: string, cpuPercent: number, usedGb: number, connected = true): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      connection: { kind: "ssh", target: id },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection: connected
      ? { status: "connected", rttMs: 5, handshake: HANDSHAKE }
      : { status: "disconnected" },
    summary: makeCapacitySummary({
      hostId: id,
      cpuPercent,
      memoryUsedBytes: usedGb * GB,
      agentsObserved: { working: 0, waiting: 0, idle: 0 },
    }),
  };
}

beforeEach(() => {
  cloud.snapshot = { providers: [], accounts: [], hosts: [] };
  getCatalog.mockReset();
  dispatch.mockReset();
  dispatch.mockImplementation(openOnHostLikeTheAction);
  _resetHostSwitchRequestsForTesting();
  registerHostSwitchDialogHost();
  useHostMetricsStore.getState().reset();
  hostList.hosts = [
    entry("studio-01", 70, 12),
    entry("studio-02", 5, 2),
    entry("away", 0, 0, false),
  ];
  useHostMetricsStore.getState().apply(
    makeCapacitySummary({
      hostId: "local",
      cpuPercent: 40,
      memoryUsedBytes: 8 * GB,
      agentsObserved: { working: 0, waiting: 0, idle: 0 },
    })
  );
});

/** The other host the row last handed the dialog, or null for this window's own. */
function lastCommit(onCommitChange: Mock<CommitListener>): PlacementCommit | null {
  return onCommitChange.mock.lastCall?.[0] ?? null;
}

type CommitListener = (commit: PlacementCommit | null) => void;

function renderRow(props: Partial<ComponentProps<typeof WorktreePlacementRow>> = {}) {
  const onCommitChange = vi.fn<CommitListener>();
  const onLeave = vi.fn();
  const view = render(
    <WorktreePlacementRow
      projectId="p1"
      rootPath={ROOT}
      worktreePath={DRAFT.path}
      getDraft={getDraft}
      onLeave={onLeave}
      onCommitChange={onCommitChange}
      {...props}
    />
  );
  return { ...view, onCommitChange, onLeave };
}

describe("WorktreePlacementRow", () => {
  it("names the host with the most free cores and memory once, keeping this window's host chosen", () => {
    const { onCommitChange } = renderRow();
    expect(screen.getByTestId("worktree-placement-suggestion").textContent).toBe(
      "studio-02 reports more free cores and memory than the others. Use studio-02"
    );
    expect(screen.getByTestId("worktree-placement-facts").textContent).toContain(
      "CPU 3.2 of 8 cores"
    );
    expect(lastCommit(onCommitChange)).toBeNull();
  });

  it("names the other host when only two were compared", () => {
    hostList.hosts = [entry("studio-02", 5, 2)];
    renderRow();
    expect(screen.getByTestId("worktree-placement-suggestion").textContent).toBe(
      `studio-02 reports more free cores and memory than ${localHostLabel(clientPlatform())}. Use studio-02`
    );
  });

  it("shows the facts without a pick when no host leads on both", () => {
    hostList.hosts = [entry("studio-01", 70, 1), entry("studio-02", 5, 14)];
    renderRow();
    expect(screen.getByTestId("worktree-placement-facts").textContent).toContain(
      "CPU 3.2 of 8 cores"
    );
    expect(screen.queryByTestId("worktree-placement-suggestion")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });

  it("hands the dialog's primary to the chosen host, closing only once the worktree exists there", async () => {
    const { onCommitChange, onLeave } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    expect(lastCommit(onCommitChange)).toMatchObject({
      hostId: "studio-02",
      hostName: "studio-02",
      status: "idle",
      unavailable: null,
      relativePath: "../daintree-worktrees/feature-placed",
    });
    await act(async () => {
      lastCommit(onCommitChange)!.submit();
    });
    const worktree = {
      newBranch: "feature/placed",
      baseBranch: "develop",
      fromRemote: false,
      useExistingBranch: false,
      relativePath: "../daintree-worktrees/feature-placed",
      recipeId: "setup",
    };
    expect(dispatch).toHaveBeenCalledWith(
      "project.openOnHost",
      { hostId: "studio-02", projectId: "p1", worktree, newWindow: false },
      { source: "user" }
    );
    expect(currentHostSwitchRequest()).toMatchObject({ toHostId: "studio-02", worktree });
    // The switch dialog is up, but nothing exists on the host yet: this dialog stays.
    expect(onLeave).not.toHaveBeenCalled();
    expect(lastCommit(onCommitChange)?.status).toBe("pending");
    act(() => completeHostSwitchRequest(currentHostSwitchRequest()!.id));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("leaves an empty path for the chosen host to place by its own pattern", async () => {
    const { onCommitChange } = renderRow({
      worktreePath: "",
      getDraft: () => ({ ...DRAFT, path: "" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    expect(lastCommit(onCommitChange)?.relativePath).toBeNull();

    await act(async () => {
      lastCommit(onCommitChange)!.submit();
    });
    expect(dispatch).toHaveBeenCalledWith(
      "project.openOnHost",
      expect.objectContaining({ worktree: expect.objectContaining({ relativePath: null }) }),
      { source: "user" }
    );
  });

  it("leaves this window where it is on a Cmd/Ctrl-click, opening the host in a new one", async () => {
    const { onCommitChange, onLeave } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    await act(async () => {
      // Both modifiers, so the platform's own one is held wherever this runs.
      lastCommit(onCommitChange)!.submit({ metaKey: true, ctrlKey: true });
    });
    expect(dispatch).toHaveBeenCalledWith(
      "project.openOnHost",
      expect.objectContaining({ hostId: "studio-02", newWindow: true }),
      { source: "user" }
    );
    expect(currentHostSwitchRequest()).toMatchObject({ toHostId: "studio-02", newWindow: true });
    // Done once the worktree exists on the host, whichever window shows it.
    expect(onLeave).not.toHaveBeenCalled();
    act(() => completeHostSwitchRequest(currentHostSwitchRequest()!.id));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("stops blocking local Create once it leaves the dialog with another host chosen", () => {
    const { onCommitChange, unmount } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    expect(lastCommit(onCommitChange)?.hostName).toBe("studio-02");
    unmount();
    expect(lastCommit(onCommitChange)).toBeNull();
  });

  it("says nothing was created, ready to go again, when the host's dialog closes without it", async () => {
    const { onCommitChange, onLeave } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    await act(async () => {
      lastCommit(onCommitChange)!.submit();
    });
    act(() => dismissHostSwitchRequest(currentHostSwitchRequest()!.id));
    expect(onLeave).not.toHaveBeenCalled();
    expect(lastCommit(onCommitChange)?.status).toBe("cancelled");
  });

  it("sends nothing while the form is invalid", async () => {
    const { onCommitChange } = renderRow({ getDraft: () => null });
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    await act(async () => {
      lastCommit(onCommitChange)!.submit();
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("names the host when the handoff fails and retries in the window it asked for", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "No view can show the host switch dialog" },
    });
    const { onCommitChange, onLeave } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    await act(async () => {
      lastCommit(onCommitChange)!.submit({ metaKey: true, ctrlKey: true });
    });
    expect(onLeave).not.toHaveBeenCalled();
    expect(lastCommit(onCommitChange)?.status).toBe("failed");
    const error = screen.getByTestId("worktree-placement-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("Couldn't open this project on studio-02");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(dispatch).toHaveBeenLastCalledWith(
      "project.openOnHost",
      expect.objectContaining({ hostId: "studio-02", newWindow: true }),
      { source: "user" }
    );
    act(() => completeHostSwitchRequest(currentHostSwitchRequest()!.id));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("renders nothing until another host exists", () => {
    hostList.hosts = [];
    const { container } = renderRow();
    expect(container.textContent).toBe("");
  });
});

describe("WorktreePlacementRow new machine (#17359)", () => {
  const ACCOUNT = {
    id: "ca_0123456789",
    providerId: "boat",
    providerUnavailable: null,
    displayName: "Personal",
    identity: "octocat",
    billingScope: { kind: "personal" as const, id: "personal", name: "Personal" },
    validation: { status: "valid" as const, checkedAt: 0 },
    hostCount: 0,
    addedAt: 0,
    keyHint: "abcd",
  };
  const REGIONS = {
    ...BOAT_PROVIDER,
    capabilities: {
      ...BOAT_PROVIDER.capabilities,
      provisioning: { ...BOAT_PROVIDER.capabilities.provisioning, location: "required" as const },
    },
  };
  const CATALOG: CloudCatalog = {
    accountId: ACCOUNT.id,
    machineTypes: [
      {
        id: "small",
        label: "Small",
        vcpu: 2,
        memoryGB: 4,
        hourlyDollars: 0.02,
        available: true,
        reason: null,
      },
      {
        id: "large",
        label: "Large",
        vcpu: 16,
        memoryGB: 64,
        hourlyDollars: 0.5,
        available: false,
        reason: "over your plan's limit",
      },
    ],
    provisioning: {
      location: {
        label: "Region",
        defaultId: "lhr",
        choices: [
          {
            id: "lhr",
            label: "London",
            description: "Closest to you",
            available: true,
            reason: null,
            locations: null,
          },
          {
            id: "sfo",
            label: "San Francisco",
            description: null,
            available: true,
            reason: null,
            locations: null,
          },
        ],
      },
      image: null,
      network: null,
    },
    lastChoice: null,
    canStart: true,
    includedHoursRemaining: null,
    startsRemaining: null,
  } as unknown as CloudCatalog;

  type CloudListener = (commit: CloudMachineCommit | null) => void;

  async function choose(trigger: HTMLElement, option: string | RegExp) {
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    });
    const item = await screen.findByRole("option", { name: option });
    await act(async () => {
      fireEvent.click(item);
    });
  }

  it("offers a new machine from each connected account, even before any other host exists", async () => {
    hostList.hosts = [];
    cloud.snapshot = { providers: [REGIONS], accounts: [ACCOUNT], hosts: [] };
    getCatalog.mockResolvedValue(CATALOG);
    const onCloudChange = vi.fn<CloudListener>();
    const { onCommitChange } = renderRow({ onCloudChange });
    expect(onCloudChange.mock.lastCall?.[0] ?? null).toBeNull();

    await choose(screen.getByTestId("worktree-host-select"), /New machine Personal/);
    expect(screen.getByTestId("worktree-new-machine-note").textContent).toContain(
      "Boat then creates a machine for it in Personal"
    );
    // The provider's own word for its choice, its suggestion, and the size with its price.
    const region = await screen.findByTestId("worktree-machine-location");
    expect(screen.getByText("Region")).toBeTruthy();
    expect(region.textContent).toContain("London");
    expect(screen.getByText("Closest to you")).toBeTruthy();
    expect(screen.getByTestId("worktree-machine-size").textContent).toContain("Small · 2 vCPU");
    expect(screen.getByTestId("worktree-machine-review").textContent).toContain(
      "about $0.020 an hour while it runs"
    );
    expect(lastCommit(onCommitChange)).toBeNull();

    const commit = onCloudChange.mock.lastCall?.[0];
    expect(commit).toMatchObject({
      accountId: ACCOUNT.id,
      label: "New machine · Personal",
      blocked: null,
    });
    expect(commit!.machine()).toEqual({
      accountId: ACCOUNT.id,
      machineType: "small",
      lifetimeHours: 2,
      provisioning: { location: "lhr", image: null, network: null },
    });

    await choose(region, "San Francisco");
    expect(onCloudChange.mock.lastCall?.[0]!.machine()).toMatchObject({
      provisioning: { location: "sfo", image: null, network: null },
    });
  });

  it("holds a picked size its region doesn't run, saying why, and never takes one it can't (#18189)", async () => {
    hostList.hosts = [];
    cloud.snapshot = { providers: [REGIONS], accounts: [ACCOUNT], hosts: [] };
    getCatalog.mockResolvedValue({
      ...CATALOG,
      machineTypes: [
        { ...CATALOG.machineTypes[0]!, locations: ["lhr"] },
        { ...CATALOG.machineTypes[1]!, id: "anywhere", label: "Anywhere", available: true },
      ],
    });
    const onCloudChange = vi.fn<CloudListener>();
    renderRow({ onCloudChange });
    await choose(screen.getByTestId("worktree-host-select"), /New machine Personal/);
    const region = await screen.findByTestId("worktree-machine-location");
    const size = screen.getByTestId("worktree-machine-size");
    // Small is shown first; choosing it again picks nothing, so it's chosen after another.
    await choose(size, /^Anywhere/);
    await choose(size, /^Small/);
    await choose(region, "San Francisco");

    expect(screen.getByTestId("worktree-machine-problem").textContent).toBe(
      "Small isn't available: not offered in San Francisco."
    );
    expect(screen.queryByTestId("worktree-machine-review")).toBeNull();
    const held = onCloudChange.mock.lastCall?.[0];
    expect(held?.blocked).toBe("Small isn't available: not offered in San Francisco.");
    expect(held?.machine()).toBeNull();
    await act(async () => {
      fireEvent.keyDown(size, { key: "ArrowDown" });
    });
    const small = await screen.findByRole("option", { name: /^Small/ });
    expect(small.textContent).toContain("Not offered in San Francisco");
    expect(small.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.keyDown(size, { key: "Escape" });
    });

    await choose(size, /^Anywhere/);
    expect(onCloudChange.mock.lastCall?.[0]!.machine()).toMatchObject({
      machineType: "anywhere",
      provisioning: { location: "sfo", image: null, network: null },
    });
  });

  it("says a machine whose provider has no stop runs, and bills, until it's deleted (#18229)", async () => {
    hostList.hosts = [];
    cloud.snapshot = {
      providers: [DELETE_ONLY_PROVIDER],
      accounts: [{ ...ACCOUNT, providerId: DELETE_ONLY_PROVIDER.id }],
      hosts: [],
    };
    getCatalog.mockResolvedValue({
      ...CATALOG,
      provisioning: { location: null, image: null, network: null },
    });
    renderRow();
    await choose(screen.getByTestId("worktree-host-select"), /New machine Personal/);
    const review = (await screen.findByTestId("worktree-machine-review")).textContent ?? "";
    expect(review).toContain(
      "Leasy has no stop: a machine runs, and bills, until it's deleted. Deleting it loses everything on it, its disk included."
    );
    expect(review).not.toMatch(/until you stop it|kept for/);
  });

  it("names a stopped machine's billing, and leaves Cmd+Enter to the dialog's Create", async () => {
    const billed = providerWith({ stoppedComputeBilled: true });
    hostList.hosts = [];
    cloud.snapshot = {
      providers: [billed],
      accounts: [{ ...ACCOUNT, providerId: billed.id }],
      hosts: [],
    };
    getCatalog.mockResolvedValue({
      ...CATALOG,
      provisioning: { location: null, image: null, network: null },
    });
    renderRow();
    await choose(screen.getByTestId("worktree-host-select"), /New machine Personal/);
    const review = await screen.findByTestId("worktree-machine-review");
    expect(review.textContent).toContain(
      "Acme keeps billing a stopped machine for compute until it's deleted."
    );
    const size = screen.getByTestId("worktree-machine-size");
    const shortcut = new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      size.dispatchEvent(shortcut);
    });
    expect(shortcut.defaultPrevented).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("holds Create while the sizes can't be read, saying why", async () => {
    hostList.hosts = [];
    cloud.snapshot = { providers: [BOAT_PROVIDER], accounts: [ACCOUNT], hosts: [] };
    getCatalog.mockRejectedValue(new Error("Boat is unreachable"));
    const onCloudChange = vi.fn<CloudListener>();
    renderRow({ onCloudChange });
    await choose(screen.getByTestId("worktree-host-select"), /New machine Personal/);
    await screen.findByRole("button", { name: "Retry" });
    const commit = onCloudChange.mock.lastCall?.[0];
    expect(commit?.blocked).toContain("Boat is unreachable");
    expect(commit?.machine()).toBeNull();
  });

  it("offers no new machine on a provider this machine can't use", () => {
    hostList.hosts = [];
    cloud.snapshot = {
      providers: [{ ...BOAT_PROVIDER, unsupportedReason: "Not on this platform" }],
      accounts: [ACCOUNT],
      hosts: [],
    };
    const { container } = renderRow();
    expect(container.textContent).toBe("");
  });
});

describe("placedRelativePath", () => {
  it("carries a sibling or nested worktree path relative to the project folder", () => {
    expect(placedRelativePath(ROOT, "/Users/greg/Projects/daintree-worktrees/x")).toBe(
      "../daintree-worktrees/x"
    );
    expect(placedRelativePath(ROOT, `${ROOT}/.worktrees/x`)).toBe(".worktrees/x");
  });

  it("leaves anything elsewhere to the host's own pattern", () => {
    expect(placedRelativePath(ROOT, "/tmp/x")).toBeNull();
    expect(placedRelativePath(ROOT, ROOT)).toBeNull();
    expect(placedRelativePath(ROOT, "")).toBeNull();
  });
});
