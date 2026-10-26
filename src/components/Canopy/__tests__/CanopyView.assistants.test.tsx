// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type { AgentDirectory, AgentDirectoryLiveEntry } from "@shared/types/agentDirectory";
import type { AssistantWorkReading } from "@shared/types/assistantWork";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});
afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

const dispatchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
const terminalApis = vi.hoisted(() => [] as Array<{ runId: string; api: unknown }>);
vi.mock("../CanopyTerminal", () => ({
  CanopyTerminal: ({ runId, api }: { runId: string; api?: unknown }) => {
    terminalApis.push({ runId, api });
    return <div data-canopy-terminal="" data-run={runId} />;
  },
}));
vi.mock("@/components/Terminal/HybridInputBar", () => ({ HybridInputBar: () => null }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
const openInAssistantMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ ok: true } | { ok: false; reason: "ended" }> => ({ ok: true }))
);
const assistantApiMock = vi.hoisted(() =>
  vi.fn((subject: unknown) => ({ assistantSubject: subject }))
);
vi.mock("@/services/assistantSubject", () => ({
  openInAssistant: openInAssistantMock,
  assistantTerminalApi: assistantApiMock,
}));

import { CanopyView } from "../CanopyView";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";

const NOW = Date.now();
/** Past the panel's wait on the typing before it reads terminals for a search. */
const SCREEN_SEARCH_SETTLE_MS = 250;

const canopySnapshot: CanopySnapshot = {
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
};

function run(runId: string, overrides: Partial<FleetSnapshot["runs"][number]> = {}) {
  return {
    runId,
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo",
    agentId: "claude" as const,
    ...overrides,
  };
}

function assistant(
  lane: number,
  overrides: Partial<AgentDirectoryLiveEntry> = {}
): AgentDirectoryLiveEntry {
  return {
    state: "live",
    role: "assistant",
    subject: {
      hostId: "local",
      scope: { kind: "project", projectId: "p1" },
      terminalId: `help-${lane}`,
      incarnation: 3,
      lane,
    },
    agentId: "claude",
    agentState: "waiting",
    waitingReason: "prompt",
    since: NOW - 10_000,
    label: null,
    attached: true,
    handback: null,
    ...overrides,
  };
}

let directory: AgentDirectory;
let assistantWork: AssistantWorkReading;

function installElectron() {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => canopySnapshot),
    refresh: vi.fn(async () => {}),
    setShown: vi.fn(async (_ids: string[]) => {}),
    setScope: vi.fn(async () => {}),
    markSeen: vi.fn(async (_runId: string, _looking?: boolean) => {}),
    setRead: vi.fn(async () => null),
    archive: vi.fn(async () => null),
    unarchive: vi.fn(async () => {}),
    trash: vi.fn(async () => null),
    rename: vi.fn(async () => {}),
    reread: vi.fn(async () => {}),
    runBranch: vi.fn(async () => "main"),
    searchScreens: vi.fn(async (_targets: Array<{ runId: string }>) => [] as string[]),
    captureBackdrop: vi.fn(async () => null),
    watchTerminal: vi.fn(),
    watchAssistantTerminal: vi.fn(),
    readAgentDirectory: vi.fn(async () => directory),
    readAssistantWork: vi.fn(async () => assistantWork),
  };
  Object.defineProperty(window, "electron", {
    value: { canopy, terminal: { restore: vi.fn() }, system: { openExternal: vi.fn() } },
    configurable: true,
    writable: true,
  });
  return canopy;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

function workerIds() {
  return [...document.querySelectorAll<HTMLElement>("[data-canopy-card]")].map((card) =>
    card.id.replace(/^canopy-card-/, "")
  );
}

function assistantRows() {
  return [...document.querySelectorAll<HTMLElement>("[data-canopy-assistant]")];
}

function roleSegment(role: "all" | "workers" | "assistants") {
  return document.querySelector<HTMLElement>(`[data-testid="canopy-role-filter-${role}"]`)!;
}

beforeEach(() => {
  __resetCanopySeenForTests();
  __resetCanopyPlaceForTests();
  terminalApis.length = 0;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  directory = {
    coverage: "ok",
    observedAt: NOW,
    complete: true,
    omitted: 0,
    entries: [assistant(0), assistant(1)],
  };
  assistantWork = { coverage: "ok", observedAt: NOW, complete: true, omitted: 0, workers: [] };
  useProjectStore.setState({
    projects: [{ id: "p1", path: "/repo", name: "app", emoji: "🌳", lastOpened: NOW }],
  });
  useFleetSnapshotStore.setState({
    snapshot: {
      runs: [
        run("waiting", { agentState: "waiting", waitingReason: "approval", since: NOW - 60_000 }),
        run("working", { agentState: "working", since: NOW - 30_000 }),
      ],
      changedAt: NOW,
      degraded: false,
      lastSuccessfulAt: NOW,
    },
  });
  useCanopyStore.setState({
    isOpen: true,
    snapshot: canopySnapshot,
    mode: "on",
    roleFilter: "all",
    assistantHandbacksSeen: {},
  });
  installElectron();
});

afterEach(() => {
  useCanopyStore.setState({
    isOpen: false,
    snapshot: null,
    mode: "unset",
    scope: "all",
    orders: {},
    unreadOnly: false,
    roleFilter: "all",
    workOf: null,
  });
  window.localStorage.removeItem("daintree-canopy-order");
  window.localStorage.removeItem("daintree-canopy-role");
  window.localStorage.removeItem("daintree-canopy-assistant-handbacks");
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CanopyView role filter", () => {
  it("lists workers and each assistant lane together, workers in their own order", async () => {
    render(<CanopyView />);
    await settle();
    const workersAlone = workerIds();
    expect(workersAlone).toEqual(["waiting", "working"]);
    const names = assistantRows().map((row) => row.getAttribute("aria-label"));
    expect(names).toEqual([
      "Daintree Assistant, app · Session 1",
      "Daintree Assistant, app · Session 2",
    ]);
  });

  it("shows only workers, then only assistants, keeping the choice for the next opening", async () => {
    render(<CanopyView />);
    await settle();
    await act(async () => fireEvent.click(roleSegment("workers")));
    expect(assistantRows()).toHaveLength(0);
    expect(workerIds()).toEqual(["waiting", "working"]);

    await act(async () => fireEvent.click(roleSegment("assistants")));
    expect(workerIds()).toEqual([]);
    expect(assistantRows()).toHaveLength(2);
    expect(window.localStorage.getItem("daintree-canopy-role")).toBe("assistants");
    // The pane shows the first assistant through its own viewer, never a worker's.
    expect(document.querySelector("[data-testid=canopy-assistant-pane]")).not.toBeNull();
    expect(terminalApis.at(-1)?.runId).toBe("help-0");
    expect(assistantApiMock).toHaveBeenLastCalledWith(assistant(0).subject);
  });

  it("keeps assistants at their prompt quiet, and an observed ask on one lane in view", async () => {
    directory.entries = [assistant(0), assistant(1, { waitingReason: "approval" })];
    render(<CanopyView />);
    await settle();
    const rows = assistantRows();
    // The ask leads; the resting lane stays without one.
    expect(rows.map((row) => row.getAttribute("data-ask"))).toEqual(["approval", null]);
    // Hidden by the filter, the ask still counts on the Assistants choice.
    await act(async () => fireEvent.click(roleSegment("workers")));
    expect(roleSegment("assistants").textContent).toContain("1");
    expect(roleSegment("assistants").getAttribute("aria-label")).toBe(
      "Assistants, 1 asking for you"
    );
  });

  it("counts only workers in the header until assistants rank with them (#14519)", async () => {
    directory.entries = [
      assistant(0, { waitingReason: "question" }),
      assistant(1, { waitingReason: "approval" }),
    ];
    const snapshot = useFleetSnapshotStore.getState().snapshot!;
    useFleetSnapshotStore.setState({
      snapshot: {
        ...snapshot,
        runs: [
          ...snapshot.runs,
          run("asking", { agentState: "waiting", waitingReason: "question", since: NOW - 50_000 }),
        ],
      },
    });
    render(<CanopyView />);
    await settle();
    expect(assistantRows().map((row) => row.getAttribute("data-ask"))).toEqual([
      "question",
      "approval",
    ]);
    const header = document.querySelector("[data-testid=canopy-dialog]")!.textContent ?? "";
    expect(header).toContain("2 agents need you");
  });

  it("never hands an assistant to the reader: not shown, searched or seen as a worker", async () => {
    const canopy = installElectron();
    render(<CanopyView />);
    await settle();
    await act(async () => fireEvent.click(roleSegment("assistants")));
    await act(async () => {
      fireEvent.change(
        document.querySelector<HTMLInputElement>(
          "[data-testid=canopy-dialog] input[role=combobox]"
        )!,
        { target: { value: "session" } }
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SCREEN_SEARCH_SETTLE_MS));
    });
    // The search did reach the workers' terminals, and only theirs.
    expect(canopy.searchScreens).toHaveBeenCalled();
    const told = [
      ...canopy.setShown.mock.calls.flatMap((call) => call[0]),
      ...canopy.searchScreens.mock.calls.flatMap((call) => call[0].map((target) => target.runId)),
      ...canopy.markSeen.mock.calls.map((call) => call[0]),
    ];
    const workers = new Set(["waiting", "working"]);
    expect(told.filter((id) => !workers.has(String(id)))).toEqual([]);
    expect(canopy.watchTerminal).not.toHaveBeenCalled();
    expect(assistantRows()).toHaveLength(2);
  });

  it("walks from the last worker down into the assistants with the keyboard", async () => {
    render(<CanopyView />);
    await settle();
    const search = document.querySelector<HTMLInputElement>(
      "[data-testid=canopy-dialog] input[role=combobox]"
    )!;
    const [first, last] = [
      document.getElementById("canopy-card-waiting")!,
      document.getElementById("canopy-card-working")!,
    ];
    fireEvent.keyDown(search, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(document.activeElement).toBe(assistantRows()[0]);
    expect(assistantRows()[0]!.getAttribute("aria-selected")).toBe("true");
    // The pane now shows that assistant, not the worker left behind.
    expect(document.querySelector("[data-testid=canopy-assistant-pane]")).not.toBeNull();
    fireEvent.keyDown(assistantRows()[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(assistantRows()[1]);
    fireEvent.keyDown(assistantRows()[1]!, { key: "ArrowUp" });
    fireEvent.keyDown(assistantRows()[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(last);
    expect(document.querySelector("[data-testid=canopy-assistant-pane]")).toBeNull();
  });

  it("opens the exact lane on Enter, and offers no worker action on an assistant row", async () => {
    render(<CanopyView />);
    await settle();
    const row = assistantRows()[1]!;
    expect(row.querySelector("[data-canopy-row-archive]")).toBeNull();
    await act(async () => {
      row.focus();
      fireEvent.keyDown(row, { key: "Enter" });
    });
    expect(openInAssistantMock).toHaveBeenCalledWith(assistant(1).subject);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("shows a lane's waiting confirmation and routes to it, with no way to answer it here (#14165)", async () => {
    directory.entries = [
      assistant(0, { waitingReason: "question" }),
      assistant(1, {
        agentState: "working",
        waitingReason: null,
        confirmations: {
          waiting: [{ actionId: "worktree.delete", since: NOW - 1_000, expiresAt: NOW + 29_000 }],
          omitted: 0,
        },
        notices: { pending: 2, ready: 0, delivery: "idle" },
      }),
    ];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView />);
    await settle();

    const rows = assistantRows();
    // Both ask, so each keeps its lane's place; only the lane that waits says so.
    expect(rows.map((row) => row.getAttribute("data-ask"))).toEqual(["question", "confirm"]);
    const confirming = rows[1]!;
    await act(async () => fireEvent.click(confirming));
    const meta = document.getElementById(confirming.getAttribute("aria-describedby")!)!;
    expect(meta.textContent).toContain("Waiting on your confirmation: worktree.delete");
    expect(meta.textContent).toContain("Watching 2 terminals");

    const callout = document.querySelector("[data-canopy-assistant-confirmation]")!;
    expect(callout.textContent).toContain("worktree.delete");
    const buttons = [...document.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons.some((label) => /approve|allow|confirm|deny|reject/i.test(label ?? ""))).toBe(
      false
    );

    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open in Assistant"
    )!;
    await act(async () => fireEvent.click(open));
    expect(openInAssistantMock).toHaveBeenCalledWith(assistant(1).subject);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("opens the global assistant by its exact subject, as it opens a lane (#14454)", async () => {
    const global = assistant(0, {
      subject: { hostId: "local", scope: { kind: "global" }, terminalId: "g-1", incarnation: 4 },
    });
    directory.entries = [global];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView />);
    await settle();
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open in Assistant"
    )!;
    await act(async () => fireEvent.click(open));
    expect(openInAssistantMock).toHaveBeenCalledWith(global.subject);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("says nothing of supervision for an assistant that watches nothing", async () => {
    directory.entries = [assistant(0, { notices: null })];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView />);
    await settle();
    expect(document.querySelector("[data-canopy-assistant-supervision]")).toBeNull();
    expect(assistantRows()[0]!.getAttribute("data-ask")).toBeNull();
  });

  it("says why a lane couldn't be opened, and starts nothing in its place", async () => {
    openInAssistantMock.mockResolvedValueOnce({ ok: false, reason: "ended" });
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView />);
    await settle();
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open in Assistant"
    )!;
    await act(async () => fireEvent.click(open));
    expect(document.body.textContent).toContain("Couldn't open this assistant");
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("marks a handback seen only for the assistant chosen, never by default", async () => {
    directory.entries = [
      assistant(0, { handback: { observedAt: NOW - 500 } }),
      assistant(1, { handback: { observedAt: NOW - 400 } }),
    ];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView />);
    await settle();
    // Shown in the pane only because it leads the list: both still ask.
    expect(document.querySelector("[data-testid=canopy-assistant-pane]")).not.toBeNull();
    expect(useCanopyStore.getState().assistantHandbacksSeen).toEqual({});
    await act(async () => fireEvent.click(assistantRows()[1]!));
    await settle();
    expect(Object.values(useCanopyStore.getState().assistantHandbacksSeen)).toEqual([NOW - 400]);
    expect(assistantRows().map((row) => row.getAttribute("data-ask"))).toEqual(["handback", null]);
    // The chosen one keeps the pane as it moves down the list.
    expect(assistantRows()[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("says when assistants couldn't all be listed, rather than that none run", async () => {
    directory = { coverage: "stale", observedAt: NOW, complete: false, omitted: 0, entries: [] };
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView />);
    await settle();
    expect(document.body.textContent).toContain("Daintree couldn't list every assistant just now.");
    expect(document.body.textContent).not.toContain("No assistant is running");
  });
});

describe("CanopyView show its work", () => {
  function linked(runId: string, lane: number) {
    const ref = { kind: "assistant" as const, subject: assistant(lane).subject };
    return {
      terminalId: runId,
      projectId: "p1",
      incarnation: 1,
      spawnedAt: NOW - 3_600_000,
      createdBy: ref,
      controlledBy: ref,
      control: "creation" as const,
    };
  }

  async function showWorkOfFirstAssistant() {
    render(<CanopyView />);
    await settle();
    await act(async () => {
      fireEvent.click(assistantRows()[0]!);
    });
    await settle();
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Show its work"
    )!;
    await act(async () => {
      fireEvent.click(button);
    });
    await settle();
  }

  it("narrows the inbox to the assistant's workers, labels them, and shows all again", async () => {
    assistantWork = {
      ...assistantWork,
      workers: [linked("waiting", 0), linked("working", 1)],
    };
    await showWorkOfFirstAssistant();
    expect(workerIds()).toEqual(["waiting"]);
    const banner = document.querySelector('[data-testid="canopy-work-of"]')!;
    expect(banner.textContent).toContain("Daintree Assistant · app · Session 1");
    expect(banner.textContent).not.toContain("incomplete");
    expect(document.getElementById("canopy-card-waiting")!.textContent).toContain(
      "Started by Daintree Assistant · app · Session 1"
    );
    // The other assistants step aside while one's work is shown.
    expect(assistantRows()).toHaveLength(1);

    const showAll = [...banner.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Show all"
    )!;
    await act(async () => {
      fireEvent.click(showAll);
    });
    await settle();
    expect(workerIds()).toEqual(["waiting", "working"]);
    expect(document.querySelector('[data-testid="canopy-work-of"]')).toBeNull();
    expect(assistantRows()).toHaveLength(2);
  });

  it("brings workers back into view when only assistants were shown", async () => {
    useCanopyStore.setState({ roleFilter: "assistants" });
    assistantWork = { ...assistantWork, workers: [linked("working", 0)] };
    await showWorkOfFirstAssistant();
    expect(useCanopyStore.getState().roleFilter).toBe("all");
    expect(workerIds()).toEqual(["working"]);
  });

  it("says when a host's records couldn't all be read, rather than that there is no work", async () => {
    assistantWork = { ...assistantWork, coverage: "stale", complete: false };
    await showWorkOfFirstAssistant();
    expect(workerIds()).toEqual([]);
    expect(document.querySelector('[data-testid="canopy-work-of"]')!.textContent).toContain(
      "Some hosts couldn't be read, so this may be incomplete"
    );
    // Never a claim that there is no work, on a reading that can't say so.
    expect(document.body.textContent).toContain("None found on the hosts that could be read.");
    expect(document.body.textContent).not.toContain("No worker in the inbox");
  });

  it("toggles back to the whole inbox from the same button, keeping it pressed while on", async () => {
    assistantWork = { ...assistantWork, workers: [linked("waiting", 0)] };
    await showWorkOfFirstAssistant();
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Show its work"
    )!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(workerIds()).toEqual(["waiting"]);
    await act(async () => {
      fireEvent.click(button);
    });
    await settle();
    expect(workerIds()).toEqual(["waiting", "working"]);
    expect(useCanopyStore.getState().workOf).toBeNull();
  });

  it("ends with the panel: a reopened panel shows the whole inbox", async () => {
    await showWorkOfFirstAssistant();
    expect(useCanopyStore.getState().workOf).not.toBeNull();
    act(() => useCanopyStore.getState().close());
    expect(useCanopyStore.getState().workOf).toBeNull();
  });
});
