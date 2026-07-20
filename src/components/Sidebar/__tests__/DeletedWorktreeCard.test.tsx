// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

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

vi.mock("@/components/DragDrop/SortableWorktreeTerminal", () => ({
  SortableWorktreeTerminal: ({ children }: { children: ReactNode }) => <>{children}</>,
  getAccordionDragId: (id: string) => `accordion-${id}`,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: ({ className }: { className?: string }) => (
    <svg data-testid="terminal-row-icon" className={className} />
  ),
}));

import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore, type DeletedWorktreeCleanupSeconds } from "@/store/preferencesStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DeletedWorktreeCard } from "../DeletedWorktreeCard";

function setPanels(
  entries: Array<{ id: string; worktreeId: string; location?: string; title?: string }>
): void {
  const panelsById: Record<string, unknown> = {};
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const entry of entries) {
    panelsById[entry.id] = {
      id: entry.id,
      kind: "terminal",
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

// Classifies Tailwind bottom-border *width* utilities (`border-b`, `border-b-2`,
// and variant-prefixed forms like `hover:border-b`) rather than matching the
// class string, so the check keeps working as unrelated classes come and go.
// `border-b-0` is excluded because it removes the border rather than painting
// one, as are colour-only utilities like `border-b-border-default`.
function hasBottomBorderUtility(element: Element): boolean {
  return [...element.classList].some((className) => {
    const utility = className.split(":").at(-1);
    if (utility === "border-b") return true;
    if (utility?.startsWith("border-b-") !== true) return false;
    const value = utility.slice("border-b-".length);
    // Arbitrary widths (`border-b-[1px]`) paint a rule of their own; arbitrary
    // colours (`border-b-[#fff]`) only tint one some width utility declared.
    if (value.startsWith("[")) return !value.startsWith("[#");
    return /^\d+$/.test(value) && value !== "0";
  });
}

function renderCard(wt: DeletedWorktree = worktree) {
  return render(
    <TooltipProvider>
      <DeletedWorktreeCard worktree={wt} />
    </TooltipProvider>
  );
}

const worktree: DeletedWorktree = {
  id: "wt-1",
  title: "feature/login",
  path: "/repo/feature-login",
  deletedAt: 1000,
  expiresAt: null,
  pinnedIndex: 2,
};

const originalSelectWorktree = useWorktreeSelectionStore.getState().selectWorktree;

beforeEach(() => {
  cleanup();
  useTerminalPendingDestructiveActionStore.getState().clear();
  useWorktreeSelectionStore.getState().reset();
  // reset() restores data fields only — undo any per-test action override.
  useWorktreeSelectionStore.setState({ selectWorktree: originalSelectWorktree });
  usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 60 });
  setPanels([]);
});

describe("DeletedWorktreeCard", () => {
  it("shows the last-known title, path, and Deleted badge", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    renderCard();

    expect(screen.getByText("feature/login")).toBeTruthy();
    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.getByText("/repo/feature-login")).toBeTruthy();
  });

  it("shows the live-card terminal summary bar instead of instructional copy", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
    ]);
    renderCard();

    expect(screen.queryByText("Drag terminals to another worktree")).toBeNull();
    // Collapsed WorktreeTerminalSection: count + "active" label, same as live cards.
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("lists surviving terminals when the sessions section is expanded", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "t2", worktreeId: "wt-1", title: "shell" },
    ]);
    useWorktreeSelectionStore.getState().toggleTerminalsExpanded("wt-1");
    renderCard();

    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("shell")).toBeTruthy();
  });

  it("selects the deleted worktree when the card is clicked", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const selectWorktree = vi.fn();
    useWorktreeSelectionStore.setState({ selectWorktree });
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Select deleted worktree: feature/login" }));

    // Session-only selection: a ghost id must never become the persisted
    // restore target (deletedWorktrees does not survive restarts).
    expect(selectWorktree).toHaveBeenCalledWith("wt-1", { source: "focus" });
  });

  // Armed presence is owned by the bottom-edge-ownership block below, which
  // asserts the same thing plus where the fill sits in the tree.

  it("shows the seconds readout next to the close button while armed", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const { container } = renderCard({ ...worktree, expiresAt: Date.now() + 60_000 });

    const readout = container.querySelector("[data-testid='deleted-worktree-countdown-seconds']");
    expect(readout?.textContent).toMatch(/^\d+s$/);
  });

  it("hides the countdown bar while auto-cleanup is off or the row is unarmed", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const unarmed = renderCard();
    expect(
      unarmed.container.querySelector("[data-testid='deleted-worktree-countdown']")
    ).toBeNull();
    cleanup();

    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    const off = renderCard({ ...worktree, expiresAt: Date.now() + 60_000 });
    expect(off.container.querySelector("[data-testid='deleted-worktree-countdown']")).toBeNull();
  });

  // #11262: the card used to carry a `border-b` *and* an absolutely positioned
  // countdown bar. `bottom-0` resolves against the padding edge, so the bar
  // landed one border-width above the border and the two painted as a doubled
  // rule. The invariant these lock is structural, not cosmetic: exactly one
  // element owns the bottom edge in every state, and the countdown lives inside
  // it rather than beside it. jsdom can't measure the overlap that caused the
  // bug, so we assert the arrangement that makes it unrepresentable.
  describe("bottom-edge ownership (#11262)", () => {
    const bottomEdgeStates: Array<{
      name: string;
      wt: DeletedWorktree;
      cleanupSeconds: DeletedWorktreeCleanupSeconds;
      armed: boolean;
    }> = [
      { name: "unarmed", wt: worktree, cleanupSeconds: 60, armed: false },
      {
        name: "armed",
        wt: { ...worktree, expiresAt: Date.now() + 60_000 },
        cleanupSeconds: 60,
        armed: true,
      },
      {
        name: "deadline set but auto-cleanup disabled",
        wt: { ...worktree, expiresAt: Date.now() + 60_000 },
        cleanupSeconds: 0,
        armed: false,
      },
    ];

    for (const { name, wt, cleanupSeconds, armed } of bottomEdgeStates) {
      it(`keeps a single bottom rule while ${name}`, () => {
        setPanels([{ id: "t1", worktreeId: "wt-1" }]);
        usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: cleanupSeconds });
        const { container } = renderCard(wt);

        const card = container.querySelector("[data-deleted-worktree-id='wt-1']");
        if (!card) throw new Error("card did not render");

        // The card must not paint a border of its own — that border plus the
        // positioned track is precisely the doubling this fixes.
        expect(hasBottomBorderUtility(card)).toBe(false);

        const separators = card.querySelectorAll(
          ":scope > [data-testid='deleted-worktree-separator']"
        );
        expect(separators).toHaveLength(1);

        // The countdown must be nested in the separator. A regression that
        // reintroduces it as a sibling would still satisfy a naive
        // presence check, so assert the containment and the absence of a
        // second top-level bar separately.
        const separator = separators[0];
        if (!separator) throw new Error("separator did not render");
        expect(
          separator.querySelectorAll(":scope > [data-testid='deleted-worktree-countdown']")
        ).toHaveLength(armed ? 1 : 0);
        expect(
          card.querySelectorAll(":scope > [data-testid='deleted-worktree-countdown']")
        ).toHaveLength(0);
      });
    }

    it("keeps the track decorative rather than a second tooltip target", () => {
      setPanels([{ id: "t1", worktreeId: "wt-1" }]);
      const { container } = renderCard({ ...worktree, expiresAt: Date.now() + 60_000 });

      const separator = container.querySelector("[data-testid='deleted-worktree-separator']");
      // A 1px strip is an unhittable hover target, and the seconds readout in
      // the header already carries the tooltip — a title here would be dead
      // weight that screen readers skip anyway.
      expect(separator?.getAttribute("aria-hidden")).toBe("true");
      expect(separator?.hasAttribute("title")).toBe(false);
      expect(
        container.querySelector("[data-testid='deleted-worktree-countdown']")?.hasAttribute("title")
      ).toBe(false);
      // The readout keeps its own tooltip, so the information is not lost.
      expect(
        container
          .querySelector("[data-testid='deleted-worktree-countdown-seconds']")
          ?.getAttribute("title")
      ).toContain("Closes automatically");
    });
  });

  // The fill's width is the only thing that makes the separator read as a
  // countdown, and `remainingFraction` is not a straight ratio: it clamps to
  // the configured TTL (the sweep re-extends the deadline out of phase with
  // this component's tick) and snaps the top ~1.5s to exactly full so a
  // deferred countdown holds steady instead of sawtoothing. Assert the
  // computed width, since every structural test above passes even if the fill
  // is permanently stuck at 0% or 100%.
  describe("countdown fill width", () => {
    function renderArmed(expiresAt: number, cleanupSeconds: DeletedWorktreeCleanupSeconds = 60) {
      setPanels([{ id: "t1", worktreeId: "wt-1" }]);
      usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: cleanupSeconds });
      const { container } = renderCard({ ...worktree, expiresAt });
      return {
        width: container.querySelector<HTMLElement>("[data-testid='deleted-worktree-countdown']")
          ?.style.width,
        readout: container.querySelector("[data-testid='deleted-worktree-countdown-seconds']")
          ?.textContent,
      };
    }

    function fillWidth(
      expiresAt: number,
      cleanupSeconds: DeletedWorktreeCleanupSeconds = 60
    ): string | undefined {
      return renderArmed(expiresAt, cleanupSeconds).width;
    }

    it("holds at full while the sweep defers the deadline past the TTL", () => {
      // The sweep re-extends the deadline out of phase with this component's
      // tick, so a deadline beyond the TTL is normal and must read as full.
      // Assert the readout too: the width alone can't distinguish the clamp
      // from the snap-to-full branch, which would also yield 100% here.
      const { width, readout } = renderArmed(Date.now() + 90_000);
      expect(width).toBe("100%");
      expect(readout).toBe("60s");
    });

    it("snaps the opening moments to exactly full so a paused bar holds steady", () => {
      // Inside the ~1.5s snap window — a raw ratio would render just under 100%.
      expect(fillWidth(Date.now() + 59_200)).toBe("100%");
    });

    it("tracks the remaining fraction once the countdown is clear of the snap", () => {
      const width = fillWidth(Date.now() + 30_000);
      const percent = Number.parseFloat(width ?? "");
      // Tolerance absorbs the ms that elapse between arming and asserting.
      expect(percent).toBeGreaterThan(48);
      expect(percent).toBeLessThan(52);
    });

    it("drains to empty once the deadline has passed", () => {
      expect(fillWidth(Date.now() - 5_000)).toBe("0%");
    });
  });

  it("marks the card active when it is the active worktree", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    const { container } = renderCard();

    expect(
      container.querySelector("[data-deleted-worktree-id='wt-1']")?.getAttribute("data-active")
    ).toBe("true");
  });

  it("omits trashed and overlay panels, matching what dismissing would close", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "t2", worktreeId: "wt-1", title: "binned", location: "trash" },
      { id: "t3", worktreeId: "wt-1", title: "assistant", location: "overlay" },
    ]);
    renderCard();

    expect(screen.queryByText("binned")).toBeNull();
    expect(screen.queryByText("assistant")).toBeNull();
    expect(screen.getByRole("button", { name: "Close 1 terminal" })).toBeTruthy();
  });

  it("names the live terminal count on the dismiss button", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
      { id: "t3", worktreeId: "wt-1" },
    ]);
    renderCard();

    expect(screen.getByRole("button", { name: "Close 3 terminals" })).toBeTruthy();
  });

  it("requests a confirmation rather than closing terminals immediately", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
    ]);
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Close 2 terminals" }));

    // Destructive tier D1: the click must only stage a confirm, never trash.
    const pending = useTerminalPendingDestructiveActionStore.getState().pending;
    expect(pending).toMatchObject({
      kind: "deletedWorktreeDismiss",
      targetCount: 2,
      worktreeId: "wt-1",
    });
    expect(usePanelStore.getState().panelsById["t1"]).toBeDefined();
  });

  it("does not select the worktree when the dismiss button is clicked", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const selectWorktree = vi.fn();
    useWorktreeSelectionStore.setState({ selectWorktree });
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Close 1 terminal" }));

    expect(selectWorktree).not.toHaveBeenCalled();
  });

  it("renders nothing once no terminals remain", () => {
    setPanels([{ id: "t1", worktreeId: "other" }]);
    const { container } = renderCard();

    expect(container.firstChild).toBeNull();
  });

  it("exposes no drop-target data, so terminals can never be dropped onto it", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const { container } = renderCard();

    // The card is identified by its own attribute and must not advertise the
    // worktree drop payload DndProvider gates on.
    expect(container.querySelector("[data-deleted-worktree-id='wt-1']")).toBeTruthy();
    expect(container.querySelector("[data-worktree-drop-target]")).toBeNull();
  });
});

describe("DeletedWorktreeCard — grouped (#11260)", () => {
  it("hides its own dismiss button so the group's bulk clear is the only one", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
    ]);
    render(
      <TooltipProvider>
        <DeletedWorktreeCard worktree={worktree} showDismissAction={false} />
      </TooltipProvider>
    );

    expect(screen.queryByRole("button", { name: "Close 2 terminals" })).toBeNull();
    // The rest of the card is unchanged — it still identifies its worktree.
    expect(screen.getByText("feature/login")).toBeTruthy();
  });

  it("keeps the dismiss button by default", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    renderCard();

    expect(screen.getByRole("button", { name: "Close 1 terminal" })).toBeTruthy();
  });
});
