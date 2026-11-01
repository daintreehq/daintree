// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionState, HostListEntry } from "@shared/types/remoteHosts";
import type { HostMetricsEvent, HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import type { HostProjectPresence } from "@shared/types/ipc/hostSwitch";
import { HANDSHAKE, makeSummary } from "@/components/Hosts/Overview/__tests__/fixtures";

const { hostList, switchToHost, openProjectOnHost } = vi.hoisted(() => ({
  hostList: { hosts: [] as HostListEntry[], localSummary: null },
  switchToHost: vi.fn(async () => {}),
  openProjectOnHost: vi.fn(async () => {}),
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
vi.mock("@/components/Hosts/OpenOnHostSubmenu", () => ({ openProjectOnHost }));
// Which mark a count wears, without copying the glyphs' own geometry.
vi.mock("@/components/Pilot/PilotRunState", () => ({
  PilotRunState: ({ band }: { band: string }) => <span data-mark={band} />,
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (select: (state: { currentProject: { name: string } }) => unknown) =>
    select({ currentProject: { name: "Helios Web" } }),
}));

import { ProjectHostsGroup } from "../ProjectHostsGroup";
import {
  PROJECT_HOSTS_ALL_SHOWN_KEY,
  PROJECT_HOSTS_EXPANDED_KEY,
  setProjectHostsAllShown,
  setProjectHostsExpanded,
} from "../projectHostsExpanded";
import {
  HANDOFF_TTL_MS,
  ORDER_SETTLE_MS,
  PROJECT_HOSTS_HANDOFF_KEY,
} from "@/components/Hosts/projectHostOrder";

const PROJECT = "a".repeat(64);

function host(
  id: string,
  connection: HostConnectionState | boolean = true,
  name = `name-${id}`
): HostListEntry {
  return {
    descriptor: {
      id,
      name,
      connection: { kind: "ssh", target: id },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection:
      connection === true
        ? { status: "connected", rttMs: 5, handshake: HANDSHAKE }
        : connection === false
          ? { status: "disconnected" }
          : connection,
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
const finished = (terminalId: string) =>
  ({ terminalId, band: "done", agentState: "completed" }) as const;

let lists: Record<string, HostWorktreeEntry[]>;
let presence: HostProjectPresence[];
const eventListeners = new Set<(event: HostMetricsEvent) => void>();
const emit = (event: HostMetricsEvent) => {
  for (const listener of [...eventListeners]) listener(event);
};
const listWorktrees = vi.fn(async ({ hostId }: { hostId: string }) => lists[hostId] ?? []);
const locate = vi.fn(async ({ toHostIds }: { toHostIds: string[] }) =>
  presence.filter((answer) => toHostIds.includes(answer.hostId))
);

const has = (hostId: string, projectId = "remote-p"): HostProjectPresence => ({
  hostId,
  projects: [{ projectId, name: "helios", path: `/srv/${projectId}` }],
});

beforeEach(() => {
  switchToHost.mockClear();
  openProjectOnHost.mockClear();
  listWorktrees.mockReset().mockImplementation(async ({ hostId }) => lists[hostId] ?? []);
  locate.mockClear();
  eventListeners.clear();
  localStorage.clear();
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  hostList.hosts = [host("linux"), host("away", false)];
  lists = {
    local: [worktree(PROJECT, "develop", [working("l1")])],
    linux: [
      worktree("remote-p", "feature/c", [waiting("t1"), working("t2")]),
      worktree("remote-p", "feature/d", [working("t3")]),
      worktree("remote-p", "develop", [finished("t4")]),
      worktree("someone-else", "other/x", [waiting("t9")]),
    ],
  };
  presence = [has("linux")];
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      hostMetrics: {
        listWorktrees,
        onEvent: (listener: (event: HostMetricsEvent) => void) => {
          eventListeners.add(listener);
          return () => {
            eventListeners.delete(listener);
          };
        },
      },
      hostSwitch: { locate },
    },
  });
});

afterEach(() => {
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  vi.restoreAllMocks();
  vi.useRealTimers();
  // The preferences keep a fallback for a view that can't write storage; a
  // working write clears it, so no test inherits another's.
  setProjectHostsExpanded(true);
  setProjectHostsAllShown(false);
});

function rows(): HTMLElement[] {
  return screen.queryAllByTestId("project-hosts-host-row");
}

function section(): HTMLElement | null {
  return screen.queryByTestId("project-hosts-group");
}

function hasRow(hostId: string): boolean {
  return document.querySelector(`[data-host-id="${hostId}"]`) !== null;
}

function rowFor(hostId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-host-id="${hostId}"] [data-testid="project-hosts-host-row"]`
  );
  if (!row) throw new Error(`no row for ${hostId}`);
  return row;
}

function hostOrder(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-host-id]")].map(
    (el) => el.dataset.hostId!
  );
}

/** Every count the row shows, run together; empty when it counts nothing. */
function countsShown(row: HTMLElement): string {
  return [...row.querySelectorAll("[data-band]")].map((el) => el.textContent).join("");
}

function count(row: HTMLElement, band: string): string | undefined {
  return row.querySelector(`[data-band="${band}"]`)?.textContent ?? undefined;
}

describe("ProjectHostsGroup", () => {
  it("lists only the hosts the project is on, this machine first and marked as this window", async () => {
    hostList.hosts = [host("zeta", false, "zeta"), host("linux", true, "alpha"), host("away")];
    presence = [has("linux"), { hostId: "away", projects: [] }];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    // No row for a host with no copy, nor for one not connected that was never matched.
    expect(hostOrder()).toEqual(["local", "linux"]);
    expect(rowFor("local").getAttribute("aria-current")).toBe("true");
    expect(rowFor("linux").getAttribute("aria-current")).toBeNull();
    // The window's own host is read like the rest, never asked whether it has its own project.
    expect(count(rowFor("local"), "running")).toBe("1");
    expect(listWorktrees).toHaveBeenCalledWith({ hostId: "local" });
    expect(locate).toHaveBeenCalledWith({
      fromHostId: "local",
      projectId: PROJECT,
      toHostIds: ["linux", "away"],
    });
  });

  it("counts a host's agents by band, asking ones included, and never lists its worktrees", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    const row = rowFor("linux");
    // Agents, not worktrees; settled agents and other projects' agents never count.
    expect(count(row, "asking")).toBe("1");
    expect(row.querySelector('[data-band="done"]')).toBeNull();
    expect(row.getAttribute("aria-label")).toBe(
      "name-linux: 1 waiting, 2 working, 1 finished (observed)"
    );
    // One row per host and nothing under it.
    expect(document.querySelectorAll("[data-project-hosts-row]")).toHaveLength(2);
    expect(screen.getByTestId("project-hosts-group").textContent).not.toContain("feature/c");
    // Counts are right-aligned in shared columns: the working count ends both rows,
    // and this machine's row, with nothing asking, leaves that column to its name.
    const cells = (hostId: string) =>
      [...rowFor(hostId).querySelectorAll<HTMLElement>("[data-count-cell]")].map(
        (cell) => cell.dataset.countCell
      );
    expect(cells("linux")).toEqual(["asking", "running"]);
    expect(cells("local")).toEqual(["running"]);
  });

  it("reads a host from before agents were listed by its worktrees' top bands", async () => {
    const { runs: _runs, ...old } = worktree("remote-p", "feature/c", [waiting("t1")]);
    lists.linux = [old];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "asking")).toBe("1"));
  });

  it("marks a host's asking count blocked when any agent there is blocked, else waiting", async () => {
    const blocked = { terminalId: "b1", band: "blocked", agentState: "waiting" } as const;
    const mark = () =>
      rowFor("linux").querySelector('[data-band="asking"] [data-mark]')?.getAttribute("data-mark");
    lists.linux = [worktree("remote-p", "feature/a", [waiting("w1"), blocked])];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "asking")).toBe("2"));
    expect(mark()).toBe("blocked");

    lists.linux = [worktree("remote-p", "feature/a", [waiting("w1")])];
    await act(async () => {
      emit({ type: "worktrees", hostId: "linux" });
    });
    await waitFor(() => expect(count(rowFor("linux"), "asking")).toBe("1"));
    expect(mark()).toBe("needs-you");
  });

  it("switches to a host's copy from its row, and does nothing from the window's own", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    fireEvent.click(rowFor("linux"));
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p");
    fireEvent.click(rowFor("linux"), { ctrlKey: true });
    expect(switchToHost).toHaveBeenLastCalledWith("linux", true, "remote-p");

    fireEvent.click(rowFor("local"));
    fireEvent.click(rowFor("local"), { metaKey: true });
    expect(switchToHost).toHaveBeenCalledTimes(2);
  });

  it("draws nothing for a project only on this machine, whatever the other hosts said", async () => {
    hostList.hosts = [host("none"), host("failed"), host("pending"), host("away", false)];
    presence = [
      { hostId: "none", projects: [] },
      { hostId: "failed", projects: null },
    ];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() =>
      expect(locate).toHaveBeenCalledWith({
        fromHostId: "local",
        projectId: PROJECT,
        toHostIds: ["failed", "none", "pending"],
      })
    );
    await act(async () => {});
    expect(section()).toBeNull();
  });

  it("says what the host listed in place of counts: no agents, how many agents, no worktrees", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));

    const reread = async (entries: HostWorktreeEntry[]) => {
      lists.linux = entries;
      await act(async () => {
        emit({ type: "worktrees", hostId: "linux" });
      });
    };
    await reread([worktree("remote-p", "develop")]);
    await waitFor(() => expect(rowFor("linux").textContent).toContain("No agents"));
    // Agents in bands the row doesn't count: how many, never a verdict on what they are doing.
    await reread([worktree("remote-p", "develop", [finished("t4")])]);
    await waitFor(() => expect(rowFor("linux").textContent).toContain("1 agent"));
    expect(countsShown(rowFor("linux"))).toBe("");
    expect(rowFor("linux").getAttribute("aria-label")).toBe("name-linux: 1 finished (observed)");
    // A host lists nothing for a project it couldn't read too: said as listed, not as "closed".
    await reread([]);
    await waitFor(() => expect(rowFor("linux").textContent).toContain("No worktrees"));
  });

  it("shows a dropped host in its link's words and nothing it said before", async () => {
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));

    hostList.hosts = [host("linux", false), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    const row = rowFor("linux");
    expect(row.textContent).toContain("Not connected");
    expect(row.querySelector("[data-band]")).toBeNull();
    // Still the copy it was matched with.
    fireEvent.click(row);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p");

    // Back, and saying it has no copy now: this machine is the only one left.
    presence = [{ hostId: "linux", projects: [] }];
    hostList.hosts = [host("linux"), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(section()).toBeNull());
  });

  it("holds a silent link's counts back rather than show them as current", async () => {
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    hostList.hosts = [
      host("linux", { status: "connected", rttMs: 5, handshake: HANDSHAKE, quietSince: 1 }),
      host("away", false),
    ];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    expect(rowFor("linux").textContent).toContain("No reply");
    expect(countsShown(rowFor("linux"))).toBe("");
  });

  it("reads a host again when it says its list changed, and only that host", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    const linuxReads = () => listWorktrees.mock.calls.filter(([a]) => a.hostId === "linux").length;
    expect(linuxReads()).toBe(1);

    lists.linux = [worktree("remote-p", "feature/c", [working("t1")])];
    await act(async () => {
      emit({ type: "worktrees", hostId: "elsewhere" });
      emit({ type: "worktrees", hostId: "linux" });
    });
    await waitFor(() => expect(count(rowFor("linux"), "asking")).toBeUndefined());
    expect(count(rowFor("linux"), "running")).toBe("1");
    expect(linuxReads()).toBe(2);
  });

  it("finds this project on a host that gains it later, when that host says its projects changed", async () => {
    presence = [{ hostId: "linux", projects: [] }];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(section()).toBeNull();

    presence = [has("linux")];
    await act(async () => {
      emit({ type: "projects", hostId: "linux" });
    });
    await waitFor(() => expect(count(rowFor("linux"), "asking")).toBe("1"));
    expect(hostOrder()).toEqual(["local", "linux"]);
    expect(locate).toHaveBeenCalledTimes(2);
    expect(locate).toHaveBeenLastCalledWith({
      fromHostId: "local",
      projectId: PROJECT,
      toHostIds: ["linux"],
    });
  });

  it("asks nothing again for agent activity on a host without this project", async () => {
    presence = [{ hostId: "linux", projects: [] }];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(1));
    await act(async () => {});

    // Its agents keep changing state: what its worktree list shows moves, and
    // whether it has this project can't.
    for (let i = 0; i < 20; i++) {
      lists.linux = [worktree("someone-else", "other/x", [i % 2 ? waiting("t9") : working("t9")])];
      await act(async () => {
        emit({ type: "worktrees", hostId: "linux" });
      });
    }
    expect(locate).toHaveBeenCalledTimes(1);
    expect(section()).toBeNull();

    // A project registered there is what can.
    presence = [has("linux")];
    await act(async () => {
      emit({ type: "projects", hostId: "linux" });
    });
    await waitFor(() => expect(hasRow("linux")).toBe(true));
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it("asks only the host whose projects changed, keeping every other host's answer", async () => {
    hostList.hosts = [host("linux"), host("other")];
    presence = [has("linux"), { hostId: "other", projects: [] }];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    expect(locate).toHaveBeenCalledTimes(1);

    presence = [{ hostId: "linux", projects: null }, has("other", "other-p")];
    lists.other = [worktree("other-p", "develop", [working("o1")])];
    await act(async () => {
      emit({ type: "projects", hostId: "other" });
    });
    await waitFor(() => expect(count(rowFor("other"), "running")).toBe("1"));
    expect(locate).toHaveBeenCalledTimes(2);
    expect(locate).toHaveBeenLastCalledWith({
      fromHostId: "local",
      projectId: PROJECT,
      toHostIds: ["other"],
    });
    // linux wasn't asked again, so its answer and counts stand.
    expect(count(rowFor("linux"), "running")).toBe("2");
  });

  it("asks a host that connects on its own, not every host again", async () => {
    hostList.hosts = [host("linux"), host("other", false)];
    presence = [has("linux"), has("other", "other-p")];
    lists.other = [worktree("other-p", "develop", [working("o1")])];
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    expect(locate).toHaveBeenCalledTimes(1);

    hostList.hosts = [host("linux"), host("other")];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("other"), "running")).toBe("1"));
    expect(locate).toHaveBeenCalledTimes(2);
    expect(locate).toHaveBeenLastCalledWith({
      fromHostId: "local",
      projectId: PROJECT,
      toHostIds: ["other"],
    });
  });

  it("shows a matched host whose copy closed as having no worktrees, without asking again", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    expect(locate).toHaveBeenCalledTimes(1);

    lists.linux = [worktree("someone-else", "other/x")];
    await act(async () => {
      emit({ type: "worktrees", hostId: "linux" });
    });
    await waitFor(() => expect(rowFor("linux").textContent).toContain("No worktrees"));
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it("never counts a host's agents for a project it no longer matches", async () => {
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));

    // The host reconnects matching through another checkout, whose read fails.
    hostList.hosts = [host("linux", false), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    presence = [has("linux", "moved-p")];
    listWorktrees.mockRejectedValue(new Error("link dropped"));
    hostList.hosts = [host("linux"), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(countsShown(rowFor("linux"))).toBe(""));
    // The old checkout's read is not this one's, so it isn't "No worktrees"
    // either; and the new one failed, which is not "still checking".
    await waitFor(() => expect(rowFor("linux").textContent).toContain("Couldn't read"));
    expect(rowFor("linux").dataset.status).toBe("note");
  });

  it("never carries the last project's counts over to a new one while its own answer is out", async () => {
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));

    locate.mockImplementationOnce(() => new Promise<HostProjectPresence[]>(() => {}));
    rerender(<ProjectHostsGroup projectId={"b".repeat(64)} />);
    expect(section()).toBeNull();
  });

  it("forgets a host's copy once a connected answer says it's gone, keeping its row while in use", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    fireEvent.pointerEnter(section()!);

    // The checkout is removed on the host: its list no longer has the project,
    // and asked again, it says so.
    lists.linux = [worktree("someone-else", "other/x")];
    presence = [{ hostId: "linux", projects: [] }];
    await act(async () => {
      emit({ type: "worktrees", hostId: "linux" });
      emit({ type: "projects", hostId: "linux" });
    });
    // Under the pointer the row stays, saying so, and a click offers to set one up.
    await waitFor(() => expect(rowFor("linux").textContent).toContain("Not added"));
    expect(countsShown(rowFor("linux"))).toBe("");
    fireEvent.click(rowFor("linux"));
    expect(openProjectOnHost).toHaveBeenLastCalledWith("linux", PROJECT, false, "user");
    expect(switchToHost).not.toHaveBeenCalled();

    // Out of use, it goes, and the section with it.
    fireEvent.pointerLeave(section()!);
    expect(section()).toBeNull();
  });

  it("keeps a row that loses the project while focus is in it, until focus leaves", async () => {
    hostList.hosts = [host("linux"), host("other")];
    presence = [has("linux"), has("other", "other-p")];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    rowFor("linux").focus();

    lists.linux = [];
    presence = [{ hostId: "linux", projects: [] }, has("other", "other-p")];
    await act(async () => {
      emit({ type: "worktrees", hostId: "linux" });
      emit({ type: "projects", hostId: "linux" });
    });
    await waitFor(() => expect(rowFor("linux").textContent).toContain("Not added"));
    expect(document.activeElement).toBe(rowFor("linux"));
    expect(hostOrder()).toEqual(["local", "linux", "other"]);

    act(() => rowFor("linux").blur());
    expect(hostOrder()).toEqual(["local", "other"]);
  });

  it("reads focus afresh when the section is drawn again, so a focus it lost unseen holds nothing", async () => {
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    rowFor("linux").focus();

    // The host is removed: the section goes with focus in it, and no blur fires.
    hostList.hosts = [host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    expect(section()).toBeNull();

    hostList.hosts = [host("linux"), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));

    lists.linux = [];
    presence = [{ hostId: "linux", projects: [] }];
    await act(async () => {
      emit({ type: "worktrees", hostId: "linux" });
      emit({ type: "projects", hostId: "linux" });
    });
    await waitFor(() => expect(section()).toBeNull());
  });

  it("keeps a matched host whose lookup later fails, still opening the copy it matched", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));

    lists.linux = [];
    presence = [{ hostId: "linux", projects: null }];
    await act(async () => {
      emit({ type: "worktrees", hostId: "linux" });
      emit({ type: "projects", hostId: "linux" });
    });
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowFor("linux").textContent).toContain("No worktrees"));
    fireEvent.click(rowFor("linux"), { metaKey: true });
    expect(switchToHost).toHaveBeenLastCalledWith("linux", true, "remote-p");
  });

  it("says a host is being checked only once its first answer is slow to come", async () => {
    listWorktrees.mockImplementation(({ hostId }) =>
      hostId === "linux"
        ? new Promise<HostWorktreeEntry[]>(() => {})
        : Promise.resolve(lists[hostId] ?? [])
    );
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("local"), "running")).toBe("1"));
    expect(rowFor("linux").dataset.status).toBe("checking");
    expect(rowFor("linux").getAttribute("aria-label")).toBe("name-linux, checking");
    // Nothing for an answer that comes quickly, then the word once it is slow.
    await waitFor(() => expect(rowFor("linux").textContent).toBe("name-linuxChecking…"));
  });

  it("asks nothing while the window's own host is away, and asks once it is back", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "linux" } as typeof window.__DAINTREE_HOST_ID__;
    hostList.hosts = [host("linux", false), host("away", false)];
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    // Nothing asked, so nothing known to have it but the window's own host.
    expect(locate).not.toHaveBeenCalled();
    expect(section()).toBeNull();

    presence = [{ hostId: "local", projects: [{ projectId: "local-p", name: "h", path: "/p" }] }];
    lists.local = [worktree("local-p", "develop", [working("l1")])];
    lists.linux = [worktree(PROJECT, "feature/c", [working("t1")])];
    hostList.hosts = [host("linux"), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("local"), "running")).toBe("1"));
    expect(count(rowFor("linux"), "running")).toBe("1");
    expect(rowFor("linux").getAttribute("aria-current")).toBe("true");
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it("asks nothing without another host, or in a scratch view", () => {
    hostList.hosts = [];
    const { container, rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    hostList.hosts = [host("linux")];
    rerender(<ProjectHostsGroup projectId="0f8fad5b-d9cb-469f-a165-70867728950e" />);
    expect(locate).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  describe("order", () => {
    /** One connected host per spec, each with this project and the agents given. */
    function fleet(specs: Record<string, HostWorktreeEntry["runs"] | "none" | "away">) {
      hostList.hosts = Object.entries(specs).map(([id, spec]) => host(id, spec !== "away"));
      presence = Object.entries(specs).map(([id, spec]) =>
        spec === "none" ? { hostId: id, projects: [] } : has(id, `${id}-p`)
      );
      for (const [id, spec] of Object.entries(specs)) {
        if (Array.isArray(spec)) lists[id] = [worktree(`${id}-p`, "develop", spec)];
      }
    }

    it("puts this machine first, then hosts asking, working, settled, leaving out the rest", async () => {
      fleet({
        a: [finished("a1")],
        b: [working("b1")],
        c: [waiting("c1")],
        d: "none",
        e: "away",
      });
      render(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(hostOrder()).toEqual(["local", "c", "b", "a"]));
    });

    it("holds still while the pointer is over it, and moves once it leaves", async () => {
      fleet({ b: [working("b1")], c: [finished("c1")] });
      render(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(count(rowFor("b"), "running")).toBe("1"));
      expect(hostOrder()).toEqual(["local", "b", "c"]);

      const section = screen.getByTestId("project-hosts-group");
      fireEvent.pointerEnter(section);
      lists.c = [worktree("c-p", "develop", [waiting("c1")])];
      await act(async () => {
        emit({ type: "worktrees", hostId: "c" });
      });
      await waitFor(() => expect(count(rowFor("c"), "asking")).toBe("1"));
      expect(hostOrder()).toEqual(["local", "b", "c"]);

      fireEvent.pointerLeave(section);
      expect(hostOrder()).toEqual(["local", "c", "b"]);
    });

    it("holds still while focus is in it", async () => {
      fleet({ b: [working("b1")], c: [finished("c1")] });
      render(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(count(rowFor("b"), "running")).toBe("1"));
      rowFor("b").focus();
      lists.c = [worktree("c-p", "develop", [waiting("c1")])];
      await act(async () => {
        emit({ type: "worktrees", hostId: "c" });
      });
      await waitFor(() => expect(count(rowFor("c"), "asking")).toBe("1"));
      expect(hostOrder()).toEqual(["local", "b", "c"]);
      act(() => rowFor("b").blur());
      expect(hostOrder()).toEqual(["local", "c", "b"]);
    });

    it("opens a window a click made on the order that click was made in", async () => {
      fleet({ b: [working("b1")], c: [finished("c1")] });
      localStorage.setItem(
        PROJECT_HOSTS_HANDOFF_KEY,
        JSON.stringify({ order: ["local", "c", "c", "b"], at: Date.now() })
      );
      // Their reads still out, so the order isn't settled and the handoff holds.
      listWorktrees.mockImplementation(({ hostId }) =>
        hostId === "local" ? Promise.resolve(lists.local ?? []) : new Promise(() => {})
      );
      render(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(count(rowFor("local"), "running")).toBe("1"));
      await waitFor(() => expect(hasRow("b")).toBe(true));
      // Each host once, however the handoff listed it.
      expect(hostOrder()).toEqual(["local", "c", "b"]);
    });

    it("ignores a handoff that is stale or unreadable", async () => {
      fleet({ b: [working("b1")], c: [finished("c1")] });
      for (const stored of [
        JSON.stringify({ order: ["local", "c", "b"], at: Date.now() - HANDOFF_TTL_MS - 1 }),
        "not json",
        JSON.stringify(["local", "c", "b"]),
      ]) {
        localStorage.setItem(PROJECT_HOSTS_HANDOFF_KEY, stored);
        const { unmount } = render(<ProjectHostsGroup projectId={PROJECT} />);
        await waitFor(() => expect(count(rowFor("b"), "running")).toBe("1"));
        expect(hostOrder()).toEqual(["local", "b", "c"]);
        unmount();
      }
    });

    it("hands the order on screen to the window a click opens", async () => {
      fleet({ b: [working("b1")], c: [finished("c1")], d: "none" });
      render(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(count(rowFor("b"), "running")).toBe("1"));
      fireEvent.click(rowFor("c"));
      const handoff: unknown = JSON.parse(
        localStorage.getItem(PROJECT_HOSTS_HANDOFF_KEY) ?? "null"
      );
      expect(handoff).toMatchObject({ order: hostOrder() });
    });

    it("keeps a host that joins while the order is held where it first landed", async () => {
      fleet({ b: [working("b1")], c: [finished("c1")] });
      const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(count(rowFor("b"), "running")).toBe("1"));
      fireEvent.pointerEnter(screen.getByTestId("project-hosts-group"));

      // n joins with nothing counted yet: it lands among the settled hosts.
      hostList.hosts = [...hostList.hosts, host("n")];
      presence = [...presence, has("n", "n-p")];
      lists.n = [worktree("n-p", "develop", [finished("n1")])];
      rerender(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(rowFor("n").textContent).toContain("1 agent"));
      const landed = hostOrder();
      expect(landed).toContain("n");

      // Then an agent there asks: it would go first, but the section is in use.
      lists.n = [worktree("n-p", "develop", [waiting("n1")])];
      await act(async () => {
        emit({ type: "worktrees", hostId: "n" });
      });
      await waitFor(() => expect(count(rowFor("n"), "asking")).toBe("1"));
      expect(hostOrder()).toEqual(landed);

      fireEvent.pointerLeave(screen.getByTestId("project-hosts-group"));
      expect(hostOrder()).toEqual(["local", "n", "b", "c"]);
    });

    it("orders without a host whose read never lands once it has waited long enough", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fleet({ b: [working("b1")], c: [finished("c1")], slow: [] });
      // slow has the project but never answers a read of it.
      listWorktrees.mockImplementation(({ hostId }) =>
        hostId === "slow" ? new Promise(() => {}) : Promise.resolve(lists[hostId] ?? [])
      );
      lists.c = [worktree("c-p", "develop", [waiting("c1")])];
      render(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(count(rowFor("c"), "asking")).toBe("1"));
      // Still waiting on slow: the first order holds.
      expect(hostOrder()).toEqual(["local", "b", "c", "slow"]);
      await act(async () => {
        vi.advanceTimersByTime(ORDER_SETTLE_MS);
      });
      expect(hostOrder()).toEqual(["local", "c", "b", "slow"]);
    });

    it("shows this machine and four more, folding the rest into one row that carries their counts", async () => {
      fleet({
        h1: [waiting("1")],
        h2: [working("2")],
        h3: [working("3")],
        h4: [working("4")],
        h5: [working("5"), working("6")],
        h6: [waiting("7")],
      });
      render(<ProjectHostsGroup projectId={PROJECT} />);
      const more = await screen.findByTestId("project-hosts-more-row");
      await waitFor(() => expect(count(more, "running")).toBe("3"));
      // Asking first, so h1 and h6 both show; h4 and h5 are past the first five.
      expect(
        rows().map((row) => row.closest("[data-host-id]")?.getAttribute("data-host-id"))
      ).toEqual(["local", "h1", "h6", "h2", "h3"]);
      expect(more.textContent).toContain("2 more hosts");
      expect(more.getAttribute("aria-label")).toBe("2 more hosts");
      expect(more.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(more);
      expect(rows()).toHaveLength(7);
      expect(more.getAttribute("aria-expanded")).toBe("true");
      // The label stays; the folded counts go once their hosts are showing.
      expect(more.textContent).toContain("2 more hosts");
      expect(more.getAttribute("aria-label")).toBe("2 more hosts");
      expect(more.querySelector("[data-band]")).toBeNull();
      expect(localStorage.getItem(PROJECT_HOSTS_ALL_SHOWN_KEY)).toBe("true");
    });

    it("holds the fold still while in use: a seventh host waits, then folds", async () => {
      fleet({ h1: [], h2: [], h3: [], h4: [], h5: [] });
      const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(rows()).toHaveLength(6));
      fireEvent.pointerEnter(screen.getByTestId("project-hosts-group"));

      hostList.hosts = [...hostList.hosts, host("h6")];
      presence = [...presence, has("h6", "h6-p")];
      lists.h6 = [worktree("h6-p", "develop")];
      rerender(<ProjectHostsGroup projectId={PROJECT} />);
      // Everything has answered, h6 included: only the pointer holds the fold now.
      await waitFor(() => expect(rowFor("h6").textContent).toContain("No agents"));
      expect(rows()).toHaveLength(7);
      expect(screen.queryByTestId("project-hosts-more-row")).toBeNull();

      fireEvent.pointerLeave(screen.getByTestId("project-hosts-group"));
      expect(rows()).toHaveLength(5);
      expect(screen.getByTestId("project-hosts-more-row").textContent).toContain("2 more hosts");
    });

    it("brings a folded host up once it asks and the section is out of use", async () => {
      fleet({
        h1: [working("1")],
        h2: [working("2")],
        h3: [working("3")],
        h4: [working("4")],
        h5: [finished("5")],
        h6: [finished("6")],
      });
      render(<ProjectHostsGroup projectId={PROJECT} />);
      const more = await screen.findByTestId("project-hosts-more-row");
      await waitFor(() => expect(rows()).toHaveLength(5));
      expect(more.querySelector("[data-band]")).toBeNull();

      fireEvent.pointerEnter(screen.getByTestId("project-hosts-group"));
      lists.h6 = [
        worktree("h6-p", "develop", [{ terminalId: "6", band: "blocked", agentState: "waiting" }]),
      ];
      await act(async () => {
        emit({ type: "worktrees", hostId: "h6" });
      });
      // Still folded, and the fold row says what came up inside it.
      await waitFor(() => expect(count(more, "asking")).toBe("1"));
      expect(
        more.querySelector('[data-band="asking"] [data-mark]')?.getAttribute("data-mark")
      ).toBe("blocked");
      const described = document.getElementById(more.getAttribute("aria-describedby") ?? "");
      expect(described?.textContent).toBe("1 asking (observed)");

      fireEvent.pointerLeave(screen.getByTestId("project-hosts-group"));
      expect(hostOrder().slice(0, 2)).toEqual(["local", "h6"]);
      expect(count(screen.getByTestId("project-hosts-more-row"), "asking")).toBeUndefined();
    });

    it("follows another window opening the fold, but not while this one is in use", async () => {
      fleet({ h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] });
      render(<ProjectHostsGroup projectId={PROJECT} />);
      await screen.findByTestId("project-hosts-more-row");
      await waitFor(() => expect(rowFor("h1").textContent).toContain("No agents"));
      const section = screen.getByTestId("project-hosts-group");
      fireEvent.pointerEnter(section);

      localStorage.setItem(PROJECT_HOSTS_ALL_SHOWN_KEY, "true");
      act(() => {
        window.dispatchEvent(new StorageEvent("storage", { key: PROJECT_HOSTS_ALL_SHOWN_KEY }));
      });
      expect(rows()).toHaveLength(5);
      fireEvent.pointerLeave(section);
      expect(rows()).toHaveLength(7);
    });

    it("never folds a single host: a row for one is no saving", async () => {
      fleet({ h1: [], h2: [], h3: [], h4: [], h5: [] });
      render(<ProjectHostsGroup projectId={PROJECT} />);
      await waitFor(() => expect(rows()).toHaveLength(6));
      expect(screen.queryByTestId("project-hosts-more-row")).toBeNull();
    });
  });

  it("still toggles in a view that can't write storage, and follows another view once storage works", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      render(<ProjectHostsGroup projectId={PROJECT} />);
      const toggle = await screen.findByTestId("project-hosts-toggle");
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      setItem.mockRestore();

      // Another view's write is what this one reads from then on.
      localStorage.setItem(PROJECT_HOSTS_EXPANDED_KEY, "true");
      act(() => {
        window.dispatchEvent(new StorageEvent("storage", { key: PROJECT_HOSTS_EXPANDED_KEY }));
      });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    } finally {
      setItem.mockRestore();
    }
  });

  it("collapses under a header naming the project, keeping the other hosts' totals, for every view", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    const toggle = screen.getByTestId("project-hosts-toggle");
    // The project's name exactly as the project selector shows it; only "across hosts" is ours.
    expect(toggle.textContent).toBe("Helios Web across hosts");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(0);
    // The list it controls stays in the tree, hidden and empty, so the reference holds.
    const controlled = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(controlled?.hidden).toBe(true);
    expect(controlled?.querySelector("ul")).toBeNull();
    expect(localStorage.getItem(PROJECT_HOSTS_EXPANDED_KEY)).toBe("false");
    // One asking and two working on linux; this machine's own working agent isn't counted.
    const totals = screen.getByTestId("project-hosts-totals");
    expect(totals.querySelector('[data-total="asking"]')?.textContent).toBe("1");
    expect(totals.querySelector('[data-total="working"]')?.textContent).toBe("2");
    // The toggle's name never changes with its state; the totals describe it.
    expect(toggle.getAttribute("aria-label")).toBe("Helios Web across hosts");
    const described = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("1 asking, 2 working on other hosts (observed)");

    // Another project view opens it again: this one follows.
    localStorage.setItem(PROJECT_HOSTS_EXPANDED_KEY, "true");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: PROJECT_HOSTS_EXPANDED_KEY }));
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rows()).toHaveLength(2);
  });

  it("marks the collapsed asking total blocked when another host has a blocked agent", async () => {
    const blocked = { terminalId: "b1", band: "blocked", agentState: "waiting" } as const;
    lists.linux = [worktree("remote-p", "feature/a", [waiting("w1"), blocked])];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "asking")).toBe("2"));
    fireEvent.click(screen.getByTestId("project-hosts-toggle"));
    const mark = screen
      .getByTestId("project-hosts-totals")
      .querySelector('[data-total="asking"] [data-mark]')
      ?.getAttribute("data-mark");
    expect(mark).toBe("blocked");
  });

  it("shows no totals when collapsed if only this machine has agents", async () => {
    lists.local = [worktree(PROJECT, "develop", [working("l1"), waiting("l2")])];
    lists.linux = [worktree("remote-p", "develop", [finished("t1")])];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(rowFor("linux").textContent).toContain("1 agent"));
    const toggle = screen.getByTestId("project-hosts-toggle");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("project-hosts-totals")).toBeNull();
    expect(toggle.getAttribute("aria-describedby")).toBeNull();
  });

  it("moves between the section's rows with the arrow keys", async () => {
    hostList.hosts = [host("linux"), host("away")];
    presence = [has("linux"), has("away", "away-p")];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    const toggle = screen.getByTestId("project-hosts-toggle");
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    toggle.focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(rowFor("local"));
    press("ArrowDown");
    expect(document.activeElement).toBe(rowFor("linux"));
    press("End");
    expect(document.activeElement).toBe(rowFor("away"));
    press("ArrowDown");
    expect(document.activeElement).toBe(rowFor("away"));
    press("Home");
    expect(document.activeElement).toBe(toggle);
  });
});
