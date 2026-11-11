// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import type {
  AgentDirectory,
  AgentDirectoryLiveEntry,
  AgentDirectorySubject,
} from "@shared/types/agentDirectory";
import type { AssistantWorkReading } from "@shared/types/assistantWork";
import type { GlobalAssistantView } from "@shared/types/ipc/help";

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
type StreamReport = (state: {
  watchId: number | null;
  ended: boolean;
  secretPrompt: boolean;
}) => void;
const terminalApis = vi.hoisted(
  () => [] as Array<{ runId: string; api: unknown; onStreamChange?: StreamReport }>
);
vi.mock("../CanopyTerminal", () => ({
  CanopyTerminal: ({
    runId,
    api,
    onStreamChange,
  }: {
    runId: string;
    api?: unknown;
    onStreamChange?: StreamReport;
  }) => {
    terminalApis.push({ runId, api, onStreamChange });
    return <div data-canopy-terminal="" data-run={runId} />;
  },
}));
// The global assistant's composer, where the keyboard goes once it takes input; no other reply draws one.
vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: ({ terminalId }: { terminalId: string }) =>
    terminalId === "g-1" ? (
      <div className="cm-content" tabIndex={0} data-testid="global-composer" />
    ) : null,
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
const assistantApiMock = vi.hoisted(() =>
  vi.fn((subject: AgentDirectorySubject, _stamp?: unknown) => ({
    assistantSubject: subject,
    dispose: vi.fn(),
  }))
);
vi.mock("@/services/assistantSubject", () => ({
  assistantTerminalApi: assistantApiMock,
}));

import { CanopyView } from "../CanopyView";
import type { CanopyFrame } from "../canopyFrame";
import { canopyTestFrame } from "./canopyTestFrame";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";
import { canopyReplyVoiceId, resolveCanopyReplyDictation } from "@/services/canopyReplyDictation";
import { isMac } from "@/lib/platform";

const NOW = Date.now();
/** A host's refusal to open an assistant, in its words. */
const ENDED = "This assistant's session has ended.";
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

const GLOBAL_SUBJECT = {
  hostId: "local",
  scope: { kind: "global" as const },
  terminalId: "g-1",
  incarnation: 4,
};

/** The global assistant as main tells a view of it. */
function globalRunning(overrides: Partial<GlobalAssistantView> = {}): GlobalAssistantView {
  return {
    phase: "running",
    generation: 1,
    agentId: "claude",
    terminalId: "g-1",
    attachments: [],
    inputOwner: null,
    inputEpoch: 0,
    subject: GLOBAL_SUBJECT,
    agentState: null,
    ...overrides,
  };
}

let globalView: GlobalAssistantView;
let frame: CanopyFrame;
let help: ReturnType<typeof makeHelp>;
let canopyBridge: ReturnType<typeof installElectron>;
let attachments = 0;
/** Who holds input once a view attaches: by default the one attaching, as main hands it over. */
let ownerOnAttach: (attachmentId: string) => string | null;

function makeHelp() {
  return {
    onGlobalAssistantChanged: vi.fn((_listener: (state: GlobalAssistantView) => void) => () => {}),
    attachGlobalAssistant: vi.fn(async () => {
      const attachmentId = `attachment-${++attachments}`;
      const owner = ownerOnAttach(attachmentId);
      globalView = {
        ...globalView,
        inputOwner: owner,
        inputEpoch: globalView.inputEpoch + (owner === globalView.inputOwner ? 0 : 1),
      };
      return { attachmentId, state: globalView };
    }),
    detachGlobalAssistant: vi.fn(async () => {}),
    setGlobalAssistantInputEligible: vi.fn(async () => {}),
    claimGlobalAssistantInput: vi.fn(async (attachmentId: string, _from?: string) => {
      globalView = {
        ...globalView,
        inputOwner: attachmentId,
        inputEpoch: globalView.inputEpoch + 1,
      };
      return globalView;
    }),
    ensureGlobalAssistant: vi.fn(async () => globalView),
    cancelGlobalAssistantLaunch: vi.fn(async () => globalView),
  };
}

function installElectron() {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => canopySnapshot),
    refresh: vi.fn(async () => {}),
    setShown: vi.fn(async (_ids: string[]) => {}),
    markSeen: vi.fn(async (_runId: string, _looking?: boolean) => {}),
    setRead: vi.fn(async () => null),
    archive: vi.fn(async () => null),
    unarchive: vi.fn(async () => {}),
    trash: vi.fn(async () => null),
    rename: vi.fn(async () => {}),
    reread: vi.fn(async () => {}),
    runBranch: vi.fn(async () => "main"),
    searchScreens: vi.fn(async (_targets: Array<{ runId: string }>) => [] as string[]),
    watchTerminal: vi.fn(),
    watchAssistantTerminal: vi.fn(),
    readAgentDirectory: vi.fn(async () => directory),
    readAssistantWork: vi.fn(async () => assistantWork),
  };
  help = makeHelp();
  Object.defineProperty(window, "electron", {
    value: { canopy, help, terminal: { restore: vi.fn() }, system: { openExternal: vi.fn() } },
    configurable: true,
    writable: true,
  });
  return canopy;
}

function electronHelp() {
  return help;
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

function description(row: HTMLElement) {
  return document.getElementById(row.getAttribute("aria-describedby")!)!.textContent ?? "";
}

/** What each empty section says, by its main line. */
function emptyLines() {
  return [...document.querySelectorAll("[data-canopy-empty-line] > p:first-child")].map(
    (line) => line.textContent
  );
}

function roleSegment(role: "all" | "workers" | "assistants") {
  return document.querySelector<HTMLElement>(`[data-testid="canopy-role-filter-${role}"]`)!;
}

beforeEach(() => {
  frame = canopyTestFrame();
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
  globalView = globalRunning();
  attachments = 0;
  ownerOnAttach = (attachmentId) => globalView.inputOwner ?? attachmentId;
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
  canopyBridge = installElectron();
});

afterEach(() => {
  useCanopyStore.setState({
    isOpen: false,
    snapshot: null,
    mode: "unset",
    order: null,
    unreadOnly: false,
    roleFilter: "all",
    workOf: null,
    globalDocked: false,
    dockWidth: null,
    archivedExpanded: false,
  });
  window.localStorage.removeItem("daintree-canopy-order");
  window.localStorage.removeItem("daintree-canopy-global-docked");
  window.localStorage.removeItem("daintree-canopy-role");
  window.localStorage.removeItem("daintree-canopy-assistant-handbacks");
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CanopyView role filter", () => {
  it("lists workers and each assistant lane together, workers in their own order", async () => {
    directory.entries = [assistant(0, { label: "Refactor" }), assistant(1)];
    render(<CanopyView frame={frame} />);
    await settle();
    const workersAlone = workerIds();
    expect(workersAlone).toEqual(["waiting", "working"]);
    // Named as a worker is, by what it is and the agent it runs on; where it
    // runs follows in its description.
    const names = assistantRows().map((row) => row.getAttribute("aria-label"));
    expect(names).toEqual([
      "Daintree Assistant, Session 1, Claude",
      "Daintree Assistant, Session 2, Claude",
    ]);
    // Its identity is said once, in the name; the description says the rest.
    const said = description(assistantRows()[0]!);
    for (const part of ["At its prompt", "app", "Refactor"]) expect(said).toContain(part);
    expect(said).not.toContain("Claude");
  });

  it("builds an assistant's row in the shape of the worker rows around it (#15370)", async () => {
    // The panel's clock starts at the fixtures' own moment, however long the suite has run.
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const since = NOW - 3 * 60_000;
    directory.entries = [
      assistant(0, { waitingReason: "question", since }),
      assistant(1, { waitingReason: "question", agentId: "codex", since }),
    ];
    const snapshot = useFleetSnapshotStore.getState().snapshot!;
    useFleetSnapshotStore.setState({
      snapshot: {
        ...snapshot,
        runs: [...snapshot.runs, run("codex-run", { agentId: "codex", agentState: "working" })],
      },
    });
    render(<CanopyView frame={frame} />);
    await settle();
    const band = document.querySelector("[data-testid=canopy-needs-you]")!.parentElement!;
    const worker = document.getElementById("canopy-card-waiting")!;
    const [claude, codex] = [...band.querySelectorAll<HTMLElement>("[data-canopy-assistant]")];
    expect(band.contains(worker)).toBe(true);

    const parts = (row: HTMLElement) => {
      const lead = row.querySelector("[data-canopy-lead]")!;
      const lines = lead.nextElementSibling!;
      return { lead, lines, where: lines.lastElementChild! };
    };
    const shape = (row: HTMLElement) => {
      const { lead, lines, where } = parts(row);
      return {
        // The same box, inset and lead as the worker beside it, however those are styled.
        row: row.className,
        lead: lead.className,
        column: lines.className,
        lines: lines.children.length,
        ageOnName: lines.firstElementChild!.lastElementChild!.hasAttribute("data-canopy-age"),
        whereLast: where.hasAttribute("data-canopy-where"),
        emoji: where.firstElementChild?.textContent,
        project: where.querySelector("[data-canopy-project]")?.textContent,
        agent: lead.querySelector("[data-terminal-icon-id]")?.getAttribute("data-terminal-icon-id"),
      };
    };
    expect(shape(claude!)).toEqual(shape(worker));
    expect(shape(worker)).toMatchObject({ lines: 3, ageOnName: true, whereLast: true });
    const codexWorker = document.getElementById("canopy-card-codex-run")!;
    expect(shape(codex!).agent).toBe(shape(codexWorker).agent);
    expect(shape(codex!).agent).not.toBe(shape(claude!).agent);
    expect(codex!.getAttribute("aria-label")).toBe("Daintree Assistant, Session 2, Codex");

    const { lines } = parts(claude!);
    const name = lines.firstElementChild!.firstElementChild!;
    expect(name.hasAttribute("data-canopy-assistant-name")).toBe(true);
    expect(name.textContent).toContain("Daintree Assistant");
    expect(name.textContent).toContain("Session 1");
    expect(name.textContent).not.toContain("app");
    expect(lines.children[1]!.textContent).toBe("Asking you");
    expect(claude!.querySelector("[data-canopy-age]")!.textContent).toBe("3m");
    expect(description(claude!)).toContain("waiting for 3m");
  });

  it("names an assistant whose agent isn't known by its role alone, with the plain terminal glyph", async () => {
    directory.entries = [assistant(0, { agentId: null })];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    const [row] = assistantRows();
    expect(row!.getAttribute("aria-label")).toBe("Daintree Assistant, Session 1");
    expect(
      row!
        .querySelector("[data-canopy-lead] [data-terminal-icon-id]")!
        .getAttribute("data-terminal-icon-id")
    ).toBe("terminal");
  });

  it("dates each assistant from what its row says, and steps up only an ask left waiting (#15370)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const minutes = (count: number) => NOW - count * 60_000;
    directory.entries = [
      assistant(0, { waitingReason: "question", since: minutes(5) }),
      assistant(1, { waitingReason: "question", since: minutes(4.9) }),
      assistant(2, { since: minutes(20.5) }),
      assistant(3, { since: null }),
      assistant(4, {
        agentState: "working",
        waitingReason: null,
        since: minutes(20.5),
        confirmations: {
          waiting: [{ actionId: "worktree.delete", since: NOW - 5_000, expiresAt: NOW + 60_000 }],
          omitted: 0,
        },
      }),
      assistant(5, { since: minutes(30.5), handback: { observedAt: minutes(10.5) } }),
    ];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    const lane = (index: number) =>
      assistantRows().find((row) => row.id.includes(encodeURIComponent(`"help-${index}"`)))!;
    const clock = (index: number) => {
      const age = lane(index).querySelector("[data-canopy-age]");
      return age === null ? null : [age.textContent, age.getAttribute("data-overdue")];
    };
    expect([0, 1, 2, 3, 4, 5].map(clock)).toEqual([
      ["5m", "true"],
      ["4m", null],
      ["20m", null],
      null,
      ["now", null],
      ["10m", null],
    ]);
    expect(description(lane(0))).toContain("waiting a while");
    expect(description(lane(1))).not.toContain("waiting a while");
    expect(description(lane(5))).toContain("handed back 10m ago");
  });

  it("gives the global assistant its scope where a project would be", async () => {
    directory.entries = [
      assistant(0, {
        subject: { hostId: "local", scope: { kind: "global" }, terminalId: "g-1", incarnation: 4 },
      }),
    ];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    const [row] = assistantRows();
    expect(row!.getAttribute("aria-label")).toBe("Daintree Assistant, Claude");
    expect(row!.querySelector("[data-canopy-where]")!.textContent).toBe("Global");
  });

  it("gives supervision the row's one note, and all of it to the pane (#15370)", async () => {
    directory.entries = [
      assistant(0, { notices: { pending: 2, ready: 1, delivery: "held" }, attached: false }),
    ];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    const [row] = assistantRows();
    const notes = row!.querySelectorAll("[data-canopy-assistant-note]");
    expect(notes).toHaveLength(1);
    // On the status line, beside what it is doing.
    const status = row!.querySelector("[data-canopy-lead]")!.nextElementSibling!.children[1]!;
    expect(notes[0]!.parentElement).toBe(status);
    expect(notes[0]!.textContent).toBe("1 notice not delivered (held for now)");
    expect(row!.querySelector("[data-canopy-assistant-supervision]")).toBeNull();
    const pane = document
      .querySelector("[data-testid=canopy-assistant-pane]")!
      .querySelector("[data-canopy-assistant-supervision]")!.textContent;
    for (const said of [
      "Watching 2 terminals",
      "1 notice not delivered (held for now)",
      "No window here",
    ]) {
      expect(pane).toContain(said);
      expect(description(row!)).toContain(said);
    }
  });

  it("shows only workers, then only assistants, keeping the choice for the next opening", async () => {
    render(<CanopyView frame={frame} />);
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
    render(<CanopyView frame={frame} />);
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

  it("counts workers and assistants in the header and ranks the asking ones in the band", async () => {
    directory.entries = [
      assistant(0, { waitingReason: "question" }),
      assistant(1, { waitingReason: "approval" }),
      assistant(2),
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
    render(<CanopyView frame={frame} />);
    await settle();
    const header = document.querySelector("[data-canopy-standalone]")!.textContent ?? "";
    expect(header).toContain("2 agents and 2 assistants need you");
    const band = document.querySelector("[data-testid=canopy-needs-you]")!.parentElement!;
    expect(
      Array.from(band.querySelectorAll("[data-canopy-assistant]")).map((row) =>
        row.getAttribute("data-ask")
      )
    ).toEqual(["question", "approval"]);
    const section = document.getElementById("canopy-assistants")!;
    expect(section.querySelectorAll("[data-canopy-assistant]")).toHaveLength(1);
  });

  it("draws the band's headings for an asking assistant alone, and none under the Assistants filter", async () => {
    directory.entries = [assistant(0, { waitingReason: "question" })];
    useFleetSnapshotStore.setState({
      snapshot: {
        ...useFleetSnapshotStore.getState().snapshot!,
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
      },
    });
    render(<CanopyView frame={frame} />);
    await settle();
    const scroller = () => document.querySelector("[data-canopy-list]")!;
    const bandLabel = document.getElementById("canopy-needs-you-label")!;
    expect(bandLabel.classList.contains("sr-only")).toBe(false);
    expect(bandLabel.parentElement!.querySelectorAll("[data-canopy-assistant]")).toHaveLength(1);
    expect(scroller().hasAttribute("data-band-headings")).toBe(true);
    expect(emptyLines()).toEqual([]);
    await act(async () => fireEvent.click(roleSegment("assistants")));
    expect(scroller().hasAttribute("data-band-headings")).toBe(false);
  });

  it("keeps an asking assistant in its own list under the Assistants filter", async () => {
    directory.entries = [assistant(0, { waitingReason: "question" })];
    render(<CanopyView frame={frame} />);
    await settle();
    await act(async () => fireEvent.click(roleSegment("assistants")));
    expect(
      document.getElementById("canopy-assistants")!.querySelectorAll("[data-ask]")
    ).toHaveLength(1);
    expect(document.querySelector("[data-testid=canopy-needs-you]")).toBeNull();
  });

  it("never hands an assistant to the reader: not shown, searched or seen as a worker", async () => {
    const canopy = installElectron();
    render(<CanopyView frame={frame} />);
    await settle();
    await act(async () => fireEvent.click(roleSegment("assistants")));
    await act(async () => {
      fireEvent.change(
        document.querySelector<HTMLInputElement>("[data-canopy-standalone] input[role=combobox]")!,
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
    render(<CanopyView frame={frame} />);
    await settle();
    const search = document.querySelector<HTMLInputElement>(
      "[data-canopy-standalone] input[role=combobox]"
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

  it("steps between the last assistant and the Archived bar below it, shut or open", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [
          run("waiting", { agentState: "waiting", waitingReason: "approval", since: NOW - 60_000 }),
          run("done", { agentState: "completed", since: NOW - 90_000 }),
        ],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    const archived: CanopySnapshot = {
      ...canopySnapshot,
      dispositions: [{ runId: "done", spawnedAt: NOW - 3_600_000, kind: "archived", at: NOW }],
    };
    // Opening the panel takes main's answer over the store's snapshot.
    canopyBridge.setActive.mockImplementation(async () => archived);
    useCanopyStore.setState({ snapshot: archived });
    render(<CanopyView frame={frame} />);
    await settle();
    const bar = () =>
      document.querySelector<HTMLButtonElement>("button[aria-controls=canopy-archived]")!;
    const [, lastAssistant] = assistantRows();
    act(() => lastAssistant!.focus());
    fireEvent.keyDown(lastAssistant!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(bar());
    fireEvent.keyDown(bar(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(lastAssistant);
    // Open, the bar still goes up to the assistant above it, not the archived row below.
    fireEvent.click(bar());
    expect(document.getElementById("canopy-card-done")).not.toBeNull();
    act(() => bar().focus());
    fireEvent.keyDown(bar(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(lastAssistant);
  });

  it("dictates into the selected worker's reply, and into nothing while an assistant is selected", async () => {
    const view = render(<CanopyView frame={frame} />);
    await settle();
    const search = document.querySelector<HTMLInputElement>(
      "[data-canopy-standalone] input[role=combobox]"
    )!;
    fireEvent.keyDown(search, { key: "Tab" });
    const first = document.getElementById("canopy-card-waiting")!;
    expect(document.activeElement).toBe(first);
    const stream = terminalApis.filter((entry) => entry.runId === "waiting").at(-1)!;
    await act(async () =>
      stream.onStreamChange?.({ watchId: 7, ended: false, secretPrompt: false })
    );

    const reply = resolveCanopyReplyDictation();
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.target.panelId).toBe(canopyReplyVoiceId("waiting"));

    const last = document.getElementById("canopy-card-working")!;
    fireEvent.keyDown(first, { key: "ArrowDown" });
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(document.querySelector("[data-testid=canopy-assistant-pane]")).not.toBeNull();
    expect(resolveCanopyReplyDictation()).toMatchObject({
      ok: false,
      message: expect.stringContaining("Select an agent"),
    });

    view.unmount();
    expect(resolveCanopyReplyDictation().ok).toBe(false);
  });

  it("opens the exact lane on Enter, and offers no worker action on an assistant row", async () => {
    render(<CanopyView frame={frame} />);
    await settle();
    const row = assistantRows()[1]!;
    expect(row.querySelector("[data-canopy-row-archive]")).toBeNull();
    await act(async () => {
      row.focus();
      fireEvent.keyDown(row, { key: "Enter" });
    });
    expect(frame.openAssistant).toHaveBeenCalledTimes(1);
    expect(frame.openAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ subject: assistant(1).subject }),
      expect.any(Function)
    );
    expect(dispatchMock).not.toHaveBeenCalled();
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
    render(<CanopyView frame={frame} />);
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
    expect(frame.openAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ subject: assistant(1).subject }),
      expect.any(Function)
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("opens the global assistant by its exact subject, as it opens a lane (#14454)", async () => {
    const global = assistant(0, {
      subject: { hostId: "local", scope: { kind: "global" }, terminalId: "g-1", incarnation: 4 },
    });
    directory.entries = [global];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open in Assistant"
    )!;
    await act(async () => fireEvent.click(open));
    expect(frame.openAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ subject: global.subject }),
      expect.any(Function)
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("says nothing of supervision for an assistant that watches nothing", async () => {
    directory.entries = [assistant(0, { notices: null })];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    expect(document.querySelector("[data-canopy-assistant-supervision]")).toBeNull();
    expect(document.querySelector("[data-canopy-assistant-note]")).toBeNull();
    expect(assistantRows()[0]!.getAttribute("data-ask")).toBeNull();
  });

  it("says why a lane couldn't be opened, and starts nothing in its place", async () => {
    vi.mocked(frame.openAssistant).mockResolvedValueOnce(ENDED);
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open in Assistant"
    )!;
    await act(async () => fireEvent.click(open));
    expect(document.body.textContent).toContain("Couldn't open this assistant");
    expect(document.body.textContent).toContain(ENDED);
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["the newer one went through", null],
    ["the newer one was refused too", "This assistant runs without a window here."],
  ])("shows only the newest open's answer, when %s", async (_label, newer) => {
    let refuseEarlier: (text: string) => void = () => {};
    let answerNewer: (text: string | null) => void = () => {};
    vi.mocked(frame.openAssistant)
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            refuseEarlier = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            answerNewer = resolve;
          })
      );
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    const open = () =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Open in Assistant"
      )!;
    await act(async () => fireEvent.click(open()));
    await act(async () => fireEvent.click(open()));
    // The newer answers first, then the earlier settles over it.
    await act(async () => answerNewer(newer));
    await act(async () => refuseEarlier(ENDED));

    expect(frame.openAssistant).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(ENDED);
    if (newer === null) {
      expect(document.body.textContent).not.toContain("Couldn't open this assistant");
    } else {
      expect(document.body.textContent).toContain(newer);
    }
  });

  it("shows the newest open's refusal when the earlier one settles first", async () => {
    const NEWER = "This assistant runs without a window here.";
    let refuseEarlier: (text: string) => void = () => {};
    let refuseNewer: (text: string) => void = () => {};
    vi.mocked(frame.openAssistant)
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            refuseEarlier = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            refuseNewer = resolve;
          })
      );
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    const open = () =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Open in Assistant"
      )!;
    await act(async () => fireEvent.click(open()));
    await act(async () => fireEvent.click(open()));
    await act(async () => refuseEarlier(ENDED));
    await act(async () => refuseNewer(NEWER));

    expect(document.body.textContent).not.toContain(ENDED);
    expect(document.body.textContent).toContain(NEWER);
  });

  it("marks a handback seen only for the assistant chosen, never by default", async () => {
    directory.entries = [
      assistant(0, { handback: { observedAt: NOW - 500 } }),
      assistant(1, { handback: { observedAt: NOW - 400 } }),
    ];
    useCanopyStore.setState({ roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
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
    render(<CanopyView frame={frame} />);
    await settle();
    expect(emptyLines()).toEqual(["Daintree couldn't list every assistant just now"]);
    expect(document.body.textContent).not.toContain("No assistant is running");
    expect(document.body.textContent).not.toContain("Start an assistant");
  });

  it("draws no 0 over an empty Assistants section, and names how to start one", async () => {
    const countOf = (id: string) =>
      document.getElementById(id)!.querySelector("[data-slot=count-badge]");
    const first = render(<CanopyView frame={frame} />);
    await settle();
    expect(countOf("canopy-assistants-label")).not.toBeNull();
    first.unmount();
    useCanopyStore.setState({ isOpen: true });

    directory = { coverage: "ok", observedAt: NOW, complete: true, omitted: 0, entries: [] };
    render(<CanopyView frame={frame} />);
    await settle();
    expect(countOf("canopy-assistants-label")).toBeNull();
    expect(emptyLines()).toContain("Start an assistant from the Assistant panel");
    // The inbox above it still counts its rows.
    expect(countOf("canopy-inbox-label")).not.toBeNull();
  });

  it("asks for reading in the pitch alone with the reader off, whichever role the list shows", async () => {
    const off = { ...canopySnapshot, activated: false, cards: [], glances: [] };
    installElectron().setActive.mockResolvedValue(off);
    useCanopyStore.setState({ snapshot: off, roleFilter: "assistants" });
    render(<CanopyView frame={frame} />);
    await settle();
    expect(document.getElementById("canopy-pitch-title")).not.toBeNull();
    expect(assistantRows()).toHaveLength(0);
    expect(document.querySelector("[data-canopy-reading-offer]")).toBeNull();
    act(() => useCanopyStore.getState().setRoleFilter("all"));
    await settle();
    expect(document.getElementById("canopy-pitch-title")).not.toBeNull();
    expect(document.querySelector("[role=listbox]")).toBeNull();
    expect(document.querySelector("[data-canopy-reading-offer]")).toBeNull();
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
    render(<CanopyView frame={frame} />);
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
    expect(emptyLines()).toContain("None found on the hosts that could be read");
    // An empty inbox still counts its rows: none.
    expect(
      document
        .getElementById("canopy-inbox-label")!
        .querySelector("[data-slot=count-badge] [aria-hidden]")?.textContent
    ).toBe("0");
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

describe("CanopyView's docked global assistant (#16214)", () => {
  const dock = () => document.querySelector<HTMLElement>("[data-canopy-global]");
  /** One per stream the pane opened: each mount of its terminal makes its own api. */
  const globalStreams = () =>
    assistantApiMock.mock.calls.filter(([subject]) => subject.terminalId === "g-1");
  const globalApiStamps = () => globalStreams().map(([, stamp]) => stamp);
  const stepChord = (key: "ArrowUp" | "ArrowDown") =>
    isMac() ? { key, metaKey: true } : { key, altKey: true };
  const buttonIn = (root: Element, label: string) =>
    [...root.querySelectorAll("button")].find((button) => button.textContent === label);

  beforeEach(() => {
    directory.entries = [assistant(0), assistant(0, { subject: GLOBAL_SUBJECT })];
  });

  it("shows the global assistant beside the selected worker, typing under the input it holds", async () => {
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    expect(document.getElementById("canopy-detail-waiting")).not.toBeNull();
    const pane = dock()!;
    expect(pane.querySelector("[data-canopy-assistant-state]")!.textContent).toBe("At its prompt");
    expect(globalApiStamps().at(-1)).toEqual({ attachmentId: "attachment-1", inputEpoch: 1 });
    expect(pane.querySelector("[data-testid=help-global-input-elsewhere]")).toBeNull();

    // Another worker selected: the assistant beside it keeps its stream.
    const opened = globalStreams().length;
    const first = document.getElementById("canopy-card-waiting")!;
    await act(async () => {
      first.focus();
      fireEvent.keyDown(first, { key: "ArrowDown" });
    });
    await settle();
    expect(document.getElementById("canopy-detail-working")).not.toBeNull();
    expect(globalStreams()).toHaveLength(opened);
    expect(electronHelp().detachGlobalAssistant).not.toHaveBeenCalled();
  });

  it("docks from the header and is kept, the toggle's name never changing", async () => {
    render(<CanopyView frame={frame} />);
    await settle();
    expect(dock()).toBeNull();
    const toggle = document.querySelector<HTMLElement>("[data-testid=canopy-global-toggle]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(toggle));
    await settle();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Global assistant");
    expect(toggle.getAttribute("aria-controls")).toBe(dock()!.id);
    expect(window.localStorage.getItem("daintree-canopy-global-docked")).toBe("1");
    expect(document.getElementById("canopy-detail-waiting")).not.toBeNull();

    await act(async () => fireEvent.click(toggle));
    await settle();
    expect(dock()).toBeNull();
    expect(toggle.getAttribute("aria-label")).toBe("Global assistant");
    expect(electronHelp().detachGlobalAssistant).toHaveBeenCalledWith("attachment-1");
  });

  it("stays docked whatever the filters hide", async () => {
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    expect(
      assistantRows().map((row) => row.querySelector("[data-canopy-where]")!.textContent)
    ).toEqual(["🌳app", "Global"]);

    act(() => useCanopyStore.getState().setRoleFilter("workers"));
    await settle();
    expect(assistantRows()).toHaveLength(0);
    expect(dock()!.querySelector("[data-canopy-assistant-state]")).not.toBeNull();
  });

  it("keeps its stream open when the directory lists it only after it showed", async () => {
    let answer: (read: AgentDirectory) => void = () => {};
    canopyBridge.readAgentDirectory.mockImplementationOnce(
      () => new Promise<AgentDirectory>((resolve) => (answer = resolve))
    );
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    expect(dock()!.querySelector("[data-canopy-assistant-state]")).toBeNull();
    expect(globalStreams()).toHaveLength(1);
    await act(async () => answer(directory));
    await settle();
    expect(dock()!.querySelector("[data-canopy-assistant-state]")).not.toBeNull();
    expect(globalStreams()).toHaveLength(1);
  });

  it("steps to the next agent from its composer with the keyboard left there", async () => {
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    const composer = dock()!.querySelector<HTMLElement>("[data-testid=global-composer]")!;
    act(() => composer.focus());
    await act(async () => fireEvent.keyDown(composer, stepChord("ArrowDown")));
    await settle();
    expect(document.getElementById("canopy-detail-working")).not.toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("shows one pane for the global assistant's own row, without reopening its stream", async () => {
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    const opened = globalStreams().length;
    const row = assistantRows().find((each) => each.textContent?.includes("Global"))!;
    await act(async () => fireEvent.click(row));
    await settle();
    expect(document.querySelectorAll("[data-testid=canopy-global-assistant]")).toHaveLength(1);
    expect(document.querySelector("[data-canopy-card-detail]")).toBeNull();
    expect(document.getElementById("canopy-detail-waiting")).toBeNull();
    expect(globalStreams()).toHaveLength(opened);
  });

  it("opens the Assistant from the dock with the worker still selected beside it", async () => {
    vi.mocked(frame.openAssistant).mockResolvedValueOnce(ENDED);
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    await act(async () => fireEvent.click(buttonIn(dock()!, "Open in Assistant")!));
    await settle();
    expect(frame.openAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ subject: GLOBAL_SUBJECT }),
      expect.any(Function)
    );
    expect(dock()!.textContent).toContain("Couldn't open this assistant");
    expect(document.getElementById("canopy-detail-waiting")).not.toBeNull();
  });

  it("offers to start the global assistant when none runs, and starts nothing by itself", async () => {
    globalView = globalRunning({ phase: "absent", subject: null, terminalId: null });
    directory.entries = [assistant(0)];
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    const start = dock()!.querySelector<HTMLElement>("[data-testid=canopy-global-start]")!;
    expect(electronHelp().ensureGlobalAssistant).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(start));
    expect(electronHelp().ensureGlobalAssistant).toHaveBeenCalledTimes(1);
  });

  it("waits on a launch as the Assistant panel does, and its Cancel stops that launch (#16603)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const absent = { phase: "absent" as const, subject: null, terminalId: null };
      globalView = globalRunning({ ...absent, phase: "launching", generation: 3 });
      directory.entries = [assistant(0)];
      electronHelp().cancelGlobalAssistantLaunch.mockImplementation(async () => {
        globalView = globalRunning({ ...absent, generation: 4 });
        return globalView;
      });
      useCanopyStore.setState({ globalDocked: true });
      render(<CanopyView frame={frame} />);
      await settle();
      expect(buttonIn(dock()!, "Cancel")).toBeUndefined();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      await act(async () => fireEvent.click(buttonIn(dock()!, "Cancel")!));
      expect(electronHelp().cancelGlobalAssistantLaunch).toHaveBeenCalledWith(3);
      expect(electronHelp().ensureGlobalAssistant).not.toHaveBeenCalled();
      expect(dock()!.querySelector("[data-testid=canopy-global-start]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the dock up with no agent running, its start offer in reach", async () => {
    globalView = globalRunning({ phase: "absent", subject: null, terminalId: null });
    directory.entries = [];
    useFleetSnapshotStore.setState({
      snapshot: { runs: [], changedAt: NOW, degraded: false, lastSuccessfulAt: NOW },
    });
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    expect(dock()!.querySelector("[data-testid=canopy-global-start]")).not.toBeNull();
  });

  it("asks before taking input another window holds", async () => {
    globalView = globalRunning({ inputOwner: "another-window", inputEpoch: 3 });
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    expect(electronHelp().claimGlobalAssistantInput).not.toHaveBeenCalled();
    expect(globalApiStamps().at(-1)).toBeUndefined();
    const take = dock()!.querySelector<HTMLElement>("[data-testid=help-global-take-input]")!;
    act(() => take.focus());
    await act(async () => fireEvent.click(take));
    await settle();
    expect(electronHelp().claimGlobalAssistantInput).toHaveBeenCalledWith("attachment-1");
    expect(globalApiStamps().at(-1)).toEqual({ attachmentId: "attachment-1", inputEpoch: 4 });
    // The button went with the stream it was in; the keyboard follows to the composer.
    expect(document.activeElement).toBe(dock()!.querySelector("[data-testid=global-composer]"));
  });

  it("dictates into nothing while the keyboard is in the dock, and says why", async () => {
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    const stream = terminalApis.filter((entry) => entry.runId === "waiting").at(-1)!;
    await act(async () =>
      stream.onStreamChange?.({ watchId: 7, ended: false, secretPrompt: false })
    );
    expect(resolveCanopyReplyDictation().ok).toBe(true);
    act(() => buttonIn(dock()!, "Open in Assistant")!.focus());
    expect(resolveCanopyReplyDictation()).toMatchObject({
      ok: false,
      message: expect.stringContaining("agent's reply"),
    });
  });

  it("keeps Escape in its terminal for the agent, with Canopy left open", async () => {
    useCanopyStore.setState({ globalDocked: true });
    render(<CanopyView frame={frame} />);
    await settle();
    const terminal = dock()!.querySelector<HTMLElement>("[data-canopy-terminal]")!;
    fireEvent.keyDown(terminal, { key: "Escape" });
    expect(useCanopyStore.getState().isOpen).toBe(true);
  });
});
