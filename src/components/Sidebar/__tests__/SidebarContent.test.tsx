import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { DROP_INDICATOR_LINE } from "@/components/DragDrop/dropIndicator";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");
const SEARCH_BAR_PATH = path.resolve(__dirname, "../../Worktree/WorktreeSidebarSearchBar.tsx");
const BADGE_PATH = path.resolve(__dirname, "../WorktreesReconnectingBadge.tsx");
const LOAD_ERROR_BANNER_PATH = path.resolve(__dirname, "../WorktreeLoadErrorBanner.tsx");
const STATIC_ROW_PATH = path.resolve(__dirname, "../StaticWorktreeRow.tsx");
const SORTABLE_CARD_PATH = path.resolve(__dirname, "../../DragDrop/SortableWorktreeCard.tsx");
const WORKTREE_CARD_PATH = path.resolve(__dirname, "../../Worktree/WorktreeCard.tsx");
const WORKTREE_ACTIONS_TOOLBAR_PATH = path.resolve(
  __dirname,
  "../../Worktree/WorktreeCard/WorktreeActionsToolbar.tsx"
);
const KEYBOARD_HOOK_PATH = path.resolve(__dirname, "../useWorktreeSidebarKeyboard.ts");
// The row model and the reorder session live beside SidebarContent (#14351);
// assertions about that code read the module that owns it.
const ROW_MODEL_PATH = path.resolve(__dirname, "../sidebarWorktreeModel.ts");
const MODEL_HOOK_PATH = path.resolve(__dirname, "../useSidebarWorktreeModel.ts");
const REORDER_HOOK_PATH = path.resolve(__dirname, "../useSidebarReorderSession.ts");

describe("SidebarContent filter scope and sort status — issue #8391", () => {
  let source: string;
  let searchBarSource: string;
  let rowModelSource: string;
  let modelHookSource: string;
  let reorderSource: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    searchBarSource = await fs.readFile(SEARCH_BAR_PATH, "utf-8");
    rowModelSource = await fs.readFile(ROW_MODEL_PATH, "utf-8");
    modelHookSource = await fs.readFile(MODEL_HOOK_PATH, "utf-8");
    reorderSource = await fs.readFile(REORDER_HOOK_PATH, "utf-8");
  });

  it("keeps the visible status text free of live-region attributes (#9665)", () => {
    // The status line mixes a dynamic filter count with persistent
    // sort-disabled text. role="status" carries an implicit aria-atomic, so a
    // live region here re-announced the whole line — including the persistent
    // text — on every keystroke. Announcements are now routed through the
    // debounced global announcer instead.
    const start = searchBarSource.indexOf("{statusText &&");
    expect(start).toBeGreaterThan(-1);
    const region = searchBarSource.slice(start, start + 400);
    expect(region).not.toContain('role="status"');
    expect(region).not.toContain("aria-live");
    expect(region).not.toContain("aria-atomic");
  });

  it("renders the visual count as 'N of M worktrees' from filteredCount", () => {
    // Both halves count the pinned main card, which is facet-filtered and on
    // screen: without it, selecting "Main" read "0 of 6" above a visible main.
    expect(source).toContain("`${filteredCount} of ${scopeTotal} worktrees`");
    expect(source).toMatch(/filteredWorktrees\.length \+ \(mainVisible \? 1 : 0\)/);
    expect(source).toMatch(/totalCount \+ \(mainWorktree \? 1 : 0\)/);
  });

  it("shows the scope line for the search and facets only, never for a state segment", () => {
    // The state segments count the same narrowed set the list shows, main
    // included, so there is no second scope to footnote. A segment shows its
    // own choice and count on the bar; a line appearing above the bar on click
    // pushed it out from under the pointer that had just pressed it.
    const start = source.indexOf("const scopeText =");
    expect(start).toBeGreaterThan(-1);
    const region = source.slice(start, start + 320);
    expect(region).toMatch(/showScope && \(hasQuery \|\| hasFacetFiltersActive\)/);
    expect(region).not.toContain("state tabs ignore search");
  });

  it("hands the bar the scope and the filter identity as separate parts", () => {
    // Concatenated onto one line beside a non-shrinking "Clear all", the count
    // took the width and the filter names truncated away first — and the names
    // are the part the count cannot substitute for.
    expect(source).toMatch(/statusText=\{filterStatusText\}/);
    expect(source).toMatch(/filterSummaryText=\{activeFacetText \|\| null\}/);
  });

  it("names the active filters in the status line, not just their number", () => {
    // A count says the list is cut down; it does not say what cut it, so a
    // sparse sidebar still read as an empty one.
    expect(source).toContain("describeActiveFacets({");
    // Reaching the bar — asserting only that the helper is called somewhere
    // would pass with its result thrown away.
    expect(source).toMatch(/filterSummaryText=\{activeFacetText \|\| null\}/);
  });

  it("gates the scope text on showScope and falls back through the drag reason", () => {
    expect(source).toMatch(/scopeText\s*=\s*showScope\s*&&/);
    // The reorder note is what is left when there is nothing else to say —
    // it is a standing explanation, not news, so it no longer outranks the
    // scope and the filter identities by consuming the line alongside them.
    expect(source).toMatch(/scopeText \?\? dragDisabledReason/);
  });

  it("hands the same drag reason to each row's grip tooltip", () => {
    // One sentence, one source: the grip tooltip and the status line must
    // not be able to disagree about why reorder is off.
    const rowSource = readFileSync(path.resolve(__dirname, "../SidebarWorktreeRow.tsx"), "utf-8");
    expect(source).toMatch(/dragDisabledReason=\{context\.dragDisabledReason\}/);
    expect(source).toMatch(/isSortDisabled,\s*dragDisabledReason,\s*\}\)/);
    expect(rowSource).toMatch(/dragDisabledReason=\{dragDisabledReason\}/);
  });

  it("derives drag-disabled reason with query taking priority over group-by-type", () => {
    // Query-first precedence: hasQuery ? "searching" : isGroupedByType ? "grouped by type" : null
    expect(reorderSource).toMatch(/hasQuery\s*\?[\s\S]*?Drag to reorder is off while searching/);
    expect(reorderSource).toMatch(
      /isGroupedByType\s*\?[\s\S]*?Drag to reorder is off while grouped by type/
    );
  });

  it("exports totalCount from the filter useMemo alongside filteredWorktrees", () => {
    // Both the grouped and ungrouped return paths must report the same total,
    // so assert the count rather than mere presence.
    expect(rowModelSource.match(/totalCount: nonMainWorktrees\.length/g)).toHaveLength(2);
  });

  it("derives every non-main count and the filtered list from one shared array (#11433)", () => {
    // The quick-state bar read "All 0" above a visible worktree because the
    // counts carried a branch-name exclusion the rendered list did not. Every
    // consumer now reads the same `nonMainWorktrees` memo, so they cannot
    // disagree about which worktrees exist.
    expect(modelHookSource).toMatch(
      /const nonMainWorktrees = useMemo\(\s*\(\) =>\s*deferredWorktrees\.filter\(\(w\) => w\.id !== mainWorktree\?\.id\)/
    );
    // The quick-state bar sits over every card it filters, main included, so
    // its counts describe the narrowed set the cards come from: every worktree
    // the search and facets leave, with no exclusion the list lacks. "All" is
    // the number the user saw read 0 above a visible worktree, so tie it to
    // that set directly — iterating it is not enough, the old code iterated
    // too and then skipped the worktree it had already pinned.
    expect(modelHookSource).toMatch(
      /const narrowedWorktrees = isNarrowed\s*\?\s*deferredWorktrees\.filter\(/
    );
    expect(modelHookSource).toMatch(/all: narrowedWorktrees\.length/);
    expect(modelHookSource).toMatch(/for \(const w of narrowedWorktrees\)/);
    // Chip counts read a population derived from the same shared array but
    // deliberately WIDER: the main worktree is not a list row yet is still
    // facet-filtered, so excluding it made every facet only it satisfies read
    // zero — and a zero count now disables the chip. The rule is that the
    // counted set is a superset of the rendered set, never a subset.
    // Main is added because it is facet-filtered; quick-state is applied to it
    // and the rest because the cards are, so a chip cannot promise matches the
    // quick state has already excluded.
    expect(modelHookSource).toMatch(/const countedWorktrees = useMemo\(/);
    expect(modelHookSource).toMatch(
      /mainEligible && mainWorktree \? \[mainWorktree, \.\.\.eligible\] : eligible/
    );
    expect(modelHookSource).toMatch(
      /const eligible =\s*quickStateFilter === "all"\s*\?\s*nonMainWorktrees\s*:\s*nonMainWorktrees\.filter\(/
    );
    expect(modelHookSource).toMatch(/matchesQuickStateFilter\(quickStateFilter, meta\)/);
    expect(modelHookSource).toMatch(/computeChipCounts\(\s*countedWorktrees,/);
    expect(rowModelSource).toMatch(/const filtered = nonMainWorktrees\.filter\(/);
    // No second, branch-derived exclusion anywhere in the sidebar: neither the
    // removed helper nor a fresh hardcoded list of "integration" branch names.
    // `next` is deliberately absent from this alternation — it's a plausible
    // ordinary string in UI code, and a false failure here teaches nothing.
    for (const owner of [source, modelHookSource, rowModelSource]) {
      expect(owner).not.toMatch(/integrationWorktree|findIntegrationWorktree/);
      expect(owner).not.toMatch(/["'](?:develop|trunk)["']/);
    }
  });

  it("computes showScope from the instant live-query filter state and count comparison", () => {
    // Compared against the same total the scope line prints, which now counts
    // the pinned main card in both halves.
    expect(source).toMatch(/showScope\s*=\s*hasFilters\s*&&\s*filteredCount\s*!==\s*scopeTotal/);
    // hasFilters mirrors the store's hasActiveFilters() but uses liveQuery so the
    // scope line reacts immediately rather than after the persisted-query debounce.
    expect(source).toMatch(/hasFilters\s*=\s*[\s\S]*?liveQuery\.trim\(\)\.length\s*>\s*0/);
  });

  it("defers the filtering memo only for a sidebar large enough to hold up typing", () => {
    // Small sidebars filter in the keystroke's own frame; past the threshold
    // the memo reads the lagged query so keystrokes stay responsive.
    expect(modelHookSource).toContain("const laggedQuery = useDeferredValue(liveQuery)");
    expect(modelHookSource).toMatch(
      /deferredWorktrees\.length > SIDEBAR_DEFER_FILTER_MIN_WORKTREES \? laggedQuery : liveQuery/
    );
    expect(modelHookSource).toMatch(/query:\s*deferredQuery/);
    expect(rowModelSource).toMatch(/query:\s*deferredQuery/);
  });
});

describe("SidebarContent screen-reader announcements — issue #9665", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("debounces the count announcement on the shared Doherty threshold", () => {
    expect(source).toContain('import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils"');
    // The count announcement is scheduled on a timer cleared on re-run, so
    // rapid keystrokes coalesce into a single late announcement.
    // The template is what gets spoken: `message` is the empty list's reason
    // when there is one and the count otherwise, copied to `spoken` for the
    // closure, and that is what the timer announces.
    expect(source).toMatch(
      /message = listEmptyTitle \?\? `\$\{filteredCount\} of \$\{scopeTotal\} worktrees`/
    );
    expect(source).toMatch(/const spoken = message;/);
    expect(source).toMatch(
      /setTimeout\([\s\S]*?announce\(spoken\)[\s\S]*?\},\s*UI_DOHERTY_THRESHOLD\)/
    );
    expect(source).toMatch(/clearTimeout\(timer\)/);
  });

  it("stays silent until the list is first narrowed, then speaks both ways", () => {
    // Opening a project must not announce its own worktree count. But once the
    // user has narrowed the list, clearing the last filter is the moment they
    // most need it confirmed — and bailing out on `!showScope` said nothing at
    // all there, so returning to everything was the one transition with no
    // feedback.
    // Gated on mount having happened, not on the list having been narrowed:
    // the old flag let an already-filtered first render announce, and skipped a
    // change between two different result sets of the same size.
    // Not a "first run is mount" flag: that flips on the loading render, so the
    // first real snapshot after it announced the project's own count on open.
    // The gate is the narrowed -> not-narrowed edge, and only once the deferred
    // rows have caught up with the instant query.
    expect(source).not.toMatch(/hasMountedScope/);
    expect(source).toMatch(/if \(showScope\) \{[\s\S]{0,400}?wasNarrowedRef\.current = true/);
    expect(source).toMatch(
      /else if \(wasNarrowedRef\.current && filteredCount === scopeTotal\) \{[\s\S]{0,120}?All \$\{scopeTotal\} worktrees shown/
    );
    // Keyed on the filter inputs too, so a same-size swap still speaks.
    expect(source).toMatch(/activeFacetText,\s*liveQuery,\s*quickStateFilter/);
  });

  it("announces the sort-disabled reason on appear/change but not on re-enable", () => {
    // Fires on null → reason and reason → reason, but not reason → null (the
    // re-enable path is owned by the isSortDisabledPrevRef effect) and not when
    // the reason is unchanged (so a stable reason isn't re-spoken every render).
    const reorderSource = readFileSync(REORDER_HOOK_PATH, "utf-8");
    expect(reorderSource).toContain("prevDragDisabledReasonRef");
    expect(reorderSource).toMatch(/dragDisabledReason !== null && prev !== dragDisabledReason/);
  });
});

describe("SidebarContent accessibility — issue #9662", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  describe("reconnecting indicator — one-shot screen-reader announcement", () => {
    it("hides the per-tick visual reconnecting span from the accessibility tree", async () => {
      // The visible "Reconnecting… last updated Xs ago" text is rewritten every
      // second by the 1Hz tick. If it stayed inside an aria-live region the AT
      // would re-announce on every tick. The span must be aria-hidden so those
      // mutations never reach assistive tech.
      expect(source).toMatch(/\{showReconnecting && \(\s*<WorktreesReconnectingBadge/);
      const span = await fs.readFile(BADGE_PATH, "utf-8");
      // The badge's root is aria-hidden, before anything it renders.
      expect(span).toMatch(/return \(\s*<span\s+aria-hidden="true"/);
      // The ticking relative time must live inside the aria-hidden span.
      expect(span).toMatch(/formatRelativeTime\(escalatedSince\)/);
      // And the live-region attributes must be gone from that span.
      expect(span).not.toMatch(/role="status"/);
      expect(span).not.toMatch(/aria-live=/);
    });

    it("announces once via the announcer store on the rising edge of reconnecting", () => {
      // One-shot announcements replace the tick-churned live region: imperative
      // announce() calls routed through document.ariaNotify (Chromium 146).
      expect(source).toMatch(
        /import \{ useAnnouncerStore \} from "@\/store\/accessibilityAnnouncerStore"/
      );
      expect(source).toMatch(
        /useAnnouncerStore\.getState\(\)\.announce\("Reconnecting…", "polite"\)/
      );
      expect(source).toMatch(
        /useAnnouncerStore\.getState\(\)\.announce\("Still reconnecting…", "polite"\)/
      );
    });

    it("edge-detects transitions with refs so it fires once, not on every tick", () => {
      // Refs track the previous reconnecting/escalated values; the announce
      // calls are guarded by a false→true edge check, so the 1Hz re-render
      // never re-announces.
      expect(source).toMatch(/prevReconnecting\.current/);
      expect(source).toMatch(/prevEscalated\.current/);
      expect(source).toMatch(/if \(showReconnecting && !prevReconnecting\.current\)/);
      // Escalation is also gated on the Doherty-gated `showReconnecting` so a
      // mid-outage remount can't fire "Still reconnecting…" before the base
      // "Reconnecting…" announcement and invert their order (issue #10318).
      expect(source).toMatch(
        /if \(showReconnecting && showReconnectingEscalated && !prevEscalated\.current\)/
      );
      // …and the escalated edge-tracker is gated the same way, so the remount
      // doesn't consume the edge before the base announcement lands and drop
      // "Still reconnecting…" permanently (issue #10318).
      expect(source).toMatch(
        /prevEscalated\.current = showReconnecting && showReconnectingEscalated;/
      );
    });
  });

  describe("refresh button — aria-disabled preserves keyboard focus", () => {
    it("uses aria-disabled instead of the native disabled attribute", () => {
      // Native disabled drops keyboard focus to <body>; aria-disabled keeps the
      // button focusable while the re-entry guard in handleRefreshAll blocks
      // activation.
      const refreshButton = source.match(
        /<(?:button|Button)[^>]*onClick=\{handleRefreshAll\}[\s\S]*?aria-label="Refresh sidebar"/
      );
      expect(refreshButton).not.toBeNull();
      const button = refreshButton![0];
      expect(button).toMatch(/aria-disabled=\{isRefreshing \|\| undefined\}/);
      // Reject ANY native disabled binding on the button (not just the literal
      // disabled={isRefreshing}), since aria-disabled is the whole point.
      // The [^-] guard keeps this from matching aria-disabled.
      expect(button).not.toMatch(/[^-]disabled=\{/);
    });

    it("styles the busy state with aria-disabled: variants but never dims it", () => {
      // Busy, not unavailable (see ARIA_DISABLED_CLASSES): the spinner is the
      // only sign a refresh is running, so fading the button fades the signal.
      const refreshButton = source.match(
        /<(?:button|Button)[^>]*onClick=\{handleRefreshAll\}[\s\S]*?aria-label="Refresh sidebar"/
      );
      const button = refreshButton![0];
      expect(button).not.toMatch(/aria-disabled:opacity-/);
      expect(button).toMatch(/aria-disabled:cursor-not-allowed/);
      expect(button).not.toMatch(/[^-]disabled:opacity-\d+/);
    });

    it("keeps the handleRefreshAll re-entry guard that suppresses activation", () => {
      // aria-disabled does not natively block click/Enter/Space, so the JS guard
      // is what actually prevents a second refresh.
      expect(source).toMatch(
        /const handleRefreshAll = useCallback\(\(\) => \{\s*if \(isRefreshing\) return;/
      );
    });
  });
});

/**
 * The fixed control zone at the top of the Worktrees sidebar — the title row,
 * the search/filter rail, and the status line under them (#11991).
 *
 * These assert rules about how the zone is composed, not the particular
 * spacing values it is composed from, so a later density pass restates the
 * numbers in one place instead of here as well.
 */
const WORKSPACE_SIDEBAR = path.resolve(__dirname, "../WorkspaceRootSidebar.tsx");
const SIDEBAR_HEADER = path.resolve(__dirname, "../sidebarHeader.ts");
/** Unique to the rail's own element — the bare class name also appears in prose. */
const RAIL_MARKER = 'variant === "sidebar" && "worktree-filter-bar"';

/**
 * The class string of the row element that carries `marker`.
 *
 * Comments are stripped first: both rows explain themselves in a comment
 * between `cn(` and its first argument, and one of the markers also appears in
 * the file's own doc block.
 */
function rowClasses(chunk: string, marker: string): string {
  const stripped = chunk.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const at = stripped.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const from = stripped.lastIndexOf("<div", at);
  expect(from).toBeGreaterThan(-1);
  // Window past the marker: the class string it identifies continues beyond it.
  const slice = stripped.slice(from, from + 600);
  return slice.match(/className=(?:"|\{cn\([^"]*")([^"]*)"/)?.[1] ?? "";
}

function inset(classes: string): string | null {
  return classes.match(/\bpx-[\d.]+\b/)?.[0] ?? null;
}

describe("Worktrees sidebar control zone — issue #11991", () => {
  let sidebar: string;
  let searchBar: string;
  let workspaceSidebar: string;
  let headerRow: string;

  beforeAll(async () => {
    sidebar = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    searchBar = await fs.readFile(SEARCH_BAR_PATH, "utf-8");
    workspaceSidebar = await fs.readFile(WORKSPACE_SIDEBAR, "utf-8");
    const shared = await fs.readFile(SIDEBAR_HEADER, "utf-8");
    headerRow = shared.match(/SIDEBAR_HEADER_ROW = "([^"]*)"/)?.[1] ?? "";
  });

  it("draws the header's rule only when no control zone renders below it", () => {
    // The header used to draw a rule and the rail drew another, putting two
    // hairlines inside the first 90px of the sidebar with the list's own
    // dividers immediately below. The header owns a rule only when it is the
    // last row of the zone; otherwise the rail below it carries one.
    const header = rowClasses(sidebar, "group/header");
    expect(header).not.toMatch(/(?:^|\s)border-b(?:\s|$)/);
    expect(sidebar).toMatch(/!showControlZone && "border-b border-divider"/);

    const rail = rowClasses(searchBar, RAIL_MARKER);
    expect(rail).toMatch(/\bborder-b\b/);
  });

  it("keeps the header and the rail on one horizontal inset", () => {
    // Three competing left margins in 90px of height — the title at one inset,
    // the field container at another — is what made the zone read as two
    // separately framed bands rather than one control zone.
    expect(sidebar).toMatch(/cn\(\s*SIDEBAR_HEADER_ROW,\s*"group\/header/);
    const headerInset = inset(headerRow);
    const railInset = inset(rowClasses(searchBar, RAIL_MARKER));
    expect(headerInset).not.toBeNull();
    expect(railInset).not.toBeNull();
    expect(headerInset).toBe(railInset);
  });

  it("gives every header branch, in every workspace kind, one fixed row height", () => {
    // Loading, empty and loaded all render the same landmark row, and so does
    // the non-git workspace sidebar; if their heights diverge the sidebar's
    // contents jump as a project resolves or the workspace kind changes. One
    // shared row with a fixed height — not padding around whatever sits in it —
    // is what holds them together.
    expect(headerRow).toMatch(/(?:^|\s)h-\d+(?:\s|$)/);
    expect(headerRow).not.toMatch(/\bpy-/);

    const worktreeBranches = sidebar.match(/className=\{(?:cn\(\s*)?SIDEBAR_HEADER_ROW\b/g) ?? [];
    expect(worktreeBranches.length).toBeGreaterThanOrEqual(3);
    expect(workspaceSidebar).toMatch(/cn\(\s*SIDEBAR_HEADER_ROW\b/);

    // No branch sizes itself around the shared row.
    for (const source of [sidebar, workspaceSidebar]) {
      for (const m of source.matchAll(/cn\(\s*SIDEBAR_HEADER_ROW,\s*"([^"]*)"/g)) {
        expect(m[1]).not.toMatch(/(?:^|\s)(?:h|py|min-h)-/);
      }
    }
  });

  it("draws the reconnecting spinner with the shared Spinner, which owns reduced motion", async () => {
    const badge = await fs.readFile(
      path.resolve(__dirname, "../WorktreesReconnectingBadge.tsx"),
      "utf-8"
    );
    expect(badge).toMatch(/<Spinner\b/);
    // A hand-wrapped spin is what drifted from reduced motion before.
    expect(badge).not.toMatch(/\banimate-spin\b/);
  });
});

describe("SidebarContent quick-state empty state — issue #6333 (CTA collapsed by #6934)", () => {
  let source: string;
  let rowModelSource: string;
  let modelHookSource: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    rowModelSource = await fs.readFile(ROW_MODEL_PATH, "utf-8");
    modelHookSource = await fs.readFile(MODEL_HOOK_PATH, "utf-8");
  });

  describe("store wiring", () => {
    it("subscribes to clearAll from the filter store as clearAllFilters", () => {
      expect(modelHookSource).toMatch(
        /const clearAllFilters = useWorktreeFilterStore\(\(state\) => state\.clearAll\)/
      );
    });

    it("does not subscribe to clearQuickStateFilter (single-CTA shape since #6934)", () => {
      expect(source).not.toContain("state.clearQuickStateFilter");
      expect(modelHookSource).not.toContain("state.clearQuickStateFilter");
    });
  });

  describe("facet filter bypass gate", () => {
    it("gates the alwaysShowActive and alwaysShowWaiting bypasses on hasFacetFiltersActive", () => {
      // The bypass rules must additionally require !hasFacetFiltersActive so that
      // selecting a popover facet filter (status/type/github/session/activity)
      // suppresses bypass injection and makes the visible list agree with chip counts.
      expect(rowModelSource).toMatch(/quickStateFilter === "all"\s*&&\s*!hasFacetFiltersActive/);
      expect(rowModelSource).toContain("hasFacetFilters");
    });

    it("subscribes to hasFacetFilters from the worktree filter store", () => {
      // Called inside the selector: the compiled hook would cache a render-time
      // call on the selected getter and freeze the facet gate.
      expect(modelHookSource).toContain(
        "useWorktreeFilterStore((state) => state.hasFacetFilters())"
      );
    });
  });

  describe("filteredWorktrees memo", () => {
    it("computes the counterfactual only when quickStateFilter is non-'all'", () => {
      expect(rowModelSource).toMatch(
        /if \(quickStateFilter !== "all"\) \{\s*if \(alwaysShowActive/
      );
    });

    it("mirrors the same alwaysShowActive bypass in the counterfactual pass", () => {
      // The counterfactual must respect alwaysShowActive/alwaysShowWaiting so it
      // doesn't claim "would match without quick state" for worktrees that
      // are only ever shown via the bypass — and it must run matchesFilters
      // for the rest.
      expect(rowModelSource).toMatch(/if \(alwaysShowActive && isActive && !hasActiveQuery/);
      expect(rowModelSource).toMatch(
        /alwaysShowWaiting[\s\S]*?derived\.hasWaitingAgent[\s\S]*?!hasActiveQuery/
      );
      expect(rowModelSource).toMatch(
        /else if \(matchesFilters\(worktree, filters, derived, isActive, devServerSessions\)\) \{\s*withoutQuickStateCount\+\+;/
      );
    });
  });

  describe("list empty state wiring", () => {
    it("renders one SidebarListEmptyState for every empty branch, resolved before the list", () => {
      expect(source).toContain("resolveSidebarListEmpty({");
      const emptyIdx = source.indexOf("{listEmpty !== null ? (");
      const listIdx = source.indexOf(") : groupedSections ? (");
      expect(emptyIdx).toBeGreaterThan(0);
      expect(emptyIdx).toBeLessThan(listIdx);
      expect(source.match(/<SidebarListEmptyState\b/g) ?? []).toHaveLength(1);
    });

    it("hands focus to the search field before each recovery action unmounts its button", () => {
      for (const handler of [
        "handleShowAllMatches",
        "handleClearSearch",
        "handleClearAllFilters",
      ]) {
        const body = source.match(
          new RegExp(`const ${handler} = \\(\\) => \\{([\\s\\S]*?)\\n  \\};`)
        );
        expect(body, handler).not.toBeNull();
        expect(body?.[1]?.trim().startsWith("searchInputRef.current?.focus();")).toBe(true);
      }
    });
  });
});

describe("SidebarContent zero-worktrees empty state — issue #6752 (supersedes #6437 nudge)", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("does not render a Press <Kbd>…</Kbd> create-worktree nudge in the zero-worktrees branch", () => {
    // Issue #6752 removed the create-worktree shortcut nudge from the
    // zero-worktrees empty state — pressing a create-worktree shortcut is
    // nonsensical when there are zero worktrees and no repository open yet.
    const branchStart = source.indexOf("if (worktrees.length === 0) {");
    const branchEnd = source.indexOf("const hasNonMainWorktrees", branchStart);
    expect(branchStart).toBeGreaterThan(0);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).not.toContain("to create a worktree");
    expect(branch).not.toContain("<Kbd>");
  });

  it("does not render the Quick Start ordered list in the zero-worktrees branch", () => {
    // Issue #6752 removed the contradictory "Open a repository → Launch an
    // agent → Inject context" Quick Start ol — first step duplicates the kbd
    // hint above, and the welcome surfaces own onboarding sequencing.
    const branchStart = source.indexOf("if (worktrees.length === 0) {");
    const branchEnd = source.indexOf("const hasNonMainWorktrees", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).not.toContain("Quick Start");
    expect(branch).not.toMatch(/<ol[^>]*>/);
  });

  it("keeps the File → Open Project menu path as the single wayfinding cue", () => {
    // It names the one action a zero-worktrees user can take next. It is a
    // menu path, not a key, so it is set as words — never in a key chip, which
    // everywhere else in the app means "press this".
    expect(source).toContain("File → Open Project");
    expect(source).not.toMatch(/<kbd[^>]*>\s*File → Open Project/);
  });

  it("leaves every project dialog to ProjectDialogHost (#13773)", () => {
    // The zero-worktrees branch, the skeleton and the non-git early return all
    // used to drop some or all of these mounts, so an action dispatched while
    // the sidebar sat in one of them opened nothing. The host mounts them once,
    // outside the sidebar, whatever branch or view is showing.
    for (const mount of [
      "<LazyNewWorktreeDialog",
      "<LazyRecipeEditor",
      "<LazyRecipeManager",
      "<BulkCreateWorktreeDialog",
      "<LazyFleetPickerPalette",
    ]) {
      expect(source).not.toContain(mount);
    }
    expect(source).not.toContain("useRecipeDialogState");
    // The triggers stay: the header still opens the picker through the shared
    // store and warms the New worktree chunk on hover.
    expect(source).toMatch(
      /const openFleetPicker = useFleetPickerPaletteStore\(\(s\) => s\.open\)/
    );
    expect(source).toContain("onPointerEnter={() => void preloadNewWorktreeDialog()}");
  });
});

describe("SidebarContent zero-worktrees taxonomy alignment — issue #6934", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("uses the EmptyState primitive with the zero-data variant", () => {
    const branchStart = source.indexOf("if (worktrees.length === 0) {");
    const branchEnd = source.indexOf("const hasNonMainWorktrees", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("<EmptyState");
    expect(branch).toContain('variant="zero-data"');
  });

  it("names the action in the title slot, not the absence", () => {
    // CLAUDE.md "Empty States" rule: first-run empty states name what the user
    // can do next. Migrating from "No worktrees yet" (the absence) to the
    // action sentence as the title fixes the slot-swap drift.
    const branchStart = source.indexOf("if (worktrees.length === 0) {");
    const branchEnd = source.indexOf("const hasNonMainWorktrees", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain('title="Open a Git repository"');
    expect(branch).not.toContain("No worktrees yet");
  });

  it("does not render a button in the zero-worktrees branch", () => {
    // The zero-worktrees state's only action is in the application menu,
    // communicated via the <kbd>File → Open Project</kbd> hint — there is
    // no inline button. Guards against a future regression that adds a
    // create-worktree CTA back into this branch.
    const branchStart = source.indexOf("if (worktrees.length === 0) {");
    const branchEnd = source.indexOf("const hasNonMainWorktrees", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).not.toContain("<button");
  });
});

describe("SidebarContent initial loading skeleton — issues #7215, #8804", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("does not render the legacy 'Loading worktrees...' text in the loading branch", () => {
    expect(source).not.toContain("Loading worktrees...");
  });

  it("renders the Skeleton primitive in the initial-loading branch with a context-specific label", () => {
    const branchStart = source.indexOf("if (showSkeleton && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    expect(branchStart).toBeGreaterThan(0);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("<Skeleton");
    expect(branch).toContain('label="Loading worktrees"');
  });

  it("preserves the Worktrees header in the loading branch to avoid layout shift on reveal", () => {
    const branchStart = source.indexOf("if (showSkeleton && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    // The shared heading draws the same `<h2>` (or the view switcher inside
    // one, once a plugin adds a sidebar view), so loading keeps the title too.
    expect(branch).toMatch(/<SidebarViewHeading[^>]*>\s*Worktrees\s*<\/SidebarViewHeading>/);
    // The loading header must be the same height as the loaded one, or the bar
    // changes size when worktrees finish loading and the list jumps (#10318).
    // Both draw the shared sidebar header row, whose height is fixed in one
    // place, so neither can size itself differently from the other.
    expect(branch).toMatch(/className=\{(?:cn\(\s*)?SIDEBAR_HEADER_ROW\b/);
    const groupIdx = source.indexOf("group/header");
    const loadedRow = source.slice(source.lastIndexOf("<div", groupIdx), groupIdx);
    expect(loadedRow).toMatch(/cn\(\s*SIDEBAR_HEADER_ROW\b/);
  });

  it("uses SkeletonBone with shimmer and no immediate prop (400ms Doherty gate) — #8804", () => {
    const branchStart = source.indexOf("if (showSkeleton && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("<SkeletonBone");
    expect(branch).toContain("shimmer");
    expect(branch).not.toContain("immediate");
  });

  it("marks each card wrapper aria-hidden so the Skeleton primitive owns the live region", () => {
    const branchStart = source.indexOf("if (showSkeleton && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain('aria-hidden="true"');
  });

  it("renders the loading branch via WORKTREE_SKELETON_CARDS.map with no row borders — #8804", () => {
    const branchStart = source.indexOf("if (showSkeleton && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("WORKTREE_SKELETON_CARDS.map");
    // The cards, not the control zone's placeholder above them, which keeps
    // the zone's own bottom edges.
    const cardsStart = branch.indexOf("WORKTREE_SKELETON_CARDS.map");
    const cards = branch.slice(cardsStart, branch.indexOf("</Skeleton>", cardsStart));
    expect(cards).not.toMatch(/\bborder-[btlr]?\b/);
  });

  it("does not measure the skeleton container with useResizeObserverRaf — #8804", () => {
    // The dynamic ResizeObserver-driven row count is replaced with a fixed
    // 4-card layout. No measurement state should remain in the file.
    expect(source).not.toContain("useResizeObserverRaf");
    expect(source).not.toContain("skeletonContainerRef");
    expect(source).not.toContain("skeletonRowCount");
  });

  it("renders SkeletonHint as sibling of Skeleton, not nested inside", () => {
    expect(source).toContain("<SkeletonHint");
    const branchStart = source.indexOf("if (showSkeleton && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toMatch(/<\/Skeleton>[\s\S]*?<SkeletonHint/);
  });
});

describe("SidebarContent workspace error banner — issue #8394", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("lets both sidebar failure banners take their glyph from the severity", () => {
    // The glyph is the severity's non-colour channel and InlineStatusBanner
    // picks it per severity; an override here is how the load error came to
    // wear a different error shape from every other one.
    const banners = [...source.matchAll(/<InlineStatusBanner\b[^>]*?title="([^"]+)"/g)];
    expect(banners.map((m) => m[1])).toContain("Workspace service unavailable");
    for (const banner of banners) expect(banner[0]).not.toMatch(/\bicon=/);
    const loadBanner = readFileSync(LOAD_ERROR_BANNER_PATH, "utf-8");
    const call = loadBanner.slice(loadBanner.indexOf("<InlineStatusBanner"));
    expect(call.slice(0, call.indexOf("/>"))).not.toMatch(/\bicon=/);
  });

  it("does not have an if (error) early return that hides the worktree list", () => {
    expect(source).not.toMatch(/if \(error\) \{\s*return/);
  });

  it("renders InlineStatusBanner with severity=error, role=status, ariaLive=polite", () => {
    // Error, not warning: it shows only once recovery has failed and settled.
    expect(source).toContain('severity="error"');
    expect(source).toContain('role="status"');
    expect(source).toContain('ariaLive="polite"');
  });

  it("wires the sanitized error text as a wrapping description and a Restart Service action", () => {
    // Not `contextLine`: that clips to one line, and at sidebar width the
    // reason was cut to its first few words with the rest behind a hover.
    expect(source).toMatch(/description=\{boundedErrorText\(error\)\}/);
    expect(source).not.toMatch(/contextLine=\{error\}/);
    expect(source).toContain('"Restart Service"');
    expect(source).toContain('id: "restart-workspace-service"');
  });

  it("uses local bannerDismissed state for dismiss instead of clearing store error", () => {
    // Dismiss uses local state so the store's `error` stays non-null and
    // `worktree.restartService` remains enabled even after banner dismissal.
    expect(source).toContain("bannerDismissed");
    expect(source).toContain("setBannerDismissed");
    expect(source).toMatch(/onClose=\{canDismissErrorBanner \? onBannerDismiss : undefined\}/);
    expect(source).not.toContain("useWorktreeStore");
  });

  it("renders errorBanner in the zero-worktree branch so fatal errors are visible before first snapshot", () => {
    // When setFatalError fires before the first snapshot hydrates (worktrees=[],
    // isLoading=false, error="..."), the zero-worktree early return must still
    // show the error banner so the user can restart the service.
    const branchStart = source.indexOf("if (worktrees.length === 0) {");
    const branchEnd = source.indexOf("const hasNonMainWorktrees", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("{errorBanner}");
  });

  it("mounts the Restart Service ConfirmDialog in both the zero-worktree branch and the main return path", () => {
    // The dialog must be reachable in both code paths so that clicking
    // "Restart Service" from the errorBanner works whether the first snapshot
    // has hydrated (main return) or `setFatalError` fired before it
    // (zero-worktree early return). The shared `restartConfirmDialog` variable
    // is the single source of truth — defined once above both early returns
    // and rendered in each path.
    expect(source).toContain("const restartConfirmDialog =");
    expect(source).toContain('title="Restart workspace service?"');
    expect(source).toContain("isOpen={isRestartConfirmOpen}");

    const branchStart = source.indexOf("if (worktrees.length === 0) {");
    const branchEnd = source.indexOf("const hasNonMainWorktrees", branchStart);
    const zeroBranch = source.slice(branchStart, branchEnd);
    expect(zeroBranch).toContain("{restartConfirmDialog}");

    const mainReturnStart = source.lastIndexOf("return (");
    const afterMainReturn = source.slice(mainReturnStart);
    expect(afterMainReturn).toContain("{restartConfirmDialog}");
  });
});

describe("SidebarContent disconnected project — issue #12576", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  function zeroWorktreeBranch(): string {
    const branchStart = source.indexOf("if (worktrees.length === 0) {");
    const branchEnd = source.indexOf("const hasNonMainWorktrees", branchStart);
    expect(branchStart).toBeGreaterThan(0);
    expect(branchEnd).toBeGreaterThan(branchStart);
    return source.slice(branchStart, branchEnd);
  }

  it("treats an open project with no snapshot as disconnected", () => {
    // `isInitialized` only flips when a snapshot applies, which needs a live
    // worktree port — so an open project without it has no connection.
    expect(source).toContain(
      "const isProjectDisconnected = currentProject !== null && !isInitialized;"
    );
  });

  it("never offers the Open a Git repository nudge to a disconnected project", () => {
    // Retry used to clear the timeout banner over a sidebar with no port, and
    // the zero-worktree branch then told a user with an open project to open one.
    const branch = zeroWorktreeBranch();
    // Gated on every load failure, a stalled reconnect over an empty list included.
    const gateIdx = branch.indexOf("{loadFailure === null && !isProjectDisconnected && (");
    const nudgeIdx = branch.indexOf('title="Open a Git repository"');
    expect(gateIdx).toBeGreaterThan(0);
    expect(nudgeIdx).toBeGreaterThan(gateIdx);
  });

  it("says the connection failed, with Retry, when nothing else explains the empty sidebar", () => {
    // A reported load failure wins; a workspace-service error already has its
    // own banner and Restart action, so the fallback stays out of its way, and
    // a cold start that is still loading is not a failure yet.
    expect(source).toMatch(
      /const loadFailure =\s*worktreeLoadError \?\?\s*\(isProjectDisconnected && !isLoading && error === null\s*\?\s*WORKTREE_DISCONNECTED_MESSAGE\s*:\s*null\) \?\?/
    );
    expect(zeroWorktreeBranch()).toContain("{worktreeLoadErrorBanner}");
  });

  it("offers Retry once a lost port has stalled and automatic recovery gave up (#13748, #14313)", () => {
    // Last in the chain: a reported failure or a missing connection says more.
    // Gated on the recovery phase too, so the banner never shows while the
    // view is still retrying on its own.
    expect(source).toMatch(
      /WORKTREE_DISCONNECTED_MESSAGE\s*:\s*null\) \?\?\s*\(needsReconnectRetry\(\{ isReconnecting, reconnectingAt, reconnectRecovery \}, now\)\s*\?\s*WORKTREE_RECONNECT_STALLED_MESSAGE\s*:\s*null\);/
    );
  });

  it("never shows the loading skeleton over a reported load failure", () => {
    // A switch whose load threw leaves the store `isLoading`; a skeleton under
    // the failure banner says the list is loading and has failed at once.
    expect(source).toMatch(/isLoading: isStoreLoading,/);
    const derivation = source.match(/const isLoading = isStoreLoading && ([^;]+);/);
    expect(derivation).not.toBeNull();
    // Both failures end the loading state: the skeleton branch mounts neither
    // banner, so a failure it swallowed would have no recovery on screen.
    expect(derivation![1]).toContain("worktreeLoadError === null");
    expect(derivation![1]).toContain("error === null");
    expect(source.match(/\bisStoreLoading\b/g)).toHaveLength(2);
    const branchStart = source.indexOf("if (showSkeleton && worktrees.length === 0)");
    const branch = source.slice(branchStart, source.indexOf("if (worktrees.length === 0) {"));
    expect(branch).toContain("<Skeleton");
    expect(branch).not.toMatch(/worktreeLoadErrorBanner|<WorktreeLoadErrorBanner|\{errorBanner\}/);
  });

  it("offers Retry only when Restart is not the fix", () => {
    // Retry cannot bring back a crashed host, so any service error — its
    // banner shown or dismissed — keeps Retry off screen.
    expect(source).toMatch(
      /const worktreeLoadErrorBanner =\s*loadFailure !== null && error === null && isFailureSettled \?/
    );
  });

  it("puts both failure banners below the control zone in every branch", () => {
    // A failure about the list sits with the list, under its header — never
    // above the header, where it reads as a failure of the whole sidebar.
    const zero = zeroWorktreeBranch();
    const header = zero.indexOf("Worktrees\n");
    expect(header).toBeGreaterThan(0);
    expect(zero.indexOf("{errorBanner}")).toBeGreaterThan(header);
    expect(zero.indexOf("{worktreeLoadErrorBanner}")).toBeGreaterThan(header);

    const main = source.slice(source.indexOf("const hasNonMainWorktrees"));
    const zone = main.indexOf("{/* Header Section */}");
    expect(zone).toBeGreaterThan(0);
    const bannerIdx = main.indexOf("{worktreeLoadErrorBanner}");
    expect(bannerIdx).toBeGreaterThan(main.indexOf("<WorktreeSidebarSearchBar"));
    expect(main.indexOf("{errorBanner}")).toBeGreaterThan(zone);
    expect(main.slice(0, zone)).not.toContain("{worktreeLoadErrorBanner}");
  });

  it("keeps the service error pinned while it is all that explains an empty, disconnected sidebar", () => {
    // Dismissing it there used to leave a bare "Worktrees" header — no
    // explanation and no Restart action — once the nudge stopped covering it.
    expect(source).toContain(
      "const canDismissErrorBanner = worktrees.length > 0 || !isProjectDisconnected;"
    );
    expect(source).toMatch(
      /error !== null && isFailureSettled && \(!bannerDismissed \|\| !canDismissErrorBanner\) \?/
    );
  });

  it("holds every failure banner behind one settle window, with the skeleton standing in (#14311)", () => {
    // One window covers both banners, fed by whichever failure would show, so
    // a hand-over from one to the other cannot restart it.
    expect(source).toMatch(
      /const sidebarFailure: SidebarFailure \| null =\s*error !== null\s*\?\s*\{ kind: "service-error", message: error \}\s*:\s*loadFailure !== null\s*\?\s*\{ kind: "load-error", message: loadFailure \}\s*:\s*null;/
    );
    expect(source).toContain("const isFailureSettled = useSettledSidebarFailure(sidebarFailure);");
    // Without the skeleton an empty sidebar would sit as a bare header for the
    // length of the window; once a failure settles it ends the skeleton even
    // while the store still reads as loading, or a stalled first hydration
    // would hide its Retry for good.
    expect(source).toContain(
      "const showSkeleton = (isLoading || sidebarFailure !== null) && !isFailureSettled;"
    );
    expect(source).toContain("if (showSkeleton && worktrees.length === 0)");
  });

  it("keeps the loading skeleton ahead of the disconnected fallback", () => {
    // `isInitialized` is false for every cold start, so the fallback may only
    // claim the state once loading has settled.
    const skeletonIdx = source.indexOf("if (showSkeleton && worktrees.length === 0)");
    const zeroIdx = source.indexOf("if (worktrees.length === 0) {");
    expect(skeletonIdx).toBeGreaterThan(0);
    expect(skeletonIdx).toBeLessThan(zeroIdx);
  });
});

describe("Worktree list keyboard grid — issue #6422 / virtualized rewrite", () => {
  describe("SortableWorktreeCard ARIA contract", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
    });

    it("strips dnd-kit's tabIndex from spread attributes so the row never gets a stray tab stop", () => {
      expect(source).toMatch(/tabIndex:\s*_tabIndex/);
    });

    it("leaves the aria-activedescendant id to the card's select button", async () => {
      // One element per id: the card's select button carries it, so the
      // row wrapper must not carry a duplicate.
      expect(source).not.toContain("id={getWorktreeSidebarRowId(");
      const cardSource = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
      const overlay =
        cardSource.match(/<button\b[^>]*\bdata-card-select-overlay=""[^>]*>/)?.[0] ?? "";
      expect(overlay).toContain("id={getWorktreeSidebarRowId(worktree.id)}");
    });
  });

  describe("WorktreeCard role conditional", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
    });

    it('only applies role="group" in the overview grid variant — sidebar rows defer to the row wrapper', () => {
      expect(source).toContain('role={variant === "grid" ? "group" : undefined}');
    });

    it("keeps outline-hidden on the inner click-target button to preserve forced-colors UA outline (#8094)", () => {
      expect(source).toMatch(/"row-select-target absolute inset-0 z-0 outline-hidden"/);
    });

    it("does not paint a duplicate accent focus ring on the inner button — card-level :has(> button:focus-visible) ring is canonical (#8094)", () => {
      expect(source).not.toContain("focus-visible:outline-accent-primary");
      expect(source).not.toContain("focus-visible:ring-accent-primary");
    });
  });

  describe("WorktreeHeader actions toolbar", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(WORKTREE_ACTIONS_TOOLBAR_PATH, "utf-8");
    });

    it("marks the actions wrapper with data-worktree-row-toolbar so the controller can find it", () => {
      expect(source).toContain('data-worktree-row-toolbar=""');
    });

    it('declares role="toolbar" and an accessible label', () => {
      expect(source).toMatch(/role="toolbar"/);
      expect(source).toMatch(/aria-label="Worktree actions"/);
    });
  });

  describe("WorktreeCard drag handle", () => {
    const SIDEBAR_CSS_PATH = path.resolve(__dirname, "../../../styles/components/sidebar.css");

    it("marks the drag handle with data-worktree-row-drag-handle so focus CSS can target it", async () => {
      const cardSource = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
      expect(cardSource).toContain('data-worktree-row-drag-handle=""');
    });

    it("reveals drag handle on keyboard focus via [data-worktree-row-drag-handle] CSS selector", async () => {
      const cssSource = await fs.readFile(SIDEBAR_CSS_PATH, "utf-8");
      expect(cssSource).toContain("[data-worktree-row-drag-handle]");
    });

    it("uses group-hover/card for mouse row-level reveal (not self-scoped hover)", async () => {
      // Discoverability is row-scoped: hovering anywhere on the card has to
      // surface the grip, or nobody finds it. The grip rests at opacity 0, so
      // the row-level reveal is the fade — not a colour change on something
      // already painted.
      const cardSource = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
      expect(cardSource).toContain("group-hover/card:opacity-100");
    });

    it("keeps the grip's backplate self-scoped so row hover does not paint a bar", async () => {
      // The grip is a full-height column. When its backplate came up on row
      // hover it painted a bar down the whole card and became the most
      // prominent thing on a row whose subject is the worktree — for a control
      // most hovers never wanted. Brightening the glyph is the row-level
      // affordance; the plate waits for the pointer to reach the grip.
      const cardSource = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
      expect(cardSource).not.toContain("group-hover/card:bg-overlay-soft");
      expect(cardSource).toContain("hover:bg-overlay-soft");
    });

    it("keeps the drag handle's fade under reduced motion", async () => {
      // The grip's reveal is an opacity fade plus a colour change, neither of
      // which is motion, so reduced motion must not zero it. Asserted against
      // the CSS: the grip's transition lives in the unlayered
      // `[data-worktree-row-drag-handle]` rule, which beats any utility.
      const cssSource = await fs.readFile(SIDEBAR_CSS_PATH, "utf-8");
      expect(cssSource).toMatch(/\[data-worktree-row-drag-handle\]\s*{\s*transition:[^}]*opacity/);
      expect(cssSource).not.toMatch(
        /@variant reduce-motion\s*{\s*\[data-worktree-row-drag-handle\]\s*{[^}]*transition:\s*none/
      );
    });
  });

  describe("SidebarContent virtualized grid wiring", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    });

    it("wires gridRef + handlers + aria-activedescendant onto the role='grid' container", () => {
      expect(source).toMatch(/aria-activedescendant=\{activeDescendantId\}/);
      expect(source).toContain('role="grid"');
      expect(source).toContain('aria-label="Worktrees"');
      expect(source).toContain("ref={gridRef}");
      expect(source).toContain("onKeyDown={handleGridKeyDown}");
      expect(source).toContain("onFocus={handleGridFocus}");
      expect(source).toContain("onFocusCapture={handleGridFocusCapture}");
    });

    it("sets a single tab stop on the grid container (not on individual rows)", () => {
      // aria-activedescendant pattern: container holds tabIndex=0, rows stay -1.
      // No rows, no stop: an empty grid would take focus with nothing to show.
      expect(source).toMatch(
        /role="grid"[\s\S]{0,400}tabIndex=\{keyboardItems\.length > 0 \? 0 : -1\}/
      );
    });

    it("passes overscan + skipAnimationFrameInResizeObserver to Virtuoso", () => {
      expect(source).toContain("SIDEBAR_VIRTUOSO_OVERSCAN_PX");
      expect(source).toContain("skipAnimationFrameInResizeObserver");
    });

    it("uses module-level computeSidebarItemKey for stable item identity (past lesson #1992)", () => {
      expect(source).toMatch(/function\s+computeSidebarItemKey\b/);
      expect(source).toContain("computeItemKey={computeSidebarItemKey}");
    });

    it("threads reactive row state through Virtuoso's context prop (React Compiler safety)", () => {
      expect(source).toMatch(/context=\{virtuosoContext\}/);
      expect(source).toMatch(/const\s+virtuosoContext\s*=\s*useMemo</);
    });

    it("wraps Virtuoso in SortableContext only when sort is enabled", () => {
      // Grouped sections disable sort and render static rows that don't call
      // useSortable — wrapping that path in SortableContext would be a no-op
      // and confuse dnd-kit measurement.
      expect(source).toMatch(/groupedSections\s*\?\s*\(\s*<Virtuoso/);
      expect(source).toMatch(/<SortableContext\s+items=\{sortableIds\}/);
    });

    it("wraps StaticWorktreeRow's WorktreeCard in role='row' + data-worktree-row + role='gridcell'", async () => {
      const staticSource = await fs.readFile(STATIC_ROW_PATH, "utf-8");
      expect(staticSource).toMatch(/role="row"/);
      expect(staticSource).toContain("data-worktree-row={worktreeId}");
      expect(staticSource).toContain("tabIndex={-1}");
      expect(staticSource).toContain('role="gridcell"');
    });

    it("leaves StaticWorktreeRow without a duplicate of the select button's id", async () => {
      // The card inside it carries the aria-activedescendant id on its select
      // button; a second element with that id would make the target ambiguous.
      const staticSource = await fs.readFile(STATIC_ROW_PATH, "utf-8");
      expect(staticSource).not.toContain("id={getWorktreeSidebarRowId(");
    });
  });

  describe("useWorktreeSidebarKeyboard hook", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(KEYBOARD_HOOK_PATH, "utf-8");
    });

    it("uses VirtuosoHandle.scrollToIndex to bring the active row into view", () => {
      expect(source).toMatch(/virtuosoRef\.current\?\.scrollToIndex\(/);
    });

    it("resets to list mode on window blur (lesson #4591)", () => {
      expect(source).toContain('window.addEventListener("blur"');
      expect(source).toMatch(/setGridMode\(\s*"list"\s*\)/);
    });

    it("allows Ctrl+Home and Ctrl+End through the modifier guard", () => {
      expect(source).toMatch(/e\.ctrlKey && e\.key !== "Home" && e\.key !== "End"/);
    });

    it("clamps the active worktree to one that still exists in the items list", () => {
      // When a filter removes the previously-active row, the hook must reseat
      // activeWorktreeId so aria-activedescendant doesn't point at a missing id.
      expect(source).toMatch(/stillVisible/);
    });

    it("skips scrollToIndex for pinned rows (they live outside Virtuoso)", () => {
      // Pinned rows are always mounted, so navigating to one must NOT call
      // scrollToIndex — that would point at the wrong Virtuoso row.
      expect(source).toMatch(/item\.isPinned/);
      expect(source).toMatch(/if \(item\.isPinned\) return/);
    });

    it("offsets the Virtuoso scrollToIndex by the number of preceding pinned rows", () => {
      // The flat items list interleaves pinned rows ahead of the virtualized
      // items; subtract the count so scrollToIndex targets the right row.
      expect(source).toMatch(/pinnedBefore/);
      expect(source).toMatch(/index: flatIndex - pinnedBefore/);
    });

    it("encodes worktree ids before composing the DOM id (paths may contain spaces)", () => {
      // Worktree ids are filesystem paths; on macOS they often contain spaces
      // which produce invalid id attributes.
      expect(source).toMatch(/encodeURIComponent\(worktreeId\)/);
    });
  });

  describe("SidebarContent — pinned rows participate in keyboard navigation", () => {
    let source: string;
    let rowModelSource: string;
    let modelHookSource: string;
    beforeEach(async () => {
      source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
      rowModelSource = await fs.readFile(ROW_MODEL_PATH, "utf-8");
      modelHookSource = await fs.readFile(MODEL_HOOK_PATH, "utf-8");
    });

    it("prepends the main worktree to keyboardItems when visible", () => {
      expect(modelHookSource).toMatch(
        /if \(mainVisible && mainWorktree\)[\s\S]{0,200}isPinned: true/
      );
    });

    it("keeps the main worktree as the only row pinned outside Virtuoso (#11433)", () => {
      // A second pinned slot used to hold whichever worktree happened to sit on
      // `develop`/`trunk`/`next`, which removed it from the counts and the list.
      // Every other worktree now reaches the grid through sidebarItems. The test
      // above pins down *which* row stays pinned; this one pins the count.
      const sidebarSource = [source, modelHookSource, rowModelSource].join("\n");
      expect(sidebarSource.match(/isPinned: true/g)).toHaveLength(1);
    });
  });

  describe("issue #7212 — APG grid attributes and keyboard model", () => {
    describe("aria-rowcount / aria-rowindex threading", () => {
      it("exposes aria-rowcount on the grid container", async () => {
        const source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
        expect(source).toContain("aria-rowcount={ariaRowCount}");
      });

      it("computes ariaRowCount including pinned, group header, and data rows", async () => {
        const source = await fs.readFile(MODEL_HOOK_PATH, "utf-8");
        expect(source).toMatch(/const ariaRowCount =/);
        expect(source).toMatch(
          /groupedSections[\s\S]*?\.reduce\([\s\S]*?1 \+ s\.worktrees\.length/
        );
      });

      it("anchors the virtualized rows directly after the single pinned main row", async () => {
        // With only the main row pinned, the first virtualized row sits one slot
        // past it and the row count starts from the same base. A second pinned
        // slot would have to reintroduce an offset here (#11433).
        const source = await fs.readFile(MODEL_HOOK_PATH, "utf-8");
        const rowModelSource = await fs.readFile(ROW_MODEL_PATH, "utf-8");
        expect(source).toMatch(/const firstScrollableRowIndex = mainRowIndex \+ 1;/);
        expect(source).toMatch(/const ariaRowCount =\s*\n?\s*mainRowIndex \+/);
        expect(rowModelSource).toMatch(/let nextRowIndex = firstScrollableRowIndex;/);
      });

      it("StaticWorktreeRow applies aria-rowindex to its role='row' div", async () => {
        const source = await fs.readFile(STATIC_ROW_PATH, "utf-8");
        expect(source).toContain("aria-rowindex={ariaRowIndex}");
      });

      it("SortableWorktreeCard applies aria-rowindex to its role='row' div", async () => {
        const source = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
        expect(source).toContain("aria-rowindex={ariaRowIndex}");
      });

      it("threads ariaRowIndex through SidebarWorktreeRow → SortableWorktreeCard", async () => {
        const sidebarRowSource = await fs.readFile(
          path.resolve(__dirname, "../SidebarWorktreeRow.tsx"),
          "utf-8"
        );
        expect(sidebarRowSource).toMatch(/ariaRowIndex:\s*number/);
        expect(sidebarRowSource).toContain("ariaRowIndex={ariaRowIndex}");
      });
    });

    describe("aria-current on the active row", () => {
      it("StaticWorktreeRow applies aria-current='true' when the row is active", async () => {
        const source = await fs.readFile(STATIC_ROW_PATH, "utf-8");
        expect(source).toContain('aria-current={isActive ? "true" : undefined}');
      });

      it("SortableWorktreeCard applies aria-current='true' when the row is active", async () => {
        const source = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
        expect(source).toContain('aria-current={isActive ? "true" : undefined}');
      });

      it("removes the (selected) suffix from WorktreeCard's aria-label", async () => {
        const source = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
        expect(source).not.toContain('" (selected)"');
      });

      it("WorktreeCard sets aria-current on the grid variant (overview modal has no row wrapper)", async () => {
        const source = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
        expect(source).toContain(
          'aria-current={variant === "grid" && isActive ? "true" : undefined}'
        );
      });
    });

    describe("grouped-by-type section structure", () => {
      let source: string;
      beforeEach(async () => {
        source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
      });

      it("emits header sentinels with role='row' + role='rowheader' from renderSidebarFlatItem", () => {
        // After virtualization, headers are flat items rather than nested
        // role='rowgroup' children. They still carry role='row' + 'rowheader'.
        expect(source).toMatch(/item\.kind === "header"/);
        expect(source).toContain('role="row"');
        expect(source).toContain('role="rowheader"');
        expect(source).toContain("aria-colspan={1}");
      });

      it("threads aria-rowindex onto group header rows", () => {
        // Headers count toward aria-rowcount and carry their own aria-rowindex.
        expect(source).toMatch(/aria-rowindex=\{item\.ariaRowIndex\}/);
      });
    });

    describe("keyboard model — PageUp/PageDown and Ctrl+Home/Ctrl+End", () => {
      let source: string;
      beforeEach(async () => {
        source = await fs.readFile(KEYBOARD_HOOK_PATH, "utf-8");
      });

      it("handles PageDown and PageUp in the list-mode switch", () => {
        expect(source).toMatch(/case "PageDown"/);
        expect(source).toMatch(/case "PageUp"/);
      });

      it("computes the page step from the Virtuoso scroller's viewport height", () => {
        expect(source).toMatch(/computePageSize/);
        expect(source).toMatch(/scrollerRef/);
      });
    });
  });

  describe("issue #9667 — keyboard cursor surfaced as a visible row state", () => {
    const SIDEBAR_CSS_PATH = path.resolve(__dirname, "../../../styles/components/sidebar.css");

    it("threads keyboardCursorId through the Virtuoso context into both row paths", async () => {
      const source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
      expect(source).toMatch(/keyboardCursorId:\s*string \| null/);
      expect(source).toContain("keyboardCursorId={context.keyboardCursorId}");
      // The pinned (main + integration) rows live outside the Virtuoso surface
      // and must receive the cursor id directly from the hook return.
      expect(source).toContain("keyboardCursorId={keyboardCursorId}");
    });

    it("flags the cursor row via data-keyboard-cursor in both static and sortable paths", async () => {
      const staticSource = await fs.readFile(STATIC_ROW_PATH, "utf-8");
      const sortableSource = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
      expect(staticSource).toContain(
        'data-keyboard-cursor={isKeyboardCursor ? "true" : undefined}'
      );
      expect(sortableSource).toContain(
        'data-keyboard-cursor={isKeyboardCursor ? "true" : undefined}'
      );
    });

    it("includes isKeyboardCursor in the SortableWorktreeCard memo comparator so the ring updates", async () => {
      // Without this the React.memo comparator would swallow cursor changes and
      // the ring would stick on a stale row as the user navigates.
      const sortableSource = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
      expect(sortableSource).toMatch(/prev\.isKeyboardCursor\s*!==\s*next\.isKeyboardCursor/);
    });

    it("ships a forced-colors outline fallback for the cursor ring (box-shadow is stripped there)", async () => {
      const css = await fs.readFile(SIDEBAR_CSS_PATH, "utf-8");
      // Split on each forced-colors media query and inspect the segment up to
      // the next media query — robust to brace indentation, unlike a lazy
      // `\n}` block match which depends on prettier's exact formatting.
      const segments = css.split("@media (forced-colors: active)").slice(1);
      const hasCursorFallback = segments.some((seg) => {
        const block = seg.split("@media")[0]!;
        return (
          block.includes('data-keyboard-cursor="true"') &&
          /outline:\s*2px solid Highlight/.test(block)
        );
      });
      expect(hasCursorFallback).toBe(true);
    });
  });

  describe("issue #8389 — per-row sidebar subscription stops full-list re-renders", () => {
    let source: string;
    let staticSource: string;
    let rowModelSource: string;
    beforeEach(async () => {
      source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
      staticSource = await fs.readFile(STATIC_ROW_PATH, "utf-8");
      rowModelSource = await fs.readFile(ROW_MODEL_PATH, "utf-8");
    });

    it("StaticWorktreeRow subscribes to its own store slice by id (not a prop object)", () => {
      // The row reads exactly its own snapshot via a primitive Map-get
      // selector, so an unrelated worktree changing in the poll cycle does
      // not invalidate this row's selector result.
      expect(staticSource).toMatch(
        /useWorktreeStore\(\s*\(state\)\s*=>\s*state\.worktrees\.get\(worktreeId\)\s*\)/
      );
      // The row's public prop is the id, never a full WorktreeState object.
      expect(staticSource).toContain("worktreeId: string;");
      expect(staticSource).not.toMatch(/worktree:\s*WorktreeState;/);
    });

    it("removes the per-render renderWorktreeCard closure that re-created every row element each poll", () => {
      // A closure rebuilt on every SidebarContent render produced a fresh
      // element factory each poll, defeating the React Compiler's per-row
      // memoization. Rows must be authored as inline JSX so each element is
      // memoized by its own (id-only) props.
      expect(source).not.toMatch(/const renderWorktreeCard\s*=/);
      expect(source).not.toMatch(/renderWorktreeCard\(/);
      // Guard against the same anti-pattern resurfacing under a different
      // name — any per-render closure that returns a <StaticWorktreeRow/>
      // factory re-creates row elements each poll and defeats memoization.
      expect(source).not.toMatch(
        /const \w*(?:render|make|build)\w*(?:Row|Card)\w*\s*=\s*\([^)]*\)\s*=>\s*\(?\s*<StaticWorktreeRow/
      );
    });

    it("threads only the worktreeId (not a full worktree object) into StaticWorktreeRow across all render paths", () => {
      // The main (pinned) row stays as inline JSX outside the Virtuoso
      // surface; its id-only prop shape is preserved.
      expect(source).toMatch(
        /<StaticWorktreeRow\s+key=\{mainWorktree\.id\}\s+worktreeId=\{mainWorktree\.id\}/
      );
      // Virtualized rows are produced by renderSidebarFlatItem which reads
      // `item.worktreeId` off each Virtuoso item — never a full worktree
      // object — and the sidebarItems memo iterates `section.worktrees` to
      // push those items.
      expect(source).toMatch(/<StaticWorktreeRow\s+worktreeId=\{item\.worktreeId\}/);
      expect(rowModelSource).toMatch(/for \(const w of section\.worktrees\)/);
      expect(rowModelSource).toMatch(/worktreeId:\s*w\.id/);
      // No render path threads a full worktree object into the row.
      expect(source).not.toMatch(/<StaticWorktreeRow[^>]*\bworktree=\{/);
    });

    it("preserves the side-effecting aria-rowindex counter in the grouped path", () => {
      // The 1-based aria-rowindex slot advances per item the sidebarItems
      // memo emits (header sentinel + each row). Virtuoso renders the items;
      // the counter still post-increments inside the iteration so each
      // emitted item carries the next 1-based row slot.
      expect(rowModelSource).toMatch(/ariaRowIndex:\s*nextRowIndex\+\+/);
    });
  });

  describe("issue #7972 — sortable sidebar drop indicator and keyboard reorder", () => {
    describe("SortableWorktreeCard directional drop indicator", () => {
      let source: string;
      beforeEach(async () => {
        source = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
      });

      it("uses the shared neutral drop-indicator ink (no accent tokens) for the indicator", () => {
        expect(source).toContain("DROP_INDICATOR_LINE");
        expect(source).not.toMatch(/daintree-accent|accent-primary/);
        expect(DROP_INDICATOR_LINE).not.toMatch(/daintree-accent|accent-primary/);
      });

      it("marks the indicator pointer-events-none so it never blocks the drop target", () => {
        expect(DROP_INDICATOR_LINE).toContain("pointer-events-none");
      });
    });

    describe("SidebarContent wires keyboard reorder to applyManualWorktreeReorder", () => {
      let source: string;
      let reorderSource: string;
      beforeEach(async () => {
        source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
        reorderSource = await fs.readFile(REORDER_HOOK_PATH, "utf-8");
      });

      it("imports the shared reorder helper used by drag-end (single source of truth)", () => {
        expect(reorderSource).toContain('from "@/lib/worktreeReorder"');
        expect(reorderSource).toContain("applyManualWorktreeReorder");
      });

      it("renders a sr-only aria-live polite region for keyboard reorder announcements", () => {
        expect(source).toMatch(/className="sr-only"[\s\S]*?aria-live="polite"/);
        expect(source).toContain("keyboardReorderAnnouncement");
      });

      it("receives a worktreeId (not a DOM element) from the keyboard hook and bounds-clamps the move", () => {
        expect(reorderSource).toMatch(
          /handleKeyboardReorder = useCallback\(\(worktreeId: string, delta: -1 \| 1\)/
        );
        expect(reorderSource).toMatch(/targetIdx < 0 \|\| targetIdx >= visible\.length/);
      });

      it("routes the reorder through useWorktreeFilterStore (manualOrder + manual sort)", () => {
        expect(reorderSource).toMatch(/filterStore\.setManualOrder\(merged\)/);
        expect(reorderSource).toMatch(/filterStore\.setOrderBy\("manual"\)/);
      });

      it("guards the reorder against grouped-by-type / active-search modes so it never silently mutates manualOrder when the drag handle is hidden", () => {
        expect(reorderSource).toMatch(/isSortDisabledRef\s*=\s*useRef\(false\)/);
        expect(reorderSource).toMatch(/isSortDisabledRef\.current\s*=\s*isSortDisabled/);
        const guard = reorderSource.match(
          /handleKeyboardReorder = useCallback\([\s\S]*?\}, \[\]\);/
        );
        expect(guard).toBeTruthy();
        expect(guard?.[0]).toMatch(/if \(isSortDisabledRef\.current\) return;/);
      });
    });
  });
});

describe("SidebarContent header reveal — issue #6964", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  // The reveal's own class string, anchored on its hover rule.
  function revealClasses(src: string): string | undefined {
    return src.match(/"([^"]*group-hover\/header:opacity-100[^"]*)"/)?.[1];
  }

  it("fades the hidden buttons rather than hiding them, so Tab still reaches them", () => {
    // `visibility: hidden` took them out of the tab order, so focus-within
    // could never reveal them and a keyboard user tabbing in never met them.
    const reveal = revealClasses(source);
    expect(reveal).toBeTruthy();
    expect(reveal).not.toMatch(/\binvisible\b/);
    expect(reveal).toMatch(/(?:^|\s)opacity-0(?:\s|$)/);
    expect(reveal).toContain("group-focus-within/header:opacity-100");
    expect(reveal).toContain("group-focus-within/header:pointer-events-auto");
  });

  // Slice the header region so assertions about the four header icon buttons
  // aren't perturbed by unrelated buttons elsewhere in the file (e.g. the
  // arm-matching affordance, which carries the same focus-visible treatment).
  function headerSlice(src: string): string {
    const start = src.indexOf("group/header");
    const end = src.indexOf("Inline search bar", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("builds all five header actions from the shared ghost icon button — issue #7602", () => {
    // The Button primitive owns the focus ring, hover and press for every one
    // of them, so none of the five can drift into its own treatment.
    const header = headerSlice(source);
    const buttons = header.match(/<Button\s+variant="ghost"\s+size="icon-xs"/g) ?? [];
    expect(buttons).toHaveLength(5);
    expect(header).not.toMatch(/<button\b/);
    expect(header).not.toMatch(/focus-visible:outline-accent-primary/);
  });

  it("gives the always-visible buttons the same treatment as their revealed siblings", () => {
    // Visibility is the cluster's only hierarchy: the three secondary actions
    // are hidden until the header is hovered or focused, and View options and
    // create are not. Once shown, all five read as one family.
    const header = headerSlice(source);
    expect(header).not.toMatch(/text-daintree-text\//);
    // The buttons' own classes: the title row also holds non-action content
    // (a remote window's "on <host>"), which is not part of the family.
    const classNames = [
      ...header.matchAll(/<Button\b(?:(?!<\/Button)[\s\S])*?className=\{([^}]*)\}/g),
    ].map((m) => m[1] ?? "");
    expect(classNames).toHaveLength(5);
    expect(classNames.every((cls) => cls.includes("SIDEBAR_HEADER_ACTION"))).toBe(true);
  });

  it("keeps the reveal's fade under reduced motion", () => {
    // The reveal is opacity only — not motion — so it must not be switched
    // off under reduced motion.
    const reveal = revealClasses(source);
    expect(reveal).toBeTruthy();
    expect(reveal).toMatch(/(?:^|\s)transition-opacity(?:\s|$)/);
    expect(reveal).not.toMatch(/motion-reduce:/);
  });

  it("keeps the cluster on screen, and clickable, while the refresh icon is turning", () => {
    // Keyed off SpinningIcon's own data-spinning rather than isRefreshing, so
    // the cluster fades back only after the finishing turn, not mid-rotation.
    const reveal = revealClasses(source);
    expect(reveal).toBeTruthy();
    for (const state of ["opacity-100", "pointer-events-auto"]) {
      expect(reveal).toContain(`has-[[data-spinning]]:${state}`);
    }
    expect(reveal).not.toMatch(/isRefreshing/);
    // The refresh button must sit inside that reveal for :has() to see it.
    const header = headerSlice(source);
    const revealAt = header.indexOf("has-[[data-spinning]]");
    const spinnerAt = header.search(/<SpinningIcon\b[^>]*icon=\{RefreshCw\}/);
    const createAt = header.indexOf('aria-label="Create new worktree"');
    expect(revealAt).toBeGreaterThan(-1);
    expect(spinnerAt).toBeGreaterThan(revealAt);
    expect(spinnerAt).toBeLessThan(createAt);
  });

  it("counts refreshes dispatched from outside the button as in flight", () => {
    // The palette, a rebound shortcut and the sidebar context menu dispatch
    // worktree.refresh directly and never enter the button's transition.
    expect(source).toMatch(
      /const \[isRefreshPending, startRefreshTransition\] = useTransition\(\);/
    );
    // The counting itself is behaviour-tested in useDispatchedSidebarRefresh.test.
    expect(source).toMatch(/const isRefreshDispatched = useDispatchedSidebarRefresh\(\);/);
    expect(source).toMatch(/const isRefreshing = isRefreshPending \|\| isRefreshDispatched;/);
  });

  it("delegates the refresh spin to SpinningIcon driven by the raw refresh flag (#11323)", () => {
    // The refresh spin is owned by the shared SpinningIcon primitive, which
    // finishes the current rotation before stopping instead of snapping back.
    // It must be driven by the raw `isRefreshing` transition flag — the old
    // `useSkeletonDisplayFloor` wall-clock floor gated duration, not rotation
    // phase, so it snapped mid-turn and is deliberately gone from this button.
    // Scope the positive match to the header so an unrelated SpinningIcon
    // elsewhere in the file can't mask a regression to a static header icon.
    const header = headerSlice(source);
    expect(header).toMatch(/<SpinningIcon\b[^>]*icon=\{RefreshCw\}[^>]*active=\{isRefreshing\}/);
    expect(source).not.toContain("useSkeletonDisplayFloor");
    expect(source).not.toContain("showRefreshSpinner");
    // No hand-rolled conditional class toggle survives on the refresh icon.
    expect(source).not.toMatch(/showRefreshSpinner\s*\?\s*"animate-spin"/);
    expect(source).not.toMatch(/isRefreshing\s*\?\s*"animate-spin"/);
  });
});

// Static-source assertions for the SR announcement plumbing on top of
// keyboard reorder (issue #8013). The keystroke→callback path itself is
// covered behaviorally by useWorktreeSidebarKeyboard.altArrow.test.tsx.
describe("SidebarContent keyboard reorder announcement — issue #8013", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(REORDER_HOOK_PATH, "utf-8");
  });

  describe("worktree name in the announcement", () => {
    it("resolves the moved row's headline through issueTitle → branch → name, never its id", () => {
      // Mirrors the drag-cancel announcer and DndProvider.resolveWorktreeLabel
      // so keyboard reorder speaks the headline shown on the card, not the bare
      // name (issue #10317). The last resort is the word, as DndProvider's is:
      // a worktree id is its absolute path, which is no headline to read aloud.
      expect(source).toMatch(
        /const\s+wt\s*=\s*worktreesRef\.current\.find\(\(w\)\s*=>\s*w\.id\s*===\s*worktreeId\)/
      );
      expect(source).toMatch(
        /const\s+label\s*=\s*wt\?\.issueTitle\s*\?\?\s*wt\?\.branch\s*\?\?\s*wt\?\.name\s*\?\?\s*"worktree"/
      );
    });

    it("announces the worktree headline alongside the position", () => {
      expect(source).toContain(
        "`Moved '${label}' to position ${targetIdx + 1} of ${visible.length}`"
      );
      expect(source).not.toMatch(/`Moved to position \$\{targetIdx \+ 1\}/);
    });
  });

  describe("debounced live-region update", () => {
    it("clears any pending timer before scheduling the next announcement", () => {
      expect(source).toMatch(
        /if\s*\(reorderAnnouncementTimerRef\.current\s*!==\s*null\)\s*\{\s*clearTimeout\(reorderAnnouncementTimerRef\.current\)/
      );
    });

    it("defers setKeyboardReorderAnnouncement behind a 150ms trailing timeout", () => {
      expect(source).toMatch(/const\s+KEYBOARD_REORDER_ANNOUNCEMENT_DEBOUNCE_MS\s*=\s*150/);
      expect(source).toMatch(
        /reorderAnnouncementTimerRef\.current\s*=\s*setTimeout\(\(\)\s*=>\s*\{[\s\S]*?reorderAnnouncementTimerRef\.current\s*=\s*null;[\s\S]*?setKeyboardReorderAnnouncement\(message\);[\s\S]*?\},\s*KEYBOARD_REORDER_ANNOUNCEMENT_DEBOUNCE_MS\)/
      );
    });

    it("does not call setKeyboardReorderAnnouncement synchronously in the callback", () => {
      const synchronousCall =
        /setKeyboardReorderAnnouncement\(`Moved/.test(source) ||
        /setOrderBy\("manual"\);\s*setKeyboardReorderAnnouncement/.test(source);
      expect(synchronousCall).toBe(false);
    });
  });

  describe("unmount safety", () => {
    it("clears a pending announcement timer when the sidebar unmounts", () => {
      expect(source).toMatch(
        /useEffect\(\(\)\s*=>\s*\{\s*return\s*\(\)\s*=>\s*\{\s*if\s*\(reorderAnnouncementTimerRef\.current\s*!==\s*null\)\s*\{\s*clearTimeout\(reorderAnnouncementTimerRef\.current\)/
      );
    });
  });
});

// Issue #8395 — When isSortDisabled transitions from true to false (filter
// cleared or group-by-type toggled off), fire an sr-only announcement so
// screen-reader users know reorder is available again.
describe("SidebarContent reorder re-enable announcement — issue #8395", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(REORDER_HOOK_PATH, "utf-8");
  });

  it("tracks the previous sort-disabled state in a ref", () => {
    expect(source).toMatch(
      /const\s+isSortDisabledPrevRef\s*=\s*useRef\(isGroupedByType\s*\|\|\s*liveQuery\.trim\(\)\.length\s*>\s*0\)/
    );
  });

  it("fires useEffect when isGroupedByType or the live query changes", () => {
    expect(source).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*isSortDisabledPrevRef[\s\S]*\},\s*\[isGroupedByType,\s*liveQuery\]\)/
    );
  });

  it("announces 'Manual reorder available' on the enable transition", () => {
    expect(source).toContain('setKeyboardReorderAnnouncement("Manual reorder available")');
  });

  it("clears any pending reorder announcement before scheduling the re-enable", () => {
    expect(source).toMatch(
      /if\s*\(reorderAnnouncementTimerRef\.current\s*!==\s*null\)[\s\S]*clearTimeout[\s\S]*reorderAnnouncementTimerRef\.current\s*=\s*setTimeout[\s\S]*"Manual reorder available"/
    );
  });

  it("gates on prev===true && current===false transition", () => {
    expect(source).toMatch(/prev\s*&&\s*!current/);
  });
});

/**
 * The sidebar's branches are ordered early-returns, so what matters for a
 * workspace with no worktrees — a folder opened without git (#11405) or a
 * scratch (#11499) — is *where* its branch sits relative to the loading
 * skeleton and the "Open a Git repository" nudge, both of which would otherwise
 * claim the same zero-worktree state and mislead.
 */
describe("SidebarContent — workspace with no worktrees (#11405, #11499)", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("decides on the workspace's own kind, not on the absence of worktrees alone", () => {
    // Reading the emptiness alone would misreport a folder initialized
    // externally, whose host does load worktrees; those must win over a stale
    // flag. `isGitBacked` is false for both a non-git project and a scratch, so
    // one gate now covers both worktree-less kinds (#11499).
    expect(source).toMatch(
      /workspaceRoot !== null\s*&&\s*!workspaceRoot\.isGitBacked\s*&&\s*worktrees\.length === 0/
    );
  });

  it("answers before the loading skeleton, which would otherwise never resolve", () => {
    const gate = source.indexOf("!workspaceRoot.isGitBacked");
    const skeleton = source.indexOf("if (showSkeleton && worktrees.length === 0)");
    expect(gate).toBeGreaterThan(-1);
    expect(skeleton).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(skeleton);
  });

  it("answers before the zero-worktree branch that nudges toward opening a repository", () => {
    const gate = source.indexOf("!workspaceRoot.isGitBacked");
    const zeroWorktrees = source.indexOf("if (worktrees.length === 0)");
    expect(gate).toBeGreaterThan(-1);
    expect(zeroWorktrees).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(zeroWorktrees);
  });

  it("hands the branch to the workspace-root sidebar rather than an empty state", () => {
    // The sidebar lists the places agents run; a worktree-less workspace has
    // exactly one, so it gets a row like every other kind instead of a
    // Worktrees header over a zero-data nudge (#11499). What that sidebar then
    // renders is covered behaviourally in WorkspaceRootSidebar.test.tsx — this
    // only pins that the branch is wired to it at all.
    expect(source).toContain("<WorkspaceRootSidebar workspace={workspaceRoot}");
  });
});

describe("SidebarContent reconnecting indicator — issue #8074", () => {
  let source: string;
  let badge: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    badge = await fs.readFile(BADGE_PATH, "utf-8");
  });

  it("gates the reconnecting indicator behind useDohertyGate", () => {
    // Doherty Threshold (400ms): routine sub-second port replacements must not
    // flash a spinner. The reconnecting indicator is gated on onset the same way
    // other deferred-display state on this component is.
    expect(source).toMatch(/const showReconnecting = useDohertyGate\(isReconnecting\)/);
  });

  it("renders the Reconnecting… span behind showReconnecting, not raw isReconnecting", () => {
    // Regression guard: anything in the render tree that reads isReconnecting
    // directly bypasses the deferred gate and flickers on every sub-400ms
    // disconnect→reconnect.
    expect(source).toMatch(/\{showReconnecting && \(\s*<WorktreesReconnectingBadge/);
    expect(source).not.toMatch(/\{isReconnecting && \(/);
    expect(badge).toMatch(/Reconnecting…/);
  });

  it("drives the reconnect tick via useVisibilityAwareInterval, not a bare setInterval — issue #9583", () => {
    // Chromium intensively throttles hidden-tab setInterval to ~1/min after 10s,
    // which corrupts the "last updated X ago" relative-time display. The tick
    // must pause while hidden and snap back on restore via the visibility hook.
    expect(source).toMatch(/import \{ useVisibilityAwareInterval \}/);
    expect(source).toMatch(
      /useVisibilityAwareInterval\(\s*\(\) => setReconnectTick\(\(n\) => n \+ 1\),\s*1000,\s*isReconnecting && reconnectingAt != null\s*\)/
    );
    // The old ungated reconnect interval must be gone.
    expect(source).not.toMatch(/setInterval\(\(\) => setReconnectTick/);
  });

  it("keeps the reconnecting badge on one line and moves the relative time into a tooltip — issue #10727", () => {
    // The escalated string "Reconnecting… last updated X ago" used to render
    // inline with no width constraint, wrapping and breaking the header layout.
    // The mark (one shape for both states, drawn beside the title or on its
    // own row) must stay single-line (whitespace-nowrap) at text-xs, scoped to
    // the badge so an unrelated element keeping these classes can't mask a
    // regression. Escalation steps the words up a text tier rather than into a
    // status colour, which has no contrast floor across the themes (#15105).
    const marks = [
      ...badge.matchAll(/inline-flex items-center gap-1 whitespace-nowrap shrink-0 ([^"]*)"/g),
    ].map((m) => m[1] ?? "");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toContain("text-xs");
    expect(badge).not.toMatch(/text-status-warning/);
    // The relative-time detail moved off the visible badge into hover tooltip
    // content; the old inline combined template literal must be gone (the
    // explanatory comment at the tick may still mention the phrasing).
    expect(badge).not.toMatch(/`Reconnecting… last updated \$\{/);
    expect(badge).toMatch(
      /<TooltipContent[\s\S]*?Last updated \{formatRelativeTime\(escalatedSince\)\}/
    );
    // The tooltip must not auto-dismiss — the relative time is the substance and
    // has to stay readable while the user hovers.
    expect(badge).toMatch(/<Tooltip autoDismiss=\{false\}>/);
  });
});

describe("SidebarContent shortcut labels — issue #5843", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  describe("live binding hooks", () => {
    it("uses dynamic hook for worktree.overview", () => {
      expect(source).toContain('useEffectiveCombo("worktree.overview")');
    });

    it("does NOT consume fleet.armFocused for the Zap button (binding mismatch)", () => {
      // The Zap button used to read `useKeybindingDisplay("fleet.armFocused")`
      // and pass it to the tooltip. That shortcut binds the *toggle armed
      // pane* action (Cmd+J), not "open the picker". After Phase 3 the Zap
      // button opens FleetPickerPalette and the tooltip advertises no
      // shortcut. Enforce that the stale hook call doesn't creep back.
      expect(source).not.toMatch(/use(KeybindingDisplay|EffectiveCombo)\("fleet\.armFocused"\)/);
    });

    it("uses dynamic hook for worktree.refresh", () => {
      expect(source).toContain('useEffectiveCombo("worktree.refresh")');
    });

    it("uses dynamic hook for worktree.createDialog.open", () => {
      expect(source).toContain('useEffectiveCombo("worktree.createDialog.open")');
    });
  });

  describe("no hardcoded shortcut strings in button titles", () => {
    it("does not hardcode shortcut strings in formatButtonTitle calls", () => {
      expect(source).not.toMatch(/formatButtonTitle\([^)]*"Cmd\+/);
      expect(source).not.toMatch(/formatButtonTitle\([^)]*"Ctrl\+/);
    });

    it("does not assign hardcoded shortcut literals to *Shortcut variables", () => {
      expect(source).not.toMatch(/const\s+\w*Shortcut\s*=\s*["'](Cmd|Ctrl|Shift|Alt|Option)/);
    });
  });

  describe("aria-keyshortcuts exposure (issue #6874)", () => {
    it("calls useAriaKeyshortcuts for each shortcut-bearing button", () => {
      expect(source).toContain('useAriaKeyshortcuts("worktree.overview")');
      expect(source).toContain('useAriaKeyshortcuts("worktree.refresh")');
      expect(source).toContain('useAriaKeyshortcuts("worktree.createDialog.open")');
    });

    it("renders aria-keyshortcuts on each interactive button", () => {
      expect(source).toContain("aria-keyshortcuts={overviewAriaShortcut}");
      expect(source).toContain("aria-keyshortcuts={refreshAriaShortcut}");
      expect(source).toContain("aria-keyshortcuts={createWorktreeAriaShortcut}");
    });
  });

  describe("header tooltips", () => {
    /**
     * The contiguous `<Tooltip>` block around the control carrying `marker`,
     * with no nested `<Tooltip>` opening in between — so what the block says is
     * proven to belong to THIS button rather than to a sibling in the header.
     */
    function tooltipFor(marker: string): string {
      const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const block = source.match(
        new RegExp(`<Tooltip>(?:(?!<Tooltip>)[\\s\\S])*?${escaped}[\\s\\S]*?</Tooltip>`)
      );
      expect(block, `no Tooltip wraps the control carrying ${marker}`).not.toBeNull();
      return block![0];
    }

    function buttonTag(block: string): string {
      return block.match(/<(?:button|Button)\b[\s\S]*?>/)![0];
    }

    it("labels every header action through the app Tooltip, never a native title", () => {
      // A native title shows late, unstyled and never on keyboard focus, and
      // beside a Tooltip it doubles up (#11633). The four header actions all
      // take the shared Tooltip.
      for (const marker of [
        "onClick={onOpenOverview}",
        "onClick={openFleetPicker}",
        "onClick={handleRefreshAll}",
        'aria-label="Create new worktree"',
      ]) {
        expect(buttonTag(tooltipFor(marker))).not.toMatch(/\btitle=/);
      }
    });

    it("carries each action's live shortcut as a chord pill, not a string suffix", () => {
      expect(tooltipFor("onClick={onOpenOverview}")).toMatch(
        /createTooltipContent\("Open worktrees overview", overviewShortcut\)/
      );
      expect(tooltipFor("onClick={handleRefreshAll}")).toMatch(
        /createTooltipContent\("Refresh sidebar", refreshShortcut\)/
      );
      expect(tooltipFor('aria-label="Create new worktree"')).toMatch(
        /createTooltipContent\("Create new worktree", createWorktreeShortcut\)/
      );
    });

    it("advertises no shortcut for Select terminals to arm (no binding opens the picker)", () => {
      // The Zap button opens the FleetPickerPalette, which has no keybinding.
      // Earlier it rendered `armFocusedShortcut` (Cmd+J), which is the *toggle
      // armed pane* binding, not "open the picker", and so misled users.
      const block = tooltipFor("onClick={openFleetPicker}");
      expect(block).toMatch(
        /<TooltipContent side="bottom">Select terminals to arm<\/TooltipContent>/
      );
      expect(block).not.toMatch(/createTooltipContent/);
    });
  });
});

// jsdom gives Virtuoso no real geometry (no layout, no ResizeObserver sizes), so
// the remount itself can't be driven in a unit test. What can be protected is
// the wiring: the surface renders from two sibling branches, and the regression
// returns the moment either one loses the key.
describe("SidebarContent Virtuoso reset wiring — issue #12094", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  function virtuosoCallSites(src: string): string[] {
    const sites: string[] = [];
    const open = "<Virtuoso<SidebarFlatItem, SidebarVirtuosoContext>";
    let from = src.indexOf(open);
    while (from !== -1) {
      const end = src.indexOf("/>", from);
      expect(end).toBeGreaterThan(from);
      sites.push(src.slice(from, end));
      from = src.indexOf(open, end);
    }
    return sites;
  }

  it("keys both call sites off the reset generation", () => {
    const sites = virtuosoCallSites(source);
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site).toContain("key={virtuosoResetKey}");
    }
  });

  it("restores the replaced scroll offset on both call sites", () => {
    const sites = virtuosoCallSites(source);
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site).toContain("initialScrollTop={virtuosoInitialScrollTop}");
    }
  });

  it("suppresses the remount against the deferred query, not the live one", () => {
    // `liveQuery` updates on the keystroke, a render before the list narrows —
    // comparing against it would let every typed character through as an
    // uncorrelated shrink and remount the list under the user.
    expect(source).toContain("useSidebarVirtuosoReset({");
    expect(source).toMatch(/searchQuery:\s*deferredQuery/);
    expect(source).not.toMatch(/searchQuery:\s*liveQuery/);
  });

  it("also hands over the live query so the hook can tell settled from stale", () => {
    // Without it the hook cannot see the urgent commit that carries a new
    // character while the filtered list is still the old one, and reads that
    // commit as the query holding still.
    const start = source.indexOf("useSidebarVirtuosoReset({");
    expect(start).toBeGreaterThan(-1);
    const call = source.slice(start, source.indexOf("});", start));
    expect(call).toMatch(/\bliveQuery\b/);
  });

  it("measures the shrink against the rendered item array", () => {
    expect(source).toMatch(/itemCount:\s*sidebarItems\.length/);
  });
});

describe("SidebarContent clock reads under React Compiler (#14351)", () => {
  // Compiled, a bare `Date.now()` is cached with whichever memo block reads it,
  // so a check that only ages (reconnect escalation, the stalled-reconnect
  // Retry, the main row's activity window) would keep its first answer. Vitest
  // runs uncompiled and cannot see that caching; these pin the shape that keeps
  // the clock a dependency once compiled.
  it.each([
    ["SidebarContent", SIDEBAR_CONTENT_PATH],
    ["the row model hook", MODEL_HOOK_PATH],
  ])("%s reads the clock through useRenderTime, never Date.now()", async (_label, file) => {
    const owner = await fs.readFile(file, "utf-8");
    expect(owner).toContain("const now = useRenderTime();");
    expect(owner).not.toMatch(/Date\.now\(\)/);
  });

  it("hands that clock to every check that ages", async () => {
    const source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    const modelHookSource = await fs.readFile(MODEL_HOOK_PATH, "utf-8");
    expect(source).toMatch(/now - reconnectingAt >= RECONNECT_ESCALATE_MS/);
    expect(source).toMatch(/needsReconnectRetry\([^)]*\}, now\)/);
    expect(modelHookSource).toMatch(/w\.id === activeWorktreeId,\s*devServerSessions,\s*now\s*\)/);
  });
});
