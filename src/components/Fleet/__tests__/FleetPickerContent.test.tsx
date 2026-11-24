// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

import { FleetPickerContent } from "../FleetPickerContent";
import { useFleetPicker } from "@/hooks/useFleetPicker";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFleetPickerSessionStore } from "@/store/fleetPickerSessionStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { _resetForTests as resetEscapeStack, dispatchEscape } from "@/lib/escapeStack";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types";

function makeTerminal(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    worktreeId: "wt-1",
    location: "grid",
    hasPty: true,
    agentState: "idle",
    runtimeStatus: "running",
    ...overrides,
  } as PtyPanelData;
}

function seedTerminals(terminals: PtyPanelData[]): void {
  const panelsById: Record<string, PtyPanelData> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function makeWorktreeSnap(
  id: string,
  name: string,
  overrides: Partial<WorktreeSnapshot> = {}
): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name,
    isCurrent: false,
    ...overrides,
  } as WorktreeSnapshot;
}

function resetStores(): void {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
    previewArmedIds: new Set<string>(),
    broadcastSignal: 0,
  });
  useFleetPickerSessionStore.setState({ activeOwner: null });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
  useFleetSnapshotStore.setState({ snapshot: null });
}

function pushFleet(runs: Array<Partial<FleetRunRow> & { runId: string }>): void {
  act(() =>
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: runs.map((run) => ({ workspaceId: "p1", spawnedAt: 0, cwd: "/repo", ...run })),
        changedAt: 0,
        degraded: false,
        lastSuccessfulAt: null,
      },
    })
  );
}

interface HarnessProps {
  mode: "cold-start" | "add";
  onCommit: (ids: string[]) => void;
  isOpen?: boolean;
  owner?: "cold-start" | "ribbon-add";
  capturePicker?: (picker: ReturnType<typeof useFleetPicker>) => void;
}

function Harness({
  mode,
  onCommit,
  isOpen = true,
  owner = "cold-start",
  capturePicker,
}: HarnessProps): React.ReactElement | null {
  const picker = useFleetPicker({ isOpen, mode, onCommit, owner });
  React.useEffect(() => {
    capturePicker?.(picker);
  });
  if (!picker.acquired) return null;
  return <FleetPickerContent picker={picker} testIdPrefix="fp" autoFocusSearch={false} />;
}

function renderHarness(
  worktrees: WorktreeSnapshot[],
  props: HarnessProps
): ReturnType<typeof render> {
  const store = createWorktreeStore();
  store.getState().applySnapshot(worktrees, { epoch: "test", seq: 1 });
  return render(
    <WorktreeStoreContext.Provider value={store}>
      <Harness {...props} />
    </WorktreeStoreContext.Provider>
  );
}

describe("FleetPickerContent + useFleetPicker", () => {
  beforeEach(() => {
    resetStores();
    seedTerminals([]);
    resetEscapeStack();
    // Stub out the IPC search; we exercise the search effect, but don't need
    // a real backend response here.
    Object.assign(window, {
      electron: {
        terminal: {
          searchSemanticBuffers: vi.fn().mockResolvedValue({ matches: [], complete: true }),
        },
      },
    });
  });

  afterEach(() => {
    resetStores();
    resetEscapeStack();
  });

  describe("cold-start mode", () => {
    it("preselects terminals belonging to the active worktree", async () => {
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
        makeTerminal("t3", { worktreeId: "wt-2" }),
      ]);
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main"), makeWorktreeSnap("wt-2", "feature")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      expect(captured.picker?.selectedIds.has("t1")).toBe(true);
      expect(captured.picker?.selectedIds.has("t2")).toBe(true);
      expect(captured.picker?.selectedIds.has("t3")).toBe(false);
    });

    it("starts with empty selection when no active worktree is set", async () => {
      seedTerminals([makeTerminal("t1")]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      expect(captured.picker?.selectedIds.size).toBe(0);
    });
  });

  describe("add mode", () => {
    it("never preselects active-worktree eligibles", async () => {
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "add",
        onCommit: () => {},
        owner: "ribbon-add",
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      expect(captured.picker?.selectedIds.size).toBe(0);
    });

    it("hides already-armed terminals from the visible list", async () => {
      seedTerminals([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")]);
      // t1 is already armed; the picker in `add` mode should exclude it.
      useFleetArmingStore.getState().armId("t1");
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "add",
        onCommit: () => {},
        owner: "ribbon-add",
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      const eligibleIds = captured.picker?.eligibleTerminals.map((t) => t.id) ?? [];
      expect(eligibleIds).toEqual(["t2", "t3"]);
    });
  });

  describe("selection handlers", () => {
    it("cancels Shift+mousedown on a row and keeps the row's focus (#12926)", async () => {
      seedTerminals([makeTerminal("t1"), makeTerminal("t2")]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      const row = screen.getByTestId("fp-row-t2");
      expect(fireEvent.mouseDown(row, { shiftKey: true, button: 0 })).toBe(false);
      expect(document.activeElement).toBe(row);
      await act(async () => {
        fireEvent.click(row, { shiftKey: true });
      });
      expect(captured.picker?.selectedIds.has("t2")).toBe(true);
      expect(fireEvent.mouseDown(row, { button: 0 })).toBe(true);
    });

    it("Cmd+A selects all visible terminals", async () => {
      seedTerminals([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      const list = screen.getByTestId("fp-list");
      await act(async () => {
        fireEvent.keyDown(list, { key: "a", metaKey: true });
      });
      expect(captured.picker?.selectedIds.size).toBe(3);
    });

    it("Cmd+Shift+I inverts the visible selection", async () => {
      seedTerminals([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      const list = screen.getByTestId("fp-list");
      await act(async () => {
        fireEvent.click(screen.getByTestId("fp-row-t1"));
      });
      await act(async () => {
        fireEvent.keyDown(list, { key: "i", metaKey: true, shiftKey: true });
      });
      const sel = captured.picker?.selectedIds;
      expect(sel?.has("t1")).toBe(false);
      expect(sel?.has("t2")).toBe(true);
      expect(sel?.has("t3")).toBe(true);
    });

    it("Space toggles the focused row", async () => {
      seedTerminals([makeTerminal("t1"), makeTerminal("t2")]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      // Initial focus should clamp to t1.
      const list = screen.getByTestId("fp-list");
      await act(async () => {
        fireEvent.keyDown(list, { key: " " });
      });
      expect(captured.picker?.selectedIds.has("t1")).toBe(true);
    });
  });

  describe("commit", () => {
    it("calls onCommit with confirmed (still-eligible) ids", async () => {
      seedTerminals([makeTerminal("t1"), makeTerminal("t2")]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const onCommit = vi.fn();
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit,
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      await act(async () => {
        fireEvent.click(screen.getByTestId("fp-row-t2"));
      });
      await act(async () => {
        captured.picker?.handleConfirm();
      });
      expect(onCommit).toHaveBeenCalledWith(["t2"]);
    });

    it("does not call onCommit when nothing is selected", async () => {
      seedTerminals([makeTerminal("t1")]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const onCommit = vi.fn();
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit,
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      await act(async () => {
        captured.picker?.handleConfirm();
      });
      expect(onCommit).not.toHaveBeenCalled();
    });
  });

  describe("session guard", () => {
    it("returns acquired=false when another picker holds the session", async () => {
      seedTerminals([makeTerminal("t1")]);
      useFleetPickerSessionStore.setState({ activeOwner: "cold-start" });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "add",
        onCommit: () => {},
        owner: "ribbon-add",
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      expect(captured.picker?.acquired).toBe(false);
    });
  });

  describe("fuzzy search", () => {
    it("filters visible terminals by title", async () => {
      seedTerminals([
        makeTerminal("alpha-runner", { title: "Alpha runner" }),
        makeTerminal("beta-runner", { title: "Beta runner" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "alpha" } });
      });
      await act(async () => {});
      const ids = captured.picker?.visibleTerminals.map((t) => t.id) ?? [];
      expect(ids).toEqual(["alpha-runner"]);
    });

    it("filters by worktree branch", async () => {
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1", title: "shell" }),
        makeTerminal("t2", { worktreeId: "wt-2", title: "shell" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness(
        [
          makeWorktreeSnap("wt-1", "main", { branch: "feature/login" }),
          makeWorktreeSnap("wt-2", "other", { branch: "fix/header" }),
        ],
        {
          mode: "cold-start",
          onCommit: () => {},
          capturePicker: (p) => {
            captured.picker = p;
          },
        }
      );
      await act(async () => {});
      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "feature/login" } });
      });
      await act(async () => {});
      const ids = captured.picker?.visibleTerminals.map((t) => t.id) ?? [];
      expect(ids).toEqual(["t1"]);
    });

    it("filters by worktree path", async () => {
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1", title: "shell" }),
        makeTerminal("t2", { worktreeId: "wt-2", title: "shell" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness(
        [
          makeWorktreeSnap("wt-1", "alpha", { path: "/repos/dashboards" }),
          makeWorktreeSnap("wt-2", "beta", { path: "/repos/auth-service" }),
        ],
        {
          mode: "cold-start",
          onCommit: () => {},
          capturePicker: (p) => {
            captured.picker = p;
          },
        }
      );
      await act(async () => {});
      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "dashboards" } });
      });
      await act(async () => {});
      const ids = captured.picker?.visibleTerminals.map((t) => t.id) ?? [];
      expect(ids).toEqual(["t1"]);
    });

    it("picks up live title changes (OSC update) without remounting the picker", async () => {
      seedTerminals([makeTerminal("t1", { title: "Server" })]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      // Simulate an OSC title update: same panel id, new title.
      seedTerminals([makeTerminal("t1", { title: "Auth API" })]);
      await act(async () => {});
      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "auth" } });
      });
      await act(async () => {});
      const ids = captured.picker?.visibleTerminals.map((t) => t.id) ?? [];
      expect(ids).toEqual(["t1"]);
    });

    it("matches FALLBACK_GROUP terminals (no worktreeId) on title", async () => {
      seedTerminals([
        makeTerminal("loose", { title: "loose runner", worktreeId: undefined as never }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "loose" } });
      });
      await act(async () => {});
      const ids = captured.picker?.visibleTerminals.map((t) => t.id) ?? [];
      expect(ids).toEqual(["loose"]);
    });

    it("does not crash on regex-special characters", async () => {
      seedTerminals([makeTerminal("alpha", { title: "Alpha runner" })]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "feat.*\\(login" } });
      });
      await act(async () => {});
      // No exception; the picker simply returns no fuzzy matches for the
      // unrelated regex-shaped query.
      expect(captured.picker?.visibleTerminals.length).toBe(0);
    });
  });

  describe("output search scope (#17516)", () => {
    let search: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers();
      search = vi.fn().mockResolvedValue({ matches: [], complete: true });
      Object.assign(window, { electron: { terminal: { searchSemanticBuffers: search } } });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function openAndType(mode: "cold-start" | "add", query: string) {
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main"), makeWorktreeSnap("wt-2", "feature")], {
        mode,
        owner: mode === "add" ? "ribbon-add" : "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      await act(async () => {
        fireEvent.change(screen.getByTestId("fp-search"), { target: { value: query } });
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      return captured;
    }

    it("searches only the panes the picker can show, across worktrees", async () => {
      seedTerminals([
        makeTerminal("t3", { worktreeId: "wt-2" }),
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
        makeTerminal("exited", { worktreeId: "wt-2", runtimeStatus: "exited" }),
      ]);
      useFleetArmingStore.getState().armId("t1");
      search.mockResolvedValue({
        matches: [{ terminalId: "t3", line: "deploy finished", matchStart: 0, matchEnd: 6 }],
        complete: true,
      });

      const captured = await openAndType("add", "deploy");

      expect(search.mock.calls).toEqual([["deploy", false, ["t2", "t3"]]]);
      // Matched by output alone: neither the title nor the worktree says "deploy".
      expect(captured.picker?.visibleTerminals.map((t) => t.id)).toEqual(["t3"]);
      expect(captured.picker?.snippetMap.get("t3")?.line).toBe("deploy finished");
    });

    it("searches again when a pane joins under the same query, but not on state churn", async () => {
      seedTerminals([makeTerminal("t1"), makeTerminal("t2")]);
      await openAndType("cold-start", "deploy");
      expect(search).toHaveBeenCalledTimes(1);

      await act(async () => {
        seedTerminals([makeTerminal("t2", { agentState: "working" }), makeTerminal("t1")]);
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(search).toHaveBeenCalledTimes(1);

      await act(async () => {
        seedTerminals([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t0")]);
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(search.mock.calls.at(-1)).toEqual(["deploy", false, ["t0", "t1", "t2"]]);
    });

    it("ignores a reply for a scope that changed, and clears hits when the scope empties", async () => {
      let resolveFirst!: (matches: unknown) => void;
      search.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      );
      seedTerminals([makeTerminal("t1"), makeTerminal("t2")]);
      const captured = await openAndType("cold-start", "deploy");

      await act(async () => {
        seedTerminals([makeTerminal("t1"), makeTerminal("t3")]);
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(search.mock.calls.map((c) => c[2])).toEqual([
        ["t1", "t2"],
        ["t1", "t3"],
      ]);

      await act(async () => {
        resolveFirst({
          matches: [{ terminalId: "t1", line: "deploy old", matchStart: 0, matchEnd: 6 }],
          complete: true,
        });
      });
      expect(captured.picker?.snippetMap.size).toBe(0);

      // A cached hit and a reply still in flight when the last pane leaves.
      let resolveThird!: (matches: unknown) => void;
      search
        .mockResolvedValueOnce({
          matches: [{ terminalId: "t1", line: "deploy new", matchStart: 0, matchEnd: 6 }],
          complete: true,
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveThird = resolve;
            })
        );
      await act(async () => {
        fireEvent.change(screen.getByTestId("fp-search"), { target: { value: "deploys" } });
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(captured.picker?.snippetMap.get("t1")?.line).toBe("deploy new");
      await act(async () => {
        seedTerminals([makeTerminal("t1"), makeTerminal("t4")]);
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(search).toHaveBeenCalledTimes(4);

      await act(async () => {
        seedTerminals([]);
      });
      expect(captured.picker?.snippetMap.size).toBe(0);
      await act(async () => {
        resolveThird({
          matches: [{ terminalId: "t1", line: "deploy late", matchStart: 0, matchEnd: 6 }],
          complete: true,
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(search).toHaveBeenCalledTimes(4);
      expect(captured.picker?.snippetMap.size).toBe(0);
      expect(captured.picker?.visibleTerminals).toEqual([]);
    });

    it("keeps id boundaries and leaves empty ids out of the scope", async () => {
      seedTerminals([makeTerminal(""), makeTerminal("a\x00b"), makeTerminal("t1")]);

      await openAndType("cold-start", "deploy");

      expect(search.mock.calls).toEqual([["deploy", false, ["a\x00b", "t1"]]]);
    });

    it("drops a hit when its pane leaves, so a restart doesn't inherit it", async () => {
      search.mockResolvedValue({
        matches: [{ terminalId: "t1", line: "deploy finished", matchStart: 0, matchEnd: 6 }],
        complete: true,
      });
      seedTerminals([makeTerminal("t1"), makeTerminal("t2")]);
      const captured = await openAndType("cold-start", "deploy");
      expect(captured.picker?.visibleTerminals.map((t) => t.id)).toEqual(["t1"]);

      search.mockResolvedValue({ matches: [], complete: true });
      await act(async () => {
        seedTerminals([makeTerminal("t1", { runtimeStatus: "exited" }), makeTerminal("t2")]);
      });
      await act(async () => {
        seedTerminals([makeTerminal("t1"), makeTerminal("t2")]);
      });
      // Back in scope, but its search hasn't answered yet.
      expect(captured.picker?.snippetMap.has("t1")).toBe(false);
      expect(captured.picker?.visibleTerminals).toEqual([]);

      const callsBeforeRejoin = search.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(search.mock.calls.slice(callsBeforeRejoin)).toEqual([["deploy", false, ["t1", "t2"]]]);
    });

    it("skips the search when no pane is eligible", async () => {
      seedTerminals([makeTerminal("t1")]);
      useFleetArmingStore.getState().armId("t1");

      const captured = await openAndType("add", "deploy");

      expect(search).not.toHaveBeenCalled();
      expect(captured.picker?.visibleTerminals).toEqual([]);
    });

    it("keeps only the picker's panes from an unscoped reply", async () => {
      seedTerminals(Array.from({ length: 257 }, (_, i) => makeTerminal(`t${i}`)));
      search.mockResolvedValue({
        matches: [
          { terminalId: "t5", line: "deploy here", matchStart: 0, matchEnd: 6 },
          { terminalId: "elsewhere", line: "deploy there", matchStart: 0, matchEnd: 6 },
        ],
        complete: true,
      });

      const captured = await openAndType("cold-start", "deploy");

      expect([...(captured.picker?.snippetMap.keys() ?? [])]).toEqual(["t5"]);
    });

    it.each([
      [256, "scoped"],
      [257, "unscoped"],
    ])("sends %i panes %s", async (count, kind) => {
      const panes = Array.from({ length: count }, (_, i) => makeTerminal(`t${i}`));
      seedTerminals(panes);

      await openAndType("cold-start", "deploy");

      const expected = kind === "scoped" ? panes.map((t) => t.id).sort() : undefined;
      expect(search.mock.calls).toEqual([["deploy", false, expected]]);
    });
  });

  describe("escape stack", () => {
    it("first Escape clears the search query when non-empty", async () => {
      seedTerminals([makeTerminal("t1")]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      const captured: { picker?: ReturnType<typeof useFleetPicker> } = {};
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
        capturePicker: (p) => {
          captured.picker = p;
        },
      });
      await act(async () => {});
      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "foo" } });
      });
      await act(async () => {});
      expect(captured.picker?.query).toBe("foo");
      await act(async () => {
        dispatchEscape();
      });
      await act(async () => {});
      expect(captured.picker?.query).toBe("");
    });
  });

  describe("tree navigation", () => {
    it("gives the whole tree one tab stop across headings and rows", async () => {
      // Every group heading used to be its own native tab stop, so Tab walked
      // the headings instead of entering the list once.
      seedTerminals([
        makeTerminal("a", { title: "alpha", worktreeId: "wt-1" }),
        makeTerminal("b", { title: "beta", worktreeId: "wt-2" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      renderHarness([makeWorktreeSnap("wt-1", "main"), makeWorktreeSnap("wt-2", "feature")], {
        mode: "cold-start",
        onCommit: () => {},
      });
      await act(async () => {});

      const nodes = screen.getAllByRole("treeitem");
      expect(nodes.length).toBeGreaterThan(1);
      const tabbable = nodes.filter((n) => n.getAttribute("tabindex") === "0");
      expect(tabbable).toHaveLength(1);
    });

    it("Shift+ArrowDown from a focused row extends the selection", async () => {
      // The unified heading+row navigation must still carry range selection;
      // an earlier version moved focus and silently dropped the extension.
      const onCommit = vi.fn();
      seedTerminals([
        makeTerminal("a", { title: "alpha", worktreeId: "wt-1" }),
        makeTerminal("b", { title: "beta", worktreeId: "wt-1" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      renderHarness([makeWorktreeSnap("wt-1", "main")], { mode: "cold-start", onCommit });
      await act(async () => {});

      const rowA = screen.getByTestId("fp-row-a");
      await act(async () => {
        fireEvent.click(rowA);
      });
      await act(async () => {
        fireEvent.keyDown(rowA, { key: "ArrowDown", shiftKey: true });
      });
      await act(async () => {
        fireEvent.keyDown(screen.getByTestId("fp-row-b"), { key: "Enter" });
      });

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect([...onCommit.mock.calls[0]![0]].sort()).toEqual(["a", "b"]);
    });

    it("a heading focused by Home becomes the tree's tab stop", async () => {
      seedTerminals([
        makeTerminal("a", { title: "alpha", worktreeId: "wt-1" }),
        makeTerminal("b", { title: "beta", worktreeId: "wt-2" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      renderHarness([makeWorktreeSnap("wt-1", "main"), makeWorktreeSnap("wt-2", "feature")], {
        mode: "cold-start",
        onCommit: () => {},
      });
      await act(async () => {});

      const rowB = screen.getByTestId("fp-row-b");
      await act(async () => {
        fireEvent.click(rowB);
      });
      await act(async () => {
        fireEvent.keyDown(rowB, { key: "Home" });
      });

      const tabbable = screen
        .getAllByRole("treeitem")
        .filter((n) => n.getAttribute("tabindex") === "0");
      expect(tabbable).toHaveLength(1);
      expect(tabbable[0]?.hasAttribute("data-group-header")).toBe(true);
    });

    it("distinguishes two same-named terminals in one worktree", async () => {
      seedTerminals([
        makeTerminal("pane-aaaaaa", { title: "Claude", worktreeId: "wt-1" }),
        makeTerminal("pane-bbbbbb", { title: "Claude", worktreeId: "wt-1" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
      });
      await act(async () => {});

      // The rule: identical titles inside one group must not be
      // indistinguishable. Assert the rows differ, not what the suffix says.
      const rows = screen
        .getAllByRole("treeitem")
        .filter((n) => n.hasAttribute("data-terminal-id"));
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).not.toBe(rows[1]?.textContent);
    });
  });

  // Amber and "Waiting" are the fleet's needs-you alone (#16059).
  describe("state badges", () => {
    const badgeFor = (id: string) =>
      screen
        .getAllByRole("treeitem")
        .find((row) => row.getAttribute("data-terminal-id") === id)
        ?.querySelector<HTMLElement>('[data-state="waiting"]') ?? null;

    it("takes a wait's words and hue from the fleet band", async () => {
      seedTerminals([
        makeTerminal("ask", { agentState: "waiting" }),
        makeTerminal("prompt", { agentState: "waiting" }),
        makeTerminal("unknown", { agentState: "waiting" }),
      ]);
      const ask = { kind: "asked", quote: "Ship it?", readAt: 0, seen: false } as const;
      pushFleet([
        { runId: "ask", agentState: "waiting", waitingReason: "question", canopy: ask },
        { runId: "prompt", agentState: "waiting", waitingReason: "prompt" },
      ]);
      renderHarness([makeWorktreeSnap("wt-1", "main")], { mode: "add", onCommit: () => {} });
      await act(async () => {});

      expect(badgeFor("ask")?.textContent).toBe("Waiting");
      expect(badgeFor("ask")?.className).toContain("text-state-waiting");
      expect(badgeFor("prompt")?.textContent).toBe("Idle");
      expect(badgeFor("prompt")?.className).not.toContain("text-state-waiting");
      expect(badgeFor("unknown")?.textContent).toBe("Last seen waiting");
      expect(badgeFor("unknown")?.className).not.toContain("text-state-waiting");

      // The band moves with no change to the pane, and the badge follows it.
      pushFleet([
        {
          runId: "ask",
          agentState: "waiting",
          waitingReason: "question",
          canopy: { ...ask, seen: true },
        },
      ]);
      expect(badgeFor("ask")?.textContent).toBe("Idle");
      expect(badgeFor("ask")?.className).not.toContain("text-state-waiting");
    });

    // The band is polled and the pane's state is pushed: an ask whose pane has
    // since stopped on an error must not keep the hue while the fleet catches up.
    it("drops a stale ask once the pane itself shows an error wait", async () => {
      seedTerminals([makeTerminal("ask", { agentState: "waiting", waitingReason: "question" })]);
      const ask = { kind: "asked", quote: "Ship it?", readAt: 0, seen: false } as const;
      pushFleet([{ runId: "ask", agentState: "waiting", waitingReason: "question", canopy: ask }]);
      renderHarness([makeWorktreeSnap("wt-1", "main")], { mode: "add", onCommit: () => {} });
      await act(async () => {});
      expect(badgeFor("ask")?.className).toContain("text-state-waiting");

      act(() =>
        seedTerminals([makeTerminal("ask", { agentState: "waiting", waitingReason: "error" })])
      );
      expect(badgeFor("ask")?.className).not.toContain("text-state-waiting");
      expect(badgeFor("ask")?.textContent).toBe("Last seen waiting");
    });
  });

  describe("empty state", () => {
    it("names the next action when there are no eligibles", async () => {
      seedTerminals([]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      renderHarness([], { mode: "cold-start", onCommit: () => {} });
      await act(async () => {});
      // Empty states name the next action, not the absence.
      expect(screen.getByText("Open a terminal in the grid to arm it")).toBeTruthy();
    });

    it("renders 'No terminals match' when the search filters out all eligibles", async () => {
      seedTerminals([
        makeTerminal("t1", { title: "alpha" }),
        makeTerminal("t2", { title: "beta" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
      });
      await act(async () => {});
      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "zzz-no-match" } });
      });
      // The verdict waits for the debounced output search to answer.
      expect(await screen.findByText("No terminals match")).toBeTruthy();
      expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
    });

    it("offers a recovery action from the filtered-empty state", async () => {
      seedTerminals([makeTerminal("t1", { title: "alpha" })]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
      });
      await act(async () => {});
      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "zzz-no-match" } });
      });
      const clearButton = await screen.findByTestId("fp-clear-search");

      await act(async () => {
        fireEvent.click(clearButton);
      });
      await act(async () => {});

      expect(search.value).toBe("");
      expect(screen.queryAllByRole("treeitem").length).toBeGreaterThan(0);
    });
  });

  describe("output search completeness (#17517)", () => {
    type Match = { terminalId: string; line: string; matchStart: number; matchEnd: number };
    type SearchResult = { matches: Match[]; complete: boolean };
    // An older host answers with the bare match array.
    type SearchFn = (
      q: string,
      isRegex: boolean,
      terminalIds?: string[]
    ) => Promise<SearchResult | Match[]>;
    let search: ReturnType<typeof vi.fn<SearchFn>>;

    const hit = (terminalId: string): Match => ({
      terminalId,
      line: "omega in output",
      matchStart: 0,
      matchEnd: 5,
    });

    function deferred<T>(): {
      promise: Promise<T>;
      resolve: (v: T) => void;
      reject: (e: Error) => void;
    } {
      let resolve: (v: T) => void = () => {};
      let reject: (e: Error) => void = () => {};
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    beforeEach(() => {
      vi.useFakeTimers();
      search = vi.fn<SearchFn>();
      Object.assign(window, { electron: { terminal: { searchSemanticBuffers: search } } });
      seedTerminals([
        makeTerminal("t1", { title: "alpha" }),
        makeTerminal("t2", { title: "beta" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function open(): Promise<void> {
      renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
      });
      await act(async () => {});
    }

    async function advance(ms: number): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    async function type(value: string): Promise<void> {
      await act(async () => {
        fireEvent.change(screen.getByTestId("fp-search"), { target: { value } });
      });
    }

    // Types, lets the debounce fire, and waits out the empty state's crossfade.
    async function typeAndSettle(value: string): Promise<void> {
      await type(value);
      await advance(300);
      await advance(300);
    }

    async function retry(): Promise<void> {
      await act(async () => {
        fireEvent.click(screen.getByTestId("fp-retry-output-search"));
      });
    }

    const rowCount = () => screen.queryAllByRole("treeitem").length;
    // Visible copy only: the live region announces the same words.
    const incompleteShown = () =>
      screen.queryAllByText("Recent output search is incomplete", {
        selector: "p, span:not([role])",
      }).length;
    const liveStatus = () =>
      document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "";

    it("keeps title matches visible and offers Retry when some output went unsearched", async () => {
      search.mockResolvedValueOnce({ matches: [], complete: false });
      await open();
      await typeAndSettle("alpha");

      expect(rowCount()).toBe(1);
      expect(screen.getByTestId("fp-output-search-incomplete").textContent).toContain(
        "Recent output search is incomplete"
      );
      expect(liveStatus()).toBe("1 of 2 terminals match. Recent output search is incomplete");

      search.mockResolvedValueOnce({ matches: [hit("t2")], complete: true });
      await retry();

      // Retry skips the debounce and searches the query on screen.
      expect(search).toHaveBeenCalledTimes(2);
      expect(search).toHaveBeenLastCalledWith("alpha", false, ["t1", "t2"]);
      expect(rowCount()).toBe(2);
      expect(screen.queryByTestId("fp-output-search-incomplete")).toBeNull();
      expect(liveStatus()).toBe("2 of 2 terminals match");
    });

    it("never claims 'No terminals match' while output is unanswered or unsearched", async () => {
      const first = deferred<SearchResult>();
      search.mockReturnValueOnce(first.promise);
      await open();
      await type("omega");
      await advance(300);

      // Waiting on the output search: no verdict yet.
      expect(search).toHaveBeenCalledWith("omega", false, ["t1", "t2"]);
      expect(screen.queryByText("No terminals match")).toBeNull();
      expect(screen.queryByText("Searching recent output…")).toBeNull();
      await advance(150);
      expect(screen.getByText("Searching recent output…", { selector: "p" })).toBeTruthy();
      expect(liveStatus()).toBe("Searching recent output…");

      // The request itself failing is as unsearched as a shard missing.
      await act(async () => {
        first.reject(new Error("ipc down"));
      });
      await advance(300);
      expect(screen.queryByText("No terminals match")).toBeNull();
      expect(incompleteShown()).toBe(1);
      expect(rowCount()).toBe(0);

      search.mockResolvedValueOnce({ matches: [], complete: false });
      await retry();
      await advance(300);
      expect(screen.queryByText("No terminals match")).toBeNull();
      expect(incompleteShown()).toBe(1);

      search.mockResolvedValueOnce({ matches: [], complete: true });
      await retry();
      await advance(300);
      expect(screen.getByText("No terminals match")).toBeTruthy();
      expect(incompleteShown()).toBe(0);
    });

    it("keeps an output-only hit when its Retry fails", async () => {
      search.mockResolvedValueOnce({ matches: [hit("t2")], complete: false });
      await open();
      await typeAndSettle("omega");
      expect(rowCount()).toBe(1);
      expect(screen.getByTestId("fp-output-search-incomplete")).toBeTruthy();

      search.mockRejectedValueOnce(new Error("ipc down"));
      await retry();
      await advance(0);

      expect(rowCount()).toBe(1);
      expect(screen.getByTestId("fp-output-search-incomplete")).toBeTruthy();
    });

    it("holds the incomplete state across a new query until an answer covers every shard", async () => {
      search.mockResolvedValueOnce({ matches: [], complete: false });
      await open();
      await typeAndSettle("zzz");
      expect(incompleteShown()).toBe(1);

      const next = deferred<SearchResult>();
      search.mockReturnValueOnce(next.promise);
      await type("zzzz");
      await advance(300);
      // The new query's search is out and unanswered; the outage still stands.
      expect(search).toHaveBeenLastCalledWith("zzzz", false, ["t1", "t2"]);
      expect(incompleteShown()).toBe(1);
      expect(screen.queryByText("No terminals match")).toBeNull();

      await act(async () => {
        next.resolve({ matches: [], complete: true });
      });
      await advance(300);
      expect(screen.getByText("No terminals match")).toBeTruthy();
      expect(incompleteShown()).toBe(0);
    });

    it("sends one search when Retry beats the debounce", async () => {
      search.mockResolvedValueOnce({ matches: [], complete: false });
      await open();
      await typeAndSettle("zzz");

      search.mockResolvedValue({ matches: [], complete: false });
      await type("yyy");
      await advance(100);
      await retry();
      const callsFor = (q: string) => search.mock.calls.filter(([query]) => query === q).length;
      // Retry searched right away, and the superseded debounce sends nothing.
      expect(callsFor("yyy")).toBe(1);
      await advance(400);
      expect(callsFor("yyy")).toBe(1);
    });

    it("keeps the newest of two overlapping retries", async () => {
      search.mockResolvedValueOnce({ matches: [], complete: false });
      await open();
      await typeAndSettle("omega");

      const older = deferred<SearchResult>();
      const newer = deferred<SearchResult>();
      search.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      await retry();
      await retry();

      await act(async () => {
        newer.resolve({ matches: [hit("t2")], complete: true });
      });
      await act(async () => {
        older.resolve({ matches: [], complete: false });
      });
      await advance(300);

      expect(rowCount()).toBe(1);
      expect(incompleteShown()).toBe(0);
    });

    it("ignores an incomplete answer that arrives after a newer query was answered", async () => {
      const stale = deferred<SearchResult>();
      search.mockReturnValueOnce(stale.promise);
      search.mockResolvedValueOnce({ matches: [hit("t2")], complete: true });
      await open();

      await typeAndSettle("zzz");
      await typeAndSettle("omega");
      expect(rowCount()).toBe(1);

      await act(async () => {
        stale.resolve({ matches: [], complete: false });
      });
      await advance(300);

      expect(rowCount()).toBe(1);
      expect(incompleteShown()).toBe(0);
    });

    it("forgets an incomplete search once the query is cleared", async () => {
      search.mockResolvedValueOnce({ matches: [], complete: false });
      await open();
      await typeAndSettle("alpha");
      expect(screen.getByTestId("fp-output-search-incomplete")).toBeTruthy();

      await typeAndSettle("");
      expect(screen.queryByTestId("fp-output-search-incomplete")).toBeNull();

      // A fresh query starts from a clean slate: waiting, not the old outage.
      search.mockReturnValueOnce(new Promise<SearchResult>(() => {}));
      await typeAndSettle("zzz");
      expect(incompleteShown()).toBe(0);
      expect(screen.queryByText("No terminals match")).toBeNull();
    });

    it("hands focus to the search field when a focused Retry goes away", async () => {
      search.mockResolvedValueOnce({ matches: [], complete: false });
      await open();
      await typeAndSettle("alpha");

      const button = screen.getByTestId("fp-retry-output-search");
      await act(async () => {
        button.focus();
      });
      expect(document.activeElement).toBe(button);

      search.mockResolvedValueOnce({ matches: [], complete: true });
      await retry();
      await advance(0);

      expect(screen.queryByTestId("fp-retry-output-search")).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId("fp-search"));
    });

    it("hands focus to the search field when the list empties under a focused Retry", async () => {
      search.mockResolvedValueOnce({ matches: [], complete: false });
      await open();
      await typeAndSettle("omega");

      const button = screen.getByTestId("fp-retry-output-search");
      await act(async () => {
        button.focus();
      });
      await act(async () => {
        seedTerminals([]);
      });
      await advance(300);

      expect(screen.getByText("Open a terminal in the grid to arm it")).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByTestId("fp-search"));
    });

    it("leaves focus alone when Retry goes away without holding it", async () => {
      search.mockResolvedValueOnce({ matches: [], complete: false });
      await open();
      await typeAndSettle("alpha");
      // Nothing holds focus, so only the held-focus check keeps the handoff out.
      expect(document.activeElement).toBe(document.body);

      search.mockResolvedValueOnce({ matches: [], complete: true });
      await retry();
      await advance(0);

      expect(screen.queryByTestId("fp-retry-output-search")).toBeNull();
      expect(document.activeElement).toBe(document.body);
    });

    it("reads a bare match array from an older host as a complete answer", async () => {
      search.mockResolvedValueOnce([hit("t2")]);
      await open();
      await typeAndSettle("omega");

      expect(rowCount()).toBe(1);
      expect(incompleteShown()).toBe(0);
    });
  });

  describe("keyboard entry from the search field", () => {
    it("ArrowDown in the search input lands on the first group heading", async () => {
      // The hand-off enters at the same node the tree container's own ArrowDown
      // does. Skipping straight to the first row would strand the heading above
      // the only keyboard route into the list.
      seedTerminals([
        makeTerminal("a", { title: "alpha", worktreeId: "wt-1" }),
        makeTerminal("b", { title: "beta", worktreeId: "wt-2" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      renderHarness([makeWorktreeSnap("wt-1", "main"), makeWorktreeSnap("wt-2", "feature")], {
        mode: "cold-start",
        onCommit: () => {},
      });
      await act(async () => {});

      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      search.focus();
      await act(async () => {
        fireEvent.keyDown(search, { key: "ArrowDown" });
      });
      await act(async () => {});

      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute("role")).toBe("treeitem");
      expect(active?.getAttribute("data-group-header")).toBe("wt-1");
    });

    it("Enter on the filtered-empty recovery button clears instead of committing", async () => {
      // That button lives inside the tree's key-handler container. Before the
      // guard, its Enter was swallowed and turned into a commit — so the user's
      // attempt to recover from an empty filter armed the very selection the
      // filter was hiding.
      const onCommit = vi.fn();
      seedTerminals([makeTerminal("t1", { title: "alpha", worktreeId: "wt-1" })]);
      renderHarness([makeWorktreeSnap("wt-1", "main")], { mode: "cold-start", onCommit });
      await act(async () => {});

      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "zzz-no-match" } });
      });

      const clear = await screen.findByTestId("fp-clear-search");
      await act(async () => {
        fireEvent.keyDown(clear, { key: "Enter" });
      });
      await act(async () => {});

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("Enter in the search input commits the selection", async () => {
      const onCommit = vi.fn();
      seedTerminals([makeTerminal("t1", { title: "alpha", worktreeId: "wt-1" })]);
      renderHarness([makeWorktreeSnap("wt-1", "main")], { mode: "cold-start", onCommit });
      await act(async () => {});

      const search = screen.getByTestId("fp-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.keyDown(search, { key: "Enter" });
      });
      await act(async () => {});

      expect(onCommit).toHaveBeenCalledWith(["t1"]);
    });
  });
});
