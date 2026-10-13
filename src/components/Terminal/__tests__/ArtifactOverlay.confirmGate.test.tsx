// @vitest-environment jsdom
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { Artifact } from "@shared/types";
import { readFile } from "fs/promises";
import { resolve as resolvePath } from "path";
import {
  ArtifactOverlay,
  describeApplyFailure,
  getPatchFiles,
  getPatchStats,
  parsePatchLines,
  PATCH_ROW_CLASS,
} from "../ArtifactOverlay";

const applyPatch = vi.fn();
const copyToClipboard = vi.fn();
const applyAllPatches = vi.fn();
let mockArtifacts: Artifact[] = [];

vi.mock("@/hooks/useArtifacts", async (importOriginal) => ({
  // The real apply ordering, so the gate is tested against the order the hook runs in.
  orderPatchesForApply: (await importOriginal<typeof import("@/hooks/useArtifacts")>())
    .orderPatchesForApply,
  useArtifacts: () => ({
    artifacts: mockArtifacts,
    actionInProgress: null,
    bulkProgress: null,
    hasArtifacts: mockArtifacts.length > 0,
    copyToClipboard,
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

function makePatch(id: string, content: string, extractedAt = 1): Artifact {
  return { id, type: "patch", filename: `${id}.diff`, content, extractedAt };
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

function rowFor(filename: string): HTMLElement {
  const row = screen.getByText(filename).closest<HTMLElement>("[data-artifact-item]");
  if (!row) throw new Error(`no artifact row holds ${filename}`);
  return row;
}

function openSingleApplyDialog(filename: string) {
  fireEvent.click(screen.getByText(filename));
  fireEvent.click(within(rowFor(filename)).getByRole("button", { name: "Apply patch" }));
}

function confirmDialog(label: string) {
  fireEvent.click(within(screen.getByRole("dialog")).getByText(label));
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

    fireEvent.click(within(screen.getByRole("dialog")).getByText("Cancel"));

    expect(applyPatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirming the single-patch dialog applies exactly the pending patch", async () => {
    renderOverlay();
    openSingleApplyDialog("patch-a.diff");

    await act(async () => {
      confirmDialog("Apply patch");
    });

    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch).toHaveBeenCalledWith(PATCH_A);
  });

  it("re-requesting apply for another patch supersedes the first pending confirm", async () => {
    renderOverlay();
    openSingleApplyDialog("patch-a.diff");
    openSingleApplyDialog("patch-b.diff");

    await act(async () => {
      confirmDialog("Apply patch");
    });

    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(applyPatch).toHaveBeenCalledWith(PATCH_B);
  });

  it("bulk dialog shows actual diff content for every patch, not just counts", () => {
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: /^Apply 2 patches$/ }));

    expect(applyAllPatches).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("+new a");
    expect(dialog.textContent).toContain("+new b");
    expect(dialog.textContent).toContain("-old a");
    expect(dialog.textContent).toContain("-old b");
  });

  it("bulk confirm applies the snapshot taken at request time, not later arrivals", async () => {
    const { rerender } = renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: /^Apply 2 patches$/ }));

    // A third patch arrives while the dialog is open.
    mockArtifacts = [PATCH_A, PATCH_B, PATCH_C];
    rerender(<ArtifactOverlay terminalId="t1" worktreeId="wt1" cwd="/repo" />);

    await act(async () => {
      confirmDialog("Apply 2 patches");
    });

    expect(applyAllPatches).toHaveBeenCalledTimes(1);
    expect(applyAllPatches).toHaveBeenCalledWith([PATCH_A, PATCH_B]);
  });

  it("bulk confirm previews and applies the patches in the same order", async () => {
    // Listed newest first, but written by the agent A-then-B: both the preview
    // and the run must follow the order they will actually be applied in.
    const first = makePatch("patch-a", PATCH_A.content, 1);
    const second = makePatch("patch-b", PATCH_B.content, 2);
    mockArtifacts = [second, first];
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: /^Apply 2 patches$/ }));

    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text.indexOf("+new a")).toBeLessThan(text.indexOf("+new b"));

    await act(async () => {
      confirmDialog("Apply 2 patches");
    });
    expect(applyAllPatches).toHaveBeenCalledWith([first, second]);
  });

  it("bulk apply leaves out a patch already applied from its own row", async () => {
    mockArtifacts = [PATCH_A, PATCH_B, PATCH_C];
    renderOverlay();
    openSingleApplyDialog("patch-a.diff");
    await act(async () => {
      confirmDialog("Apply patch");
    });

    fireEvent.click(screen.getByRole("button", { name: /^Apply 2 patches$/ }));
    await act(async () => {
      confirmDialog("Apply 2 patches");
    });

    expect(applyAllPatches).toHaveBeenCalledWith([PATCH_B, PATCH_C]);
  });

  it("cancelling the bulk dialog never applies", () => {
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: /^Apply 2 patches$/ }));

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

describe("ArtifactOverlay keeps keyboard focus through its own actions", () => {
  it("leaves focus on Copy while the copy is in flight, rather than disabling it", async () => {
    let finish: (ok: boolean) => void = () => undefined;
    copyToClipboard.mockReturnValue(new Promise<boolean>((resolve) => (finish = resolve)));
    renderOverlay();
    fireEvent.click(screen.getByText("patch-a.diff"));
    const copy = within(rowFor("patch-a.diff")).getByRole("button", { name: "Copy" });
    copy.focus();

    await act(async () => {
      fireEvent.click(copy);
    });
    expect(copy.hasAttribute("disabled")).toBe(false);
    expect(copy.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(copy);

    await act(async () => {
      finish(true);
    });
  });
});

const PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
].join("\n");

function kinds(content: string) {
  return parsePatchLines(content).map((line) => line.kind);
}

describe("ArtifactOverlay patch preview helpers (issue #10020)", () => {
  describe("getPatchStats", () => {
    it("counts added and removed lines, excluding +++/--- file headers", () => {
      expect(getPatchStats(PATCH)).toEqual({ additions: 2, deletions: 1 });
    });

    it("returns zeros for content with no change lines", () => {
      expect(getPatchStats("just some text\nwith no markers")).toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("counts hunk lines whose text begins with ++ or -- as changes, not headers", () => {
      const patch = [PATCH, "@@ -9,2 +10,2 @@", "--- old separator", "+++ new separator"].join(
        "\n"
      );
      expect(getPatchStats(patch)).toEqual({ additions: 3, deletions: 2 });
    });
  });

  describe("parsePatchLines", () => {
    it("reads headers, hunks, changes and context in order", () => {
      expect(kinds(PATCH)).toEqual([
        "file",
        "file",
        "file",
        "hunk",
        "context",
        "del",
        "add",
        "add",
      ]);
    });

    it("keeps the no-newline marker as a verbatim note inside a hunk", () => {
      const lines = parsePatchLines([PATCH, "\\ No newline at end of file"].join("\n"));
      expect(lines.at(-1)).toEqual({ kind: "meta", text: "\\ No newline at end of file" });
    });

    it("treats a new diff header as leaving the hunk, so the next --- is a header again", () => {
      const second = ["diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts"].join("\n");
      expect(kinds([PATCH, second].join("\n")).slice(-3)).toEqual(["file", "file", "file"]);
    });

    it("gives every line kind its own treatment", () => {
      const classes = Object.values(PATCH_ROW_CLASS);
      expect(new Set(classes).size).toBe(classes.length);
    });
  });

  describe("getPatchFiles", () => {
    it("lists every file a multi-file patch touches, once each, in order", () => {
      const multi = [
        PATCH,
        "diff --git a/src/bar.ts b/src/bar.ts",
        "--- a/src/bar.ts",
        "+++ b/src/bar.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -9 +9 @@",
        "-p",
        "+q",
      ].join("\n");
      expect(getPatchFiles(multi)).toEqual(["src/foo.ts", "src/bar.ts"]);
    });

    it("names a deleted file by its old path rather than /dev/null", () => {
      const deletion = ["--- a/src/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"].join("\n");
      expect(getPatchFiles(deletion)).toEqual(["src/gone.ts"]);
    });

    it("ignores ++-prefixed content lines inside a hunk", () => {
      const patch = [PATCH, "+++ b/not-a-file.ts"].join("\n");
      expect(getPatchFiles(patch)).toEqual(["src/foo.ts"]);
    });
  });

  describe("describeApplyFailure", () => {
    it("tells a stale patch, a missing file and an unreadable patch apart", () => {
      const advice = [
        describeApplyFailure(
          "error: patch failed: src/a.ts:24\nerror: src/a.ts: patch does not apply"
        ),
        describeApplyFailure("error: src/a.ts: No such file or directory"),
        describeApplyFailure("error: corrupt patch at line 12"),
        describeApplyFailure("something git has never said"),
      ];
      expect(new Set(advice).size).toBe(advice.length);
    });
  });
});

describe("ArtifactOverlay — contrast on neutral surfaces (issue #4611)", () => {
  it("buttons on bg-border-default use text-text-primary, not text-text-inverse", async () => {
    const content = await readFile(resolvePath(__dirname, "../ArtifactOverlay.tsx"), "utf-8");
    expect(content).not.toMatch(/bg-border-default[^"]*text-text-inverse/);
  });
});
