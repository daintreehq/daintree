// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PendingCreation } from "@/store/worktreeStore";
import { SKELETON_HINT_FIRST_THRESHOLD_MS } from "@/components/ui/Skeleton";
import { WorktreeCardPlaceholder } from "../WorktreeCardPlaceholder";

// The row maps its error with the real `mapCreationError`; only the stores its
// "Open worktree" recovery reads are stood in for.
const { viewWorktrees, mockSelectWorktree } = vi.hoisted(() => ({
  viewWorktrees: { current: new Map<string, { id: string; path: string }>() },
  mockSelectWorktree: vi.fn(),
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: viewWorktrees.current }) }),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({ selectWorktree: mockSelectWorktree }) },
}));
vi.mock("@/hooks/useHostPlatform", () => ({ isHostWindows: () => false }));

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

    describe("when the branch is already open in another worktree", () => {
      const HOLDER = "/repo-worktrees/stream-upload-retry-elsewhere";
      beforeEach(() => {
        viewWorktrees.current = new Map([
          ["wt-other", { id: "wt-other", path: "/repo-worktrees/unrelated" }],
          ["wt-holder", { id: "wt-holder", path: HOLDER }],
        ]);
        mockSelectWorktree.mockClear();
      });

      // Git 2.42 reworded the first into the second; both reach users.
      it.each([
        `fatal: 'feature/stream-upload-retry' is already checked out at '${HOLDER}'`,
        `fatal: 'feature/stream-upload-retry' is already used by worktree at '${HOLDER}'`,
      ])("says so and opens that worktree, taking the row with it: %s", (raw) => {
        const onDismiss = vi.fn();
        const row = pending({ status: "error", error: raw });
        renderRow(
          <WorktreeCardPlaceholder pendingCreation={row} onRetry={vi.fn()} onDismiss={onDismiss} />
        );
        const alert = screen.getByRole("alert");
        expect(alert.textContent).toContain("This branch is already open in another worktree.");
        expect(alert.textContent).not.toContain(HOLDER);

        fireEvent.click(screen.getByRole("button", { name: "Open worktree" }));

        expect(mockSelectWorktree).toHaveBeenCalledWith("wt-holder");
        expect(onDismiss).toHaveBeenCalledWith(row.path);
      });

      it("keeps the row when the worktree holding the branch isn't in the list", () => {
        viewWorktrees.current = new Map();
        const onDismiss = vi.fn();
        renderRow(
          <WorktreeCardPlaceholder
            pendingCreation={pending({
              status: "error",
              error: `fatal: 'feature/stream-upload-retry' is already checked out at '${HOLDER}'`,
            })}
            onRetry={vi.fn()}
            onDismiss={onDismiss}
          />
        );

        fireEvent.click(screen.getByRole("button", { name: "Open worktree" }));

        expect(mockSelectWorktree).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
      });
    });

    it("shows a classified failure's recovery hint, with git's own text a click away", () => {
      const raw = "fatal: Authentication failed for 'https://github.com/acme/app.git/'";
      renderRow(
        <WorktreeCardPlaceholder
          pendingCreation={pending({ status: "error", error: raw })}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Check your Git credentials");
      expect(alert.textContent).not.toContain("Authentication failed");
      expect(screen.queryByRole("button", { name: "Open worktree" })).toBeNull();

      const toggle = screen.getByRole("button", { name: "Git output" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);

      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const outputId = toggle.getAttribute("aria-controls")!;
      expect(document.getElementById(outputId)?.textContent).toBe(raw);

      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(document.getElementById(outputId)).toBeNull();
    });

    it("shows an unrecognised failure as git wrote it, with nothing to expand", () => {
      const raw = "fatal: something nobody has seen before";
      renderRow(
        <WorktreeCardPlaceholder
          pendingCreation={pending({ status: "error", error: raw })}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
      expect(screen.getByRole("alert").textContent).toContain(raw);
      expect(screen.queryByRole("button", { name: "Git output" })).toBeNull();
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
