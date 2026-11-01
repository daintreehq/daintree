// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { HANDSHAKE, makeCapacitySummary } from "./fixtures";

const { hostList, dispatch } = vi.hoisted(() => ({
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
  type PlacementCommit,
  type PlacementDraft,
} from "../WorktreePlacementRow";

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
