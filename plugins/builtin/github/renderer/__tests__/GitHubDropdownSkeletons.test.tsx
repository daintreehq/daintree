/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import {
  GitHubResourceListSkeleton,
  CommitListSkeleton,
  ForgeOptionRowsSkeleton,
  FORGE_OPTION_ROW,
  RESOURCE_ITEM_HEIGHT_PX,
  RESOURCE_RAIL_SLOTS,
  COMMIT_ITEM_HEIGHT_PX,
  MAX_SKELETON_ITEMS,
} from "../components/GitHubDropdownSkeletons";

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

  it("defaults to MAX_SKELETON_ITEMS for undefined count", () => {
    const { container } = render(<GitHubResourceListSkeleton count={undefined} />);
    const rows = container.querySelectorAll(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(rows).toHaveLength(MAX_SKELETON_ITEMS);
  });

  it("defaults to MAX_SKELETON_ITEMS for null count", () => {
    const { container } = render(<GitHubResourceListSkeleton count={null} />);
    const rows = container.querySelectorAll(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(rows).toHaveLength(MAX_SKELETON_ITEMS);
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
    expect(status?.getAttribute("aria-busy")).toBe("true");
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
      expect(ids).toEqual(
        RESOURCE_RAIL_SLOTS[type].filter((slot) => slot.bone).map((slot) => slot.id)
      );
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

  it("clamps count above MAX_SKELETON_ITEMS", () => {
    const { container } = render(<CommitListSkeleton count={100} />);
    const rows = container.querySelectorAll(`[style*="height: ${COMMIT_ITEM_HEIGHT_PX}px"]`);
    expect(rows).toHaveLength(MAX_SKELETON_ITEMS);
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
      for (const token of FORGE_OPTION_ROW.split(" ")) {
        expect(row.className).toContain(token);
      }
      expect(row.getAttribute("style")).toBeNull();
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
