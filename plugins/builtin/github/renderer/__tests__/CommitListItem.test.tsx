/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { CommitListItem } from "../components/CommitListItem";
import type { GitCommit } from "@shared/types/github";

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: (date: string) => `time:${date}`,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

const baseCommit: GitCommit = {
  hash: "a1b2c3d4e5f6",
  shortHash: "a1b2c3d",
  message: "feat(auth): add login flow",
  body: "This adds a complete login flow with OAuth.\n\nSupports Google and GitHub.",
  author: { name: "Alice", email: "alice@example.com" },
  date: "2026-01-01T00:00:00Z",
};

const commitNoBody: GitCommit = {
  ...baseCommit,
  hash: "b2c3d4e5f6a7",
  shortHash: "b2c3d4e",
  body: undefined,
};

const commitWhitespaceBody: GitCommit = {
  ...baseCommit,
  hash: "c3d4e5f6a7b8",
  shortHash: "c3d4e5f",
  body: "\n   \n\t\n",
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CommitListItem", () => {
  it("renders subject (parsed conventional commit)", () => {
    render(<CommitListItem commit={baseCommit} />);
    expect(screen.getByText("feat")).toBeTruthy();
    expect(screen.getByText("(auth)")).toBeTruthy();
    expect(screen.getByText(": add login flow")).toBeTruthy();
  });

  it("renders metadata row with author, time, and hash button", () => {
    render(<CommitListItem commit={baseCommit} />);
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("time:2026-01-01T00:00:00Z")).toBeTruthy();
    expect(screen.getByLabelText("Copy hash a1b2c3d")).toBeTruthy();
  });

  it("renders chevron when commit has a body", () => {
    const { container } = render(<CommitListItem commit={baseCommit} />);
    expect(container.querySelector("[data-animated-chevron]")).not.toBeNull();
  });

  it("does not render chevron when body is missing", () => {
    const { container } = render(<CommitListItem commit={commitNoBody} />);
    expect(container.querySelector("[data-animated-chevron]")).toBeNull();
  });

  it("treats whitespace-only body as no body (no chevron)", () => {
    const { container } = render(<CommitListItem commit={commitWhitespaceBody} />);
    expect(container.querySelector("[data-animated-chevron]")).toBeNull();
  });

  it("chevron rotates 90deg when expanded", () => {
    const { container } = render(<CommitListItem commit={baseCommit} isExpanded />);
    const chevron = container.querySelector("[data-animated-chevron]");
    expect(chevron?.getAttribute("class") ?? "").toContain("rotate-90");
  });

  it("chevron is not rotated when collapsed", () => {
    const { container } = render(<CommitListItem commit={baseCommit} isExpanded={false} />);
    const chevron = container.querySelector("[data-animated-chevron]");
    expect(chevron?.getAttribute("class") ?? "").not.toContain("rotate-90");
  });

  it("sets aria-expanded when body exists", () => {
    const { container } = render(<CommitListItem commit={baseCommit} isExpanded />);
    const option = container.querySelector("[role='option']");
    expect(option?.getAttribute("aria-expanded")).toBe("true");
  });

  it("omits aria-expanded when body is missing", () => {
    const { container } = render(<CommitListItem commit={commitNoBody} />);
    const option = container.querySelector("[role='option']");
    expect(option?.hasAttribute("aria-expanded")).toBe(false);
  });

  it("calls onToggle with commit hash on row click when body exists", () => {
    const onToggle = vi.fn();
    const { container } = render(<CommitListItem commit={baseCommit} onToggle={onToggle} />);
    fireEvent.click(container.querySelector("[role='option']")!);
    expect(onToggle).toHaveBeenCalledWith(baseCommit.hash);
  });

  it("does not call onToggle on row click when body is missing", () => {
    const onToggle = vi.fn();
    const { container } = render(<CommitListItem commit={commitNoBody} onToggle={onToggle} />);
    fireEvent.click(container.querySelector("[role='option']")!);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("does not call onToggle on row click when body is whitespace-only", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CommitListItem commit={commitWhitespaceBody} onToggle={onToggle} />
    );
    fireEvent.click(container.querySelector("[role='option']")!);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("renders body in a pre block when expanded", () => {
    const { container } = render(<CommitListItem commit={baseCommit} isExpanded />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("This adds a complete login flow with OAuth.");
    expect(pre?.textContent).toContain("Supports Google and GitHub.");
  });

  it("body pre uses whitespace-pre-wrap and break-words", () => {
    const { container } = render(<CommitListItem commit={baseCommit} isExpanded />);
    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(pre?.className).toContain("break-words");
  });

  it("body region toggles grid-rows class for height animation", () => {
    const { container, rerender } = render(
      <CommitListItem commit={baseCommit} isExpanded={false} />
    );
    const region = container.querySelector(".grid.transition-\\[grid-template-rows\\]");
    expect(region?.className).toContain("grid-rows-[0fr]");

    rerender(<CommitListItem commit={baseCommit} isExpanded />);
    const expandedRegion = container.querySelector(".grid.transition-\\[grid-template-rows\\]");
    expect(expandedRegion?.className).toContain("grid-rows-[1fr]");
  });

  it("body region is not rendered when body is missing", () => {
    const { container } = render(<CommitListItem commit={commitNoBody} />);
    expect(container.querySelector(".grid.transition-\\[grid-template-rows\\]")).toBeNull();
  });

  it("collapsed body region is aria-hidden", () => {
    const { container } = render(<CommitListItem commit={baseCommit} isExpanded={false} />);
    const region = container.querySelector(".grid.transition-\\[grid-template-rows\\]");
    expect(region?.getAttribute("aria-hidden")).toBe("true");
  });

  it("expanded body region is not aria-hidden", () => {
    const { container } = render(<CommitListItem commit={baseCommit} isExpanded />);
    const region = container.querySelector(".grid.transition-\\[grid-template-rows\\]");
    expect(region?.getAttribute("aria-hidden")).toBe("false");
  });

  it("hash copy button stops propagation so row toggle does not fire", async () => {
    const onToggle = vi.fn();
    render(<CommitListItem commit={baseCommit} onToggle={onToggle} />);
    const copyButton = screen.getByLabelText("Copy hash a1b2c3d");
    await act(async () => {
      fireEvent.click(copyButton);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(baseCommit.hash);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("clicking hash button shows check icon then reverts after timeout", async () => {
    render(<CommitListItem commit={baseCommit} />);
    const copyButton = screen.getByLabelText("Copy hash a1b2c3d");
    await act(async () => {
      fireEvent.click(copyButton);
    });
    expect(copyButton.querySelector(".text-status-success")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(copyButton.querySelector(".text-status-success")).toBeNull();
  });

  it("row has cursor-pointer when body exists", () => {
    const { container } = render(<CommitListItem commit={baseCommit} />);
    const option = container.querySelector("[role='option']");
    expect(option?.className).toContain("cursor-pointer");
  });

  it("row has cursor-default when body is missing", () => {
    const { container } = render(<CommitListItem commit={commitNoBody} />);
    const option = container.querySelector("[role='option']");
    expect(option?.className).toContain("cursor-default");
  });

  it("applies aria-selected when isActive", () => {
    const { container } = render(<CommitListItem commit={baseCommit} isActive />);
    const option = container.querySelector("[role='option']");
    expect(option?.getAttribute("aria-selected")).toBe("true");
  });
});
