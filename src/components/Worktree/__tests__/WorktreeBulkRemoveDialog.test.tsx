// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { WorktreeBulkRemoveDialog } from "../WorktreeBulkRemoveDialog";
import type {
  BulkRemoveTarget,
  BulkRemoveTargetStatus,
  UseWorktreeBulkRemoveReturn,
} from "../useWorktreeBulkRemove";
import { isBulkRemoveEligible } from "../useWorktreeBulkRemove";
import type { WorktreeDeletePreview } from "../worktreeDeletePreview";
import type { FileChangeDetail } from "@shared/types/git";
import type { SubmoduleDeleteRisk } from "@shared/types/submodule";

function change(path: string, status: FileChangeDetail["status"]): FileChangeDetail {
  return { path, status, insertions: null, deletions: null };
}

function risk(over: Partial<SubmoduleDeleteRisk> = {}): SubmoduleDeleteRisk {
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

function verified(over: Partial<WorktreeDeletePreview> = {}): BulkRemoveTargetStatus {
  const changes = over.changes ?? [];
  return {
    state: "verified",
    preview: {
      trackedChangeCount: changes.filter((c) => c.status !== "untracked" && c.status !== "ignored")
        .length,
      untrackedFileCount: changes.filter((c) => c.status === "untracked").length,
      hasTrackedChanges: false,
      hasUntrackedFiles: false,
      changes,
      rootPath: "/repo/a",
      submodules: { status: "verified", risk: risk() },
      ...over,
    },
  };
}

function target(id: string, over: Partial<BulkRemoveTarget> = {}): BulkRemoveTarget {
  return {
    id,
    name: id,
    branch: `feature/${id}`,
    path: `/repo/${id}`,
    aheadCount: 0,
    status: verified(),
    ...over,
  };
}

function hookValue(over: Partial<UseWorktreeBulkRemoveReturn> = {}): UseWorktreeBulkRemoveReturn {
  const targets = over.targets ?? [target("a")];
  const eligibleCount = over.eligibleCount ?? targets.filter(isBulkRemoveEligible).length;
  const isPreviewPending =
    over.isPreviewPending ?? targets.some((t) => t.status.state === "pending");
  return {
    isConfirmOpen: true,
    targets,
    excludedMainCount: 0,
    eligibleCount,
    isPreviewPending,
    hasFailedPreviews: targets.some((t) => t.status.state === "failed"),
    consentKey: `1:${isPreviewPending ? "pending" : "settled"}`,
    typedNameTarget: eligibleCount === 1 ? "1 worktree" : `${eligibleCount} worktrees`,
    canConfirm: !isPreviewPending && eligibleCount > 0,
    isExecuting: false,
    handleRemoveClick: vi.fn(),
    handleRetryPreviews: vi.fn(),
    handleConfirm: vi.fn(),
    handleCancel: vi.fn(),
    ...over,
  };
}

function renderDialog(over: Partial<UseWorktreeBulkRemoveReturn> = {}) {
  const value = hookValue(over);
  render(<WorktreeBulkRemoveDialog bulkRemove={value} />);
  return value;
}

/** The primary action, found by its accessible name rather than a testid. */
function confirmButton(): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll("button"));
  return (buttons.find((b) => /^Remove\b/.test(b.textContent ?? "")) ??
    null) as HTMLButtonElement | null;
}

/**
 * `AppDialog.Footer` disables its primary with `aria-disabled` rather than the
 * DOM property, so the button stays focusable and its name stays announced.
 */
function confirmIsDisabled(): boolean {
  return confirmButton()?.getAttribute("aria-disabled") === "true";
}

/**
 * Satisfy the typed-count gate, so what the assertion then measures is the
 * dialog's OWN gate rather than an untyped input.
 */
function typeTheCount(value: string) {
  const input = document.querySelector("input") as HTMLInputElement | null;
  expect(input).not.toBeNull();
  fireEvent.change(input!, { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("WorktreeBulkRemoveDialog — the preview is the consent (#12416)", () => {
  it("lists the actual files it is about to discard, not just a count", () => {
    renderDialog({
      targets: [
        target("a", {
          status: verified({
            changes: [
              change("/repo/a/src/agent.ts", "modified"),
              change("/repo/a/notes.md", "untracked"),
            ],
          }),
        }),
      ],
    });

    const list = document.querySelector('[data-testid="bulk-remove-file-list"]');
    expect(list).not.toBeNull();
    const text = list!.textContent ?? "";
    // The D2 rule this surface was failing: "Preview must show actual content
    // (diff, message, file list). A count alone is insufficient."
    expect(text).toContain("src/agent.ts");
    expect(text).toContain("notes.md");
  });

  it("names the nested submodule files the parent status collapses into one row", () => {
    renderDialog({
      targets: [
        target("a", {
          status: verified({
            changes: [change("/repo/a/vendor/lib", "modified")],
            submodules: {
              status: "verified",
              risk: risk({ dirtyFiles: ["vendor/lib/src/main.c"] }),
            },
          }),
        }),
      ],
    });

    const body = document.body.textContent ?? "";
    expect(body).toContain("vendor/lib/src/main.c");
    expect(body).toContain("1 file inside submodules");
  });

  it("caps a long file list and says how many it withheld", () => {
    renderDialog({
      targets: [
        target("a", {
          status: verified({
            changes: Array.from({ length: 9 }, (_, i) =>
              change(`/repo/a/file-${i}.ts`, "modified")
            ),
          }),
        }),
      ],
    });

    const list = document.querySelector('[data-testid="bulk-remove-file-list"]')!;
    expect(list.textContent).toContain("file-0.ts");
    expect(list.textContent).toContain("…and 4 more");
    // Five rows plus the tail — a twenty-worktree selection has to stay
    // scannable or the row that matters scrolls out of the fixed-height list.
    expect(list.querySelectorAll("li")).toHaveLength(6);
  });
});

describe("WorktreeBulkRemoveDialog — gating", () => {
  it("disables the primary while any preview is still pending, even once the count is typed", () => {
    const value = renderDialog({ targets: [target("a", { status: { state: "pending" } })] });

    typeTheCount(value.typedNameTarget);
    // The typed gate is satisfied and the primary is STILL closed — consent
    // given against a skeleton is consent to evidence nobody has seen.
    expect(confirmIsDisabled()).toBe(true);
    // Says what it is waiting on, where the user is looking when they ask.
    expect(document.body.textContent).toContain("Checking each worktree for uncommitted work");
  });

  it("renders a loading status rather than an empty row while pending", () => {
    renderDialog({ targets: [target("a", { status: { state: "pending" } })] });

    const status = document.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.getAttribute("aria-busy")).toBe("true");
    // A zero-count row would be a claim the evidence has not made yet.
    expect(document.querySelector('[data-testid="bulk-remove-file-list"]')).toBeNull();
  });

  it("disables the primary when every target was excluded", () => {
    renderDialog({
      targets: [
        target("a", { status: { state: "failed", submodules: null } }),
        target("b", { status: { state: "gone" } }),
      ],
    });

    typeTheCount("0 worktrees");
    expect(confirmIsDisabled()).toBe(true);
    expect(document.body.textContent).toContain("Nothing left to remove");
  });

  it("counts only the eligible targets in the typed gate and the button label", () => {
    renderDialog({
      targets: [
        target("a"),
        target("b", { status: { state: "gone" } }),
        target("c", { status: { state: "failed", submodules: null } }),
      ],
    });

    // Three rows are listed, but the consent is for the one that will run.
    expect(document.querySelectorAll('[data-testid="bulk-remove-target"]')).toHaveLength(3);
    expect(confirmButton()?.textContent).toContain("Remove worktree");
    expect(document.body.textContent).toContain("2 excluded — 1 will be removed");

    // Typing the SELECTED count must not open the gate — only the eligible
    // count does, so the number the user types is the number that runs.
    typeTheCount("3 worktrees");
    expect(confirmIsDisabled()).toBe(true);
    typeTheCount("1 worktree");
    expect(confirmIsDisabled()).toBe(false);
  });
});

describe("WorktreeBulkRemoveDialog — exclusions state their reason", () => {
  it("says an already-removed worktree is excluded", () => {
    renderDialog({ targets: [target("a", { status: { state: "gone" } })] });
    expect(document.querySelector('[data-testid="bulk-remove-excluded"]')?.textContent).toContain(
      "Already removed"
    );
  });

  it("says an unverifiable worktree is excluded and offers a retry", () => {
    const value = renderDialog({
      targets: [target("a", { status: { state: "failed", submodules: null } })],
    });

    expect(document.querySelector('[data-testid="bulk-remove-excluded"]')?.textContent).toContain(
      "Couldn't read this worktree's changes"
    );
    const retry = document.querySelector(
      '[data-testid="bulk-remove-retry-previews"]'
    ) as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    act(() => retry!.click());
    expect(value.handleRetryPreviews).toHaveBeenCalled();
  });

  it("names the at-risk commits behind a blocked target", () => {
    // The host refuses these before it reads `force`, so the row has to say
    // what would clear it rather than offering a gate that cannot work.
    renderDialog({
      targets: [
        target("a", {
          status: verified({
            submodules: {
              status: "verified",
              risk: risk({
                atRiskCommits: [{ oid: "abc1234def5678", subject: "wip: vendored hotfix" }],
              }),
            },
          }),
        }),
      ],
    });

    const excluded = document.querySelector('[data-testid="bulk-remove-excluded"]')!;
    expect(excluded.textContent).toContain("not on any remote");
    expect(excluded.textContent).toContain("wip: vendored hotfix");
    expect(excluded.textContent).toContain("abc1234");
  });
});

describe("WorktreeBulkRemoveDialog — copy", () => {
  it("states the specific consequence, including that branches are kept", () => {
    renderDialog();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Uncommitted and untracked files are discarded");
    expect(body).toContain("including files inside submodules");
    // `deleteBranch: false` — the commits on a named branch outlive the
    // worktree, and saying so is what stops the confirm overstating itself.
    expect(body).toContain("Branches are kept");
  });

  it("names the excluded main worktrees", () => {
    renderDialog({ excludedMainCount: 1 });
    expect(document.body.textContent).toContain("1 main worktree is excluded");
  });
});
