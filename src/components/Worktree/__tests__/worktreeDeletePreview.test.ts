import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileChangeDetail, GitStatus, WorktreeChanges } from "@shared/types/git";
import type { SubmoduleDeleteRisk } from "@shared/types/submodule";

const { getFreshChangesMock, getSubmoduleDeleteRiskMock } = vi.hoisted(() => ({
  getFreshChangesMock: vi.fn(),
  getSubmoduleDeleteRiskMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  worktreeClient: {
    getFreshChanges: getFreshChangesMock,
    getSubmoduleDeleteRisk: getSubmoduleDeleteRiskMock,
  },
}));

import {
  summarizeWorktreeChanges,
  buildWorktreeDeletePreview,
  buildSubmoduleCommitRows,
  buildSubmoduleFileRows,
  deriveSubmoduleTierInputs,
  formatWorktreeDeletePreviewLines,
  formatWorktreeChangeRows,
  buildWorktreeChangeRows,
  submoduleForceRequired,
  type WorktreeSubmoduleRiskState,
} from "../worktreeDeletePreview";

/** A submodule inventory that found nothing — the ordinary case. */
function emptyRisk(over: Partial<SubmoduleDeleteRisk> = {}): SubmoduleDeleteRisk {
  return {
    entries: [],
    dirtyFiles: [],
    untrackedFiles: [],
    atRiskCommits: [],
    requiresMechanicalForce: false,
    incomplete: false,
    ...over,
  };
}

const CLEAR: WorktreeSubmoduleRiskState = { status: "verified", risk: emptyRisk() };

/**
 * The worktree root every fixture hangs off. Production `FileChangeDetail.path`
 * is ABSOLUTE — `electron/utils/git.ts` resolves each entry against the git
 * root — so `file()` builds absolute paths from a relative one. The previous
 * fixture hand-built bare names like `a.ts`, a shape the app never produces,
 * which is precisely why a preview rendering raw absolute paths passed this
 * suite while rendering unreadably in the real dialog (#11977).
 */
const ROOT = "/Users/dev/proj-worktrees/feature-streaming-uploads";

function file(path: string, status: GitStatus): FileChangeDetail {
  return { path: `${ROOT}/${path}`, status, insertions: null, deletions: null };
}

function changes(files: FileChangeDetail[]): WorktreeChanges {
  return {
    worktreeId: "wt-1",
    rootPath: ROOT,
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
    getSubmoduleDeleteRiskMock.mockResolvedValue(emptyRisk());
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

  it("carries a completed submodule inventory as verified", async () => {
    getFreshChangesMock.mockResolvedValue(changes([]));
    getSubmoduleDeleteRiskMock.mockResolvedValue(
      emptyRisk({ atRiskCommits: [{ oid: "a1b2c3d4e5", subject: "Fix the vendored parser" }] })
    );
    const preview = await buildWorktreeDeletePreview("wt-1");
    expect(getSubmoduleDeleteRiskMock).toHaveBeenCalledWith("wt-1");
    expect(preview?.submodules.status).toBe("verified");
    expect(preview?.submodules.risk?.atRiskCommits).toHaveLength(1);
  });

  it("marks the submodule half unverified when its fetch rejects, without failing the preview", async () => {
    // The parent status is what the fail-closed rejection contract covers.
    // Letting a submodule inventory failure reject the whole preview would turn
    // a partial answer into no answer.
    getFreshChangesMock.mockResolvedValue(changes([file("a.ts", "modified")]));
    getSubmoduleDeleteRiskMock.mockRejectedValue(new Error("no such handler"));
    const preview = await buildWorktreeDeletePreview("wt-1");
    expect(preview?.trackedChangeCount).toBe(1);
    expect(preview?.submodules).toEqual({ status: "unverified", risk: null });
  });

  it("treats an incomplete inventory as unverified while keeping what it found", async () => {
    getFreshChangesMock.mockResolvedValue(changes([]));
    const partial = emptyRisk({ incomplete: true, dirtyFiles: ["vendor/lib/src/main.c"] });
    getSubmoduleDeleteRiskMock.mockResolvedValue(partial);
    const preview = await buildWorktreeDeletePreview("wt-1");
    expect(preview?.submodules.status).toBe("unverified");
    expect(preview?.submodules.risk).toEqual(partial);
  });

  it("treats a null inventory as unverified, never as nothing found", async () => {
    getFreshChangesMock.mockResolvedValue(changes([]));
    getSubmoduleDeleteRiskMock.mockResolvedValue(null);
    const preview = await buildWorktreeDeletePreview("wt-1");
    expect(preview?.submodules).toEqual({ status: "unverified", risk: null });
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
      rootPath: ROOT,
      submodules: CLEAR,
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
      rootPath: ROOT,
      submodules: CLEAR,
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
      rootPath: ROOT,
      submodules: CLEAR,
    };
    const lines = formatWorktreeDeletePreviewLines(preview);
    // header + 12 files + overflow line
    expect(lines).toHaveLength(14);
    expect(lines[lines.length - 1]).toBe("  …and 3 more");
  });
});

describe("formatWorktreeChangeRows", () => {
  it("prefixes each file with its status glyph", () => {
    const rows = formatWorktreeChangeRows(
      [
        file("a.ts", "modified"),
        file("b.ts", "deleted"),
        file("c.ts", "added"),
        file("n.txt", "untracked"),
      ],
      undefined,
      ROOT
    );
    expect(rows).toEqual(["  M a.ts", "  D b.ts", "  A c.ts", "  ? n.txt"]);
  });

  it("drops ignored files (not part of what a delete discards)", () => {
    const rows = formatWorktreeChangeRows(
      [file("a.ts", "modified"), file("node_modules/x", "ignored")],
      undefined,
      ROOT
    );
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

  /**
   * The rule, not the value: a preview row must never carry the worktree root.
   * Asserted against the prefix rather than against specific expected strings
   * so it keeps holding when the row format changes — the point is that the
   * distinguishing part of a path is never pushed past the wrap by a prefix
   * that is identical on every row and already shown elsewhere in the dialog.
   */
  it("never repeats the worktree root on a row when the root is known", () => {
    const rows = formatWorktreeChangeRows(
      [
        file("src/queue.ts", "modified"),
        file("deeply/nested/dir/component.tsx", "added"),
        file(".env.local", "untracked"),
      ],
      undefined,
      ROOT
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).not.toContain(ROOT);
    }
    // ...and the filename still survives intact.
    expect(rows.join("\n")).toContain("src/queue.ts");
  });

  it("leaves a path that escapes the root absolute rather than mangling it", () => {
    const outside = "/somewhere/else/stray.ts";
    const rows = formatWorktreeChangeRows(
      [{ path: outside, status: "modified", insertions: null, deletions: null }],
      undefined,
      ROOT
    );
    expect(rows).toEqual([`  M ${outside}`]);
  });

  it("relativises Windows paths, not just POSIX ones", () => {
    // Daintree runs on Windows, where the producer emits backslash paths. A
    // separator-specific check leaves every Windows row absolute — the exact
    // defect this relativisation exists to prevent, on the other platform.
    const winRoot = "C:\\Users\\dev\\proj-worktrees\\feature-x";
    const rows = formatWorktreeChangeRows(
      [
        {
          path: `${winRoot}\\src\\queue.ts`,
          status: "modified",
          insertions: null,
          deletions: null,
        },
      ],
      undefined,
      winRoot
    );
    expect(rows).toEqual(["  M src\\queue.ts"]);
    expect(rows[0]).not.toContain(winRoot);
  });

  it("tolerates a root given with a trailing separator", () => {
    const rows = formatWorktreeChangeRows([file("src/a.ts", "modified")], undefined, `${ROOT}/`);
    expect(rows).toEqual(["  M src/a.ts"]);
  });

  it("carries a spoken status label on every structured row", () => {
    // The visible column is a single glyph — right for scanning, useless to a
    // screen reader, which would otherwise hear paths with no way to tell a
    // deletion from an addition.
    const rows = buildWorktreeChangeRows(
      [file("src/a.ts", "modified"), file("gone.ts", "deleted"), file("n.txt", "untracked")],
      undefined,
      ROOT
    );
    expect(rows.map((r) => r.statusLabel)).toEqual(["Modified", "Deleted", "Untracked"]);
    // The overflow tail is not a file and must not claim a status.
    const capped = buildWorktreeChangeRows(
      Array.from({ length: 14 }, (_, i) => file(`f${i}.ts`, "modified")),
      12,
      ROOT
    );
    expect(capped[capped.length - 1]?.statusLabel).toBeNull();
  });

  it("renders raw paths when no root is supplied", () => {
    const rows = formatWorktreeChangeRows([file("src/a.ts", "modified")]);
    expect(rows).toEqual([`  M ${ROOT}/src/a.ts`]);
  });
});

describe("submodule risk derivation", () => {
  it("counts observed commits as at-risk even when the walk did not finish", () => {
    const inputs = deriveSubmoduleTierInputs({
      status: "unverified",
      risk: emptyRisk({
        incomplete: true,
        atRiskCommits: [{ oid: "a1b2c3d4", subject: "WIP" }],
      }),
    });
    expect(inputs).toEqual({ submoduleCommitsAtRisk: true, submoduleRiskUnverified: true });
  });

  it("reports a clean verified inventory as neither at-risk nor unverified", () => {
    expect(deriveSubmoduleTierInputs(CLEAR)).toEqual({
      submoduleCommitsAtRisk: false,
      submoduleRiskUnverified: false,
    });
  });

  it("only claims force is mechanically required on a completed inventory", () => {
    expect(
      submoduleForceRequired({
        status: "verified",
        risk: emptyRisk({ requiresMechanicalForce: true }),
      })
    ).toBe(true);
    // Blocking the safe non-force attempt on state we could not read would
    // coerce the user into forcing on the very evidence we do not have.
    expect(
      submoduleForceRequired({
        status: "unverified",
        risk: emptyRisk({ requiresMechanicalForce: true }),
      })
    ).toBe(false);
  });
});

describe("submodule preview rows", () => {
  it("renders the real nested paths, dirty then untracked", () => {
    const rows = buildSubmoduleFileRows(
      emptyRisk({
        dirtyFiles: ["vendor/lib/src/main.c"],
        untrackedFiles: ["vendor/lib/scratch.log"],
      })
    );
    expect(rows.map((r) => [r.glyph, r.label])).toEqual([
      ["M", "vendor/lib/src/main.c"],
      ["?", "vendor/lib/scratch.log"],
    ]);
    expect(rows.map((r) => r.statusLabel)).toEqual(["Modified", "Untracked"]);
  });

  it("caps the nested file list across both buckets", () => {
    const rows = buildSubmoduleFileRows(
      emptyRisk({
        dirtyFiles: Array.from({ length: 10 }, (_, i) => `vendor/lib/d${i}.c`),
        untrackedFiles: Array.from({ length: 10 }, (_, i) => `vendor/lib/u${i}.c`),
      })
    );
    expect(rows).toHaveLength(13); // 12 files + overflow
    expect(rows[12]).toEqual({
      glyph: null,
      statusLabel: null,
      label: "…and 8 more",
      isOverflow: true,
    });
  });

  it("abbreviates commit oids and caps the list", () => {
    const rows = buildSubmoduleCommitRows(
      emptyRisk({
        atRiskCommits: Array.from({ length: 7 }, (_, i) => ({
          oid: `${i}abcdef0123456789`,
          subject: `Commit ${i}`,
        })),
      })
    );
    expect(rows).toHaveLength(6); // 5 commits + overflow
    // The full oid survives for identity (seven characters can collide); the
    // abbreviation is a separate display field.
    expect(rows[0]?.oid).toBe("0abcdef0123456789");
    expect(rows[0]?.shortOid).toBe("0abcdef");
    expect(rows[5]).toEqual({ oid: "", shortOid: "", subject: "…and 2 more", isOverflow: true });
  });

  it("returns nothing when there is no inventory to render", () => {
    expect(buildSubmoduleFileRows(null)).toEqual([]);
    expect(buildSubmoduleCommitRows(null)).toEqual([]);
  });
});

describe("formatWorktreeDeletePreviewLines — submodules", () => {
  const preview = (submodules: WorktreeSubmoduleRiskState, files: FileChangeDetail[] = []) => ({
    ...summarizeWorktreeChanges(files),
    changes: files,
    rootPath: ROOT,
    submodules,
  });

  it("never claims a clean tree while submodule work is listed below it", () => {
    const lines = formatWorktreeDeletePreviewLines(
      preview({
        status: "verified",
        risk: emptyRisk({
          atRiskCommits: [{ oid: "a1b2c3d4e5f6", subject: "Fix the vendored parser" }],
        }),
      })
    );
    expect(lines[0]).toBe("No uncommitted changes in the worktree itself.");
    expect(lines.some((l) => l.includes("Fix the vendored parser"))).toBe(true);
  });

  it("still reports a genuinely clean tree with the unqualified line", () => {
    expect(formatWorktreeDeletePreviewLines(preview(CLEAR))).toEqual(["No uncommitted changes."]);
  });

  it("lists nested paths rather than the single parent entry that stands for them", () => {
    // The parent's own status shows all of this as one ` M vendor/lib` row.
    const lines = formatWorktreeDeletePreviewLines(
      preview(
        {
          status: "verified",
          risk: emptyRisk({
            dirtyFiles: ["vendor/lib/src/main.c", "vendor/lib/src/parse.c"],
            untrackedFiles: ["vendor/lib/scratch.log"],
          }),
        },
        [file("vendor/lib", "modified")]
      )
    );
    expect(lines).toContain("  M vendor/lib/src/main.c");
    expect(lines).toContain("  M vendor/lib/src/parse.c");
    expect(lines).toContain("  ? vendor/lib/scratch.log");
    expect(lines.some((l) => l.includes("3 files the parent's status shows as one entry"))).toBe(
      true
    );
  });

  it("marks the at-risk commit header as a caution line", () => {
    const lines = formatWorktreeDeletePreviewLines(
      preview({
        status: "verified",
        risk: emptyRisk({ atRiskCommits: [{ oid: "a1b2c3d4e5f6", subject: "WIP vendored fix" }] }),
      })
    );
    // Scoped to what the inventory can actually prove — it measures
    // reachability from this module repo's own remote-tracking refs, so it
    // cannot claim the commit exists nowhere in the world.
    const header = lines.find((l) => l.includes("no remote this clone knows about"));
    expect(header?.startsWith("⚠ ")).toBe(true);
    expect(header).toContain("1 commit inside submodules is");
    expect(header).not.toContain("cannot be recovered");
    expect(lines).toContain("  a1b2c3d WIP vendored fix");
  });

  it("says the inventory could not be finished rather than implying it found nothing", () => {
    const lines = formatWorktreeDeletePreviewLines(preview({ status: "unverified", risk: null }));
    const caution = lines.find((l) => l.includes("submodules"));
    expect(caution?.startsWith("⚠ ")).toBe(true);
    expect(caution).toContain("Could not finish checking");
  });
});
