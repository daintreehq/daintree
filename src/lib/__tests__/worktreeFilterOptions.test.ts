import { describe, it, expect } from "vitest";
import { describeActiveFacets, TYPE_OPTIONS } from "@/lib/worktreeFilterOptions";

const NONE = {
  statusFilters: new Set<never>(),
  typeFilters: new Set<never>(),
  prIssueFilters: new Set<never>(),
  sessionFilters: new Set<never>(),
  activityFilters: new Set<never>(),
  devServerFilters: new Set<never>(),
};

describe("describeActiveFacets", () => {
  it("says nothing when nothing is filtered", () => {
    expect(describeActiveFacets(NONE)).toBe("");
  });

  it("names the facet as well as the value", () => {
    // "Dirty" alone does not say which axis it constrains, and the sidebar has
    // no room to show the popover's section headings.
    expect(describeActiveFacets({ ...NONE, statusFilters: new Set(["dirty"] as const) })).toBe(
      "Status: Dirty"
    );
  });

  it("joins several values within a facet, and several facets", () => {
    expect(
      describeActiveFacets({
        ...NONE,
        statusFilters: new Set(["dirty"] as const),
        typeFilters: new Set(["feature", "bugfix"] as const),
      })
    ).toBe("Status: Dirty · Branch type: Feature, Bugfix");
  });

  it("orders values by the option list, not by when they were toggled", () => {
    // Otherwise the summary reshuffles under the user as they toggle chips.
    const a = describeActiveFacets({
      ...NONE,
      typeFilters: new Set(["bugfix", "feature"] as const),
    });
    const b = describeActiveFacets({
      ...NONE,
      typeFilters: new Set(["feature", "bugfix"] as const),
    });
    expect(a).toBe(b);
    expect(a).toBe("Branch type: Feature, Bugfix");
  });

  it("can name every value it offers", () => {
    // The rule, not a fixed list: every option carries a non-empty label, so a
    // new facet value can never show up in the summary as a bare store key.
    for (const option of TYPE_OPTIONS) {
      expect(option.label.trim()).not.toBe("");
      expect(option.label).not.toBe(option.value);
    }
  });
});
