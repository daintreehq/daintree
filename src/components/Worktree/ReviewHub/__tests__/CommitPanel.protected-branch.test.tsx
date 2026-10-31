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
  fireEvent.click(button);
}

beforeEach(() => {
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
  it("with currentBranch=null but a resolved destination, keeps the confirm blocked", () => {
    const { onCommitAndPush } = renderPanel({
      currentBranch: null,
      pushDestination: { remote: "origin", branch: "main" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(screen.getByTestId("push-confirm-dialog")).toBeDefined();
    const confirm = confirmButton(/Push to origin\/main/);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
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
  function openConfirm(overrides: RenderProps = {}) {
    const rendered = renderPanel({ currentBranch: "feature/x", ...overrides });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    return rendered;
  }

  it("keeps the confirm blocked until the earlier-commit range has loaded", async () => {
    const read = deferred<GitPushCommitPreview>();
    listPushCommits.mockReturnValueOnce(read.promise);
    const { onCommitAndPush } = openConfirm();

    const confirm = confirmButton(/Push to origin\/feature\/x/);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(confirm);
    expect(onCommitAndPush).not.toHaveBeenCalled();

    read.resolve(pushPreview({ commits: earlierCommits(2), total: 2 }));
    await confirmWhenReady(/Push to origin\/feature\/x/);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("keeps the confirm blocked after a failed read, and Retry re-reads before enabling it", async () => {
    const retryRead = deferred<GitPushCommitPreview>();
    listPushCommits
      .mockRejectedValueOnce(new Error("could not read from remote"))
      .mockReturnValueOnce(retryRead.promise);
    const { onCommitAndPush } = openConfirm();

    const error = await screen.findByTestId("commit-panel-push-confirm-unpushed-error");
    const confirm = confirmButton(/Push to origin\/feature\/x/);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("confirm-hint").textContent).toContain("Retry");
    fireEvent.click(confirm);
    expect(onCommitAndPush).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(error.isConnected).toBe(false));
    expect(confirm.getAttribute("aria-disabled")).toBe("true");

    retryRead.resolve(pushPreview());
    await confirmWhenReady(/Push to origin\/feature\/x/);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("says a tracked range isn't on the remote yet", async () => {
    listPushCommits.mockResolvedValueOnce(pushPreview({ commits: earlierCommits(2), total: 2 }));
    openConfirm();
    const range = await screen.findByTestId("commit-panel-push-confirm-unpushed");
    expect(range.textContent).toContain(
      "Also pushes 2 earlier commits that aren't on the remote yet"
    );
    expect(screen.queryByTestId("commit-panel-push-confirm-unverified")).toBeNull();
  });

  it("describes a branch being created rather than claiming its history is missing from the remote", async () => {
    listPushCommits.mockResolvedValueOnce(
      pushPreview({ rangeBasis: "creates", commits: earlierCommits(3), total: 120 })
    );
    openConfirm();
    const range = await screen.findByTestId("commit-panel-push-confirm-unpushed");
    expect(range.textContent).toContain("Creates this branch");
    expect(range.textContent).not.toContain("on the remote yet");
    expect(screen.queryByTestId("commit-panel-push-confirm-unverified")).toBeNull();
  });

  it("marks a non-empty unverified range as unverified, with a Retry that re-reads", async () => {
    listPushCommits
      .mockResolvedValueOnce(
        pushPreview({ rangeBasis: "unverified", commits: earlierCommits(2), total: 2 })
      )
      .mockReturnValueOnce(new Promise(() => {}));
    openConfirm();
    const notice = await screen.findByTestId("commit-panel-push-confirm-unverified");
    expect(notice.textContent).toContain("Couldn't verify the outgoing commits");
    const range = screen.getByTestId("commit-panel-push-confirm-unpushed");
    expect(range.textContent).toContain("unverified");
    expect(range.textContent).not.toContain("on the remote yet");
    // Unverified is a warning, not a blocker, as in the standalone push confirm.
    expect(confirmButton(/Push to origin\/feature\/x/).getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(confirmButton(/Push to origin\/feature\/x/).getAttribute("aria-disabled")).toBe("true")
    );
  });

  it("marks an empty unverified range instead of rendering nothing", async () => {
    listPushCommits.mockResolvedValueOnce(pushPreview({ rangeBasis: "unverified" }));
    openConfirm();
    const notice = await screen.findByTestId("commit-panel-push-confirm-unverified");
    expect(notice.textContent).toContain("Couldn't verify the outgoing commits");
    expect(screen.getByTestId("commit-panel-push-confirm-empty-unverified").textContent).toContain(
      "isn't confirmed"
    );
    expect(screen.queryByTestId("commit-panel-push-confirm-unpushed")).toBeNull();
  });

  it("says before approval that git will refuse a push to a diverged destination", async () => {
    listPushCommits.mockResolvedValueOnce(
      pushPreview({ commits: earlierCommits(1), total: 1, behind: 2 })
    );
    const { onCommitAndPush } = openConfirm();
    const notice = await screen.findByTestId("commit-panel-push-confirm-diverged");
    expect(notice.textContent).toContain("origin/feature/x has 2 commits this branch doesn't");
    expect(notice.textContent).toContain("Git will refuse this push");
    // Not blocked: git's own refusal is where the force-push lease is captured.
    await confirmWhenReady(/Push to origin\/feature\/x/);
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
    expect(confirmButton(/Push to origin\/feature\/x/).getAttribute("aria-disabled")).toBe("true");
  });

  it("ignores a read from an earlier opening that lands during the next one", async () => {
    const first = deferred<GitPushCommitPreview>();
    listPushCommits.mockReturnValueOnce(first.promise).mockReturnValueOnce(new Promise(() => {}));
    openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    await waitFor(() => expect(listPushCommits).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.resolve(pushPreview({ commits: earlierCommits(1), total: 1 }));
    });
    expect(screen.queryByTestId("commit-panel-push-confirm-unpushed")).toBeNull();
    expect(confirmButton(/Push to origin\/feature\/x/).getAttribute("aria-disabled")).toBe("true");
  });

  it("does not approve a range read for a destination that changed while the dialog was open", async () => {
    const second = deferred<GitPushCommitPreview>();
    listPushCommits
      .mockResolvedValueOnce(pushPreview({ commits: earlierCommits(1), total: 1 }))
      .mockReturnValueOnce(second.promise);
    const onCommitAndPush = vi.fn().mockResolvedValue(undefined);
    const panel = (destination: { remote: string; branch: string }) => (
      <CommitPanel
        stagedCount={1}
        isDetachedHead={false}
        hasConflicts={false}
        hasRemote
        pushDestination={destination}
        worktreePath="/repo"
        currentBranch="feature/x"
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
    const { rerender } = render(panel({ remote: "origin", branch: "feature/x" }));
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    await screen.findByTestId("commit-panel-push-confirm-unpushed");

    rerender(panel({ remote: "fork", branch: "feature/x" }));
    const confirm = confirmButton(/Push to fork\/feature\/x/);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("commit-panel-push-confirm-unpushed")).toBeNull();
    fireEvent.click(confirm);
    expect(onCommitAndPush).not.toHaveBeenCalled();

    second.resolve(pushPreview({ destination: { remote: "fork", branch: "feature/x" } }));
    await confirmWhenReady(/Push to fork\/feature\/x/);
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
  });

  it("does not re-read when the parent hands over an equal destination object", async () => {
    const onCommitAndPush = vi.fn().mockResolvedValue(undefined);
    const panel = (destination: { remote: string; branch: string }) => (
      <CommitPanel
        stagedCount={1}
        isDetachedHead={false}
        hasConflicts={false}
        hasRemote
        pushDestination={destination}
        worktreePath="/repo"
        currentBranch="feature/x"
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
    const { rerender } = render(panel({ remote: "origin", branch: "feature/x" }));
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    await waitFor(() =>
      expect(confirmButton(/Push to origin\/feature\/x/).getAttribute("aria-disabled")).toBeNull()
    );
    // A staging-status refresh rebuilds the destination object.
    rerender(panel({ remote: "origin", branch: "feature/x" }));
    // The read starts in a microtask; flush it so a re-read would be counted.
    await act(async () => {});
    expect(listPushCommits).toHaveBeenCalledTimes(1);
    expect(confirmButton(/Push to origin\/feature\/x/).getAttribute("aria-disabled")).toBeNull();
  });

  it("blocks a range that main measured against a different destination", async () => {
    listPushCommits.mockResolvedValueOnce(
      pushPreview({ destination: { remote: "upstream", branch: "feature/x" } })
    );
    const { onCommitAndPush } = openConfirm();
    await screen.findByTestId("commit-panel-push-confirm-unpushed-error");
    const confirm = confirmButton(/Push to origin\/feature\/x/);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(confirm);
    expect(onCommitAndPush).not.toHaveBeenCalled();
  });

  it("does not read the range when the confirm opt-out skips the dialog", () => {
    const { onCommitAndPush } = renderPanel({ currentBranch: "feature/x", skipPushConfirm: true });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(onCommitAndPush).toHaveBeenCalledWith("fix: bug");
    expect(listPushCommits).not.toHaveBeenCalled();
  });
});
