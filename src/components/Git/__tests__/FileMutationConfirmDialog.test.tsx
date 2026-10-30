// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { FileMutationConfirmDialog } from "../FileMutationConfirmDialog";
import {
  useFileMutationConfirmStore,
  type FileMutationApproval,
  type FileMutationConfirmRequest,
} from "@/store/fileMutationConfirmStore";
import type {
  FileDiscardPreview,
  FileMutationPreview,
  FileTrashPreview,
} from "@shared/types/fileMutation";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const previewMock = vi.fn<(payload: unknown) => Promise<FileMutationPreview>>();

const PATCH = "@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n";

function discardPreview(overrides: Partial<FileDiscardPreview> = {}): FileDiscardPreview {
  return {
    kind: "discard",
    path: "src/deep/index.ts",
    renamedFrom: null,
    copiedFrom: null,
    inLastCommit: true,
    outcome: "lose",
    staged: { churn: { insertions: 1, deletions: 1 }, patch: PATCH, truncated: false },
    unstaged: { churn: { insertions: 2, deletions: 0 }, patch: PATCH, truncated: false },
    overwrites: null,
    token: "token-1",
    ...overrides,
  };
}

function trashPreview(overrides: Partial<FileTrashPreview> = {}): FileTrashPreview {
  return {
    kind: "trash",
    path: "notes/todo.md",
    inLastCommit: false,
    inIndex: false,
    ignored: false,
    staged: null,
    unstaged: null,
    bytes: 24,
    binary: false,
    lines: 2,
    excerpt: "# Todo\n- ship it\n",
    excerptTruncated: false,
    ...overrides,
  };
}

const WORKTREE = "/repo/one";

async function request(
  req: Omit<FileMutationConfirmRequest, "worktreePath">
): Promise<{ decision: () => FileMutationApproval | null | undefined }> {
  let decision: FileMutationApproval | null | undefined;
  await act(async () => {
    void useFileMutationConfirmStore
      .getState()
      .requestConfirmation({ ...req, worktreePath: WORKTREE })
      .then((approval) => {
        decision = approval;
      });
  });
  // The preview resolves, then the dialog mounts with it.
  await act(async () => {});
  return { decision: () => decision };
}

function dialogText(): string {
  return screen.getByRole("dialog").textContent ?? "";
}

describe("FileMutationConfirmDialog", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    previewMock.mockReset();
    (window as unknown as { electron: unknown }).electron = {
      git: { previewFileMutation: previewMock },
    };
  });

  afterEach(() => {
    if (useFileMutationConfirmStore.getState().pendingConfirm) {
      useFileMutationConfirmStore.getState().resolveConfirmation(null);
    }
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing until something asks", () => {
    render(<FileMutationConfirmDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("reads the preview for the file it names, from the request's worktree", async () => {
    previewMock.mockResolvedValue(discardPreview());
    render(<FileMutationConfirmDialog />);
    await request({ kind: "discard", relativePath: "src/deep/index.ts" });

    expect(previewMock).toHaveBeenCalledWith({
      worktreePath: WORKTREE,
      relativePath: "src/deep/index.ts",
      kind: "discard",
    });
  });

  it("states a modification's loss with both sides' counts and approves with the preview's token", async () => {
    previewMock.mockResolvedValue(discardPreview());
    render(<FileMutationConfirmDialog />);
    const pending = await request({ kind: "discard", relativePath: "src/deep/index.ts" });

    expect(dialogText()).toContain("Discard changes to 'index.ts'?");
    // The full path, so two files called index.ts can be told apart.
    expect(dialogText()).toContain("src/deep/index.ts");
    expect(dialogText()).toContain("staged and unstaged changes are both lost");
    expect(screen.getByRole("region", { name: "Changes to discard" })).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Discard changes" }).click();
    });
    expect(pending.decision()).toEqual({ token: "token-1" });
    expect(useFileMutationConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("names only the side that is lost", async () => {
    previewMock.mockResolvedValue(discardPreview({ staged: null }));
    render(<FileMutationConfirmDialog />);
    await request({ kind: "discard", relativePath: "src/deep/index.ts" });

    expect(dialogText()).toContain("Its unstaged changes are lost");
    expect(dialogText()).not.toContain("staged and unstaged");
  });

  it("offers a deleted file back as a restore, not a loss", async () => {
    previewMock.mockResolvedValue(
      discardPreview({
        outcome: "restore",
        staged: null,
        unstaged: { churn: { insertions: 0, deletions: 34 }, patch: "", truncated: false },
      })
    );
    render(<FileMutationConfirmDialog />);
    const pending = await request({ kind: "discard", relativePath: "docs/old.md" });

    expect(dialogText()).toContain("Restore 'old.md'?");
    expect(dialogText()).toContain("Nothing is lost");
    expect(dialogText()).toContain("34 lines");
    expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();

    await act(async () => {
      screen.getByRole("button", { name: "Restore file" }).click();
    });
    expect(pending.decision()).toEqual({ token: "token-1" });
  });

  it("says a file git has no copy of will exist only in the Trash, and resolves null on Cancel", async () => {
    previewMock.mockResolvedValue(trashPreview());
    render(<FileMutationConfirmDialog />);
    const pending = await request({ kind: "trash", relativePath: "notes/todo.md" });

    expect(dialogText()).toContain("Trash 'todo.md'?");
    expect(dialogText()).toContain("the Trash will hold the only one");
    expect(dialogText()).toContain("ship it");

    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });
    expect(pending.decision()).toBeNull();
  });

  it("approves a trash without a token", async () => {
    previewMock.mockResolvedValue(trashPreview({ inLastCommit: true, inIndex: true }));
    render(<FileMutationConfirmDialog />);
    const pending = await request({ kind: "trash", relativePath: "notes/todo.md" });

    expect(dialogText()).toContain("git lists it as deleted");
    await act(async () => {
      screen.getByRole("button", { name: "Trash file" }).click();
    });
    expect(pending.decision()).toEqual({ token: null });
  });

  it("stands the primary down when there is nothing left to discard", async () => {
    previewMock.mockRejectedValue(
      new Error("[AppError|NOT_FOUND] 'src/a.ts' has no changes to discard.")
    );
    render(<FileMutationConfirmDialog />);
    await request({ kind: "discard", relativePath: "src/a.ts" });

    expect(dialogText()).toContain("nothing to discard");
    const confirm = screen.getByRole("button", { name: "Discard changes" });
    expect(
      confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true"
    ).toBe(true);
  });

  it("cancels an earlier request when a second one arrives", async () => {
    previewMock.mockResolvedValueOnce(trashPreview()).mockResolvedValueOnce(discardPreview());
    render(<FileMutationConfirmDialog />);
    const first = await request({ kind: "trash", relativePath: "a.txt" });
    const second = await request({ kind: "discard", relativePath: "b.txt" });

    expect(first.decision()).toBeNull();
    expect(dialogText()).toContain("'b.txt'");

    await act(async () => {
      screen.getByRole("button", { name: "Discard changes" }).click();
    });
    expect(second.decision()).toEqual({ token: "token-1" });
  });

  it("resolves null when the host unmounts mid-request", async () => {
    previewMock.mockResolvedValue(discardPreview());
    const { unmount } = render(<FileMutationConfirmDialog />);
    const pending = await request({ kind: "discard", relativePath: "a.txt" });

    unmount();
    await act(async () => {});

    expect(pending.decision()).toBeNull();
  });
});
