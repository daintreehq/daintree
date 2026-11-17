// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";

// Each tab and session row owns a TerminalContextMenu, which reads the worktree
// store; its scoping is pinned in its own suite, so it is a passthrough here.
vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children?: unknown }) => <>{children as never}</>,
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

// Records what the collapsed rail hands to the real drag source. Rescue-drag is
// the whole reason the rail exists, so the contract under test is "every
// surviving terminal gets a drag source, carrying its own worktree id" — not
// dnd-kit's internals, which the mock above stands in for.
const sortableProps = vi.fn<(props: { terminalId: string; worktreeId: string }) => void>();

vi.mock("@/components/DragDrop/SortableWorktreeTerminal", () => ({
  SortableWorktreeTerminal: ({
    terminal,
    worktreeId,
    children,
  }: {
    terminal: { id: string };
    worktreeId: string;
    children: ReactNode;
  }) => {
    sortableProps({ terminalId: terminal.id, worktreeId });
    return <>{children}</>;
  },
  getAccordionDragId: (id: string) => `accordion-${id}`,
}));

// jsdom has no layout, so overflow is whatever the test says it is.
const truncation = vi.hoisted(() => ({ truncated: false }));
vi.mock("@/hooks/useTruncationDetection", () => ({
  useTruncationDetection: () => ({ ref: () => {}, isTruncated: truncation.truncated }),
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: ({ className }: { className?: string }) => (
    <svg data-testid="terminal-row-icon" className={className} />
  ),
}));

// Only the component root reads this store, so its selector calls count the
// root's renders and nothing beneath it (#17051).
const rootRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/store/terminalPendingDestructiveActionStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/store/terminalPendingDestructiveActionStore")>();
  const store = actual.useTerminalPendingDestructiveActionStore;
  const counted = Object.assign((selector: Parameters<typeof store>[0]) => {
    rootRenders.count += 1;
    return store(selector);
  }, store);
  return { ...actual, useTerminalPendingDestructiveActionStore: counted };
});

import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DeletedWorktreeGroup } from "../DeletedWorktreeGroup";

function setPanels(
  entries: Array<{
    id: string;
    worktreeId: string;
    location?: string;
    title?: string;
    kind?: string;
  }>
): void {
  const panelsById: Record<string, unknown> = {};
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const entry of entries) {
    panelsById[entry.id] = {
      id: entry.id,
      kind: entry.kind ?? "terminal",
      title: entry.title ?? entry.id,
      worktreeId: entry.worktreeId,
      location: entry.location ?? "grid",
    };
    const bucket = panelIdsByWorktreeId[entry.worktreeId];
    if (bucket) bucket.push(entry.id);
    else panelIdsByWorktreeId[entry.worktreeId] = [entry.id];
  }
  usePanelStore.setState({
    panelIds: entries.map((e) => e.id),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    panelsById: panelsById as never,
    panelIdsByWorktreeId,
  });
}

function makeDeleted(id: string, title: string, expiresAt: number | null = null): DeletedWorktree {
  return {
    id,
    title,
    path: `/repo/${id}`,
    deletedAt: 1000,
    expiresAt,
    holdReason: null,
    pinnedBeforeWorktreeId: null,
  };
}

const worktrees = [makeDeleted("wt-1", "feature/alpha"), makeDeleted("wt-2", "feature/beta")];

function renderGroup(list: DeletedWorktree[] = worktrees) {
  return render(
    <TooltipProvider>
      <DeletedWorktreeGroup worktrees={list} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  cleanup();
  truncation.truncated = false;
  sortableProps.mockClear();
  useTerminalPendingDestructiveActionStore.getState().clear();
  useWorktreeSelectionStore.getState().reset();
  usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 60 });
  setPanels([]);
});

// Patches a panel the way the status buffer does: a fresh object in a fresh
// `panelsById`, with every bucket array left as it was.
function patchPanel(id: string, fields: Partial<PtyPanelData>): void {
  act(() => {
    usePanelStore.setState((state) => {
      const panel = state.panelsById[id];
      if (!panel || !isPtyPanel(panel)) throw new Error(`no PTY panel ${id}`);
      return { panelsById: { ...state.panelsById, [id]: { ...panel, ...fields } } };
    });
  });
}

function streamOutput(id: string, line: number): void {
  patchPanel(id, {
    activityHeadline: `line ${line}`,
    activityStatus: "working",
    lastCommand: `make ${line}`,
  });
}

describe("DeletedWorktreeGroup", () => {
  it("does not re-render while its members' or any other terminal streams output", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
      { id: "elsewhere", worktreeId: "wt-live" },
    ]);
    renderGroup();
    const before = rootRenders.count;

    for (let line = 0; line < 3; line++) {
      streamOutput("t1", line);
      streamOutput("t2", line);
      streamOutput("elsewhere", line);
    }

    expect(rootRenders.count).toBe(before);
  });

  it("summarises worktree and terminal counts in one row", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
      { id: "t3", worktreeId: "wt-2" },
    ]);
    renderGroup();

    const summary = screen.getByRole("button", { expanded: false });
    expect(summary.textContent).toContain("2 deleted worktrees");
    expect(summary.textContent).toContain("3 panels");
  });

  it("keeps every surviving terminal mounted as a drag source while collapsed", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
      { id: "t3", worktreeId: "wt-2" },
    ]);
    renderGroup();

    // Rescue-drag must survive collapsing — a summary that unmounted its
    // terminals would remove the only way to save a live agent session.
    expect(sortableProps.mock.calls.map((c) => c[0])).toEqual([
      { terminalId: "t1", worktreeId: "wt-1" },
      { terminalId: "t2", worktreeId: "wt-1" },
      { terminalId: "t3", worktreeId: "wt-2" },
    ]);
  });

  it("labels each rail chip with its terminal and source worktree", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1", title: "claude" }]);
    renderGroup();

    expect(
      screen.getByRole("button", {
        name: "Drag to rescue claude in deleted worktree feature/alpha",
      })
    ).toBeTruthy();
  });

  describe("rail chip title", () => {
    const LONG_TITLE = "claude-code-session-with-a-very-long-title";
    // Past Radix's default hover delay (700 ms).
    const PAST_HOVER_DELAY_MS = 1000;

    function chipTitle(): HTMLElement {
      const chip = screen.getByRole("button", {
        name: `${LONG_TITLE} in deleted worktree feature/alpha`,
      });
      const span = Array.from(chip.querySelectorAll("span")).find(
        (el) => el.textContent === LONG_TITLE
      );
      if (!span) throw new Error("chip title not rendered");
      return span;
    }

    function hoverChipTitle() {
      act(() => {
        fireEvent.pointerMove(chipTitle(), { pointerType: "mouse" });
        vi.advanceTimersByTime(PAST_HOVER_DELAY_MS);
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("discloses the full title on hover when it is cut off", () => {
      truncation.truncated = true;
      setPanels([{ id: "t1", worktreeId: "wt-1", title: LONG_TITLE }]);
      renderGroup([worktrees[0]!]);
      expect(screen.queryByRole("tooltip")).toBeNull();

      hoverChipTitle();

      expect(screen.getByRole("tooltip").textContent).toBe(LONG_TITLE);
    });

    it("adds no tooltip when the title fits", () => {
      setPanels([{ id: "t1", worktreeId: "wt-1", title: LONG_TITLE }]);
      renderGroup([worktrees[0]!]);

      hoverChipTitle();

      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("leaves the chip button the only tab stop when the title is cut off", () => {
      truncation.truncated = true;
      setPanels([{ id: "t1", worktreeId: "wt-1", title: LONG_TITLE }]);
      renderGroup([worktrees[0]!]);

      expect(chipTitle().hasAttribute("tabindex")).toBe(false);
    });
  });

  it("swaps the rail for the member cards once expanded", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    useWorktreeSelectionStore.setState({ deletedWorktreeGroupExpanded: true });
    renderGroup();

    expect(screen.getByText("/repo/wt-1")).toBeTruthy();
    expect(screen.getByText("/repo/wt-2")).toBeTruthy();
    expect(screen.queryByRole("list", { name: /^Terminals from deleted worktree/ })).toBeNull();
  });

  it("toggles expansion from the summary row", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    renderGroup();

    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(useWorktreeSelectionStore.getState().deletedWorktreeGroupExpanded).toBe(true);
  });

  // A flat membership would read this move as no change at all: the same
  // terminals in the same order, only filed under another member.
  it("re-files a terminal rescued from one member into another, on the store write alone", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    renderGroup();
    expect(screen.getByRole("list", { name: /feature\/alpha/ })).toBeTruthy();
    sortableProps.mockClear();

    act(() => {
      setPanels([
        { id: "t1", worktreeId: "wt-2" },
        { id: "t2", worktreeId: "wt-2" },
      ]);
    });

    expect(screen.queryByRole("list", { name: /feature\/alpha/ })).toBeNull();
    const beta = screen.getByRole("list", { name: /feature\/beta/ });
    expect(beta.textContent).toContain("t1");
    expect(beta.textContent).toContain("t2");
    expect(sortableProps).toHaveBeenCalledWith({ terminalId: "t1", worktreeId: "wt-2" });
  });

  it("keeps a panel that stops being a terminal in the count but out of the rail", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    renderGroup();

    act(() => {
      setPanels([
        { id: "t1", worktreeId: "wt-1", kind: "browser" },
        { id: "t2", worktreeId: "wt-2" },
      ]);
    });

    expect(screen.getByRole("button", { expanded: false }).textContent).toContain("2 panels");
    expect(screen.queryByRole("list", { name: /feature\/alpha/ })).toBeNull();
  });

  it("previews the panels as they are when the clear is clicked", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "Old name" },
      { id: "t2", worktreeId: "wt-2", title: "shell" },
    ]);
    renderGroup();
    const before = rootRenders.count;
    patchPanel("t1", { title: "New name", detectedAgentId: "claude", agentState: "working" });
    expect(rootRenders.count).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Close 2 panels" }));

    const pending = useTerminalPendingDestructiveActionStore.getState().pending;
    expect(pending?.preview?.[0]).toEqual({
      worktreeId: "wt-1",
      worktreeTitle: "feature/alpha",
      terminals: [{ terminalId: "t1", terminalTitle: "New name", hasRunningAgent: true }],
    });
  });

  it("shrinks live when a terminal is rescued out of a member", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    const { rerender } = renderGroup();
    expect(screen.getByRole("button", { expanded: false }).textContent).toContain("2 panels");

    // Membership is derived, so re-homing a panel is enough to shrink the group.
    setPanels([{ id: "t2", worktreeId: "wt-2" }]);
    rerender(
      <TooltipProvider>
        <DeletedWorktreeGroup worktrees={worktrees} />
      </TooltipProvider>
    );

    expect(screen.getByRole("button", { expanded: false }).textContent).toContain("1 panel");
  });

  it("omits trashed and overlay panels, matching what the clear would close", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1", location: "trash" },
      { id: "t3", worktreeId: "wt-2", location: "overlay" },
    ]);
    renderGroup();

    expect(screen.getByRole("button", { name: "Close 1 panel" })).toBeTruthy();
  });

  it("gives each member its own deadline in the rail, not one shared readout", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    const now = Date.now();
    const { container } = renderGroup([
      makeDeleted("wt-1", "feature/alpha", now + 50_000),
      makeDeleted("wt-2", "feature/beta", now + 10_000),
    ]);

    const readouts = Array.from(
      container.querySelectorAll("[data-deleted-worktree-member]"),
      (member) => ({
        id: member.getAttribute("data-deleted-worktree-member"),
        seconds: Number(
          member
            .querySelector("[data-testid='deleted-worktree-member-countdown']")
            ?.textContent?.replace("s", "")
        ),
      })
    );
    expect(readouts.map((r) => r.id)).toEqual(["wt-1", "wt-2"]);
    expect(readouts[0]!.seconds).toBeGreaterThan(readouts[1]!.seconds);
  });

  it("freezes a held member and names why, while its siblings keep counting", () => {
    vi.useFakeTimers();
    try {
      setPanels([
        { id: "t1", worktreeId: "wt-1" },
        { id: "t2", worktreeId: "wt-2" },
      ]);
      const now = Date.now();
      const held = {
        ...makeDeleted("wt-1", "feature/alpha", now + 20_000),
        holdReason: "agent" as const,
        heldRemainingMs: 20_000,
      };
      const running = makeDeleted("wt-2", "feature/beta", now + 40_000);
      const { container, rerender } = renderGroup([held, running]);
      const read = (id: string) =>
        Number(
          container
            .querySelector(
              `[data-deleted-worktree-member='${id}'] [data-testid='deleted-worktree-member-countdown']`
            )
            ?.textContent?.replace("s", "")
        );
      const heldBefore = read("wt-1");
      const runningBefore = read("wt-2");

      // The sweep re-pins a held row's deadline to now + remaining on every
      // pass; the readout must hold still rather than follow it.
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      rerender(
        <TooltipProvider>
          <DeletedWorktreeGroup
            worktrees={[{ ...held, expiresAt: Date.now() + 20_000 }, running]}
          />
        </TooltipProvider>
      );
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(read("wt-1")).toBe(heldBefore);
      expect(read("wt-2")).toBeLessThan(runningBefore);
      expect(
        container.querySelector(
          "[data-deleted-worktree-member='wt-1'] [data-testid='deleted-worktree-member-hold']"
        )?.textContent
      ).toBe("Agent working");
      expect(
        container.querySelector(
          "[data-deleted-worktree-member='wt-2'] [data-testid='deleted-worktree-member-hold']"
        )
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("summarises the next close from running members only", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
      { id: "t3", worktreeId: "wt-3" },
    ]);
    const now = Date.now();
    const { container } = renderGroup([
      // Held rows are re-pinned every pass, so the soonest held one must not win.
      { ...makeDeleted("wt-1", "feature/alpha", now + 5_000), holdReason: "agent" },
      makeDeleted("wt-2", "feature/beta", now + 30_000),
      makeDeleted("wt-3", "feature/gamma", now + 50_000),
    ]);

    const readout = container.querySelector("[data-testid='deleted-worktree-group-countdown']");
    const seconds = Number(readout?.textContent?.replace("s", ""));
    expect(seconds).toBeGreaterThan(25);
    expect(seconds).toBeLessThanOrEqual(30);
    // Kept out of the disclosure button so its name does not tick.
    expect(readout?.closest("button")).toBeNull();
  });

  describe("countdown tooltips", () => {
    // Keyboard focus opens a Radix tooltip with no hover delay.
    function focusTooltip(timer: Element | null): string {
      if (!(timer instanceof HTMLElement)) throw new Error("timer not rendered");
      act(() => {
        timer.focus();
      });
      return screen.getByRole("tooltip").textContent ?? "";
    }

    it("explains the group's next cleanup on the summary row", () => {
      setPanels([
        { id: "t1", worktreeId: "wt-1" },
        { id: "t2", worktreeId: "wt-2" },
      ]);
      const now = Date.now();
      const { container } = renderGroup([
        makeDeleted("wt-1", "feature/alpha", now + 30_000),
        makeDeleted("wt-2", "feature/beta", now + 50_000),
      ]);

      const timer = container.querySelector("[data-testid='deleted-worktree-group-countdown']");
      expect(timer?.getAttribute("tabindex")).toBe("0");
      expect(focusTooltip(timer)).toMatch(/^Next cleanup in \d+s$/);
      expect(container.querySelector("[title]")).toBeNull();
    });

    it("explains a running member's timer in the rail", () => {
      setPanels([{ id: "t1", worktreeId: "wt-1" }]);
      const { container } = renderGroup([
        makeDeleted("wt-1", "feature/alpha", Date.now() + 40_000),
      ]);

      const timer = container.querySelector("[data-testid='deleted-worktree-member-countdown']");
      expect(timer?.getAttribute("tabindex")).toBe("0");
      expect(focusTooltip(timer)).toMatch(/^Closes automatically in \d+s$/);
      expect(container.querySelector("[title]")).toBeNull();
    });

    it("says why a held member's timer is holding", () => {
      setPanels([{ id: "t1", worktreeId: "wt-1" }]);
      const { container } = renderGroup([
        {
          ...makeDeleted("wt-1", "feature/alpha", Date.now() + 40_000),
          holdReason: "agent",
          heldRemainingMs: 33_000,
        },
      ]);

      const timer = container.querySelector("[data-testid='deleted-worktree-member-countdown']");
      expect(focusTooltip(timer)).toBe(
        "Auto-close is paused while an agent here is still working, holding at 33s"
      );
      expect(container.querySelector("[title]")).toBeNull();
      expect(
        screen.getByRole("timer", {
          name: "Auto-close is paused while an agent here is still working, holding at 33 seconds",
        })
      ).toBeTruthy();
    });

    it("opens a member's tooltip on pointer hover too", () => {
      vi.useFakeTimers();
      try {
        setPanels([{ id: "t1", worktreeId: "wt-1" }]);
        const { container } = renderGroup([
          makeDeleted("wt-1", "feature/alpha", Date.now() + 40_000),
        ]);
        const timer = container.querySelector("[data-testid='deleted-worktree-member-countdown']")!;

        act(() => {
          fireEvent.pointerMove(timer, { pointerType: "mouse" });
          vi.advanceTimersByTime(1000);
        });

        expect(screen.getByRole("tooltip").textContent).toMatch(/^Closes automatically in \d+s$/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders no native title on an expanded group's cards", () => {
      setPanels([{ id: "t1", worktreeId: "wt-1" }]);
      useWorktreeSelectionStore.setState({ deletedWorktreeGroupExpanded: true });
      const { container } = renderGroup([
        makeDeleted("wt-1", "feature/alpha", Date.now() + 40_000),
      ]);

      expect(container.querySelector("[title]")).toBeNull();
    });
  });

  it("drops the summary timer when every member is held", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    const now = Date.now();
    const { container } = renderGroup([
      { ...makeDeleted("wt-1", "feature/alpha", now + 5_000), holdReason: "agent" },
      { ...makeDeleted("wt-2", "feature/beta", now + 9_000), holdReason: "drag" },
    ]);

    expect(container.querySelector("[data-testid='deleted-worktree-group-countdown']")).toBeNull();
  });

  it("files every rail chip under the worktree it came from", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "t2", worktreeId: "wt-2", title: "claude" },
    ]);
    renderGroup();

    // Two sessions can share a title; the list they sit in is what tells them apart.
    for (const title of ["feature/alpha", "feature/beta"]) {
      const list = screen.getByRole("list", { name: `Terminals from deleted worktree ${title}` });
      expect(list.textContent).toContain("claude");
    }
  });

  it("carries each agent's state into the rail", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1", title: "codex" }]);
    usePanelStore.setState((s) => ({
      panelsById: {
        ...s.panelsById,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        t1: { ...s.panelsById.t1, detectedAgentId: "codex", agentState: "waiting" } as never,
      },
    }));
    renderGroup();

    const chip = screen.getByRole("button", { name: "codex in deleted worktree feature/alpha" });
    expect(chip.getAttribute("aria-description")).toMatch(/^waiting/);
  });

  it("keeps the bulk clear neutral until it is pointed at or focused", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    renderGroup();

    const clear = screen.getByRole("button", { name: "Close 1 panel" });
    const restingDanger = clear.className
      .split(/\s+/)
      .filter((c) => c.includes("status-error") && !/^(hover|focus-visible):/.test(c));
    expect(restingDanger).toEqual([]);
  });

  it("stages a confirm previewing the actual terminals rather than clearing (D2)", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "t2", worktreeId: "wt-2", title: "shell" },
    ]);
    renderGroup();

    fireEvent.click(screen.getByRole("button", { name: "Close 2 panels" }));

    const pending = useTerminalPendingDestructiveActionStore.getState().pending;
    expect(pending).toMatchObject({ kind: "deletedWorktreeGroupDismiss", targetCount: 2 });
    expect(pending?.preview).toEqual([
      {
        worktreeId: "wt-1",
        worktreeTitle: "feature/alpha",
        terminals: [{ terminalId: "t1", terminalTitle: "claude", hasRunningAgent: false }],
      },
      {
        worktreeId: "wt-2",
        worktreeTitle: "feature/beta",
        terminals: [{ terminalId: "t2", terminalTitle: "shell", hasRunningAgent: false }],
      },
    ]);
    // Nothing may be trashed before the user confirms.
    expect(usePanelStore.getState().panelsById["t1"]).toBeDefined();
  });

  it("leaves a member with no surviving terminals out of the preview", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1", title: "claude" }]);
    renderGroup();

    fireEvent.click(screen.getByRole("button", { name: "Close 1 panel" }));

    expect(useTerminalPendingDestructiveActionStore.getState().pending?.preview).toHaveLength(1);
  });

  it("previews every panel the clear would trash, not just the terminals", () => {
    // `bulkTrashByWorktree` closes every non-trash/overlay/dialog panel, so a
    // preview narrowed to PTY panels would under-report what confirming ends —
    // the #9699 mismatch class, and a D2 consent violation besides.
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "b1", worktreeId: "wt-1", title: "localhost:3000", kind: "browser" },
      { id: "t2", worktreeId: "wt-2", title: "shell" },
    ]);
    renderGroup();

    fireEvent.click(screen.getByRole("button", { name: "Close 3 panels" }));

    const preview = useTerminalPendingDestructiveActionStore.getState().pending?.preview;
    expect(preview?.[0]?.terminals.map((t) => t.terminalTitle)).toEqual([
      "claude",
      "localhost:3000",
    ]);
    expect(useTerminalPendingDestructiveActionStore.getState().pending?.targetCount).toBe(3);
  });

  it("keeps a non-terminal panel out of the draggable rail", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "b1", worktreeId: "wt-1", title: "localhost:3000", kind: "browser" },
      { id: "t2", worktreeId: "wt-2", title: "shell" },
    ]);
    renderGroup();

    // Only a terminal can ride the accordion drag, so the browser panel counts
    // toward the clear but must not appear as a rescue chip.
    expect(sortableProps.mock.calls.map((c) => c[0].terminalId)).toEqual(["t1", "t2"]);
  });

  it("renders nothing once no member has a terminal left", () => {
    setPanels([{ id: "t1", worktreeId: "other" }]);
    const { container } = renderGroup();

    expect(container.firstChild).toBeNull();
  });
});
