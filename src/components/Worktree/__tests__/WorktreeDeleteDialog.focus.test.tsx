/**
 * @vitest-environment jsdom
 *
 * Initial-focus contract, against the REAL AppDialog.
 *
 * The main suite stubs AppDialog so it can assert copy and consequence logic
 * cheaply, which means it can only check that the dialog *passes* the focus
 * markers — not that the chrome then does the right thing with them. That gap
 * is exactly where the original bug lived: `variant="destructive"` intends to
 * focus Cancel, resolves it via `[data-confirm-role="cancel"]`, and silently
 * falls back to the first tabbable element when the marker is absent. With a
 * hand-written footer that fallback was the force-delete checkbox — the one
 * control that widens the blast radius, which WAI-ARIA APG specifically
 * forbids as an initial focus target.
 *
 * So this file mounts the real chrome and asserts where focus actually lands.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { WorktreeState } from "@/types";
import type { WorktreeChanges, GitStatus } from "@shared/types/git";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const { startDeleteMock, devPreviewGetByWorktreeMock, buildPreviewMock } = vi.hoisted(() => ({
  startDeleteMock: vi.fn(),
  devPreviewGetByWorktreeMock: vi.fn(),
  buildPreviewMock: vi.fn(),
}));

vi.mock("@/components/Worktree/worktreeDeletePreview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktreeDeletePreview")>();
  return { ...actual, buildWorktreeDeletePreview: buildPreviewMock };
});

(window as unknown as Record<string, unknown>).electron = {
  ...((window as unknown as Record<string, unknown>).electron ?? {}),
  devPreview: { getByWorktree: devPreviewGetByWorktreeMock, stopByWorktree: vi.fn() },
};

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ startDelete: startDeleteMock }) }),
}));

vi.mock("@/hooks/useWorktreeTerminals", () => ({
  useWorktreeTerminals: () => ({ counts: { total: 0 }, terminals: [] }),
}));

vi.mock("@/utils/destructiveSessionConfirm", () => ({
  collectRunningAgentTerminals: () => [],
}));

import { WorktreeDeleteDialog } from "../WorktreeDeleteDialog";

function makeChanges(files: Array<{ path: string; status: GitStatus }>): WorktreeChanges {
  return {
    worktreeId: "wt-1",
    rootPath: "/test/worktree",
    changedFileCount: files.length,
    changes: files.map((f) => ({
      path: f.path,
      status: f.status,
      insertions: null,
      deletions: null,
    })),
  };
}

function makeWorktree(worktreeChanges: WorktreeChanges | null = null): WorktreeState {
  return {
    id: "wt-1",
    path: "/test/worktree",
    name: "feature/test",
    branch: "feature/test",
    isCurrent: false,
    isMainWorktree: false,
    gitDir: "/test/.git/worktrees/wt-1",
    worktreeChanges,
    agentStates: {},
    prNumber: null,
    prState: null,
    prUrl: null,
    issueNumber: null,
    mood: "stable",
    moodLabel: null,
  } as unknown as WorktreeState;
}

describe("WorktreeDeleteDialog — real-chrome focus contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    buildPreviewMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("puts initial focus on Cancel, never on a control that widens the blast radius", async () => {
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={makeWorktree()} />);

    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active).not.toBeNull();
      // The rule: focus is on the safest control. Asserted by role+name rather
      // than by identity so it keeps holding if the footer is restructured.
      expect(active?.tagName.toLowerCase()).toBe("button");
      expect(active?.textContent?.trim()).toBe("Cancel");
    });

    // And explicitly NOT the force checkbox — the original defect.
    expect((document.activeElement as HTMLElement).getAttribute("type")).not.toBe("checkbox");
  });

  it("renders role=dialog, not alertdialog, once the body carries form controls", async () => {
    render(
      <WorktreeDeleteDialog
        isOpen={true}
        onClose={vi.fn()}
        worktree={makeWorktree(makeChanges([{ path: "/test/worktree/a.ts", status: "modified" }]))}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeDefined();
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("wires aria-describedby to an element that actually exists", async () => {
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={makeWorktree()} />);

    const dialog = await screen.findByRole("dialog");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy as string);
    expect(description).not.toBeNull();
    expect(description?.textContent?.trim().length).toBeGreaterThan(0);
  });
});
