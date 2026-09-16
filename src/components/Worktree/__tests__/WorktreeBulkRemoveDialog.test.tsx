// @vitest-environment jsdom
import type React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, renderHook } from "@testing-library/react";

const worktreeClientMock = vi.hoisted(() => ({
  delete: vi.fn(),
  getFreshChanges: vi.fn(),
  getSubmoduleDeleteRisk: vi.fn(),
}));

// Only the module, never the `@/clients` barrel: the barrel re-exports from
// here so `worktreeDeletePreview` still gets the double, while the rest of the
// dialog's component graph keeps the real `projectClient` it loads at import.
vi.mock("@/clients/worktreeClient", () => ({ worktreeClient: worktreeClientMock }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  ...((window as unknown as Record<string, unknown>).electron ?? {}),
  devPreview: { getByWorktree: vi.fn(), stopByWorktree: vi.fn() },
};

import { WorktreeBulkRemoveDialog } from "../WorktreeBulkRemoveDialog";
import { useWorktreeBulkRemove } from "../useWorktreeBulkRemove";
import type { WorktreeState } from "@/types";
import type { WorktreeChanges } from "@shared/types/git";
import type {
  BulkRemoveTarget,
  BulkRemoveTargetStatus,
  UseWorktreeBulkRemoveReturn,
} from "../useWorktreeBulkRemove";
import { isBulkRemoveEligible, isBulkRemoveRetryable } from "../useWorktreeBulkRemove";
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
    hasRetryablePreviews: targets.some(isBulkRemoveRetryable),
    isRetryingPreviews: false,
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

let rerenderDialogFn: ((ui: React.ReactElement) => void) | null = null;

function renderDialog(over: Partial<UseWorktreeBulkRemoveReturn> = {}) {
  const value = hookValue(over);
  const { rerender } = render(<WorktreeBulkRemoveDialog bulkRemove={value} />);
  rerenderDialogFn = rerender;
  return value;
}

/** Re-render the same mounted dialog with a new hook snapshot. */
function rerenderDialog(over: Partial<UseWorktreeBulkRemoveReturn> = {}) {
  const value = hookValue(over);
  rerenderDialogFn!(<WorktreeBulkRemoveDialog bulkRemove={value} />);
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
 * Split a file row into its three parts. `textContent` concatenates the
 * aria-hidden glyph straight onto the sr-only status label ("MModified: …"),
 * which is correct in the DOM and unreadable as an assertion.
 */
function fileRows(list: Element): Array<{ glyph: string; spoken: string; path: string }> {
  return Array.from(list.querySelectorAll("li")).map((li) => {
    const spans = Array.from(li.querySelectorAll("span"));
    return {
      glyph: li.querySelector("[aria-hidden]")?.textContent ?? "",
      spoken: (li.querySelector(".sr-only")?.textContent ?? "").replace(/:\s*$/, ""),
      path: spans[spans.length - 1]?.textContent ?? "",
    };
  });
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
  rerenderDialogFn = null;
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
    // The D2 rule this surface was failing: "Preview must show actual content
    // (diff, message, file list). A count alone is insufficient."
    //
    // Exact paths, not substrings: they arrive ABSOLUTE from the host and are
    // relativised against `rootPath` for display, so a substring match would
    // pass on the un-relativised `/repo/a/src/agent.ts` that buries the
    // filename behind the worktree path.
    expect(fileRows(list!)).toEqual([
      { glyph: "M", spoken: "Modified", path: "src/agent.ts" },
      { glyph: "?", spoken: "Untracked", path: "notes.md" },
    ]);
  });

  it("renders no warning and no file list for an eligible, clean worktree", () => {
    // The negative half of the D2 duty: a clean worktree must not be dressed
    // up with an empty warning row.
    renderDialog({ targets: [target("a")] });

    const row = document.querySelector('[data-testid="bulk-remove-target"]')!;
    // The warning CONTAINER, not just its text: dropping the empty-risks guard
    // leaves a bare alert icon behind, which every text-based assertion here
    // would happily pass.
    expect(document.querySelector('[data-testid="bulk-remove-risks"]')).toBeNull();
    expect(row.querySelector("svg.text-status-warning")).toBeNull();
    expect(document.querySelector('[data-testid="bulk-remove-file-list"]')).toBeNull();
    expect(document.querySelector('[data-testid="bulk-remove-excluded"]')).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect((row.textContent ?? "").trim()).toBe("feature/a");
  });

  it("names untracked-only submodule content, which the parent status omits entirely", () => {
    renderDialog({
      targets: [
        target("a", {
          status: verified({
            submodules: {
              status: "verified",
              risk: risk({ untrackedFiles: ["vendor/lib/new.c"] }),
            },
          }),
        }),
      ],
    });

    const lists = document.querySelectorAll('[data-testid="bulk-remove-file-list"]');
    // Only the nested list — the parent is clean, so there is nothing to show
    // for it, and a submodule's untracked file is invisible in `git status`.
    expect(lists).toHaveLength(1);
    expect(fileRows(lists[0]!)).toEqual([
      { glyph: "?", spoken: "Untracked", path: "vendor/lib/new.c" },
    ]);
    expect(document.body.textContent).toContain("1 file inside submodules");
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
    const rows = Array.from(list.querySelectorAll("li")).map((li) => li.textContent ?? "");
    const overflow = rows.find((r) => /and \d+ more/.test(r));
    expect(overflow, "a truncated list must say how many rows it withheld").toBeDefined();

    // Derived from the fixture, not from the cap: shown rows plus the number
    // the tail admits to withholding must account for every input file, at any
    // cap. Restating "5" and "4 more" here would just re-spell the constant.
    const withheld = Number(/and (\d+) more/.exec(overflow!)![1]);
    const shown = rows.length - 1;
    expect(shown + withheld).toBe(9);
    expect(shown).toBeLessThan(9);
  });
});

describe("WorktreeBulkRemoveDialog — gating", () => {
  it("offers no typed gate at all while nothing has been cleared yet", () => {
    renderDialog({ targets: [target("a", { status: { state: "pending" } })] });

    expect(confirmIsDisabled()).toBe(true);
    // Nothing is eligible yet, so there is no count to attest to.
    expect(document.querySelector("input")).toBeNull();
    // Says what it is waiting on, where the user is looking when they ask.
    expect(document.body.textContent).toContain("Checking each worktree for uncommitted work");
  });

  it("holds the primary shut on a part-settled batch even once the count is typed", () => {
    // One target cleared, one still checking — so a typed gate IS on screen
    // and can be satisfied. The primary must stay closed anyway: consent given
    // before the last row's evidence lands is consent to something unseen.
    const value = renderDialog({
      targets: [target("a"), target("b", { status: { state: "pending" } })],
    });

    expect(value.eligibleCount).toBe(1);
    typeTheCount(value.typedNameTarget);
    expect(confirmIsDisabled()).toBe(true);
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

    // No typed gate is offered at zero eligible, so the primary is closed on
    // `confirmDisabled` alone.
    expect(confirmIsDisabled()).toBe(true);
    expect(document.body.textContent).toContain("Every selected worktree was excluded");
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

  it("offers a retry when only the submodule check failed", () => {
    // The parent status succeeded, so `status.state` is "verified" — but the
    // inventory did not answer, which a retry CAN clear. Keying the affordance
    // off the failed-parent state alone left this batch unrecoverable without
    // cancelling and reopening.
    const value = renderDialog({
      targets: [
        target("a", {
          status: verified({ submodules: { status: "unverified", risk: null } }),
        }),
      ],
    });

    expect(value.eligibleCount).toBe(0);
    expect(document.querySelector('[data-testid="bulk-remove-excluded"]')?.textContent).toContain(
      "submodule check didn't finish"
    );
    const retry = document.querySelector(
      '[data-testid="bulk-remove-retry-previews"]'
    ) as HTMLButtonElement | null;
    expect(retry, "a submodule check that never answered has to be retryable").not.toBeNull();
    act(() => retry!.click());
    expect(value.handleRetryPreviews).toHaveBeenCalled();
  });

  it("offers no retry for at-risk commits, which only a push or fetch clears", () => {
    renderDialog({
      targets: [
        target("a", {
          status: verified({
            submodules: {
              status: "verified",
              risk: risk({ atRiskCommits: [{ oid: "abc1234def", subject: "wip" }] }),
            },
          }),
        }),
      ],
    });

    // That inventory DID answer. Offering Retry would promise a recovery the
    // button does not have.
    expect(document.querySelector('[data-testid="bulk-remove-retry-previews"]')).toBeNull();
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
    expect(excluded.textContent).toContain("can't find on a remote");
    expect(excluded.textContent).toContain("wip: vendored hotfix");
    expect(excluded.textContent).toContain("abc1234");
  });
});

describe("WorktreeBulkRemoveDialog — the title and the button agree", () => {
  it("names the eligible batch once previews settle, not the selection", () => {
    // The title used to name all three while the button offered one, so the
    // dialog asked the user to confirm a removal it was not going to perform.
    renderDialog({
      targets: [
        target("a"),
        target("b", { status: { state: "gone" } }),
        target("c", { status: { state: "failed", submodules: null } }),
      ],
    });

    expect(document.body.textContent).toContain("Remove 'feature/a'?");
    expect(confirmButton()?.textContent).toContain("Remove worktree");
  });

  it("names the selection while previews are still pending", () => {
    // The eligible count is not known yet, so naming it would be a guess.
    renderDialog({
      targets: [target("a", { status: { state: "pending" } }), target("b")],
    });
    expect(document.body.textContent).toContain("Remove 2 worktrees?");
  });

  it("counts main-worktree exclusions in the exclusion total", () => {
    // One main filtered out before the dialog opened, one target excluded by
    // its own preview, one eligible — the user excluded two things, and a
    // total that said "1" understated what it had dropped.
    renderDialog({
      excludedMainCount: 1,
      targets: [target("a"), target("b", { status: { state: "gone" } })],
    });
    expect(document.body.textContent).toContain("2 excluded — 1 will be removed");
  });

  it("offers no typed gate and no removal question when nothing can run", () => {
    renderDialog({ targets: [target("a", { status: { state: "gone" } })] });

    expect(document.body.textContent).toContain("Every selected worktree was excluded");
    // The most emphatic confirmation the app has must not be raised for a
    // batch of zero.
    expect(document.querySelector("input")).toBeNull();
  });

  it("says nothing extra when the whole batch is eligible", () => {
    renderDialog({ targets: [target("a"), target("b")] });
    expect(document.querySelector('[data-testid="app-dialog-hint"]')).toBeNull();
  });
});

describe("WorktreeBulkRemoveDialog — activation", () => {
  it("runs the confirm handler once the gate is satisfied", () => {
    // Without this, replacing onConfirm with a no-op would pass the suite.
    const value = renderDialog({ targets: [target("a")] });

    act(() => confirmButton()!.click());
    expect(value.handleConfirm).not.toHaveBeenCalled();

    typeTheCount("1 worktree");
    act(() => confirmButton()!.click());
    expect(value.handleConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps Retry mounted through its own re-run so focus is never stranded", () => {
    // Clicking Retry drops every row back to pending, which clears
    // `hasRetryablePreviews`. Unmounting the button under the user's own click
    // drops focus onto document.body inside an open dialog.
    const value = renderDialog({
      targets: [target("a", { status: { state: "failed", submodules: null } })],
    });
    const retry = document.querySelector(
      '[data-testid="bulk-remove-retry-previews"]'
    ) as HTMLButtonElement;
    act(() => retry.click());
    expect(value.handleRetryPreviews).toHaveBeenCalled();

    // What the hook reports mid-retry: everything back to pending, nothing
    // retryable any more, and `isRetryingPreviews` carrying the reason.
    rerenderDialog({
      targets: [target("a", { status: { state: "pending" } })],
      isPreviewPending: true,
      isRetryingPreviews: true,
    });
    const afterRetry = document.querySelector(
      '[data-testid="bulk-remove-retry-previews"]'
    ) as HTMLButtonElement | null;
    expect(afterRetry, "Retry must survive its own click").not.toBeNull();
    expect(afterRetry!.disabled).toBe(true);
  });

  it("disables Retry while the batch is executing", () => {
    renderDialog({
      targets: [target("a", { status: { state: "failed", submodules: null } })],
      isExecuting: true,
    });
    const retry = document.querySelector(
      '[data-testid="bulk-remove-retry-previews"]'
    ) as HTMLButtonElement | null;
    // The handler refuses mid-run; a live button would advertise a no-op.
    expect(retry?.disabled).toBe(true);
  });
});

describe("WorktreeBulkRemoveDialog — settled evidence clears earlier consent", () => {
  function wt(id: string): WorktreeState {
    return {
      id,
      name: id,
      path: `/repo/${id}`,
      branch: `feature/${id}`,
      worktreeChanges: null,
      lastActivityTimestamp: null,
    } as WorktreeState;
  }

  it("clears a count typed against the skeletons when the previews land", async () => {
    // Driven through the REAL hook, because the thing under test is the
    // `consentKey` flip. A static hook value would keep passing if
    // `cooldownKey` were dropped from the dialog entirely.
    //
    // The eligible count is deliberately 1 both before and after, so
    // `typedNameTarget` never changes — ConfirmDialog also resets on that, and
    // it would mask the reset actually being tested.
    let resolveA: ((v: WorktreeChanges | null) => void) | undefined;
    worktreeClientMock.getFreshChanges.mockImplementation((id: string) =>
      id === "a"
        ? Promise.resolve({
            worktreeId: id,
            rootPath: `/repo/${id}`,
            changes: [],
            changedFileCount: 0,
          })
        : new Promise<WorktreeChanges | null>((resolve) => {
            resolveA = resolve;
          })
    );
    worktreeClientMock.getSubmoduleDeleteRisk.mockResolvedValue(risk());

    const hook = renderHook(() =>
      useWorktreeBulkRemove({
        selectedIds: new Set(["a", "b"]),
        worktreeMap: new Map([
          ["a", wt("a")],
          ["b", wt("b")],
        ]),
        clearSelection: vi.fn(),
      })
    );
    const { rerender } = render(<WorktreeBulkRemoveDialog bulkRemove={hook.result.current} />);

    act(() => hook.result.current.handleRemoveClick());
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    rerender(<WorktreeBulkRemoveDialog bulkRemove={hook.result.current} />);

    // "a" is eligible, "b" is still pending. Type the count now.
    expect(hook.result.current.eligibleCount).toBe(1);
    typeTheCount("1 worktree");
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("1 worktree");

    // "b" comes back unverifiable, so the eligible count stays 1.
    await act(async () => {
      resolveA!(null);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    rerender(<WorktreeBulkRemoveDialog bulkRemove={hook.result.current} />);
    expect(hook.result.current.eligibleCount).toBe(1);

    // Same count, new evidence — the attestation must not survive it.
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(confirmIsDisabled()).toBe(true);
    hook.unmount();
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
