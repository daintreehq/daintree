/**
 * @vitest-environment jsdom
 *
 * Containment rules for the sidebar worktree card (#11992).
 *
 * These assert the RULE, not the classes that currently satisfy it. The card's
 * material will keep changing; what must not come back is a second bordered,
 * filled plane inside a row that is already a container, a divider cutting a
 * disclosure trigger off from the body it just revealed, or the two sibling
 * sections drifting into different shells. Each test states the rule it is
 * defending so a future change can argue with it rather than guess at it.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeState } from "@/types";
import type { PtyPanelData } from "@shared/types/panel";
import type { ComputedSubtitle } from "../hooks/useWorktreeStatus";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  WorktreeDetailsSection,
  type WorktreeDetailsSectionProps,
} from "../WorktreeDetailsSection";
import { WorktreeTerminalSection } from "../WorktreeTerminalSection";

const mockAnimate = vi.fn();

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useAnimate: () => [{ current: null } as unknown as React.RefObject<HTMLElement>, mockAnimate],
    useReducedMotion: () => false,
  };
});

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

const noop = () => {};
const noopAsync = async () => {};

const worktree: WorktreeState = {
  id: "wt-1",
  worktreeId: "wt-1",
  path: "/tmp/wt-1",
  name: "stream-upload",
  branch: "feature/issue-1-stream-upload",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: {
    worktreeId: "wt-1",
    changedFileCount: 3,
    insertions: 5,
    deletions: 2,
    changes: [],
    rootPath: "",
  },
  lastActivityTimestamp: null,
};

const subtitle: ComputedSubtitle = { text: "3 files changed", tone: "muted" };

const detailsProps: WorktreeDetailsSectionProps = {
  worktree,
  isExpanded: false,
  hasChanges: true,
  computedSubtitle: subtitle,
  worktreeErrors: [],
  isFocused: false,
  onToggleExpand: noop,
  onPathClick: noop,
  onDismissError: noop,
  onRetryError: noopAsync,
};

const terminal = {
  id: "term-1",
  kind: "pty",
  title: "Claude",
  worktreeId: "wt-1",
  location: "grid",
} as unknown as PtyPanelData;

function renderDetails(overrides: Partial<WorktreeDetailsSectionProps> = {}) {
  return render(
    <TooltipProvider>
      <WorktreeDetailsSection {...detailsProps} {...overrides} />
    </TooltipProvider>
  );
}

function renderTerminals(
  overrides: {
    variant?: "sidebar" | "grid";
    isExpanded?: boolean;
    total?: number;
    onStartSession?: () => void;
  } = {}
) {
  const total = overrides.total ?? 1;
  return render(
    <TooltipProvider>
      <WorktreeTerminalSection
        worktreeId="wt-1"
        variant={overrides.variant}
        isExpanded={overrides.isExpanded ?? false}
        counts={{ total, byState: {} } as never}
        terminals={total === 0 ? [] : [terminal]}
        onToggle={noop}
        onStartSession={"onStartSession" in overrides ? overrides.onStartSession : noop}
        onTerminalSelect={noop}
      />
    </TooltipProvider>
  );
}

/**
 * A "well" is the combination that makes an element read as a contained
 * region: a visible border AND a surface fill of its own.
 *
 * Matches any fill token, not just `bg-surface-inset`. Pinning it to one token
 * meant a well built from a different surface passed straight through, and the
 * assertions below silently stopped defending anything.
 */
function isWell(el: Element): boolean {
  const cls = el.className.toString();
  const hasBorder = /(^|\s|:)border(\s|$|-[trbl]\b)/.test(cls) || /\sborder\s/.test(` ${cls} `);
  const hasFill = /\bbg-(surface|overlay)-[a-z-]+\b/.test(cls);
  return hasBorder && hasFill;
}

function wellCount(container: HTMLElement): number {
  return Array.from(container.querySelectorAll("*")).filter(isWell).length;
}

describe("sidebar session well", () => {
  it("still renders with no sessions, so every card in the list ends the same way", () => {
    // An idle card that simply stops has nothing closing it off, and in a list
    // where only some cards end on a well the rhythm breaks at exactly the
    // cards with the least shape of their own.
    const { container, unmount } = renderTerminals({ variant: "sidebar", total: 0 });
    expect(container.firstElementChild, "sidebar tray vanished when empty").toBeTruthy();
    unmount();
  });

  it("names the next action when empty rather than reporting the absence", () => {
    const { container, unmount } = renderTerminals({ variant: "sidebar", total: 0 });
    const text = container.textContent ?? "";
    expect(
      /no sessions/i.test(text),
      "an empty well must not spend a row saying nothing is there — repeated down the sidebar that is all it says"
    ).toBe(false);
    expect(text.trim().length, "an empty tray still has to say something").toBeGreaterThan(0);
    unmount();
  });

  it("makes the empty tray actually actionable, since it presents itself as an action", () => {
    const onStartSession = vi.fn();
    const { container, unmount } = renderTerminals({
      variant: "sidebar",
      total: 0,
      onStartSession,
    });
    const control = container.querySelector("button");
    expect(control, "the empty tray offers an action, so it must be a control").toBeTruthy();
    control!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onStartSession).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("drops the empty tray when the caller has no session to start", () => {
    // The tray IS a `Start a session` button, so a caller that cannot start
    // one (DeletedWorktreeCard — the worktree's directory is gone) must get no
    // tray rather than a focusable control that does nothing.
    const { container, unmount } = renderTerminals({
      variant: "sidebar",
      total: 0,
      onStartSession: undefined,
    });
    expect(container.firstElementChild, "empty tray rendered with no action behind it").toBeNull();
    unmount();
  });

  it("gives the grid an empty tray too, but without a well around it", () => {
    // The grid renders the tray so every card carries the same bottom slot —
    // that is what lets a row of cards share a height without the shorter
    // ones looking truncated, and it names the next action instead of the
    // absence. It does NOT get a well: a well is a container, and with no
    // sessions there is nothing to contain.
    //
    // The sidebar keeps its well in the same state, and that is the one place
    // the rule bends: its cards are full-bleed with no border of their own,
    // so the well doubles as what separates two adjacent cards.
    const grid = renderTerminals({ variant: "grid", total: 0 });
    expect(grid.container.firstElementChild, "grid empty tray did not render").not.toBeNull();
    expect(wellCount(grid.container)).toBe(0);
    expect(grid.container.textContent).toContain("Start a session");
    grid.unmount();

    const sidebar = renderTerminals({ variant: "sidebar", total: 0 });
    expect(wellCount(sidebar.container)).toBeGreaterThan(0);
    sidebar.unmount();
  });

  it("adds no full-width rule that could be mistaken for a card boundary", () => {
    // The card boundary is the only full-bleed line in this list. The well
    // carries a perimeter, which is a different shape and cannot be confused
    // with it; a stray full-width border-t could be.
    for (const total of [0, 1]) {
      const { container, unmount } = renderTerminals({ variant: "sidebar", total });
      const withTopRule = Array.from(container.querySelectorAll("*")).filter((el) =>
        /\bborder-t\b/.test(el.className.toString())
      );
      expect(
        withTopRule.length,
        `sidebar sessions (total=${total}) reintroduced a full-width rule that competes with the card boundary`
      ).toBe(0);
      unmount();
    }
  });
});

describe("sidebar card containment", () => {
  it("wells Details only once it has a body to hold", () => {
    // Collapsed, Details is a single row, and a well around one row is a box
    // around nothing — that is the nesting #11992 was right to remove.
    // Expanded, it has content of its own, and the contour is what says the
    // content belongs to it rather than to the card at large. Same rule the
    // session well follows, which is why the two read as peers.
    const collapsed = renderDetails({ variant: "sidebar", isExpanded: false });
    expect(wellCount(collapsed.container), "collapsed Details should be a bare row").toBe(0);
    collapsed.unmount();

    const expanded = renderDetails({ variant: "sidebar", isExpanded: true });
    expect(wellCount(expanded.container), "expanded Details should be exactly one well").toBe(1);
    expanded.unmount();
  });

  it("spends exactly one well on the sidebar card, and spends it on sessions", () => {
    // The count is the rule. #11992 flattened this to zero and the cards
    // merged; the fixes that followed went the other way — a full-bleed tray,
    // then a title band and a footer band — and each one grouped ACROSS cards,
    // because a region touching both card edges binds to whatever is adjacent
    // to it. A well cannot: its inset and perimeter close it, so it belongs to
    // the card whose padding contains it. One, contained, at the bottom.
    for (const isExpanded of [false, true]) {
      for (const total of [0, 1]) {
        const { container, unmount } = renderTerminals({ variant: "sidebar", isExpanded, total });
        expect(
          wellCount(container),
          `sidebar sessions (expanded=${isExpanded}, total=${total}) should be exactly one well`
        ).toBe(1);
        unmount();
      }
    }
  });

  it("keeps the session well inset, which is what attaches it to its own card", () => {
    // A full-bleed fill is ambiguous by construction: footer of this card, or
    // header of the next? The inset is the whole argument for the well.
    const { container, unmount } = renderTerminals({ variant: "sidebar", isExpanded: false });
    const well = Array.from(container.querySelectorAll("*")).find(isWell);
    expect(well, "no well found").toBeTruthy();
    const cls = well!.className.toString();
    expect(
      /(^|\s)-m[xl]?-/.test(cls),
      "the session well must not bleed past the card's padding"
    ).toBe(false);
    unmount();
  });

  it("spends at most one well per disclosure, in either variant, and only when it holds a body", () => {
    // The rule both variants now follow: the card is already a container, so
    // one closed contour inside it is the budget — and a collapsed section is
    // a single row, which a well would be a box around nothing.
    //
    // The grid used to keep a bordered, filled well in BOTH states for BOTH
    // sections. Stacked, that gave the card two identical boxes with nothing
    // saying which was git state and which was running work, on top of the
    // card's own border and the grid cell's — the card-in-card that Carbon
    // and Material 3 both name as this component's characteristic failure.
    for (const variant of ["sidebar", "grid"] as const) {
      const collapsedDetails = renderDetails({ variant, isExpanded: false });
      expect(
        wellCount(collapsedDetails.container),
        `${variant}: collapsed Details must be a row, not a well`
      ).toBe(0);
      collapsedDetails.unmount();

      const expandedDetails = renderDetails({ variant, isExpanded: true });
      expect(
        wellCount(expandedDetails.container),
        `${variant}: expanded Details must have exactly one well`
      ).toBe(1);
      expandedDetails.unmount();

      for (const isExpanded of [false, true]) {
        const terminals = renderTerminals({ variant, isExpanded });
        expect(
          wellCount(terminals.container),
          `${variant}: sessions (expanded=${isExpanded}) must have exactly one well`
        ).toBe(1);
        terminals.unmount();
      }
    }
  });

  it("does not separate a sidebar disclosure trigger from the body it reveals", () => {
    // A rule between a trigger and its own content cuts the two apart and they
    // read as separate components. Dividers belong BETWEEN sibling sections.
    for (const render_ of [
      () => renderDetails({ variant: "sidebar", isExpanded: true }),
      () => renderTerminals({ variant: "sidebar", isExpanded: true }),
    ]) {
      const { container, unmount } = render_();
      const trigger = container.querySelector('[aria-expanded="true"]');
      expect(trigger, "expanded section should expose an aria-expanded trigger").toBeTruthy();
      expect(
        /\bborder-b\b/.test(trigger!.className.toString()),
        "a sidebar disclosure trigger must not carry a bottom rule above its own body"
      ).toBe(false);
      unmount();
    }
  });

  it("gives both sidebar sections the same trigger label treatment", () => {
    // They are siblings. Two equal sections wearing different label type read
    // as two different components, which is what this replaced.
    const details = renderDetails({ variant: "sidebar", isExpanded: true });
    const detailsLabel = details.container
      .querySelector('[aria-expanded="true"]')!
      .querySelector("span")!;
    const detailsClasses = new Set(detailsLabel.className.toString().split(/\s+/));
    details.unmount();

    const terminals = renderTerminals({ variant: "sidebar", isExpanded: true });
    const terminalsLabel = terminals.container
      .querySelector('[aria-expanded="true"]')!
      .querySelector("span")!;
    const terminalsClasses = new Set(terminalsLabel.className.toString().split(/\s+/));

    // Every typographic token on one label must appear on the other. Layout
    // utilities may differ (one carries an icon); the type ramp may not.
    const typeTokens = (set: Set<string>) =>
      [...set].filter((c) => /^(text-|font-|uppercase|tracking-)/.test(c)).sort();
    expect(typeTokens(detailsClasses)).toEqual(typeTokens(terminalsClasses));
  });

  it("puts the sidebar disclosure chevron before its label, not after", () => {
    // Leading chevrons are the tree/outline convention these sections belong
    // to, and a consistent side is what makes a column of them scannable.
    const { container } = renderDetails({ variant: "sidebar", isExpanded: true });
    const trigger = container.querySelector('[aria-expanded="true"]')!;
    const svg = trigger.querySelector("svg");
    const label = trigger.querySelector("span");
    expect(svg).toBeTruthy();
    expect(label).toBeTruthy();
    expect(
      svg!.compareDocumentPosition(label!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the chevron should precede the section label"
    ).toBeTruthy();
  });

  it("marks a sidebar section as a disclosure while it is CLOSED, not only while open", () => {
    // Flattening took away the well that used to say "this opens". Without a
    // closed-state chevron the resting Details row is a line of metadata with
    // no affordance, which is the one thing the boxes were still earning.
    const details = renderDetails({ variant: "sidebar", isExpanded: false });
    const detailsRow = details.container.querySelector('[aria-expanded="false"]')!.closest("div")!;
    expect(
      detailsRow.querySelector("svg"),
      "collapsed sidebar Details should carry a disclosure chevron"
    ).toBeTruthy();
    details.unmount();

    const terminals = renderTerminals({ variant: "sidebar", isExpanded: false });
    expect(
      terminals.container.querySelector('[aria-expanded="false"]')!.querySelectorAll("svg").length,
      "collapsed sidebar Active sessions should carry a disclosure chevron beside its own icon"
    ).toBeGreaterThan(1);
  });
});
