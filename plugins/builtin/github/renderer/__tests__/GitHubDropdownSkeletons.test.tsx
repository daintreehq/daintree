/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import {
  GitHubResourceListSkeleton,
  CommitListSkeleton,
  ForgeOptionRowsSkeleton,
  FORGE_OPTION_LINE,
  FORGE_OPTION_ROW,
  RESOURCE_ITEM_HEIGHT_PX,
  RESOURCE_RAIL_ORDER,
  RESOURCE_RAIL_SLOT,
  COMMIT_ITEM_HEIGHT_PX,
  MAX_SKELETON_ITEMS,
} from "../components/GitHubDropdownSkeletons";
import { resetGitHubFilterStore, useGitHubFilterStore } from "../stores/githubFilterStore";

describe("GitHubResourceListSkeleton", () => {
  it("renders MAX_SKELETON_ITEMS rows by default", () => {
    const { container } = render(<GitHubResourceListSkeleton />);
    const rows = container.querySelectorAll(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(rows).toHaveLength(MAX_SKELETON_ITEMS);
  });

  it("renders specified count of rows", () => {
    const { container } = render(<GitHubResourceListSkeleton count={3} />);
    const rows = container.querySelectorAll(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(rows).toHaveLength(3);
  });

  it("clamps count above MAX_SKELETON_ITEMS", () => {
    const { container } = render(<GitHubResourceListSkeleton count={20} />);
    const rows = container.querySelectorAll(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(rows).toHaveLength(MAX_SKELETON_ITEMS);
  });

  it("clamps count below 1 to 1", () => {
    const { container } = render(<GitHubResourceListSkeleton count={0} />);
    const rows = container.querySelectorAll(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(rows).toHaveLength(1);
  });

  it("uses animate-pulse-delayed by default", () => {
    const { container } = render(<GitHubResourceListSkeleton count={1} />);
    const row = container.querySelector(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(row?.className).toContain("animate-pulse-delayed");
    expect(row?.className).not.toContain("animate-pulse-immediate");
  });

  it("uses animate-pulse-delayed during the 200ms gate when immediate is true", () => {
    vi.useFakeTimers();
    const { container } = render(<GitHubResourceListSkeleton count={1} immediate />);
    const row = container.querySelector(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(row?.className).toContain("animate-pulse-delayed");
    expect(row?.className).not.toContain("animate-pulse-immediate");
    vi.useRealTimers();
  });

  it("switches to animate-pulse-immediate after the 200ms gate when immediate is true", () => {
    vi.useFakeTimers();
    const { container } = render(<GitHubResourceListSkeleton count={1} immediate />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const row = container.querySelector(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(row?.className).toContain("animate-pulse-immediate");
    expect(row?.className).not.toContain("animate-pulse-delayed");
    vi.useRealTimers();
  });

  it("has accessible loading markup", () => {
    const { container } = render(<GitHubResourceListSkeleton />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.closest('[aria-busy="true"]')).toBeNull();
    expect(status?.getAttribute("aria-label")).toBe("Loading GitHub results");
  });

  it("hands the rows the type it was given, which they need to pick a rail", () => {
    // The panel skeleton took `type` for its tabs and search copy and then
    // dropped it, so a PR panel drew an issue's rail under a PR's header.
    for (const type of ["issue", "pr"] as const) {
      const { container, unmount } = render(<GitHubResourceListSkeleton count={1} type={type} />);
      const ids = Array.from(container.querySelectorAll("[data-rail-slot]")).map((slot) =>
        slot.getAttribute("data-rail-slot")
      );
      expect(ids).toEqual(RESOURCE_RAIL_ORDER[type].filter((id) => RESOURCE_RAIL_SLOT[id].bone));
      unmount();
    }
  });

  it("reserves every header icon slot the loaded list renders", () => {
    // Refresh, sort and bulk-select. One slot short and the search field
    // jumps narrower the moment real content replaces this.
    const { container } = render(<GitHubResourceListSkeleton />);
    const header = container.querySelector(".border-b");
    const slots = header?.querySelectorAll(".w-8.h-8");
    expect(slots).toHaveLength(3);
  });
});

describe("GitHubResourceListSkeleton header state", () => {
  afterEach(() => {
    resetGitHubFilterStore();
  });

  // Where the thumb actually sits, not just which segment is marked.
  const thumbs = (type: "issue" | "pr") => {
    const { container, unmount } = render(<GitHubResourceListSkeleton type={type} />);
    const owners = Array.from(container.querySelectorAll('[data-slot="segmented-thumb"]')).map(
      (thumb) => thumb.closest("[data-segment]")?.getAttribute("data-segment")
    );
    unmount();
    return owners;
  };

  const sortLifted = (type: "issue" | "pr") => {
    const { container, unmount } = render(<GitHubResourceListSkeleton type={type} />);
    const lifted = container
      .querySelector('[data-header-slot="sort"]')!
      .classList.contains("bg-overlay-soft");
    unmount();
    return lifted;
  };

  const field = (type: "issue" | "pr") => {
    const { container, unmount } = render(<GitHubResourceListSkeleton type={type} />);
    const el = container.querySelector("[data-search-field]")!;
    const result = {
      text: el.textContent,
      clear: el.querySelector(".search-field-clear") !== null,
    };
    unmount();
    return result;
  };

  it("puts one thumb on Open for both types by default", () => {
    expect(thumbs("issue")).toEqual(["open"]);
    expect(thumbs("pr")).toEqual(["open"]);
  });

  it("puts the thumb on the state each type's panel was left on", () => {
    // The loaded control reads the persisted filter, so a panel reopened on
    // Closed would otherwise slide its thumb the moment the list landed.
    useGitHubFilterStore.setState({ issueFilter: "closed" });
    expect(thumbs("issue")).toEqual(["closed"]);
    expect(thumbs("pr")).toEqual(["open"]);
    useGitHubFilterStore.setState({ issueFilter: "open", prFilter: "merged" });
    expect(thumbs("issue")).toEqual(["open"]);
    expect(thumbs("pr")).toEqual(["merged"]);
  });

  it("lifts the sort slot only under its own type's non-default sort", () => {
    expect([sortLifted("issue"), sortLifted("pr")]).toEqual([false, false]);
    useGitHubFilterStore.setState({ issueSortOrder: "updated" });
    expect([sortLifted("issue"), sortLifted("pr")]).toEqual([true, false]);
    useGitHubFilterStore.setState({ issueSortOrder: "created", prSortOrder: "updated" });
    expect([sortLifted("issue"), sortLifted("pr")]).toEqual([false, true]);
  });

  it("shows its own type's persisted query and clear button in place of the placeholder", () => {
    expect(field("issue")).toEqual({ text: "Search issues…", clear: false });
    expect(field("pr")).toEqual({ text: "Search pull requests…", clear: false });
    useGitHubFilterStore.setState({ issueSearchQuery: "skeleton drift" });
    expect(field("issue")).toEqual({ text: "skeleton drift", clear: true });
    expect(field("pr")).toEqual({ text: "Search pull requests…", clear: false });
    useGitHubFilterStore.setState({ issueSearchQuery: "", prSearchQuery: "head ref" });
    expect(field("issue")).toEqual({ text: "Search issues…", clear: false });
    expect(field("pr")).toEqual({ text: "head ref", clear: true });
  });
});

describe("CommitListSkeleton", () => {
  it("renders MAX_SKELETON_ITEMS rows by default", () => {
    const { container } = render(<CommitListSkeleton />);
    const rows = container.querySelectorAll(`[style*="height: ${COMMIT_ITEM_HEIGHT_PX}px"]`);
    expect(rows).toHaveLength(MAX_SKELETON_ITEMS);
  });

  it("renders specified count of rows", () => {
    const { container } = render(<CommitListSkeleton count={2} />);
    const rows = container.querySelectorAll(`[style*="height: ${COMMIT_ITEM_HEIGHT_PX}px"]`);
    expect(rows).toHaveLength(2);
  });

  it("uses animate-pulse-delayed during the 200ms gate when immediate is true", () => {
    vi.useFakeTimers();
    const { container } = render(<CommitListSkeleton count={1} immediate />);
    const row = container.querySelector(`[style*="height: ${COMMIT_ITEM_HEIGHT_PX}px"]`);
    expect(row?.className).toContain("animate-pulse-delayed");
    vi.useRealTimers();
  });

  it("switches to animate-pulse-immediate after the 200ms gate when immediate is true", () => {
    vi.useFakeTimers();
    const { container } = render(<CommitListSkeleton count={1} immediate />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const row = container.querySelector(`[style*="height: ${COMMIT_ITEM_HEIGHT_PX}px"]`);
    expect(row?.className).toContain("animate-pulse-immediate");
    vi.useRealTimers();
  });

  it("has accessible loading markup", () => {
    const { container } = render(<CommitListSkeleton />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-label")).toBe("Loading commits");
  });
});

describe("ForgeOptionRowsSkeleton", () => {
  it("draws the option row's own geometry, not the 64px resource row", () => {
    // `IssueSelector` borrowed the resource skeleton for a single-line popover
    // option, so its list collapsed to a third the height when issues landed.
    const { container } = render(<ForgeOptionRowsSkeleton count={3} />);
    const rows = container.querySelectorAll('[aria-hidden="true"] > div');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expectTokens(row, FORGE_OPTION_ROW);
      // No inline height: the option sizes to its own content, unlike the
      // 64px resource row this used to borrow.
      expect(row.getAttribute("style")).toBeNull();
      // The line box the loaded option gets from `text-sm` and a bone has
      // none of. Without it every row comes up 4px short.
      expectTokens(row.querySelector("[data-option-line]")!, FORGE_OPTION_LINE);
    }
  });

  it("clamps its count the way every other skeleton here does", () => {
    const { container } = render(<ForgeOptionRowsSkeleton count={99} />);
    expect(container.querySelectorAll('[aria-hidden="true"] > div')).toHaveLength(
      MAX_SKELETON_ITEMS
    );
  });

  it("pulses immediately when the caller already knows the wait is long", () => {
    const { container } = render(<ForgeOptionRowsSkeleton count={1} immediate />);
    const row = container.querySelector('[aria-hidden="true"] > div');
    expect(row?.className).toContain("animate-pulse-immediate");
    expect(row?.className).not.toContain("animate-pulse-delayed");
  });
});

/** Whole tokens only — a substring check would accept `w-40` for `w-4`. */
function expectTokens(el: Element, classes: string) {
  const present = Array.from(el.classList);
  for (const token of classes.split(" ").filter(Boolean)) {
    expect(present).toContain(token);
  }
}
