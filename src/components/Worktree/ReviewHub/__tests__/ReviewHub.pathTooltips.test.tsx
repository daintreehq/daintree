/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import type { StagingFileEntry, StagingStatus } from "@shared/types";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";

// The real TruncatedTooltip runs; only Radix is replaced, so a tooltip's content
// is in the DOM exactly when TruncatedTooltip decides the text is cut.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, children }: { isOpen: boolean; children?: ReactNode }) =>
    isOpen ? <div data-testid="confirm-dialog">{children}</div> : null,
}));

import { FileStageRow } from "../FileStageRow";
import { BaseBranchFileRow } from "../BaseBranchFileRow";
import { ConflictPanel } from "../ConflictPanel";
import { CommitPanel } from "../CommitPanel";

// jsdom lays nothing out, so `cut` decides which boxes overflow in a test. In a
// browser only a box that clips its own text (`truncate`, which PathTail and the
// name spans carry) reports more scroll width than client width; the flex
// wrappers around them shrink their children instead and never overflow.
let cut: (el: HTMLElement) => boolean = () => false;
const clips = (el: HTMLElement) => el.classList.contains("truncate");
const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");
const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

function restore(name: "scrollWidth" | "clientWidth", original?: PropertyDescriptor) {
  if (original) Object.defineProperty(HTMLElement.prototype, name, original);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return cut(this) ? 240 : 120;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 120,
  });
});

afterAll(() => {
  restore("scrollWidth", originalScrollWidth);
  restore("clientWidth", originalClientWidth);
});

afterEach(() => {
  cleanup();
  cut = () => false;
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as unknown as Record<string, unknown>).electron;
});

function cutText(...texts: string[]) {
  cut = (el) => clips(el) && texts.includes(el.textContent ?? "");
}

function tooltips(): string[] {
  return screen.queryAllByTestId("tooltip-content").map((el) => el.textContent ?? "");
}

const DIR = "src/components/Worktree/ReviewHub";
const PATH = `${DIR}/FileStageRow.tsx`;

describe("FileStageRow path tooltip", () => {
  const file: StagingFileEntry = { path: PATH, status: "modified", insertions: 1, deletions: 0 };

  function renderRow(entry: StagingFileEntry = file) {
    return render(
      <FileStageRow
        file={entry}
        section="unstaged"
        isStaged={false}
        isSelected={false}
        rowIndex={0}
        onToggle={vi.fn()}
        onRowClick={vi.fn()}
      />
    );
  }

  it("opens on the full path when the directory is cut", () => {
    cutText(`${DIR}/`);
    renderRow();
    expect(tooltips()).toContain(PATH);
  });

  it("opens on the full path when only the file name is cut", () => {
    cutText("FileStageRow.tsx");
    renderRow();
    expect(tooltips()).toContain(PATH);
  });

  it("stays shut while the path fits", () => {
    renderRow();
    expect(tooltips()).not.toContain(PATH);
  });

  it("opens for a cut file at the repository root, which has no directory part", () => {
    cutText("a-file-name-long-enough-to-be-cut.config.ts");
    renderRow({ ...file, path: "a-file-name-long-enough-to-be-cut.config.ts" });
    expect(tooltips()).toContain("a-file-name-long-enough-to-be-cut.config.ts");
  });

  it("keeps a cut row's name button out of the tab order, which the listbox owns", () => {
    cutText(`${DIR}/`);
    const { container } = renderRow();
    const name = container.querySelector<HTMLButtonElement>(
      `button[aria-label="View diff: ${PATH}"]`
    );
    expect(name?.tabIndex).toBe(-1);
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
  });
});

describe("BaseBranchFileRow path tooltip", () => {
  const file: CrossWorktreeFile = { path: PATH, status: "M", insertions: 2, deletions: 1 };

  function renderRow() {
    return render(<BaseBranchFileRow file={file} rowIndex={0} onClick={vi.fn()} />);
  }

  it("opens on the full path when the directory is cut", () => {
    cutText(`${DIR}/`);
    renderRow();
    expect(tooltips()).toEqual([PATH]);
  });

  it("opens on the full path when only the file name is cut", () => {
    cutText("FileStageRow.tsx");
    renderRow();
    expect(tooltips()).toEqual([PATH]);
  });

  it("stays shut while the path fits", () => {
    renderRow();
    expect(tooltips()).toEqual([]);
  });

  it("adds no tab stop beside the row's own buttons", () => {
    cutText(`${DIR}/`);
    const { container } = renderRow();
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
  });
});

describe("ConflictPanel path tooltips", () => {
  const CONFLICTED = `${DIR}/ConflictPanel.tsx`;
  const RESOLVED = `${DIR}/CommitPanel.tsx`;

  function renderPanel() {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { git: { scanConflictMarkers: vi.fn().mockResolvedValue([]) } },
    });
    const status: StagingStatus = {
      staged: [{ path: RESOLVED, status: "modified", insertions: 1, deletions: 0 }],
      unstaged: [],
      conflicted: [CONFLICTED],
      conflictedFiles: [{ path: CONFLICTED, xy: "UU", label: "both modified" }],
      resolveUndoPaths: [RESOLVED],
      isDetachedHead: false,
      currentBranch: "feature/x",
      hasRemote: true,
      pushDestination: null,
      pullSource: null,
      repoState: "MERGING",
      repoOperationId: null,
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    };
    const result = render(
      <ConflictPanel
        status={status}
        worktreePath="/repo/wt"
        onMarkResolved={vi.fn()}
        onOpenInEditor={vi.fn()}
        onCheckoutOursTheirs={vi.fn()}
        onAbort={vi.fn().mockResolvedValue(undefined)}
        onContinue={vi.fn().mockResolvedValue(undefined)}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Resolved/ }));
    return result;
  }

  it("names the conflicted file and its kind when the directory is cut", () => {
    cutText(`${DIR}/`);
    renderPanel();
    expect(tooltips()).toContain(`${CONFLICTED} (both modified)`);
    expect(tooltips()).toContain(RESOLVED);
  });

  it("names the file when only its name is cut", () => {
    cutText("ConflictPanel.tsx", "CommitPanel.tsx");
    renderPanel();
    expect(tooltips()).toContain(`${CONFLICTED} (both modified)`);
    expect(tooltips()).toContain(RESOLVED);
  });

  it("stays shut while the paths fit", () => {
    renderPanel();
    expect(tooltips()).not.toContain(`${CONFLICTED} (both modified)`);
    expect(tooltips()).not.toContain(RESOLVED);
  });

  it("adds no tab stop to a cut path", () => {
    cutText(`${DIR}/`);
    renderPanel();
    for (const name of ["Conflicted files", "Resolved files"]) {
      const list = screen.getByRole("list", { name });
      expect(list.querySelector('[tabindex="0"]')).toBeNull();
    }
  });
});

describe("CommitPanel", () => {
  function renderPanel(overrides: Partial<ComponentProps<typeof CommitPanel>> = {}) {
    const props: ComponentProps<typeof CommitPanel> = {
      stagedCount: 2,
      isDetachedHead: false,
      hasConflicts: false,
      hasRemote: true,
      pushDestination: { remote: "origin", branch: "feature/a-very-long-branch-name" },
      worktreePath: "/repo/wt",
      currentBranch: "feature/a-very-long-branch-name",
      commitMessage: "fix: bug",
      onCommitMessageChange: vi.fn(),
      onCommit: vi.fn().mockResolvedValue(undefined),
      onCommitAndPush: vi.fn().mockResolvedValue(undefined),
      onCommitThenReviewPush: vi.fn().mockResolvedValue(undefined),
      isPushing: false,
      pushProgress: new Map(),
      pushTargetBranch: null,
      skipPushConfirm: false,
      onSetSkipPushConfirm: vi.fn(),
      stagedPaths: [PATH, "README.md"],
      ...overrides,
    } as ComponentProps<typeof CommitPanel>;
    return render(<CommitPanel {...props} />);
  }

  function statusLineCut(el: HTMLElement) {
    return clips(el) && el.textContent?.includes("pushes to") === true;
  }

  function statusTooltips(): string[] {
    return within(screen.getByTestId("review-hub-commit-status"))
      .queryAllByTestId("tooltip-content")
      .map((el) => el.textContent ?? "");
  }

  it("draws no native title on the status line", () => {
    cut = statusLineCut;
    const { container } = renderPanel();
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("discloses a cut push destination in a tooltip", () => {
    cut = statusLineCut;
    renderPanel();
    expect(statusTooltips()).toEqual([
      "2 files staged · pushes to origin/feature/a-very-long-branch-name",
    ]);
  });

  it("shows no tooltip while the status line fits", () => {
    renderPanel();
    expect(statusTooltips()).toEqual([]);
  });

  it("discloses a cut destination while pushing", () => {
    cut = (el) => clips(el) && el.textContent?.startsWith("Pushing to") === true;
    renderPanel({ isPushing: true, pushTargetBranch: "origin/feature/a-very-long-branch-name" });
    expect(statusTooltips()).toEqual(["Pushing to origin/feature/a-very-long-branch-name"]);
  });

  it("adds no tab stop for a cut destination", () => {
    cut = statusLineCut;
    renderPanel();
    expect(screen.getByTestId("review-hub-commit-status").querySelector("[tabindex]")).toBeNull();
  });

  // Every box overflows here, so only the missing tooltip text keeps these shut.
  it("offers no tooltip for a blocker", () => {
    cut = () => true;
    renderPanel({ commitMessage: "" });
    expect(screen.getByTestId("review-hub-commit-status").textContent).toContain(
      "Write a commit message"
    );
    expect(statusTooltips()).toEqual([]);
  });

  it("offers no tooltip for a line with no destination to name", () => {
    cut = () => true;
    renderPanel({ pushDestination: null });
    expect(screen.getByTestId("review-hub-commit-status").textContent).toContain(
      "no push destination"
    );
    expect(statusTooltips()).toEqual([]);
  });

  describe("push confirm file list", () => {
    function openConfirm() {
      fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
      return screen.getByTestId("commit-panel-push-confirm-files");
    }

    it("draws no native title on its rows", () => {
      cutText(`${DIR}/`);
      renderPanel();
      expect(openConfirm().querySelector("[title]")).toBeNull();
    });

    it("discloses a cut path in a tooltip, and only that one", () => {
      cutText(`${DIR}/`);
      renderPanel();
      openConfirm();
      expect(tooltips()).toContain(PATH);
      expect(tooltips()).not.toContain("README.md");
    });

    it("discloses a path whose file name alone is cut, at the root too", () => {
      const root = "a-root-file-name-long-enough-to-be-cut.config.ts";
      cutText("FileStageRow.tsx", root);
      renderPanel({ stagedPaths: [PATH, "README.md", root] });
      openConfirm();
      expect(tooltips()).toContain(PATH);
      expect(tooltips()).toContain(root);
      expect(tooltips()).not.toContain("README.md");
    });

    it("adds no tab stop to a row inside the scrolling list", () => {
      cutText(`${DIR}/`);
      renderPanel();
      const list = openConfirm();
      expect(list.querySelector('[tabindex="0"]')).toBeNull();
    });
  });
});
