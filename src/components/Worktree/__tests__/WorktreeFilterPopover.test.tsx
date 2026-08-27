// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { render, screen, cleanup } from "@testing-library/react";
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
    const trigger = screen.getByLabelText("Filter and sort worktrees");
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
    const trigger = screen.getByLabelText("Filter and sort worktrees");
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
    const trigger = screen.getByLabelText("Filter and sort worktrees");
    expect(trigger.textContent).toContain("2");
    expect(trigger.className).toMatch(/(?:^|\s)bg-overlay-soft(?:\s|$)/);
  });
});

describe("WorktreeFilterPopover keyboard and focus surfaces", () => {
  beforeEach(() => {
    useWorktreeFilterStore.getState().clearAll();
  });
  afterEach(cleanup);

  it("gives the trigger the app's accent focus ring rather than the browser's", () => {
    // Every other control in the sidebar rail carries this; without it the
    // trigger fell back to the UA's own outline, which is a different colour
    // from the rest of the surface.
    openPopover();
    const trigger = screen.getByLabelText("Filter and sort worktrees");
    expect(trigger.className).toMatch(/focus-visible:outline\b/);
    expect(trigger.className).toContain("outline-daintree-accent");
  });

  it("owns its sort radios with a labelled radiogroup", () => {
    // `role="radio"` outside a radiogroup is invalid ARIA — the options were
    // announced as four unrelated radios with no group name.
    openPopover();
    const group = screen.getByRole("radiogroup");
    expect(group).not.toBeNull();
    expect(group.getAttribute("aria-labelledby")).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBeGreaterThan(1);
    for (const radio of radios) {
      expect(group.contains(radio)).toBe(true);
    }
  });

  it("names every radio group option and marks exactly one checked", () => {
    openPopover();
    const radios = screen.getAllByRole("radio");
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });
});
