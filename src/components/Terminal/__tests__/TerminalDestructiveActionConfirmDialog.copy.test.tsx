// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

// Typed explicitly so asserting on `toHaveBeenCalledWith` needs no cast.
const dispatch = vi.fn<(id: string, args: unknown, opts: unknown) => Promise<void>>(() =>
  Promise.resolve()
);

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (id: string, args: unknown, opts: unknown) => dispatch(id, args, opts),
  },
}));

vi.mock("@/lib/accessibility", () => ({
  closeAndAnnounce: (clear: () => void) => clear(),
}));

import {
  useTerminalPendingDestructiveActionStore,
  type DestructivePreviewGroup,
  type TerminalPendingDestructiveActionSnapshot,
} from "@/store/terminalPendingDestructiveActionStore";
import { TRASH_TTL_SECONDS } from "@/components/Layout/trashCountdown";
import { TerminalDestructiveActionConfirmDialog } from "../TerminalDestructiveActionConfirmDialog";

beforeEach(() => {
  cleanup();
  dispatch.mockClear();
  useTerminalPendingDestructiveActionStore.getState().clear();
});

const PREVIEW: DestructivePreviewGroup[] = [
  {
    worktreeId: "wt-a",
    worktreeTitle: "feature/oauth",
    terminals: [
      { terminalId: "t1", terminalTitle: "Claude · auth", hasRunningAgent: true },
      { terminalId: "t2", terminalTitle: "dev server", hasRunningAgent: false },
    ],
  },
  {
    worktreeId: "wt-b",
    worktreeTitle: "fix/retry",
    terminals: [{ terminalId: "t3", terminalTitle: "Codex · tests", hasRunningAgent: true }],
  },
];

type Case = {
  name: string;
  snapshot: TerminalPendingDestructiveActionSnapshot;
  subject?: string;
  bulk: boolean;
  recoverable: boolean;
};

const WORKTREE = { worktreeId: "wt-a", worktreeTitle: "feature/oauth" };

const CASES: Case[] = [
  {
    name: "kill",
    snapshot: {
      kind: "kill",
      targetCount: 1,
      runningAgentCount: 1,
      terminalId: "t1",
      terminalTitle: "Claude · auth",
    },
    subject: "Claude · auth",
    bulk: false,
    recoverable: false,
  },
  {
    name: "restart",
    snapshot: {
      kind: "restart",
      targetCount: 1,
      runningAgentCount: 1,
      terminalId: "t1",
      terminalTitle: "Claude · auth",
    },
    subject: "Claude · auth",
    bulk: false,
    recoverable: false,
  },
  {
    name: "killAll",
    snapshot: { kind: "killAll", targetCount: 3, runningAgentCount: 2, preview: PREVIEW },
    bulk: true,
    recoverable: false,
  },
  {
    name: "restartAll",
    snapshot: { kind: "restartAll", targetCount: 3, runningAgentCount: 2, preview: PREVIEW },
    bulk: true,
    recoverable: false,
  },
  {
    name: "worktreeRestartAll",
    snapshot: {
      kind: "worktreeRestartAll",
      targetCount: 2,
      runningAgentCount: 1,
      ...WORKTREE,
      preview: PREVIEW.slice(0, 1),
    },
    subject: "feature/oauth",
    bulk: true,
    recoverable: false,
  },
  {
    name: "worktreeTrashAll",
    snapshot: {
      kind: "worktreeTrashAll",
      targetCount: 2,
      runningAgentCount: 1,
      ...WORKTREE,
      preview: PREVIEW.slice(0, 1),
    },
    subject: "feature/oauth",
    bulk: true,
    recoverable: true,
  },
  {
    name: "worktreeEndAll",
    snapshot: {
      kind: "worktreeEndAll",
      targetCount: 2,
      runningAgentCount: 1,
      ...WORKTREE,
      preview: PREVIEW.slice(0, 1),
    },
    subject: "feature/oauth",
    bulk: true,
    recoverable: false,
  },
  {
    name: "worktreeClearHistory",
    snapshot: { kind: "worktreeClearHistory", targetCount: 0, runningAgentCount: 0, ...WORKTREE },
    subject: "feature/oauth",
    bulk: false,
    recoverable: false,
  },
  {
    name: "deletedWorktreeDismiss",
    snapshot: {
      kind: "deletedWorktreeDismiss",
      targetCount: 2,
      runningAgentCount: 1,
      ...WORKTREE,
      preview: PREVIEW.slice(0, 1),
    },
    subject: "feature/oauth",
    bulk: true,
    recoverable: true,
  },
  {
    name: "deletedWorktreeGroupDismiss",
    snapshot: {
      kind: "deletedWorktreeGroupDismiss",
      targetCount: 3,
      runningAgentCount: 2,
      preview: PREVIEW,
    },
    bulk: true,
    recoverable: true,
  },
];

function open(snapshot: TerminalPendingDestructiveActionSnapshot) {
  useTerminalPendingDestructiveActionStore.getState().request(snapshot);
  render(<TerminalDestructiveActionConfirmDialog />);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
  if (!dialog) throw new Error("dialog did not render");
  const byId = (attr: string) =>
    document.getElementById(dialog.getAttribute(attr) ?? "")?.textContent ?? "";
  return {
    dialog,
    title: byId("aria-labelledby"),
    described: byId("aria-describedby"),
    preview: dialog.querySelector('[data-testid="destructive-confirm-preview"]'),
  };
}

const WORKING_LEAD = /^(Its agent is working|1 agent is working|\d+ agents are working)/;

describe("TerminalDestructiveActionConfirmDialog — copy and preview invariants", () => {
  it.each(CASES.filter((c) => c.subject))("$name names its target in the title", (c) => {
    const { title } = open(c.snapshot);
    expect(title).toContain(`'${c.subject}'`);
  });

  it.each(CASES.filter((c) => c.snapshot.runningAgentCount > 0))(
    "$name leads its description with the working-agent consequence",
    (c) => {
      const { described } = open(c.snapshot);
      expect(described).toMatch(WORKING_LEAD);
    }
  );

  it.each(CASES.filter((c) => c.snapshot.kind !== "kill" && c.snapshot.kind !== "restart"))(
    "$name says nothing about working agents when none are working",
    (c) => {
      const { described } = open({ ...c.snapshot, runningAgentCount: 0 });
      expect(described).not.toMatch(/working/i);
    }
  );

  it.each(CASES)("$name previews its targets only when it is a bulk action", (c) => {
    const { dialog, preview, described } = open(c.snapshot);
    expect(preview !== null).toBe(c.bulk);
    // A scrollable preview makes it a plain dialog; a text-only confirm stays an alertdialog.
    expect(dialog.getAttribute("role")).toBe(c.bulk ? "dialog" : "alertdialog");
    // The preview never rides in the accessible description.
    if (preview) {
      for (const row of preview.querySelectorAll("li")) {
        expect(described).not.toContain(row.textContent ?? "");
      }
    }
  });

  it.each(CASES.filter((c) => c.bulk))(
    "$name marks exactly the working terminals in its preview",
    (c) => {
      const { preview } = open(c.snapshot);
      const rows = [...(preview?.querySelectorAll("li") ?? [])];
      const expected = (c.snapshot.preview ?? [])
        .flatMap((g) => g.terminals)
        .filter((t) => t.hasRunningAgent)
        .map((t) => t.terminalTitle);
      const marked = rows
        .filter((row) => /Working$/.test(row.textContent ?? ""))
        .map((row) => (row.textContent ?? "").replace(/Working$/, ""));
      expect(marked.sort()).toEqual(expected.sort());
    }
  );

  it.each(CASES)("$name states the real trash window only when it is recoverable", (c) => {
    const { described } = open(c.snapshot);
    expect(new RegExp(`${TRASH_TTL_SECONDS}\\s+seconds`).test(described)).toBe(c.recoverable);
  });

  it.each(CASES)("$name keeps advice out of the accessible description", (c) => {
    const { dialog, described } = open(c.snapshot);
    const describedBy = dialog.getAttribute("aria-describedby");
    const notes = [...dialog.querySelectorAll("p")].filter((p) => p.id !== describedBy);
    for (const note of notes) {
      expect(described).not.toContain(note.textContent ?? "");
    }
  });
});

function stage(targetCount: number, runningAgentCount = 0): void {
  useTerminalPendingDestructiveActionStore.getState().request({
    kind: "deletedWorktreeDismiss",
    targetCount,
    runningAgentCount,
    worktreeId: "wt-1",
  });
}

describe("TerminalDestructiveActionConfirmDialog — deleted-worktree dismiss", () => {
  it("names the count in the confirm button", () => {
    stage(3);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "Close 3 terminals" })).toBeTruthy();
  });

  it("uses the singular noun for one terminal", () => {
    stage(1);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "Close 1 terminal" })).toBeTruthy();
  });

  it("points at dragging as the alternative to closing", () => {
    stage(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/drag it to another worktree/)).toBeTruthy();
  });

  it("trashes the worktree's sessions on confirm", () => {
    stage(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Close 2 terminals" }));

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.trashAll",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
  });

  it("dispatches nothing while the dialog is merely open", () => {
    stage(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(dispatch).not.toHaveBeenCalled();
  });
});

function stageGroup(): void {
  useTerminalPendingDestructiveActionStore.getState().request({
    kind: "deletedWorktreeGroupDismiss",
    targetCount: 3,
    runningAgentCount: 1,
    preview: [
      {
        worktreeId: "wt-1",
        worktreeTitle: "feature/alpha",
        terminals: [
          { terminalId: "t1", terminalTitle: "Claude", hasRunningAgent: true },
          { terminalId: "t2", terminalTitle: "zsh", hasRunningAgent: false },
        ],
      },
      {
        worktreeId: "wt-2",
        worktreeTitle: "feature/beta",
        terminals: [{ terminalId: "t3", terminalTitle: "Codex", hasRunningAgent: false }],
      },
    ],
  });
}

describe("TerminalDestructiveActionConfirmDialog — grouped deleted-worktree clear (#11260)", () => {
  it("previews the actual terminals rather than only a count (D2)", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("zsh")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("groups the previewed terminals under the worktree each came from", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText("feature/alpha")).toBeTruthy();
    expect(screen.getByText("feature/beta")).toBeTruthy();
  });

  it("names both counts in the title", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText("Close 3 terminals from 2 deleted worktrees?")).toBeTruthy();
  });

  it("fans the single-worktree executor over every previewed worktree on confirm", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Close 3 terminals" }));

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.trashAll",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.trashAll",
      { worktreeId: "wt-2", confirmed: true },
      { source: "user" }
    );
  });

  it("dispatches nothing when the preview is empty", () => {
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "deletedWorktreeGroupDismiss",
      targetCount: 0,
      runningAgentCount: 0,
      preview: [],
    });
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Close 0 terminals" }));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still points at dragging as the alternative", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/drag it to another worktree/)).toBeTruthy();
  });
});

function stageEndAll(targetCount: number, runningAgentCount = 0): void {
  useTerminalPendingDestructiveActionStore.getState().request({
    kind: "worktreeEndAll",
    targetCount,
    runningAgentCount,
    worktreeId: "wt-1",
  });
}

describe("TerminalDestructiveActionConfirmDialog — worktree end-all (#11345)", () => {
  it("names the count in the confirm button", () => {
    stageEndAll(3);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "End 3 sessions" })).toBeTruthy();
  });

  it("uses the singular noun for one session", () => {
    stageEndAll(1);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "End 1 session" })).toBeTruthy();
  });

  it("frames the loss as permanent and unrecoverable, unlike trashing", () => {
    stageEndAll(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/can't be restored/)).toBeTruthy();
  });

  it("warns when a session has a running agent", () => {
    stageEndAll(2, 1);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/1 agent is working and will be stopped/)).toBeTruthy();
  });

  it("uses the plural agent warning when several are running", () => {
    stageEndAll(3, 2);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/2 agents are working and will be stopped/)).toBeTruthy();
  });

  it("ends the worktree's sessions on confirm", () => {
    stageEndAll(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "End 2 sessions" }));

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.endAll",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
  });

  it("dispatches nothing when the worktree id is missing from the snapshot", () => {
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "worktreeEndAll",
      targetCount: 2,
      runningAgentCount: 0,
    });
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "End 2 sessions" }));

    expect(dispatch).not.toHaveBeenCalled();
  });
});

function stageClearHistory(): void {
  useTerminalPendingDestructiveActionStore.getState().request({
    kind: "worktreeClearHistory",
    targetCount: 0,
    runningAgentCount: 0,
    worktreeId: "wt-1",
  });
}

describe("TerminalDestructiveActionConfirmDialog — worktree clear-history (#11345)", () => {
  it("uses count-free copy rather than a misleading '0 sessions'", () => {
    stageClearHistory();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "Clear session history" })).toBeTruthy();
    expect(screen.getByText("Clear session history for this worktree?")).toBeTruthy();
    expect(screen.queryByText(/0 session/)).toBeNull();
  });

  it("clears the worktree's history on confirm", () => {
    stageClearHistory();
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Clear session history" }));

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.clearHistory",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
  });

  it("dispatches nothing when the worktree id is missing from the snapshot", () => {
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "worktreeClearHistory",
      targetCount: 0,
      runningAgentCount: 0,
    });
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Clear session history" }));

    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("TerminalDestructiveActionConfirmDialog — confirmed re-dispatch source", () => {
  const origins = ["keybinding", "user", "menu", "context-menu", "agent", undefined] as const;

  it.each(origins)(
    "answers a %s-raised confirm as a keybinding only when it came from one",
    (origin) => {
      useTerminalPendingDestructiveActionStore.getState().request({
        kind: "worktreeEndAll",
        targetCount: 2,
        runningAgentCount: 0,
        worktreeId: "wt-1",
        dispatchSource: origin,
      });
      render(<TerminalDestructiveActionConfirmDialog />);
      fireEvent.click(screen.getByRole("button", { name: "End 2 sessions" }));

      const opts = dispatch.mock.calls.at(-1)![2];
      // A human confirmed this, so it is never replayed as an agent dispatch.
      expect(opts).toEqual({ source: origin === "keybinding" ? "keybinding" : "user" });
    }
  );
});
