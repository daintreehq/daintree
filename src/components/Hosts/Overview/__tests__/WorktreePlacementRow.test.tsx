// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { HANDSHAKE, makeSummary } from "./fixtures";

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
  hasRemoteHosts: (state: { hosts: unknown[] }) => state.hosts.length > 0,
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("../hostMetricsFeed", () => ({ startHostMetricsFeed: () => () => {} }));

import { useHostMetricsStore } from "@/store/hostMetricsStore";
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
  const { hostId, projectId, worktree } = args as {
    hostId: string;
    projectId: string;
    worktree: unknown;
  };
  const requestId = requestHostSwitch({
    toHostId: hostId,
    projectId,
    worktreePath: null,
    worktree: worktree as never,
  });
  return { ok: true, result: { requestId } };
}

function entry(id: string, cpuPercent: number, connected = true): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      sshTarget: id,
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
    },
    connection: connected
      ? { status: "connected", rttMs: 5, handshake: HANDSHAKE }
      : { status: "disconnected" },
    summary: makeSummary({
      hostId: id,
      cpuPercent,
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
  hostList.hosts = [entry("studio-01", 70), entry("studio-02", 5), entry("away", 0, false)];
  useHostMetricsStore.getState().apply(
    makeSummary({
      hostId: "local",
      cpuPercent: 40,
      agentsObserved: { working: 0, waiting: 0, idle: 0 },
    })
  );
});

describe("WorktreePlacementRow", () => {
  it("always names the least-loaded reachable host while keeping this window's host chosen", () => {
    const onElsewhereChange = vi.fn();
    render(
      <WorktreePlacementRow
        projectId="p1"
        rootPath={ROOT}
        getDraft={getDraft}
        onLeave={() => {}}
        onElsewhereChange={onElsewhereChange}
      />
    );
    expect(screen.getByTestId("worktree-placement-suggestion").textContent).toBe(
      "Least loaded: studio-02 · CPU 5% · memory normal · 0 working (observed)"
    );
    expect(screen.queryByTestId("worktree-placement-continue")).toBeNull();
    expect(onElsewhereChange).toHaveBeenLastCalledWith(false);
  });

  it("creates the form's worktree on the chosen host, closing only once it exists there", async () => {
    const onLeave = vi.fn();
    const onElsewhereChange = vi.fn();
    render(
      <WorktreePlacementRow
        projectId="p1"
        rootPath={ROOT}
        getDraft={getDraft}
        onLeave={onLeave}
        onElsewhereChange={onElsewhereChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    expect(onElsewhereChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("worktree-placement-continue"));
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
      { hostId: "studio-02", projectId: "p1", worktree },
      { source: "user" }
    );
    expect(currentHostSwitchRequest()).toMatchObject({ toHostId: "studio-02", worktree });
    // The switch dialog is up, but nothing exists on the host yet: this dialog stays.
    expect(onLeave).not.toHaveBeenCalled();
    expect((screen.getByTestId("worktree-placement-continue") as HTMLButtonElement).disabled).toBe(
      true
    );
    act(() => completeHostSwitchRequest(currentHostSwitchRequest()!.id));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("stays open, ready to retry, when the host's dialog is closed without creating it", async () => {
    const onLeave = vi.fn();
    render(
      <WorktreePlacementRow projectId="p1" rootPath={ROOT} getDraft={getDraft} onLeave={onLeave} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("worktree-placement-continue"));
    });
    act(() => dismissHostSwitchRequest(currentHostSwitchRequest()!.id));
    expect(onLeave).not.toHaveBeenCalled();
    expect((screen.getByTestId("worktree-placement-continue") as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("sends nothing while the form is invalid", async () => {
    render(
      <WorktreePlacementRow
        projectId="p1"
        rootPath={ROOT}
        getDraft={() => null}
        onLeave={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("worktree-placement-continue"));
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and names the host when the handoff fails", async () => {
    dispatch.mockResolvedValueOnce({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "No view can show the host switch dialog" },
    });
    const onLeave = vi.fn();
    render(
      <WorktreePlacementRow projectId="p1" rootPath={ROOT} getDraft={getDraft} onLeave={onLeave} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("worktree-placement-continue"));
    });
    expect(onLeave).not.toHaveBeenCalled();
    const error = screen.getByTestId("worktree-placement-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      "Couldn't open this project on studio-02. Check that it's connected and retry."
    );
    // Retrying is the same button, and the worktree existing on the host then closes the dialog.
    await act(async () => {
      fireEvent.click(screen.getByTestId("worktree-placement-continue"));
    });
    act(() => completeHostSwitchRequest(currentHostSwitchRequest()!.id));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("renders nothing until another host exists", () => {
    hostList.hosts = [];
    const { container } = render(
      <WorktreePlacementRow projectId="p1" rootPath={ROOT} getDraft={getDraft} onLeave={() => {}} />
    );
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
