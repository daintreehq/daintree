/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  GitHubResourceListSkeleton,
  CommitListSkeleton,
  RESOURCE_ITEM_HEIGHT_PX,
  COMMIT_ITEM_HEIGHT_PX,
  MAX_SKELETON_ITEMS,
} from "../GitHubDropdownSkeletons";

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

  it("uses animate-pulse-immediate when immediate is true", () => {
    const { container } = render(<GitHubResourceListSkeleton count={1} immediate />);
    const row = container.querySelector(`[style*="height: ${RESOURCE_ITEM_HEIGHT_PX}px"]`);
    expect(row?.className).toContain("animate-pulse-immediate");
    expect(row?.className).not.toContain("animate-pulse-delayed");
  });

  it("has accessible loading markup", () => {
    const { container } = render(<GitHubResourceListSkeleton />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-busy")).toBe("true");
    expect(status?.getAttribute("aria-label")).toBe("Loading GitHub results");
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

  it("uses animate-pulse-immediate when immediate is true", () => {
    const { container } = render(<CommitListSkeleton count={1} immediate />);
    const row = container.querySelector(`[style*="height: ${COMMIT_ITEM_HEIGHT_PX}px"]`);
    expect(row?.className).toContain("animate-pulse-immediate");
  });

  it("has accessible loading markup", () => {
    const { container } = render(<CommitListSkeleton />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-label")).toBe("Loading commits");
  });
});
