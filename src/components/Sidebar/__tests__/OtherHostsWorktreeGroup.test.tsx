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
  runs: NonNullable<HostWorktreeEntry["runs"]> = []
): HostWorktreeEntry {
  const top = runs[0];
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
    observed: top ? { band: top.band, agentState: top.agentState } : null,
    runs,
  };
}

const waiting = (terminalId: string) =>
  ({ terminalId, band: "needs-you", agentState: "waiting" }) as const;
const working = (terminalId: string) =>
  ({ terminalId, band: "running", agentState: "working" }) as const;

let lists: Record<string, HostWorktreeEntry[]>;
let presence: HostProjectPresence[];
let eventListener: ((event: HostMetricsEvent) => void) | null;
const listWorktrees = vi.fn(async ({ hostId }: { hostId: string }) => lists[hostId] ?? []);
const locate = vi.fn(async () => presence);

beforeEach(() => {
  switchToHost.mockClear();
  listWorktrees.mockReset().mockImplementation(async ({ hostId }) => lists[hostId] ?? []);
  locate.mockClear();
  eventListener = null;
  hostList.hosts = [host("linux", true), host("away", false)];
  lists = {
    linux: [
      worktree("remote-p", "feature/c", [waiting("t1"), working("t2")]),
      worktree("remote-p", "feature/d", [working("t3")]),
      worktree("remote-p", "develop", [
        { terminalId: "t4", band: "done", agentState: "completed" },
      ]),
      worktree("someone-else", "other/x", [waiting("t9")]),
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

/** Every count the row shows, run together; empty when it counts nothing. */
function countsShown(row: HTMLElement): string {
  return [...row.querySelectorAll("[data-band]")].map((el) => el.textContent).join("");
}

function count(row: HTMLElement, band: string): string | undefined {
  return row.querySelector(`[data-band="${band}"]`)?.textContent ?? undefined;
}

describe("OtherHostsWorktreeGroup", () => {
  it("gives each host with this project one row, counting its agents by the band that host observed", async () => {
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await waitFor(() =>
      expect(count(screen.getByTestId("other-hosts-host-row"), "running")).toBe("2")
    );
    const row = screen.getByTestId("other-hosts-host-row");
    // Agents, not worktrees: feature/c's working agent counts beside feature/d's.
    // The asking agent is named under the row rather than counted on it, and a
    // zero draws nothing; each band keeps its own column.
    expect(
      [...row.querySelectorAll("[data-band]")].map((el) => el.getAttribute("data-band"))
    ).toEqual(["running"]);
    expect(row.querySelector('[data-band="running"]')?.className).toContain("col-start-5");
    // Settled agents and other projects' agents never count.
    expect(row.querySelector('[data-band="done"]')).toBeNull();
    expect(row.getAttribute("aria-label")).toBe(
      "name-linux: 1 waiting, 2 working, 1 finished (observed)"
    );
    // A disconnected host is never asked, so nothing is dialled for the sidebar.
    expect(locate).toHaveBeenCalledWith({
      fromHostId: "local",
      projectId: PROJECT,
      toHostIds: ["linux"],
    });
  });

  it("names only the agents asking, and lands on that agent's pane when one is picked", async () => {
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    const asks = await screen.findAllByTestId("other-hosts-ask-row");
    expect(asks).toHaveLength(1);
    // The branch without its type prefix, which is where an issue number starts.
    expect(asks[0]!.textContent).toBe("cWaiting");
    expect(asks[0]!.getAttribute("aria-label")).toBe("feature/c on name-linux, waiting (observed)");

    fireEvent.click(asks[0]!);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p", {
      focusIntent: { intent: "focus-panel", panelId: "t1" },
    });
    fireEvent.click(asks[0]!, { metaKey: true });
    expect(switchToHost).toHaveBeenLastCalledWith("linux", true, "remote-p", {
      focusIntent: { intent: "focus-panel", panelId: "t1" },
    });
  });

  it("opens the host's project from its row, in a new window on a modifier click", async () => {
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    const row = await screen.findByTestId("other-hosts-host-row");
    fireEvent.click(row);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p");
    fireEvent.click(row, { ctrlKey: true });
    expect(switchToHost).toHaveBeenLastCalledWith("linux", true, "remote-p");
  });

  it("folds asking agents past the first two into one row that lands on the first of them", async () => {
    lists.linux = ["a", "b", "c", "d"].map((name, i) =>
      worktree("remote-p", `feature/${name}`, [waiting(`t${i}`)])
    );
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await waitFor(() => expect(screen.getAllByTestId("other-hosts-ask-row")).toHaveLength(2));
    const more = screen.getByTestId("other-hosts-more-row");
    expect(more.textContent).toBe("2 more");
    // The first agent it stands for, not whichever waiting agent comes next.
    fireEvent.click(more);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p", {
      focusIntent: { intent: "focus-panel", panelId: "t2" },
    });
  });

  it("reads a host from before agents were listed by its worktrees' top bands, landing on the next one waiting", async () => {
    const { runs: _runs, ...old } = worktree("remote-p", "feature/c", [waiting("t1")]);
    lists.linux = [old];
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    const [ask] = await screen.findAllByTestId("other-hosts-ask-row");
    fireEvent.click(ask!);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p", {
      focusIntent: { intent: "focus-next-waiting" },
    });
  });

  it("keeps a row for a host with this project and nothing in flight, with no counts", async () => {
    lists.linux = [worktree("remote-p", "develop")];
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await waitFor(() => expect(listWorktrees).toHaveBeenCalled());
    const row = await screen.findByTestId("other-hosts-host-row");
    await waitFor(() =>
      expect(row.getAttribute("aria-label")).toBe("name-linux, no agents observed")
    );
    expect(countsShown(row)).toBe("");
  });

  it("keeps a host's place in its link's words when it drops, until a connected answer says it's gone", async () => {
    const { rerender } = render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await screen.findAllByTestId("other-hosts-ask-row");

    hostList.hosts = [host("linux", false)];
    rerender(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    const row = screen.getByTestId("other-hosts-host-row");
    expect(row.textContent).toContain("Not connected");
    // What a dropped link last said is not shown as if it were now.
    expect(row.querySelector("[data-band]")).toBeNull();
    expect(screen.queryAllByTestId("other-hosts-ask-row")).toHaveLength(0);
    fireEvent.click(row);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p");

    presence = [{ hostId: "linux", projects: [] }];
    hostList.hosts = [host("linux", true)];
    rerender(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await waitFor(() => expect(screen.queryAllByTestId("other-hosts-host-row")).toHaveLength(0));
  });

  it("reads a host again when it says its list changed, and only that host", async () => {
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await screen.findAllByTestId("other-hosts-ask-row");
    expect(listWorktrees).toHaveBeenCalledTimes(1);

    lists.linux = [worktree("remote-p", "feature/c", [working("t1")])];
    await act(async () => {
      eventListener?.({ type: "worktrees", hostId: "elsewhere" });
      eventListener?.({ type: "worktrees", hostId: "linux" });
    });
    await waitFor(() => expect(screen.queryAllByTestId("other-hosts-ask-row")).toHaveLength(0));
    expect(count(screen.getByTestId("other-hosts-host-row"), "running")).toBe("1");
    expect(listWorktrees).toHaveBeenCalledTimes(2);
  });

  it("stays hidden while no other host has this project", async () => {
    presence = [{ hostId: "linux", projects: [] }];
    const { container } = render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await waitFor(() => expect(locate).toHaveBeenCalled());
    expect(listWorktrees).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("finds this project on a host that gains it later, when that host says its list changed", async () => {
    presence = [{ hostId: "linux", projects: [] }];
    render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(1));

    presence = [
      { hostId: "linux", projects: [{ projectId: "remote-p", name: "helios", path: "/srv" }] },
    ];
    await act(async () => {
      eventListener?.({ type: "worktrees", hostId: "linux" });
    });
    const asks = await screen.findAllByTestId("other-hosts-ask-row");
    expect(asks[0]!.textContent).toContain("feature/c");
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it("never counts a host's agents for a project it no longer matches", async () => {
    const { rerender } = render(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await screen.findAllByTestId("other-hosts-ask-row");

    // The host reconnects matching through another checkout, whose read fails.
    hostList.hosts = [host("linux", false)];
    rerender(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    presence = [
      { hostId: "linux", projects: [{ projectId: "moved-p", name: "helios", path: "/srv2" }] },
    ];
    listWorktrees.mockRejectedValue(new Error("link dropped"));
    hostList.hosts = [host("linux", true)];
    rerender(<OtherHostsWorktreeGroup projectId={PROJECT} />);
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(countsShown(screen.getByTestId("other-hosts-host-row"))).toBe(""));
    expect(screen.queryAllByTestId("other-hosts-ask-row")).toHaveLength(0);
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
