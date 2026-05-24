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
import { _resetForTests as resetEscapeStack, dispatchEscape } from "@/lib/escapeStack";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { TerminalInstance, WorktreeSnapshot } from "@shared/types";

function makeTerminal(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
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
  } as TerminalInstance;
}

function seedTerminals(terminals: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
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
          searchSemanticBuffers: vi.fn().mockResolvedValue([]),
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
    it("toggles a row on click", async () => {
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
      const row = screen.getByTestId("fp-row-t1");
      await act(async () => {
        fireEvent.click(row);
      });
      expect(captured.picker?.selectedIds.has("t1")).toBe(true);
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

    it("releases the session when isOpen flips false", async () => {
      seedTerminals([makeTerminal("t1")]);
      const { rerender } = renderHarness([makeWorktreeSnap("wt-1", "main")], {
        mode: "cold-start",
        onCommit: () => {},
      });
      await act(async () => {});
      expect(useFleetPickerSessionStore.getState().activeOwner).toBe("cold-start");
      rerender(
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <Harness mode="cold-start" onCommit={() => {}} isOpen={false} />
        </WorktreeStoreContext.Provider>
      );
      await act(async () => {});
      expect(useFleetPickerSessionStore.getState().activeOwner).toBeNull();
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

  describe("empty state", () => {
    it("renders 'No terminals available' when there are no eligibles", async () => {
      seedTerminals([]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      renderHarness([], { mode: "cold-start", onCommit: () => {} });
      await act(async () => {});
      expect(screen.getByText("No terminals available")).toBeTruthy();
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
      await act(async () => {});
      expect(screen.getByText("No terminals match")).toBeTruthy();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });
  });
});
