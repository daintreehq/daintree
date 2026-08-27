/**
 * @vitest-environment jsdom
 */
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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

const {
  startDeleteMock,
  terminalCountsMock,
  terminalsMock,
  devPreviewGetByWorktreeMock,
  buildPreviewMock,
} = vi.hoisted(() => ({
  startDeleteMock: vi.fn(),
  terminalCountsMock: { total: 0 },
  terminalsMock: [] as Array<{ running?: boolean }>,
  devPreviewGetByWorktreeMock: vi.fn(),
  buildPreviewMock: vi.fn(),
}));

// Mock only the fresh-fetch builder; keep `summarizeWorktreeChanges` real so
// the prop-seed path (existing render assertions) is exercised unchanged.
vi.mock("@/components/Worktree/worktreeDeletePreview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktreeDeletePreview")>();
  return { ...actual, buildWorktreeDeletePreview: buildPreviewMock };
});

(globalThis as Record<string, unknown>).window = globalThis.window ?? {};
(window as unknown as Record<string, unknown>).electron = {
  ...((window as unknown as Record<string, unknown>).electron ?? {}),
  devPreview: {
    getByWorktree: devPreviewGetByWorktreeMock,
    stopByWorktree: vi.fn(),
  },
};

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ startDelete: startDeleteMock }),
  }),
}));

vi.mock("@/hooks/useWorktreeTerminals", () => ({
  useWorktreeTerminals: () => ({ counts: terminalCountsMock, terminals: terminalsMock }),
}));

// Agent detection is covered by its own unit suite; here we just steer the
// running-agent subset directly so the D2 preview breakdown can be asserted.
vi.mock("@/utils/destructiveSessionConfirm", () => ({
  collectRunningAgentTerminals: (terminals: Array<{ running?: boolean }>) =>
    terminals.filter((t) => t.running),
}));

/**
 * Faithful enough to assert the chrome contract, not just to render.
 *
 * `hasPreview` and the structured footer actions are surfaced as DOM
 * attributes because both are load-bearing and both were silently wrong here:
 * without `hasPreview` the real AppDialog locks `role="alertdialog"` onto a
 * dialog full of form controls, and a footer built from `children` never gets
 * the `data-confirm-role` markers the "focus Cancel first" behaviour resolves
 * against — so focus fell through to the force checkbox (#11977).
 */
vi.mock("@/components/ui/AppDialog", () => {
  type Action = { label: string; onClick: () => void; disabled?: boolean; intent?: string };
  const Dialog = ({
    children,
    isOpen,
    hasPreview,
    variant,
  }: {
    children: React.ReactNode;
    isOpen: boolean;
    onClose?: () => void;
    size?: string;
    variant?: string;
    hasPreview?: boolean;
    "data-testid"?: string;
  }) =>
    isOpen ? (
      <div
        data-testid="delete-worktree-dialog"
        data-has-preview={hasPreview ? "true" : "false"}
        data-variant={variant}
      >
        {children}
      </div>
    ) : null;
  Dialog.Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>;
  Dialog.CloseButton = () => <button aria-label="Close dialog" />;
  Dialog.Description = ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <p data-testid="delete-worktree-description" className={className}>
      {children}
    </p>
  );
  Dialog.Footer = ({
    children,
    hint,
    primaryAction,
    secondaryAction,
  }: {
    children?: React.ReactNode;
    hint?: React.ReactNode;
    primaryAction?: Action;
    secondaryAction?: Action;
  }) => (
    <div>
      {hint && <div data-testid="delete-worktree-hint">{hint}</div>}
      {children}
      {secondaryAction && (
        <button data-confirm-role="cancel" onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </button>
      )}
      {primaryAction && (
        <button
          data-testid="delete-worktree-confirm"
          data-confirm-role="confirm"
          data-intent={primaryAction.intent}
          disabled={primaryAction.disabled}
          onClick={primaryAction.onClick}
        >
          {primaryAction.label}
        </button>
      )}
    </div>
  );
  return { AppDialog: Dialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => {
    const { variant: _v, ...htmlProps } = props as Record<string, unknown>;
    return (
      <button {...(htmlProps as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
    );
  },
}));

import { WorktreeDeleteDialog } from "../WorktreeDeleteDialog";

function makeWorktree(
  worktreeChanges: WorktreeChanges | null = null,
  overrides: Partial<WorktreeState> = {}
): WorktreeState {
  const base = {
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
  return { ...base, ...overrides };
}

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

// A fresh delete preview (what buildWorktreeDeletePreview resolves to) for the
// on-open / on-submit fetch (#11343).
function makePreview(files: Array<{ path: string; status: GitStatus }>) {
  const changes = files.map((f) => ({
    path: f.path,
    status: f.status,
    insertions: null,
    deletions: null,
  }));
  const trackedChangeCount = changes.filter(
    (c) => c.status !== "untracked" && c.status !== "ignored"
  ).length;
  const untrackedFileCount = changes.filter((c) => c.status === "untracked").length;
  return {
    trackedChangeCount,
    untrackedFileCount,
    hasTrackedChanges: trackedChangeCount > 0,
    hasUntrackedFiles: untrackedFileCount > 0,
    changes,
    rootPath: "/test/worktree",
  };
}

describe("WorktreeDeleteDialog — warning messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
    terminalsMock.length = 0;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    // Default: no fresh override → dialog uses the prop seed (existing tests).
    buildPreviewMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows no warning when worktree has no changes", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.queryByText(/Standard deletion will fail/)).toBeNull();
  });

  it("shows untracked-file count when only untracked files exist", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "new.txt", status: "untracked" },
        { path: "temp.log", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("2 untracked files");
    expect(warning.textContent).not.toContain("uncommitted file");
  });

  it("shows uncommitted-file count when only tracked changes exist", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "src/index.ts", status: "deleted" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("2 uncommitted files");
    expect(warning.textContent).not.toContain("untracked file");
  });

  it("shows both counts when tracked and untracked files exist", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "src/index.ts", status: "modified" },
        { path: "new.txt", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("2 uncommitted files and 1 untracked file");
  });

  it("uses singular form for a single tracked change", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("1 uncommitted file ");
    expect(warning.textContent).not.toContain("1 uncommitted files");
  });

  it("uses singular form for a single untracked file", () => {
    const worktree = makeWorktree(makeChanges([{ path: "new.txt", status: "untracked" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("1 untracked file ");
    expect(warning.textContent).not.toContain("1 untracked files");
  });

  it("excludes ignored files from the uncommitted count", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "node_modules/foo", status: "ignored" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const warning = screen.getByText(/Standard deletion will fail/);
    expect(warning.textContent).toContain("1 uncommitted file ");
  });

  it("persists banner with escalated copy when force is checked for tracked changes", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Standard deletion will fail/)).toBeDefined();

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.queryByText(/Standard deletion will fail/)).toBeNull();
    // The separate red banner is gone: it repeated counts the consequence list
    // already carries, and stated irreversibility a third time. The loss is now
    // one danger-toned consequence row.
    expect(screen.getByText(/1 uncommitted file will be permanently lost/)).toBeDefined();
  });

  it("persists banner with escalated copy when force is checked for untracked-only files", () => {
    const worktree = makeWorktree(makeChanges([{ path: "new.txt", status: "untracked" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/Standard deletion will fail/)).toBeDefined();

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.queryByText(/Standard deletion will fail/)).toBeNull();
    expect(screen.getByText(/1 untracked file will be permanently lost/)).toBeDefined();
  });

  it("shows combined counts in force banner when both tracked and untracked files exist", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "new.txt", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    const row = screen.getByText(/will be permanently lost/);
    expect(row.textContent).toContain("and 1 untracked file");
    // Irreversibility is stated once, at the D3 gate — not repeated here.
    expect(row.textContent).not.toContain("irreversible");
  });

  /**
   * Replaces three tests that asserted the force label swapped between
   * "(remove untracked files)", "(lose uncommitted changes)" and the combined
   * form. A toggle label never changes with state (house microcopy rule), so
   * the varying detail moved to a sub-line under a constant label. Invariance
   * itself is pinned in the "dialog chrome contract" block.
   */
  it("states the change breakdown under the force toggle without altering its label", () => {
    const worktree = makeWorktree(
      makeChanges([
        { path: "src/app.ts", status: "modified" },
        { path: "new.txt", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const toggle = screen.getByRole("checkbox", { name: /force delete/i });
    expect(toggle.closest("label")?.textContent).toContain(
      "1 uncommitted file and 1 untracked file present"
    );
  });
});

describe("WorktreeDeleteDialog — consequence list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
    terminalsMock.length = 0;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    buildPreviewMock.mockResolvedValue(null);
  });

  /**
   * The rule this block pins, replacing the old strikethrough assertions:
   * **a consequence row exists if and only if that consequence will occur.**
   *
   * Previously every outcome was always rendered and the inapplicable ones
   * were dimmed + struck through, so a clean delete showed five rows of which
   * four were non-events (#11977). Those tests asserted the strikethrough
   * class, i.e. the implementation value; these assert presence/absence, i.e.
   * the rule — so they keep holding if the row styling changes again.
   */

  const DIRECTORY_ROW = "Worktree directory will be deleted from disk";

  it("renders the 'What will happen' heading", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText("What will happen")).toBeDefined();
  });

  it("shows ONLY the directory row for a clean worktree with nothing attached", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText(DIRECTORY_ROW)).toBeDefined();
  });

  it("never renders a struck-through consequence row in any state", () => {
    terminalCountsMock.total = 2;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    const worktree = makeWorktree(makeChanges([{ path: "/wt/src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    for (const row of within(screen.getByRole("list")).getAllByRole("listitem")) {
      expect(row.className).not.toContain("line-through");
    }
  });

  it("omits the terminal row when there are no terminals, and shows it when there are", () => {
    const worktree = makeWorktree(makeChanges([]));
    const { unmount } = render(
      <WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />
    );
    expect(screen.queryByText(/terminals? will be closed/)).toBeNull();
    // The "0 terminals" template leak: a count row must never render a zero.
    expect(screen.queryByText(/^0 terminal/)).toBeNull();
    unmount();

    terminalCountsMock.total = 3;
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);
    expect(screen.getByText(/3 terminals will be closed/)).toBeDefined();
  });

  it("uses singular 'terminal' when one terminal is associated", () => {
    terminalCountsMock.total = 1;
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/1 terminal will be closed/)).toBeDefined();
    expect(screen.queryByText(/1 terminals/)).toBeNull();
  });

  it("drops the terminal row when the user unchecks 'Close all terminals'", () => {
    terminalCountsMock.total = 2;
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/2 terminals will be closed/)).toBeDefined();
    fireEvent.click(screen.getByRole("checkbox", { name: /close all terminals/i }));
    expect(screen.queryByText(/terminals will be closed/)).toBeNull();
  });

  it("breaks out the running-agent subset only when agents are running", () => {
    terminalCountsMock.total = 3;
    terminalsMock.push({ running: true }, { running: true }, { running: false });
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText(/3 terminals will be closed — 2 running an agent/)).toBeDefined();
  });

  it("omits the data-loss row unless force is on AND there is something to lose", () => {
    const clean = makeWorktree(makeChanges([]));
    const { unmount } = render(
      <WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={clean} />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    expect(screen.queryByText(/will be permanently lost/)).toBeNull();
    unmount();

    const dirty = makeWorktree(makeChanges([{ path: "/wt/src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={dirty} />);
    // Dirty but not forced: still nothing is lost yet.
    expect(screen.queryByText(/will be permanently lost/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    expect(screen.getByText(/will be permanently lost/)).toBeDefined();
  });

  it("marks the data-loss row as the only danger-toned consequence", () => {
    const worktree = makeWorktree(makeChanges([{ path: "/wt/src/app.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    const danger = within(screen.getByRole("list"))
      .getAllByRole("listitem")
      .filter((row) => row.className.includes("text-status-error"));
    expect(danger).toHaveLength(1);
    expect(danger[0]?.textContent).toContain("permanently lost");
  });

  it("never signals the irreversible row by colour alone", () => {
    // Under `forced-colors: active` every status colour resolves to the same
    // system ink, so a colour-only danger cue disappears exactly where it is
    // needed most. The row must carry a non-colour signal too.
    const worktree = makeWorktree(makeChanges([{ path: "/wt/src/app.ts", status: "modified" }]));
    const { container } = render(
      <WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    const danger = container.querySelector('li[data-tone="danger"]');
    expect(danger).not.toBeNull();
    // A glyph, plus a weight distinction, plus an assistive-tech qualifier —
    // none of which depend on the colour surviving.
    expect(danger?.querySelector("svg")).not.toBeNull();
    expect(danger?.className).toContain("font-medium");
    expect(danger?.textContent).toContain("Irreversible:");
  });

  it("omits the branch row until 'Delete branch' is checked", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const list = () => screen.getByRole("list");
    expect(
      within(list())
        .getAllByRole("listitem")
        .some((row) => /will be deleted$/.test(row.textContent ?? ""))
    ).toBe(false);

    fireEvent.click(screen.getByRole("checkbox", { name: /delete branch/i }));
    expect(
      within(list())
        .getAllByRole("listitem")
        .some((row) => (row.textContent ?? "").startsWith("Branch feature/test"))
    ).toBe(true);
    expect(screen.getByText(/fails if it has unmerged changes/)).toBeDefined();
  });

  it("does not offer a branch row for a protected branch", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.queryByRole("checkbox", { name: /delete branch/i })).toBeNull();
  });

  it("states the specific permanent result instead of generic irreversibility copy", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    // House microcopy rule: the body names the consequence; generic
    // irreversibility copy is confirmation-fatigue filler. ConfirmDialog warns
    // on this string at runtime; this dialog bypasses that guard, so pin it.
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
    expect(screen.queryByText(/can't be undone/i)).toBeNull();
  });

  it("names the worktree path and branch concretely", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByText("/test/worktree")).toBeDefined();
    expect(screen.getAllByText("feature/test").length).toBeGreaterThan(0);
  });
});

describe("WorktreeDeleteDialog — dialog chrome contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
    terminalsMock.length = 0;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    buildPreviewMock.mockResolvedValue(null);
  });

  it("declares hasPreview so the ARIA role is dialog, not alertdialog", () => {
    // The body carries a scrollable file list, three checkboxes and a text
    // input. WAI-ARIA APG reserves `alertdialog` for brief text-only messages,
    // and AppDialog picks the role off this flag.
    const worktree = makeWorktree(makeChanges([{ path: "/wt/a.ts", status: "modified" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.getByTestId("delete-worktree-dialog").dataset.hasPreview).toBe("true");
  });

  it("routes the footer through structured actions so Cancel carries the focus marker", () => {
    // Initial focus for a destructive dialog resolves against
    // [data-confirm-role="cancel"]; a hand-written footer has no marker, so
    // focus fell through to the first tabbable control — the force checkbox.
    const worktree = makeWorktree(makeChanges([]));
    const { container } = render(
      <WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />
    );

    expect(container.querySelector('[data-confirm-role="cancel"]')).not.toBeNull();
    expect(container.querySelector('[data-confirm-role="confirm"]')).not.toBeNull();
  });

  it("gives the dialog a short static description for aria-describedby", () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const description = screen.getByTestId("delete-worktree-description");
    expect(description.textContent?.length).toBeGreaterThan(0);
    // Static: it must not restate the dynamic consequence list.
    expect(description.textContent).not.toMatch(/will be closed|permanently lost/);
  });

  it("keeps the primary label free of the branch name at every tier", () => {
    // Interpolating an untruncated branch overflowed the footer and pushed
    // Cancel out of the dialog entirely.
    const longBranch = "feature/" + "x".repeat(120);
    const worktree = makeWorktree(makeChanges([{ path: "/wt/a.ts", status: "modified" }]), {
      branch: longBranch,
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const confirm = screen.getByTestId("delete-worktree-confirm");
    expect(confirm.textContent).toBe("Delete worktree");
    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    expect(screen.getByTestId("delete-worktree-confirm").textContent).toBe("Force delete worktree");
  });

  it("keeps the force toggle label invariant across states", () => {
    // House microcopy rule: a toggle label never changes with state.
    const clean = makeWorktree(makeChanges([]));
    const { unmount } = render(
      <WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={clean} />
    );
    const cleanLabel = screen.getByRole("checkbox", { name: /force delete/i });
    expect(cleanLabel).toBeDefined();
    unmount();

    const dirty = makeWorktree(
      makeChanges([
        { path: "/wt/a.ts", status: "modified" },
        { path: "/wt/n.txt", status: "untracked" },
      ])
    );
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={dirty} />);
    expect(screen.getByRole("checkbox", { name: /force delete/i })).toBeDefined();
  });
});

describe("WorktreeDeleteDialog — medium tier (no name confirmation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
    terminalsMock.length = 0;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    // Default: no fresh override → dialog uses the prop seed (existing tests).
    buildPreviewMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("non-protected branch + force with only untracked files does not require name confirmation", () => {
    const worktree = makeWorktree(makeChanges([{ path: "new.txt", status: "untracked" }]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Force delete worktree");
  });

  it("starts a delete on click and dismisses immediately", () => {
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    const button = screen.getByTestId("delete-worktree-confirm");
    fireEvent.click(button);

    expect(startDeleteMock).toHaveBeenCalledTimes(1);
    expect(startDeleteMock).toHaveBeenCalledWith("wt-1", { force: false, deleteBranch: false });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("forwards closeTerminals when terminals are associated", () => {
    terminalCountsMock.total = 2;
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByTestId("delete-worktree-confirm"));

    expect(startDeleteMock).toHaveBeenCalledWith("wt-1", {
      force: false,
      deleteBranch: false,
      closeTerminals: true,
    });
  });
});

describe("WorktreeDeleteDialog — high tier (name confirmation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
    terminalsMock.length = 0;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    // Default: no fresh override → dialog uses the prop seed (existing tests).
    buildPreviewMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders type-to-confirm input when force-deleting a protected branch", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.getByTestId("delete-worktree-confirm-input")).toBeDefined();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    // The label is a stable verb-noun; the target is named by the gate, not the
    // button, because interpolating it here overflowed the footer (#11977).
    expect(button.textContent).toBe("Force delete worktree");
    expect(screen.getByLabelText("Type main to confirm")).toBeDefined();
    expect(button.disabled).toBe(true);
  });

  it("renders type-to-confirm input when force-deleting with uncommitted tracked changes", () => {
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]), {
      branch: "feature/x",
      name: "feature/x",
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    expect(screen.getByTestId("delete-worktree-confirm-input")).toBeDefined();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "feature/x" } });
    expect(button.disabled).toBe(false);
  });

  it("renders type-to-confirm input when force-deleting the main worktree", () => {
    const worktree = makeWorktree(makeChanges([]), {
      branch: "feature/x",
      name: "feature/x",
      isMainWorktree: true,
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    expect(screen.getByTestId("delete-worktree-confirm-input")).toBeDefined();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("enables the destructive button only when the typed name matches exactly", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "mai" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "Main" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "main" } });
    expect(button.disabled).toBe(false);
  });

  it("falls back to worktree.name when branch is the empty string", () => {
    const worktree = makeWorktree(makeChanges([]), {
      branch: "",
      name: "abc1234",
      isMainWorktree: true,
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.textContent).toBe("Force delete worktree");
    expect(screen.getByLabelText("Type abc1234 to confirm")).toBeDefined();
    expect(button.disabled).toBe(true);

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc1234" } });
    expect(button.disabled).toBe(false);
  });

  it("uses worktree.name as the confirmation target for detached HEAD", () => {
    const worktree = makeWorktree(makeChanges([]), {
      branch: undefined,
      name: "abc1234",
      isMainWorktree: true,
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.textContent).toBe("Force delete worktree");
    expect(screen.getByLabelText("Type abc1234 to confirm")).toBeDefined();

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc1234" } });
    expect(button.disabled).toBe(false);
  });

  it("clears typed name and reverts to medium tier when force is unchecked", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const forceCheckbox = screen.getByRole("checkbox", { name: /force delete/i });
    fireEvent.click(forceCheckbox);

    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "main" } });
    expect(input.value).toBe("main");

    fireEvent.click(forceCheckbox);

    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.textContent).toBe("Delete worktree");
    expect(button.disabled).toBe(false);
  });

  it("submits on Enter when name is matched", async () => {
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "main" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(startDeleteMock).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not submit on Enter when name is unmatched", () => {
    const worktree = makeWorktree(makeChanges([]), { branch: "main", name: "main" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    const input = screen.getByTestId("delete-worktree-confirm-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mai" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(startDeleteMock).not.toHaveBeenCalled();
  });
});

describe("WorktreeDeleteDialog — immediate dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
    terminalsMock.length = 0;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    // Default: no fresh override → dialog uses the prop seed (existing tests).
    buildPreviewMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render any in-modal skeleton after submit (progress surfaces on the card — #8417)", () => {
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    fireEvent.click(screen.getByTestId("delete-worktree-confirm"));

    expect(screen.queryByTestId("delete-worktree-skeleton")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never blocks dismissal — Cancel always closes (no isDeleting guard)", () => {
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("WorktreeDeleteDialog — dev preview disclosure (#9084)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
    terminalsMock.length = 0;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    // Default: no fresh override → dialog uses the prop seed (existing tests).
    buildPreviewMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the dev server row inactive when no session is running", async () => {
    devPreviewGetByWorktreeMock.mockResolvedValueOnce(null);
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    await waitFor(() => {
      expect(devPreviewGetByWorktreeMock).toHaveBeenCalledWith({ worktreeId: "wt-1" });
    });
    expect(screen.queryByText("Dev server will be stopped")).toBeNull();
  });

  it("activates the dev server row when a running session is detected", async () => {
    devPreviewGetByWorktreeMock.mockResolvedValueOnce({
      panelId: "panel-1",
      projectId: "project-1",
      worktreeId: "wt-1",
      status: "running",
      url: "http://localhost:5173",
      predictedUrl: null,
      error: null,
      terminalId: "t-1",
      isRestarting: false,
      generation: 1,
      updatedAt: Date.now(),
    });
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    await waitFor(() => {
      expect(screen.getByText("Dev server will be stopped")).toBeDefined();
    });
  });

  it("treats a stopped session as inactive", async () => {
    devPreviewGetByWorktreeMock.mockResolvedValueOnce({
      panelId: "panel-1",
      projectId: "project-1",
      worktreeId: "wt-1",
      status: "stopped",
      url: null,
      predictedUrl: null,
      error: null,
      terminalId: null,
      isRestarting: false,
      generation: 1,
      updatedAt: Date.now(),
    });
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    await waitFor(() => {
      expect(devPreviewGetByWorktreeMock).toHaveBeenCalled();
    });
    expect(screen.queryByText("Dev server will be stopped")).toBeNull();
  });
});

describe("WorktreeDeleteDialog — state reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
    terminalsMock.length = 0;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    // Default: no fresh override → dialog uses the prop seed (existing tests).
    buildPreviewMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("resets closeTerminals to true when the dialog re-opens", () => {
    terminalCountsMock.total = 2;
    const worktree = makeWorktree(makeChanges([]));
    const { rerender } = render(
      <WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />
    );

    const closeTerminalsCheckbox = screen.getByRole("checkbox", {
      name: /close all terminals/i,
    }) as HTMLInputElement;
    expect(closeTerminalsCheckbox.checked).toBe(true);
    fireEvent.click(closeTerminalsCheckbox);
    expect(closeTerminalsCheckbox.checked).toBe(false);

    rerender(<WorktreeDeleteDialog isOpen={false} onClose={vi.fn()} worktree={worktree} />);
    rerender(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    const reopened = screen.getByRole("checkbox", {
      name: /close all terminals/i,
    }) as HTMLInputElement;
    expect(reopened.checked).toBe(true);
  });
});

describe("WorktreeDeleteDialog — fresh status verification (#11343)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalCountsMock.total = 0;
    terminalsMock.length = 0;
    devPreviewGetByWorktreeMock.mockResolvedValue(null);
    buildPreviewMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it("fetches fresh worktree changes when the dialog opens", async () => {
    const worktree = makeWorktree(makeChanges([]));
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    await waitFor(() => {
      expect(buildPreviewMock).toHaveBeenCalledWith("wt-1");
    });
  });

  it("escalates to the D3 typed-name gate when fresh status reveals tracked changes the prop missed", async () => {
    // Prop snapshot is stale-empty (the backgrounded-worktree bug); the fresh
    // fetch reveals an agent's in-progress tracked edits.
    buildPreviewMock.mockResolvedValue(makePreview([{ path: "src/app.ts", status: "modified" }]));
    const worktree = makeWorktree(makeChanges([]), { branch: "feature/x", name: "feature/x" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    await waitFor(() => {
      expect(screen.getByTestId("delete-worktree-confirm-input")).toBeDefined();
    });
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("fails closed with an escalation and a warning when the fresh fetch errors", async () => {
    buildPreviewMock.mockRejectedValue(new Error("refresh timeout"));
    const worktree = makeWorktree(makeChanges([]), { branch: "feature/x", name: "feature/x" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    // The "couldn't verify" banner surfaces regardless of force.
    await waitFor(() => {
      expect(screen.getByText(/Couldn't check this worktree for uncommitted work/)).toBeDefined();
    });

    // With force on, the fail-closed state demands the typed-name gate.
    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    expect(screen.getByTestId("delete-worktree-confirm-input")).toBeDefined();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("blocks a force-delete at submit time when files changed after open", async () => {
    // Open sees a clean tree (D2, no gate); an agent writes a tracked file
    // before the user clicks — the submit-time re-check must catch it.
    buildPreviewMock.mockResolvedValueOnce(makePreview([]));
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]), { branch: "feature/x", name: "feature/x" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    await waitFor(() => {
      expect(buildPreviewMock).toHaveBeenCalledTimes(1);
    });
    // Clean at open → no typed-name gate, button enabled.
    expect(screen.queryByTestId("delete-worktree-confirm-input")).toBeNull();
    const button = screen.getByTestId("delete-worktree-confirm") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    // Now a tracked change appears; submit must revalidate and refuse.
    buildPreviewMock.mockResolvedValueOnce(
      makePreview([{ path: "src/app.ts", status: "modified" }])
    );
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByTestId("delete-worktree-confirm-input")).toBeDefined();
    });
    expect(startDeleteMock).not.toHaveBeenCalled();
  });

  it("shows the actual fresh file list a force delete would discard (D2 content preview)", async () => {
    buildPreviewMock.mockResolvedValue(
      makePreview([
        { path: "src/app.ts", status: "modified" },
        { path: "new.txt", status: "untracked" },
      ])
    );
    const worktree = makeWorktree(makeChanges([]), { branch: "feature/x", name: "feature/x" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    // No list until the destructive path is armed.
    expect(screen.queryByTestId("delete-worktree-file-list")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    await waitFor(() => {
      const list = screen.getByTestId("delete-worktree-file-list");
      expect(list.textContent).toContain("M src/app.ts");
      expect(list.textContent).toContain("? new.txt");
    });
  });

  it("hides the file list and shows the warning when verification fails", async () => {
    buildPreviewMock.mockRejectedValue(new Error("refresh timeout"));
    const worktree = makeWorktree(makeChanges([{ path: "src/app.ts", status: "modified" }]), {
      branch: "feature/x",
      name: "feature/x",
    });
    render(<WorktreeDeleteDialog isOpen={true} onClose={vi.fn()} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));

    await waitFor(() => {
      expect(screen.getByText(/Couldn't check this worktree for uncommitted work/)).toBeDefined();
    });
    expect(screen.queryByTestId("delete-worktree-file-list")).toBeNull();
  });

  it("dispatches a force-delete after submit re-check confirms it is still safe", async () => {
    // Untracked-only stays D2 both at open and submit → no gate, delete runs.
    buildPreviewMock.mockResolvedValue(makePreview([{ path: "new.txt", status: "untracked" }]));
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]), { branch: "feature/x", name: "feature/x" });
    render(<WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    await waitFor(() => {
      expect(buildPreviewMock).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByTestId("delete-worktree-confirm"));

    await waitFor(() => {
      expect(startDeleteMock).toHaveBeenCalledTimes(1);
    });
    expect(startDeleteMock).toHaveBeenCalledWith("wt-1", { force: true, deleteBranch: false });
    expect(onClose).toHaveBeenCalled();
  });

  it("still dispatches a force-delete under StrictMode (mountedRef remount guard)", async () => {
    // StrictMode runs mount effects setup→cleanup→setup; a mounted flag that
    // only cleared would be false after remount and abort every force-delete.
    buildPreviewMock.mockResolvedValue(makePreview([{ path: "new.txt", status: "untracked" }]));
    const onClose = vi.fn();
    const worktree = makeWorktree(makeChanges([]), { branch: "feature/x", name: "feature/x" });
    render(
      <StrictMode>
        <WorktreeDeleteDialog isOpen={true} onClose={onClose} worktree={worktree} />
      </StrictMode>
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /force delete/i }));
    await waitFor(() => {
      expect(buildPreviewMock).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByTestId("delete-worktree-confirm"));

    await waitFor(() => {
      expect(startDeleteMock).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalled();
  });
});
