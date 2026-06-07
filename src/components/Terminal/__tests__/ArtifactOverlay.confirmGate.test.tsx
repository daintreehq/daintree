// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { Artifact } from "@shared/types";
import { ArtifactOverlay } from "../ArtifactOverlay";

const applyPatch = vi.fn();
const applyAllPatches = vi.fn();
let mockArtifacts: Artifact[] = [];

vi.mock("@/hooks/useArtifacts", () => ({
  useArtifacts: () => ({
    artifacts: mockArtifacts,
    actionInProgress: null,
    bulkProgress: null,
    hasArtifacts: mockArtifacts.length > 0,
    copyToClipboard: vi.fn(),
    saveToFile: vi.fn(),
    applyPatch,
    clearArtifacts: vi.fn(),
    canApplyPatch: () => true,
    copyAll: vi.fn(),
    saveAll: vi.fn(),
    applyAllPatches,
  }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// The gate logic under test lives in ArtifactOverlay; the dialog chrome
// (AppDialog portal/focus-trap) is out of scope, so stub it to its contract.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    onClose,
    onConfirm,
    confirmLabel,
    children,
  }: {
    isOpen: boolean;
    onClose?: () => void;
    onConfirm: () => void | Promise<void>;
    confirmLabel: string;
    children?: ReactNode;
  }) =>
    isOpen ? (
      <div role="dialog">
        {children}
        <button onClick={() => void onConfirm()}>{confirmLabel}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    ) : null,
}));

function makePatch(id: string, content: string): Artifact {
  return { id, type: "patch", filename: `${id}.diff`, content, extractedAt: 1 };
}

const PATCH_A = makePatch("patch-a", "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old a\n+new a");
const PATCH_B = makePatch("patch-b", "--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old b\n+new b");
const PATCH_C = makePatch("patch-c", "--- a/c.ts\n+++ b/c.ts\n@@ -1 +1 @@\n-old c\n+new c");

function renderOverlay() {
  const utils = render(<ArtifactOverlay terminalId="t1" worktreeId="wt1" cwd="/repo" />);
  // Expand the collapsed pill so the artifact list and bulk bar render.
  fireEvent.click(screen.getByText(/artifacts?$/i));
  return utils;
}

function openSingleApplyDialog(filename: string) {
  fireEvent.click(screen.getByText(filename));
  fireEvent.click(screen.getByText("Apply Patch"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockArtifacts = [PATCH_A, PATCH_B];
  applyPatch.mockResolvedValue({ success: true, modifiedFiles: ["a.ts"] });
  applyAllPatches.mockResolvedValue({
    succeeded: 2,
    failed: 0,
    failures: [],
    modifiedFiles: ["a.ts", "b.ts"],
  });
});

describe("ArtifactOverlay confirm gate (issue #10020)", () => {
  it("does not apply a patch until the confirm dialog is confirmed, and shows the diff", () => {
    renderOverlay();
    openSingleApplyDialog("patch-a.diff");

    expect(applyPatch).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("+new a");
    expect(dialog.textContent).toContain("-old a");
  });

  it("cancelling the single-patch dialog never applies", () => {
    renderOverlay();
    openSingleApplyDialog("patch-a.diff");

    fireEvent.click(screen.getByText("Cancel"));

    expect(applyPatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirming the single-patch dialog applies exactly the pending patch", async () => {
    renderOverlay();
    openSingleApplyDialog("patch-a.diff");

    await act(async () => {
      fireEvent.click(screen.getByText("Apply patch"));
    });

    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch).toHaveBeenCalledWith(PATCH_A);
  });

  it("re-requesting apply for another patch supersedes the first pending confirm", async () => {
    renderOverlay();
    openSingleApplyDialog("patch-a.diff");
    fireEvent.click(screen.getByText("patch-b.diff"));
    fireEvent.click(screen.getAllByText("Apply Patch")[1]!);

    await act(async () => {
      fireEvent.click(screen.getByText("Apply patch"));
    });

    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch).toHaveBeenCalledWith(PATCH_B);
  });

  it("bulk dialog shows actual diff content for every patch, not just counts", () => {
    renderOverlay();
    fireEvent.click(screen.getByText("Apply All Patches"));

    expect(applyAllPatches).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("+new a");
    expect(dialog.textContent).toContain("+new b");
    expect(dialog.textContent).toContain("-old a");
    expect(dialog.textContent).toContain("-old b");
  });

  it("bulk confirm applies the snapshot taken at request time, not later arrivals", async () => {
    const { rerender } = renderOverlay();
    fireEvent.click(screen.getByText("Apply All Patches"));

    // A third patch arrives while the dialog is open.
    mockArtifacts = [PATCH_A, PATCH_B, PATCH_C];
    rerender(<ArtifactOverlay terminalId="t1" worktreeId="wt1" cwd="/repo" />);

    await act(async () => {
      fireEvent.click(screen.getByText("Apply 2 patches"));
    });

    expect(applyAllPatches).toHaveBeenCalledTimes(1);
    expect(applyAllPatches).toHaveBeenCalledWith([PATCH_A, PATCH_B]);
  });

  it("cancelling the bulk dialog never applies", () => {
    renderOverlay();
    fireEvent.click(screen.getByText("Apply All Patches"));

    fireEvent.click(screen.getByText("Cancel"));

    expect(applyAllPatches).not.toHaveBeenCalled();
  });

  it("losing all artifacts while a confirm is pending cancels it without applying", () => {
    const { rerender } = renderOverlay();
    openSingleApplyDialog("patch-a.diff");

    mockArtifacts = [];
    rerender(<ArtifactOverlay terminalId="t1" worktreeId="wt1" cwd="/repo" />);

    expect(applyPatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
