import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

describe("SidebarContent quick-state empty state — issue #6333 (CTA collapsed by #6934)", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  describe("store wiring", () => {
    it("subscribes to clearAll from the filter store as clearAllFilters", () => {
      expect(source).toMatch(
        /const clearAllFilters = useWorktreeFilterStore\(\(state\) => state\.clearAll\)/
      );
    });

    it("does not subscribe to clearQuickStateFilter (single-CTA shape since #6934)", () => {
      expect(source).not.toContain("state.clearQuickStateFilter");
    });
  });

  describe("facet filter bypass gate", () => {
    it("gates the alwaysShowActive and alwaysShowWaiting bypasses on hasFacetFiltersActive", () => {
      // The bypass rules must additionally require !hasFacetFiltersActive so that
      // selecting a popover facet filter (status/type/github/session/activity)
      // suppresses bypass injection and makes the visible list agree with chip counts.
      expect(source).toMatch(/quickStateFilter === "all"\s*&&\s*!hasFacetFiltersActive/);
      expect(source).toContain("hasFacetFilters");
    });

    it("subscribes to hasFacetFilters from the worktree filter store", () => {
      expect(source).toContain("useWorktreeFilterStore((state) => state.hasFacetFilters)");
    });
  });

  describe("filteredWorktrees memo", () => {
    it("returns hasResultsWithoutQuickState alongside the filtered list", () => {
      expect(source).toContain("hasResultsWithoutQuickState");
      expect(source).toMatch(
        /const \{ filteredWorktrees, groupedSections, hasResultsWithoutQuickState[\s\S]*\}\s*=\s*useMemo/
      );
    });

    it("computes the counterfactual only when quickStateFilter is non-'all'", () => {
      expect(source).toMatch(/if \(!withoutQuickStateMatch && quickStateFilter !== "all"\)/);
    });

    it("mirrors the same alwaysShowActive bypass in the counterfactual pass", () => {
      // The counterfactual must respect alwaysShowActive/alwaysShowWaiting so it
      // doesn't claim "would match without quick state" for worktrees that
      // are only ever shown via the bypass — and it must run matchesFilters
      // for the rest.
      expect(source).toMatch(/if \(alwaysShowActive && isActive && !hasActiveQuery/);
      expect(source).toMatch(
        /alwaysShowWaiting[\s\S]*?derived\.hasWaitingAgent[\s\S]*?!hasActiveQuery/
      );
      expect(source).toMatch(
        /else if \(matchesFilters\(worktree, filters, derived, isActive\)\) \{\s*withoutQuickStateMatch = true;/
      );
    });
  });

  describe("showQuickStateEmptyState gate", () => {
    it("requires zero results, non-'all' filter, would-match-without, and non-main worktrees", () => {
      const block = source.match(/const showQuickStateEmptyState =\s*[\s\S]*?hasNonMainWorktrees;/);
      expect(block).not.toBeNull();
      expect(block![0]).toContain("filteredWorktrees.length === 0");
      expect(block![0]).toContain('quickStateFilter !== "all"');
      expect(block![0]).toContain("hasResultsWithoutQuickState");
      expect(block![0]).toContain("hasNonMainWorktrees");
    });
  });

  describe("empty-state branch ordering and copy", () => {
    it("renders the quick-state empty state before the generic filter-mismatch branch", () => {
      const quickStateIdx = source.indexOf(
        "showQuickStateEmptyState && !hasFacetFiltersActive && !hasQuery ?"
      );
      const genericIdx = source.indexOf(") : filteredWorktrees.length === 0 &&");
      expect(quickStateIdx).toBeGreaterThan(0);
      expect(genericIdx).toBeGreaterThan(0);
      expect(quickStateIdx).toBeLessThan(genericIdx);
    });

    it("splits the no-facet-filter quick-state branch by filter: waiting gets user-cleared, others get filtered-empty", () => {
      // When the quick-state filter is the only active filter (no facet
      // filters), zero results for "waiting" means nothing needs attention —
      // a genuine completion state using user-cleared. Zero results for
      // "working" or "finished" is a filter mismatch — those use
      // filtered-empty with recovery actions.
      const branchStart = source.indexOf(
        "showQuickStateEmptyState && !hasFacetFiltersActive && !hasQuery ?"
      );
      const branchEnd = source.indexOf(
        ") : showQuickStateEmptyState && hasFacetFiltersActive ?",
        branchStart
      );
      const branch = source.slice(branchStart, branchEnd);
      expect(branch).toContain("<EmptyState");
      expect(branch).toContain('variant="user-cleared"');
      expect(branch).toContain('variant="filtered-empty"');
      expect(branch).toContain('title="All caught up"');
      expect(branch).toContain('quickStateFilter === "waiting"');
      expect(branch).toContain(
        `No \${QUICK_STATE_LABELS[quickStateFilter].toLowerCase()} worktrees`
      );
      expect(branch).toContain("setQuickStateFilter");
      expect(branch).not.toContain("clearAllFilters");
    });

    it("names both axes when a facet filter is active alongside the quick-state — issue #7971", () => {
      // When the quick-state filter and one or more facet filters are active
      // together and produce zero results, the title must call out both axes
      // (e.g. "No worktrees match Working with 2 filters"). The dual-axis
      // branch is now gated on `showQuickStateEmptyState && hasFacetFiltersActive`
      // (only entered when facet filters are active alongside quick-state).
      const branchStart = source.indexOf("showQuickStateEmptyState && hasFacetFiltersActive ?");
      const branchEnd = source.indexOf(") : filteredWorktrees.length === 0 &&", branchStart);
      const branch = source.slice(branchStart, branchEnd);
      expect(branch).toMatch(
        /`No worktrees match \$\{QUICK_STATE_LABELS\[quickStateFilter\]\} with \$\{activeFacetFilterCount\} \$\{[\s\S]*?activeFacetFilterCount === 1 \? "filter" : "filters"[\s\S]*?\}`/
      );
      expect(branch).toContain('variant="filtered-empty"');
    });

    it("derives the active facet filter count from the five facet Set sizes — issue #7971", () => {
      // The combined-axis title needs the actual number of facet filters
      // selected. Sum the five facet axes (status, type, github, session,
      // activity) — the same axes hasFacetFilters() reads. Do not include
      // query or quickStateFilter, which are named separately in the title.
      expect(source).toMatch(
        /const activeFacetFilterCount =\s*statusFilters\.size \+\s*typeFilters\.size \+\s*prIssueFilters\.size \+\s*sessionFilters\.size \+\s*activityFilters\.size;/
      );
    });

    it("maps quick-state filter values to title-cased labels for the combined-axis title — issue #7971", () => {
      // The raw quickStateFilter values are lowercase ("working", "waiting",
      // "finished"). The combined-axis title displays them title-cased via a
      // module-level QUICK_STATE_LABELS map so the prose reads naturally.
      expect(source).toMatch(
        /const QUICK_STATE_LABELS: Record<"working" \| "waiting" \| "finished", string> = \{\s*working: "Working",\s*waiting: "Waiting",\s*finished: "Finished",\s*\};/
      );
    });

    it("uses both user-cleared and filtered-empty variants in the quick-state branch", () => {
      // When only the quick-state filter is active (no facet filters),
      // the "waiting" filter gets user-cleared (nothing waiting = caught up);
      // "working" and "finished" get filtered-empty (filter mismatch).
      // When facet filters are also active, filtered-empty describes the
      // combined absence.
      const quickStateIdx = source.indexOf(
        "showQuickStateEmptyState && !hasFacetFiltersActive && !hasQuery ?"
      );
      const genericIdx = source.indexOf(") : filteredWorktrees.length === 0 &&");
      const branch = source.slice(quickStateIdx, genericIdx);
      expect(branch).toContain('variant="user-cleared"');
      expect(branch).toContain('variant="filtered-empty"');
    });

    it("renders dual recovery actions in the facet-filtered branch: clear filters and open overview — issues #7971, #8383", () => {
      // The user-cleared variant (only quick-state, no facets) forbids actions
      // by design — completed-result states stay quiet per CLAUDE.md. The
      // facet-filtered branch carries both recovery paths: "Show all
      // worktrees" clears filters; "Open overview" gives an alternative
      // escape to the full worktrees overview modal (#8383).
      const branchStart = source.indexOf("showQuickStateEmptyState && hasFacetFiltersActive ?");
      const branchEnd = source.indexOf(") : filteredWorktrees.length === 0 &&", branchStart);
      const branch = source.slice(branchStart, branchEnd);
      expect(branch).toMatch(/onClick=\{clearAllFilters\}[\s\S]*?>\s*Show all worktrees\s*</);
      expect(branch).toMatch(/onClick=\{onOpenOverview\}[\s\S]*?>\s*Open overview\s*</);
      // Two buttons — "Show all worktrees" and "Open overview"
      const buttonMatches = branch.match(/<button\b/g) ?? [];
      expect(buttonMatches).toHaveLength(2);
    });

    it("renders the dual recovery actions in the quick-state branch with the overview shortcut in the title — issue #8383", () => {
      // The "Open overview" button surfaces the keyboard shortcut via
      // formatButtonTitle in a title attribute, matching the toolbar pattern.
      // The old "Show all states" / "Clear all filters" strings from the
      // pre-#6934 dual-CTA shape must not reappear.
      expect(source).not.toContain("Show all states");
      expect(source).not.toContain("Clear all filters");
      expect(source).toContain('title={formatButtonTitle("Open overview", overviewShortcut)}');
    });

    it("does not render a description in the quick-state branch", () => {
      // The user-cleared variant forbids description by design; the
      // filtered-empty sidebar variant omits description per CLAUDE.md
      // empty-state rules.
      const branchStart = source.indexOf(
        "showQuickStateEmptyState && !hasFacetFiltersActive && !hasQuery ?"
      );
      const branchEnd = source.indexOf(") : filteredWorktrees.length === 0 &&", branchStart);
      const branch = source.slice(branchStart, branchEnd);
      expect(branch).not.toMatch(/description=/);
    });

    it("uses setQuickStateFilter in the non-waiting filtered-empty branch, not clearAllFilters — issue #8650", () => {
      // The non-waiting branch (working/finished) only fires when no facet
      // filters are active, so clearing just the quick-state filter is the
      // precise recovery action. clearAllFilters would be overkill.
      const branchStart = source.indexOf(
        "showQuickStateEmptyState && !hasFacetFiltersActive && !hasQuery ?"
      );
      const branchEnd = source.indexOf(
        ") : showQuickStateEmptyState && hasFacetFiltersActive ?",
        branchStart
      );
      const branch = source.slice(branchStart, branchEnd);
      expect(branch).toMatch(/setQuickStateFilter\("all"\)/);
      expect(branch).not.toContain("clearAllFilters");
    });

    it("renders Show all worktrees and Open overview buttons in the non-waiting filtered-empty branch — issue #8650", () => {
      // The working/finished filtered-empty branch must include both recovery
      // buttons, consistent with all other filtered-empty branches (#8383).
      const branchStart = source.indexOf(
        "showQuickStateEmptyState && !hasFacetFiltersActive && !hasQuery ?"
      );
      const branchEnd = source.indexOf(
        ") : showQuickStateEmptyState && hasFacetFiltersActive ?",
        branchStart
      );
      const branch = source.slice(branchStart, branchEnd);
      expect(branch).toMatch(
        /onClick=\{\(\) => setQuickStateFilter\("all"\)\}[\s\S]*?>\s*Show all worktrees\s*</
      );
      expect(branch).toMatch(/onClick=\{onOpenOverview\}[\s\S]*?>\s*Open overview\s*</);
    });

    it("renders the popover-filtered empty state via the EmptyState primitive with a noun-phrase title", () => {
      const branchStart = source.indexOf(") : filteredWorktrees.length === 0 &&");
      const branchEnd = source.indexOf("groupedSections ?", branchStart);
      const branch = source.slice(branchStart, branchEnd);
      expect(branch).toContain("<EmptyState");
      expect(branch).toContain('variant="filtered-empty"');
      expect(branch).toContain('"No matching worktrees"');
      expect(branch).toMatch(/hasQuery/);
      expect(branch).toMatch(/truncateSearchQuery/);
      expect(branch).toMatch(/onClick=\{clearAllFilters\}[\s\S]*?>\s*Show all worktrees\s*</);
      expect(branch).toMatch(/onClick=\{onOpenOverview\}[\s\S]*?>\s*Open overview\s*</);
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

  it("keeps the File → Open Directory menu-path pill as the single wayfinding cue", () => {
    // The menu-path pill stays as a raw <kbd> with the existing styling — it
    // names the one action a zero-worktrees user can take next.
    expect(source).toMatch(/<kbd[^>]*>\s*File → Open Directory\s*<\/kbd>/);
  });

  it("mounts NewWorktreeDialog from the zero-worktrees branch so populated-sidebar shortcuts still work", () => {
    // Even without the inline nudge, the dialog mount must remain reachable
    // from every branch so worktree.createDialog.open dispatched from
    // elsewhere (command palette, menu) opens correctly.
    expect(source).toContain("const newWorktreeDialogElement");
    const branchStart = source.indexOf("if (worktrees.length === 0) {");
    const branchEnd = source.indexOf("const hasNonMainWorktrees", branchStart);
    expect(branchStart).toBeGreaterThan(0);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("{newWorktreeDialogElement}");
  });

  it("hoists the dialog mount before all early returns so it is reachable from every branch", () => {
    // The dialog declaration must appear before the first early-return guard
    // (`isLoading && worktrees.length === 0`); otherwise dispatching
    // worktree.createDialog.open from outside the populated sidebar (loading,
    // error, or empty state) would be a no-op.
    const dialogIdx = source.indexOf("const newWorktreeDialogElement");
    const firstEarlyReturnIdx = source.indexOf("if (isLoading && worktrees.length === 0)");
    expect(dialogIdx).toBeGreaterThan(0);
    expect(firstEarlyReturnIdx).toBeGreaterThan(0);
    expect(dialogIdx).toBeLessThan(firstEarlyReturnIdx);
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
    expect(branch).toContain('title="Open a Git repository to get started"');
    expect(branch).not.toContain("No worktrees yet");
  });

  it("imports the EmptyState primitive", () => {
    expect(source).toMatch(/import \{ EmptyState \} from "@\/components\/ui\/EmptyState"/);
  });

  it("removes FilterX from lucide-react imports (no longer rendered after EmptyState migration)", () => {
    // FilterX was the icon used in the raw filter-empty markup. The
    // filtered-empty EmptyState variant intentionally omits icons, so the
    // import becomes unused — keeping it would be dead code.
    const importLine = source.match(/import \{[^}]*\} from "lucide-react"/);
    expect(importLine).not.toBeNull();
    expect(importLine![0]).not.toContain("FilterX");
  });

  it("does not render a button in the zero-worktrees branch", () => {
    // The zero-worktrees state's only action is in the application menu,
    // communicated via the <kbd>File → Open Directory</kbd> hint — there is
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

  it("imports Skeleton, SkeletonBone, and SkeletonHint from the ui directory (SkeletonText dropped in #8804)", () => {
    expect(source).toMatch(
      /import \{ Skeleton, SkeletonBone, SkeletonHint \} from "@\/components\/ui\/Skeleton"/
    );
    expect(source).not.toContain("SkeletonText");
  });

  it("does not render the legacy 'Loading worktrees...' text in the loading branch", () => {
    expect(source).not.toContain("Loading worktrees...");
  });

  it("renders the Skeleton primitive in the initial-loading branch with a context-specific label", () => {
    const branchStart = source.indexOf("if (isLoading && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    expect(branchStart).toBeGreaterThan(0);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("<Skeleton");
    expect(branch).toContain('label="Loading worktrees"');
  });

  it("preserves the Worktrees header in the loading branch to avoid layout shift on reveal", () => {
    const branchStart = source.indexOf("if (isLoading && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toMatch(/<h2[^>]*>Worktrees<\/h2>/);
  });

  it("uses SkeletonBone with shimmer and no immediate prop (400ms Doherty gate) — #8804", () => {
    const branchStart = source.indexOf("if (isLoading && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("<SkeletonBone");
    expect(branch).toContain("shimmer");
    expect(branch).not.toContain("immediate");
  });

  it("marks each card wrapper aria-hidden so the Skeleton primitive owns the live region", () => {
    const branchStart = source.indexOf("if (isLoading && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain('aria-hidden="true"');
  });

  it("defines WORKTREE_SKELETON_CARDS metadata for fixed-count shimmer cards — #8804", () => {
    // #8804 replaces the dynamic-height row count with 4 fixed shimmer cards
    // mirroring the index.html startup ghost `.skel-card` design.
    expect(source).toContain("WORKTREE_SKELETON_CARDS");
    expect(source).not.toContain("SKELETON_ROW_HEIGHT_PX");
    expect(source).not.toContain("MIN_SKELETON_ROWS");
  });

  it("renders the loading branch via WORKTREE_SKELETON_CARDS.map with no row borders — #8804", () => {
    const branchStart = source.indexOf("if (isLoading && worktrees.length === 0)");
    const branchEnd = source.indexOf("if (worktrees.length === 0)", branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain("WORKTREE_SKELETON_CARDS.map");
    expect(branch).not.toContain("border-b border-border-default");
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
    const branchStart = source.indexOf("if (isLoading && worktrees.length === 0)");
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

  it("imports InlineStatusBanner from the Terminal directory", () => {
    expect(source).toMatch(
      /import \{ InlineStatusBanner \} from "@\/components\/Terminal\/InlineStatusBanner"/
    );
  });

  it("imports AlertTriangle from lucide-react for the banner icon", () => {
    const importLine = source.match(/import \{[^}]*\} from "lucide-react"/);
    expect(importLine).not.toBeNull();
    expect(importLine![0]).toContain("AlertTriangle");
  });

  it("does not have an if (error) early return that hides the worktree list", () => {
    expect(source).not.toMatch(/if \(error\) \{\s*return/);
  });

  it("renders InlineStatusBanner with severity=warning, role=status, ariaLive=polite", () => {
    expect(source).toContain('severity="warning"');
    expect(source).toContain('role="status"');
    expect(source).toContain('ariaLive="polite"');
  });

  it("wires the error text as contextLine and a Restart Service action", () => {
    expect(source).toMatch(/contextLine=\{error\}/);
    expect(source).toContain('"Restart Service"');
    expect(source).toContain('id: "restart-workspace-service"');
  });

  it("uses local bannerDismissed state for dismiss instead of clearing store error", () => {
    // Dismiss uses local state so the store's `error` stays non-null and
    // `worktree.restartService` remains enabled even after banner dismissal.
    expect(source).toContain("bannerDismissed");
    expect(source).toContain("setBannerDismissed");
    expect(source).toMatch(/onClose=\{onBannerDismiss\}/);
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

describe("SidebarContent quick-state user-cleared variant — issue #8394", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("routes no-facet-filter, no-query zero for 'waiting' to user-cleared with 'All caught up' title", () => {
    // Only the "waiting" quick-state filter routes to user-cleared — nothing
    // waiting on the user is genuinely caught up. "working" and "finished"
    // with zero results are filter mismatches and use filtered-empty instead.
    expect(source).toContain("showQuickStateEmptyState && !hasFacetFiltersActive && !hasQuery");
    expect(source).toContain('quickStateFilter === "waiting"');
    expect(source).toContain('variant="user-cleared"');
    expect(source).toContain('title="All caught up"');
  });

  it("keeps filtered-empty when facet filters are active alongside quick-state", () => {
    expect(source).toContain("showQuickStateEmptyState && hasFacetFiltersActive ?");
    expect(source).toContain('variant="filtered-empty"');
  });
});
