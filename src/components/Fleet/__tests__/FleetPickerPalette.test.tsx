// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, screen, act, within } from "@testing-library/react";

vi.mock("@/components/ui/ScrollShadow", () => ({
  ScrollShadow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Spread the real module rather than hand-listing exports: the palette pulls in
// more of animationUtils than this test cares about, and a factory that misses a
// single constant fails every test in the file at render time (e.g. the commit-mode
// thumb's duration). Only the timing values that would make the palette animate are
// overridden.
vi.mock("@/lib/animationUtils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/animationUtils")>()),
  UI_ENTER_DURATION: 0,
  UI_EXIT_DURATION: 0,
  UI_ENTER_EASING: "linear",
  UI_EXIT_EASING: "linear",
  UI_PALETTE_ENTER_DURATION: 0,
  UI_PALETTE_EXIT_DURATION: 0,
  getUiTransitionDuration: () => 0,
  getUiPaletteTransitionDuration: () => 0,
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

import { FleetPickerPalette } from "../FleetPickerPalette";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFleetPickerSessionStore } from "@/store/fleetPickerSessionStore";
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

function makeWorktreeSnap(id: string, name: string): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name,
    isCurrent: false,
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

function renderPalette(
  worktrees: WorktreeSnapshot[],
  isOpen = true,
  onClose: () => void = () => {}
) {
  const store = createWorktreeStore();
  store.getState().applySnapshot(worktrees, { epoch: "test", seq: 1 });
  return render(
    <WorktreeStoreContext.Provider value={store}>
      <FleetPickerPalette isOpen={isOpen} onClose={onClose} />
    </WorktreeStoreContext.Provider>
  );
}

describe("FleetPickerPalette", () => {
  beforeEach(() => {
    resetStores();
    seedTerminals([]);
    resetEscapeStack();
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

  it("renders the palette title and content when open", async () => {
    seedTerminals([makeTerminal("t1")]);
    renderPalette([makeWorktreeSnap("wt-1", "main")]);
    await act(async () => {});
    // The dialog title renders as the h2 heading.
    expect(screen.getByRole("heading", { name: "Select terminals to arm" })).toBeTruthy();
    expect(screen.getByTestId("fleet-picker-cold-start-root")).toBeTruthy();
  });

  it("preselects active-worktree eligibles in cold-start mode", async () => {
    seedTerminals([
      makeTerminal("t1", { worktreeId: "wt-1" }),
      makeTerminal("t2", { worktreeId: "wt-1" }),
      makeTerminal("t3", { worktreeId: "wt-2" }),
    ]);
    renderPalette([makeWorktreeSnap("wt-1", "main"), makeWorktreeSnap("wt-2", "feature")]);
    await act(async () => {});
    const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
    expect(confirm.textContent).toContain("Arm 2 selected");
    expect(confirm.disabled).toBe(false);
  });

  it("commit replaces the armed set via armIds", async () => {
    seedTerminals([
      makeTerminal("t1", { worktreeId: "wt-1" }),
      makeTerminal("t2", { worktreeId: "wt-1" }),
    ]);
    // Pre-existing armed terminal that is NOT in active worktree — replace
    // semantics should drop it.
    useFleetArmingStore.getState().armId("preexisting");
    seedTerminals([
      makeTerminal("preexisting", { worktreeId: "wt-2" }),
      makeTerminal("t1", { worktreeId: "wt-1" }),
      makeTerminal("t2", { worktreeId: "wt-1" }),
    ]);
    const onClose = vi.fn();
    renderPalette([makeWorktreeSnap("wt-1", "main")], true, onClose);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("fleet-picker-cold-start-confirm"));
    });
    const s = useFleetArmingStore.getState();
    // t1, t2 replaced "preexisting".
    expect(s.armOrder).toEqual(["t1", "t2"]);
    expect(s.armedIds.has("preexisting")).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it("Cancel button calls onClose without arming", async () => {
    seedTerminals([makeTerminal("t1")]);
    const onClose = vi.fn();
    renderPalette([makeWorktreeSnap("wt-1", "main")], true, onClose);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });
    expect(onClose).toHaveBeenCalled();
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("Esc closes the palette via the escape stack", async () => {
    seedTerminals([makeTerminal("t1")]);
    const onClose = vi.fn();
    renderPalette([makeWorktreeSnap("wt-1", "main")], true, onClose);
    await act(async () => {});
    await act(async () => {
      dispatchEscape();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("Esc with non-empty search clears search before closing", async () => {
    seedTerminals([makeTerminal("alpha"), makeTerminal("beta")]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    const onClose = vi.fn();
    renderPalette([makeWorktreeSnap("wt-1", "main")], true, onClose);
    await act(async () => {});
    const search = screen.getByTestId("fleet-picker-cold-start-search") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(search, { target: { value: "alpha" } });
    });
    await act(async () => {});
    // 1st Esc clears the query — palette stays open.
    await act(async () => {
      dispatchEscape();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId("fleet-picker-cold-start-search") as HTMLInputElement).value).toBe(
      ""
    );
    // 2nd Esc closes the palette.
    await act(async () => {
      dispatchEscape();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("disables confirm when no terminals are selected", async () => {
    seedTerminals([makeTerminal("t1")]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    renderPalette([makeWorktreeSnap("wt-1", "main")]);
    await act(async () => {});
    const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain("Arm selected");
  });

  it("renders blocked state when another picker holds the session", async () => {
    seedTerminals([makeTerminal("t1")]);
    useFleetPickerSessionStore.setState({ activeOwner: "ribbon-add" });
    renderPalette([makeWorktreeSnap("wt-1", "main")]);
    await act(async () => {});
    expect(screen.getByTestId("fleet-picker-cold-start-blocked")).toBeTruthy();
    expect(screen.queryByTestId("fleet-picker-cold-start-root")).toBeNull();
  });

  it("releases the picker session when the palette closes", async () => {
    seedTerminals([makeTerminal("t1")]);
    const { rerender } = renderPalette([makeWorktreeSnap("wt-1", "main")], true);
    await act(async () => {});
    expect(useFleetPickerSessionStore.getState().activeOwner).toBe("cold-start");
    rerender(
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <FleetPickerPalette isOpen={false} onClose={() => {}} />
      </WorktreeStoreContext.Provider>
    );
    await act(async () => {});
    expect(useFleetPickerSessionStore.getState().activeOwner).toBeNull();
  });

  it("excludes ineligible terminals (e.g. trash, hasPty=false) from preselection", async () => {
    // Cold-start preselects active-worktree eligibles. A trashed or
    // pty-less terminal in the active worktree must NOT count even though
    // it shares the worktreeId — otherwise the user would unwittingly
    // arm an ineligible row that gets dropped at commit time.
    seedTerminals([
      makeTerminal("t1", { worktreeId: "wt-1" }),
      makeTerminal("t2", { worktreeId: "wt-1", location: "trash" }),
      makeTerminal("t3", { worktreeId: "wt-1", hasPty: false }),
    ]);
    renderPalette([makeWorktreeSnap("wt-1", "main")]);
    await act(async () => {});
    const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
    expect(confirm.textContent).toContain("Arm 1 selected");
  });

  it("renders empty state when there are no eligible terminals at all", async () => {
    seedTerminals([
      makeTerminal("t-trash", { location: "trash" }),
      makeTerminal("t-nopty", { hasPty: false }),
    ]);
    renderPalette([makeWorktreeSnap("wt-1", "main")]);
    await act(async () => {});
    expect(screen.getByText("Open a terminal in the grid to arm it")).toBeTruthy();
    const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  describe("Select all / Select agents helper buttons", () => {
    it("renders 'Select all' and selects all visible terminals on click", async () => {
      // No active worktree → no preselection, so the Arm button starts at 0
      // and clicking "Select all" must populate the selection.
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      seedTerminals([makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      const selectAll = screen.getByTestId(
        "fleet-picker-cold-start-select-all"
      ) as HTMLButtonElement;
      expect(selectAll.textContent).toContain("Select all");
      expect(selectAll.disabled).toBe(false);

      await act(async () => {
        fireEvent.click(selectAll);
      });

      const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
      expect(confirm.textContent).toContain("Arm 3 selected");
    });

    it("label becomes 'Select all visible' when a search query narrows the list", async () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      seedTerminals([makeTerminal("alpha"), makeTerminal("beta"), makeTerminal("gamma")]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      const search = screen.getByTestId("fleet-picker-cold-start-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "alp" } });
      });
      await act(async () => {});

      const selectAll = screen.getByTestId(
        "fleet-picker-cold-start-select-all"
      ) as HTMLButtonElement;
      expect(selectAll.textContent).toContain("Select all visible");

      await act(async () => {
        fireEvent.click(selectAll);
      });

      const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
      // Only "alpha" matches the query, so exactly one terminal is armed.
      expect(confirm.textContent).toContain("Arm 1 selected");
    });

    it("keeps each bulk action's label fixed while its selection state changes", async () => {
      // The rule, not the string: one control means one action. This used to be
      // a single button cycling through four labels, which reversed its own
      // meaning under the pointer and reflowed its neighbour on every click.
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      seedTerminals([makeTerminal("t1"), makeTerminal("t2")]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      const selectAll = screen.getByTestId(
        "fleet-picker-cold-start-select-all"
      ) as HTMLButtonElement;
      const clear = screen.getByTestId(
        "fleet-picker-cold-start-clear-selection"
      ) as HTMLButtonElement;
      const labelBefore = selectAll.textContent;

      await act(async () => {
        fireEvent.click(selectAll);
      });
      expect(selectAll.textContent).toBe(labelBefore);

      await act(async () => {
        fireEvent.click(clear);
      });
      expect(selectAll.textContent).toBe(labelBefore);

      const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
    });

    it("'Clear' empties the whole selection, not just the filtered subset", async () => {
      // "Clear" that leaves things selected is a trap — the scoped removal the
      // old toggle did was invisible, and the commit still armed the leftovers.
      seedTerminals([
        makeTerminal("alpha", { worktreeId: "wt-1" }),
        makeTerminal("beta", { worktreeId: "wt-1" }),
        makeTerminal("gamma", { worktreeId: "wt-1" }),
      ]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      const search = screen.getByTestId("fleet-picker-cold-start-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "alp" } });
      });
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-clear-selection"));
      });

      await act(async () => {
        fireEvent.change(search, { target: { value: "" } });
      });
      await act(async () => {});

      const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
    });

    it("'Select agents' adds only working/waiting/directing terminals additively", async () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      seedTerminals([
        makeTerminal("t-working", { agentState: "working" }),
        makeTerminal("t-waiting", { agentState: "waiting" }),
        makeTerminal("t-directing", { agentState: "directing" }),
        makeTerminal("t-idle", { agentState: "idle" }),
        makeTerminal("t-completed", { agentState: "completed" }),
        makeTerminal("t-exited", { agentState: "exited" }),
      ]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      const selectAgents = screen.getByTestId(
        "fleet-picker-cold-start-select-agents"
      ) as HTMLButtonElement;
      expect(selectAgents.disabled).toBe(false);

      await act(async () => {
        fireEvent.click(selectAgents);
      });

      const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
      // Exactly 3: working + waiting + directing. idle/completed/exited skipped.
      expect(confirm.textContent).toContain("Arm 3 selected");
    });

    it("'Select agents' is disabled when no visible terminals are in an active agent state", async () => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      seedTerminals([
        makeTerminal("t1", { agentState: "idle" }),
        makeTerminal("t2", { agentState: "completed" }),
      ]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      const selectAgents = screen.getByTestId(
        "fleet-picker-cold-start-select-agents"
      ) as HTMLButtonElement;
      expect(selectAgents.disabled).toBe(true);
    });

    it("'Select agents' is truly additive — adds the agent without dropping a manually-picked non-agent", async () => {
      // No preselection (null active worktree). Filter to the idle terminal,
      // select it via "Select all visible", clear the query, then click
      // "Select agents" — the agent must be added on top of the idle pick.
      useWorktreeSelectionStore.setState({ activeWorktreeId: null });
      seedTerminals([
        makeTerminal("alpha-idle", { agentState: "idle" }),
        makeTerminal("beta-working", { agentState: "working" }),
      ]);
      const onClose = vi.fn();
      renderPalette([makeWorktreeSnap("wt-1", "main")], true, onClose);
      await act(async () => {});

      const search = screen.getByTestId("fleet-picker-cold-start-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "alpha" } });
      });
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-select-all"));
      });

      await act(async () => {
        fireEvent.change(search, { target: { value: "" } });
      });
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-select-agents"));
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-confirm"));
      });

      const s = useFleetArmingStore.getState();
      expect(s.armOrder.sort()).toEqual(["alpha-idle", "beta-working"]);
    });

    it("'Select all visible' keeps picks the filter is hiding", async () => {
      // The invariant: a bulk action scoped to what is visible must only ever
      // ADD. This test previously asserted the opposite — that the wt-1 pick
      // was dropped — which encoded a silent data loss: the user filters,
      // bulk-selects, commits, and broadcasts to a different set than the one
      // they assembled. Arming is the one thing on this surface that must not
      // surprise anybody.
      seedTerminals([
        makeTerminal("a-wt1", { worktreeId: "wt-1" }),
        makeTerminal("b-wt2", { worktreeId: "wt-2" }),
      ]);
      const onClose = vi.fn();
      renderPalette(
        [makeWorktreeSnap("wt-1", "main"), makeWorktreeSnap("wt-2", "feature")],
        true,
        onClose
      );
      await act(async () => {});

      const search = screen.getByTestId("fleet-picker-cold-start-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "b-wt2" } });
      });
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-select-all"));
      });

      await act(async () => {
        fireEvent.change(search, { target: { value: "" } });
      });
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-confirm"));
      });

      expect(useFleetArmingStore.getState().armOrder.sort()).toEqual(["a-wt1", "b-wt2"]);
    });

    it("'Clear' drops drifted ids too — they do not come back when the terminal does", async () => {
      // Cold-start preselects two wt-1 terminals. Simulate drift by removing
      // one from the panel store while the picker is open, then Clear. When the
      // drifted terminal re-enters the panel store its id must not still be in
      // selectedIds, or a "cleared" picker silently re-arms it.
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      let confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
      expect(confirm.textContent).toContain("Arm 2 selected");

      // Drift t2 out of the panel store. visibleIds shrinks to [t1] and
      // allVisibleSelected stays true (t1 is selected).
      seedTerminals([makeTerminal("t1", { worktreeId: "wt-1" })]);
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-clear-selection"));
      });

      // Re-introduce t2 — confirm should still be empty if Clear really
      // cleared everything.
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      await act(async () => {});

      confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      expect(confirm.textContent).toContain("Arm selected");
    });

    it("footer holds only commit controls — bulk-selection helpers sit above the list", async () => {
      seedTerminals([makeTerminal("t1", { worktreeId: "wt-1" })]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      // The commit footer is the row that hosts the Replace/Append toggle.
      const footer = screen.getByTestId("fleet-picker-cold-start-commit-mode")
        .parentElement as HTMLElement;
      const inFooter = within(footer);
      expect(inFooter.getByTestId("fleet-picker-cold-start-confirm")).toBeTruthy();
      expect(inFooter.getByText("Cancel")).toBeTruthy();
      // The decluttered footer must not carry the bulk-selection helpers or
      // the dropped status text — that's the whole point of #8802.
      expect(inFooter.queryByTestId("fleet-picker-cold-start-select-all")).toBeNull();
      expect(inFooter.queryByTestId("fleet-picker-cold-start-select-agents")).toBeNull();
      expect(inFooter.queryByTestId("fleet-picker-cold-start-status")).toBeNull();

      // The helpers still exist — relocated into the list's search section.
      expect(screen.getByTestId("fleet-picker-cold-start-select-all")).toBeTruthy();
      expect(screen.getByTestId("fleet-picker-cold-start-select-agents")).toBeTruthy();
    });

    it("surfaces the drift count as a live region when a selected terminal drifts out", async () => {
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      // Both terminals start pre-selected; drift t2 out of the panel store.
      seedTerminals([makeTerminal("t1", { worktreeId: "wt-1" })]);
      await act(async () => {});

      const drift = screen.getByText("1 became ineligible");
      expect(drift.getAttribute("role")).toBe("status");
    });
  });

  describe("Replace / Append commit-mode toggle", () => {
    it("renders the toggle defaulting to Replace", async () => {
      seedTerminals([makeTerminal("t1", { worktreeId: "wt-1" })]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      const replace = screen.getByTestId("fleet-picker-cold-start-commit-mode-replace");
      const append = screen.getByTestId("fleet-picker-cold-start-commit-mode-append");
      expect(replace.getAttribute("aria-checked")).toBe("true");
      expect(append.getAttribute("aria-checked")).toBe("false");
      const confirm = screen.getByTestId("fleet-picker-cold-start-confirm");
      expect(confirm.textContent).toContain("Arm 1 selected");
    });

    it("keeps a single sliding thumb, owned by the checked mode", async () => {
      seedTerminals([makeTerminal("t1", { worktreeId: "wt-1" })]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      const group = screen.getByTestId("fleet-picker-cold-start-commit-mode");
      const thumbOwner = () => {
        const thumbs = group.querySelectorAll("[data-slot='segmented-thumb']");
        expect(thumbs.length).toBe(1);
        return thumbs[0]?.closest("[role='radio']");
      };

      expect(thumbOwner()).toBe(screen.getByTestId("fleet-picker-cold-start-commit-mode-replace"));

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-commit-mode-append"));
      });

      expect(thumbOwner()).toBe(screen.getByTestId("fleet-picker-cold-start-commit-mode-append"));
    });

    it("switching to Append updates aria-checked and confirm label", async () => {
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-commit-mode-append"));
      });

      const replace = screen.getByTestId("fleet-picker-cold-start-commit-mode-replace");
      const append = screen.getByTestId("fleet-picker-cold-start-commit-mode-append");
      expect(replace.getAttribute("aria-checked")).toBe("false");
      expect(append.getAttribute("aria-checked")).toBe("true");

      const confirm = screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement;
      expect(confirm.textContent).toContain("Add 2");
      expect(confirm.textContent).not.toContain("Arm");
    });

    it("commit in append mode extends the armed set (does not replace)", async () => {
      // Pre-arm a terminal that lives outside the active worktree — replace
      // would drop it, append must keep it.
      useFleetArmingStore.getState().armId("preexisting");
      seedTerminals([
        makeTerminal("preexisting", { worktreeId: "wt-2" }),
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      const onClose = vi.fn();
      renderPalette([makeWorktreeSnap("wt-1", "main")], true, onClose);
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-commit-mode-append"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-confirm"));
      });

      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["preexisting", "t1", "t2"]);
      expect(s.armedIds.has("preexisting")).toBe(true);
      expect(onClose).toHaveBeenCalled();
    });

    it("commit in append mode dedupes against already-armed ids", async () => {
      useFleetArmingStore.getState().armId("t1");
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-commit-mode-append"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-confirm"));
      });

      // t1 was already armed and stays at its prior position; t2 is appended.
      expect(useFleetArmingStore.getState().armOrder).toEqual(["t1", "t2"]);
    });

    it("toggling Replace ↔ Append preserves the current selection", async () => {
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      // Preselection in cold-start mode gives us 2 selected.
      const confirmInitial = screen.getByTestId(
        "fleet-picker-cold-start-confirm"
      ) as HTMLButtonElement;
      expect(confirmInitial.textContent).toContain("Arm 2 selected");

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-commit-mode-append"));
      });
      expect(
        (screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement).textContent
      ).toContain("Add 2");

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-commit-mode-replace"));
      });
      expect(
        (screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement).textContent
      ).toContain("Arm 2 selected");
    });

    it("resets to Replace when the palette is closed and reopened", async () => {
      // FleetPickerPalette stays mounted across isOpen toggles (it lives
      // inside SidebarContent), so commitMode survives a naive close-reopen
      // unless we explicitly reset it. Guard against that regression.
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      const store = createWorktreeStore();
      store.getState().applySnapshot([makeWorktreeSnap("wt-1", "main")], { epoch: "test", seq: 1 });
      const { rerender } = render(
        <WorktreeStoreContext.Provider value={store}>
          <FleetPickerPalette isOpen={true} onClose={() => {}} />
        </WorktreeStoreContext.Provider>
      );
      await act(async () => {});

      // Switch to Append.
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-commit-mode-append"));
      });
      expect(
        screen
          .getByTestId("fleet-picker-cold-start-commit-mode-append")
          .getAttribute("aria-checked")
      ).toBe("true");

      // Close…
      rerender(
        <WorktreeStoreContext.Provider value={store}>
          <FleetPickerPalette isOpen={false} onClose={() => {}} />
        </WorktreeStoreContext.Provider>
      );
      await act(async () => {});

      // …and reopen. Replace must be active again.
      rerender(
        <WorktreeStoreContext.Provider value={store}>
          <FleetPickerPalette isOpen={true} onClose={() => {}} />
        </WorktreeStoreContext.Provider>
      );
      await act(async () => {});

      const replace = screen.getByTestId("fleet-picker-cold-start-commit-mode-replace");
      const append = screen.getByTestId("fleet-picker-cold-start-commit-mode-append");
      expect(replace.getAttribute("aria-checked")).toBe("true");
      expect(append.getAttribute("aria-checked")).toBe("false");
      expect(
        (screen.getByTestId("fleet-picker-cold-start-confirm") as HTMLButtonElement).textContent
      ).toContain("Arm 2 selected");
    });

    it("already-armed terminals stay visible after switching to Append", async () => {
      // The hook's `mode` prop must remain "cold-start" regardless of the
      // toggle, so already-armed terminals are NOT hidden in the visible list
      // (that filtering only kicks in when the hook itself is in "add" mode).
      useFleetArmingStore.getState().armId("t1");
      seedTerminals([
        makeTerminal("t1", { worktreeId: "wt-1" }),
        makeTerminal("t2", { worktreeId: "wt-1" }),
      ]);
      renderPalette([makeWorktreeSnap("wt-1", "main")]);
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-cold-start-commit-mode-append"));
      });

      // Both rows should still be rendered — t1 (already armed) and t2.
      expect(screen.getByTestId("fleet-picker-cold-start-row-t1")).toBeTruthy();
      expect(screen.getByTestId("fleet-picker-cold-start-row-t2")).toBeTruthy();
    });
  });
});
