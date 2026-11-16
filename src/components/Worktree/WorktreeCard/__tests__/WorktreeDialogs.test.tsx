// @vitest-environment jsdom
/**
 * Every sidebar card holds these dialogs. A closed one must not be mounted
 * until its first open, and once opened it stays mounted so its own presence
 * gate can play the exit (#17072).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";
import type { ConfirmDialogState } from "../hooks/useWorktreeActions";

const mounted = vi.hoisted(() => ({ confirm: [] as boolean[], title: [] as boolean[] }));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen }: { isOpen: boolean }) => {
    mounted.confirm.push(isOpen);
    return <div data-testid="confirm" data-open={String(isOpen)} />;
  },
}));

vi.mock("../EditWorktreeTitleDialog", () => ({
  EditWorktreeTitleDialog: ({ isOpen }: { isOpen: boolean }) => {
    mounted.title.push(isOpen);
    return <div data-testid="title" data-open={String(isOpen)} />;
  },
}));

import { WorktreeDialogs, type WorktreeDialogsProps } from "../WorktreeDialogs";

const WORKTREE = { id: "wt-1", path: "/repo/wt-1", name: "wt-1", branch: "wt-1" } as WorktreeState;
const CLOSED: ConfirmDialogState = { isOpen: false };
const OPEN: ConfirmDialogState = {
  isOpen: true,
  title: "Close all sessions?",
  description: "Every session in this worktree stops.",
  confirmLabel: "Close sessions",
  variant: "destructive",
  onConfirm: () => {},
};

function props(overrides: Partial<WorktreeDialogsProps> = {}): WorktreeDialogsProps {
  return {
    worktree: WORKTREE,
    confirmDialog: CLOSED,
    onCloseConfirm: () => {},
    showDeleteDialog: false,
    onCloseDeleteDialog: () => {},
    showIssuePicker: false,
    onCloseIssuePicker: () => {},
    onAttachIssue: () => {},
    onDetachIssue: () => {},
    showTitleDialog: false,
    onCloseTitleDialog: () => {},
    customTitle: undefined,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  mounted.confirm = [];
  mounted.title = [];
});

describe("WorktreeDialogs (#17072)", () => {
  it("mounts no dialog while every one is closed", () => {
    const view = render(<WorktreeDialogs {...props()} />);
    view.rerender(<WorktreeDialogs {...props({ customTitle: "Renamed" })} />);
    expect(mounted.confirm).toEqual([]);
    expect(mounted.title).toEqual([]);
    expect(view.container.childElementCount).toBe(0);
  });

  it("mounts the confirm dialog on open and keeps it mounted through the close", () => {
    const view = render(<WorktreeDialogs {...props()} />);
    view.rerender(<WorktreeDialogs {...props({ confirmDialog: OPEN })} />);
    const opened = view.getByTestId("confirm");
    expect(opened.dataset.open).toBe("true");

    // The same instance, so the dialog's own exit plays rather than a remount.
    view.rerender(<WorktreeDialogs {...props({ confirmDialog: CLOSED })} />);
    expect(view.getByTestId("confirm")).toBe(opened);
    expect(opened.dataset.open).toBe("false");
    expect(mounted.title).toEqual([]);
  });

  it("mounts the title dialog on open and keeps it mounted through the close", () => {
    const view = render(<WorktreeDialogs {...props()} />);
    view.rerender(<WorktreeDialogs {...props({ showTitleDialog: true })} />);
    const opened = view.getByTestId("title");
    expect(opened.dataset.open).toBe("true");

    view.rerender(<WorktreeDialogs {...props({ showTitleDialog: false })} />);
    expect(view.getByTestId("title")).toBe(opened);
    expect(opened.dataset.open).toBe("false");
    expect(mounted.confirm).toEqual([]);
  });
});
