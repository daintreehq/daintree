// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PendingCreation } from "@/store/worktreeStore";
import { SKELETON_HINT_FIRST_THRESHOLD_MS } from "@/components/ui/Skeleton";
import { WorktreeCardPlaceholder } from "../WorktreeCardPlaceholder";

const NOW = 1_700_000_000_000;

function pending(overrides: Partial<PendingCreation> = {}): PendingCreation {
  return {
    path: "/repo-worktrees/stream-upload-retry",
    branch: "feature/stream-upload-retry",
    startedAt: NOW,
    status: "creating",
    ...overrides,
  };
}

function renderRow(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("WorktreeCardPlaceholder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("while creating", () => {
    it("names the branch being created, visibly and to assistive tech", () => {
      const { container } = renderRow(
        <WorktreeCardPlaceholder
          pendingCreation={pending()}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
      const status = screen.getByRole("status");
      expect(status.textContent).toBe("Creating worktree feature/stream-upload-retry");
      expect(status.closest('[aria-busy="true"]')).toBeNull();
      expect(container.textContent).toContain("stream-upload-retry");
    });

    it("registers its live region empty and fills it a commit later, so it is announced", () => {
      // Static markup is the first commit, before any effect runs.
      const row = (
        <TooltipProvider>
          <WorktreeCardPlaceholder
            pendingCreation={pending()}
            onRetry={vi.fn()}
            onDismiss={vi.fn()}
          />
        </TooltipProvider>
      );
      const first = document.createElement("div");
      first.innerHTML = renderToStaticMarkup(row);
      expect(first.querySelector('[role="status"]')?.textContent).toBe("");
      render(row);
      expect(screen.getByRole("status").textContent).toContain("feature/stream-upload-retry");
    });

    it("is shaped like the sidebar card it becomes", () => {
      const { container } = renderRow(
        <WorktreeCardPlaceholder
          pendingCreation={pending()}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
      const row = container.querySelector("[data-pending-creation-path]")!;
      expect(row.classList.contains("sidebar-worktree-card")).toBe(true);
      expect(row.getAttribute("data-variant")).toBe("sidebar");
    });

    it("says it is still working once the wait passes the skeleton hint threshold", () => {
      renderRow(
        <WorktreeCardPlaceholder
          pendingCreation={pending()}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
      const status = screen.getByRole("status");
      const before = status.textContent;
      act(() => {
        vi.advanceTimersByTime(SKELETON_HINT_FIRST_THRESHOLD_MS - 1);
      });
      expect(status.textContent).toBe(before);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(status.textContent).not.toBe(before);
      expect(status.textContent).toMatch(/still/i);
    });

    it("measures the wait from when creation started, not from when the row mounted", () => {
      renderRow(
        <WorktreeCardPlaceholder
          pendingCreation={pending({ startedAt: NOW - SKELETON_HINT_FIRST_THRESHOLD_MS })}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
      expect(screen.getByRole("status").textContent).toMatch(/still/i);
    });
  });

  describe("after a failure", () => {
    const failed = pending({
      status: "error",
      error: "fatal: a branch named 'feature/stream-upload-retry' already exists",
    });

    it("announces the failure and shows git's reason", () => {
      renderRow(
        <WorktreeCardPlaceholder pendingCreation={failed} onRetry={vi.fn()} onDismiss={vi.fn()} />
      );
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("already exists");
    });

    it("wires Retry and Dismiss to their handlers as real buttons", () => {
      const onRetry = vi.fn();
      const onDismiss = vi.fn();
      renderRow(
        <WorktreeCardPlaceholder pendingCreation={failed} onRetry={onRetry} onDismiss={onDismiss} />
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetry).toHaveBeenCalledWith(failed);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(onDismiss).toHaveBeenCalledWith(failed.path);
    });

    it("stays neutral: one red glyph, no tinted block and no red body copy", () => {
      const { container } = renderRow(
        <WorktreeCardPlaceholder pendingCreation={failed} onRetry={vi.fn()} onDismiss={vi.fn()} />
      );
      const alert = screen.getByRole("alert");
      expect(alert.className).not.toMatch(/bg-status-/);
      const red = [...container.querySelectorAll("[class*='status-error']")];
      expect(red.length).toBe(1);
      expect(red[0]!.tagName.toLowerCase()).toBe("svg");
    });
  });
});
