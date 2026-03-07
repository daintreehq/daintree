/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { StagingStatus } from "@shared/types";
import type { WorktreeState } from "@shared/types";

const { getStagingStatusMock, onUpdateMock, debounceCancelSpy } = vi.hoisted(() => ({
  getStagingStatusMock: vi.fn(),
  onUpdateMock: vi.fn(),
  debounceCancelSpy: vi.fn(),
}));

vi.mock("@/utils/debounce", () => ({
  debounce: (fn: (...args: unknown[]) => void) => {
    const immediate = (...args: unknown[]) => fn(...args);
    immediate.cancel = debounceCancelSpy;
    immediate.flush = vi.fn();
    return immediate;
  },
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/hooks", () => ({ useOverlayState: vi.fn() }));

vi.mock("../../FileDiffModal", () => ({ FileDiffModal: () => null }));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ReviewHub } from "../ReviewHub";

const WORKTREE_PATH = "/home/user/project";

const makeStatus = (overrides?: Partial<StagingStatus>): StagingStatus => ({
  staged: [{ path: "src/index.ts", status: "modified", insertions: 5, deletions: 2 }],
  unstaged: [{ path: "src/app.ts", status: "modified", insertions: 3, deletions: 1 }],
  conflicted: [],
  isDetachedHead: false,
  currentBranch: "feature/test",
  hasRemote: false,
  ...overrides,
});

const makeWorktreeState = (path = WORKTREE_PATH): WorktreeState =>
  ({
    id: path,
    path,
    worktreeId: path,
    name: "test",
    isCurrent: true,
    worktreeChanges: null,
    lastActivityTimestamp: null,
  }) as unknown as WorktreeState;

describe("ReviewHub", () => {
  let capturedUpdateCallback: ((state: WorktreeState) => void) | null = null;
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    capturedUpdateCallback = null;
    debounceCancelSpy.mockReset();

    getStagingStatusMock.mockResolvedValue(makeStatus());
    onUpdateMock.mockImplementation((callback: (state: WorktreeState) => void) => {
      capturedUpdateCallback = callback;
      return mockUnsubscribe;
    });

    Object.defineProperty(window, "electron", {
      value: {
        git: {
          getStagingStatus: getStagingStatusMock,
          stageFile: vi.fn().mockResolvedValue(undefined),
          unstageFile: vi.fn().mockResolvedValue(undefined),
          stageAll: vi.fn().mockResolvedValue(undefined),
          unstageAll: vi.fn().mockResolvedValue(undefined),
          commit: vi.fn().mockResolvedValue(undefined),
          push: vi.fn().mockResolvedValue({ success: true }),
        },
        worktree: { onUpdate: onUpdateMock },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches status once on open", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(getStagingStatusMock).toHaveBeenCalledTimes(1);
      expect(getStagingStatusMock).toHaveBeenCalledWith(WORKTREE_PATH);
    });
  });

  it("renders staged and unstaged files after initial load", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      screen.getByText("index.ts");
      screen.getByText("app.ts");
    });
  });

  it("subscribes to worktree updates on open", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => expect(onUpdateMock).toHaveBeenCalledTimes(1));
    expect(capturedUpdateCallback).not.toBeNull();
  });

  it("triggers background refresh when matching worktree emits update", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));

    const updatedStatus = makeStatus({
      staged: [{ path: "new.ts", status: "added", insertions: 10, deletions: 0 }],
      unstaged: [],
    });
    getStagingStatusMock.mockResolvedValue(updatedStatus);

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getStagingStatusMock).toHaveBeenCalledTimes(2);
      screen.getByText("new.ts");
    });
  });

  it("ignores worktree update events for a different path", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState("/home/user/other-project"));
      await Promise.resolve();
    });

    expect(getStagingStatusMock).toHaveBeenCalledTimes(1);
  });

  it("preserves commit message during a background resync", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByPlaceholderText("Commit message…"));

    const textarea = screen.getByPlaceholderText("Commit message…");
    fireEvent.change(textarea, { target: { value: "My commit message" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("My commit message");

    getStagingStatusMock.mockResolvedValue(makeStatus());
    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(2));

    expect((textarea as HTMLTextAreaElement).value).toBe("My commit message");
  });

  it("keeps existing file rows visible during background refresh (no blank flash)", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    let resolveRefresh!: (value: StagingStatus) => void;
    getStagingStatusMock.mockReturnValue(
      new Promise<StagingStatus>((resolve) => {
        resolveRefresh = resolve;
      })
    );

    act(() => {
      capturedUpdateCallback!(makeWorktreeState());
    });

    screen.getByText("index.ts");

    await act(async () => {
      resolveRefresh(makeStatus());
      await Promise.resolve();
    });
  });

  it("unsubscribes when closed", async () => {
    const { rerender } = render(
      <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
    );
    await waitFor(() => expect(onUpdateMock).toHaveBeenCalled());

    rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it("cancels debounce before explicit stage actions", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("app.ts"));

    // Click the "Stage src/app.ts" button (unstaged file) — aria-label starts with "Stage"
    const stageBtn = screen.getByRole("button", { name: /^Stage src\/app\.ts/i });
    fireEvent.click(stageBtn);

    await waitFor(() => expect(debounceCancelSpy).toHaveBeenCalled());
  });

  it("manual refresh button still works independently", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(1));

    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    act(() => fireEvent.click(refreshButton));

    await waitFor(() => expect(getStagingStatusMock).toHaveBeenCalledTimes(2));
  });

  it("resets commit message on close then reopen", async () => {
    const { rerender } = render(
      <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
    );
    await waitFor(() => screen.getByPlaceholderText("Commit message…"));

    const textarea = screen.getByPlaceholderText("Commit message…");
    fireEvent.change(textarea, { target: { value: "draft message" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("draft message");

    rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    rerender(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

    await waitFor(() => {
      const ta = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;
      expect(ta.value).toBe("");
    });
  });

  it("background refresh error keeps existing file list visible", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    getStagingStatusMock.mockRejectedValue(new Error("network error"));

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    screen.getByText("index.ts");
  });

  it("removes old rows after background refresh replaces status", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    const statusWithNewFiles = makeStatus({
      staged: [{ path: "new-feature.ts", status: "added", insertions: 10, deletions: 0 }],
      unstaged: [],
    });
    getStagingStatusMock.mockResolvedValue(statusWithNewFiles);

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    await waitFor(() => screen.getByText("new-feature.ts"));
    expect(screen.queryByText("index.ts")).toBeNull();
    expect(screen.queryByText("app.ts")).toBeNull();
  });

  it("background refresh clears a prior loadError on success", async () => {
    getStagingStatusMock.mockRejectedValue(new Error("git error"));
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("git error"));

    getStagingStatusMock.mockResolvedValue(makeStatus());

    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText("git error")).toBeNull();
      screen.getByText("index.ts");
    });
  });

  it("foreground and background requests use independent IDs, neither suppresses the other", async () => {
    render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("index.ts"));

    // Trigger a background refresh (fires immediately due to mocked debounce)
    await act(async () => {
      capturedUpdateCallback!(makeWorktreeState());
      await Promise.resolve();
    });

    // Then trigger an explicit manual refresh
    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    act(() => fireEvent.click(refreshButton));

    await waitFor(() => {
      // Both should have fired — total calls: 1 initial + 1 bg + 1 manual = 3
      expect(getStagingStatusMock).toHaveBeenCalledTimes(3);
      screen.getByText("index.ts");
    });
  });
});
