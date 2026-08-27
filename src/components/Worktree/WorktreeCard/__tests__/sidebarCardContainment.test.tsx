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

function renderTerminals(overrides: { variant?: "sidebar" | "grid"; isExpanded?: boolean } = {}) {
  return render(
    <TooltipProvider>
      <WorktreeTerminalSection
        worktreeId="wt-1"
        variant={overrides.variant}
        isExpanded={overrides.isExpanded ?? false}
        counts={{ total: 1, byState: {} } as never}
        terminals={[terminal]}
        onToggle={noop}
        onTerminalSelect={noop}
      />
    </TooltipProvider>
  );
}

/**
 * A "well" is the combination that makes an element read as a card: a visible
 * border AND a surface fill of its own. Either alone is a legitimate tool;
 * together, inside a row that is already a card, they add a containment level.
 */
function isWell(el: Element): boolean {
  const cls = el.className.toString();
  const hasBorder = /(^|\s|:)border(\s|$|-[trbl]\b)/.test(cls) || /\sborder\s/.test(` ${cls} `);
  const hasFill = /\bbg-surface-inset\b/.test(cls);
  return hasBorder && hasFill;
}

function wellCount(container: HTMLElement): number {
  return Array.from(container.querySelectorAll("*")).filter(isWell).length;
}

describe("sidebar card containment", () => {
  it("adds no bordered-and-filled plane of its own in the sidebar, in either disclosure state", () => {
    for (const isExpanded of [false, true]) {
      const { container, unmount } = renderDetails({ variant: "sidebar", isExpanded });
      expect(
        wellCount(container),
        `sidebar Details (expanded=${isExpanded}) introduced a nested card-like well`
      ).toBe(0);
      unmount();
    }

    for (const isExpanded of [false, true]) {
      const { container, unmount } = renderTerminals({ variant: "sidebar", isExpanded });
      expect(
        wellCount(container),
        `sidebar Active sessions (expanded=${isExpanded}) introduced a nested card-like well`
      ).toBe(0);
      unmount();
    }
  });

  it("keeps the well in the grid variant, where the card is a standalone surface", () => {
    const details = renderDetails({ variant: "grid", isExpanded: false });
    expect(wellCount(details.container)).toBeGreaterThan(0);
    details.unmount();

    const terminals = renderTerminals({ variant: "grid", isExpanded: false });
    expect(wellCount(terminals.container)).toBeGreaterThan(0);
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
});
