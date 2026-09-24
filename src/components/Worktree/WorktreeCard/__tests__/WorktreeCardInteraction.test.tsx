// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Issue #6963 — three interaction states (hover, focus, drop-target) on the
// worktree row used the same overlay-background axis and stacked into a muddy
// tint. The fix moves drop-target to a ring-inset axis, removes the redundant
// absolute overlay div, and suppresses hover background while a drag is active.

const cardSource = readFileSync(resolve(__dirname, "../../WorktreeCard.tsx"), "utf-8");
const overviewSource = readFileSync(resolve(__dirname, "../../WorktreeOverviewModal.tsx"), "utf-8");
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

/** The grip's transition declaration, which lives in sidebar.css because the
 *  two stages run on two different timings. */
function gripTransitionRule(): string {
  // Anchored to the start of a line: the keyboard-reveal rule above ends its
  // selector list with the same attribute and would match first.
  const block = sidebarCss.match(/^\[data-worktree-row-drag-handle\]\s*{([^}]*)}/m);
  const body = block?.[1];
  if (!body) throw new Error("no [data-worktree-row-drag-handle] rule in sidebar.css");
  return body;
}

/** Resolve `transition: <prop> var(--duration-N) ...` to milliseconds. */
function transitionDurationMs(rule: string, property: string): number {
  const match = rule.match(new RegExp(`${property}\\s+var\\(--duration-(\\d+)\\)`));
  if (!match) throw new Error(`no transition entry for ${property}`);
  return Number(match[1]);
}

describe("WorktreeCard interaction-state axes (issue #6963)", () => {
  it("marks the panel drop-target via data-drop-target, painted as an inset ring in CSS", () => {
    expect(cardSource).toMatch(/data-drop-target=\{isPanelDropTarget \? "true" : undefined\}/);
    // The ring lives in sidebar.css as an inset box-shadow because the
    // unlayered base card declarations override layered Tailwind utilities.
    expect(cardSource).not.toMatch(/isOver\s*&&\s*!isActive\s*&&\s*"ring-2/);
    expect(sidebarCss).toMatch(
      /\.sidebar-worktree-card\[data-drop-target="true"\]\s*\{[^}]*inset 0 0 0 2px var\(--theme-border-strong\)/
    );
  });

  it("does not stack bg-overlay-soft on the isOver branch", () => {
    expect(cardSource).not.toMatch(/isOver\s*&&[^,]*bg-overlay-(soft|subtle|strong|emphasis)/);
  });

  it("does not render the redundant absolute isOver overlay div", () => {
    expect(cardSource).not.toMatch(/isOver && !isActive && \(\s*<div/);
    expect(cardSource).not.toContain("z-50 bg-overlay-soft border-2 border-overlay");
  });

  it("pairs any ambient hover lift with the drag guard", () => {
    // Whatever element paints the ambient hover lift must also carry the drag
    // guard, or a sort drag sweeping across it lights each one in turn. The
    // overview's rows are flat list rows now and paint no lift at all, so the
    // rule holds there with a count of zero; it still binds the card.
    for (const source of [cardSource, overviewSource]) {
      const liftCount = (source.match(/hover:shadow-\[var\(--theme-shadow-ambient\)\]/g) ?? [])
        .length;
      const guardCount = (
        source.match(/\[html\[data-dragging='true'\]_&\]:hover:shadow-none/g) ?? []
      ).length;
      expect(guardCount).toBe(liftCount);
    }
  });

  it("suppresses sidebar hover background while a drag is active, except on the drop target", () => {
    expect(sidebarCss).toMatch(
      /html\[data-dragging="true"\][^{]*\.sidebar-worktree-card\[data-hoverable="true"\]:not\(\[data-drop-target="true"\]\):hover/
    );
    expect(sidebarCss).toMatch(
      /html\[data-dragging="true"\][^{]*\.sidebar-worktree-card\[data-hovered="true"\]:not\(\[data-drop-target="true"\]\)/
    );
  });

  it("reveals the drag-handle dots on the fast tier, with nothing gating them", () => {
    // Was a 50ms delay on a 150ms fade, to filter fast cursor sweeps. The
    // dots appear directly under a pointer that is already sitting on them,
    // so the filtering cost more than it bought: the mark arrived after the
    // eye had landed on the spot it was going to occupy, which reads as lag
    // rather than as motion.
    //
    // Assert the rule, not the number: opacity resolves faster than the
    // 150ms state-change tier the backplate uses, and no delay stands in
    // front of it.
    const rule = gripTransitionRule();
    const opacityMs = transitionDurationMs(rule, "opacity");
    const plateMs = transitionDurationMs(rule, "background-color");
    expect(opacityMs).toBeGreaterThan(0);
    expect(opacityMs).toBeLessThan(plateMs);
    expect(cardSource).not.toContain("delay-[50ms]");
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
    expect(toolbarSource).toContain("group-hover/card:delay-75");
    expect(toolbarSource).toContain("group-has-[:focus-visible]/card:delay-0");
    expect(toolbarSource).toContain("group-has-[[data-state=open]]/card:delay-0");
  });

  it("session-row grip reveals the way the card's own grip does", () => {
    // #8099 kept this grip visible-but-dimmed because the card's grip was;
    // the card's grip has since moved to absent-at-rest with a hover and
    // keyboard-focus reveal, and the session grip follows it rather than
    // being the one permanent handle column in the card.
    const rules = [...sidebarCss.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .map(([, selector, body]) => ({
        selectors: selector!
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split(",")
          .map((part) => part.trim().replace(/\s+/g, " ")),
        body: body!,
      }))
      .filter((rule) => rule.selectors.some((sel) => sel.includes("[data-session-grip]")));

    const rest = rules.filter((rule) => rule.selectors.includes("[data-session-grip]"));
    expect(rest.map((rule) => rule.body).join(";")).toMatch(/opacity:\s*0\s*;/);
    expect(rest.map((rule) => rule.body).join(";")).toMatch(/pointer-events:\s*none/);

    const reveals = rules.filter((rule) => /opacity:\s*1\s*;/.test(rule.body));
    const revealSelectors = reveals.flatMap((rule) => rule.selectors);
    // Hover alone and keyboard focus alone each reveal it, as separate
    // alternatives rather than one selector that needs both.
    expect(revealSelectors).toContain("[data-session-row]:hover [data-session-grip]");
    expect(revealSelectors).toContain("[data-session-row]:has(:focus-visible) [data-session-grip]");
    for (const rule of reveals) expect(rule.body).toMatch(/pointer-events:\s*auto/);
    // Mouse focus from clicking a row must not strand a visible grip on it.
    for (const rule of rules) {
      expect(rule.selectors.join(",")).not.toContain(":focus-within");
    }

    // Solid tokens at rest and on hover, the hover one the brighter.
    const handle = terminalSectionSource.slice(
      terminalSectionSource.indexOf("data-session-grip"),
      terminalSectionSource.indexOf("data-session-grip") + 400
    );
    expect(handle).toMatch(/(^|\s)text-text-secondary\b/);
    expect(handle).toMatch(/(^|\s)hover:text-text-primary\b/);
    expect(handle).not.toMatch(/text-text-\w+\/\d/);
  });

  it("resource action buttons use outline (not ring-2) for forced-colors survival", () => {
    expect(detailsSource).not.toMatch(
      /focus-visible:ring-2\s+focus-visible:ring-(?:daintree-accent|accent-primary)(?![\w-])/
    );
    expect(detailsSource).not.toMatch(
      /focus-visible:outline-hidden\s+focus-visible:ring-2\s+focus-visible:ring-(?:daintree-accent|accent-primary)(?![\w-])/
    );
  });

  it("Review & Commit button keeps an inset focus ring and clears the 24px target floor", () => {
    // It used to be a fenced right segment in the grid — a left border plus a
    // right-rounded cap — which read as a split pill with an unlabelled second
    // half. Both variants now draw it as a trailing icon button. What must
    // survive that is the inset ring (it sits flush inside a row, so a
    // positive offset would be clipped) and the SC 2.5.8 target size.
    const button = detailsSource.slice(
      Math.max(0, detailsSource.indexOf("aria-label={`Open ${reviewHubButtonLabel}`}") - 1200),
      detailsSource.indexOf("aria-label={`Open ${reviewHubButtonLabel}`}")
    );
    expect(button).toContain("focus-visible:outline-offset-[-2px]");
    expect(button).toMatch(/min-h-6[\s\S]*min-w-6|min-w-6[\s\S]*min-h-6/);
    // No fence: the grid's border-l + rounded-r pair is gone from this button.
    expect(button).not.toContain("border-l");
    expect(button).not.toContain("rounded-r-[var(--radius-lg)]");
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
      /focus-visible:ring-1\s+focus-visible:ring-(?:daintree-accent|accent-primary)(?![\w-])/
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

  it("hides the pointer-only grips from assistive tech instead of dead aria-labels", () => {
    // The grips are role-less and non-focusable (SortableWorktreeCard strips
    // dnd-kit's role/tabIndex), so an aria-label would claim a phantom
    // control — keyboard reorder is the row's Alt+Arrow path.
    expect(cardSource).not.toContain('aria-label="Drag to reorder"');
    expect(cardSource).not.toContain('aria-label="Manual reorder paused while filter is active"');
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
    expect(cardSource).toContain("{...dragHandleListeners}");
  });

  it("leaves the enabled grip's reveal timing to the stylesheet", () => {
    // Two properties, two durations — a Tailwind `duration-*` utility cannot
    // express that, so the grip must not carry one at all or it would flatten
    // both channels onto whichever value it names.
    expect(cardSource).not.toMatch(/data-worktree-row-drag-handle[\s\S]{0,600}?duration-\d+/);
    expect(gripTransitionRule()).toContain("opacity");
  });

  it("gates the grip block on dragHandleListeners OR isDragHandleDisabled", () => {
    // The gate is a named flag rather than the expression inlined at each use
    // site: the card reads it three times now (the grip, the body padding, and
    // the data attribute the footer aligns off), and three copies of the same
    // condition is three chances for them to disagree about whether the row
    // has a grip. Assert the definition and that nothing has drifted back to
    // testing the raw expression in place.
    expect(cardSource).toMatch(
      /const hasRowDragHandle =\s*Boolean\(dragHandleListeners\)\s*\|\|\s*isDragHandleDisabled;/
    );
    expect(cardSource).toMatch(/\{hasRowDragHandle &&/);
  });
});

// Issue #12087 — Retry/Dismiss on the delete and issue error banners were dead
// on sidebar cards. Both banners mount as bare siblings of the card's content
// column inside a `relative isolate` root that also carries the sidebar's
// full-card select overlay at `absolute inset-0 z-0`. A static in-flow block
// paints in an earlier step than a positioned `z-0` sibling no matter the DOM
// order (CSS 2.1 Appendix E), so the overlay covered the banners and, since
// hit-testing follows paint order, swallowed every click.
//
// jsdom has no layout engine and loads no CSS, so the real coordinate check is
// impossible here — this asserts the ORDERING that makes it true. Renumbering
// either tier keeps the test green; breaking the relationship fails it.

/** Positioning/stacking tokens carried by one element's Tailwind class list. */
function stackingTokens(classList: string): { positioned: boolean; z: number | null } {
  const tokens = classList.split(/\s+/).filter(Boolean);
  const positioned = tokens.some((t) => ["relative", "absolute", "fixed", "sticky"].includes(t));
  const zToken = tokens.filter((t) => /^z-\d+$/.test(t)).pop();
  return { positioned, z: zToken ? Number(zToken.slice(2)) : null };
}

/** A z-tier that must exist — fails with the element's name rather than
 *  comparing against null (or asserting the type away). */
function requireZ(label: string, tokens: { z: number | null }): number {
  if (tokens.z === null) throw new Error(`${label} carries no z-* utility`);
  return tokens.z;
}

/** The single opening tag carrying `attribute`, and nothing past its `>`. The
 *  `[^>]*` fences keep the match inside one element, so a className lifted out
 *  of it can never belong to a descendant however the attributes are ordered. */
function openingTagWith(source: string, tag: string, attribute: string): string {
  const found = source.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}[^>]*>`))?.[0];
  if (found === undefined) throw new Error(`no <${tag}> carrying ${attribute}`);
  return found;
}

/** The sidebar select overlay's class string, anchored on its unique attribute. */
function selectOverlayClasses(): string {
  const tag = openingTagWith(cardSource, "button", 'data-card-select-overlay=""');
  const classes = tag.match(/className=\{cn\(\s*"([^"]+)"/)?.[1];
  if (classes === undefined) {
    throw new Error("no className={cn(...)} on the [data-card-select-overlay] button");
  }
  return classes;
}

/** A banner root's class string, anchored on its unique test id. */
function bannerRootClasses(testId: string): string {
  const tag = openingTagWith(detailsSource, "div", `data-testid="${testId}"`);
  const classes = tag.match(/className="([^"]+)"/)?.[1];
  if (classes === undefined) throw new Error(`no root className for [data-testid="${testId}"]`);
  return classes;
}

describe("worktree error banner stacking (issue #12087)", () => {
  it("renders both banners from the card", () => {
    // Named for what it actually proves: the card still mounts them. Every
    // other test here reads the banner definitions or renders the exports
    // directly, so deleting these two blocks from WorktreeCard would otherwise
    // leave the whole suite green. It says nothing about WHERE they sit.
    expect(cardSource).toMatch(/\{deleteError && \(\s*<WorktreeDeleteErrorBanner/);
    expect(cardSource).toMatch(/\{issueError && \(\s*<WorktreeIssueErrorBanner/);
  });

  it("gives the select overlay a positioned, z-indexed full-card layer", () => {
    // Guards the ordering assertions from passing vacuously if the overlay's
    // class string ever stops being extractable.
    const overlay = stackingTokens(selectOverlayClasses());
    expect(overlay.positioned).toBe(true);
    expect(overlay.z).not.toBeNull();
  });

  it.each([["worktree-delete-error-banner"], ["worktree-issue-error-banner"]])(
    "%s is positioned above the select overlay so its buttons take the click",
    (testId) => {
      const overlayZ = requireZ("the select overlay", stackingTokens(selectOverlayClasses()));
      const banner = stackingTokens(bannerRootClasses(testId));

      // A z-index on a static element is inert — both halves are required.
      expect(banner.positioned).toBe(true);
      expect(requireZ(testId, banner)).toBeGreaterThan(overlayZ);
    }
  );
});

// The collapsed alarm mark is a non-focusable span, so the select overlay is
// where a keyboard user meets it. WorktreeHeader.test proves the header puts
// the alarm's words at `collapsedAlarmDescriptionId(worktree.id)` and opens the
// tooltip from `isKeyboardFocused`; this is the card's half of each contract.
describe("collapsed alarm reaches the select overlay", () => {
  it("describes the overlay by every mounted row mark", () => {
    // Each part is gated on the same condition that mounts its node:
    // `selectButtonDescribedBy` drops the unmounted ones, so a wrong gate here
    // is a dangling IDREF or a silent mark.
    const tag = openingTagWith(cardSource, "button", 'data-card-select-overlay=""');
    const call = tag.match(
      /aria-describedby=\{selectButtonDescribedBy\(worktree\.id, \{([^}]*)\}\)\}/
    );
    expect(
      call,
      "the overlay's aria-describedby is not built by selectButtonDescribedBy"
    ).not.toBeNull();
    const gates = call![1]!;
    expect(gates).toMatch(/lifecycle:\s*chipState !== null/);
    expect(gates).toMatch(/alarm:\s*!!effectiveIsCollapsed/);
    expect(gates).toMatch(/external:\s*isExternal/);
  });

  it("mounts the lifecycle description beside the tick, sidebar only", () => {
    expect(cardSource).toMatch(
      /\{chipState !== null && variant === "sidebar" && \([\s\S]{0,400}<span id=\{worktreeRowDescriptionId\(worktree\.id, "lifecycle"\)\} hidden>\s*\{CHIP_LABELS\[chipState\]\}/
    );
  });

  it("tracks the overlay's keyboard focus and hands it to the header", () => {
    const tag = openingTagWith(cardSource, "button", 'data-card-select-overlay=""');
    expect(tag).toMatch(/onFocus=\{handleSelectFocus\}/);
    expect(tag).toMatch(/onBlur=\{handleSelectBlur\}/);
    // Focus-visible only: a pointer click focuses the overlay too, and a click
    // that selected the row should not also pop the alarm open under it.
    expect(cardSource).toMatch(/handleSelectFocus[\s\S]{0,200}matches\(":focus-visible"\)/);
    expect(openingTagWith(cardSource, "WorktreeHeader", "isKeyboardFocused=")).toMatch(
      /isKeyboardFocused=\{isSelectFocusVisible\}/
    );
  });
});
