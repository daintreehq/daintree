// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { CanopyHostEvent } from "@shared/types/ipc/canopyHost";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type { AgentDirectory, AgentDirectoryLiveEntry } from "@shared/types/agentDirectory";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { HostListEntry, HostMetricsSummary } from "@shared/types/remoteHosts";

const state = vi.hoisted(() => ({
  hosts: [] as HostListEntry[],
  localSummary: null as HostMetricsSummary | null,
  listeners: new Set<(event: CanopyHostEvent) => void>(),
  invoke: vi.fn(),
  release: vi.fn(async () => {}),
  dispatch: vi.fn(async () => ({ ok: true })),
  retryHostProjects: vi.fn(),
  switchWindowHost: vi.fn(),
  reportError: vi.fn(),
  readWork: vi.fn(async (_hostId: string) => Promise.reject(new Error("no records"))),
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});
vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => true,
  isRemoteHostSupported: () => true,
  isEitherRemoteRoleSupported: () => true,
}));
vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => ({ hosts: state.hosts, localSummary: state.localSummary }),
  useHostFigures: () => ({ hosts: state.hosts, localSummary: state.localSummary }),
  getHostListSnapshot: () => ({ hosts: state.hosts, localSummary: state.localSummary }),
  hasRemoteHosts: (list: { hosts: HostListEntry[] }) => list.hosts.length > 0,
}));
vi.mock("@/components/Hosts/hostProjects", () => ({
  useHostProjectLists: (hostIds: readonly string[]) =>
    new Map(
      hostIds.map((id) => [id, [{ id: "p1", name: "server-app", path: "/srv/app" }]] as const)
    ),
  retryHostProjects: state.retryHostProjects,
}));
vi.mock("@/clients/canopyHostClient", () => ({
  canopyHostClient: {
    invoke: state.invoke,
    release: state.release,
    readAssistantWork: state.readWork,
    onEvent: (callback: (event: CanopyHostEvent) => void) => {
      state.listeners.add(callback);
      return () => state.listeners.delete(callback);
    },
  },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: state.dispatch, has: () => false },
}));
vi.mock("../CanopyTerminal", () => ({
  CanopyTerminal: ({ runId }: { runId: string }) => (
    <div data-canopy-terminal="" data-run={runId} />
  ),
}));
vi.mock("@/components/Terminal/HybridInputBar", () => ({ HybridInputBar: () => null }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/rendererGlobalErrorHandlers", () => ({
  reportRendererGlobalError: state.reportError,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { CanopyView } from "../CanopyView";
import { ALL_HOSTS_ID, useCanopyStore } from "@/store/canopyStore";
import { usePanelStore } from "@/store/panelStore";
import { allHostsKey } from "../canopyAllHosts";
import { notify } from "@/lib/notify";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

const NOW = Date.now();
const HANDSHAKE = {
  version: "1.0.0",
  commit: "abc",
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
} as const;

function summary(hostId: string, waiting: number, working: number): HostMetricsSummary {
  return {
    hostId,
    sampledAt: NOW,
    platform: "linux",
    cpuPercent: null,
    memoryPressure: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    thermal: null,
    cpuPressure: null,
    agentsObserved: { working, waiting, idle: 0 },
    agentAttention: { waiting, blocked: 0, idle: 0 },
    projectCount: 1,
    worktreeCount: 1,
    driver: null,
    agentClis: [],
  };
}

function host(
  id: string,
  name: string,
  connection: HostListEntry["connection"] = { status: "connected", rttMs: 1, handshake: HANDSHAKE }
): HostListEntry {
  return {
    descriptor: {
      id,
      name,
      connection: { kind: "ssh", target: `greg@${name}` },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection,
    summary: connection.status === "connected" ? summary(id, 2, 1) : null,
  };
}

function canopySnapshot(overrides: Partial<CanopySnapshot> = {}): CanopySnapshot {
  return {
    mode: "on",
    activated: true,
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: true,
    busy: false,
    refreshedAt: NOW,
    cards: [],
    lastError: null,
    failedRuns: [],
    glances: [],
    ...overrides,
  };
}

function fleet(runIds: string[]): FleetSnapshot {
  return {
    runs: runIds.map((runId) => ({
      runId,
      workspaceId: "p1",
      spawnedAt: NOW - 3_600_000,
      cwd: "/srv/app",
      agentId: "claude" as const,
      agentState: "waiting" as const,
      waitingReason: "approval" as const,
      since: NOW - 60_000,
    })),
    changedAt: NOW,
    degraded: false,
    lastSuccessfulAt: NOW,
  };
}

/** A described approval, answerable from the list by its number. */
function approvalCard(runId: string): CanopySnapshot["cards"][number] {
  return {
    runId,
    spawnedAt: NOW - 3_600_000,
    revision: 2,
    category: "approval",
    confidence: 0.9,
    attentionProbability: 0.9,
    attentionScore: 95,
    priority: 95,
    stage: "described",
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    wordsCategory: "approval",
    describing: false,
    task: null,
    headline: "Wants to run the migration",
    summary: null,
    question: "Do you want to proceed?",
    options: ["Yes", "No"],
    secretPrompt: false,
    risk: "none",
    riskReason: null,
    action: null,
    progress: null,
    steps: null,
    tests: "unknown",
    changes: "unknown",
    handledAt: null,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: null,
    observedAt: NOW + 10_000,
  };
}

/** A settled reading of an agent at work: nothing in it asks for the user. */
function calmCard(runId: string): CanopySnapshot["cards"][number] {
  return {
    ...approvalCard(runId),
    category: "working",
    wordsCategory: "working",
    attentionProbability: 0.05,
    attentionScore: 5,
    priority: 5,
    headline: "Running the suite",
    question: null,
    options: [],
  };
}

/** Runs at work, none of them waiting. */
function workingFleet(runIds: string[]): FleetSnapshot {
  const base = fleet(runIds);
  return {
    ...base,
    runs: base.runs.map(({ waitingReason: _reason, ...run }) => ({
      ...run,
      agentState: "working" as const,
    })),
  };
}

function summaryWords() {
  return document.querySelector("[data-testid=canopy-summary]")?.textContent ?? "";
}

function bandWords() {
  return (
    document.querySelector(
      "[role=group][aria-labelledby=canopy-needs-you-label] [data-canopy-empty-line]"
    )?.textContent ?? null
  );
}

let remoteCanopy: CanopySnapshot = canopySnapshot();
let remoteFleet: FleetSnapshot | null = fleet(["remote-run"]);

function installElectron() {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => canopySnapshot()),
    setScope: vi.fn(async () => {}),
    setShown: vi.fn(async () => {}),
    setRead: vi.fn(async () => null),
    archive: vi.fn(async (): Promise<unknown> => null),
    unarchive: vi.fn(async () => {}),
    markSeen: vi.fn(async () => {}),
    runBranch: vi.fn(async () => "main"),
    searchScreens: vi.fn(async () => [] as string[]),
    answer: vi.fn(async () => {}),
    trash: vi.fn(async () => null),
    untrash: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    setMode: vi.fn(async () => canopySnapshot()),
    // No assistants: a full, empty directory of this machine.
    readAgentDirectory: vi.fn(async (): Promise<AgentDirectory> => ({
      coverage: "ok" as const,
      observedAt: 1,
      complete: true,
      omitted: 0,
      entries: [],
    })),
  };
  Object.defineProperty(window, "electron", {
    value: {
      canopy,
      system: { openExternal: vi.fn() },
      remoteHosts: { switchWindowHost: state.switchWindowHost },
    },
    configurable: true,
    writable: true,
  });
  return canopy;
}

/** Past the panel's wait on the typing before it reads terminals for a search. */
const SCREEN_SEARCH_SETTLE_MS = 250;

async function screenSearchSettled() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SCREEN_SEARCH_SETTLE_MS));
  });
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function channelsCalled(): string[] {
  return state.invoke.mock.calls.map((call) => `${String(call[0])} ${String(call[1])}`);
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

beforeEach(() => {
  __resetCanopyPlaceForTests();
  __resetCanopySeenForTests();
  state.hosts = [host("studio", "studio-01")];
  state.localSummary = summary("local", 0, 3);
  remoteCanopy = canopySnapshot();
  remoteFleet = fleet(["remote-run"]);
  state.invoke.mockImplementation(async (_hostId: string, channel: string) => {
    if (channel === "canopy:set-active") return remoteCanopy;
    if (channel === "fleet:get-snapshot") return remoteFleet;
    if (channel === "canopy:run-branch") return "remote-branch";
    if (channel === "canopy:trash") return 7;
    return null;
  });
  state.switchWindowHost.mockResolvedValue({
    outcome: "switched",
    hostId: "studio",
    projectId: "p1",
  });
  useProjectStore.setState({
    projects: [{ id: "p1", path: "/repo", name: "local-app", emoji: "🌳", lastOpened: NOW }],
  });
  useFleetSnapshotStore.setState({ snapshot: fleet(["local-run"]) });
  useCanopyStore.setState({
    isOpen: true,
    snapshot: canopySnapshot(),
    mode: "on",
    hostId: null,
    scope: "all",
    orders: {},
    hostOrders: {},
  });
});

afterEach(() => {
  cleanup();
  state.listeners.clear();
  useCanopyStore.setState({ isOpen: false, snapshot: null, mode: "unset", hostId: null });
  window.localStorage.removeItem("daintree-canopy-order");
  vi.clearAllMocks();
});

describe("the Canopy host picker", () => {
  it("isn't there for anyone with no other host", async () => {
    state.hosts = [];
    installElectron();
    render(<CanopyView />);
    await settle();
    expect(screen.queryByTestId("canopy-host-picker")).toBeNull();
  });

  it("opens on the window's own host, and lists This Mac first with each host's agents", async () => {
    installElectron();
    render(<CanopyView />);
    await settle();
    const picker = screen.getByTestId("canopy-host-picker");
    expect(picker.getAttribute("data-host-id")).toBe("local");
    fireEvent.keyDown(picker, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const [allHosts, ...rows] = [...menu.querySelectorAll<HTMLElement>("[data-host-id]")];
    // All hosts leads the list; it is a scope, not a host.
    expect(allHosts!.getAttribute("data-host-id")).toBe("*");
    expect(allHosts!.getAttribute("aria-checked")).toBe("false");
    expect(rows.map((row) => row.getAttribute("data-host-id"))).toEqual(["local", "studio"]);
    expect(rows[0]!.getAttribute("aria-checked")).toBe("true");
    // Waiting first, then working, as the host switcher draws them.
    expect(rows[1]!.querySelector("[data-host-agents]")?.textContent).toContain(
      "Agents: 2 waiting, 1 working"
    );
    // Nothing is read from another host until it is picked.
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it("searches the picked host's terminals on that host, never this one's", async () => {
    const own = installElectron();
    render(<CanopyView />);
    await settle();
    act(() => useCanopyStore.getState().setHostId("studio"));
    await settle();
    const input = document.querySelector<HTMLInputElement>("input[role=combobox]")!;
    await act(async () => {
      fireEvent.change(input, { target: { value: "segfault" } });
    });
    await screenSearchSettled();
    const asked = state.invoke.mock.calls.filter((call) => call[1] === "canopy:search-screens");
    expect(asked).toHaveLength(1);
    expect(asked[0]![0]).toBe("studio");
    expect(asked[0]![2]).toEqual([
      expect.objectContaining({ runId: "remote-run", terms: ["segfault"] }),
    ]);
    expect(own.searchScreens).not.toHaveBeenCalled();
  });

  it("draws no counts for a host that isn't connected, rather than zero", async () => {
    state.hosts = [host("studio", "studio-01", { status: "disconnected" })];
    installElectron();
    render(<CanopyView />);
    await settle();
    fireEvent.keyDown(screen.getByTestId("canopy-host-picker"), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const studio = menu.querySelector<HTMLElement>('[data-host-id="studio"]')!;
    expect(studio.querySelector("[data-host-agents]")?.textContent).toBe("");
    expect(studio.textContent).toContain("Not connected");
  });

  it("shows the picked host's agents, named from its own projects, and leaves this host's alone", async () => {
    const own = installElectron();
    render(<CanopyView />);
    await settle();
    own.setActive.mockClear();
    own.setShown.mockClear();
    own.runBranch.mockClear();
    act(() => useCanopyStore.getState().setHostId("studio"));
    await settle();

    const rows = [...document.querySelectorAll<HTMLElement>("[data-canopy-card]")];
    expect(rows.map((row) => row.id)).toEqual(["canopy-card-remote-run"]);
    expect(document.body.textContent).toContain("server-app");
    expect(document.body.textContent).not.toContain("Unknown workspace");
    expect(channelsCalled()).toContain("studio canopy:set-active");
    expect(channelsCalled()).toContain("studio canopy:set-shown");
    // This host's panel stood down; nothing of the other host reached it.
    expect(own.setShown).not.toHaveBeenCalled();
    expect(own.setActive).toHaveBeenCalledWith(false);
    // The branch line is the run's own host's.
    expect(own.runBranch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("remote-branch");
    // The toolbar still counts this host: its snapshot is untouched.
    expect(useCanopyStore.getState().snapshot?.refreshedAt).toBe(NOW);
    // All projects only: "This project" means this window's.
    expect(screen.queryByRole("radiogroup", { name: "Agents to show" })).toBeNull();
  });

  it("shows another host's run live and answers it there", async () => {
    const own = installElectron();
    remoteCanopy = canopySnapshot({ cards: [approvalCard("remote-run")] });
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    const row = document.getElementById("canopy-card-remote-run")!;
    // Its live terminal, read from that host.
    expect(document.querySelector('[data-canopy-terminal][data-run="remote-run"]')).not.toBeNull();
    act(() => row.focus());

    await act(async () => {
      fireEvent.keyDown(row, { key: "1" });
    });
    await settle();
    expect(state.invoke).toHaveBeenCalledWith(
      "studio",
      "canopy:answer",
      "remote-run",
      { spawnedAt: NOW - 3_600_000 },
      "Yes"
    );
    expect(own.answer).not.toHaveBeenCalled();

    fireEvent.keyDown(row, { key: "e" });
    await settle();
    expect(state.invoke).toHaveBeenCalledWith(
      "studio",
      "canopy:archive",
      "remote-run",
      expect.objectContaining({ spawnedAt: NOW - 3_600_000 })
    );
    expect(own.archive).not.toHaveBeenCalled();
  });

  it("goes to another host's run by moving the window to its project, focusing its pane there", async () => {
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to terminal" }));
    });
    await settle();
    expect(state.switchWindowHost).toHaveBeenCalledWith({
      hostId: "studio",
      newWindow: false,
      projectId: "p1",
      focusIntent: { intent: "focus-panel", panelId: "remote-run" },
    });
    // Never this host's own navigation: the run's terminal isn't here.
    expect(state.dispatch).not.toHaveBeenCalled();
    // Closed only once the switch landed.
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("opens another host's run in a new window on a modified click", async () => {
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    // Both modifiers, so the platform's own new-window key is among them.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to terminal" }), {
        metaKey: true,
        ctrlKey: true,
      });
    });
    await settle();
    expect(state.switchWindowHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "studio", newWindow: true, projectId: "p1" })
    );
  });

  it("stays open when going to another host's run didn't move anything", async () => {
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();

    state.switchWindowHost.mockResolvedValueOnce({ outcome: "superseded", hostId: "studio" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to terminal" }));
    });
    await settle();
    expect(useCanopyStore.getState().isOpen).toBe(true);

    vi.mocked(notify).mockClear();
    state.switchWindowHost.mockRejectedValueOnce(new Error("The host went away"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to terminal" }));
    });
    await settle();
    expect(useCanopyStore.getState().isOpen).toBe(true);
    // The host switch's own failure, with the same switch to try again.
    const toast = vi.mocked(notify).mock.calls.at(-1)![0];
    expect(toast.title).toBe("Couldn't switch to studio-01");
    state.switchWindowHost.mockClear();
    await act(async () => {
      void toast.actions?.find((action) => action.label === "Retry")?.onClick();
    });
    expect(state.switchWindowHost).toHaveBeenCalledWith({
      hostId: "studio",
      newWindow: false,
      projectId: "p1",
      focusIntent: { intent: "focus-panel", panelId: "remote-run" },
    });
    // The retry landed: the panel closes as the first try would have.
    await settle();
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("closes once the window already showing the run's project came forward", async () => {
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    state.switchWindowHost.mockResolvedValueOnce({
      outcome: "focused-elsewhere",
      hostId: "studio",
      projectId: "p1",
      targetWindowId: 2,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to terminal" }));
    });
    await settle();
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("leaves the panel open when the user moved to another host before the switch landed", async () => {
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    let land: (result: unknown) => void = () => {};
    state.switchWindowHost.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Go to terminal" }));
    });
    act(() => useCanopyStore.getState().setHostId(null));
    await settle();
    await act(async () => {
      land({ outcome: "focused-elsewhere", hostId: "studio", projectId: "p1", targetWindowId: 2 });
    });
    await settle();
    expect(useCanopyStore.getState().isOpen).toBe(true);
  });

  it("renames another host's run on that host", async () => {
    const own = installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    const row = document.getElementById("canopy-card-remote-run")!;
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "F2" });
    await settle();
    const field = document.querySelector<HTMLInputElement>(
      "[data-canopy-detail] [data-canopy-rename] input"
    )!;
    fireEvent.change(field, { target: { value: "auth fix" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(state.invoke).toHaveBeenCalledWith(
      "studio",
      "canopy:rename",
      "remote-run",
      { spawnedAt: NOW - 3_600_000 },
      "auth fix"
    );
    expect(own.rename).not.toHaveBeenCalled();
  });

  it("trashes another host's run there, and takes it back there", async () => {
    const own = installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    const row = document.getElementById("canopy-card-remote-run")!;
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "Backspace", metaKey: true, ctrlKey: true });
    vi.mocked(notify).mockClear();
    await act(async () => {
      fireEvent.keyDown(row, { key: "Backspace", metaKey: true, ctrlKey: true });
    });
    await settle();
    expect(state.invoke).toHaveBeenCalledWith("studio", "canopy:trash", "remote-run", {
      spawnedAt: NOW - 3_600_000,
    });
    expect(own.trash).not.toHaveBeenCalled();
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
    const line = document.querySelector("[data-canopy-undo-line]");
    expect(line?.textContent).toContain("Trashed '");

    // The receipt is the trashing host's: Z goes back there, and nowhere else.
    await act(async () => {
      fireEvent.keyDown(document.querySelector('[data-testid="canopy-dialog"]')!, { key: "z" });
    });
    expect(state.invoke).toHaveBeenCalledWith("studio", "canopy:untrash", 7);
    expect(own.untrash).not.toHaveBeenCalled();
  });

  it("starts another host's list afresh: no run open from the last, and Z takes nothing back from it", async () => {
    const own = installElectron();
    let land: (mark: unknown) => void = () => {};
    own.archive.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    useFleetSnapshotStore.setState({ snapshot: fleet(["local-run", "shared"]) });
    // The same run id on the other host, under a run that ranks above it.
    remoteFleet = fleet(["remote-first", "shared"]);
    remoteCanopy = canopySnapshot({ cards: [approvalCard("remote-first")] });
    render(<CanopyView />);
    await settle();
    const row = document.getElementById("canopy-card-local-run")!;
    act(() => row.focus());
    // Archiving moves the cursor on, onto the run whose id the other host shares.
    fireEvent.keyDown(row, { key: "e" });
    expect(own.archive).toHaveBeenCalledWith("local-run", { spawnedAt: NOW - 3_600_000 });
    expect(document.getElementById("canopy-detail-shared")).not.toBeNull();

    act(() => useCanopyStore.getState().setHostId("studio"));
    await settle();
    expect(document.getElementById("canopy-detail-remote-first")).not.toBeNull();
    expect(document.getElementById("canopy-detail-shared")).toBeNull();

    // Pressed before main answers this host's archive, and again after: neither is its Z.
    const remoteRow = document.getElementById("canopy-card-remote-first")!;
    fireEvent.keyDown(remoteRow, { key: "z" });
    await act(async () => {
      land({
        runId: "local-run",
        spawnedAt: NOW - 3_600_000,
        turn: 1,
        readTurn: 1,
        markedUnreadAt: null,
        version: 2,
      });
    });
    fireEvent.keyDown(remoteRow, { key: "z" });
    await settle();
    expect(own.unarchive).not.toHaveBeenCalled();
    expect(channelsCalled()).not.toContain("studio canopy:unarchive");
  });

  it("lands on Go to terminal's run on another host, not one there sharing the focused agent's id", async () => {
    useFleetSnapshotStore.setState({ snapshot: fleet(["shared"]) });
    remoteFleet = fleet(["remote-first", "remote-resume", "shared"]);
    usePanelStore.setState({
      panelsById: {
        shared: { id: "shared", kind: "terminal", location: "grid", detectedAgentId: "claude" },
      } as never,
      focusedId: "shared",
    });
    try {
      useCanopyStore.setState({
        isOpen: false,
        resume: {
          at: Date.now(),
          hostId: "studio",
          query: "",
          runId: "remote-resume",
          order: ["remote-first", "remote-resume", "shared"],
        },
      });
      act(() => useCanopyStore.getState().open());
      installElectron();
      render(<CanopyView />);
      await settle();
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      expect(useCanopyStore.getState().hostId).toBe("studio");
      expect(document.getElementById("canopy-card-shared")).not.toBeNull();
      // Neither the list's default nor the focused agent's id: Go to terminal's run.
      expect(document.querySelector("[data-canopy-card]")?.id).toBe("canopy-card-remote-first");
      expect(
        document
          .querySelector('[data-canopy-card][aria-selected="true"]')
          ?.id.replace(/^canopy-card-/, "")
      ).toBe("remote-resume");
    } finally {
      usePanelStore.setState({ panelsById: {} as never, focusedId: null });
      useCanopyStore.setState({ resume: null });
    }
  });

  it("presses no answer into another host's run while the link to it is down", async () => {
    installElectron();
    // Its agents were read; the link has dropped since.
    state.hosts = [host("studio", "studio-01", { status: "connecting", attempt: 1 })];
    remoteCanopy = canopySnapshot({ cards: [approvalCard("remote-run")] });
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    const row = document.getElementById("canopy-card-remote-run")!;
    act(() => row.focus());
    await act(async () => {
      fireEvent.keyDown(row, { key: "1" });
    });
    expect(channelsCalled()).not.toContain("studio canopy:answer");
  });

  it("keeps the picked host's order apart from this host's", async () => {
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    const stored: unknown = JSON.parse(
      window.localStorage.getItem("daintree-canopy-order") ?? "{}"
    );
    expect(stored).toEqual({ "studio|all": ["remote-run"] });
  });

  it("offers Canopy for the picked host by name when it is off there, and turns it on there", async () => {
    const own = installElectron();
    remoteCanopy = canopySnapshot({ mode: "unset", activated: false });
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    // Its agents stay listed as it observed them, with the offer one press away.
    expect(document.body.textContent).not.toContain("Canopy is off on studio-01");
    const bar = document.querySelector<HTMLElement>("[data-canopy-status]")!;
    fireEvent.click(within(bar).getByRole("button", { name: "Turn on reading" }));
    await settle();
    expect(document.body.textContent).toContain("Canopy is off on studio-01");
    expect(document.querySelector("[data-canopy-card]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn on Canopy on studio-01" }));
    await settle();
    expect(state.invoke).toHaveBeenCalledWith("studio", "canopy:set-mode", "on");
    expect(own.setMode).not.toHaveBeenCalled();
  });

  it("offers reading above the picked host's agents by its name, opening that host's offer", async () => {
    installElectron();
    remoteCanopy = canopySnapshot({ mode: "unset", activated: false });
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    const callout = document.querySelector<HTMLElement>("[data-canopy-reading-offer]")!;
    expect(callout.textContent).toContain("on studio-01");
    // Above that host's own agents.
    const row = document.getElementById("canopy-card-remote-run")!;
    expect(callout.compareDocumentPosition(row)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    fireEvent.click(within(callout).getByRole("button", { name: "Turn on reading" }));
    await settle();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.body.textContent).toContain("Canopy is off on studio-01");
    expect(document.querySelector("[data-canopy-reading-offer]")).toBeNull();
    // The button left with the inbox: the keyboard lands on the offer's heading, not Turn on.
    expect(document.activeElement?.id).toBe("canopy-host-offer-title");
    expect(state.invoke).not.toHaveBeenCalledWith("studio", "canopy:set-mode", "on");
  });

  it("says why a host can't be reached, never showing another host's agents instead", async () => {
    state.hosts = [
      host("studio", "studio-01", {
        status: "unreachable",
        lastSeenAt: null,
        detail: null,
      }),
    ];
    state.invoke.mockRejectedValue(
      new Error("[AppError|HOST_DISCONNECTED] Host studio is not connected")
    );
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("Can't reach studio-01");
    expect(document.body.textContent).toContain("Unreachable.");
    expect(document.querySelector("[data-canopy-card]")).toBeNull();
    expect(state.reportError).not.toHaveBeenCalled();

    state.invoke.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(channelsCalled()).toContain("studio canopy:set-active");
  });

  it("reports no refusal from a host whose link is down, and still reports any other failure", async () => {
    state.hosts = [host("studio", "studio-01", { status: "disconnected" })];
    const refused = () =>
      Promise.reject(new Error("[AppError|HOST_DISCONNECTED] Host studio is not connected"));
    state.invoke.mockImplementation(refused);
    state.release.mockImplementation(refused);
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    expect(channelsCalled()).toContain("studio canopy:set-scope");
    expect(channelsCalled()).toContain("studio canopy:set-shown");
    act(() => useCanopyStore.getState().setHostId(null));
    await settle();
    expect(state.release).toHaveBeenCalledWith("studio");
    expect(state.reportError).not.toHaveBeenCalled();

    state.invoke.mockImplementation(async (_hostId: string, channel: string) => {
      if (channel === "canopy:set-scope") throw new Error("[AppError|INTERNAL] scope refused");
      return channel === "fleet:get-snapshot"
        ? remoteFleet
        : channel === "canopy:set-active"
          ? remoteCanopy
          : null;
    });
    act(() => useCanopyStore.getState().setHostId("studio"));
    await settle();
    expect(state.reportError).toHaveBeenCalledWith(
      "unhandledrejection",
      expect.objectContaining({ code: "INTERNAL" }),
      expect.anything()
    );
  });

  it("goes back to the window's own host when the host shown is removed", async () => {
    state.hosts = [host("studio", "studio-01"), host("lab", "lab-02")];
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    const { rerender } = render(<CanopyView />);
    await settle();
    state.hosts = [host("lab", "lab-02")];
    rerender(<CanopyView />);
    await settle();
    expect(useCanopyStore.getState().hostId).toBeNull();
    expect(screen.getByTestId("canopy-host-picker").getAttribute("data-host-id")).toBe("local");
    expect(state.release).toHaveBeenCalledWith("studio");
  });

  it("says the list is what the host last showed once its link drops", async () => {
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    const { rerender } = render(<CanopyView />);
    await settle();
    expect(document.body.textContent).not.toContain("Can't reach studio-01");
    state.hosts = [host("studio", "studio-01", { status: "disconnected" })];
    rerender(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("Can't reach studio-01");
    expect(document.body.textContent).toContain("These are the agents it last showed.");
    expect(document.getElementById("canopy-card-remote-run")).not.toBeNull();
  });

  it("draws no all-clear from a host's rows once its link drops", async () => {
    remoteFleet = workingFleet(["remote-run"]);
    remoteCanopy = canopySnapshot({ cards: [calmCard("remote-run")] });
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    const { rerender } = render(<CanopyView />);
    await settle();
    expect(summaryWords()).toBe("Nothing needs you");
    expect(bandWords()).toBe("No action needed");
    state.hosts = [host("studio", "studio-01", { status: "disconnected" })];
    rerender(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("These are the agents it last showed.");
    expect(document.getElementById("canopy-card-remote-run")).not.toBeNull();
    expect(summaryWords()).toBe("Can't tell who needs you right now");
    expect(bandWords()).toBe("Can't tell who needs you right now");
  });

  it("drops the warning on held rows once the link is back, while their reread is owed", async () => {
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    const { rerender } = render(<CanopyView />);
    await settle();
    state.hosts = [host("studio", "studio-01", { status: "disconnected" })];
    state.invoke.mockRejectedValue(
      new Error("[AppError|HOST_DISCONNECTED] Host studio is not connected")
    );
    rerender(<CanopyView />);
    await settle();
    // Read again while the link is down: refused, the rows kept.
    state.invoke.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(channelsCalled()).toContain("studio canopy:set-active");
    expect(document.body.textContent).toContain("These are the agents it last showed.");

    state.hosts = [host("studio", "studio-01")];
    rerender(<CanopyView />);
    await settle();
    expect(document.body.textContent).not.toContain("These are the agents it last showed.");
    expect(document.querySelector('[data-callout="warning"]')).toBeNull();
    expect(document.getElementById("canopy-card-remote-run")).not.toBeNull();
  });

  it("says it is connecting while picking a host dials it, not that it can't be reached", async () => {
    state.hosts = [host("studio", "studio-01", { status: "disconnected" })];
    // As main's refusal arrives across the bridge: the code rides in the message.
    state.invoke.mockRejectedValue(
      new Error("[AppError|HOST_DISCONNECTED] Host studio is not connected")
    );
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    const { rerender } = render(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("Connecting to studio-01…");
    expect(document.body.textContent).not.toContain("Can't reach studio-01");

    // The link is up a moment before the resync's reread lands.
    state.hosts = [host("studio", "studio-01")];
    rerender(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("Connecting to studio-01…");
    expect(document.body.textContent).not.toContain("Can't reach studio-01");
  });
});

describe("All hosts", () => {
  const cardOf = (hostId: string, runId: string) =>
    document.getElementById(`canopy-card-${allHostsKey(hostId, runId)}`);

  beforeEach(() => {
    remoteFleet = fleet(["shared-run"]);
    useFleetSnapshotStore.setState({ snapshot: fleet(["shared-run"]) });
    useCanopyStore.setState({ hostId: ALL_HOSTS_ID });
  });

  it("lists the runs of every host together, with the same run id on two hosts kept apart", async () => {
    installElectron();
    render(<CanopyView />);
    await settle();
    expect(cardOf("local", "shared-run")).not.toBeNull();
    expect(cardOf("studio", "shared-run")).not.toBeNull();
    // The project and the host, on the row.
    expect(cardOf("local", "shared-run")!.textContent).toContain("local-app");
    expect(cardOf("studio", "shared-run")!.textContent).toContain("server-app");
    expect(
      cardOf("studio", "shared-run")!.querySelector("[data-canopy-host]")?.textContent
    ).toContain("studio-01");
    expect(screen.getByTestId("canopy-host-picker").getAttribute("data-host-id")).toBe("*");
    // A read scope: no "This project" switch.
    expect(screen.queryByRole("radiogroup", { name: "Agents to show" })).toBeNull();
  });

  it("opens on this machine's run the main view has focused, never another host's under the same id", async () => {
    useFleetSnapshotStore.setState({ snapshot: fleet(["local-first", "shared-run"]) });
    remoteCanopy = canopySnapshot({ cards: [approvalCard("shared-run")] });
    usePanelStore.setState({
      panelsById: {
        "shared-run": {
          id: "shared-run",
          kind: "terminal",
          location: "grid",
          detectedAgentId: "claude",
        },
      } as never,
      focusedId: "shared-run",
    });
    try {
      installElectron();
      render(<CanopyView />);
      await settle();
      const selected = document.querySelector('[data-canopy-card][aria-selected="true"]');
      expect(document.querySelector("[data-canopy-card]")).not.toBe(cardOf("local", "shared-run"));
      expect(cardOf("studio", "shared-run")).not.toBeNull();
      expect(selected).toBe(cardOf("local", "shared-run"));
    } finally {
      usePanelStore.setState({ panelsById: {} as never, focusedId: null });
    }
  });

  it("names this machine on an assistant's place line, as on its workers', not in its name (#15370)", async () => {
    const own = installElectron();
    const entry = (
      scope: AgentDirectoryLiveEntry["subject"]["scope"],
      terminalId: string
    ): AgentDirectoryLiveEntry => ({
      state: "live",
      role: "assistant",
      subject: {
        hostId: "local",
        scope,
        terminalId,
        incarnation: 1,
        ...(scope.kind === "project" ? { lane: 0 } : {}),
      },
      agentId: "claude",
      agentState: "waiting",
      waitingReason: "prompt",
      since: NOW - 10_000,
      label: null,
      attached: true,
      handback: null,
    });
    own.readAgentDirectory.mockResolvedValue({
      coverage: "ok",
      observedAt: NOW,
      complete: true,
      omitted: 0,
      entries: [
        entry({ kind: "project", projectId: "p1" }, "help-0"),
        entry({ kind: "global" }, "g-1"),
      ],
    });
    render(<CanopyView />);
    await settle();
    const [lane, global] = [...document.querySelectorAll<HTMLElement>("[data-canopy-assistant]")];
    const where = (row: HTMLElement) => row.querySelector("[data-canopy-where]")!;
    const workerHost = where(cardOf("local", "shared-run")!).querySelector("[data-canopy-host]")!;
    const host = workerHost.lastElementChild!.textContent!;
    for (const row of [lane!, global!]) {
      expect(where(row).querySelector("[data-canopy-host]")!.textContent).toBe(
        workerHost.textContent
      );
      expect(row.querySelector("[data-canopy-assistant-name]")!.textContent).not.toContain(host);
    }
    expect(where(lane!).querySelector("[data-canopy-project]")!.textContent).toBe("local-app");
    expect(where(global!).querySelector("[data-canopy-project]")!.textContent).toBe("Global");
  });

  it("asks each host about its own terminals, by the id it knows", async () => {
    const own = installElectron();
    render(<CanopyView />);
    await settle();
    const input = document.querySelector<HTMLInputElement>("input[role=combobox]")!;
    await act(async () => {
      fireEvent.change(input, { target: { value: "segfault" } });
    });
    await screenSearchSettled();
    const asked = state.invoke.mock.calls.filter((call) => call[1] === "canopy:search-screens");
    expect(asked).toHaveLength(1);
    expect(asked[0]![0]).toBe("studio");
    expect(asked[0]![2]).toEqual([
      expect.objectContaining({ runId: "shared-run", terms: ["segfault"] }),
    ]);
    expect(own.searchScreens).toHaveBeenCalledWith([
      expect.objectContaining({ runId: "shared-run", terms: ["segfault"] }),
    ]);
  });

  it("says once, in the empty Assistants line, that only this machine's assistants are listed", async () => {
    installElectron();
    render(<CanopyView />);
    await settle();
    const line = [...document.querySelectorAll("[data-canopy-empty-line]")].find((candidate) =>
      candidate.textContent?.startsWith("Start an assistant from the Assistant panel")
    );
    expect(line?.textContent).toBe(
      "Start an assistant from the Assistant panelOnly This machine's assistants are listed"
    );
    expect(document.body.textContent!.split("assistants are listed")).toHaveLength(2);
  });

  it("lets a host that can't be read outrank the all-clear in the band, as in the header", async () => {
    remoteFleet = workingFleet(["shared-run"]);
    remoteCanopy = canopySnapshot({ cards: [calmCard("shared-run")] });
    useFleetSnapshotStore.setState({ snapshot: workingFleet(["shared-run"]) });
    const settled = canopySnapshot({ cards: [calmCard("shared-run")] });
    useCanopyStore.setState({ snapshot: settled });
    installElectron().setActive.mockResolvedValue(settled);
    const first = render(<CanopyView />);
    await settle();
    // Every host read and calm: the conclusion stands.
    expect(summaryWords()).toBe("Nothing needs you");
    expect(bandWords()).toBe("No action needed");
    first.unmount();

    useCanopyStore.setState({ isOpen: true, snapshot: settled, hostId: ALL_HOSTS_ID });
    installElectron().setActive.mockResolvedValue(settled);
    state.invoke.mockRejectedValue(new Error("offline"));
    render(<CanopyView />);
    await settle();
    expect(cardOf("local", "shared-run")).not.toBeNull();
    expect(summaryWords()).toBe("Not every host could be read");
    expect(bandWords()).toBe("Not every host could be read");
  });

  it("turns Canopy on nowhere, and says which host is off", async () => {
    const own = installElectron();
    remoteCanopy = canopySnapshot({ activated: false, mode: "unset", cards: [] });
    render(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("Canopy is off on studio-01");
    // A reader left off is a choice, not a failure: it stays out of the warning.
    expect(document.body.textContent).not.toContain("Not every host is being read");
    expect(document.body.textContent).not.toContain("Not every host could be read");
    expect(channelsCalled()).not.toContain("studio canopy:set-mode");
    expect(own.setMode).not.toHaveBeenCalled();
    // What the host that is off adds is what Daintree observes of its runs.
    expect(cardOf("studio", "shared-run")).not.toBeNull();
  });

  it("offers no reading callout over every host's agents, even with the readers off", async () => {
    const off = canopySnapshot({ activated: false, mode: "unset", cards: [] });
    installElectron().setActive.mockResolvedValue(off);
    useCanopyStore.setState({ snapshot: off });
    remoteCanopy = off;
    render(<CanopyView />);
    await settle();
    expect(cardOf("local", "shared-run")).not.toBeNull();
    expect(cardOf("studio", "shared-run")).not.toBeNull();
    expect(document.querySelector("[data-canopy-reading-offer]")).toBeNull();
  });

  it("names a host that can't be reached and keeps the others", async () => {
    installElectron();
    state.invoke.mockRejectedValue(new Error("offline"));
    render(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("Can't reach studio-01");
    expect(cardOf("local", "shared-run")).not.toBeNull();
    expect(cardOf("studio", "shared-run")).toBeNull();
  });

  it("reads a host dialled on open as connecting, silently, through the gap before its reread lands", async () => {
    installElectron();
    useFleetSnapshotStore.setState({ snapshot: fleet([]) });
    state.hosts = [host("studio", "studio-01", { status: "disconnected" })];
    state.invoke.mockRejectedValue(
      new Error("[AppError|HOST_DISCONNECTED] Host studio is not connected")
    );
    const { rerender } = render(<CanopyView />);
    await settle();
    const quiet = () => {
      expect(document.body.textContent).not.toContain("Connecting to studio-01");
      expect(document.body.textContent).not.toContain("Can't reach studio-01");
      expect(document.body.textContent).not.toContain("Not every host");
      expect(document.body.textContent).toContain("Checking who needs you…");
      expect(document.querySelector("[data-callout]")).toBeNull();
      expect(document.querySelector("[data-testid=canopy-host-issues]")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    };
    quiet();

    state.hosts = [host("studio", "studio-01", { status: "connecting", attempt: 1 })];
    rerender(<CanopyView />);
    await settle();
    quiet();

    // The link is up before the resync's reread lands: the refusal is still the reading's.
    state.hosts = [host("studio", "studio-01")];
    rerender(<CanopyView />);
    await settle();
    quiet();

    // The reread is slow to land, and its two reads land apart.
    const answer = { canopy: () => {}, fleet: () => {} };
    state.invoke.mockImplementation(
      (_hostId: string, channel: string) =>
        new Promise((resolve) => {
          if (channel === "canopy:set-active") answer.canopy = () => resolve(remoteCanopy);
          else if (channel === "fleet:get-snapshot") answer.fleet = () => resolve(remoteFleet);
          else resolve(null);
        })
    );
    act(() => {
      for (const listener of state.listeners) listener({ kind: "resync", hostId: "studio" });
    });
    await settle();
    quiet();
    await act(async () => answer.canopy());
    await settle();
    quiet();
    await act(async () => answer.fleet());
    await settle();
    expect(cardOf("studio", "shared-run")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Connecting to studio-01");
    expect(document.body.textContent).not.toContain("Not every host");
  });

  /** Nothing about the host is said, and the hosts that answered read as they would alone. */
  function saysNothingOf(name: string) {
    for (const words of [`reach ${name}`, `Connecting to ${name}`, `${name} isn't connected`]) {
      expect(document.body.textContent).not.toContain(words);
    }
    expect(document.body.textContent).not.toContain("Not every host");
    expect(document.querySelector("[data-callout]")).toBeNull();
    expect(document.querySelector("[data-testid=canopy-host-issues]")).toBeNull();
    expect(document.querySelector("[data-testid=canopy-hosts-connecting]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  }

  function calmEverywhere() {
    const settled = canopySnapshot({ cards: [calmCard("shared-run")] });
    remoteFleet = workingFleet(["shared-run"]);
    remoteCanopy = settled;
    useFleetSnapshotStore.setState({ snapshot: workingFleet(["shared-run"]) });
    useCanopyStore.setState({ snapshot: settled });
    installElectron().setActive.mockResolvedValue(settled);
  }

  it("leaves out a host it can't reach, saying nothing of it, and lists it once it comes back", async () => {
    calmEverywhere();
    state.hosts = [
      host("studio", "studio-01", { status: "unreachable", lastSeenAt: null, detail: null }),
      host("build", "build-02"),
    ];
    const answers = state.invoke.getMockImplementation()!;
    state.invoke.mockImplementation((hostId: string, ...rest: unknown[]) =>
      hostId === "studio"
        ? Promise.reject(new Error("[AppError|HOST_DISCONNECTED] Host studio is not connected"))
        : answers(hostId, ...rest)
    );
    const { rerender } = render(<CanopyView />);
    await settle();
    expect(cardOf("local", "shared-run")).not.toBeNull();
    expect(cardOf("build", "shared-run")).not.toBeNull();
    expect(cardOf("studio", "shared-run")).toBeNull();
    saysNothingOf("studio-01");
    expect(summaryWords()).toBe("Nothing needs you");
    expect(bandWords()).toBe("No action needed");

    // Its link retried in the background, and still not answering: still nothing said.
    state.hosts = [
      host("studio", "studio-01", { status: "connecting", attempt: 2 }),
      host("build", "build-02"),
    ];
    rerender(<CanopyView />);
    await settle();
    saysNothingOf("studio-01");
    expect(summaryWords()).toBe("Nothing needs you");
    // Left out, not let go: its viewer stays open for the link to come back on,
    // and no assistant's work is read from it meanwhile.
    expect(state.release).not.toHaveBeenCalled();
    expect(state.readWork.mock.calls.map((call) => call[0])).toContain("build");
    expect(state.readWork.mock.calls.map((call) => call[0])).not.toContain("studio");

    // Back: the link comes up and says `resync`, and its agents are read and listed.
    state.invoke.mockImplementation(answers);
    state.hosts = [host("studio", "studio-01"), host("build", "build-02")];
    rerender(<CanopyView />);
    act(() => {
      for (const listener of state.listeners) listener({ kind: "resync", hostId: "studio" });
    });
    await settle();
    expect(cardOf("studio", "shared-run")).not.toBeNull();
    expect(cardOf("build", "shared-run")).not.toBeNull();
    saysNothingOf("studio-01");
    expect(summaryWords()).toBe("Nothing needs you");
  });

  it("says a host whose link failed can't be reached while its reads are still owed", async () => {
    installElectron();
    state.hosts = [
      host("studio", "studio-01", {
        status: "version-mismatch",
        mismatch: { kind: "protocol", local: 2, remote: 1 },
        remote: HANDSHAKE,
      }),
    ];
    state.invoke.mockImplementation(() => new Promise(() => {}));
    render(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("Can't reach studio-01");
    expect(document.body.textContent).not.toContain("Connecting to studio-01");
  });

  it.each([
    ["disconnected", { status: "disconnected" }],
    ["redialling", { status: "connecting", attempt: 1 }],
    ["unreachable", { status: "unreachable", lastSeenAt: null, detail: null }],
  ] as const)(
    "drops a host's agents once its link goes after they were read, and brings them back with it (%s)",
    async (_status, connection) => {
      calmEverywhere();
      // Its model still downloading when it was read: progress, until the link drops.
      remoteCanopy = canopySnapshot({
        cards: [calmCard("shared-run")],
        model: { id: "m", status: "downloading", received: 1, total: 2 },
      });
      const { rerender } = render(<CanopyView />);
      await settle();
      expect(cardOf("studio", "shared-run")).not.toBeNull();
      expect(document.body.textContent).toContain("Downloading Canopy's model on studio-01");

      state.hosts = [host("studio", "studio-01", connection)];
      rerender(<CanopyView />);
      await settle();
      expect(cardOf("studio", "shared-run")).toBeNull();
      expect(cardOf("local", "shared-run")).not.toBeNull();
      saysNothingOf("studio-01");
      expect(summaryWords()).toBe("Nothing needs you");

      // The link is back: what it last showed is listed again until its reread lands.
      remoteCanopy = canopySnapshot({ cards: [calmCard("shared-run")] });
      state.hosts = [host("studio", "studio-01")];
      rerender(<CanopyView />);
      await settle();
      expect(cardOf("studio", "shared-run")).not.toBeNull();
      act(() => {
        for (const listener of state.listeners) listener({ kind: "resync", hostId: "studio" });
      });
      await settle();
      expect(cardOf("studio", "shared-run")).not.toBeNull();
      saysNothingOf("studio-01");
      expect(summaryWords()).toBe("Nothing needs you");
    }
  );

  it("keeps a host's agents as last seen when its link is refused for another build", async () => {
    installElectron();
    const { rerender } = render(<CanopyView />);
    await settle();
    expect(cardOf("studio", "shared-run")).not.toBeNull();

    state.hosts = [
      host("studio", "studio-01", {
        status: "version-mismatch",
        mismatch: { kind: "protocol", local: 2, remote: 1 },
        remote: HANDSHAKE,
      }),
    ];
    rerender(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain(
      "studio-01 isn't connected. Its agents are as last seen"
    );
    expect(cardOf("studio", "shared-run")).not.toBeNull();
  });

  it("hands a host over to the single-host panel without releasing it after it is read again", async () => {
    installElectron();
    render(<CanopyView />);
    await settle();
    state.invoke.mockClear();
    state.release.mockClear();
    act(() => useCanopyStore.getState().setHostId("studio"));
    await settle();
    const opened =
      state.invoke.mock.invocationCallOrder[
        state.invoke.mock.calls.findIndex((call) => call[1] === "canopy:set-active")
      ]!;
    expect(state.release).toHaveBeenCalledWith("studio");
    // Let go of the all-hosts reader first, so it can't close what the new one opened.
    expect(Math.max(...state.release.mock.invocationCallOrder)).toBeLessThan(opened);
  });

  it("withholds the all-clear while a host has been heard in only one of its two reads", async () => {
    installElectron();
    useFleetSnapshotStore.setState({ snapshot: fleet([]) });
    state.invoke.mockImplementation(async (_hostId: string, channel: string) => {
      if (channel === "canopy:set-active") return remoteCanopy;
      return new Promise(() => {});
    });
    render(<CanopyView />);
    await settle();
    expect(document.body.textContent).not.toContain("Connecting to studio-01");
    expect(document.querySelector("[data-callout]")).toBeNull();
    expect(summaryWords()).toBe("Checking who needs you…");
    expect(document.querySelector("[data-testid=canopy-host-issues]")).toBeNull();
    expect(document.body.textContent).not.toContain("No agents are running on any host");
    expect(document.body.textContent).not.toContain("Nothing needs you");
  });

  it("holds the band's all-clear back for a host still connecting, with no word about it", async () => {
    const settled = canopySnapshot({ cards: [calmCard("shared-run")] });
    useFleetSnapshotStore.setState({ snapshot: workingFleet(["shared-run"]) });
    useCanopyStore.setState({ snapshot: settled });
    installElectron().setActive.mockResolvedValue(settled);
    state.hosts = [host("studio", "studio-01", { status: "connecting", attempt: 1 })];
    state.invoke.mockImplementation(() => new Promise(() => {}));
    render(<CanopyView />);
    await settle();
    expect(cardOf("local", "shared-run")).not.toBeNull();
    expect(summaryWords()).toBe("Checking who needs you…");
    expect(bandWords()).toBe("Checking who needs you…");
    expect(document.querySelector("[data-callout]")).toBeNull();
    expect(document.querySelector("[data-testid=canopy-host-issues]")).toBeNull();
    expect(document.body.textContent).not.toContain("studio-01…");
  });

  describe("while a host connects", () => {
    const spinner = () => document.querySelector("[data-testid=canopy-hosts-connecting]");
    const gate = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

    beforeEach(() => {
      // The gate's timer is the one clock these tests move: the reads settle on promises.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      installElectron();
      useFleetSnapshotStore.setState({ snapshot: fleet([]) });
    });

    afterEach(() => {
      // Unmounted on the clock that armed the timers, before it is let go.
      cleanup();
      vi.useRealTimers();
    });

    /** Both of the host's reads held back, each answered when the test says so. */
    function deferReads() {
      const answer = { canopy: () => {}, fleet: () => {} };
      state.invoke.mockImplementation(
        (_hostId: string, channel: string) =>
          new Promise((resolve) => {
            if (channel === "canopy:set-active") answer.canopy = () => resolve(remoteCanopy);
            else if (channel === "fleet:get-snapshot") answer.fleet = () => resolve(remoteFleet);
            else resolve(null);
          })
      );
      return answer;
    }

    it("draws no box, and a spinner by the picker only once it is past the loading gate", async () => {
      state.hosts = [host("studio", "studio-01", { status: "connecting", attempt: 1 })];
      state.invoke.mockImplementation(() => new Promise(() => {}));
      render(<CanopyView />);
      await settle();
      expect(spinner()).toBeNull();

      await gate(399);
      expect(spinner()).toBeNull();
      await gate(1);
      const shown = spinner();
      expect(shown).not.toBeNull();
      expect(document.querySelector("[data-testid=canopy-host-picker]")?.parentElement).toBe(
        shown?.parentElement
      );
      // Past the gate it is the spinner that speaks, never a box listing the host.
      expect(document.querySelector("[data-callout]")).toBeNull();
      expect(document.querySelector("[data-testid=canopy-host-issues]")).toBeNull();
      expect(document.body.textContent).not.toContain("Connecting to studio-01");
    });

    it("shows nothing at all when the reads land inside the gate", async () => {
      state.hosts = [host("studio", "studio-01", { status: "connecting", attempt: 1 })];
      const answer = deferReads();
      const { rerender } = render(<CanopyView />);
      await settle();
      await gate(300);
      expect(spinner()).toBeNull();
      expect(document.querySelector("[data-callout]")).toBeNull();

      state.hosts = [host("studio", "studio-01")];
      rerender(<CanopyView />);
      await act(async () => {
        answer.canopy();
        answer.fleet();
      });
      await settle();
      expect(cardOf("studio", "shared-run")).not.toBeNull();
      await gate(1_000);
      expect(spinner()).toBeNull();
      expect(document.querySelector("[data-callout]")).toBeNull();
    });

    it("takes the spinner away once the reads land", async () => {
      state.hosts = [host("studio", "studio-01", { status: "connecting", attempt: 1 })];
      const answer = deferReads();
      const { rerender } = render(<CanopyView />);
      await settle();
      await gate(400);
      expect(spinner()).not.toBeNull();

      state.hosts = [host("studio", "studio-01")];
      rerender(<CanopyView />);
      await act(async () => {
        answer.canopy();
        answer.fleet();
      });
      await settle();
      expect(spinner()).toBeNull();
      expect(cardOf("studio", "shared-run")).not.toBeNull();
    });

    it("starts the gate afresh on each open, however long the panel stood shut", async () => {
      state.hosts = [host("studio", "studio-01", { status: "connecting", attempt: 1 })];
      state.invoke.mockImplementation(() => new Promise(() => {}));
      render(<CanopyView />);
      await settle();
      await gate(400);
      expect(spinner()).not.toBeNull();

      act(() => useCanopyStore.getState().close());
      await settle();
      await gate(1_000);
      act(() => useCanopyStore.getState().open());
      await settle();
      expect(spinner()).toBeNull();
      await gate(399);
      expect(spinner()).toBeNull();
      await gate(1);
      expect(spinner()).not.toBeNull();

      // Shut part way through the gate: the time already run carries nothing over.
      act(() => useCanopyStore.getState().close());
      await settle();
      act(() => useCanopyStore.getState().open());
      await settle();
      await gate(200);
      act(() => useCanopyStore.getState().close());
      await settle();
      await gate(1_000);
      act(() => useCanopyStore.getState().open());
      await settle();
      await gate(399);
      expect(spinner()).toBeNull();
      await gate(1);
      expect(spinner()).not.toBeNull();
    });

    it.each([
      ["the notes before the fleet", ["canopy", "fleet"]],
      ["the fleet before the notes", ["fleet", "canopy"]],
    ] as const)(
      "keeps the spinner for a connected host until both its reads land, %s",
      async (_order, order) => {
        const answer = deferReads();
        render(<CanopyView />);
        await settle();
        await gate(400);
        expect(spinner()).not.toBeNull();

        const [first, second] = order;
        await act(async () => answer[first]());
        await settle();
        expect(spinner()).not.toBeNull();
        expect(document.querySelector("[data-testid=canopy-host-issues]")).toBeNull();
        await act(async () => answer[second]());
        await settle();
        expect(spinner()).toBeNull();
        expect(cardOf("studio", "shared-run")).not.toBeNull();
      }
    );

    it("keeps the spinner while this machine's own agents are still being read", async () => {
      useFleetSnapshotStore.setState({ snapshot: null });
      render(<CanopyView />);
      await settle();
      expect(cardOf("studio", "shared-run")).not.toBeNull();
      expect(document.body.textContent).not.toContain("Reading This Mac");
      expect(document.querySelector("[data-callout]")).toBeNull();
      expect(spinner()).toBeNull();
      await gate(400);
      expect(spinner()).not.toBeNull();

      act(() => useFleetSnapshotStore.setState({ snapshot: fleet(["shared-run"]) }));
      await settle();
      expect(spinner()).toBeNull();
    });

    it("keeps a failing host's warning while another host is still connecting", async () => {
      state.hosts = [
        host("studio", "studio-01", {
          status: "version-mismatch",
          mismatch: { kind: "protocol", local: 2, remote: 1 },
          remote: HANDSHAKE,
        }),
        host("build", "build-02", { status: "connecting", attempt: 1 }),
      ];
      state.invoke.mockImplementation((hostId: string) =>
        hostId === "studio"
          ? Promise.reject(new Error("[AppError|HOST_DISCONNECTED] Host studio is not connected"))
          : new Promise(() => {})
      );
      render(<CanopyView />);
      await settle();
      await gate(400);
      expect(document.body.textContent).toContain("Can't reach studio-01");
      expect(document.body.textContent).toContain("Not every host is being read");
      expect(document.querySelector('[data-callout="warning"]')).not.toBeNull();
      expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
      // The connecting host adds no line to the warning, only the spinner.
      expect(document.body.textContent).not.toContain("build-02…");
      expect(document.querySelector('[data-callout="neutral"]')).toBeNull();
      expect(spinner()).not.toBeNull();
    });

    it("draws no spinner for a host that failed", async () => {
      state.hosts = [
        host("studio", "studio-01", { status: "unreachable", lastSeenAt: null, detail: null }),
      ];
      state.invoke.mockRejectedValue(
        new Error("[AppError|HOST_DISCONNECTED] Host studio is not connected")
      );
      render(<CanopyView />);
      await settle();
      await gate(1_000);
      expect(document.body.textContent).not.toContain("studio-01");
      expect(document.querySelector("[data-callout]")).toBeNull();
      expect(spinner()).toBeNull();
    });

    it("keeps a model download in the list, as a read in progress that is not a connection", async () => {
      remoteCanopy = canopySnapshot({
        model: { id: "m", status: "downloading", received: 1, total: 2 },
      });
      render(<CanopyView />);
      await settle();
      await gate(1_000);
      expect(document.body.textContent).toContain("Downloading Canopy's model on studio-01");
      expect(spinner()).toBeNull();
    });
  });

  it("releases every host it opened when the panel closes", async () => {
    installElectron();
    render(<CanopyView />);
    await settle();
    expect(channelsCalled()).toContain("studio canopy:set-active");
    act(() => useCanopyStore.getState().close());
    await settle();
    expect(state.release).toHaveBeenCalledWith("studio");
  });
});
