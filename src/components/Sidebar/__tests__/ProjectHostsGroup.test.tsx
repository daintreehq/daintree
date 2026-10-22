// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionState, HostListEntry } from "@shared/types/remoteHosts";
import type { HostMetricsEvent, HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import type { HostProjectPresence } from "@shared/types/ipc/hostSwitch";
import { HANDSHAKE, makeSummary } from "@/components/Hosts/Overview/__tests__/fixtures";

const { hostList, switchToHost, openProjectOnHost, dispatch } = vi.hoisted(() => ({
  hostList: { hosts: [] as HostListEntry[], localSummary: null },
  switchToHost: vi.fn(async () => {}),
  openProjectOnHost: vi.fn(async () => {}),
  dispatch: vi.fn(async () => ({ ok: true })),
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
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (select: (state: { currentProject: { name: string } }) => unknown) =>
    select({ currentProject: { name: "helios" } }),
}));

import { ProjectHostsGroup } from "../ProjectHostsGroup";
import { PROJECT_HOSTS_EXPANDED_KEY } from "../projectHostsExpanded";

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
  dispatch.mockClear();
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
      worktree("remote-p", "develop", [
        { terminalId: "t4", band: "done", agentState: "completed" },
      ]),
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
});

function rows(): HTMLElement[] {
  return screen.queryAllByTestId("project-hosts-host-row");
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
  it("lists every host, this machine first and marked as this window, whatever each has", async () => {
    hostList.hosts = [host("zeta", false, "zeta"), host("linux", true, "alpha"), host("away")];
    presence = [has("linux"), { hostId: "away", projects: [] }];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    // This machine, then by name: a host without the project or without a link keeps its place.
    expect(hostOrder()).toEqual(["local", "linux", "away", "zeta"]);
    expect(rowFor("local").getAttribute("aria-current")).toBe("true");
    expect(rowFor("linux").getAttribute("aria-current")).toBeNull();
    expect(rowFor("away").textContent).toContain("Not added");
    expect(rowFor("zeta").textContent).toContain("Not connected");
    // The window's own host is read like the rest, never asked whether it has its own project.
    expect(count(rowFor("local"), "running")).toBe("1");
    expect(listWorktrees).toHaveBeenCalledWith({ hostId: "local" });
    expect(locate).toHaveBeenCalledWith({
      fromHostId: "local",
      projectId: PROJECT,
      toHostIds: ["linux", "away"],
    });
  });

  it("keeps the same rows in the same order from a window on another host, marking that one", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "linux" } as typeof window.__DAINTREE_HOST_ID__;
    lists.linux = [worktree(PROJECT, "feature/c", [working("t1")])];
    presence = [{ hostId: "local", projects: [{ projectId: "local-p", name: "h", path: "/p" }] }];
    lists.local = [worktree("local-p", "develop", [working("l1"), working("l2")])];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("local"), "running")).toBe("2"));
    expect(hostOrder()).toEqual(["local", "away", "linux"]);
    expect(rowFor("linux").getAttribute("aria-current")).toBe("true");
    expect(count(rowFor("linux"), "running")).toBe("1");
    expect(locate).toHaveBeenCalledWith({
      fromHostId: "linux",
      projectId: PROJECT,
      toHostIds: ["local"],
    });
  });

  it("counts a host's agents by the band that host observed, naming the ones asking", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("linux"), "running")).toBe("2"));
    const row = rowFor("linux");
    // Agents, not worktrees: feature/c's working agent counts beside feature/d's.
    // The asking agent is named under the row rather than counted on it, and a
    // zero draws nothing; each band keeps its own column.
    expect(
      [...row.querySelectorAll("[data-band]")].map((el) => el.getAttribute("data-band"))
    ).toEqual(["running"]);
    // Settled agents and other projects' agents never count.
    expect(row.querySelector('[data-band="done"]')).toBeNull();
    expect(row.getAttribute("aria-label")).toBe(
      "name-linux: 1 waiting, 2 working, 1 finished (observed)"
    );
    const asks = screen.getAllByTestId("project-hosts-ask-row");
    expect(asks).toHaveLength(1);
    // The branch without its type prefix, which is where an issue number starts.
    expect(asks[0]!.textContent).toBe("cWaiting");
    expect(asks[0]!.getAttribute("aria-label")).toBe("feature/c on name-linux, waiting (observed)");
  });

  it("lands on an asking agent's pane on its host, or on this one without switching", async () => {
    lists.local = [worktree(PROJECT, "feature/here", [waiting("l1")])];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(screen.getAllByTestId("project-hosts-ask-row")).toHaveLength(2));
    const [here, there] = screen.getAllByTestId("project-hosts-ask-row");

    fireEvent.click(there!);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p", {
      focusIntent: { intent: "focus-panel", panelId: "t1" },
    });
    fireEvent.click(there!, { metaKey: true });
    expect(switchToHost).toHaveBeenLastCalledWith("linux", true, "remote-p", {
      focusIntent: { intent: "focus-panel", panelId: "t1" },
    });

    fireEvent.click(here!);
    expect(dispatch).toHaveBeenLastCalledWith(
      "pilot.openRun",
      { runId: "l1", workspaceId: PROJECT },
      { source: "user" }
    );
    expect(switchToHost).toHaveBeenCalledTimes(2);
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

  it("opens the switch dialog for a host with no copy, and dials one that isn't connected", async () => {
    presence = [{ hostId: "linux", projects: [] }];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(rowFor("linux").textContent).toContain("Not added"));
    fireEvent.click(rowFor("linux"));
    expect(openProjectOnHost).toHaveBeenLastCalledWith("linux", PROJECT, false, "user");
    expect(switchToHost).not.toHaveBeenCalled();

    // Never matched this session: the switch lands on whatever that host last showed.
    fireEvent.click(rowFor("away"));
    expect(switchToHost).toHaveBeenLastCalledWith("away", false, undefined);
  });

  it("expands a host's asking agents past the first two in place", async () => {
    lists.linux = ["a", "b", "c", "d"].map((name, i) =>
      worktree("remote-p", `feature/${name}`, [waiting(`t${i}`)])
    );
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(screen.getAllByTestId("project-hosts-ask-row")).toHaveLength(2));
    const more = screen.getByTestId("project-hosts-more-row");
    expect(more.textContent).toBe("2 more");
    fireEvent.click(more);
    expect(switchToHost).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("project-hosts-ask-row")).toHaveLength(4);
    expect(screen.queryByTestId("project-hosts-more-row")).toBeNull();
  });

  it("reads a host from before agents were listed by its worktrees' top bands, landing on the next one waiting", async () => {
    const { runs: _runs, ...old } = worktree("remote-p", "feature/c", [waiting("t1")]);
    lists.linux = [old];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    const asks = await screen.findAllByTestId("project-hosts-ask-row");
    fireEvent.click(asks[0]!);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p", {
      focusIntent: { intent: "focus-next-waiting" },
    });
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
    await reread([
      worktree("remote-p", "develop", [
        { terminalId: "t4", band: "done", agentState: "completed" },
      ]),
    ]);
    // Agents in bands the row doesn't count: how many, never a verdict on what they are doing.
    await waitFor(() => expect(rowFor("linux").textContent).toContain("1 agent"));
    expect(countsShown(rowFor("linux"))).toBe("");
    expect(rowFor("linux").getAttribute("aria-label")).toBe("name-linux: 1 finished (observed)");
    // A host lists nothing for a project it couldn't read too: said as listed, not as "closed".
    await reread([]);
    await waitFor(() => expect(rowFor("linux").textContent).toContain("No worktrees"));
  });

  it("shows a dropped host in its link's words, in its place, and nothing it said before", async () => {
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    await screen.findAllByTestId("project-hosts-ask-row");

    hostList.hosts = [host("linux", false), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    expect(hostOrder()).toEqual(["local", "away", "linux"]);
    const row = rowFor("linux");
    expect(row.textContent).toContain("Not connected");
    expect(row.querySelector("[data-band]")).toBeNull();
    expect(screen.queryAllByTestId("project-hosts-ask-row")).toHaveLength(0);
    // Still the copy it was matched with.
    fireEvent.click(row);
    expect(switchToHost).toHaveBeenLastCalledWith("linux", false, "remote-p");

    presence = [{ hostId: "linux", projects: [] }];
    hostList.hosts = [host("linux"), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(rowFor("linux").textContent).toContain("Not added"));
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
    expect(screen.queryAllByTestId("project-hosts-ask-row")).toHaveLength(0);
  });

  it("reads a host again when it says its list changed, and only that host", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await screen.findAllByTestId("project-hosts-ask-row");
    const linuxReads = () => listWorktrees.mock.calls.filter(([a]) => a.hostId === "linux").length;
    expect(linuxReads()).toBe(1);

    lists.linux = [worktree("remote-p", "feature/c", [working("t1")])];
    await act(async () => {
      emit({ type: "worktrees", hostId: "elsewhere" });
      emit({ type: "worktrees", hostId: "linux" });
    });
    await waitFor(() => expect(screen.queryAllByTestId("project-hosts-ask-row")).toHaveLength(0));
    expect(count(rowFor("linux"), "running")).toBe("1");
    expect(linuxReads()).toBe(2);
  });

  it("finds this project on a host that gains it later, when that host says its list changed", async () => {
    presence = [{ hostId: "linux", projects: [] }];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(rowFor("linux").textContent).toContain("Not added"));

    presence = [has("linux")];
    await act(async () => {
      emit({ type: "worktrees", hostId: "linux" });
    });
    const asks = await screen.findAllByTestId("project-hosts-ask-row");
    expect(asks[0]!.getAttribute("aria-label")).toBe("feature/c on name-linux, waiting (observed)");
    expect(locate).toHaveBeenCalledTimes(2);
  });

  it("never counts a host's agents for a project it no longer matches", async () => {
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    await screen.findAllByTestId("project-hosts-ask-row");

    // The host reconnects matching through another checkout, whose read fails.
    hostList.hosts = [host("linux", false), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    presence = [has("linux", "moved-p")];
    listWorktrees.mockRejectedValue(new Error("link dropped"));
    hostList.hosts = [host("linux"), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(locate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(countsShown(rowFor("linux"))).toBe(""));
    expect(screen.queryAllByTestId("project-hosts-ask-row")).toHaveLength(0);
    // The old checkout's read is not this one's, so it isn't "No worktrees" either: nothing yet.
    expect(rowFor("linux").dataset.status).toBe("none");
  });

  it("never carries the last project's counts over to a new one while its own answer is out", async () => {
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    await screen.findAllByTestId("project-hosts-ask-row");

    locate.mockImplementationOnce(() => new Promise<HostProjectPresence[]>(() => {}));
    rerender(<ProjectHostsGroup projectId={"b".repeat(64)} />);
    expect(countsShown(rowFor("linux"))).toBe("");
    expect(screen.queryAllByTestId("project-hosts-ask-row")).toHaveLength(0);
  });

  it("forgets a host's copy once a connected answer says it's gone, and offers to set one up", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await screen.findAllByTestId("project-hosts-ask-row");

    // The checkout is removed on the host: its list no longer has the project,
    // and asked again, it says so.
    lists.linux = [worktree("someone-else", "other/x")];
    presence = [{ hostId: "linux", projects: [] }];
    await act(async () => {
      emit({ type: "worktrees", hostId: "linux" });
    });
    await waitFor(() => expect(rowFor("linux").textContent).toContain("Not added"));
    expect(countsShown(rowFor("linux"))).toBe("");
    expect(screen.queryAllByTestId("project-hosts-ask-row")).toHaveLength(0);
    fireEvent.click(rowFor("linux"));
    expect(openProjectOnHost).toHaveBeenLastCalledWith("linux", PROJECT, false, "user");
    expect(switchToHost).not.toHaveBeenCalled();
  });

  it("says it couldn't check a host whose lookup failed, and opens the switch dialog for it", async () => {
    presence = [{ hostId: "linux", projects: null }];
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(rowFor("linux").textContent).toContain("Couldn't check"));
    fireEvent.click(rowFor("linux"), { metaKey: true });
    expect(openProjectOnHost).toHaveBeenLastCalledWith("linux", PROJECT, true, "user");
  });

  it("shows nothing for a host while its first answer is out", async () => {
    locate.mockImplementationOnce(() => new Promise<HostProjectPresence[]>(() => {}));
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("local"), "running")).toBe("1"));
    expect(rowFor("linux").dataset.status).toBe("none");
    expect(rowFor("linux").textContent).toBe("name-linux");
  });

  it("asks nothing while the window's own host is away, and asks once it is back", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "linux" } as typeof window.__DAINTREE_HOST_ID__;
    hostList.hosts = [host("linux", false), host("away", false)];
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    expect(rowFor("linux").getAttribute("aria-current")).toBe("true");
    expect(rowFor("linux").textContent).toContain("Not connected");
    expect(locate).not.toHaveBeenCalled();
    fireEvent.click(rowFor("linux"));
    expect(switchToHost).not.toHaveBeenCalled();

    presence = [{ hostId: "local", projects: [{ projectId: "local-p", name: "h", path: "/p" }] }];
    lists.local = [worktree("local-p", "develop", [working("l1")])];
    lists.linux = [worktree(PROJECT, "feature/c", [working("t1")])];
    hostList.hosts = [host("linux"), host("away", false)];
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    await waitFor(() => expect(count(rowFor("local"), "running")).toBe("1"));
    expect(count(rowFor("linux"), "running")).toBe("1");
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it('keeps focus in the list when a focused "more" row expands, on the first agent it revealed', async () => {
    lists.linux = ["a", "b", "c", "d"].map((name, i) =>
      worktree("remote-p", `feature/${name}`, [waiting(`t${i}`)])
    );
    render(<ProjectHostsGroup projectId={PROJECT} />);
    const more = await screen.findByTestId("project-hosts-more-row");
    more.focus();
    fireEvent.click(more);
    const asks = screen.getAllByTestId("project-hosts-ask-row");
    expect(asks).toHaveLength(4);
    expect(document.activeElement).toBe(asks[2]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(asks[3]);
  });

  it("folds a host's asks again when the project changes and comes back", async () => {
    lists.linux = ["a", "b", "c", "d"].map((name, i) =>
      worktree("remote-p", `feature/${name}`, [waiting(`t${i}`)])
    );
    const { rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    fireEvent.click(await screen.findByTestId("project-hosts-more-row"));
    expect(screen.getAllByTestId("project-hosts-ask-row")).toHaveLength(4);

    rerender(<ProjectHostsGroup projectId={"b".repeat(64)} />);
    rerender(<ProjectHostsGroup projectId={PROJECT} />);
    await screen.findByTestId("project-hosts-more-row");
    expect(screen.getAllByTestId("project-hosts-ask-row")).toHaveLength(2);
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

  it("asks nothing without another host, or in a scratch view", () => {
    hostList.hosts = [];
    const { container, rerender } = render(<ProjectHostsGroup projectId={PROJECT} />);
    hostList.hosts = [host("linux")];
    rerender(<ProjectHostsGroup projectId="0f8fad5b-d9cb-469f-a165-70867728950e" />);
    expect(locate).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("collapses under a header naming the project, keeping every host's totals, for every view", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await screen.findAllByTestId("project-hosts-ask-row");
    const toggle = screen.getByTestId("project-hosts-toggle");
    expect(toggle.textContent).toContain("helios across hosts");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(0);
    expect(localStorage.getItem(PROJECT_HOSTS_EXPANDED_KEY)).toBe("false");
    // One asking on linux; two working there and one on this machine.
    const totals = screen.getByTestId("project-hosts-totals");
    expect(totals.querySelector('[data-total="asking"]')?.textContent).toBe("1");
    expect(totals.querySelector('[data-total="working"]')?.textContent).toBe("3");
    // The toggle's name never changes with its state; the totals describe it.
    expect(toggle.getAttribute("aria-label")).toBe("helios across hosts");
    const described = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("1 asking, 3 working (observed)");

    // Another project view opens it again: this one follows.
    localStorage.setItem(PROJECT_HOSTS_EXPANDED_KEY, "true");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: PROJECT_HOSTS_EXPANDED_KEY }));
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rows()).toHaveLength(3);
  });

  it("moves between the section's rows with the arrow keys", async () => {
    render(<ProjectHostsGroup projectId={PROJECT} />);
    await screen.findAllByTestId("project-hosts-ask-row");
    const toggle = screen.getByTestId("project-hosts-toggle");
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    toggle.focus();
    // The header, then every row in its order: this machine, name-away, name-linux and its ask.
    press("ArrowDown");
    expect(document.activeElement).toBe(rowFor("local"));
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(rowFor("linux"));
    press("ArrowDown");
    expect(document.activeElement).toBe(screen.getByTestId("project-hosts-ask-row"));
    press("ArrowDown");
    expect(document.activeElement).toBe(screen.getByTestId("project-hosts-ask-row"));
    press("Home");
    expect(document.activeElement).toBe(toggle);
    press("ArrowUp");
    expect(document.activeElement).toBe(toggle);
    press("End");
    expect(document.activeElement).toBe(screen.getByTestId("project-hosts-ask-row"));
  });
});
