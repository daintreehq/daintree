// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { WorktreeFilterPopover } from "../WorktreeFilterPopover";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";

const SOURCE = fs.readFileSync(path.resolve(__dirname, "../WorktreeFilterPopover.tsx"), "utf-8");

function openPopover() {
  return render(
    <WorktreeFilterPopover appearance="field" hideSearchInput open onOpenChange={() => {}} />
  );
}

describe("WorktreeFilterPopover derives its filter state from one snapshot", () => {
  beforeEach(() => {
    useWorktreeFilterStore.getState().clearAll();
  });
  afterEach(cleanup);

  // The defect this guards: the trigger's count came from
  // `getActiveFilterCount()` and the footer from `hasActiveFilters()`, two
  // helpers that reread the project store imperatively at call time. They are
  // logically equivalent, so they can only disagree by observing the store at
  // two different instants — which is exactly what happened: the trigger
  // showed "3" while the bulk-clear footer was absent from the DOM, leaving no
  // way out of three active filters except clearing each axis by hand.
  it("does not call the store's derived predicates during render", () => {
    const body = SOURCE.slice(SOURCE.indexOf("export function WorktreeFilterPopover"))
      // Strip comments: this file explains the defect by naming the helpers,
      // and the rule is about calls, not prose.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(body).not.toMatch(/\bhasActiveFilters\(\)/);
    expect(body).not.toMatch(/\bgetActiveFilterCount\(\)/);
  });

  it("shows a count and a bulk clear together whenever a facet filter is on", () => {
    useWorktreeFilterStore.getState().toggleStatusFilter("dirty");
    openPopover();
    const trigger = screen.getByLabelText(/^Filter and sort worktrees/);
    expect(trigger.textContent).toContain("1");
    expect(screen.queryByText("Clear all filters")).not.toBeNull();
  });

  it("offers a bulk clear for a query-only filter, and no count beside it", () => {
    // The query is a filter — it belongs in the bulk clear. It is NOT one of
    // the filters the trigger counts, because it is already visible in the
    // field next to the trigger; counting it lit the control up with no number
    // beside it, which read as "a filter is on" pointing at nothing.
    useWorktreeFilterStore.getState().setQuery("auth");
    openPopover();
    const trigger = screen.getByLabelText(/^Filter and sort worktrees/);
    expect(trigger.textContent?.trim()).toBe("");
    // Boundary-matched: the resting trigger legitimately carries
    // `hover:bg-overlay-soft`, so a substring check would always pass.
    expect(trigger.className).not.toMatch(/(?:^|\s)bg-overlay-soft(?:\s|$)/);
    expect(screen.queryByText("Clear all filters")).not.toBeNull();
  });

  it("offers no bulk clear when nothing is filtered", () => {
    openPopover();
    expect(screen.queryByText("Clear all filters")).toBeNull();
  });

  it("keeps the trigger's count and its active styling in agreement", () => {
    // One derived number drives both, so the control can never look switched
    // on while showing nothing, or show a number while looking switched off.
    useWorktreeFilterStore.getState().toggleTypeFilter("feature");
    useWorktreeFilterStore.getState().toggleTypeFilter("bugfix");
    openPopover();
    const trigger = screen.getByLabelText(/^Filter and sort worktrees/);
    expect(trigger.textContent).toContain("2");
    expect(trigger.className).toMatch(/(?:^|\s)bg-overlay-soft(?:\s|$)/);
  });
});

describe("WorktreeFilterPopover chip states are told apart without colour", () => {
  beforeEach(() => {
    useWorktreeFilterStore.getState().clearAll();
  });
  afterEach(cleanup);

  const COUNTS = {
    status: { active: 0, dirty: 3, stale: 0, idle: 2 },
    branchType: {
      feature: 2,
      bugfix: 1,
      refactor: 0,
      chore: 0,
      docs: 0,
      test: 0,
      release: 0,
      ci: 0,
      deps: 0,
      perf: 0,
      style: 0,
      wip: 0,
      main: 0,
      detached: 0,
      other: 0,
    },
    prIssue: { hasIssue: 0, hasPR: 0, prOpen: 0, prMerged: 0, prClosed: 0 },
    sessions: { hasTerminals: 0, working: 0, waiting: 0, completed: 0, exited: 0 },
    activity: { last15m: 0, last1h: 0, last24h: 0, last7d: 0 },
    devServer: { hasDevServer: 0, running: 0, starting: 0, error: 0 },
  } as never;

  function openWithCounts() {
    return render(
      <WorktreeFilterPopover
        appearance="field"
        hideSearchInput
        open
        onOpenChange={() => {}}
        chipCounts={COUNTS}
      />
    );
  }

  function chip(name: RegExp) {
    return screen.getAllByRole("button").find((b) => name.test(b.textContent ?? ""));
  }

  it("disables a value that matches nothing rather than letting it empty the list", () => {
    // The dead-end trap: selecting a zero-count value can only produce an empty
    // list, so it must not be selectable at all.
    openWithCounts();
    const dead = chip(/^Active/);
    expect(dead).toBeDefined();
    expect((dead as HTMLButtonElement).disabled).toBe(true);
    const live = chip(/^Dirty/);
    expect((live as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps a value's count visible even when it drops to zero", () => {
    // The count used to vanish at zero, so a chip's label changed as filters
    // moved and the grid reflowed underneath the pointer.
    openWithCounts();
    expect(chip(/^Active/)?.textContent).toContain("(0)");
  });

  it("marks selection with something that is not a fill or a text tone", () => {
    // Hovering an unselected chip already raises its fill and takes its text to
    // text-primary, so if selection were carried by fill or tone alone the two
    // would be indistinguishable while the pointer was in the grid. Selection
    // must add a glyph — which also survives forced-colors, where fills flatten.
    openWithCounts();
    const before = chip(/^Dirty/);
    const glyphsBefore = before?.querySelectorAll("svg").length ?? 0;
    fireEvent.click(before!);
    const after = chip(/^Dirty/);
    expect(after?.getAttribute("aria-pressed")).toBe("true");
    expect(after?.querySelectorAll("svg").length ?? 0).toBeGreaterThan(glyphsBefore);
  });

  it("folds a long facet's dead values behind one control, keeping the live ones", () => {
    // Branch type carries fifteen values and a real repository uses three or
    // four. The rule is that what is shown is what can do something.
    openWithCounts();
    expect(chip(/^Feature/)).toBeDefined();
    expect(chip(/^Bugfix/)).toBeDefined();
    expect(chip(/^Detached/)).toBeUndefined();
    const more = screen.getByText(/with no matches$/);
    fireEvent.click(more);
    expect(chip(/^Detached/)).toBeDefined();
  });

  it("never folds away a value the user has selected", () => {
    // A filter narrowing the list from behind a fold is invisible state. The
    // cap spends its room on unselected values; selections are not negotiable.
    const many = {
      ...COUNTS,
      branchType: Object.fromEntries(
        Object.keys((COUNTS as never as { branchType: Record<string, number> }).branchType).map(
          (k) => [k, 0]
        )
      ),
    } as never;
    const store = useWorktreeFilterStore.getState();
    const picked = [
      "feature",
      "bugfix",
      "refactor",
      "chore",
      "docs",
      "test",
      "release",
      "ci",
      "deps",
    ] as const;
    for (const v of picked) store.toggleTypeFilter(v);
    render(
      <WorktreeFilterPopover
        appearance="field"
        hideSearchInput
        open
        onOpenChange={() => {}}
        chipCounts={many}
      />
    );
    const labels = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    for (const v of picked) {
      const label = v === "ci" ? "CI" : v[0]!.toUpperCase() + v.slice(1);
      expect(labels.some((l) => l.startsWith(label))).toBe(true);
    }
  });

  it("only says 'no matches' when that is true of everything it folded", () => {
    // Past the cap some hidden values do match; calling them "no matches" tells
    // the user there is nothing under there worth opening.
    const manyMatching = {
      ...COUNTS,
      branchType: {
        feature: 1,
        bugfix: 1,
        refactor: 1,
        chore: 1,
        docs: 1,
        test: 1,
        release: 1,
        ci: 1,
        deps: 1,
        perf: 1,
        style: 1,
        wip: 1,
        main: 0,
        detached: 0,
        other: 0,
      },
    } as never;
    render(
      <WorktreeFilterPopover
        appearance="field"
        hideSearchInput
        open
        onOpenChange={() => {}}
        chipCounts={manyMatching}
      />
    );
    expect(screen.queryByText(/with no matches$/)).toBeNull();
    expect(screen.getByText(/\d+ more$/)).toBeTruthy();
  });

  it("names each chip's facet through a labelled group", () => {
    // A chip announced as "Working" alone does not say which axis it filters.
    openWithCounts();
    const groups = screen.getAllByRole("group");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const labelledBy = group.getAttribute("aria-labelledby");
      expect(labelledBy).toBeTruthy();
      expect(document.getElementById(labelledBy!)?.textContent?.trim()).toBeTruthy();
    }
  });
});

describe("WorktreeFilterPopover surfaces its own state", () => {
  beforeEach(() => {
    useWorktreeFilterStore.getState().clearAll();
  });
  afterEach(cleanup);

  it("speaks the active-filter count, not just draws it", () => {
    // `aria-label` overrides an element's contents when the accessible name is
    // computed, so a count rendered as text inside the button was unspoken.
    useWorktreeFilterStore.getState().toggleStatusFilter("dirty");
    useWorktreeFilterStore.getState().toggleTypeFilter("feature");
    openPopover();
    const trigger = screen.getByLabelText(/^Filter and sort worktrees/);
    expect(trigger.textContent).toContain("2");
    expect(trigger.getAttribute("aria-label")).toContain("2");
  });

  it("keeps the bulk clear out of the scrolling body", () => {
    // With several sections open the only escape from a filtered list used to
    // scroll away with them.
    useWorktreeFilterStore.getState().toggleStatusFilter("dirty");
    const { container } = openPopover();
    const clear = screen.getByText("Clear all filters");
    const scroller = container.ownerDocument.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(clear)).toBe(false);
  });

  it("says what it is sorted by while the sort section is shut", () => {
    openPopover();
    const header = screen.getByRole("button", { name: /Sort by/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.textContent).toContain("Date created");
  });
});

/**
 * Sort is a disclosure like every other section, so its body is `aria-hidden`
 * and `inert` until it is opened — which is what a collapsed panel means. The
 * radio assertions below open it first and then check the same APG contract.
 */
function expandSort() {
  fireEvent.click(screen.getByRole("button", { name: /Sort by/ }));
}

describe("WorktreeFilterPopover keyboard and focus surfaces", () => {
  beforeEach(() => {
    // clearAll() resets the project-scoped filters; sort order and grouping are
    // global preferences and would otherwise leak between tests.
    useWorktreeFilterStore.getState().clearAll();
    useWorktreeFilterStore.getState().setGroupByType(false);
    useWorktreeFilterStore.getState().setOrderBy("created");
  });
  afterEach(cleanup);

  it("gives the trigger the app's accent focus ring rather than the browser's", () => {
    // Every other control in the sidebar rail carries this; without it the
    // trigger fell back to the UA's own outline, which is a different colour
    // from the rest of the surface.
    openPopover();
    const trigger = screen.getByLabelText(/^Filter and sort worktrees/);
    expect(trigger.className).toMatch(/focus-visible:outline\b/);
    expect(trigger.className).toContain("outline-accent-primary");
  });

  it("owns its sort radios with a labelled radiogroup", () => {
    // `role="radio"` outside a radiogroup is invalid ARIA — the options were
    // announced as four unrelated radios with no group name.
    openPopover();
    expandSort();
    const group = screen.getByRole("radiogroup");
    expect(group).not.toBeNull();
    // Named, by either mechanism — APG requires the group carry an accessible
    // name, not that it carry one particular attribute. It is `aria-label`
    // here because the visible heading is the disclosure button, whose text
    // also holds the current-order summary.
    const labelledBy = group.getAttribute("aria-labelledby");
    const accessibleName = labelledBy
      ? (document.getElementById(labelledBy)?.textContent ?? "")
      : (group.getAttribute("aria-label") ?? "");
    expect(accessibleName.trim()).not.toBe("");
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBeGreaterThan(1);
    for (const radio of radios) {
      expect(group.contains(radio)).toBe(true);
    }
  });

  it("names every radio group option and marks exactly one checked", () => {
    openPopover();
    expandSort();
    const radios = screen.getAllByRole("radio");
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("is one tab stop, with the checked option holding it", () => {
    // A radio group is a single stop; without a roving index every option was
    // its own stop, so Tab walked four times through one choice.
    openPopover();
    expandSort();
    const radios = screen.getAllByRole("radio");
    const tabbable = radios.filter((r) => r.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.getAttribute("aria-checked")).toBe("true");
  });

  it("moves selection and focus with the arrows, and wraps at the ends", () => {
    // Selection follows focus, which is the APG default for a radio group.
    openPopover();
    expandSort();
    const radios = () => screen.getAllByRole("radio");
    const checkedIndex = () => radios().findIndex((r) => r.getAttribute("aria-checked") === "true");
    const count = radios().length;
    const start = checkedIndex();

    fireEvent.keyDown(radios()[start]!, { key: "ArrowDown" });
    expect(checkedIndex()).toBe((start + 1) % count);
    expect(document.activeElement).toBe(radios()[(start + 1) % count]);

    fireEvent.keyDown(radios()[0]!, { key: "ArrowLeft" });
    expect(checkedIndex()).toBe(count - 1);
    expect(document.activeElement).toBe(radios()[count - 1]);
  });

  it("jumps to the ends with Home and End, like the app's other radio group", () => {
    openPopover();
    expandSort();
    const radios = () => screen.getAllByRole("radio");
    const checkedIndex = () => radios().findIndex((r) => r.getAttribute("aria-checked") === "true");

    fireEvent.keyDown(radios()[0]!, { key: "End" });
    expect(checkedIndex()).toBe(radios().length - 1);

    fireEvent.keyDown(radios()[radios().length - 1]!, { key: "Home" });
    expect(checkedIndex()).toBe(0);
  });

  it("keeps exactly one tabbable option when grouping removes an option", () => {
    // "Custom order" leaves the list while grouping is on. Whatever the store
    // does with the selection, the group must never end up with no tab stop.
    useWorktreeFilterStore.getState().setOrderBy("manual");
    useWorktreeFilterStore.getState().setGroupByType(true);
    openPopover();
    expandSort();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).not.toContain("Custom order");
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
  });
});
