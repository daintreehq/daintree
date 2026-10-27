// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { CanopySnapshot, CanopyTrashEntry } from "@shared/types/ipc/canopy";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class IntersectionObserverStub {
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
// The pane's reply draws an editor that needs a project's stores; the list is what is tested here.
vi.mock("@/components/Terminal/HybridInputBar", () => ({ HybridInputBar: () => null }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { notify } from "@/lib/notify";
import { CanopyView } from "../CanopyView";
import { useCanopyStore } from "@/store/canopyStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { __resetCanopySeenForTests } from "@/lib/canopySeen";
import { __resetCanopyPlaceForTests } from "../CanopyPlace";

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

/** A run the host's trash holds, closed `ageMs` ago, named by the user. */
function trashed(runId: string, workspaceId: string, ageMs: number): CanopyTrashEntry {
  return {
    run: run(runId, { workspaceId, title: `Fix ${runId}`, titleMode: "user" }),
    trashedAt: NOW - ageMs,
    expiresAt: NOW - ageMs + 20_000,
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
};

const TRASH = [trashed("newer", "p2", 3_000), trashed("older", "p1", 9_000)];

function fleet(runIds: string[]): FleetSnapshot {
  return {
    runs: runIds.map((runId) =>
      run(runId, { agentState: "waiting", waitingReason: "question", since: NOW - 60_000 })
    ),
    changedAt: NOW,
    degraded: false,
    lastSuccessfulAt: NOW,
  };
}

function installElectron(snapshot: CanopySnapshot) {
  const canopy = {
    onSnapshotUpdated: vi.fn(() => () => {}),
    setActive: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => {}),
    trash: vi.fn(async (): Promise<number | null> => null),
    untrash: vi.fn(async () => {}),
    restoreTrashed: vi.fn(async (_runId: string, _target: unknown) => {}),
    removeTrashed: vi.fn(async (_runId: string, _target: unknown) => {}),
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
    captureBackdrop: vi.fn(async () => null),
    readAgentDirectory: vi.fn(async () => ({
      coverage: "ok" as const,
      observedAt: 1,
      complete: true,
      omitted: 0,
      entries: [],
    })),
    rename: vi.fn(async () => {}),
    setMode: vi.fn(async () => snapshot),
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

/** Shows the panel over `trash`, with the given runs in the inbox. */
async function open(trash: CanopyTrashEntry[], runIds: string[] = ["live"]) {
  const snapshot = { ...baseSnapshot, trash };
  useFleetSnapshotStore.setState({ snapshot: fleet(runIds) });
  useCanopyStore.setState({ isOpen: true, snapshot, mode: "on" });
  const canopy = installElectron(snapshot);
  render(<CanopyView />);
  await frames();
  return canopy;
}

async function frames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

function trashBar(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("button[aria-controls=canopy-trash]");
}

function trashRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-canopy-trash-row]")];
}

function dialogButton(name: string): HTMLElement {
  return within(document.body).getByRole("button", { name, hidden: true });
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  __resetCanopySeenForTests();
  __resetCanopyPlaceForTests();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useProjectStore.setState({
    projects: [
      { id: "p1", path: "/repo", name: "app", emoji: "🌳", lastOpened: NOW },
      { id: "p2", path: "/api", name: "api", lastOpened: NOW - 1 },
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
  window.localStorage.removeItem("daintree-canopy-order");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CanopyView Trash", () => {
  it("lists every project's trashed agents under a folded Trash, newest first", async () => {
    await open(TRASH);
    const bar = trashBar()!;
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(bar.textContent).toContain("Trash");
    expect(bar.textContent).toContain("2");
    expect(trashRows()).toHaveLength(0);

    fireEvent.click(bar);
    const rows = trashRows();
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Fix newer", "Fix older"]);
    // Where each ran, and when it was closed, to the second.
    expect(rows[0]!.querySelector("[data-canopy-project]")?.textContent).toBe("api");
    expect(rows[1]!.querySelector("[data-canopy-project]")?.textContent).toBe("app");
    expect(rows[0]!.textContent).toMatch(/Closed \d+s ago/);
  });

  it("shows no Trash at all while the trash is empty, even with the inbox empty too", async () => {
    await open([], []);
    expect(trashBar()).toBeNull();
    expect(document.getElementById("canopy-trash-label")).toBeNull();
  });

  it("shows a search's matching trash rows open, without unfolding the Trash for good", async () => {
    await open(TRASH);
    const input = document.querySelector<HTMLInputElement>(
      "[data-testid=canopy-dialog] input[role=combobox]"
    )!;
    await act(async () => {
      fireEvent.change(input, { target: { value: "api" } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(trashRows().map((row) => row.getAttribute("aria-label"))).toEqual(["Fix newer"]);
    expect(useCanopyStore.getState().trashExpanded).toBe(false);
  });

  it("restores from the row's button, and selects the run once it is back in the inbox", async () => {
    const canopy = await open(TRASH);
    fireEvent.click(trashBar()!);
    const restore = trashRows()[1]!.querySelector<HTMLElement>("[data-canopy-trash-restore]")!;
    await act(async () => {
      fireEvent.click(restore);
    });
    expect(canopy.restoreTrashed).toHaveBeenCalledWith("older", {
      spawnedAt: NOW - 3_600_000,
      expiresAt: TRASH[1]!.expiresAt,
    });
    // Back in the fleet, and gone from the trash.
    await act(async () => {
      useFleetSnapshotStore.setState({ snapshot: fleet(["live", "older"]) });
      useCanopyStore.setState({ snapshot: { ...baseSnapshot, trash: [TRASH[0]!] } });
    });
    await frames();
    expect(document.getElementById("canopy-card-older")?.getAttribute("aria-selected")).toBe(
      "true"
    );
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });

  it("is reached from the inbox's last row by arrow, unfolded there, and Enter restores", async () => {
    const canopy = await open(TRASH);
    const last = document.getElementById("canopy-card-live")!;
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(document.activeElement).toBe(trashBar());
    // The bar's own button: Enter and Space press it.
    fireEvent.click(trashBar()!);
    fireEvent.keyDown(trashBar()!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(trashRows()[0]);
    fireEvent.keyDown(trashRows()[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(trashRows()[1]);
    await act(async () => {
      fireEvent.keyDown(trashRows()[1]!, { key: "Enter" });
    });
    expect(canopy.restoreTrashed).toHaveBeenCalledWith("older", expect.anything());
    // Up off the bar is back into the inbox.
    fireEvent.keyDown(trashRows()[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(trashBar());
    fireEvent.keyDown(trashBar()!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(last);
  });

  it("removes a run for good only once confirmed: cancelling leaves it", async () => {
    const canopy = await open(TRASH);
    fireEvent.click(trashBar()!);
    const ask = async () => {
      fireEvent.contextMenu(trashRows()[0]!);
      const item = await within(document.body).findByRole("menuitem", {
        name: "Remove now…",
        hidden: true,
      });
      await act(async () => {
        fireEvent.click(item);
      });
    };
    await ask();
    expect(within(document.body).getByText("Remove 'Fix newer'?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(dialogButton("Cancel"));
    });
    expect(canopy.removeTrashed).not.toHaveBeenCalled();

    await ask();
    await act(async () => {
      fireEvent.click(dialogButton("Remove panel"));
    });
    expect(canopy.removeTrashed).toHaveBeenCalledWith("newer", {
      spawnedAt: NOW - 3_600_000,
      expiresAt: TRASH[0]!.expiresAt,
    });
  });

  it("empties exactly the runs the confirm named, once confirmed", async () => {
    const canopy = await open(TRASH);
    const options = within(document.body).getByRole("button", {
      name: "Trash options",
      hidden: true,
    });
    const ask = async () => {
      await act(async () => {
        fireEvent.keyDown(options, { key: "Enter" });
      });
      const item = await within(document.body).findByRole("menuitem", {
        name: "Empty trash…",
        hidden: true,
      });
      await act(async () => {
        fireEvent.click(item);
      });
    };
    await ask();
    expect(within(document.body).getByText("2 panels will be permanently removed.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(dialogButton("Cancel"));
    });
    expect(canopy.emptyTrash).not.toHaveBeenCalled();

    await ask();
    // One leaves the trash while the confirm is open: it is still the list confirmed.
    await act(async () => {
      useCanopyStore.setState({ snapshot: { ...baseSnapshot, trash: [TRASH[1]!] } });
    });
    await act(async () => {
      fireEvent.click(dialogButton("Empty trash"));
    });
    expect(canopy.emptyTrash).toHaveBeenCalledWith([
      { runId: "newer", spawnedAt: NOW - 3_600_000, expiresAt: TRASH[0]!.expiresAt },
      { runId: "older", spawnedAt: NOW - 3_600_000, expiresAt: TRASH[1]!.expiresAt },
    ]);
  });

  it("says once, politely, that a run left the trash at its time", async () => {
    const announce = vi
      .spyOn(useAnnouncerStore.getState(), "announce")
      .mockImplementation(() => {});
    const due: CanopyTrashEntry = {
      ...trashed("due", "p2", 19_800),
      expiresAt: Date.now() + 200,
    };
    const restored = trashed("restored", "p2", 2_000);
    await open([due, restored]);
    await act(async () => {
      useCanopyStore.setState({ snapshot: { ...baseSnapshot, trash: [restored] } });
    });
    // Restored or removed long before its time: not an expiry.
    await act(async () => {
      useCanopyStore.setState({ snapshot: { ...baseSnapshot, trash: [] } });
    });
    expect(announce.mock.calls).toEqual([["'Fix due' expired and was removed permanently"]]);
  });
});
