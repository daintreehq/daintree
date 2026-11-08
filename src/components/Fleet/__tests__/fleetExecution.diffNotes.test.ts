// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executeFleetBroadcast, findCrossHostContextTargets } from "../fleetExecution";
import { crossHostTargetKey } from "../crossHostFleet";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { setCurrentViewStore, type WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { DiffNote } from "@/components/Worktree/diffNotes";

const submitMock = vi.hoisted(() =>
  vi.fn<(id: string, text: string, token?: string) => Promise<void>>()
);
const clearDiffNotesOnceWritten = vi.hoisted(() =>
  vi.fn<(terminalId: string, token: string, notes: readonly DiffNote[]) => void>()
);

vi.mock("@/components/Terminal/diffNotesDelivery", () => ({ clearDiffNotesOnceWritten }));

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    terminalClient: {
      ...actual.terminalClient,
      submit: (...args: [string, string, string?]) => submitMock(...args),
    },
  };
});

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    notifyUserInput: () => {},
    notifyEnterPressed: () => {},
    clearDirectingState: () => {},
    get: () => undefined,
    getCachedSelection: () => null,
  };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});

import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

beforeAll(async () => {
  await loadTerminalService();
});

function agent(id: string, worktreeId: string, overrides: Partial<PtyPanelData> = {}) {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: `/repo/${worktreeId}`,
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId,
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as PtyPanelData;
}

function seedFleet(panels: PanelInstance[]): void {
  const panelIds = panels.map((panel) => panel.id);
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((panel) => [panel.id, panel])),
    panelIds,
  });
  useFleetArmingStore.setState({
    armedIds: new Set(panelIds),
    armOrder: panelIds,
    armOrderById: Object.fromEntries(panelIds.map((id, i) => [id, i + 1])),
    lastArmedId: panelIds[panelIds.length - 1] ?? null,
    crossHostTargets: [],
  });
}

function addNote(worktreeId: string, body: string): DiffNote {
  return useDiffNotesStore.getState().addNote({
    worktreePath: `/repo/${worktreeId}`,
    filePath: "src/a.ts",
    anchor: { kind: "file" },
    body,
  })!;
}

const sentTo = (id: string) => submitMock.mock.calls.find((call) => call[0] === id);

describe("executeFleetBroadcast with @notes", () => {
  beforeEach(() => {
    submitMock.mockReset();
    submitMock.mockResolvedValue(undefined);
    clearDiffNotesOnceWritten.mockReset();
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    setCurrentViewStore({
      getState: () => ({
        worktrees: new Map(
          ["wt-1", "wt-2", "wt-3"].map((id) => [id, { path: `/repo/${id}` }] as const)
        ),
      }),
    } as unknown as WorktreeViewStoreApi);
  });

  it("gives each target its own worktree's notes, and no other's", async () => {
    const one = addNote("wt-1", "For one");
    const two = addNote("wt-2", "For two");
    seedFleet([agent("a", "wt-1"), agent("b", "wt-2"), agent("c", "wt-3")]);

    await executeFleetBroadcast("Fix @notes", ["a", "b", "c"]);

    const a = sentTo("a")!;
    expect(a[1]).toContain('"For one"');
    expect(a[1]).not.toContain("For two");
    const b = sentTo("b")!;
    expect(b[1]).toContain('"For two"');
    expect(b[1]).not.toContain("For one");
    expect(sentTo("c")).toEqual(["c", "Fix [No pending diff notes]"]);

    expect(a[2]).toEqual(expect.any(String));
    expect(a[2]).not.toBe(b[2]);
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledWith("a", a[2], [one]);
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledWith("b", b[2], [two]);
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledTimes(2);
  });

  it("answers for a failed target's notes only by keeping them", async () => {
    const one = addNote("wt-1", "For one");
    const two = addNote("wt-2", "For two");
    seedFleet([agent("a", "wt-1"), agent("b", "wt-2")]);
    submitMock.mockImplementation(async (id) => {
      if (id === "a") throw new Error("EPIPE: terminal a has no live PTY (exited)");
    });

    const result = await executeFleetBroadcast("@notes", ["a", "b"]);

    expect(result.failedIds).toEqual(["a"]);
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledTimes(1);
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledWith("b", sentTo("b")![2], [two]);
    expect(useDiffNotesStore.getState().notes[one.id]).toEqual(one);
  });

  it("hands two agents in one worktree the same notes, each watching its own send", async () => {
    const note = addNote("wt-1", "Shared");
    seedFleet([agent("a", "wt-1"), agent("b", "wt-1")]);

    await executeFleetBroadcast("@notes", ["a", "b"]);

    expect(sentTo("a")![1]).toContain('"Shared"');
    expect(sentTo("b")![1]).toContain('"Shared"');
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledWith("a", sentTo("a")![2], [note]);
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledWith("b", sentTo("b")![2], [note]);
  });

  it("never hands notes to a plain shell in the fleet", async () => {
    const note = addNote("wt-1", "Agents only");
    seedFleet([
      agent("agent", "wt-1"),
      agent("shell", "wt-1", { detectedAgentId: undefined, launchAgentId: undefined }),
    ]);

    await executeFleetBroadcast("@notes", ["agent", "shell"]);

    expect(sentTo("shell")).toEqual(["shell", "[Diff notes aren't available here]"]);
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledTimes(1);
    expect(clearDiffNotesOnceWritten).toHaveBeenCalledWith("agent", sentTo("agent")![2], [note]);
  });

  it("clears nothing for a send cancelled before it went out", async () => {
    addNote("wt-1", "Still pending");
    seedFleet([agent("a", "wt-1")]);
    const controller = new AbortController();
    controller.abort();

    await executeFleetBroadcast("@notes", ["a"], undefined, controller.signal);

    expect(submitMock).not.toHaveBeenCalled();
    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
  });

  it("skips a target whose agent quit while another's context was read", async () => {
    const note = addNote("wt-1", "Agents only");
    seedFleet([agent("a", "wt-1")]);
    (window as unknown as { electron: unknown }).electron = {
      git: {
        getWorkingDiff: vi.fn(async () => {
          seedFleet([agent("a", "wt-1", { detectedAgentId: undefined, launchAgentId: undefined })]);
          return "";
        }),
      },
    };

    const result = await executeFleetBroadcast("@notes @diff", ["a"]);

    expect(submitMock).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
    expect(useDiffNotesStore.getState().notes[note.id]).toEqual(note);
  });

  it("gives a send without notes no token", async () => {
    seedFleet([agent("a", "wt-1")]);
    await executeFleetBroadcast("hello", ["a"]);
    expect(submitMock).toHaveBeenCalledWith("a", "hello");
    expect(clearDiffNotesOnceWritten).not.toHaveBeenCalled();
  });

  it("refuses @notes to an agent on another host, like every context token", () => {
    const remote = crossHostTargetKey("host-1", "t-1");
    expect(findCrossHostContextTargets("Fix @notes", [remote])).toEqual([remote]);
  });
});
