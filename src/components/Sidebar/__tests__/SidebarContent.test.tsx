import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");
const SEARCH_BAR_PATH = path.resolve(__dirname, "../../Worktree/WorktreeSidebarSearchBar.tsx");

describe("SidebarContent filter scope and sort status — issue #8391", () => {
  let source: string;
  let searchBarSource: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    searchBarSource = await fs.readFile(SEARCH_BAR_PATH, "utf-8");
  });

  it("renders no standalone status line — status lives inside the search bar strip", () => {
    // The scope/sort readout used to float between the header and the search
    // bar; it now rides the search bar's bottom row alongside "Clear all".
    expect(source).not.toContain("{/* Filter scope and sort-disabled status");
    expect(source).toMatch(/statusText=\{filterStatusText\}/);
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

  it("renders drag-disabled reason for search", () => {
    expect(source).toContain("Drag to reorder is off while searching");
  });

  it("renders drag-disabled reason for group-by-type", () => {
    expect(source).toContain("Drag to reorder is off while grouped by type");
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
    expect(source).toMatch(/scopeText\s*=\s*showScope\s*\?/);
    // The reorder note is what is left when there is nothing else to say —
    // it is a standing explanation, not news, so it no longer outranks the
    // scope and the filter identities by consuming the line alongside them.
    expect(source).toMatch(/scopeText \?\? dragDisabledReason/);
  });

  it("derives drag-disabled reason with query taking priority over group-by-type", () => {
    // Query-first precedence: hasQuery ? "searching" : isGroupedByType ? "grouped by type" : null
    expect(source).toMatch(/hasQuery\s*\?[\s\S]*?Drag to reorder is off while searching/);
    expect(source).toMatch(
      /isGroupedByType\s*\?[\s\S]*?Drag to reorder is off while grouped by type/
    );
  });

  it("exports totalCount from the filter useMemo alongside filteredWorktrees", () => {
    // Both the grouped and ungrouped return paths must report the same total,
    // so assert the count rather than mere presence.
    expect(source.match(/totalCount: nonMainWorktrees\.length/g)).toHaveLength(2);
  });

  it("derives every non-main count and the filtered list from one shared array (#11433)", () => {
    // The quick-state bar read "All 0" above a visible worktree because the
    // counts carried a branch-name exclusion the rendered list did not. Every
    // consumer now reads the same `nonMainWorktrees` memo, so they cannot
    // disagree about which worktrees exist.
    expect(source).toMatch(
      /const nonMainWorktrees = useMemo\(\s*\(\) =>\s*deferredWorktrees\.filter\(\(w\) => w\.id !== mainWorktree\?\.id\)/
    );
    // quick-state counts, chip counts, the main card aggregate, and the list.
    // "All" is the number the user saw read 0 above a visible worktree, so tie
    // it to the shared array directly — iterating it is not enough, the old
    // code iterated too and then skipped the worktree it had already pinned.
    expect(source).toMatch(/all: nonMainWorktrees\.length/);
    expect(source).toMatch(/for \(const w of nonMainWorktrees\)/);
    // Chip counts read a population derived from the same shared array but
    // deliberately WIDER: the main worktree is not a list row yet is still
    // facet-filtered, so excluding it made every facet only it satisfies read
    // zero — and a zero count now disables the chip. The rule is that the
    // counted set is a superset of the rendered set, never a subset.
    // Main is added because it is facet-filtered; quick-state is applied to the
    // rest because the rows are, so a chip cannot promise matches the quick
    // state has already excluded.
    expect(source).toMatch(/const countedWorktrees = useMemo\(/);
    expect(source).toMatch(/mainWorktree \? \[mainWorktree, \.\.\.eligible\] : eligible/);
    expect(source).toMatch(
      /const eligible =\s*quickStateFilter === "all"\s*\?\s*nonMainWorktrees\s*:\s*nonMainWorktrees\.filter\(/
    );
    expect(source).toMatch(/matchesQuickStateFilter\(quickStateFilter, meta\)/);
    expect(source).toMatch(/computeChipCounts\(\s*countedWorktrees,/);
    expect(source).toMatch(/const nonMainCount = nonMainWorktrees\.length;/);
    expect(source).toMatch(/const filtered = nonMainWorktrees\.filter\(/);
    // No second, branch-derived exclusion anywhere in the sidebar: neither the
    // removed helper nor a fresh hardcoded list of "integration" branch names.
    // `next` is deliberately absent from this alternation — it's a plausible
    // ordinary string in UI code, and a false failure here teaches nothing.
    expect(source).not.toMatch(/integrationWorktree|findIntegrationWorktree/);
    expect(source).not.toMatch(/["'](?:develop|trunk)["']/);
  });

  it("computes showScope from the instant live-query filter state and count comparison", () => {
    // Compared against the same total the scope line prints, which now counts
    // the pinned main card in both halves.
    expect(source).toMatch(/showScope\s*=\s*hasFilters\s*&&\s*filteredCount\s*!==\s*scopeTotal/);
    // hasFilters mirrors the store's hasActiveFilters() but uses liveQuery so the
    // scope line reacts immediately rather than after the persisted-query debounce.
    expect(source).toMatch(/hasFilters\s*=\s*[\s\S]*?liveQuery\.trim\(\)\.length\s*>\s*0/);
  });

  it("drives the filtering memo from a deferred query so keystrokes stay responsive", () => {
    expect(source).toContain("const deferredQuery = useDeferredValue(liveQuery)");
    expect(source).toMatch(/query:\s*deferredQuery/);
  });
});

describe("SidebarContent screen-reader announcements — issue #9665", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("routes announcements through the global announcer store", () => {
    expect(source).toContain(
      'import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore"'
    );
    expect(source).toContain("useAnnouncerStore.getState().announce(");
  });

  it("debounces the count announcement on the shared Doherty threshold", () => {
    expect(source).toContain('import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils"');
    // The count announcement is scheduled on a timer cleared on re-run, so
    // rapid keystrokes coalesce into a single late announcement.
    // The template is what gets spoken: `message` is built from the count,
    // copied to `spoken` for the closure, and that is what the timer announces.
    expect(source).toMatch(/message = `\$\{filteredCount\} of \$\{scopeTotal\} worktrees`/);
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
    expect(source).toMatch(/if \(showScope\) \{[\s\S]{0,120}?wasNarrowedRef\.current = true/);
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
    expect(source).toContain("prevDragDisabledReasonRef");
    expect(source).toMatch(/dragDisabledReason !== null && prev !== dragDisabledReason/);
  });
});
