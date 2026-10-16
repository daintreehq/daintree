// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { CanopyHostEvent } from "@shared/types/ipc/canopyHost";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
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

import { TooltipProvider } from "@/components/ui/tooltip";
import { CanopyView } from "../CanopyView";
import { useCanopyStore } from "@/store/canopyStore";
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
      assistantMessagingEnabled: false,
      assistantStartEnabled: false,
    },
    connection,
    summary: connection.status === "connected" ? summary(id, 2, 1) : null,
  };
}

function canopySnapshot(overrides: Partial<CanopySnapshot> = {}): CanopySnapshot {
  return {
    mode: "on",
    activated: true,
    tier: "priority",
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

let remoteCanopy: CanopySnapshot = canopySnapshot();
let remoteFleet: FleetSnapshot | null = fleet(["remote-run"]);

function installElectron() {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => canopySnapshot()),
    setScope: vi.fn(async () => {}),
    setShown: vi.fn(async () => {}),
    setRead: vi.fn(async () => null),
    archive: vi.fn(async () => null),
    unarchive: vi.fn(async () => {}),
    markSeen: vi.fn(async () => {}),
    runBranch: vi.fn(async () => "main"),
    answer: vi.fn(async () => {}),
    trash: vi.fn(async () => null),
    rename: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    setMode: vi.fn(async () => canopySnapshot()),
    captureBackdrop: vi.fn(async () => null),
  };
  Object.defineProperty(window, "electron", {
    value: { canopy, system: { openExternal: vi.fn() } },
    configurable: true,
    writable: true,
  });
  return canopy;
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
    return null;
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
    const rows = [...menu.querySelectorAll<HTMLElement>("[data-host-id]")];
    expect(rows.map((row) => row.getAttribute("data-host-id"))).toEqual(["local", "studio"]);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    // Waiting first, then working, as the host switcher draws them.
    expect(rows[1]!.querySelector("[data-host-agents]")?.textContent).toContain(
      "Agents: 2 waiting, 1 working"
    );
    // Nothing is read from another host until it is picked.
    expect(state.invoke).not.toHaveBeenCalled();
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

  it("offers only what reaches the run's own host", async () => {
    const own = installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    const row = document.getElementById("canopy-card-remote-run")!;
    // Its reading, never its terminal or a reply.
    expect(document.querySelector("[data-canopy-terminal]")).toBeNull();
    expect(document.querySelector("[data-canopy-reading]")).not.toBeNull();

    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: "F2" });
    fireEvent.keyDown(row, { key: "1" });
    fireEvent.keyDown(row, { key: "Backspace", metaKey: true });
    fireEvent.doubleClick(row);
    await settle();
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(own.answer).not.toHaveBeenCalled();
    expect(own.trash).not.toHaveBeenCalled();
    expect(own.rename).not.toHaveBeenCalled();

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
    expect(document.body.textContent).toContain("Canopy is off on studio-01");
    expect(document.querySelector("[data-canopy-card]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn on Canopy on studio-01" }));
    await settle();
    expect(state.invoke).toHaveBeenCalledWith("studio", "canopy:set-mode", "on");
    expect(own.setMode).not.toHaveBeenCalled();
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
      Object.assign(new Error("Host studio is not connected"), { code: "HOST_DISCONNECTED" })
    );
    installElectron();
    useCanopyStore.setState({ hostId: "studio" });
    render(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("Can't reach studio-01");
    expect(document.body.textContent).toContain("Unreachable.");
    expect(document.querySelector("[data-canopy-card]")).toBeNull();

    state.invoke.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(channelsCalled()).toContain("studio canopy:set-active");
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
});
