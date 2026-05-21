// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Issue #6963 — three interaction states (hover, focus, drop-target) on the
// worktree row used the same overlay-background axis and stacked into a muddy
// tint. The fix moves drop-target to a ring-inset axis, removes the redundant
// absolute overlay div, and suppresses hover background while a drag is active.

const cardSource = readFileSync(resolve(__dirname, "../../WorktreeCard.tsx"), "utf-8");
const sidebarCss = readFileSync(
  resolve(__dirname, "../../../../styles/components/sidebar.css"),
  "utf-8"
);
const toolbarSource = readFileSync(resolve(__dirname, "../WorktreeActionsToolbar.tsx"), "utf-8");
const detailsSource = readFileSync(resolve(__dirname, "../WorktreeDetailsSection.tsx"), "utf-8");
const terminalSectionSource = readFileSync(
  resolve(__dirname, "../WorktreeTerminalSection.tsx"),
  "utf-8"
);
const envPopoverSource = readFileSync(resolve(__dirname, "../EnvironmentPopover.tsx"), "utf-8");

describe("WorktreeCard interaction-state axes (issue #6963)", () => {
  it("uses ring-inset (no background) for the isOver drop-target", () => {
    expect(cardSource).toMatch(
      /isOver\s*&&\s*!isActive\s*&&\s*"ring-2 ring-inset ring-border-default"/
    );
  });

  it("does not stack bg-overlay-soft on the isOver branch", () => {
    expect(cardSource).not.toMatch(/isOver\s*&&[^,]*bg-overlay-(soft|subtle|strong|emphasis)/);
  });

  it("does not render the redundant absolute isOver overlay div", () => {
    expect(cardSource).not.toMatch(/isOver && !isActive && \(\s*<div/);
    expect(cardSource).not.toContain("z-50 bg-overlay-soft border-2 border-overlay");
  });

  it("suppresses the grid hover-shadow lift while a drag is active", () => {
    expect(cardSource).toContain("[html[data-dragging='true']_&]:hover:shadow-none");
  });

  it("suppresses sidebar hover background while a drag is active for both hover paths", () => {
    expect(sidebarCss).toMatch(
      /html\[data-dragging="true"\][^{]*\.sidebar-worktree-card\[data-hoverable="true"\]:hover/
    );
    expect(sidebarCss).toMatch(
      /html\[data-dragging="true"\][^{]*\.sidebar-worktree-card\[data-hovered="true"\]/
    );
  });

  it("delays the drag-handle hover reveal to filter fast cursor sweeps", () => {
    expect(cardSource).toContain("group-hover/card:delay-[50ms]");
  });
});

// Issue #7699 — When a non-main worktree row in the sidebar is active or
// focused (j/k keyboard nav or click), a single sub-line of metadata appears
// under the headline while the row remains collapsed.
describe("WorktreeCard focused sub-line (issue #7699)", () => {
  it("imports FocusedSubLine from the WorktreeCard subdirectory", () => {
    expect(cardSource).toMatch(
      /import\s*{\s*FocusedSubLine\s*}\s*from\s*"\.\/WorktreeCard\/FocusedSubLine"/
    );
  });

  it("renders FocusedSubLine with the focus/active gate, excluding main worktrees", () => {
    expect(cardSource).toMatch(
      /open=\{\s*!isMainWorktree\s*&&\s*effectiveIsCollapsed\s*&&\s*\(isActive\s*\|\|\s*isFocused\)\s*\}/
    );
  });

  it("prefers lifecycleLabel over resourceStatusLabel for the sub-line status segment", () => {
    expect(cardSource).toMatch(
      /statusLabel=\{\s*lifecycleLabel\s*\?\?\s*resourceStatusLabel\s*\?\?\s*null\s*\}/
    );
  });

  it("passes worktree.lastActivityTimestamp (not latestFileMtime) to the sub-line", () => {
    expect(cardSource).toMatch(/lastActivityTimestamp=\{\s*worktree\.lastActivityTimestamp\s*\}/);
  });
});

// Issue #8099 — polish four interaction-fidelity gaps in the worktree row:
// (1) toolbar reveal switches from :focus-within to :focus-visible so mousedown
// no longer triggers a pre-click flash; (2) terminal sub-row drag handle stays
// visible-but-dimmed instead of opacity-0 at rest; (3) ring-2 focus rings on
// resource buttons and Review & Commit migrate to outline-based vocabulary for
// forced-colors survival; (4) toolbar hover-reveal adds a 75ms delay (keyboard
// focus bypasses) to filter fast cursor sweeps across many rows.
describe("WorktreeCard row affordances polish (issue #8099)", () => {
  it("toolbar reveal uses focus-visible (not focus-within) so mousedown does not flash", () => {
    expect(toolbarSource).toContain("group-has-[:focus-visible]/card:opacity-100");
    expect(toolbarSource).not.toContain("group-focus-within/card:opacity-100");
  });

  it("toolbar hover reveal is delayed 75ms but keyboard focus bypasses the delay", () => {
    expect(toolbarSource).toContain("group-hover/card:delay-[75ms]");
    expect(toolbarSource).toContain("group-has-[:focus-visible]/card:delay-0");
    expect(toolbarSource).toContain("group-has-[[data-state=open]]/card:delay-0");
  });

  it("terminal sub-row drag handle stays visible-but-dimmed (no opacity-0 at rest)", () => {
    expect(terminalSectionSource).toContain("text-text-primary/25");
    expect(terminalSectionSource).toContain("group-hover/termrow:text-text-primary/40");
    expect(terminalSectionSource).not.toMatch(/data-drag-handle[\s\S]{0,400}opacity-0/);
  });

  it("resource action buttons use outline (not ring-2) for forced-colors survival", () => {
    expect(detailsSource).not.toMatch(/focus-visible:ring-2\s+focus-visible:ring-daintree-accent/);
    expect(detailsSource).not.toMatch(
      /focus-visible:outline-hidden\s+focus-visible:ring-2\s+focus-visible:ring-daintree-accent/
    );
  });

  it("Review & Commit button uses inset outline (-2px offset) for its flush rounded-r edge", () => {
    expect(detailsSource).toMatch(
      /rounded-r-\[var\(--radius-lg\)\][\s\S]{0,200}focus-visible:outline-offset-\[-2px\][\s\S]{0,400}aria-label="Open Review & Commit"/
    );
  });

  it("sidebar row CSS reveal rules use :has(:focus-visible) so mousedown does not flash", () => {
    expect(sidebarCss).toMatch(
      /\[data-worktree-row\]:has\(:focus-visible\)\s+\[data-worktree-row-toolbar\]/
    );
    expect(sidebarCss).not.toMatch(
      /\[data-worktree-row\]:focus-within\s+\[data-worktree-row-toolbar\]/
    );
    expect(sidebarCss).not.toMatch(
      /\[data-worktree-row\]:focus-within\s+\[data-worktree-row-drag-handle\]/
    );
  });

  it("environment popover trigger uses outline (not ring-1) for forced-colors survival", () => {
    expect(envPopoverSource).not.toMatch(
      /focus-visible:ring-1\s+focus-visible:ring-daintree-accent/
    );
    expect(envPopoverSource).toContain("focus-visible:outline-2");
  });
});

// Issue #8395 — Replace silent disable of sidebar reorder with a disabled
// drag handle. The grip always renders for non-pinned rows, but shows disabled
// styling and a tooltip when group-by-type or search is active.
describe("WorktreeCard disabled drag handle (issue #8395)", () => {
  it("accepts isDragHandleDisabled as an optional boolean prop", () => {
    expect(cardSource).toMatch(/isDragHandleDisabled\s*\?\s*:\s*boolean/);
    expect(cardSource).toMatch(/isDragHandleDisabled\s*=\s*false/);
  });

  it("renders the disabled grip with cursor-not-allowed and opacity-30", () => {
    expect(cardSource).toContain("cursor-not-allowed opacity-30");
  });

  it("sets aria-disabled on the disabled grip", () => {
    expect(cardSource).toContain('aria-disabled="true"');
  });

  it("labels the disabled grip for screen readers", () => {
    expect(cardSource).toContain('aria-label="Manual reorder paused while filter is active"');
  });

  it("shows the disabled explanation in a TooltipContent", () => {
    expect(cardSource).toContain("Manual reorder paused while filter is active");
  });

  it("wraps the disabled grip in a Tooltip with TooltipTrigger asChild", () => {
    expect(cardSource).toMatch(/isDragHandleDisabled\s*\?\s*\(\s*<Tooltip>/);
    expect(cardSource).toMatch(/<TooltipTrigger asChild>/);
  });

  it("keeps the enabled grip with cursor-grab and dragHandleListeners", () => {
    expect(cardSource).toContain("cursor-grab active:cursor-grabbing");
    expect(cardSource).toContain('aria-label="Drag to reorder"');
  });

  it("preserves the group-hover delay on the enabled grip", () => {
    expect(cardSource).toContain("group-hover/card:delay-[50ms]");
  });

  it("gates the grip block on dragHandleListeners OR isDragHandleDisabled", () => {
    expect(cardSource).toMatch(/\(dragHandleListeners\s*\|\|\s*isDragHandleDisabled\)\s*&&/);
  });
});
