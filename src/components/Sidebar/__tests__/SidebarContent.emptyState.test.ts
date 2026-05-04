import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

describe("SidebarContent quick-state empty state — issue #6333", () => {
  let source: string;

  beforeAll(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  describe("store wiring", () => {
    it("subscribes to clearQuickStateFilter from the filter store", () => {
      expect(source).toMatch(
        /const clearQuickStateFilter = useWorktreeFilterStore\(\(state\) => state\.clearQuickStateFilter\)/
      );
    });
  });

  describe("filteredWorktrees memo", () => {
    it("returns hasResultsWithoutQuickState alongside the filtered list", () => {
      expect(source).toContain("hasResultsWithoutQuickState");
      expect(source).toMatch(
        /const \{ filteredWorktrees, groupedSections, hasResultsWithoutQuickState \} = useMemo/
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
      expect(source).toMatch(/if \(alwaysShowActive && isActive && !hasActiveQuery\)/);
      expect(source).toMatch(
        /else if \(alwaysShowWaiting && derived\.hasWaitingAgent && !hasActiveQuery\)/
      );
      expect(source).toMatch(
        /else if \(matchesFilters\(worktree, filters, derived, isActive\)\) \{\s*withoutQuickStateMatch = true;/
      );
    });
  });

  describe("hasPopoverFilters derivation", () => {
    it("excludes quickStateFilter from the popover-only check", () => {
      // hasPopoverFilters powers the secondary "Clear all filters" CTA — it
      // must NOT include quickStateFilter, otherwise the second button shows
      // even when the only active filter is the quick state itself.
      const block = source.match(/const hasPopoverFilters =\s*[\s\S]*?activityFilters\.size > 0;/);
      expect(block).not.toBeNull();
      expect(block![0]).not.toContain("quickStateFilter");
    });

    it("includes query, statusFilters, typeFilters, githubFilters, sessionFilters, activityFilters", () => {
      const block = source.match(/const hasPopoverFilters =\s*[\s\S]*?activityFilters\.size > 0;/);
      expect(block![0]).toContain("query.trim().length > 0");
      expect(block![0]).toContain("statusFilters.size > 0");
      expect(block![0]).toContain("typeFilters.size > 0");
      expect(block![0]).toContain("githubFilters.size > 0");
      expect(block![0]).toContain("sessionFilters.size > 0");
      expect(block![0]).toContain("activityFilters.size > 0");
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
      const quickStateIdx = source.indexOf("showQuickStateEmptyState ?");
      const genericIdx = source.indexOf(
        "filteredWorktrees.length === 0 && hasFilters && hasNonMainWorktrees ?"
      );
      expect(quickStateIdx).toBeGreaterThan(0);
      expect(genericIdx).toBeGreaterThan(0);
      expect(quickStateIdx).toBeLessThan(genericIdx);
    });

    it("titles the empty state with the active quick-state label", () => {
      expect(source).toContain("No {quickStateFilter} worktrees");
    });

    it("primary CTA resets only the quick-state filter", () => {
      const block = source.match(
        /onClick=\{clearQuickStateFilter\}[\s\S]*?>\s*Show all states\s*</
      );
      expect(block).not.toBeNull();
    });

    it("only renders the secondary 'Clear all filters' CTA when popover filters are active", () => {
      // The secondary button is gated on hasPopoverFilters so it doesn't
      // appear when the quick-state filter is the *only* active filter
      // (otherwise users see two buttons that appear to do the same thing).
      const block = source.match(
        /\{hasPopoverFilters \?[\s\S]*?onClick=\{clearAllFilters\}[\s\S]*?Clear all filters[\s\S]*?: null\}/
      );
      expect(block).not.toBeNull();
    });

    it("preserves the existing 'No worktrees match your filters' branch for popover-only cases", () => {
      expect(source).toContain("No worktrees match your filters");
      // Original Clear filters button is still wired to clearAllFilters
      expect(source).toMatch(/onClick=\{clearAllFilters\}[\s\S]*?>\s*Clear filters\s*</);
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
