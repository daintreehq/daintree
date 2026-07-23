import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileChangeDetail, GitStatus, WorktreeChanges } from "@shared/types/git";

const { getFreshChangesMock } = vi.hoisted(() => ({
  getFreshChangesMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  worktreeClient: { getFreshChanges: getFreshChangesMock },
}));

import {
  summarizeWorktreeChanges,
  buildWorktreeDeletePreview,
  formatWorktreeDeletePreviewLines,
  formatWorktreeChangeRows,
} from "../worktreeDeletePreview";

function file(path: string, status: GitStatus): FileChangeDetail {
  return { path, status, insertions: null, deletions: null };
}

function changes(files: FileChangeDetail[]): WorktreeChanges {
  return {
    worktreeId: "wt-1",
    rootPath: "/wt",
    changedFileCount: files.length,
    changes: files,
  };
}

describe("summarizeWorktreeChanges", () => {
  it("counts tracked changes excluding untracked and ignored", () => {
    const summary = summarizeWorktreeChanges([
      file("a.ts", "modified"),
      file("b.ts", "deleted"),
      file("new.txt", "untracked"),
      file("node_modules/x", "ignored"),
    ]);
    expect(summary.trackedChangeCount).toBe(2);
    expect(summary.untrackedFileCount).toBe(1);
    expect(summary.hasTrackedChanges).toBe(true);
    expect(summary.hasUntrackedFiles).toBe(true);
  });

  it("treats untracked-only sets as having no tracked changes (no D3 escalation — #4927)", () => {
    const summary = summarizeWorktreeChanges([
      file("a.txt", "untracked"),
      file("b.txt", "untracked"),
    ]);
    expect(summary.trackedChangeCount).toBe(0);
    expect(summary.hasTrackedChanges).toBe(false);
    expect(summary.untrackedFileCount).toBe(2);
  });

  it("handles null/empty input as no changes", () => {
    expect(summarizeWorktreeChanges(null)).toEqual({
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
    });
    expect(summarizeWorktreeChanges([]).hasTrackedChanges).toBe(false);
  });
});

describe("buildWorktreeDeletePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the fresh summary and file list from a forced status fetch", async () => {
    getFreshChangesMock.mockResolvedValue(
      changes([file("a.ts", "modified"), file("n.txt", "untracked")])
    );
    const preview = await buildWorktreeDeletePreview("wt-1");
    expect(getFreshChangesMock).toHaveBeenCalledWith("wt-1");
    expect(preview).not.toBeNull();
    expect(preview?.trackedChangeCount).toBe(1);
    expect(preview?.untrackedFileCount).toBe(1);
    expect(preview?.changes).toHaveLength(2);
  });

  it("returns null when the monitor is gone (getFreshChanges resolves null)", async () => {
    getFreshChangesMock.mockResolvedValue(null);
    await expect(buildWorktreeDeletePreview("wt-1")).resolves.toBeNull();
  });

  it("propagates a fetch error so callers can fail closed", async () => {
    getFreshChangesMock.mockRejectedValue(new Error("timeout"));
    await expect(buildWorktreeDeletePreview("wt-1")).rejects.toThrow("timeout");
  });
});

describe("formatWorktreeDeletePreviewLines", () => {
  it("returns a couldn't-verify note for a null preview (fail-closed display)", () => {
    expect(formatWorktreeDeletePreviewLines(null)).toEqual([
      "⚠ Could not verify current changes — proceed with caution.",
    ]);
  });

  it("returns a clean-tree note when there are no changes", () => {
    const preview = {
      trackedChangeCount: 0,
      untrackedFileCount: 0,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes: [],
    };
    expect(formatWorktreeDeletePreviewLines(preview)).toEqual(["No uncommitted changes."]);
  });

  it("lists the actual files under a counts header", () => {
    const files = [file("src/app.ts", "modified"), file("new.txt", "untracked")];
    const preview = {
      trackedChangeCount: 1,
      untrackedFileCount: 1,
      hasTrackedChanges: true,
      hasUntrackedFiles: true,
      changes: files,
    };
    const lines = formatWorktreeDeletePreviewLines(preview);
    expect(lines[0]).toBe("1 uncommitted tracked file and 1 untracked file:");
    expect(lines).toContain("  M src/app.ts");
    expect(lines).toContain("  ? new.txt");
  });

  it("caps the file list and reports the overflow count", () => {
    const files = Array.from({ length: 15 }, (_, i) => file(`f${i}.ts`, "modified"));
    const preview = {
      trackedChangeCount: 15,
      untrackedFileCount: 0,
      hasTrackedChanges: true,
      hasUntrackedFiles: false,
      changes: files,
    };
    const lines = formatWorktreeDeletePreviewLines(preview);
    // header + 12 files + overflow line
    expect(lines).toHaveLength(14);
    expect(lines[lines.length - 1]).toBe("  …and 3 more");
  });
});

describe("formatWorktreeChangeRows", () => {
  it("prefixes each file with its status glyph", () => {
    const rows = formatWorktreeChangeRows([
      file("a.ts", "modified"),
      file("b.ts", "deleted"),
      file("c.ts", "added"),
      file("n.txt", "untracked"),
    ]);
    expect(rows).toEqual(["  M a.ts", "  D b.ts", "  A c.ts", "  ? n.txt"]);
  });

  it("drops ignored files (not part of what a delete discards)", () => {
    const rows = formatWorktreeChangeRows([
      file("a.ts", "modified"),
      file("node_modules/x", "ignored"),
    ]);
    expect(rows).toEqual(["  M a.ts"]);
  });

  it("caps at the limit and appends an overflow row (ignored excluded from the count)", () => {
    const files = [
      ...Array.from({ length: 14 }, (_, i) => file(`f${i}.ts`, "modified")),
      file("ignore.me", "ignored"),
    ];
    const rows = formatWorktreeChangeRows(files);
    expect(rows).toHaveLength(13); // 12 files + overflow
    expect(rows[rows.length - 1]).toBe("  …and 2 more");
  });
});
