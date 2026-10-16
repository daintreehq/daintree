import { describe, it, expect } from "vitest";
import {
  ACTIVITY_OPTIONS,
  DEV_SERVER_OPTIONS,
  PR_ISSUE_OPTIONS,
  SESSION_OPTIONS,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
  describeActiveFacets,
  HAS_AGENT_LABEL,
} from "@/lib/worktreeFilterOptions";
import { WORKTREE_TYPE_IDS } from "@/lib/worktreeTypes";

const NONE = {
  statusFilters: new Set<never>(),
  typeFilters: new Set<never>(),
  prIssueFilters: new Set<never>(),
  sessionFilters: new Set<never>(),
  hasAgentFilter: false,
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

  it("names 'Has an agent' first and on its own, not as a Sessions value", () => {
    expect(describeActiveFacets({ ...NONE, hasAgentFilter: true })).toBe("Has an agent");
    expect(
      describeActiveFacets({
        ...NONE,
        hasAgentFilter: true,
        sessionFilters: new Set(["waiting"] as const),
      })
    ).toBe("Has an agent · Sessions: Waiting");
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

  it("names every value of every facet through the formatter, never as a bare key", () => {
    // Runs the real formatter with every value of every facet selected, and
    // checks each label appears and no store key leaks through. A value missing
    // from its option array would be silently dropped here and fail.
    const all = {
      statusFilters: new Set(STATUS_OPTIONS.map((o) => o.value)),
      typeFilters: new Set(TYPE_OPTIONS.map((o) => o.value)),
      prIssueFilters: new Set(PR_ISSUE_OPTIONS.map((o) => o.value)),
      sessionFilters: new Set(SESSION_OPTIONS.map((o) => o.value)),
      hasAgentFilter: true,
      activityFilters: new Set(ACTIVITY_OPTIONS.map((o) => o.value)),
      devServerFilters: new Set(DEV_SERVER_OPTIONS.map((o) => o.value)),
    };
    const out = describeActiveFacets(all);
    for (const options of [
      STATUS_OPTIONS,
      TYPE_OPTIONS,
      PR_ISSUE_OPTIONS,
      SESSION_OPTIONS,
      ACTIVITY_OPTIONS,
      DEV_SERVER_OPTIONS,
    ]) {
      for (const option of options) {
        expect(option.label.trim()).not.toBe("");
        expect(out).toContain(option.label);
        if (option.label !== option.value) {
          // "Has an agent" is a facet with no key, so its words are not a leak.
          expect(out.replace(HAS_AGENT_LABEL, "").split(/[:,·\s]+/)).not.toContain(option.value);
        }
      }
    }
    for (const title of [
      "Status",
      "Branch type",
      "Issues & PRs",
      "Sessions",
      "Activity",
      "Dev server",
    ]) {
      expect(out).toContain(`${title}:`);
    }
  });
});

describe("TYPE_OPTIONS", () => {
  it("offers every worktree type exactly once, each with a label", () => {
    const values = TYPE_OPTIONS.map((option) => option.value);
    expect([...values].sort()).toEqual([...WORKTREE_TYPE_IDS].sort());
    expect(TYPE_OPTIONS.every((option) => option.label.length > 0)).toBe(true);
  });
});
