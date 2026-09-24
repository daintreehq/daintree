// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: () => Promise.resolve() },
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
    expect(described.includes(`${TRASH_TTL_SECONDS} seconds`)).toBe(c.recoverable);
  });
});
