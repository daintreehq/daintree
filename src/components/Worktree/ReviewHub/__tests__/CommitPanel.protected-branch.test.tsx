/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { GitPushCommitPreview } from "@shared/types/git";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("@/components/ui/Spinner", () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    "aria-disabled": ariaDisabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    "aria-disabled"?: boolean;
  }) => (
    <button type="button" onClick={onClick} aria-disabled={ariaDisabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The handler the panel last handed the dialog, so a test can drive it past the
// disabled button the way the real dialog's Enter key path could.
const confirmDialogProps = vi.hoisted(() => ({ onConfirm: null as (() => void) | null }));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    description,
    children,
    onConfirm,
    onClose,
    confirmLabel,
    confirmDisabled,
    hint,
  }: {
    isOpen: boolean;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    onConfirm: () => void;
    onClose?: () => void;
    confirmLabel: string;
    confirmDisabled?: boolean;
    hint?: ReactNode;
  }) => {
    if (!isOpen) return null;
    confirmDialogProps.onConfirm = onConfirm;
    return (
      <div role="alertdialog" data-testid="push-confirm-dialog">
        <div data-testid="confirm-title">{title}</div>
        {description && <div data-testid="confirm-description">{description}</div>}
        {children && <div data-testid="confirm-body">{children}</div>}
        {/* Honours confirmDisabled: a double that always fires onConfirm would
            make every gating assertion vacuous. */}
        <button
          type="button"
          aria-disabled={confirmDisabled || undefined}
          onClick={confirmDisabled ? undefined : onConfirm}
        >
          {confirmLabel}
        </button>
        {hint && <div data-testid="confirm-hint">{hint}</div>}
        {onClose && (
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
    );
  },
}));

import { CommitPanel } from "../CommitPanel";

interface RenderProps {
  currentBranch?: string | null;
  hasRemote?: boolean;
  pushDestination?: { remote: string; branch: string } | null;
  commitMessage?: string;
  skipPushConfirm?: boolean;
  onCommitAndPush?: (message: string) => Promise<void>;
  onSetSkipPushConfirm?: (value: boolean) => void;
}

function renderPanel(overrides: RenderProps = {}) {
  const onCommitAndPush = overrides.onCommitAndPush ?? vi.fn().mockResolvedValue(undefined);
  const onSetSkipPushConfirm = overrides.onSetSkipPushConfirm ?? vi.fn();
  // Use `in` so callers can explicitly pass `currentBranch: null` to test the
  // missing-branch path — `??` would coalesce null to the default.
  const currentBranch =
    "currentBranch" in overrides ? (overrides.currentBranch ?? null) : "feature/x";
  const panel = (commitMessage: string) => (
    <CommitPanel
      stagedCount={1}
      isDetachedHead={false}
      hasConflicts={false}
      hasRemote={overrides.hasRemote ?? true}
      pushDestination={
        "pushDestination" in overrides
          ? (overrides.pushDestination ?? null)
          : currentBranch === null
            ? null
            : { remote: "origin", branch: currentBranch }
      }
      worktreePath="/repo"
      currentBranch={currentBranch}
      commitMessage={commitMessage}
      onCommitMessageChange={vi.fn()}
      onCommit={vi.fn().mockResolvedValue(undefined)}
      onCommitAndPush={onCommitAndPush}
      isPushing={false}
      pushProgress={new Map()}
      pushTargetBranch={null}
      skipPushConfirm={overrides.skipPushConfirm ?? false}
      onSetSkipPushConfirm={onSetSkipPushConfirm}
    />
  );
  const { rerender } = render(panel(overrides.commitMessage ?? "fix: bug"));
  return {
    onCommitAndPush,
    onSetSkipPushConfirm,
    setCommitMessage: (message: string) => rerender(panel(message)),
  };
}

function pushPreview(overrides: Partial<GitPushCommitPreview> = {}): GitPushCommitPreview {
  return {
    destination: { remote: "origin", branch: "feature/x" },
    rangeBasis: "tracked",
    commits: [],
    total: 0,
    behind: 0,
    ...overrides,
  };
}

function earlierCommits(count: number): GitPushCommitPreview["commits"] {
  return Array.from({ length: count }, (_, i) => ({
    hash: `${i + 1}`.padStart(40, "a"),
    date: "2026-10-01T00:00:00Z",
    message: `feat: earlier ${i + 1}`,
    author: "Dev",
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const listPushCommits = vi.fn();

function confirmButton(name: RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

async function confirmWhenReady(name: RegExp): Promise<void> {
  const button = confirmButton(name);
  await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
  // The push settles after the click; its state updates belong inside act too.
  await act(async () => {
    fireEvent.click(button);
  });
}

// The read starts in a microtask after the effect, so a call count asserted
// straight after a render can't yet see it.
async function flushReadStart(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  confirmDialogProps.onConfirm = null;
  // Echoes the local branch as the destination, which is what `renderPanel`
  // resolves by default.
  listPushCommits
    .mockReset()
    .mockImplementation((_cwd: string, branch: string) =>
      Promise.resolve(pushPreview({ destination: { remote: "origin", branch } }))
    );
  Object.defineProperty(window, "electron", {
    value: {
      git: { listCommits: vi.fn().mockResolvedValue({ items: [] }), listPushCommits },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommitPanel — push confirm", () => {
  it("on a feature branch, opens the ConfirmDialog instead of pushing immediately", () => {
    const { onCommitAndPush } = renderPanel({ currentBranch: "feature/x" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(onCommitAndPush).not.toHaveBeenCalled();
    expect(screen.getByTestId("push-confirm-dialog")).toBeDefined();
  });

  it("confirming the dialog calls onCommitAndPush", async () => {
    const { onCommitAndPush } = renderPanel({ currentBranch: "develop" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(onCommitAndPush).not.toHaveBeenCalled();

    await confirmWhenReady(/Push to origin\/develop/);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("cancelling the dialog does not call onCommitAndPush", () => {
    const { onCommitAndPush } = renderPanel({ currentBranch: "main" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCommitAndPush).not.toHaveBeenCalled();
    expect(screen.queryByTestId("push-confirm-dialog")).toBeNull();
  });

  it("shows the commit message preview inside the confirm dialog body", () => {
    renderPanel({ currentBranch: "main", commitMessage: "chore: bump deps\n\nBody line" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    const message = screen.getByTestId("commit-panel-push-confirm-message");
    expect(message.textContent).toContain("chore: bump deps");
    expect(message.textContent).toContain("Body line");
  });

  // The parent clears the composer the moment the commit lands, which can be
  // while the closing dialog is still fading out over it (#15007).
  it("keeps its preview when the composer behind it clears", () => {
    const { setCommitMessage } = renderPanel({ currentBranch: "main", commitMessage: "feat: x" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    setCommitMessage("");
    expect(screen.getByTestId("commit-panel-push-confirm-message").textContent).toBe("feat: x");
  });

  it("pushes the message it previewed, not one that replaced it behind the dialog", async () => {
    const { onCommitAndPush, setCommitMessage } = renderPanel({
      currentBranch: "develop",
      commitMessage: "feat: previewed",
    });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    // A history recall that resolves after the dialog opened.
    setCommitMessage("feat: recalled late");
    await confirmWhenReady(/Push to origin\/develop/);
    expect(onCommitAndPush).toHaveBeenCalledWith("feat: previewed");
  });

  it("warns about protected branches in the description copy", () => {
    renderPanel({ currentBranch: "main" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    const description = screen.getByTestId("confirm-description");
    expect(description.textContent).toContain("protected branch");
  });

  it("uses a simpler description for non-protected branches", () => {
    renderPanel({ currentBranch: "feature/x" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    const description = screen.getByTestId("confirm-description");
    expect(description.textContent).not.toContain("protected branch");
    expect(description.textContent).toContain("Review the commit before pushing");
  });

  it("when skipPushConfirm is true, pushes directly without opening the dialog", () => {
    const { onCommitAndPush, onSetSkipPushConfirm } = renderPanel({
      currentBranch: "feature/x",
      skipPushConfirm: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
    expect(screen.queryByTestId("push-confirm-dialog")).toBeNull();
    expect(onSetSkipPushConfirm).not.toHaveBeenCalled();
  });

  it("confirming with the 'don't ask again' checkbox checked calls onSetSkipPushConfirm(true)", async () => {
    const { onCommitAndPush, onSetSkipPushConfirm } = renderPanel({ currentBranch: "feature/x" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    const checkbox = screen.getByTestId("commit-panel-push-confirm-dont-ask");
    fireEvent.click(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await confirmWhenReady(/Push to origin\/feature\/x/);
    expect(onSetSkipPushConfirm).toHaveBeenCalledWith(true);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("confirming without checking the box calls onSetSkipPushConfirm(false)", async () => {
    const { onSetSkipPushConfirm } = renderPanel({ currentBranch: "feature/x" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    await confirmWhenReady(/Push to origin\/feature\/x/);
    expect(onSetSkipPushConfirm).toHaveBeenCalledWith(false);
  });

  it("cancelling after checking the box does NOT call onSetSkipPushConfirm", () => {
    const { onSetSkipPushConfirm } = renderPanel({ currentBranch: "feature/x" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    fireEvent.click(screen.getByTestId("commit-panel-push-confirm-dont-ask"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSetSkipPushConfirm).not.toHaveBeenCalled();
  });

  it("resets the 'don't ask again' checkbox after the dialog closes via cancel", () => {
    renderPanel({ currentBranch: "feature/x" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    fireEvent.click(screen.getByTestId("commit-panel-push-confirm-dont-ask"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    const checkbox = screen.getByTestId("commit-panel-push-confirm-dont-ask");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  });

  it("normalizes mixed-case protected branch names ('Main', 'DEVELOP') for the warning copy", () => {
    renderPanel({ currentBranch: "Main" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(screen.getByTestId("confirm-description").textContent).toContain("protected branch");
    cleanup();

    renderPanel({ currentBranch: "DEVELOP" });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(screen.getByTestId("confirm-description").textContent).toContain("protected branch");
  });

  it("with hasRemote=false, does not open the dialog (no push to confirm)", () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const onCommitAndPush = vi.fn().mockResolvedValue(undefined);
    render(
      <CommitPanel
        stagedCount={1}
        isDetachedHead={false}
        hasConflicts={false}
        hasRemote={false}
        pushDestination={null}
        worktreePath="/repo"
        currentBranch="feature/x"
        commitMessage="fix: bug"
        onCommitMessageChange={vi.fn()}
        onCommit={onCommit}
        onCommitAndPush={onCommitAndPush}
        isPushing={false}
        pushProgress={new Map()}
        pushTargetBranch={null}
        skipPushConfirm={false}
        onSetSkipPushConfirm={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Commit$/ }));
    expect(onCommit).toHaveBeenCalledWith("fix: bug");
    expect(onCommitAndPush).not.toHaveBeenCalled();
    expect(screen.queryByTestId("push-confirm-dialog")).toBeNull();
  });

  it("Cmd+Enter on the textarea routes through the confirm gate", () => {
    const { onCommitAndPush } = renderPanel({ currentBranch: "feature/x" });
    const textarea = screen.getByLabelText("Commit message");
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onCommitAndPush).not.toHaveBeenCalled();
    expect(screen.getByTestId("push-confirm-dialog")).toBeDefined();
  });

  // The earlier-commit range is read by local branch name, so with none there
  // is nothing to show the approver and the push stays unapprovable.
  it("with currentBranch=null but a resolved destination, keeps the confirm blocked", async () => {
    const { onCommitAndPush } = renderPanel({
      currentBranch: null,
      pushDestination: { remote: "origin", branch: "main" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(screen.getByTestId("push-confirm-dialog")).toBeDefined();
    await flushReadStart();
    const confirm = confirmButton(/Push to origin\/main/);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("confirm-hint").textContent).toBe("Check out a branch to continue");
    fireEvent.click(confirm);
    expect(listPushCommits).not.toHaveBeenCalled();
    expect(onCommitAndPush).not.toHaveBeenCalled();
  });

  it("persists the opt-out even when the push call rejects", async () => {
    const onCommitAndPush = vi.fn().mockRejectedValue(new Error("network"));
    const { onSetSkipPushConfirm } = renderPanel({
      currentBranch: "feature/x",
      onCommitAndPush,
    });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    fireEvent.click(screen.getByTestId("commit-panel-push-confirm-dont-ask"));
    await confirmWhenReady(/Push to origin\/feature\/x/);
    expect(onSetSkipPushConfirm).toHaveBeenCalledWith(true);
    // The push attempt itself was made.
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });
});

describe("CommitPanel — unresolved push destination (#11746)", () => {
  it("names the resolved destination rather than the local branch", () => {
    renderPanel({
      currentBranch: "topic",
      pushDestination: { remote: "fork", branch: "release/topic" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(screen.getByTestId("commit-panel-push-confirm-branch").textContent).toBe(
      "fork/release/topic"
    );
  });

  it("blocks the push confirm when no destination resolved", () => {
    const onCommitAndPush = vi.fn().mockResolvedValue(undefined);
    renderPanel({ currentBranch: "topic", pushDestination: null, onCommitAndPush });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));

    expect(screen.getByTestId("commit-panel-push-no-destination")).toBeDefined();
    expect(screen.getByTestId("confirm-hint").textContent).toBe("Set a destination to continue");
    fireEvent.click(screen.getByRole("button", { name: /Push to topic/ }));
    expect(onCommitAndPush).not.toHaveBeenCalled();
  });

  it("overrides the confirm opt-out when no destination resolved", () => {
    // The opt-out must not turn a push that will certainly be refused into a
    // silent failure with no explanation.
    const onCommitAndPush = vi.fn().mockResolvedValue(undefined);
    renderPanel({
      currentBranch: "topic",
      pushDestination: null,
      skipPushConfirm: true,
      onCommitAndPush,
    });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));

    expect(screen.getByTestId("commit-panel-push-no-destination")).toBeDefined();
    expect(onCommitAndPush).not.toHaveBeenCalled();
  });
});

describe("CommitPanel — earlier commits in the push (#15557)", () => {
  const CONFIRM = /Push to origin\/feature\/x/;

  function openConfirm(overrides: RenderProps = {}) {
    const rendered = renderPanel({ currentBranch: "feature/x", ...overrides });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    return rendered;
  }

  interface Identity {
    worktreePath: string;
    currentBranch: string;
    destination: { remote: string; branch: string };
  }

  const IDENTITY_A: Identity = {
    worktreePath: "/repo",
    currentBranch: "feature/x",
    destination: { remote: "origin", branch: "feature/x" },
  };

  // Rendered by hand so a test can change what the open confirm is for.
  function renderIdentity(identity: Identity, onPushDestinationChanged = vi.fn()) {
    const onCommitAndPush = vi.fn().mockResolvedValue(undefined);
    const panel = (next: Identity) => (
      <CommitPanel
        stagedCount={1}
        isDetachedHead={false}
        hasConflicts={false}
        hasRemote
        pushDestination={{ ...next.destination }}
        onPushDestinationChanged={onPushDestinationChanged}
        worktreePath={next.worktreePath}
        currentBranch={next.currentBranch}
        commitMessage="fix: bug"
        onCommitMessageChange={vi.fn()}
        onCommit={vi.fn().mockResolvedValue(undefined)}
        onCommitAndPush={onCommitAndPush}
        isPushing={false}
        pushProgress={new Map()}
        pushTargetBranch={null}
        skipPushConfirm={false}
        onSetSkipPushConfirm={vi.fn()}
      />
    );
    const { rerender } = render(panel(identity));
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    return { onCommitAndPush, show: (next: Identity) => rerender(panel(next)) };
  }

  function rowSubjects(region: HTMLElement): string[] {
    return Array.from(region.querySelectorAll("li")).map((li) => li.textContent ?? "");
  }

  it("keeps the confirm blocked while the earlier-commit read is in flight", async () => {
    const read = deferred<GitPushCommitPreview>();
    listPushCommits.mockReturnValueOnce(read.promise);
    const { onCommitAndPush } = openConfirm();
    await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(1));

    const confirm = confirmButton(CONFIRM);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(confirm);
    expect(onCommitAndPush).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(pushPreview({ commits: earlierCommits(2), total: 2 }));
    });
    const rows = screen.getByRole("region", { name: "Earlier commits in this push" });
    expect(rowSubjects(rows).some((row) => row.includes("feat: earlier 2"))).toBe(true);
    await confirmWhenReady(CONFIRM);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("does not run the confirm handler while the read is in flight", async () => {
    listPushCommits.mockReturnValueOnce(new Promise(() => {}));
    const { onCommitAndPush, onSetSkipPushConfirm } = openConfirm();
    await flushReadStart();
    await act(async () => {
      confirmDialogProps.onConfirm?.();
    });
    expect(onCommitAndPush).not.toHaveBeenCalled();
    expect(onSetSkipPushConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("push-confirm-dialog")).toBeDefined();
  });

  it("keeps the confirm blocked after a failed read, and Retry re-reads before enabling it", async () => {
    const retryRead = deferred<GitPushCommitPreview>();
    listPushCommits
      .mockRejectedValueOnce(new Error("could not read from remote"))
      .mockReturnValueOnce(retryRead.promise);
    const { onCommitAndPush } = openConfirm();

    const error = await screen.findByTestId("commit-panel-push-confirm-unpushed-error");
    const confirm = confirmButton(CONFIRM);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("confirm-hint").textContent).toBe("Retry the preview to continue");
    fireEvent.click(confirm);
    expect(onCommitAndPush).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(error.isConnected).toBe(false));
    expect(confirm.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      retryRead.resolve(pushPreview());
    });
    await confirmWhenReady(CONFIRM);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("treats a read that throws before it starts as a failed read", async () => {
    listPushCommits.mockImplementationOnce(() => {
      throw new Error("IPC unavailable");
    });
    openConfirm();
    await screen.findByTestId("commit-panel-push-confirm-unpushed-error");
    expect(confirmButton(CONFIRM).getAttribute("aria-disabled")).toBe("true");
  });

  it("says a tracked range isn't on the remote yet, and lists it", async () => {
    listPushCommits.mockResolvedValueOnce(pushPreview({ commits: earlierCommits(2), total: 2 }));
    openConfirm();
    const range = await screen.findByTestId("commit-panel-push-confirm-unpushed");
    expect(range.textContent).toContain(
      "Also pushes 2 earlier commits that aren't on the remote yet"
    );
    const rows = screen.getByRole("region", { name: "Earlier commits in this push" });
    expect(rowSubjects(rows)).toHaveLength(2);
    expect(rowSubjects(rows)[0]).toContain("feat: earlier 1");
    expect(screen.queryByTestId("commit-panel-push-confirm-unverified")).toBeNull();
    expect(screen.queryByTestId("commit-panel-push-confirm-diverged")).toBeNull();
  });

  it("agrees in number for a single tracked earlier commit", async () => {
    listPushCommits.mockResolvedValueOnce(pushPreview({ commits: earlierCommits(1), total: 1 }));
    openConfirm();
    const range = await screen.findByTestId("commit-panel-push-confirm-unpushed");
    expect(range.textContent).toContain(
      "Also pushes 1 earlier commit that isn't on the remote yet"
    );
  });

  it("describes a branch being created rather than claiming its history is missing from the remote", async () => {
    listPushCommits.mockResolvedValueOnce(
      pushPreview({ rangeBasis: "creates", commits: earlierCommits(3), total: 120 })
    );
    openConfirm();
    const range = await screen.findByTestId("commit-panel-push-confirm-unpushed");
    expect(range.textContent).toContain(
      "Creates this branch on the remote, with 120 earlier commits of history"
    );
    expect(range.textContent).not.toContain("on the remote yet");
    const rows = rowSubjects(screen.getByRole("region", { name: "This branch's history" }));
    expect(rows).toHaveLength(4);
    expect(rows[2]).toContain("feat: earlier 3");
    expect(rows[3]).toBe("Listing the 3 most recent of 120");
    expect(screen.queryByTestId("commit-panel-push-confirm-unverified")).toBeNull();
  });

  it("marks a non-empty unverified range as unverified without blocking the push", async () => {
    listPushCommits.mockResolvedValueOnce(
      pushPreview({ rangeBasis: "unverified", commits: earlierCommits(2), total: 2 })
    );
    const { onCommitAndPush } = openConfirm();
    const notice = await screen.findByTestId("commit-panel-push-confirm-unverified");
    expect(notice.textContent).toContain("Couldn't verify the outgoing commits");
    expect(notice.textContent).toContain("origin/feature/x couldn't be checked");
    const range = screen.getByTestId("commit-panel-push-confirm-unpushed");
    expect(range.textContent).toContain("Also pushes 2 earlier commits, unverified");
    expect(range.textContent).not.toContain("on the remote yet");
    expect(
      rowSubjects(screen.getByRole("region", { name: "Earlier commits found locally" }))
    ).toHaveLength(2);
    await confirmWhenReady(CONFIRM);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("re-reads an unverified range from its Retry, blocking until the new answer lands", async () => {
    const retryRead = deferred<GitPushCommitPreview>();
    listPushCommits
      .mockResolvedValueOnce(pushPreview({ rangeBasis: "unverified" }))
      .mockReturnValueOnce(retryRead.promise);
    const { onCommitAndPush } = openConfirm();
    await screen.findByTestId("commit-panel-push-confirm-unverified");
    expect(confirmButton(CONFIRM).getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(2));
    expect(confirmButton(CONFIRM).getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("commit-panel-push-confirm-unverified")).toBeNull();

    await act(async () => {
      retryRead.resolve(pushPreview({ commits: earlierCommits(1), total: 1 }));
    });
    expect(screen.queryByTestId("commit-panel-push-confirm-unverified")).toBeNull();
    await confirmWhenReady(CONFIRM);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("marks an empty unverified range instead of rendering nothing, and still allows the push", async () => {
    listPushCommits.mockResolvedValueOnce(pushPreview({ rangeBasis: "unverified" }));
    const { onCommitAndPush } = openConfirm();
    const notice = await screen.findByTestId("commit-panel-push-confirm-unverified");
    expect(notice.textContent).toContain("Couldn't verify the outgoing commits");
    expect(screen.getByTestId("commit-panel-push-confirm-empty-unverified").textContent).toBe(
      "No earlier commits found, but that isn't confirmed."
    );
    expect(screen.queryByTestId("commit-panel-push-confirm-unpushed")).toBeNull();
    await confirmWhenReady(CONFIRM);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("renders nothing extra for an empty tracked range", async () => {
    openConfirm();
    await waitFor(() => expect(confirmButton(CONFIRM).getAttribute("aria-disabled")).toBeNull());
    expect(screen.queryByTestId("commit-panel-push-confirm-unpushed")).toBeNull();
    expect(screen.queryByTestId("commit-panel-push-confirm-empty-unverified")).toBeNull();
    expect(screen.queryByTestId("commit-panel-push-confirm-unverified")).toBeNull();
  });

  it("says before approval that git will refuse a push to a diverged destination", async () => {
    listPushCommits.mockResolvedValueOnce(pushPreview({ behind: 2 }));
    const { onCommitAndPush } = openConfirm();
    const notice = await screen.findByTestId("commit-panel-push-confirm-diverged");
    expect(notice.textContent).toContain("origin/feature/x has 2 commits this branch doesn't");
    expect(notice.textContent).toContain("Git will refuse this push");
    // Not blocked: git's own refusal is where the force-push lease is captured.
    await confirmWhenReady(CONFIRM);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("reads the range again on each opening rather than trusting the last one", async () => {
    listPushCommits
      .mockResolvedValueOnce(pushPreview({ commits: earlierCommits(1), total: 1 }))
      .mockReturnValueOnce(new Promise(() => {}));
    openConfirm();
    await screen.findByTestId("commit-panel-push-confirm-unpushed");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("commit-panel-push-confirm-unpushed")).toBeNull();
    expect(confirmButton(CONFIRM).getAttribute("aria-disabled")).toBe("true");
  });

  it.each([
    [
      "resolves",
      (read: ReturnType<typeof deferred<GitPushCommitPreview>>) =>
        read.resolve(pushPreview({ commits: earlierCommits(3), total: 3 })),
    ],
    [
      "rejects",
      (read: ReturnType<typeof deferred<GitPushCommitPreview>>) =>
        read.reject(new Error("late failure")),
    ],
  ])(
    "keeps the current opening's range when an earlier opening's read %s late",
    async (_label, settleLate) => {
      const first = deferred<GitPushCommitPreview>();
      const second = deferred<GitPushCommitPreview>();
      listPushCommits.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const { onCommitAndPush } = openConfirm();
      await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
      await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(2));

      await act(async () => {
        second.resolve(pushPreview({ commits: earlierCommits(1), total: 1 }));
      });
      await act(async () => {
        settleLate(first);
      });

      const range = screen.getByTestId("commit-panel-push-confirm-unpushed");
      expect(range.textContent).toContain("Also pushes 1 earlier commit");
      expect(screen.queryByTestId("commit-panel-push-confirm-unpushed-error")).toBeNull();
      await confirmWhenReady(CONFIRM);
      expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
    }
  );

  it.each<[string, Identity]>([
    ["destination remote", { ...IDENTITY_A, destination: { remote: "fork", branch: "feature/x" } }],
    [
      "destination branch",
      { ...IDENTITY_A, destination: { remote: "origin", branch: "release/x" } },
    ],
    ["local branch", { ...IDENTITY_A, currentBranch: "feature/y" }],
    ["worktree", { ...IDENTITY_A, worktreePath: "/other" }],
  ])(
    "does not approve a range read before the %s changed while the dialog was open",
    async (_label, next) => {
      const replacement = deferred<GitPushCommitPreview>();
      listPushCommits
        .mockResolvedValueOnce(pushPreview({ commits: earlierCommits(1), total: 1 }))
        .mockReturnValueOnce(replacement.promise);
      const { onCommitAndPush, show } = renderIdentity(IDENTITY_A);
      await screen.findByTestId("commit-panel-push-confirm-unpushed");

      show(next);
      const label = new RegExp(`Push to ${next.destination.remote}/${next.destination.branch}`);
      const confirm = confirmButton(label);
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
      expect(screen.queryByTestId("commit-panel-push-confirm-unpushed")).toBeNull();
      fireEvent.click(confirm);
      expect(onCommitAndPush).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(listPushCommits).toHaveBeenLastCalledWith(
          next.worktreePath,
          next.currentBranch,
          expect.any(Number)
        )
      );

      await act(async () => {
        replacement.resolve(pushPreview({ destination: next.destination }));
      });
      await confirmWhenReady(label);
      expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
    }
  );

  it("does not revive the first answer when the destination changes and changes back", async () => {
    listPushCommits
      .mockResolvedValueOnce(pushPreview({ commits: earlierCommits(1), total: 1 }))
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(new Promise(() => {}));
    const { show } = renderIdentity(IDENTITY_A);
    await screen.findByTestId("commit-panel-push-confirm-unpushed");

    show({ ...IDENTITY_A, destination: { remote: "fork", branch: "feature/x" } });
    await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(2));
    show(IDENTITY_A);
    await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(3));

    expect(screen.queryByTestId("commit-panel-push-confirm-unpushed")).toBeNull();
    expect(confirmButton(CONFIRM).getAttribute("aria-disabled")).toBe("true");
  });

  it("does not re-read when the parent hands over an equal destination object", async () => {
    const { show } = renderIdentity(IDENTITY_A);
    await waitFor(() => expect(confirmButton(CONFIRM).getAttribute("aria-disabled")).toBeNull());
    // A staging-status refresh rebuilds the destination object.
    show({ ...IDENTITY_A, destination: { ...IDENTITY_A.destination } });
    await flushReadStart();
    expect(listPushCommits).toHaveBeenCalledTimes(1);
    expect(confirmButton(CONFIRM).getAttribute("aria-disabled")).toBeNull();
  });

  it.each([
    ["remote", { remote: "upstream", branch: "feature/x" }],
    ["branch", { remote: "origin", branch: "release/x" }],
  ])(
    "blocks a range main measured against a different destination %s, and asks for a status refresh",
    async (_label, resolved) => {
      // Main answers with the same destination on the re-read that follows.
      listPushCommits.mockResolvedValue(pushPreview({ destination: resolved }));
      const onPushDestinationChanged = vi.fn();
      const { onCommitAndPush, show } = renderIdentity(IDENTITY_A, onPushDestinationChanged);

      const error = await screen.findByTestId("commit-panel-push-confirm-unpushed-error");
      expect(error.textContent).toContain(
        `Git now resolves this push to ${resolved.remote}/${resolved.branch}, not origin/feature/x`
      );
      expect(onPushDestinationChanged).toHaveBeenCalledTimes(1);
      const confirm = confirmButton(CONFIRM);
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(confirm);
      expect(onCommitAndPush).not.toHaveBeenCalled();

      // The refreshed status names the destination main resolved.
      show({ ...IDENTITY_A, destination: resolved });
      const label = new RegExp(`Push to ${resolved.remote}/${resolved.branch}`);
      await confirmWhenReady(label);
      expect(listPushCommits).toHaveBeenCalledTimes(2);
      expect(onPushDestinationChanged).toHaveBeenCalledTimes(1);
      expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
    }
  );

  it("does not read the range when the confirm opt-out skips the dialog", async () => {
    const { onCommitAndPush } = renderPanel({ currentBranch: "feature/x", skipPushConfirm: true });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    await flushReadStart();
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
    expect(listPushCommits).not.toHaveBeenCalled();
    expect(screen.queryByTestId("push-confirm-dialog")).toBeNull();
  });
});
