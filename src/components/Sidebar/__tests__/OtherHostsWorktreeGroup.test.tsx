// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { HostMetricsEvent, HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import type { HostProjectPresence } from "@shared/types/ipc/hostSwitch";
import { HANDSHAKE, makeSummary } from "@/components/Hosts/Overview/__tests__/fixtures";

const { hostList, switchToHost } = vi.hoisted(() => ({
  hostList: { hosts: [] as HostListEntry[], localSummary: null },
  switchToHost: vi.fn(async () => {}),
}));

vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => hostList,
  hasRemoteHosts: (state: { hosts: unknown[] }) => state.hosts.length > 0,
}));
vi.mock("@/components/Hosts/hostSwitching", () => ({
  switchToHost,
  isNewWindowClick: (event: { metaKey: boolean; ctrlKey: boolean }) =>
    event.metaKey || event.ctrlKey,
}));

import { OtherHostsWorktreeGroup } from "../OtherHostsWorktreeGroup";

const PROJECT = "a".repeat(64);

function host(id: string, connected: boolean): HostListEntry {
  return {
    descriptor: {
      id,
      name: `name-${id}`,
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
    summary: makeSummary({ hostId: id }),
  };
}

function worktree(
  projectId: string,
  branch: string,
  observed: HostWorktreeEntry["observed"] = null
): HostWorktreeEntry {
  return {
    hostId: "linux",
    projectId,
    projectName: "helios",
    worktreeId: `/srv/${branch}`,
    name: branch,
    branch,
    path: `/srv/${branch}`,
    isMainWorktree: false,
    modifiedCount: null,
    lastActivityAt: null,
    observed,
  };
}

let lists: Record<string, HostWorktreeEntry[]>;
let presence: HostProjectPresence[];
let eventListener: ((event: HostMetricsEvent) => void) | null;
const listWorktrees = vi.fn(async ({ hostId }: { hostId: string }) => lists[hostId] ?? []);
const locate = vi.fn(async () => presence);

beforeEach(() => {
  switchToHost.mockClear();
  listWorktrees.mockClear();
  locate.mockClear();
  eventListener = null;
  hostList.hosts = [host("linux", true), host("away", false)];
  lists = {
    linux: [
      worktree("remote-p", "feature/c", { band: "needs-you", agentState: "waiting" }),
      worktree("someone-else", "other/x"),
    ],
  };
  presence = [
    { hostId: "linux", projects: [{ projectId: "remote-p", name: "helios", path: "/srv" }] },
  ];
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      hostMetrics: {
        listWorktrees,
        onEvent: (listener: (event: HostMetricsEvent) => void) => {
          eventListener = listener;
          return () => {
            eventListener = null;
          };
        },
      },
      hostSwitch: { locate },
    },
  });
});

describe("OtherHostsWorktreeGroup", () => {
  it("lists only this project's worktrees on connected hosts, with the band each host observed", async () => {
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    const rows = await screen.findAllByTestId("other-hosts-worktree-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("feature/c");
    expect(rows[0]!.textContent).toContain("Waiting · name-linux");
    expect(rows[0]!.getAttribute("aria-label")).toBe("feature/c on name-linux, waiting (observed)");
    // A disconnected host is never asked, so nothing is dialled for the sidebar.
    expect(locate).toHaveBeenCalledWith({
      fromHostId: "local",
      projectId: PROJECT,
      toHostIds: ["linux"],
    });
  });

  it("switches this window on a plain click and opens a new one on a modifier click", async () => {
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    const [row] = await screen.findAllByTestId("other-hosts-worktree-row");
    fireEvent.click(row!);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p");
    fireEvent.click(row!, { metaKey: true });
    expect(switchToHost).toHaveBeenLastCalledWith("linux", true, "remote-p");
  });

  it("reads a host again when it says its list changed, and only that host", async () => {
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await screen.findAllByTestId("other-hosts-worktree-row");
    expect(listWorktrees).toHaveBeenCalledTimes(1);

    lists.linux = [worktree("remote-p", "feature/c", { band: "running", agentState: "working" })];
    await act(async () => {
      eventListener?.({ type: "worktrees", hostId: "elsewhere" });
      eventListener?.({ type: "worktrees", hostId: "linux" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("other-hosts-worktree-row").textContent).toContain("Working")
    );
    expect(listWorktrees).toHaveBeenCalledTimes(2);
  });

  it("stays hidden while no other host has this project", async () => {
    presence = [{ hostId: "linux", projects: [] }];
    const { container } = render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await waitFor(() => expect(locate).toHaveBeenCalled());
    expect(listWorktrees).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("asks nothing without another host, or in a scratch view", () => {
    hostList.hosts = [];
    const { container, rerender } = render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    hostList.hosts = [host("linux", true)];
    rerender(<OtherHostsWorktreeGroup projectId="0f8fad5b-d9cb-469f-a165-70867728950e" />);
    expect(locate).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});
