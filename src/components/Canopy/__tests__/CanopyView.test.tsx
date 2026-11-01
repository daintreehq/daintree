// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

/** The app root provides tooltips; the rows' action buttons need one. */
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { CanopyCard, CanopySnapshot } from "@shared/types/ipc/canopy";

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
interface ReplyRoute {
  submitText: (text: string, imagePaths: readonly string[]) => Promise<boolean>;
  sendEnter: () => void;
}
// What the pane hands its terminal and reply, for a test to open the stream and send.
const pane = vi.hoisted(() => ({
  stream: null as
    ((state: { watchId: number; ended: boolean; secretPrompt: boolean }) => void) | null,
  reply: null as {
    submitText: (text: string, imagePaths: readonly string[]) => Promise<boolean>;
    modEnterSend?: () => ReplyRoute;
    ref?: React.Ref<{ focus: () => void }>;
  } | null,
  /** The reply draws an editor that takes the keyboard; off, it draws nothing. */
  editable: false,
}));
// The pane's live terminal needs a canvas and a PTY host; the list is what is tested here.
vi.mock("../CanopyTerminal", () => ({
  CanopyTerminal: ({
    runId,
    onStreamChange,
  }: {
    runId: string;
    onStreamChange: NonNullable<typeof pane.stream>;
  }) => {
    pane.stream = onStreamChange;
    return (
      <div data-canopy-terminal="" data-run={runId}>
        <textarea aria-label="Terminal input" />
      </div>
    );
  },
}));
vi.mock("@/components/Terminal/HybridInputBar", async () => {
  const { useImperativeHandle, useRef } = await import("react");
  return {
    HybridInputBar: (props: NonNullable<typeof pane.reply>) => {
      pane.reply = props;
      const editor = useRef<HTMLDivElement>(null);
      useImperativeHandle(props.ref, () => ({ focus: () => editor.current?.focus() }));
      if (!pane.editable) return null;
      return (
        <div className="cm-editor">
          <div ref={editor} tabIndex={-1} data-reply-editor="" />
        </div>
      );
    },
  };
});
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
const lifecycle = vi.hoisted(() => new Set<(phase: string) => void>());
const viewCached = vi.hoisted(() => ({ current: false }));
vi.mock("@/lib/viewCacheState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/viewCacheState")>()),
  isProjectViewCached: () => viewCached.current,
  // The real one reads the module's own flag, which this mock doesn't reach.
  isProjectViewObservable: () => !viewCached.current,
  subscribeProjectViewLifecycle: (listener: (phase: string) => void) => {
    lifecycle.add(listener);
    return () => lifecycle.delete(listener);
  },
}));

import { notify } from "@/lib/notify";
import { CanopyView } from "../CanopyView";
import { CANOPY_TITLE } from "../canopyTerms";
import { useCanopyStore } from "@/store/canopyStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";
import { CANOPY_REVEAL_MS } from "../canopyOrder";

const NOW = Date.now();

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

let fleetApi = {
  parkRun: vi.fn(async (_runId: string, _input?: unknown) => {}),
  unparkRun: vi.fn(async (_runId: string) => {}),
  snoozeRun: vi.fn(async (_runId: string, _option: string) => {}),
  unsnoozeRun: vi.fn(async (_runId: string) => {}),
};

function installElectron(
  snapshot: CanopySnapshot = canopySnapshot,
  branchOf: (runId: string) => Promise<string | null> = async (runId) => `feature/${runId}`
) {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    trash: vi.fn(async (): Promise<number | null> => null),
    untrash: vi.fn(async () => {}),
    reread: vi.fn(async () => {}),
    setShown: vi.fn(async () => {}),
    archive: vi.fn(
      async (
        runId: string,
        target: { spawnedAt: number },
        _expectTurn?: number
      ): Promise<unknown> => ({
        runId,
        spawnedAt: target.spawnedAt,
        turn: 0,
        readTurn: 0,
        markedUnreadAt: null,
        version: 1,
      })
    ),
    unarchive: vi.fn(async () => {}),
    setScope: vi.fn(async () => {}),
    markSeen: vi.fn(async (_runId: string, _looking?: boolean, _place?: string) => {}),
    // Each read change answers with the mark it left, as main does.
    setRead: vi.fn(
      async (runId: string, target: { spawnedAt: number }, read: boolean, turn?: number) => ({
        runId,
        spawnedAt: target.spawnedAt,
        turn: turn ?? 0,
        readTurn: read ? (turn ?? 0) : 0,
        markedUnreadAt: read ? null : NOW,
        version: 2,
      })
    ),
    markAllRead: vi.fn(async (targets: Array<{ runId: string; spawnedAt: number; turn: number }>) =>
      targets.map((target) => ({
        ...target,
        readTurn: target.turn,
        markedUnreadAt: null,
        version: 2,
      }))
    ),
    restoreReads: vi.fn(async (_restores: unknown[]) => {}),
    runBranch: vi.fn((runId: string, _target: { spawnedAt: number }) => branchOf(runId)),
    searchScreens: vi.fn(
      async (_targets: Array<{ runId: string; spawnedAt: number; terms: string[] }>) =>
        [] as string[]
    ),
    // No assistants: a full, empty directory of this machine.
    readAgentDirectory: vi.fn(async () => ({
      coverage: "ok" as const,
      observedAt: 1,
      complete: true,
      omitted: 0,
      entries: [],
    })),
    rename: vi.fn(async (_runId: string, _target: { spawnedAt: number }, _title: string) => {}),
    setMode: vi.fn(async (mode: CanopySnapshot["mode"], _expectRevision?: number) => ({
      ...snapshot,
      mode,
      modeRevision: 5,
      activated: mode === "on",
    })),
  };
  fleetApi = {
    parkRun: vi.fn(async () => {}),
    unparkRun: vi.fn(async () => {}),
    snoozeRun: vi.fn(async () => {}),
    unsnoozeRun: vi.fn(async () => {}),
  };
  Object.defineProperty(window, "electron", {
    value: {
      canopy,
      fleet: fleetApi,
      terminal: { restore: vi.fn() },
      system: { openExternal: vi.fn() },
    },
    configurable: true,
    writable: true,
  });
  return canopy;
}

/** The status bar's offer: there whether or not the callout above the list is. */
async function openOffer() {
  const bar = document.querySelector<HTMLElement>("[data-canopy-status]")!;
  await act(async () => {
    fireEvent.click(within(bar).getByRole("button", { name: "Turn on reading", hidden: true }));
  });
  await frames();
}

/** The callout offering reading above a listed inbox; null while it isn't shown. */
function readingCallout(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-canopy-reading-offer]");
}

function screenButton(root: HTMLElement, name: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>("button")].find(
    (button) => button.textContent?.trim() === name
  );
  if (!found) throw new Error(`No button "${name}"`);
  return found;
}

/** The header's line beside the title. */
function summaryWords() {
  return document.querySelector("[data-testid=canopy-summary]")?.textContent ?? "";
}

/** What the empty Needs you band says, above the listbox; null while it has rows. */
function bandWords() {
  return (
    document.querySelector(
      "[role=group][aria-labelledby=canopy-needs-you-label] [data-canopy-empty-line]"
    )?.textContent ?? null
  );
}

/** Drain the landing effect's two animation frames. */
async function frames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

beforeEach(() => {
  __resetCanopySeenForTests();
  __resetCanopyPlaceForTests();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useProjectStore.setState({
    projects: [{ id: "p1", path: "/repo", name: "app", emoji: "🌳", lastOpened: NOW }],
  });
  useFleetSnapshotStore.setState({
    snapshot: {
      runs: [
        run("waiting", { agentState: "waiting", waitingReason: "approval", since: NOW - 60_000 }),
        run("asking", { agentState: "waiting", waitingReason: "question", since: NOW - 40_000 }),
        run("working", { agentState: "working", since: NOW - 30_000 }),
      ],
      changedAt: NOW,
      degraded: false,
      lastSuccessfulAt: NOW,
    },
  });
  useCanopyStore.setState({ isOpen: true, snapshot: canopySnapshot, mode: "on" });
});

afterEach(() => {
  useCanopyStore.setState({
    isOpen: false,
    snapshot: null,
    mode: "unset",
    scope: "all",
    orders: {},
    unreadOnly: false,
    readingOfferDismissed: false,
    listWidth: null,
    listDrag: null,
  });
  window.localStorage.removeItem("daintree-canopy-order");
  window.localStorage.removeItem("daintree-canopy-reading-offer-dismissed");
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** A reading that puts a working agent above everything: stuck on the same step. */
function stuckCard(runId: string): CanopyCard {
  return {
    runId,
    spawnedAt: NOW - 3_600_000,
    revision: 2,
    category: "working",
    confidence: 0.9,
    attentionProbability: 0.9,
    attentionScore: 95,
    priority: 95,
    stage: "described",
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    wordsCategory: "working",
    describing: false,
    task: null,
    headline: "Retrying the same failing install",
    summary: null,
    question: null,
    options: [],
    secretPrompt: false,
    risk: "unknown",
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

/** A question read as a quiet one: worth answering, not paging for. */
function quietQuestion(runId: string): CanopyCard {
  return {
    ...stuckCard(runId),
    category: "question",
    wordsCategory: "question",
    attentionScore: 70,
    priority: 70,
    headline: "Asks which port to use",
    question: "Which port should the server use?",
  };
}

/** A run with turns the user hasn't read. */
function unreadMark(runId: string, turn: number) {
  return { runId, spawnedAt: NOW - 3_600_000, turn, readTurn: 0, markedUnreadAt: null, version: 1 };
}

function liveRun(container: HTMLElement) {
  return container.ownerDocument.querySelector("[data-canopy-terminal]")?.getAttribute("data-run");
}

function cards(container: HTMLElement) {
  return [...container.ownerDocument.querySelectorAll<HTMLElement>("[data-canopy-card]")];
}

function searchInput() {
  return document.querySelector<HTMLInputElement>(
    "[data-testid=canopy-dialog] input[role=combobox]"
  )!;
}

function selectedRun(container: HTMLElement) {
  return cards(container)
    .find((card) => card.getAttribute("aria-selected") === "true")
    ?.id.replace(/^canopy-card-/, "");
}

/** Past the panel's wait on the typing before it reads terminals for a search. */
const SCREEN_SEARCH_SETTLE_MS = 250;

async function screenSearchSettled() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SCREEN_SEARCH_SETTLE_MS));
  });
}

async function search(value: string) {
  await act(async () => {
    fireEvent.change(searchInput(), { target: { value } });
  });
}

function terminalInput(container: HTMLElement) {
  return container.ownerDocument.querySelector<HTMLTextAreaElement>(
    "[data-canopy-terminal] textarea"
  )!;
}

describe("CanopyView search", () => {
  it("keeps every plain key typed into the search from acting on an agent", async () => {
    const snapshot = {
      ...canopySnapshot,
      cards: [
        {
          ...stuckCard("waiting"),
          category: "approval" as const,
          wordsCategory: "approval" as const,
          question: "Do you want to proceed?",
          options: ["Yes", "No"],
          risk: "none" as const,
        },
      ],
      reads: [unreadMark("waiting", 2)],
    };
    useCanopyStore.setState({ snapshot });
    const canopy = installElectron(snapshot);
    const answer = vi.fn(async () => {});
    Object.assign(canopy, { answer });
    const { container } = render(<CanopyView />);
    await frames();
    const input = searchInput();
    expect(selectedRun(container)).toBe("waiting");
    for (const key of ["1", "2", "y", "Y", "r", "e", "u", "z", "j", "k"]) {
      fireEvent.keyDown(input, { key });
    }
    expect(canopy.archive).not.toHaveBeenCalled();
    expect(canopy.setRead).not.toHaveBeenCalled();
    expect(canopy.trash).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    // The same key on the row answers: the search alone held it back.
    fireEvent.keyDown(input, { key: "Tab" });
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "y" });
    });
    expect(answer).toHaveBeenCalled();
  });

  it("narrows the list to the runs a query names, selecting the top match", async () => {
    const snapshot = { ...canopySnapshot, cards: [stuckCard("working")] };
    useCanopyStore.setState({ snapshot });
    installElectron(snapshot);
    const { container } = render(<CanopyView />);
    await frames();
    expect(cards(container)).toHaveLength(3);

    await search("FAILING install");
    expect(cards(container).map((card) => card.id)).toEqual(["canopy-card-working"]);
    expect(selectedRun(container)).toBe("working");
    expect(liveRun(container)).toBe("working");

    await search("failing nowhere");
    expect(cards(container)).toHaveLength(0);
    expect(document.body.textContent).toContain("No agent matches");

    // Escape clears the search before it closes anything.
    await act(async () => {
      fireEvent.keyDown(searchInput(), { key: "Escape" });
    });
    expect(searchInput().value).toBe("");
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(cards(container)).toHaveLength(3);
  });

  it("asks main only for the words a run doesn't hold, and lists what its terminal does", async () => {
    const canopy = installElectron();
    canopy.searchScreens.mockImplementation(async (targets) =>
      targets.filter((target) => target.runId === "asking").map((target) => target.runId)
    );
    const { container } = render(<CanopyView />);
    await frames();

    await search("app segfault");
    // Not on every keystroke: the terminals are read once the typing rests.
    expect(canopy.searchScreens).not.toHaveBeenCalled();
    expect(cards(container)).toHaveLength(0);
    await screenSearchSettled();
    expect(canopy.searchScreens).toHaveBeenCalledTimes(1);
    const targets = canopy.searchScreens.mock.calls[0]![0];
    // "app" is every run's project: only the word nothing on them holds is asked.
    expect(targets.map((target) => target.terms)).toEqual([
      ["segfault"],
      ["segfault"],
      ["segfault"],
    ]);
    expect(cards(container).map((card) => card.id)).toEqual(["canopy-card-asking"]);
    expect(selectedRun(container)).toBe("asking");
  });

  it("selects the top terminal match, wherever the selection was before", async () => {
    const canopy = installElectron();
    canopy.searchScreens.mockImplementation(async (targets) =>
      targets.map((target) => target.runId).filter((runId) => runId !== "waiting")
    );
    const { container } = render(<CanopyView />);
    await frames();
    const input = searchInput();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selectedRun(container)).toBe(cards(container)[2]!.id.replace(/^canopy-card-/, ""));

    await search("segfault");
    await screenSearchSettled();
    const shown = cards(container);
    expect(shown).toHaveLength(2);
    expect(selectedRun(container)).toBe(shown[0]!.id.replace(/^canopy-card-/, ""));
  });

  it("asks nothing of a terminal for words past what main takes", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    await search(Array.from({ length: 17 }, (_, index) => `word${index}`).join(" "));
    await screenSearchSettled();
    expect(canopy.searchScreens).not.toHaveBeenCalled();
    expect(cards(container)).toHaveLength(0);
  });

  it("comes back to the search with / from a row", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const input = searchInput();
    fireEvent.keyDown(input, { key: "Tab" });
    const row = cards(container)[0]!;
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: "/" });
    expect(document.activeElement).toBe(input);
  });

  it("starts each opening with an empty search", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    await search("waiting");
    act(() => useCanopyStore.getState().close());
    act(() => useCanopyStore.setState({ isOpen: true }));
    await frames();
    expect(searchInput().value).toBe("");
    expect(cards(container)).toHaveLength(3);
  });
});

describe("CanopyView", () => {
  it("lists the agents Daintree observes with the reader off, offering reading beside them", async () => {
    const canopy = installElectron({ ...canopySnapshot, activated: false, cards: [], glances: [] });
    useCanopyStore.setState({
      snapshot: { ...canopySnapshot, activated: false, cards: [], glances: [] },
    });
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    expect(dialog.querySelector("[role=listbox]")).not.toBeNull();
    expect(dialog.querySelectorAll("[data-canopy-card]").length).toBeGreaterThan(0);
    expect(dialog.textContent).not.toContain("Reading the screen");
    expect(dialog.textContent).not.toContain("Checking who needs you");
    expect(dialog.querySelector('button[aria-label="Refresh"]')).toBeNull();
    expect(dialog.querySelector("[data-canopy-pitch], #canopy-pitch-title")).toBeNull();
    expect(canopy.setMode).not.toHaveBeenCalled();
    await openOffer();
    expect(document.getElementById("canopy-pitch-title")).not.toBeNull();
    expect(canopy.setMode).not.toHaveBeenCalled();
  });

  it("covers the window, with nothing of the app behind it and no picture taken of it", async () => {
    const createObjectURL = vi.fn(() => "blob:still");
    const original = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    try {
      const off = { ...canopySnapshot, activated: false };
      installElectron(off);
      useCanopyStore.setState({ snapshot: off });
      render(<CanopyView />);
      await frames();
      const layer = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
      expect(layer.className).not.toMatch(/\bbackdrop-blur-|\bbg-scrim-/);
      expect(layer.firstElementChild?.className ?? "").not.toMatch(/\bmax-w-/);
      // The inbox and the offer share one frame, so the list stays put between them.
      expect(layer.querySelector(".canopy-frame [role=listbox]")).not.toBeNull();
      await openOffer();
      expect(
        document.querySelector("[data-testid=canopy-dialog] .canopy-frame #canopy-pitch-title")
      ).not.toBeNull();
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(document.querySelector("img[src^='blob:']")).toBeNull();
    } finally {
      if (original) Object.defineProperty(URL, "createObjectURL", original);
      else Reflect.deleteProperty(URL, "createObjectURL");
    }
  });

  it("keeps the list at the width the user chose, under the offer as in the inbox", async () => {
    const off = { ...canopySnapshot, activated: false };
    installElectron(off);
    useCanopyStore.setState({ snapshot: off, listWidth: 600 });
    render(<CanopyView />);
    await frames();
    const listWidth = () =>
      document
        .querySelector<HTMLElement>("[data-testid=canopy-dialog] .canopy-list-column")!
        .style.getPropertyValue("--canopy-list-width");
    expect(document.querySelector("[data-testid=canopy-list-resize]")).not.toBeNull();
    expect(listWidth()).toBe("600px");
    await openOffer();
    expect(document.getElementById("canopy-pitch-title")).not.toBeNull();
    expect(listWidth()).toBe("600px");
  });

  it("offers reading above a listed inbox with the reader off, opening the pitch from it", async () => {
    const off = { ...canopySnapshot, activated: false, cards: [], glances: [] };
    const canopy = installElectron(off);
    useCanopyStore.setState({ snapshot: off });
    render(<CanopyView />);
    await frames();
    const callout = readingCallout()!;
    expect(callout.textContent).toContain("on this computer");
    // Above the list, never among its rows.
    const rows = [...document.querySelectorAll<HTMLElement>("[data-canopy-card]")];
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((row) => callout.compareDocumentPosition(row) === Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);
    // The status bar keeps its own offer beside it.
    const bar = document.querySelector<HTMLElement>("[data-canopy-status]")!;
    expect(within(bar).queryByRole("button", { name: "Turn on reading" })).not.toBeNull();
    await act(async () => {
      fireEvent.click(within(callout).getByRole("button", { name: "Turn on reading" }));
    });
    await frames();
    expect(document.getElementById("canopy-pitch-title")).not.toBeNull();
    expect(canopy.setMode).not.toHaveBeenCalled();
  });

  it("puts the reading callout away for good, keeping the status bar's offer and the keyboard", async () => {
    const off = { ...canopySnapshot, activated: false, cards: [], glances: [] };
    installElectron(off);
    useCanopyStore.setState({ snapshot: off });
    const { unmount } = render(<CanopyView />);
    await frames();
    const dismiss = within(readingCallout()!).getByRole("button", {
      name: "Dismiss reading offer",
    });
    act(() => dismiss.focus());
    await act(async () => {
      fireEvent.click(dismiss);
    });
    await frames();
    expect(readingCallout()).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search agents");
    const bar = document.querySelector<HTMLElement>("[data-canopy-status]")!;
    expect(within(bar).queryByRole("button", { name: "Turn on reading" })).not.toBeNull();
    // Closed and opened again: still away.
    unmount();
    render(<CanopyView />);
    await frames();
    expect(document.querySelector("[data-canopy-card]")).not.toBeNull();
    expect(readingCallout()).toBeNull();
  });

  it("offers no reading callout with the reader on, or over an empty list", async () => {
    installElectron();
    const { unmount } = render(<CanopyView />);
    await frames();
    expect(document.querySelector("[data-canopy-card]")).not.toBeNull();
    expect(readingCallout()).toBeNull();
    unmount();

    const off = { ...canopySnapshot, activated: false, cards: [], glances: [] };
    installElectron(off);
    useCanopyStore.setState({ snapshot: off });
    useFleetSnapshotStore.setState({
      snapshot: { ...useFleetSnapshotStore.getState().snapshot!, runs: [] },
    });
    render(<CanopyView />);
    await frames();
    expect(document.body.textContent).toContain("Launch an agent from the toolbar");
    expect(readingCallout()).toBeNull();
  });

  it("still offers reading, quietly, when the reader is off and no agent runs", async () => {
    const off = { ...canopySnapshot, activated: false, cards: [], glances: [] };
    installElectron(off);
    useCanopyStore.setState({ snapshot: off });
    useFleetSnapshotStore.setState({
      snapshot: { ...useFleetSnapshotStore.getState().snapshot!, runs: [] },
    });
    render(<CanopyView />);
    await frames();
    expect(document.body.textContent).toContain("Launch an agent from the toolbar");
    await openOffer();
    expect(document.getElementById("canopy-pitch-title")).not.toBeNull();
  });

  it("reads nothing until the user turns it on, showing a demo and what turning it on does", async () => {
    const canopy = installElectron({ ...canopySnapshot, activated: false });
    useCanopyStore.setState({ snapshot: { ...canopySnapshot, activated: false } });
    render(<CanopyView />);
    await frames();
    await openOffer();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    // What turning it on does, and how to stop, said where it is turned on.
    expect(dialog.textContent).toContain("Nothing it reads leaves this computer.");
    expect(dialog.textContent).toContain("Settings > Canopy");
    expect(dialog.textContent).not.toMatch(/servers|paid|beta|privacy/i);
    expect(within(document.body).getByRole("dialog", { name: CANOPY_TITLE })).toBeTruthy();
    // The keyboard lands on the offer's heading: Enter alone agrees to nothing.
    expect(document.activeElement?.id).toBe("canopy-pitch-title");
    // The demo's made-up agents, never the user's own runs, and nothing streamed.
    const rows = [...dialog.querySelectorAll<HTMLElement>("[data-canopy-card]")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.id.startsWith("canopy-demo-"))).toBe(true);
    expect(rows.every((row) => row.closest("[inert]") !== null)).toBe(true);
    expect(dialog.querySelector("[role=listbox]")).toBeNull();
    expect(dialog.querySelector("[data-canopy-terminal]")).toBeNull();

    await act(async () => {
      fireEvent.click(screenButton(dialog, "Turn on Canopy"));
    });
    expect(canopy.setMode).toHaveBeenCalledWith("on");
    // On: the user's own agents, in the inbox.
    expect(document.querySelector("[data-testid=canopy-dialog] [role=listbox]")).not.toBeNull();
    expect(within(document.body).getByRole("dialog", { name: CANOPY_TITLE })).toBeTruthy();
  });

  it("hides Canopy from its offer, closing it with a way back", async () => {
    const off = {
      ...canopySnapshot,
      mode: "unset" as const,
      activated: false,
    };
    const canopy = installElectron(off);
    useCanopyStore.setState({ snapshot: off, mode: "unset" });
    const notifySpy = vi.mocked(notify);
    notifySpy.mockClear();
    render(<CanopyView />);
    await frames();
    await openOffer();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    await act(async () => {
      fireEvent.click(screenButton(dialog, "Hide Canopy"));
    });
    expect(canopy.setMode).toHaveBeenCalledWith("hidden");
    expect(useCanopyStore.getState()).toMatchObject({ isOpen: false, mode: "hidden" });
    const [options] = notifySpy.mock.calls.at(-1)!;
    expect(options).toMatchObject({
      title: "Canopy hidden",
      message: "Show it again from Settings > Canopy.",
    });

    await act(async () => {
      options.action!.onClick();
    });
    // Against the revision the hide left: main changes nothing if Canopy has moved on since.
    expect(canopy.setMode).toHaveBeenLastCalledWith("unset", 5);
    expect(useCanopyStore.getState().mode).toBe("unset");
  });

  it("undoes against its own hide, never a later one it heard of since", async () => {
    const off = {
      ...canopySnapshot,
      mode: "unset" as const,
      activated: false,
    };
    const canopy = installElectron(off);
    useCanopyStore.setState({ snapshot: off, mode: "unset" });
    const notifySpy = vi.mocked(notify);
    notifySpy.mockClear();
    render(<CanopyView />);
    await frames();
    await openOffer();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    await act(async () => {
      fireEvent.click(screenButton(dialog, "Hide Canopy"));
    });
    const [options] = notifySpy.mock.calls.at(-1)!;
    // Shown and hidden again from Settings while the toast is up.
    act(() => {
      useCanopyStore
        .getState()
        .applySnapshot({ ...off, mode: "unset", modeRevision: 6, sequence: 10 });
      useCanopyStore
        .getState()
        .applySnapshot({ ...off, mode: "hidden", modeRevision: 7, sequence: 11 });
    });
    await act(async () => {
      options.action!.onClick();
    });
    // Main refuses it: revision 5 is no longer where Canopy stands.
    expect(canopy.setMode).toHaveBeenLastCalledWith("unset", 5);
  });

  it("says where to show Canopy when its Undo fails", async () => {
    const off = {
      ...canopySnapshot,
      mode: "unset" as const,
      activated: false,
    };
    const canopy = installElectron(off);
    useCanopyStore.setState({ snapshot: off, mode: "unset" });
    const notifySpy = vi.mocked(notify);
    notifySpy.mockClear();
    render(<CanopyView />);
    await frames();
    await openOffer();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    await act(async () => {
      fireEvent.click(screenButton(dialog, "Hide Canopy"));
    });
    const [options] = notifySpy.mock.calls.at(-1)!;
    canopy.setMode.mockRejectedValueOnce(new Error("rate limited"));
    await act(async () => {
      options.action!.onClick();
    });
    const [failure] = notifySpy.mock.calls.at(-1)!;
    expect(failure).toMatchObject({ type: "error", title: "Couldn't show Canopy" });
    failure.action!.onClick();
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "app.settings.openTab",
      { tab: "canopy" },
      { source: "user" }
    );
  });

  it("keeps the offer open, saying so, when hiding Canopy fails", async () => {
    const off = {
      ...canopySnapshot,
      mode: "unset" as const,
      activated: false,
    };
    const canopy = installElectron(off);
    canopy.setMode.mockRejectedValueOnce(new Error("rate limited"));
    useCanopyStore.setState({ snapshot: off, mode: "unset" });
    vi.mocked(notify).mockClear();
    render(<CanopyView />);
    await frames();
    await openOffer();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    await act(async () => {
      fireEvent.click(screenButton(dialog, "Hide Canopy"));
    });
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(dialog.textContent).toContain("Couldn't hide Canopy. Try again.");
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });

  it("shows a pressed refresh as busy until it is done", async () => {
    const canopy = installElectron();
    let done!: () => void;
    canopy.refresh.mockImplementation(() => new Promise<void>((resolve) => (done = resolve)));
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    const button = dialog.querySelector<HTMLElement>('button[aria-label="Refresh"]')!;
    expect(button.getAttribute("aria-busy")).toBeNull();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      done();
    });
    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("keeps the panel's keys behind a button rather than a standing footer", async () => {
    installElectron();
    render(<CanopyView />);
    await frames();
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    expect(document.body.textContent).not.toContain("Take the first choice");
    const button = dialog.querySelector<HTMLElement>('button[aria-label="Keyboard shortcuts"]')!;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(document.body.textContent).toContain("Take the first choice");
    // Every way the list moves, and what Cmd+W does where the keyboard is.
    expect(document.body.textContent).toContain("Move down or up");
    expect(document.body.textContent).toContain("First or last agent");
    expect(document.body.textContent).toContain("Close Canopy");
    // In the pane it trashes the agent's terminal; off the Mac only from a
    // reply, since the terminal keeps Ctrl+W for the shell.
    expect(document.body.textContent).toMatch(/in a reply: trash the agent's terminal/i);
  });

  it("steps to the next agent with ⌘↓ from inside its terminal, keeping the keyboard in the pane", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    expect(liveRun(container)).toBe("waiting");
    terminalInput(container).focus();
    fireEvent.keyDown(terminalInput(container), { key: "ArrowDown", metaKey: true });
    expect(liveRun(container)).toBe("asking");
    await frames();
    expect(document.activeElement).toBe(terminalInput(container));
    // Clamped at the top rather than wrapping.
    fireEvent.keyDown(terminalInput(container), { key: "ArrowUp", metaKey: true });
    fireEvent.keyDown(terminalInput(container), { key: "ArrowUp", metaKey: true });
    expect(liveRun(container)).toBe("waiting");
  });

  it("leaves ⌘↓ to an input method composing in the terminal", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    terminalInput(container).focus();
    fireEvent.keyDown(terminalInput(container), {
      key: "ArrowDown",
      metaKey: true,
      isComposing: true,
    });
    expect(liveRun(container)).toBe("waiting");
  });

  it("steps between agents with Alt+↑/↓ off the Mac, and leaves Ctrl+↑/↓ to the terminal", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "ArrowDown", ctrlKey: true });
    expect(liveRun(container)).toBe("waiting");
    fireEvent.keyDown(first!, { key: "ArrowDown", altKey: true });
    expect(liveRun(container)).toBe("asking");
    expect(document.activeElement).toBe(second);
  });

  it("closes when its project's view goes into the background", async () => {
    installElectron();
    render(<CanopyView />);
    await frames();
    act(() => {
      for (const listener of lifecycle) listener("cached");
    });
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("closes at once when it mounts in a view already in the background, looking at nothing", async () => {
    const canopy = installElectron({ ...canopySnapshot, cards: [stuckCard("working")] });
    useCanopyStore.setState({ snapshot: { ...canopySnapshot, cards: [stuckCard("working")] } });
    viewCached.current = true;
    try {
      render(<CanopyView />);
      await frames();
      expect(useCanopyStore.getState().isOpen).toBe(false);
      expect(canopy.markSeen).not.toHaveBeenCalledWith("working", true, "panel");
      expect(canopy.setRead).not.toHaveBeenCalled();
    } finally {
      viewCached.current = false;
    }
  });

  it("archives a row from its hover button without moving the user off the row they are on", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, , third] = cards(container);
    act(() => third!.focus());
    await act(async () => {
      fireEvent.click(first!.querySelector<HTMLElement>("[data-canopy-row-archive]")!);
    });
    expect(canopy.archive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
    expect(document.activeElement).toBe(third);
  });

  it("lets an answer that lands after the panel closed move nothing in the panel opened since", async () => {
    const canopy = installElectron({
      ...canopySnapshot,
      cards: [
        {
          ...stuckCard("waiting"),
          category: "approval",
          wordsCategory: "approval",
          question: "Do you want to proceed?",
          options: ["Yes", "No"],
          risk: "none",
        },
      ],
    });
    useCanopyStore.setState({
      snapshot: {
        ...canopySnapshot,
        cards: [
          {
            ...stuckCard("waiting"),
            category: "approval",
            wordsCategory: "approval",
            question: "Do you want to proceed?",
            options: ["Yes", "No"],
            risk: "none",
          },
        ],
      },
    });
    let settle!: () => void;
    const answer = vi.fn(
      (_runId: string, _target: { spawnedAt: number }, _label: string) =>
        new Promise<void>((resolve) => (settle = resolve))
    );
    Object.assign(canopy, { answer });
    const before = render(<CanopyView />);
    await frames();
    const row = cards(before.container).find((card) => card.id.includes("waiting"))!;
    act(() => row.focus());
    await act(async () => {
      fireEvent.keyDown(row, { key: "1" });
    });
    expect(answer).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 }, "Yes");
    before.unmount();

    const after = render(<CanopyView />);
    await frames();
    const chosen = cards(after.container).find((card) => card.id.includes("working"))!;
    act(() => chosen.focus());
    await act(async () => settle());
    expect(document.activeElement).toBe(chosen);
  });

  describe("after a reply or an answer", () => {
    const approvalCard = (runId: string): CanopyCard => ({
      ...stuckCard(runId),
      category: "approval",
      wordsCategory: "approval",
      question: "Do you want to proceed?",
      options: ["Yes", "No"],
      risk: "none",
    });

    beforeEach(() => {
      pane.stream = null;
      pane.reply = null;
      pane.editable = true;
      useFleetSnapshotStore.setState({
        snapshot: {
          runs: [
            run("waiting", {
              agentState: "waiting",
              waitingReason: "approval",
              since: NOW - 60_000,
              title: "Approve the migration",
            }),
            run("asking", {
              agentState: "waiting",
              waitingReason: "question",
              since: NOW - 40_000,
              title: "Pick a port",
            }),
            run("working", { agentState: "working", since: NOW - 30_000, title: "Tidy the store" }),
          ],
          changedAt: NOW,
          degraded: false,
          lastSuccessfulAt: NOW,
        },
      });
    });

    /** The first row chosen, its terminal's stream open and its reply loaded. */
    async function replyingTo(snapshot: CanopySnapshot = canopySnapshot) {
      const canopy = installElectron(snapshot);
      useCanopyStore.setState({ snapshot });
      const terminalSubmit = vi.fn(async (..._args: unknown[]) => {});
      const terminalSendKey = vi.fn(async (..._args: unknown[]) => {});
      Object.assign(canopy, { terminalSubmit, terminalSendKey });
      const view = render(<CanopyView />);
      await frames();
      const first = cards(view.container)[0]!;
      act(() => first.focus());
      await act(async () => pane.stream!({ watchId: 7, ended: false, secretPrompt: false }));
      await vi.waitFor(() => expect(pane.reply).not.toBeNull());
      const moveOnLine = () =>
        document.querySelector<HTMLElement>("[data-canopy-move-on]")?.textContent ?? null;
      const replyEditor = () => document.querySelector<HTMLElement>("[data-reply-editor]")!;
      return { ...view, canopy, first, terminalSubmit, moveOnLine, replyEditor };
    }

    afterEach(() => {
      pane.editable = false;
    });

    it("stays on the agent a reply was sent to, the keyboard in its reply", async () => {
      const { container, terminalSubmit, replyEditor } = await replyingTo();
      expect(liveRun(container)).toBe("waiting");
      const editor = replyEditor();
      act(() => editor.focus());

      await act(async () => {
        await pane.reply!.submitText("Yes, go ahead", []);
      });
      await frames();

      expect(terminalSubmit).toHaveBeenCalledWith(7, "Yes, go ahead", undefined);
      expect(liveRun(container)).toBe("waiting");
      expect(selectedRun(container)).toBe("waiting");
      expect(document.activeElement).toBe(editor);
    });

    it("moves on with ⌘↩ to the agent the reply names, into its reply, and names none past the last", async () => {
      const { container, moveOnLine, replyEditor } = await replyingTo();
      expect(moveOnLine()).toContain("Send and go to");
      expect(moveOnLine()).toContain("Pick a port");
      act(() => replyEditor().focus());

      const route = pane.reply!.modEnterSend!();
      await act(async () => {
        await route.submitText("Yes, go ahead", []);
      });
      await frames();

      expect(liveRun(container)).toBe("asking");
      expect(selectedRun(container)).toBe("asking");
      expect(document.activeElement?.hasAttribute("data-reply-editor")).toBe(true);
      expect(document.activeElement?.closest("[data-canopy-detail]")?.id).toBe(
        "canopy-detail-asking"
      );
      // Nothing below needs the user: ⌘↩ from here would send and stay.
      expect(moveOnLine()).toBe("");
    });

    it("stays when the agent ⌘↩ named was parked before the send landed", async () => {
      const { container } = await replyingTo();
      const route = pane.reply!.modEnterSend!();
      act(() => {
        const snapshot = useFleetSnapshotStore.getState().snapshot!;
        useFleetSnapshotStore.setState({
          snapshot: {
            ...snapshot,
            runs: snapshot.runs.map((r) =>
              r.runId === "asking" ? { ...r, park: { parkedAt: NOW } } : r
            ),
          },
        });
      });

      await act(async () => {
        await route.submitText("Yes, go ahead", []);
      });

      expect(liveRun(container)).toBe("waiting");
    });

    it("stays on the agent a choice answered, the keyboard on its row as the choice goes", async () => {
      const snapshot = { ...canopySnapshot, cards: [approvalCard("waiting")] };
      const { container, canopy } = await replyingTo(snapshot);
      const answer = vi.fn(
        async (_runId: string, _target: { spawnedAt: number }, _label: string) => {}
      );
      Object.assign(canopy, { answer });
      const yes = [...document.querySelectorAll<HTMLElement>("[data-canopy-choices] button")].find(
        (button) => button.textContent?.includes("Yes")
      )!;
      act(() => yes.focus());

      await act(async () => {
        fireEvent.click(yes);
      });

      expect(answer).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 }, "Yes");
      expect(liveRun(container)).toBe("waiting");
      expect(document.activeElement?.id).toBe("canopy-card-waiting");
    });

    it("leaves the keyboard on Reply when the user went there while the answer was on its way", async () => {
      const snapshot = { ...canopySnapshot, cards: [approvalCard("waiting")] };
      const { canopy } = await replyingTo(snapshot);
      let settle!: () => void;
      const answer = vi.fn(
        (_runId: string, _target: { spawnedAt: number }, _label: string) =>
          new Promise<void>((resolve) => (settle = resolve))
      );
      Object.assign(canopy, { answer });
      const choices = [...document.querySelectorAll<HTMLElement>("[data-canopy-choices] button")];
      const yes = choices.find((button) => button.textContent?.includes("Yes"))!;
      const reply = choices.find((button) => button.textContent?.includes("Reply"))!;
      act(() => yes.focus());
      await act(async () => {
        fireEvent.click(yes);
      });
      act(() => reply.focus());

      await act(async () => settle());

      expect(answer).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(reply);
    });
  });

  it("archives the selected run with E and moves the cursor on to the next", async () => {
    const canopy = installElectron();
    vi.mocked(notify).mockClear();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    await act(async () => {
      fireEvent.keyDown(first!, { key: "e" });
    });
    expect(canopy.archive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
    expect(document.activeElement).toBe(second);
    // The user archived it and watched it go: no toast. Z takes it back.
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
    fireEvent.keyDown(second!, { key: "z" });
    expect(canopy.unarchive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("names an archive in an Undo line that takes it back, then goes away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const canopy = installElectron();
      vi.mocked(notify).mockClear();
      const { container } = render(<CanopyView />);
      await frames();
      await act(async () => {
        fireEvent.keyDown(cards(container)[0]!, { key: "e" });
      });
      const line = () => container.ownerDocument.querySelector("[data-canopy-undo-line]");
      expect(line()?.textContent).toContain("Archived '");
      expect(vi.mocked(notify)).not.toHaveBeenCalled();
      const undo = [...line()!.querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
      await act(async () => {
        fireEvent.click(undo);
      });
      expect(canopy.unarchive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
      expect(line()).toBeNull();
      // Z after the button finds it done.
      fireEvent.keyDown(cards(container)[0]!, { key: "z" });
      expect(canopy.unarchive).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the Undo line after ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      installElectron();
      const { container } = render(<CanopyView />);
      await frames();
      await act(async () => {
        fireEvent.keyDown(cards(container)[0]!, { key: "e" });
      });
      expect(container.ownerDocument.querySelector("[data-canopy-undo-line]")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(10_001);
      });
      expect(container.ownerDocument.querySelector("[data-canopy-undo-line]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renames the selected run from F2 on its row, in its title bar", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "F2" });
    await frames();
    const field = document.querySelector<HTMLInputElement>(
      "[data-canopy-detail] [data-canopy-rename] input"
    )!;
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "auth fix" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(canopy.rename).toHaveBeenCalledWith(
      "waiting",
      { spawnedAt: NOW - 3_600_000 },
      "auth fix"
    );
    expect(useCanopyStore.getState().isOpen).toBe(true);
  });

  it("leaves a rename with Escape, and the panel stays open", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "F2" });
    await frames();
    const field = document.querySelector<HTMLInputElement>(
      "[data-canopy-detail] [data-canopy-rename] input"
    )!;
    fireEvent.change(field, { target: { value: "never mind" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await frames();
    expect(document.querySelector("[data-canopy-rename]")).toBeNull();
    expect(canopy.rename).not.toHaveBeenCalled();
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(document.activeElement?.getAttribute("aria-keyshortcuts")).toBe("F2");
  });

  it("takes an archive back with Z pressed before main has answered it", async () => {
    const canopy = installElectron();
    let land: (mark: unknown) => void = () => {};
    canopy.archive.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "e" });
    fireEvent.keyDown(second!, { key: "z" });
    expect(canopy.unarchive).not.toHaveBeenCalled();
    await act(async () => {
      land({
        runId: "waiting",
        spawnedAt: NOW - 3_600_000,
        turn: 1,
        readTurn: 1,
        markedUnreadAt: null,
        version: 2,
      });
    });
    expect(canopy.unarchive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("undoes the newest action pressed, whichever main answers last", async () => {
    const canopy = installElectron();
    let land: (mark: unknown) => void = () => {};
    canopy.archive.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "e" });
    // U on the next run, answered before the archive is.
    await act(async () => {
      fireEvent.keyDown(second!, { key: "u" });
    });
    await act(async () => {
      land({
        runId: "waiting",
        spawnedAt: NOW - 3_600_000,
        turn: 1,
        readTurn: 1,
        markedUnreadAt: null,
        version: 2,
      });
    });
    // Holding Z undoes once; the repeat takes nothing more.
    fireEvent.keyDown(second!, { key: "z" });
    fireEvent.keyDown(second!, { key: "z", repeat: true });
    expect(canopy.restoreReads).toHaveBeenCalledTimes(1);
    expect(canopy.unarchive).not.toHaveBeenCalled();
  });

  it("takes back archiving the last run with Z, though the list is empty", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [run("done", { agentState: "completed", since: NOW - 60_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    await act(async () => {
      fireEvent.keyDown(cards(container)[0]!, { key: "e" });
    });
    act(() => {
      useCanopyStore.getState().applySnapshot({
        ...canopySnapshot,
        sequence: 50,
        dispositions: [{ runId: "done", spawnedAt: NOW - 3_600_000, kind: "archived", at: NOW }],
      });
    });
    await frames();
    // Focus went to Refresh in the header, outside the list.
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    const refresh = dialog.querySelector<HTMLElement>('button[aria-label="Refresh"]')!;
    refresh.focus();
    fireEvent.keyDown(refresh, { key: "z" });
    expect(canopy.unarchive).toHaveBeenCalledWith("done", { spawnedAt: NOW - 3_600_000 });
  });

  it("shows only this project's agents when asked, and tells main to read only those", async () => {
    const canopy = installElectron();
    (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__ = {
      id: "p1",
    };
    const fleet = useFleetSnapshotStore.getState().snapshot!;
    useFleetSnapshotStore.setState({
      snapshot: {
        ...fleet,
        runs: [
          ...fleet.runs,
          run("elsewhere", { workspaceId: "p2", agentState: "waiting", since: NOW - 10_000 }),
        ],
      },
    });
    const { container, getByRole } = render(<CanopyView />);
    await frames();
    expect(cards(container).some((card) => card.id.endsWith("elsewhere"))).toBe(true);
    fireEvent.click(getByRole("radio", { name: "This project" }));
    expect(cards(container).some((card) => card.id.endsWith("elsewhere"))).toBe(false);
    expect(canopy.setScope).toHaveBeenLastCalledWith("p1");
    act(() => useCanopyStore.getState().setScope("all"));
  });

  it("lands in the search with the most urgent card selected, the arrows moving it", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    const input = searchInput();
    expect(document.activeElement).toBe(input);
    expect(first!.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(first!.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(input);
    expect(second!.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(second!.id);
    expect(liveRun(container)).toBe(second!.getAttribute("id")!.replace(/^canopy-card-/, ""));
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(first!.getAttribute("aria-selected")).toBe("true");

    // Tab takes the keyboard down to the selected row, where the arrows move it.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    // Up off the top of the list is back in the search.
    fireEvent.keyDown(first!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
  });

  it("names the project on every row, though every run is in the same one", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const rows = cards(container);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const meta = row.querySelector("[data-canopy-where]");
      expect(meta?.textContent).toContain("🌳");
      expect(meta?.textContent).toContain("app");
    }
  });

  it("says above the pane which project and branch the selected agent is in", async () => {
    const canopy = installElectron();
    render(<CanopyView />);
    await frames();
    await act(async () => {});
    const place = document.querySelector<HTMLElement>("[data-canopy-place]");
    expect(place?.textContent).toContain("🌳");
    expect(place?.textContent).toContain("app");
    expect(place?.textContent).toContain("feature/waiting");
    expect(canopy.runBranch).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("keeps one place bar as the cursor moves, naming the run it lands on", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    fireEvent.keyDown(second!, { key: "ArrowDown" });
    await act(async () => {});
    const bars = document.querySelectorAll<HTMLElement>("[data-canopy-place]");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.textContent).toContain("feature/working");
    const pane = document.querySelector<HTMLElement>("[data-canopy-detail]");
    expect(pane?.getAttribute("aria-describedby")).toBe(bars[0]!.id);
  });

  it("still names the folder when the branch can't be read", async () => {
    installElectron(canopySnapshot, async () => {
      throw new Error("Too many requests");
    });
    render(<CanopyView />);
    await frames();
    await act(async () => {});
    const place = document.querySelector<HTMLElement>("[data-canopy-place]");
    expect(place?.textContent).toContain("app");
    expect(place?.textContent).toContain("repo");
    expect(place?.textContent).toContain("in folder");
  });

  it("names the worktree instead when the folder has no branch to say", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [
          run("detached", {
            cwd: "/worktrees/login-fix",
            spawnedAt: NOW - 1_234,
            agentState: "waiting",
            waitingReason: "approval",
            since: NOW - 60_000,
          }),
        ],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    installElectron(canopySnapshot, async () => null);
    render(<CanopyView />);
    await frames();
    await act(async () => {});
    const place = document.querySelector<HTMLElement>("[data-canopy-place]");
    expect(place?.textContent).toContain("app");
    expect(place?.textContent).toContain("login-fix");
    expect(place?.textContent).not.toContain("on branch");
  });

  it("tells main the panel is open, and closed again on unmount", async () => {
    const canopy = installElectron();
    const { unmount } = render(<CanopyView />);
    expect(canopy.setActive).toHaveBeenCalledWith(true);
    unmount();
    expect(canopy.setActive).toHaveBeenLastCalledWith(false);
  });

  it("goes to a terminal in this project before closing, and stays open if that fails", async () => {
    installElectron();
    (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__ = {
      id: "p1",
    };
    dispatchMock.mockResolvedValueOnce({ ok: false });
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "Enter" });
    expect(dispatchMock).toHaveBeenCalledWith(
      "pilot.openRun",
      { runId: "waiting", workspaceId: "p1" },
      { source: "user" }
    );
    await act(async () => {});
    expect(useCanopyStore.getState().isOpen).toBe(true);
    delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
  });

  describe("reopening after Go to terminal", () => {
    beforeEach(() => {
      (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__ = {
        id: "p1",
      };
    });
    afterEach(() => {
      delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
      vi.useRealTimers();
    });

    async function goToTerminalFrom(container: HTMLElement, runId: string) {
      const card = cards(container).find((c) => c.id === `canopy-card-${runId}`)!;
      act(() => card.focus());
      fireEvent.keyDown(card, { key: "Enter" });
      await act(async () => {});
      expect(useCanopyStore.getState().isOpen).toBe(false);
    }

    it("lands on the run it was left on, keeping the search, with the keyboard in the search", async () => {
      installElectron();
      const { container } = render(<CanopyView />);
      await frames();
      await goToTerminalFrom(container, "asking");
      expect(useCanopyStore.getState().resume?.runId).toBe("asking");

      act(() => useCanopyStore.getState().open());
      await frames();
      expect(selectedRun(container)).toBe("asking");
      expect(document.activeElement).toBe(searchInput());
      expect(useCanopyStore.getState().resume).toBeNull();
    });

    it("keeps the search it was left with, and gives a gone run's place to its neighbour", async () => {
      installElectron();
      const { container } = render(<CanopyView />);
      await frames();
      fireEvent.change(searchInput(), { target: { value: "a" } });
      await frames();
      const listed = cards(container).map((c) => c.id.replace(/^canopy-card-/, ""));
      expect(listed.length).toBeGreaterThan(1);
      await goToTerminalFrom(container, listed[1]!);

      // The run it was left on has since gone.
      const { resume } = useCanopyStore.getState();
      useCanopyStore.setState({
        resume: { ...resume!, runId: "gone", order: ["gone", ...listed] },
      });
      act(() => useCanopyStore.getState().open());
      await frames();
      expect(searchInput().value).toBe("a");
      expect(selectedRun(container)).toBe(listed[0]);
    });

    it("opens as it does today after a plain close, or after thirty minutes", async () => {
      installElectron();
      const { container } = render(<CanopyView />);
      await frames();
      fireEvent.keyDown(cards(container)[1]!, { key: "ArrowDown" });
      act(() => useCanopyStore.getState().close());
      act(() => useCanopyStore.getState().open());
      await frames();
      expect(selectedRun(container)).toBe(cards(container)[0]!.id.replace(/^canopy-card-/, ""));

      await goToTerminalFrom(container, "asking");
      const { resume } = useCanopyStore.getState();
      useCanopyStore.setState({ resume: { ...resume!, at: Date.now() - 31 * 60 * 1000 } });
      act(() => useCanopyStore.getState().open());
      await frames();
      expect(selectedRun(container)).toBe(cards(container)[0]!.id.replace(/^canopy-card-/, ""));
      expect(useCanopyStore.getState().resume).toBeNull();
    });
  });

  describe("opening on the agent focused in the main view", () => {
    function focusInMainView(id: string | null, panel: Record<string, unknown> = {}) {
      usePanelStore.setState({
        panelsById: (id === null
          ? {}
          : {
              [id]: { id, kind: "terminal", location: "grid", detectedAgentId: "claude", ...panel },
            }) as never,
        focusedId: id,
      });
    }

    afterEach(() => {
      usePanelStore.setState({ panelsById: {} as never, focusedId: null });
    });

    it("selects the focused agent's row, brings it into view and shows its terminal, moving nothing", async () => {
      installElectron();
      const { container } = render(<CanopyView />);
      await frames();
      const order = cards(container).map((card) => card.id);
      expect(order.at(-1)).toBe("canopy-card-working");
      act(() => useCanopyStore.getState().close());
      focusInMainView("working");
      const scrolled = vi.mocked(Element.prototype.scrollIntoView);
      scrolled.mockClear();

      act(() => useCanopyStore.getState().open());
      await frames();
      expect(selectedRun(container)).toBe("working");
      expect(liveRun(container)).toBe("working");
      expect(document.activeElement).toBe(searchInput());
      expect(scrolled.mock.contexts).toContain(document.getElementById("canopy-card-working"));
      expect(cards(container).map((card) => card.id)).toEqual(order);
    });

    it("lands on it on the panel's first opening too, keeping the agent focused as it opened", async () => {
      installElectron();
      const fleet = useFleetSnapshotStore.getState().snapshot!;
      useFleetSnapshotStore.setState({ snapshot: { ...fleet, runs: [] } });
      useCanopyStore.setState({ isOpen: false });
      focusInMainView("asking");
      act(() => useCanopyStore.getState().toggle());
      const first = render(<CanopyView />);
      await frames();
      // Focus moves on in the main view before the runs arrive: the landing
      // keeps the agent the panel opened on.
      focusInMainView("working");
      act(() => useFleetSnapshotStore.setState({ snapshot: fleet }));
      await frames();
      expect(selectedRun(first.container)).toBe("asking");
      expect(liveRun(first.container)).toBe("asking");
      first.unmount();

      // The next opening reads it afresh.
      act(() => useCanopyStore.getState().close());
      act(() => useCanopyStore.getState().toggle());
      const next = render(<CanopyView />);
      await frames();
      expect(selectedRun(next.container)).toBe("working");
    });

    it("lands on it in Archived only while Archived is open, never opening the fold", async () => {
      const archived: CanopySnapshot = {
        ...canopySnapshot,
        dispositions: [{ runId: "working", spawnedAt: NOW - 3_600_000, kind: "archived", at: NOW }],
      };
      installElectron(archived);
      useCanopyStore.setState({ snapshot: archived, isOpen: false, archivedExpanded: false });
      focusInMainView("working");
      try {
        act(() => useCanopyStore.getState().open());
        const shut = render(<CanopyView />);
        await frames();
        expect(useCanopyStore.getState().archivedExpanded).toBe(false);
        expect(document.getElementById("canopy-card-working")).toBeNull();
        expect(selectedRun(shut.container)).toBe("waiting");
        shut.unmount();

        act(() => useCanopyStore.getState().close());
        useCanopyStore.setState({ archivedExpanded: true });
        act(() => useCanopyStore.getState().open());
        const scrolled = vi.mocked(Element.prototype.scrollIntoView);
        scrolled.mockClear();
        const open = render(<CanopyView />);
        await frames();
        expect(selectedRun(open.container)).toBe("working");
        expect(liveRun(open.container)).toBe("working");
        expect(scrolled.mock.contexts).toContain(document.getElementById("canopy-card-working"));
      } finally {
        useCanopyStore.setState({ archivedExpanded: false });
      }
    });

    it("opens as before on a pane that isn't an agent, or an agent Canopy doesn't list", async () => {
      installElectron();
      const { container } = render(<CanopyView />);
      await frames();
      const reopen = async () => {
        act(() => useCanopyStore.getState().close());
        act(() => useCanopyStore.getState().open());
        await frames();
        return selectedRun(container);
      };
      focusInMainView("working", { detectedAgentId: undefined });
      expect(await reopen()).toBe("waiting");
      focusInMainView("working", { kind: "browser" });
      expect(await reopen()).toBe("waiting");
      focusInMainView("elsewhere");
      expect(await reopen()).toBe("waiting");
      focusInMainView(null);
      expect(await reopen()).toBe("waiting");
    });

    it("leaves the filters as they are when they hide it", async () => {
      installElectron({
        ...canopySnapshot,
        reads: [unreadMark("waiting", 2), unreadMark("asking", 1)],
      });
      useCanopyStore.setState({ unreadOnly: true });
      const { container } = render(<CanopyView />);
      await frames();
      act(() => useCanopyStore.getState().close());
      focusInMainView("working");
      act(() => useCanopyStore.getState().open());
      await frames();
      expect(useCanopyStore.getState().unreadOnly).toBe(true);
      expect(cards(container).some((card) => card.id === "canopy-card-working")).toBe(false);
      expect(selectedRun(container)).toBe("waiting");
    });

    describe("after Go to terminal", () => {
      beforeEach(() => {
        (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__ = {
          id: "p1",
        };
        useFleetSnapshotStore.setState({
          snapshot: {
            ...useFleetSnapshotStore.getState().snapshot!,
            runs: [
              run("waiting", {
                agentState: "waiting",
                waitingReason: "approval",
                since: NOW - 60_000,
                title: "Port the auth flow",
              }),
              run("asking", {
                agentState: "waiting",
                waitingReason: "question",
                since: NOW - 40_000,
                title: "Port the billing page",
              }),
              run("working", { agentState: "working", since: NOW - 30_000, title: "Tidy docs" }),
            ],
          },
        });
      });
      afterEach(() => {
        delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
      });

      /** Leaves the panel through Go to terminal on "asking", under the search given. */
      async function leaveOnAsking(container: HTMLElement, query: string) {
        if (query !== "") {
          fireEvent.change(searchInput(), { target: { value: query } });
          await frames();
        }
        const card = cards(container).find((c) => c.id === "canopy-card-asking")!;
        act(() => card.focus());
        fireEvent.keyDown(card, { key: "Enter" });
        await act(async () => {});
        expect(useCanopyStore.getState().resume).toMatchObject({ runId: "asking", query });
      }

      it("wins over the run it left the panel on", async () => {
        installElectron();
        const { container } = render(<CanopyView />);
        await frames();
        await leaveOnAsking(container, "");
        focusInMainView("working");

        act(() => useCanopyStore.getState().open());
        await frames();
        expect(selectedRun(container)).toBe("working");
        expect(liveRun(container)).toBe("working");
      });

      it("wins under the search it put back, and gives way when that search hides it", async () => {
        installElectron();
        const { container } = render(<CanopyView />);
        await frames();
        await leaveOnAsking(container, "port");
        const resume = useCanopyStore.getState().resume!;
        focusInMainView("waiting");

        act(() => useCanopyStore.getState().open());
        await frames();
        expect(searchInput().value).toBe("port");
        expect(selectedRun(container)).toBe("waiting");

        act(() => useCanopyStore.getState().close());
        act(() => useCanopyStore.setState({ resume: { ...resume, at: Date.now() } }));
        focusInMainView("working");
        act(() => useCanopyStore.getState().open());
        await frames();
        expect(searchInput().value).toBe("port");
        expect(cards(container).some((card) => card.id === "canopy-card-working")).toBe(false);
        expect(selectedRun(container)).toBe("asking");
      });
    });
  });

  it("looks at a run the arrow keys move onto, leaving the reading to the look", async () => {
    const canopy = installElectron({
      ...canopySnapshot,
      reads: [unreadMark("waiting", 2), unreadMark("asking", 1)],
    });
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    canopy.markSeen.mockClear();
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    expect(liveRun(container)).toBe("asking");
    // A look begins there; arrowing past reads nothing by itself, unlike a click.
    expect(canopy.markSeen).toHaveBeenCalledWith("asking", true, "panel");
    expect(canopy.setRead).not.toHaveBeenCalled();
  });

  it("opens a run's terminal on a click, not a hover, and reads it through the turn it showed", async () => {
    const canopy = installElectron({
      ...canopySnapshot,
      reads: [unreadMark("waiting", 2), unreadMark("asking", 1)],
    });
    const { container } = render(<CanopyView />);
    await frames();
    const [first, second] = cards(container);
    expect(liveRun(container)).toBe("waiting");
    // Landing on the first run when the panel opens reads nothing by itself.
    expect(first!.getAttribute("data-unread")).toBe("true");
    expect(canopy.setRead).not.toHaveBeenCalled();

    fireEvent.pointerMove(second!);
    expect(liveRun(container)).toBe("waiting");

    fireEvent.click(first!);
    expect(canopy.setRead).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 }, true, 2);
    fireEvent.click(second!);
    expect(liveRun(container)).toBe("asking");
  });

  it("marks the selected run read or unread with U, and takes it back with Z", async () => {
    const canopy = installElectron({ ...canopySnapshot, reads: [unreadMark("waiting", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    const [first] = cards(container);
    fireEvent.keyDown(first!, { key: "u" });
    expect(canopy.setRead).toHaveBeenLastCalledWith(
      "waiting",
      { spawnedAt: NOW - 3_600_000 },
      true,
      1
    );
    // The undo is offered once main has answered with what the change left.
    await act(async () => {});
    fireEvent.keyDown(first!, { key: "z" });
    expect(canopy.restoreReads).toHaveBeenCalledWith([
      { mark: unreadMark("waiting", 1), expectVersion: 2 },
    ]);
    // One deep: a second Z has nothing left to undo.
    fireEvent.keyDown(first!, { key: "z" });
    expect(canopy.restoreReads).toHaveBeenCalledTimes(1);
  });

  it("marks every unread run listed read with ⌥U, by the key's place rather than its character", async () => {
    const canopy = installElectron({
      ...canopySnapshot,
      reads: [unreadMark("waiting", 2), unreadMark("asking", 1)],
    });
    const { container } = render(<CanopyView />);
    await frames();
    // On a Mac ⌥U is the umlaut dead key: the event carries no "u".
    fireEvent.keyDown(cards(container)[0]!, { key: "Dead", code: "KeyU", altKey: true });
    expect(canopy.markAllRead).toHaveBeenCalledWith([
      { runId: "waiting", spawnedAt: NOW - 3_600_000, turn: 2 },
      { runId: "asking", spawnedAt: NOW - 3_600_000, turn: 1 },
    ]);
  });

  it("filters to the unread, keeping a row read since until the filter is turned off", async () => {
    installElectron({ ...canopySnapshot, reads: [unreadMark("asking", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    const ids = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(ids()).toEqual(["waiting", "asking", "working"]);
    fireEvent.click(screenButton(container.ownerDocument.body, "Unread1"));
    expect(ids()).toEqual(["asking"]);
    // Read while listed: it stays, rather than vanishing under the user.
    act(() =>
      useCanopyStore.setState({
        snapshot: { ...canopySnapshot, reads: [{ ...unreadMark("asking", 1), readTurn: 1 }] },
      })
    );
    expect(ids()).toEqual(["asking"]);
    fireEvent.click(screenButton(container.ownerDocument.body, "Unread"));
    expect(ids()).toEqual(["waiting", "asking", "working"]);
  });

  it("says first what needs you, then what is unread", async () => {
    installElectron({ ...canopySnapshot, reads: [unreadMark("working", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    expect(container.ownerDocument.body.textContent).toContain("2 agents need you · 1 unread");
  });

  it("offers each row's actions on a right-click, with their keys", async () => {
    const canopy = installElectron({ ...canopySnapshot, reads: [unreadMark("waiting", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[0]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    expect(items.map((item) => item.firstChild?.textContent)).toEqual([
      "Go to terminal",
      "Reply",
      "Mark as read",
      "Read again",
      "Archive",
      "Rename…",
      "Park…",
      "Snooze…",
      "Trash terminal…",
    ]);
    expect(
      items
        .find((item) => item.textContent?.startsWith("Archive"))
        ?.getAttribute("aria-keyshortcuts")
    ).toBe("E");
    fireEvent.click(items.find((item) => item.textContent?.startsWith("Archive"))!);
    expect(canopy.archive).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("snoozes a run from the row's menu and wakes one that is snoozed", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[1]!, { clientX: 5, clientY: 5 });
    const trigger = (await within(document.body).findAllByRole("menuitem", { hidden: true })).find(
      (item) => item.textContent?.startsWith("Snooze")
    )!;
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const fifteen = await within(document.body).findByRole("menuitem", {
      name: "15 minutes",
      hidden: true,
    });
    fireEvent.click(fifteen);
    expect(fleetApi.snoozeRun).toHaveBeenCalledWith(
      cards(container)[1]!.id.replace(/^canopy-card-/, ""),
      "15m"
    );
    expect(fleetApi.parkRun).not.toHaveBeenCalled();
  });

  it("offers Unpark only for a parked run, and lifts the park", async () => {
    installElectron();
    const fleet = useFleetSnapshotStore.getState().snapshot!;
    const target = fleet.runs[0]!.runId;
    useFleetSnapshotStore.setState({
      snapshot: {
        ...fleet,
        runs: fleet.runs.map((r) =>
          r.runId === target ? { ...r, park: { parkedAt: NOW - 1000 } as typeof r.park } : r
        ),
      },
    });
    const { container } = render(<CanopyView />);
    await frames();
    const parkedCard = cards(container).find((card) => card.id.endsWith(target))!;
    fireEvent.contextMenu(parkedCard, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    fireEvent.click(items.find((item) => item.textContent === "Unpark")!);
    expect(fleetApi.unparkRun).toHaveBeenCalledWith(target);
  });

  it("shows neither the offer nor the inbox until main says whether Canopy is on", async () => {
    useCanopyStore.setState({ snapshot: null });
    const canopy = installElectron();
    // Main hasn't answered yet.
    canopy.setActive.mockReturnValue(new Promise(() => {}));
    render(<CanopyView />);
    const dialog = document.querySelector<HTMLElement>("[data-testid=canopy-dialog]")!;
    expect(dialog.textContent).not.toContain("Turn on Canopy");
    expect(dialog.querySelector("[role=listbox]")).toBeNull();
    expect(dialog.querySelector("[aria-busy=true]")).not.toBeNull();
    expect(within(document.body).getByRole("dialog", { name: CANOPY_TITLE })).toBeTruthy();
    // The keyboard waits inside the dialog, not on whatever opened it.
    await frames();
    expect(document.activeElement).toBe(dialog.querySelector("[aria-busy=true]"));
  });

  it("hands the keyboard straight from the loading panel to the inbox replacing it", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    try {
      useCanopyStore.setState({ snapshot: null });
      const canopy = installElectron();
      let answer: (snapshot: CanopySnapshot) => void = () => {};
      canopy.setActive.mockReturnValue(
        new Promise<CanopySnapshot>((resolve) => {
          answer = resolve;
        })
      );
      render(<CanopyView />);
      await frames();
      // Main answers: the inbox replaces the loading panel.
      await act(async () => {
        answer(canopySnapshot);
      });
      // Never back on the opener in between, where keys reach the grid.
      expect(document.activeElement).not.toBe(opener);
      expect(document.activeElement?.closest("[data-testid=canopy-dialog]")).not.toBeNull();
    } finally {
      opener.remove();
    }
  });

  it("hands the keyboard to the offer when reading is turned off while the inbox is open", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    try {
      installElectron();
      render(<CanopyView />);
      await frames();
      expect(document.activeElement?.closest("[data-testid=canopy-dialog]")).not.toBeNull();
      // Turned off from another view: the offer replaces the inbox.
      await act(async () => {
        useCanopyStore
          .getState()
          .applySnapshot({ ...canopySnapshot, mode: "unset", activated: false });
      });
      expect(document.activeElement).not.toBe(opener);
      expect(document.activeElement?.closest("[data-testid=canopy-dialog]")).not.toBeNull();
    } finally {
      opener.remove();
    }
  });

  it("reads a row's screen again from its menu, for a reading that looks wrong", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[0]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    await act(async () => {
      fireEvent.click(items.find((item) => item.textContent === "Read again")!);
    });
    expect(canopy.reread).toHaveBeenCalledWith("waiting", { spawnedAt: NOW - 3_600_000 });
  });

  it("offers every project when this one has no agents, and says when status is unavailable", async () => {
    useCanopyStore.setState({ scope: "project" });
    window.__DAINTREE_INITIAL_PROJECT__ = {
      id: "elsewhere",
    } as typeof window.__DAINTREE_INITIAL_PROJECT__;
    try {
      installElectron();
      const view = render(<CanopyView />);
      await frames();
      expect(document.body.textContent).toContain("No agents in this project");
      fireEvent.click(screenButton(document.body, "Show all projects"));
      expect(useCanopyStore.getState().scope).toBe("all");
      view.unmount();

      // Daintree can't see its agents: no claim that there are none.
      useCanopyStore.setState({ isOpen: true, scope: "project" });
      useFleetSnapshotStore.setState({
        snapshot: {
          ...useFleetSnapshotStore.getState().snapshot!,
          runs: [],
          degraded: true,
          lastSuccessfulAt: NOW - 120_000,
        },
      });
      render(<CanopyView />);
      await frames();
      expect(document.body.textContent).toContain("Agent status is unavailable");
      expect(document.body.textContent).toContain("Can't tell who needs you right now");
      expect(document.body.textContent).not.toContain("No agents");
    } finally {
      delete window.__DAINTREE_INITIAL_PROJECT__;
    }
  });

  it("starts a rename in the pane from the row's menu", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[1]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    const rename = items.find((item) => item.textContent?.startsWith("Rename"))!;
    expect(rename.getAttribute("aria-keyshortcuts")).toBe("F2");
    fireEvent.click(rename);
    await frames();
    // The run it was asked for is the one open, its name ready to type over —
    // once the menu has finished handing focus about.
    await vi.waitFor(() =>
      expect(document.activeElement?.closest("[data-canopy-rename]")).not.toBeNull()
    );
    expect(document.activeElement?.closest("[data-canopy-detail]")?.id).toBe(
      `canopy-detail-${cards(container)[1]!.id.replace(/^canopy-card-/, "")}`
    );
  });

  it("arms Trash from the menu for the pane to confirm, rather than trashing at once", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[1]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    fireEvent.click(items.find((item) => item.textContent?.startsWith("Trash"))!);
    expect(canopy.trash).not.toHaveBeenCalled();
    // The run it named is open, its Trash armed: the second press trashes it.
    expect(liveRun(container)).toBe("asking");
    await vi.waitFor(() =>
      expect(container.ownerDocument.body.textContent).toContain(
        "Press Trash terminal again to trash it"
      )
    );
    fireEvent.keyDown(cards(container)[1]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    expect(canopy.trash).toHaveBeenCalledWith("asking", { spawnedAt: NOW - 3_600_000 });
  });

  it("offers no Undo for an archive main refused, only the error", async () => {
    const canopy = installElectron();
    canopy.archive.mockRejectedValueOnce(new Error("rate limited"));
    const notifySpy = vi.mocked(notify);
    notifySpy.mockClear();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "e" });
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalled());
    const titles = notifySpy.mock.calls.map(([options]) => options.title);
    expect(titles).toEqual(["Couldn't archive"]);
    fireEvent.keyDown(cards(container)[0]!, { key: "z" });
    expect(canopy.unarchive).not.toHaveBeenCalled();
  });

  it("announces nothing for an archive main refused without an error", async () => {
    const canopy = installElectron();
    canopy.archive.mockResolvedValueOnce(null);
    vi.mocked(notify).mockClear();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "e" });
    await act(async () => {});
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
    fireEvent.keyDown(cards(container)[0]!, { key: "z" });
    expect(canopy.unarchive).not.toHaveBeenCalled();
  });

  it("forgets a Trash armed from the menu once the user moves to another run", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.contextMenu(cards(container)[0]!, { clientX: 5, clientY: 5 });
    const items = await within(document.body).findAllByRole("menuitem", { hidden: true });
    fireEvent.click(items.find((item) => item.textContent?.startsWith("Trash"))!);
    await vi.waitFor(() => expect(liveRun(container)).toBe("waiting"));
    fireEvent.click(cards(container)[1]!);
    fireEvent.click(cards(container)[0]!);
    // Back on it, one press only arms Trash again.
    fireEvent.keyDown(cards(container)[0]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    expect(canopy.trash).not.toHaveBeenCalled();
  });

  it("counts what needs you across the whole inbox while the Unread filter is on", async () => {
    installElectron({ ...canopySnapshot, reads: [unreadMark("working", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.click(screenButton(container.ownerDocument.body, "Unread1"));
    expect(cards(container).map((card) => card.id)).toEqual(["canopy-card-working"]);
    expect(container.ownerDocument.body.textContent).toContain("2 agents need you · 1 unread");
  });

  it("holds exactly the runs the header counts in the Needs you band, ahead of the rest", async () => {
    installElectron({ ...canopySnapshot, reads: [unreadMark("working", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    const body = container.ownerDocument.body;
    const band = body.querySelector("[aria-labelledby=canopy-needs-you-label]")!;
    const rest = body.querySelector("[aria-labelledby=canopy-everything-else-label]")!;
    expect(band.querySelectorAll("[data-canopy-card]")).toHaveLength(2);
    expect([...rest.querySelectorAll("[data-canopy-card]")].map((card) => card.id)).toEqual([
      "canopy-card-working",
    ]);
    expect(body.textContent).toContain("2 agents need you");
  });

  it("says a filter hides what the header counts when the band is empty under Unread", async () => {
    installElectron({ ...canopySnapshot, reads: [unreadMark("working", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    const body = container.ownerDocument.body;
    fireEvent.click(screenButton(body, "Unread1"));
    const band = body.querySelector("[aria-labelledby=canopy-needs-you-label]")!;
    expect(band.querySelectorAll("[data-canopy-card]")).toHaveLength(0);
    expect(bandWords()).toBe("2 agents need you, but a filter hides them");
  });

  it("takes the header count to the band and lifts the Unread filter that hides a member", async () => {
    installElectron({ ...canopySnapshot, reads: [unreadMark("working", 1)] });
    const { container } = render(<CanopyView />);
    await frames();
    const body = container.ownerDocument.body;
    fireEvent.click(screenButton(body, "Unread1"));
    expect(cards(container).map((card) => card.id)).toEqual(["canopy-card-working"]);
    fireEvent.click(body.querySelector<HTMLElement>("[data-testid=canopy-needs-you-count]")!);
    await frames();
    expect(useCanopyStore.getState().unreadOnly).toBe(false);
    const first = body.querySelector("[aria-labelledby=canopy-needs-you-label] [data-canopy-card]");
    expect(first?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens the selected row's menu from Shift+F10", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.keyDown(cards(container)[0]!, { key: "F10", shiftKey: true });
    expect(await within(document.body).findByRole("menu", { hidden: true })).not.toBeNull();
  });

  it("trashes the selected run from the list with its chord pressed twice", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [run("done", { agentState: "completed", since: NOW - 60_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    const canopy = installElectron();
    canopy.trash.mockResolvedValue(7);
    const { container } = render(<CanopyView />);
    await frames();
    // Down from the search to the row, where Z undoes once the row is gone.
    fireEvent.keyDown(searchInput(), { key: "Tab" });
    fireEvent.keyDown(cards(container)[0]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    // The first press only arms it.
    expect(canopy.trash).not.toHaveBeenCalled();
    vi.mocked(notify).mockClear();
    await act(async () => {
      fireEvent.keyDown(cards(container)[0]!, { key: "Backspace", metaKey: true, ctrlKey: true });
    });
    expect(canopy.trash).toHaveBeenCalledWith("done", { spawnedAt: NOW - 3_600_000 });
    // No toast: the panel's undo line names it, and it and Z take it back.
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
    const line = container.ownerDocument.querySelector("[data-canopy-undo-line]");
    expect(line?.textContent).toContain("Trashed '");
    const undo = [...line!.querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
    await act(async () => {
      fireEvent.click(undo);
    });
    // By the receipt the trash gave, so only that trash of that terminal comes back.
    expect(canopy.untrash).toHaveBeenCalledWith(7);
    expect(container.ownerDocument.querySelector("[data-canopy-undo-line]")).toBeNull();
    // Z, pressed after the line's Undo, finds it done: once only.
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "z" });
    });
    expect(canopy.untrash).toHaveBeenCalledTimes(1);
  });

  it("says nothing needs you only once the open's readings are in, and qualifies it when reads fail", async () => {
    const working = {
      snapshot: {
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    };
    useFleetSnapshotStore.setState(working);
    // Opening, with the working run's first reading still under way.
    const owed = { ...canopySnapshot, busy: true };
    useCanopyStore.setState({ snapshot: owed });
    installElectron(owed);
    const first = render(<CanopyView />);
    await frames();
    // A conclusion held back is the header's own words in the band, never its all-clear.
    expect(summaryWords()).toContain("Checking who needs you…");
    expect(bandWords()).toBe("Checking who needs you…");
    first.unmount();

    useCanopyStore.setState({ isOpen: true });
    useFleetSnapshotStore.setState(working);
    const failing = { ...canopySnapshot, lastError: "Couldn't reach Canopy" };
    useCanopyStore.setState({ snapshot: failing });
    installElectron(failing);
    render(<CanopyView />);
    await frames();
    expect(summaryWords()).toContain("Nothing needs you that Canopy could read");
    expect(bandWords()).toBe("Nothing needs you that Canopy could read");
  });

  it('withholds "Nothing needs you" while a read waits to be retried or agent status is unavailable', async () => {
    const working = (degraded: boolean) => ({
      snapshot: {
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
        changedAt: NOW,
        degraded,
        lastSuccessfulAt: NOW,
      },
    });
    useFleetSnapshotStore.setState(working(false));
    // A settled, calm reading, so only the retry holds the conclusion back.
    const calm = {
      ...stuckCard("working"),
      priority: 5,
      attentionScore: 5,
      headline: "Running the suite",
    };
    const retrying = { ...canopySnapshot, cards: [calm], waiting: "retrying" as const };
    useCanopyStore.setState({ snapshot: retrying });
    installElectron(retrying);
    const first = render(<CanopyView />);
    await frames();
    expect(summaryWords()).toContain("Checking who needs you…");
    expect(bandWords()).toBe("Checking who needs you…");
    // Once the retry is through, the conclusion stands: the header draws it and
    // the band settles it in words of its own.
    act(() => useCanopyStore.getState().applySnapshot({ ...canopySnapshot, cards: [calm] }));
    await frames();
    expect(summaryWords()).toBe("Nothing needs you");
    expect(document.body.textContent).not.toContain("Checking who needs you…");
    expect(bandWords()).toBe("No action needed");
    first.unmount();

    useCanopyStore.setState({ isOpen: true, snapshot: canopySnapshot });
    useFleetSnapshotStore.setState(working(true));
    installElectron();
    render(<CanopyView />);
    await frames();
    expect(summaryWords()).toContain("Can't tell who needs you right now");
    expect(bandWords()).toBe("Can't tell who needs you right now");
  });

  it("draws no heading over an empty band or over the rest, until the band has rows", async () => {
    const working = run("working", { agentState: "working", since: NOW - 30_000 });
    useFleetSnapshotStore.setState({
      snapshot: { runs: [working], changedAt: NOW, degraded: false, lastSuccessfulAt: NOW },
    });
    const calm = {
      ...stuckCard("working"),
      priority: 5,
      attentionScore: 5,
      headline: "Running the suite",
    };
    const settled = { ...canopySnapshot, cards: [calm] };
    useCanopyStore.setState({ snapshot: settled });
    installElectron(settled);
    const { container } = render(<CanopyView />);
    await frames();
    const body = container.ownerDocument.body;
    const band = body.querySelector("[role=group][aria-labelledby=canopy-needs-you-label]")!;
    expect(bandWords()).toBe("No action needed");
    // Words, not options: outside the listbox, which still holds the run.
    expect(band.closest("[role=listbox]")).toBeNull();
    expect(band.querySelector("[role=option]")).toBeNull();
    expect(cards(container).map((card) => card.id)).toEqual(["canopy-card-working"]);
    // Both groups keep their names for the screen reader; neither is drawn.
    const labelHidden = (id: string) => body.querySelector(`#${id}`)?.classList.contains("sr-only");
    expect(labelHidden("canopy-needs-you-label")).toBe(true);
    expect(labelHidden("canopy-everything-else-label")).toBe(true);
    expect(body.querySelector("[data-canopy-list]")!.hasAttribute("data-band-headings")).toBe(
      false
    );

    // An agent stops for the user: the band has a row, and both headings show.
    act(() =>
      useFleetSnapshotStore.setState({
        snapshot: {
          runs: [
            working,
            run("waiting", {
              agentState: "waiting",
              waitingReason: "approval",
              since: NOW - 10_000,
            }),
          ],
          changedAt: NOW + 1,
          degraded: false,
          lastSuccessfulAt: NOW,
        },
      })
    );
    await frames();
    expect(bandWords()).toBeNull();
    expect(labelHidden("canopy-needs-you-label")).toBe(false);
    expect(labelHidden("canopy-everything-else-label")).toBe(false);
    expect(body.querySelector("[data-canopy-list]")!.hasAttribute("data-band-headings")).toBe(true);
  });

  it("words the empty band as the header does with the reader off, never as the all-clear", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    const off = { ...canopySnapshot, activated: false, cards: [], glances: [] };
    installElectron(off);
    useCanopyStore.setState({ snapshot: off });
    render(<CanopyView />);
    await frames();
    expect(summaryWords()).toContain("No agent is waiting on you");
    expect(bandWords()).toBe("No agent is waiting on you");
  });

  it("says nothing is unread in a line of its own, with when each comes back", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    fireEvent.click(screenButton(container.ownerDocument.body, "Unread"));
    await frames();
    expect(cards(container)).toHaveLength(0);
    const line = [...document.querySelectorAll("[data-canopy-empty-line]")].find(
      (candidate) => candidate.querySelector("p")?.textContent === "Nothing unread"
    );
    expect(line?.textContent).toBe(
      "Nothing unreadEach agent shows here again when it does something new"
    );
  });

  it("lists a working run with the rest and lands on the top of the list", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    expect(cards(container).map((card) => card.id)).toEqual(["canopy-card-working"]);
    expect(liveRun(container)).toBe("working");
    const body = container.ownerDocument.body;
    expect(body.querySelector("#canopy-needs-you-label")).not.toBeNull();
    expect(
      body.querySelector("[role=group][aria-labelledby=canopy-needs-you-label]")?.textContent
    ).toContain("Not every agent could be read yet");
    expect(body.querySelector("#canopy-everything-else-label")).not.toBeNull();
  });

  it("tells main when a look at the shown run starts and ends, and starts none while the window is away", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const marked = () => canopy.markSeen.mock.calls.map(([id, looking]) => `${id}:${looking}`);
    expect(marked()).toEqual(["waiting:true"]);
    fireEvent.click(cards(container)[1]!);
    expect(marked()).toEqual(["waiting:true", "waiting:false", "asking:true"]);
    // A snapshot landing re-renders the panel but is no new look.
    act(() => useCanopyStore.setState({ snapshot: { ...canopySnapshot, refreshedAt: NOW + 1 } }));
    expect(marked()).toEqual(["waiting:true", "waiting:false", "asking:true"]);

    vi.mocked(document.hasFocus).mockReturnValue(false);
    fireEvent.click(cards(container)[2]!);
    expect(marked()).toEqual(["waiting:true", "waiting:false", "asking:true", "asking:false"]);
  });

  it("holds the order under the pointer, and re-ranks once the user leaves it alone", async () => {
    installElectron();
    useCanopyStore.setState({
      orders: {
        all: {
          ids: ["waiting", "asking", "working"],
          rankedFor: canopySnapshot.refreshedAt,
          urgent: [],
          band: ["waiting", "asking"],
        },
      },
    });
    const { container } = render(<CanopyView />);
    await frames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);

    const list = container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!;
    fireEvent.pointerEnter(list);
    // A scan lands that reads the working agent above the question, though
    // not as an urgent ask: only the hold decides when it moves.
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          refreshedAt: NOW + 10_000,
          // The question read as less pressing than it looked, and the working
          // agent clearly above it.
          cards: [
            { ...stuckCard("working"), priority: 84, attentionScore: 84 },
            quietQuestion("asking"),
          ],
        },
      })
    );
    expect(order()).toEqual(["waiting", "asking", "working"]);
    fireEvent.pointerLeave(list);
    // Not the moment the pointer leaves: the list was just ranked.
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(order()).toEqual(["waiting", "working", "asking"]);
  });

  it("places an ask that turns urgent at once, even under the pointer", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    fireEvent.pointerEnter(container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!);
    act(() =>
      useCanopyStore.setState({
        snapshot: { ...canopySnapshot, refreshedAt: NOW + 10_000, cards: [stuckCard("working")] },
      })
    );
    expect(order()).toEqual(["working", "waiting", "asking"]);
  });

  it("lets a selected row that no longer needs the user leave the band at the next re-rank, kept selected and focused", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const body = container.ownerDocument.body;
    const band = () =>
      [
        ...body.querySelectorAll<HTMLElement>(
          "[aria-labelledby=canopy-needs-you-label] [data-canopy-card]"
        ),
      ].map((card) => card.id.replace("canopy-card-", ""));
    const list = body.querySelector<HTMLElement>("[role=listbox]")!;
    expect(band()).toEqual(["waiting", "asking"]);
    const asking = cards(container)[1]!;
    fireEvent.pointerDown(asking);
    fireEvent.pointerUp(asking);
    fireEvent.click(asking);
    act(() => asking.focus());
    expect(selectedRun(container)).toBe("asking");
    fireEvent.pointerEnter(list);
    // The reply lands as handled, with no scan behind it: under the pointer it
    // reads as replied where it is.
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          dispositions: [
            { runId: "asking", spawnedAt: NOW - 3_600_000, kind: "replied" as const, at: NOW },
          ],
        },
      })
    );
    expect(band()).toEqual(["waiting", "asking"]);
    expect(body.querySelector("#canopy-card-asking")?.textContent).toContain("Replied");
    // The count is live, and says the band is behind it.
    expect(summaryWords()).toBe("1 agent needs you · Not every agent is sorted yet");
    // However long the pointer stays.
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(band()).toEqual(["waiting", "asking"]);

    // Left alone, the list re-ranks, though the row is still selected: it
    // moves out of the band under the selection, the pane and the keyboard
    // staying with it, and the list doesn't scroll to follow it.
    const terminal = body.querySelector("[data-canopy-terminal]");
    expect(terminal).not.toBeNull();
    expect(document.activeElement).toBe(asking);
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    const focused = vi.spyOn(HTMLElement.prototype, "focus");
    fireEvent.pointerLeave(list);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(band()).toEqual(["waiting"]);
    expect(asking.isConnected).toBe(false);
    expect(selectedRun(container)).toBe("asking");
    expect(body.querySelector("[data-canopy-terminal]")).toBe(terminal);
    const moved = body.querySelector<HTMLElement>("#canopy-card-asking")!;
    expect(document.activeElement).toBe(moved);
    expect(focused.mock.calls.filter((_, index) => focused.mock.contexts[index] === moved)).toEqual(
      [[{ preventScroll: true }]]
    );
    expect(scrolled).not.toHaveBeenCalled();
    expect(summaryWords()).toBe("1 agent needs you");
  });

  it("brings the selected row into view when the keyboard is lost from anything but its own row", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    const body = container.ownerDocument.body;
    expect(selectedRun(container)).toBe("waiting");
    // A control beside the list had the keyboard, and went away.
    const control = document.createElement("button");
    body.append(control);
    act(() => control.focus());
    control.remove();
    const scrolled = vi.mocked(Element.prototype.scrollIntoView);
    scrolled.mockClear();
    act(() => useCanopyStore.setState({ snapshot: { ...canopySnapshot, refreshedAt: NOW + 1 } }));
    expect(document.activeElement?.id).toBe("canopy-card-waiting");
    expect(scrolled).toHaveBeenCalled();
  });

  it("gives the band as it is now on Refresh, whatever is selected", async () => {
    const canopy = installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const body = container.ownerDocument.body;
    const band = () =>
      [
        ...body.querySelectorAll<HTMLElement>(
          "[aria-labelledby=canopy-needs-you-label] [data-canopy-card]"
        ),
      ].map((card) => card.id.replace("canopy-card-", ""));
    const asking = body.querySelector<HTMLElement>("#canopy-card-asking")!;
    fireEvent.pointerDown(asking);
    fireEvent.pointerUp(asking);
    fireEvent.click(asking);
    expect(selectedRun(container)).toBe("asking");
    // Answered in its terminal: Daintree sees it working again, and nothing
    // records a reply.
    act(() =>
      useFleetSnapshotStore.setState({
        snapshot: {
          runs: [
            run("waiting", {
              agentState: "waiting",
              waitingReason: "approval",
              since: NOW - 60_000,
            }),
            run("asking", { agentState: "working", since: NOW }),
            run("working", { agentState: "working", since: NOW - 30_000 }),
          ],
          changedAt: NOW + 1,
          degraded: false,
          lastSuccessfulAt: NOW + 1,
        },
      })
    );
    // Just interacted with: the list holds.
    expect(band()).toEqual(["waiting", "asking"]);
    await act(async () => {
      fireEvent.click(body.querySelector<HTMLElement>('button[aria-label="Refresh"]')!);
    });
    expect(canopy.refresh).toHaveBeenCalled();
    expect(band()).toEqual(["waiting"]);
    expect(selectedRun(container)).toBe("asking");
  });

  it("never gives the all-clear beside a band holding a run that no longer needs the user", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    const read = (priority: number, at: number) => ({
      ...canopySnapshot,
      refreshedAt: at,
      cards: [{ ...stuckCard("working"), priority, attentionScore: priority }],
    });
    useCanopyStore.setState({ snapshot: read(84, NOW) });
    installElectron(read(84, NOW));
    const { container } = render(<CanopyView />);
    await frames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const band = () =>
      [
        ...container.ownerDocument.querySelectorAll<HTMLElement>(
          "[aria-labelledby=canopy-needs-you-label] [data-canopy-card]"
        ),
      ].map((card) => card.id.replace("canopy-card-", ""));
    expect(band()).toEqual(["working"]);
    expect(selectedRun(container)).toBe("working");
    expect(summaryWords()).toContain("1 agent needs you");
    const list = container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!;
    fireEvent.pointerEnter(list);
    // Read again as going normally, while the pointer holds the band.
    act(() => useCanopyStore.setState({ snapshot: read(5, NOW + 10_000) }));
    expect(band()).toEqual(["working"]);
    // The count is live; the line says the band is behind rather than concluding.
    expect(summaryWords()).toBe("Not every agent is sorted yet");
    act(() =>
      useCanopyStore.setState({ snapshot: { ...read(5, NOW + 10_000), lastError: "Read failed" } })
    );
    expect(summaryWords()).toBe("Not every agent is sorted yet");
    act(() => useCanopyStore.setState({ snapshot: read(5, NOW + 10_000) }));
    fireEvent.pointerLeave(list);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(band()).toEqual([]);
    expect(selectedRun(container)).toBe("working");
    expect(summaryWords()).toBe("Nothing needs you");
    expect(bandWords()).toBe("No action needed");
  });

  it("keeps a run whose reading crosses the floor out of the band until the list may re-rank", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const doc = container.ownerDocument;
    const band = () =>
      [
        ...doc.querySelectorAll<HTMLElement>(
          "[aria-labelledby=canopy-needs-you-label] [data-canopy-card]"
        ),
      ].map((card) => card.id.replace("canopy-card-", ""));
    const sortNow = () =>
      Array.from(doc.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "Sort now"
      );
    const list = doc.querySelector<HTMLElement>("[role=listbox]")!;
    fireEvent.pointerEnter(list);
    // Read as needing the user, though not as an urgent ask.
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          refreshedAt: NOW + 10_000,
          cards: [{ ...stuckCard("working"), priority: 84, attentionScore: 84 }],
        },
      })
    );
    expect(band()).toEqual(["waiting", "asking"]);
    expect(summaryWords()).toBe("2 agents need you · Not every agent is sorted yet");
    expect(sortNow()).toBeDefined();
    fireEvent.pointerLeave(list);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(band()).toEqual(["waiting", "asking", "working"]);
    expect(summaryWords()).toBe("3 agents need you");
  });

  it("takes an ask that turns urgent into the band at once, while a crossing still waits", async () => {
    installElectron();
    const { container } = render(<CanopyView />);
    await frames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const doc = container.ownerDocument;
    const band = () =>
      [
        ...doc.querySelectorAll<HTMLElement>(
          "[aria-labelledby=canopy-needs-you-label] [data-canopy-card]"
        ),
      ].map((card) => card.id.replace("canopy-card-", ""));
    fireEvent.pointerEnter(doc.querySelector<HTMLElement>("[role=listbox]")!);
    const land = (refreshedAt: number, card: CanopyCard) =>
      act(() =>
        useCanopyStore.setState({ snapshot: { ...canopySnapshot, refreshedAt, cards: [card] } })
      );
    land(NOW + 10_000, { ...stuckCard("working"), priority: 84, attentionScore: 84 });
    expect(band()).toEqual(["waiting", "asking"]);
    land(NOW + 20_000, stuckCard("working"));
    expect(band()).toEqual(["working", "waiting", "asking"]);
    expect(doc.body.textContent).toContain("3 agents need you");
  });

  it("takes an approval Daintree sees into the band at once, whatever an earlier reading said", async () => {
    const fleet = (agentState: "working" | "waiting") => ({
      snapshot: {
        runs: [
          run("late", {
            agentState,
            ...(agentState === "waiting" ? { waitingReason: "approval" as const } : {}),
            // Well after the reading below was taken.
            since: agentState === "waiting" ? NOW + 60_000 : NOW - 30_000,
          }),
        ],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    useFleetSnapshotStore.setState(fleet("working"));
    const calm = {
      ...canopySnapshot,
      cards: [{ ...stuckCard("late"), priority: 10, attentionScore: 10 }],
    };
    useCanopyStore.setState({ snapshot: calm });
    installElectron(calm);
    const { container } = render(<CanopyView />);
    await frames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    expect(summaryWords()).toBe("Nothing needs you");
    fireEvent.pointerEnter(container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!);
    act(() => useFleetSnapshotStore.setState(fleet("waiting")));
    const band = container.ownerDocument.querySelector("[aria-labelledby=canopy-needs-you-label]");
    expect(band?.querySelector("#canopy-card-late")).not.toBeNull();
    expect(summaryWords()).toContain("1 agent needs you");
  });

  it('withholds "Nothing needs you" while a run that needs the user waits to join the band', async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [run("working", { agentState: "working", since: NOW - 30_000 })],
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
    });
    const read = (priority: number) => ({
      ...canopySnapshot,
      refreshedAt: NOW + priority,
      cards: [{ ...stuckCard("working"), priority, attentionScore: priority }],
    });
    useCanopyStore.setState({ snapshot: read(5) });
    installElectron(read(5));
    const { container } = render(<CanopyView />);
    await frames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    expect(summaryWords()).toBe("Nothing needs you");
    const list = container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!;
    fireEvent.pointerEnter(list);
    act(() => useCanopyStore.setState({ snapshot: read(84) }));
    expect(summaryWords()).toBe("Not every agent is sorted yet");
    expect(bandWords()).toBe("Not every agent is sorted yet");
    // Nor "nothing … that Canopy could read" while some screens can't be read.
    act(() => useCanopyStore.setState({ snapshot: { ...read(84), lastError: "Read failed" } }));
    expect(summaryWords()).toBe("Not every agent is sorted yet");
    fireEvent.pointerLeave(list);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(summaryWords()).toContain("1 agent needs you");
    expect(bandWords()).toBeNull();
  });

  it("shows every run at once while the cards it is owed are written, and places each as it lands", async () => {
    const owed = { ...canopySnapshot, busy: true };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    await frames();
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          // The question read as less pressing than it looked, and the working
          // agent clearly above it.
          cards: [
            { ...stuckCard("working"), priority: 84, attentionScore: 84 },
            quietQuestion("asking"),
          ],
        },
      })
    );
    await frames();
    expect(order()).toEqual(["waiting", "working", "asking"]);
  });

  it("ends the reveal when the pointer comes into the list, and offers the order it holds back", async () => {
    const owed = { ...canopySnapshot, busy: true };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const said: string[] = [];
    const unsubscribe = useAnnouncerStore.subscribe((state, before) => {
      if (state.polite && state.polite !== before.polite) said.push(state.polite.msg);
    });
    const { container } = render(<CanopyView />);
    await frames();
    const doc = container.ownerDocument;
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    const revealing = () => doc.querySelector("[data-canopy-list][data-revealing]") !== null;
    const sortNow = () =>
      Array.from(doc.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "Sort now"
      );
    expect(revealing()).toBe(true);
    fireEvent.pointerEnter(doc.querySelector<HTMLElement>("[role=listbox]")!);
    expect(revealing()).toBe(false);
    expect(sortNow()).toBeUndefined();
    const land = (refreshedAt: number, priority: number) =>
      act(() =>
        useCanopyStore.setState({
          snapshot: {
            ...owed,
            refreshedAt,
            // Far enough above the quiet question to pass it, were the list not held.
            cards: [
              { ...stuckCard("working"), priority, attentionScore: priority },
              quietQuestion("asking"),
            ],
          },
        })
      );
    land(NOW + 10_000, 84);
    await frames();
    expect(order()).toEqual(["waiting", "asking", "working"]);
    expect(sortNow()).toBeDefined();
    land(NOW + 20_000, 83);
    await frames();
    const offers = said.filter((msg) => msg.includes("Sort now"));
    unsubscribe();
    expect(offers).toHaveLength(1);

    fireEvent.click(sortNow()!);
    await frames();
    expect(order()).toEqual(["waiting", "working", "asking"]);
    expect(sortNow()).toBeUndefined();
  });

  it("ends the reveal when the user moves the selection, and holds the next score for the pause", async () => {
    const owed = { ...canopySnapshot, busy: true };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    await frames();
    const doc = container.ownerDocument;
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    const before = selectedRun(container);
    expect(doc.querySelector("[data-canopy-list][data-revealing]")).not.toBeNull();
    fireEvent.keyDown(searchInput(), { key: "ArrowDown" });
    expect(selectedRun(container)).not.toBe(before);
    expect(doc.querySelector("[data-canopy-list][data-revealing]")).toBeNull();
    // The user has just moved: the score waits for the pause, as always.
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...owed,
          refreshedAt: NOW + 10_000,
          cards: [
            { ...stuckCard("working"), priority: 84, attentionScore: 84 },
            quietQuestion("asking"),
          ],
        },
      })
    );
    await frames();
    expect(order()).toEqual(["waiting", "asking", "working"]);
  });

  it("ends the reveal when ⌘↓ steps to the next agent from its terminal", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const owed = { ...canopySnapshot, busy: true };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    await frames();
    const doc = container.ownerDocument;
    const before = liveRun(container);
    expect(doc.querySelector("[data-canopy-list][data-revealing]")).not.toBeNull();
    terminalInput(container).focus();
    fireEvent.keyDown(terminalInput(container), { key: "ArrowDown", metaKey: true });
    expect(liveRun(container)).not.toBe(before);
    expect(doc.querySelector("[data-canopy-list][data-revealing]")).toBeNull();
  });

  it.each([
    ["typing in the search", () => fireEvent.input(searchInput(), { target: { value: "a" } })],
    [
      "scrolling the list",
      () => fireEvent.wheel(document.querySelector<HTMLElement>("[data-canopy-list]")!),
    ],
    [
      "pressing on the list's scrollbar",
      () => fireEvent.pointerDown(document.querySelector<HTMLElement>("[data-canopy-list]")!),
    ],
  ])("ends the reveal on %s", async (_, interact) => {
    const owed = { ...canopySnapshot, busy: true };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    await frames();
    const revealing = () =>
      container.ownerDocument.querySelector("[data-canopy-list][data-revealing]") !== null;
    expect(revealing()).toBe(true);
    act(() => interact());
    expect(revealing()).toBe(false);
  });

  it("keeps revealing when the list is scrolled for it, not by the user", async () => {
    const owed = { ...canopySnapshot, busy: true };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    await frames();
    const list = container.ownerDocument.querySelector<HTMLElement>("[data-canopy-list]")!;
    act(() => {
      fireEvent.scroll(list);
    });
    expect(list.hasAttribute("data-revealing")).toBe(true);
  });

  it("keeps an offered order on offer when an ask turns urgent, and says it once", async () => {
    installElectron();
    const said: string[] = [];
    const unsubscribe = useAnnouncerStore.subscribe((state, before) => {
      if (state.polite && state.polite !== before.polite) said.push(state.polite.msg);
    });
    const { container } = render(<CanopyView />);
    await frames();
    const doc = container.ownerDocument;
    const sortNow = () =>
      Array.from(doc.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "Sort now"
      );
    fireEvent.pointerEnter(doc.querySelector<HTMLElement>("[role=listbox]")!);
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          refreshedAt: NOW + 10_000,
          cards: [
            { ...stuckCard("working"), priority: 84, attentionScore: 84 },
            quietQuestion("asking"),
          ],
        },
      })
    );
    await frames();
    expect(sortNow()).toBeDefined();
    sortNow()!.focus();
    // An urgent ask arrives: it is placed at once, and the held reorder stays held.
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          refreshedAt: NOW + 10_000,
          cards: [
            { ...stuckCard("working"), priority: 84, attentionScore: 84 },
            quietQuestion("asking"),
            { ...stuckCard("waiting"), priority: 95, attentionScore: 95 },
          ],
        },
      })
    );
    await frames();
    unsubscribe();
    expect(sortNow()).toBeDefined();
    expect(doc.activeElement).toBe(sortNow());
    expect(said.filter((msg) => msg.includes("Sort now"))).toHaveLength(1);
  });

  it("stops revealing once the cards it was owed have landed, and holds still after", async () => {
    const owed = { ...canopySnapshot, busy: true };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    await frames();
    const revealing = () =>
      container.ownerDocument.querySelector("[data-canopy-list][data-revealing]") !== null;
    expect(revealing()).toBe(true);
    act(() => useCanopyStore.setState({ snapshot: canopySnapshot }));
    await frames();
    expect(revealing()).toBe(false);
    // Revealed: a score landing under the pointer waits, as always.
    fireEvent.pointerEnter(container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!);
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...canopySnapshot,
          refreshedAt: NOW + 20_000,
          // Far enough above the quiet question to pass it, were the list not held.
          cards: [
            { ...stuckCard("working"), priority: 84, attentionScore: 84 },
            quietQuestion("asking"),
          ],
        },
      })
    );
    await frames();
    expect(cards(container).map((card) => card.id.replace("canopy-card-", ""))).toEqual([
      "waiting",
      "asking",
      "working",
    ]);
  });

  it("shows the runs main is still reading for the first time, and moves them as readings land", async () => {
    // The snapshot in hand is from before the open; main's answer says it is reading.
    installElectron({ ...canopySnapshot, busy: true });
    useCanopyStore.setState({ snapshot: { ...canopySnapshot, active: false } });
    const { container } = render(<CanopyView />);
    await frames();
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() =>
      useCanopyStore.setState({
        snapshot: { ...canopySnapshot, busy: true, cards: [stuckCard("working")] },
      })
    );
    await frames();
    expect(order()).toEqual(["working", "waiting", "asking"]);
  });

  it("holds still like always once the open's readings have had their time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const owed = { ...canopySnapshot, busy: true };
    installElectron(owed);
    useCanopyStore.setState({ snapshot: owed });
    const { container } = render(<CanopyView />);
    const order = () => cards(container).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() => {
      vi.advanceTimersByTime(CANOPY_REVEAL_MS);
    });
    // Over by the clock alone, before the pointer comes in.
    expect(container.ownerDocument.querySelector("[data-canopy-list][data-revealing]")).toBeNull();
    fireEvent.pointerEnter(container.ownerDocument.querySelector<HTMLElement>("[role=listbox]")!);
    act(() =>
      useCanopyStore.setState({
        snapshot: {
          ...owed,
          refreshedAt: NOW + 20_000,
          // Far enough above the quiet question to pass it, were the list not held.
          cards: [
            { ...stuckCard("working"), priority: 84, attentionScore: 84 },
            quietQuestion("asking"),
          ],
        },
      })
    );
    expect(order()).toEqual(["waiting", "asking", "working"]);
  });

  it("keeps the inbox's heading still while summaries are written, and says so in its footer", async () => {
    const reading = {
      ...canopySnapshot,
      cards: [{ ...stuckCard("working"), describing: true }],
      reader: { model: "Light", inFlight: 1, readMs: 9 },
    };
    installElectron(reading);
    useCanopyStore.setState({ snapshot: reading });
    const { container } = render(<CanopyView />);
    await frames();
    const heading = container.ownerDocument.querySelector("#canopy-inbox-label")!.parentElement!;
    expect(heading.textContent).not.toMatch(/Updating|Starting|retry/);
    const footer = container.ownerDocument.querySelector("[data-canopy-status]")!;
    expect(footer.textContent).toBe("Light model, on this computer9 ms a screen");
    // Under the list, in the same column, not over the pane beside it. The
    // column's edge handle sits out of flow, after it.
    const column = container.ownerDocument.querySelector("[data-canopy-list]")!.parentElement!;
    const handle = container.ownerDocument.querySelector("[data-testid=canopy-list-resize]");
    expect(handle?.parentElement).toBe(column);
    expect([...column.children].filter((child) => child !== handle).at(-1)).toBe(footer);
  });

  it("opens in the order it was left, or ranked before it shows when something was read meanwhile", async () => {
    installElectron();
    const first = render(<CanopyView />);
    await frames();
    const order = () => cards(document.body).map((card) => card.id.replace("canopy-card-", ""));
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() => useCanopyStore.setState({ isOpen: false }));
    first.unmount();

    act(() => useCanopyStore.setState({ isOpen: true }));
    const second = render(<CanopyView />);
    await frames();
    expect(order()).toEqual(["waiting", "asking", "working"]);
    act(() => useCanopyStore.setState({ isOpen: false }));
    second.unmount();

    // Read while closed: the list opens in its new order, with no move to see.
    // The stuck agent turned urgent meanwhile, so it opens in the readers'
    // place for it, however near the approval above.
    act(() =>
      useCanopyStore.setState({
        snapshot: { ...canopySnapshot, refreshedAt: NOW + 10_000, cards: [stuckCard("working")] },
      })
    );
    act(() => useCanopyStore.setState({ isOpen: true }));
    render(<CanopyView />);
    expect(order()).toEqual(["working", "waiting", "asking"]);
  });
});
