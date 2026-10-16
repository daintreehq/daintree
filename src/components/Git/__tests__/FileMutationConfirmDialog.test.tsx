// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { FileMutationConfirmDialog } from "../FileMutationConfirmDialog";
import {
  useFileMutationConfirmStore,
  type FileMutationConfirmRequest,
} from "@/store/fileMutationConfirmStore";

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

async function request(req: FileMutationConfirmRequest): Promise<{ decision: () => unknown }> {
  let decision: boolean | undefined;
  await act(async () => {
    void useFileMutationConfirmStore
      .getState()
      .requestConfirmation(req)
      .then((ok) => {
        decision = ok;
      });
  });
  return { decision: () => decision };
}

describe("FileMutationConfirmDialog", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    if (useFileMutationConfirmStore.getState().pendingConfirm) {
      useFileMutationConfirmStore.getState().resolveConfirmation(false);
    }
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing until something asks", () => {
    render(<FileMutationConfirmDialog />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("names the file and resolves true on Discard changes", async () => {
    render(<FileMutationConfirmDialog />);
    const pending = await request({ kind: "discard", relativePath: "src/deep/index.ts" });

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Discard changes to 'index.ts'?");
    // The full path, so two files called index.ts can be told apart.
    expect(dialog.textContent).toContain("src/deep/index.ts");
    expect(dialog.textContent).toContain("staged and unstaged");

    await act(async () => {
      screen.getByRole("button", { name: "Discard changes" }).click();
    });
    expect(pending.decision()).toBe(true);
    expect(useFileMutationConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("says a deleted file goes to the Trash and resolves false on Cancel", async () => {
    render(<FileMutationConfirmDialog />);
    const pending = await request({ kind: "trash", relativePath: "notes/todo.md" });

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete 'todo.md'?");
    expect(dialog.textContent).toContain("moves to the Trash");
    expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();

    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });
    expect(pending.decision()).toBe(false);
  });

  it("cancels an earlier request when a second one arrives", async () => {
    render(<FileMutationConfirmDialog />);
    const first = await request({ kind: "trash", relativePath: "a.txt" });
    const second = await request({ kind: "discard", relativePath: "b.txt" });

    expect(first.decision()).toBe(false);
    expect(screen.getByRole("alertdialog").textContent).toContain("'b.txt'");

    await act(async () => {
      screen.getByRole("button", { name: "Discard changes" }).click();
    });
    expect(second.decision()).toBe(true);
  });

  it("resolves false when the host unmounts mid-request", async () => {
    const { unmount } = render(<FileMutationConfirmDialog />);
    const pending = await request({ kind: "discard", relativePath: "a.txt" });

    unmount();
    await act(async () => {});

    expect(pending.decision()).toBe(false);
  });
});
