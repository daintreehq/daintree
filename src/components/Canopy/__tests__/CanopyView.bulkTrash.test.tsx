// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type {
  CanopyInputLineReading,
  CanopyRunTarget,
  CanopySnapshot,
  CanopyTrashOutcome,
  CanopyUntrashOutcome,
} from "@shared/types/ipc/canopy";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
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

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true })) },
}));
vi.mock("../CanopyTerminal", () => ({
  CanopyTerminal: () => <div data-canopy-terminal="" />,
}));
vi.mock("@/components/Terminal/HybridInputBar", () => ({ HybridInputBar: () => null }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
}));

import { CanopyView } from "../CanopyView";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { isolatedComposerScope } from "@/lib/draftKey";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";

const NOW = Date.now();
const SPAWNED = NOW - 3_600_000;
/** Past the panel's wait on the typing before a search applies. */
const SEARCH_SETTLE_MS = 250;

type Run = FleetSnapshot["runs"][number];

function run(runId: string, overrides: Partial<Run> = {}): Run {
  return {
    runId,
    workspaceId: "p1",
    spawnedAt: SPAWNED,
    cwd: "/repo",
    agentId: "claude",
    title: `Review ${runId}`,
    titleMode: "user",
    agentState: "waiting",
    waitingReason: "question",
    since: NOW - 60_000,
    ...overrides,
  };
}

const baseSnapshot: CanopySnapshot = {
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
  trash: [],
};

function installElectron() {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => baseSnapshot),
    refresh: vi.fn(async () => {}),
    trash: vi.fn(async (): Promise<number | null> => null),
    trashBatch: vi.fn(async (targets: CanopyRunTarget[]): Promise<CanopyTrashOutcome[]> =>
      targets.map((target, index) => ({ runId: target.runId, receipt: index + 1 }))
    ),
    untrash: vi.fn(async () => {}),
    untrashBatch: vi.fn(async (receipts: number[]): Promise<CanopyUntrashOutcome[]> =>
      receipts.map((receipt) => ({ receipt }))
    ),
    readInputLines: vi.fn(async (targets: CanopyRunTarget[]): Promise<CanopyInputLineReading[]> =>
      targets.map((target) => ({ runId: target.runId, state: "empty" }))
    ),
    restoreTrashed: vi.fn(async (runId: string) => ({ runId })),
    removeTrashed: vi.fn(async () => {}),
    emptyTrash: vi.fn(async (targets: unknown[]) => targets.length),
    reread: vi.fn(async () => {}),
    setShown: vi.fn(async () => {}),
    archive: vi.fn(async () => null),
    unarchive: vi.fn(async () => {}),
    setScope: vi.fn(async () => {}),
    markSeen: vi.fn(async () => {}),
    setRead: vi.fn(async () => null),
    markAllRead: vi.fn(async () => []),
    restoreReads: vi.fn(async () => {}),
    runBranch: vi.fn(async () => null),
    searchScreens: vi.fn(async () => [] as string[]),
    readAgentDirectory: vi.fn(async () => ({
      coverage: "ok" as const,
      observedAt: 1,
      complete: true,
      omitted: 0,
      entries: [],
    })),
    rename: vi.fn(async () => {}),
    setMode: vi.fn(async () => baseSnapshot),
  };
  Object.defineProperty(window, "electron", {
    value: {
      canopy,
      fleet: {
        parkRun: vi.fn(async () => {}),
        unparkRun: vi.fn(async () => {}),
        snoozeRun: vi.fn(async () => {}),
        unsnoozeRun: vi.fn(async () => {}),
      },
      terminal: { restore: vi.fn() },
      system: { openExternal: vi.fn() },
    },
    configurable: true,
    writable: true,
  });
  return canopy;
}

async function frames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function open(runs: Run[]) {
  useFleetSnapshotStore.setState({
    snapshot: { runs, changedAt: NOW, degraded: false, lastSuccessfulAt: NOW },
  });
  useCanopyStore.setState({ isOpen: true, snapshot: baseSnapshot, mode: "on" });
  const canopy = installElectron();
  render(<CanopyView />);
  await frames();
  return canopy;
}

function searchInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(
    "[data-testid=canopy-dialog] input[role=combobox]"
  )!;
}

async function search(text: string) {
  await act(async () => {
    fireEvent.change(searchInput(), { target: { value: text } });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_SETTLE_MS));
  });
}

function trashResultsButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-canopy-trash-results]");
}

function reviewRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-bulk-trash-runs] > li")];
}

function ticked(row: HTMLElement): boolean {
  return row.querySelector("[role=checkbox]")?.getAttribute("aria-checked") === "true";
}

function dialogButton(name: string | RegExp): HTMLElement {
  return within(document.body).getByRole("button", { name, hidden: true });
}

/** Opens the review from the Inbox bar and lets the input-line checks land. */
async function openReview() {
  await act(async () => {
    fireEvent.click(trashResultsButton()!);
  });
  await frames();
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", ObserverStub);
  vi.stubGlobal("ResizeObserver", ObserverStub);
  __resetCanopySeenForTests();
  __resetCanopyPlaceForTests();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useProjectStore.setState({
    projects: [
      { id: "p1", path: "/repo", name: "app", emoji: "🌳", lastOpened: NOW },
      { id: "p2", path: "/api", name: "api", emoji: "🧪", lastOpened: NOW - 1 },
    ],
  });
});

afterEach(() => {
  useCanopyStore.setState({
    isOpen: false,
    snapshot: null,
    mode: "unset",
    scope: "all",
    orders: {},
    unreadOnly: false,
    trashExpanded: false,
  });
  useTerminalInputStore.setState({ draftInputs: new Map() });
  window.localStorage.removeItem("daintree-canopy-order");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CanopyView bulk trash of search results", () => {
  it("offers the review only while a search has results", async () => {
    await open([run("a"), run("b", { title: "Ship docs" })]);
    expect(trashResultsButton()).toBeNull();
    await search("review");
    expect(trashResultsButton()).not.toBeNull();
    await search("nothing matches this");
    expect(trashResultsButton()).toBeNull();
  });

  it("lists exactly the search's results, with project and observed state", async () => {
    await open([run("a"), run("b", { workspaceId: "p2" }), run("c", { title: "Ship docs" })]);
    await search("review");
    await openReview();
    const rows = reviewRows();
    expect(rows.map((row) => row.getAttribute("data-run-id")).sort()).toEqual(["a", "b"]);
    const b = rows.find((row) => row.getAttribute("data-run-id") === "b")!;
    expect(b.textContent).toContain("Review b");
    expect(b.textContent).toContain("api");
    expect(document.body.textContent).toContain("Trash results for 'review'?");
  });

  it("starts working runs, typed input and drafted replies unticked, but not a CLI suggestion", async () => {
    const canopy = await open([
      run("idle"),
      run("busy", { agentState: "working", waitingReason: undefined }),
      run("typed"),
      run("ghost"),
      run("drafted"),
    ]);
    canopy.readInputLines.mockImplementation(async (targets) =>
      targets.map((target) => ({
        runId: target.runId,
        state:
          target.runId === "typed" ? "typed" : target.runId === "ghost" ? "suggestion" : "empty",
      }))
    );
    useTerminalInputStore.setState({
      draftInputs: new Map([[`${isolatedComposerScope()}:drafted`, "half a reply"]]),
    });
    await search("review");
    await openReview();
    const byId = new Map(reviewRows().map((row) => [row.getAttribute("data-run-id"), row]));
    expect(ticked(byId.get("idle")!)).toBe(true);
    expect(ticked(byId.get("ghost")!)).toBe(true);
    expect(ticked(byId.get("busy")!)).toBe(false);
    expect(byId.get("busy")!.getAttribute("data-hold")).toBe("working");
    expect(ticked(byId.get("typed")!)).toBe(false);
    expect(byId.get("typed")!.getAttribute("data-hold")).toBe("typed");
    expect(ticked(byId.get("drafted")!)).toBe(false);
    expect(byId.get("drafted")!.getAttribute("data-hold")).toBe("reply");
    // Only the ticked ones go, in one call, each in the incarnation listed.
    await act(async () => {
      fireEvent.click(dialogButton("Trash 2 agents"));
    });
    expect(canopy.trashBatch).toHaveBeenCalledTimes(1);
    const sent = canopy.trashBatch.mock.calls[0]![0];
    expect(sent.map((target) => target.runId).sort()).toEqual(["ghost", "idle"]);
    expect(sent.every((target) => target.spawnedAt === SPAWNED)).toBe(true);
    expect(canopy.trash).not.toHaveBeenCalled();
  });

  it("lets a held run be ticked by hand before trashing", async () => {
    const canopy = await open([run("idle"), run("busy", { agentState: "working" })]);
    await search("review");
    await openReview();
    const busy = reviewRows().find((row) => row.getAttribute("data-run-id") === "busy")!;
    await act(async () => {
      fireEvent.click(busy.querySelector("[role=checkbox]")!);
    });
    await act(async () => {
      fireEvent.click(dialogButton("Trash 2 agents"));
    });
    expect(canopy.trashBatch.mock.calls[0]![0].map((target) => target.runId).sort()).toEqual([
      "busy",
      "idle",
    ]);
  });

  it("closes once every run went, and one Z takes them all back", async () => {
    const canopy = await open([run("a"), run("b")]);
    await search("review");
    await openReview();
    await act(async () => {
      fireEvent.click(dialogButton("Trash 2 agents"));
    });
    await frames();
    expect(reviewRows()).toHaveLength(0);
    expect(document.body.textContent).toContain("Trashed 2 agents");
    const row =
      document.getElementById("canopy-card-a") ?? document.getElementById("canopy-card-b");
    await act(async () => {
      fireEvent.keyDown(row!, { key: "z" });
    });
    expect(canopy.untrashBatch).toHaveBeenCalledTimes(1);
    expect([...canopy.untrashBatch.mock.calls[0]![0]].sort()).toEqual([1, 2]);
    expect(canopy.untrash).not.toHaveBeenCalled();
  });

  it("keeps the review open on a refusal, naming why each run stayed", async () => {
    const canopy = await open([run("a"), run("b")]);
    canopy.trashBatch.mockImplementation(async (targets) =>
      targets.map((target) =>
        target.runId === "a"
          ? { runId: "a", receipt: 7 }
          : { runId: target.runId, error: "This project is being driven from another screen." }
      )
    );
    await search("review");
    await openReview();
    await act(async () => {
      fireEvent.click(dialogButton("Trash 2 agents"));
    });
    await frames();
    const byId = new Map(reviewRows().map((row) => [row.getAttribute("data-run-id"), row]));
    expect(byId.get("a")!.getAttribute("data-outcome")).toBe("trashed");
    expect(byId.get("b")!.getAttribute("data-outcome")).toBe("failed");
    expect(byId.get("b")!.textContent).toContain(
      "Not trashed: This project is being driven from another screen."
    );
    expect(document.body.textContent).toContain("Trashed 1 of 2 agents");
  });

  it("says a host's whole refusal for each of its runs", async () => {
    const canopy = await open([run("a"), run("b")]);
    canopy.trashBatch.mockRejectedValue(new Error("Host went away."));
    await search("review");
    await openReview();
    await act(async () => {
      fireEvent.click(dialogButton("Trash 2 agents"));
    });
    await frames();
    expect(reviewRows().map((row) => row.getAttribute("data-outcome"))).toEqual([
      "failed",
      "failed",
    ]);
    expect(document.body.textContent).toContain("Not trashed: Host went away.");
  });

  it("opens the review with Cmd+A from a row, but leaves Cmd+A in the search to its words", async () => {
    await open([run("a"), run("b")]);
    await search("review");
    await act(async () => {
      fireEvent.keyDown(searchInput(), { key: "a", metaKey: true });
    });
    await frames();
    expect(reviewRows()).toHaveLength(0);
    const row = document.getElementById("canopy-card-a")!;
    await act(async () => {
      fireEvent.keyDown(row, { key: "a", metaKey: true });
    });
    await frames();
    expect(reviewRows()).toHaveLength(2);
  });

  it("does nothing on Cmd+A from a row with no search", async () => {
    await open([run("a"), run("b")]);
    const row = document.getElementById("canopy-card-a")!;
    await act(async () => {
      fireEvent.keyDown(row, { key: "a", metaKey: true });
    });
    await frames();
    expect(reviewRows()).toHaveLength(0);
  });

  it("leaves a run whose input couldn't be read ticked, and says so", async () => {
    const canopy = await open([run("a")]);
    canopy.readInputLines.mockRejectedValue(new Error("unreachable"));
    await search("review");
    await openReview();
    const [row] = reviewRows();
    expect(ticked(row!)).toBe(true);
    expect(row!.textContent).toContain("Its input couldn't be checked");
  });
});
