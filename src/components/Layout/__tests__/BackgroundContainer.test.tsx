// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { ESCAPE_BACKSTOP_DIALOG_ATTR } from "@/lib/dialogEscapeBackstop";
import type { AgentState } from "@/types";
import type { TrashedTerminalGroupMetadata } from "@/store/slices";
import { act } from "react";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import {
  __resetPanelCloseGuardsForTests,
  registerPanelCloseGuard,
} from "@/services/panelCloseGuard";

const watchPanelMock = vi.fn();
const unwatchPanelMock = vi.fn();
const removePanelMock = vi.fn();
const restoreBackgroundTerminalMock = vi.fn();
const restoreBackgroundGroupMock = vi.fn();
const activateTerminalMock = vi.fn();
const pingTerminalMock = vi.fn();
const fireWatchNotificationMock = vi.fn();
const selectWorktreeMock = vi.fn();
const trackTerminalFocusMock = vi.fn();

let mockTerminals: PanelInstance[] = [];
let mockBackgroundedTerminals = new Map<
  string,
  { groupRestoreId?: string; groupMetadata?: TrashedTerminalGroupMetadata }
>();
let mockWatchedPanels = new Set<string>();

vi.mock("@/hooks/useTerminalSelectors", () => ({
  useBackgroundedTerminals: () => mockTerminals,
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktreeNames: () =>
    new Map([
      ["wt-1", "feature-auth"],
      ["wt-2", "feature-ui"],
    ]),
}));

vi.mock("@/store", () => ({
  usePanelStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      backgroundedTerminals: mockBackgroundedTerminals,
      watchedPanels: mockWatchedPanels,
      restoreBackgroundTerminal: restoreBackgroundTerminalMock,
      restoreBackgroundGroup: restoreBackgroundGroupMock,
      activateTerminal: activateTerminalMock,
      pingTerminal: pingTerminalMock,
      removePanel: removePanelMock,
      watchPanel: watchPanelMock,
      unwatchPanel: unwatchPanelMock,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      activeWorktreeId: "wt-1",
      selectWorktree: selectWorktreeMock,
      trackTerminalFocus: trackTerminalFocusMock,
    }),
}));

vi.mock("@/lib/watchNotification", () => ({
  fireWatchNotification: (...args: unknown[]) => fireWatchNotificationMock(...args),
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => null,
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: (panel?: { kind?: string }) => ({
    iconId: null,
    label: panel?.kind === "file" ? "File viewer" : "Terminal",
    isAgent: false,
    agentId: null,
    processId: null,
    runtimeKind: "none",
  }),
}));

vi.mock("@/components/Worktree/LiveTimeAgo", () => ({
  LiveTimeAgo: ({ timestamp }: { timestamp: number }) => (
    <span data-testid="live-time-ago">{`@${timestamp}`}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    pressed,
    ...props
  }: {
    children: React.ReactNode;
    pressed?: boolean;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button aria-pressed={pressed} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => {
  const Pass = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return {
    Tooltip: Pass,
    TooltipContent: Pass,
    TooltipProvider: Pass,
    TooltipTrigger: Pass,
  };
});

type DismissHandler = (e: { preventDefault: () => void; target?: Element | null }) => void;

const popoverHandlers: {
  onPointerDownOutside: DismissHandler | undefined;
  onInteractOutside: DismissHandler | undefined;
  onEscapeKeyDown: DismissHandler | undefined;
} = {
  onPointerDownOutside: undefined,
  onInteractOutside: undefined,
  onEscapeKeyDown: undefined,
};

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-testid="popover" data-open={open ? "true" : "false"}>
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-trigger">{children}</div>
  ),
  PopoverContent: ({
    children,
    onPointerDownOutside,
    onInteractOutside,
    onEscapeKeyDown,
  }: {
    children: React.ReactNode;
    onPointerDownOutside?: DismissHandler;
    onInteractOutside?: DismissHandler;
    onEscapeKeyDown?: DismissHandler;
  }) => {
    popoverHandlers.onPointerDownOutside = onPointerDownOutside;
    popoverHandlers.onInteractOutside = onInteractOutside;
    popoverHandlers.onEscapeKeyDown = onEscapeKeyDown;
    return <div data-testid="popover-content">{children}</div>;
  },
}));

const markEscapeYieldedMock = vi.fn();

vi.mock("@/lib/dialogEscapeBackstop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dialogEscapeBackstop")>()),
  markEscapeYieldedToDialog: (event: unknown) => markEscapeYieldedMock(event),
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    confirmLabel,
    onConfirm,
    onClose,
  }: {
    isOpen: boolean;
    title: React.ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
    onClose: () => void;
  }) => {
    if (!isOpen) return null;
    return (
      <div role="dialog" data-testid="kill-confirm-dialog">
        <div data-testid="confirm-title">{title}</div>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    );
  },
}));

// Right-click on a row must be that row's panel, so the menu records whose it is.
vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({
    terminalId,
    children,
  }: {
    terminalId: string;
    children: React.ReactNode;
  }) => <div data-menu-for={terminalId}>{children}</div>,
}));

import { BackgroundContainer } from "../BackgroundContainer";

/** The fleet reporting an unread Canopy ask on each of these runs: the only waits counted. */
function deliverAsks(ids: string[]) {
  act(() => {
    useFleetSnapshotStore.getState().applySnapshot({
      runs: ids.map((runId) => ({
        runId,
        workspaceId: "p1",
        spawnedAt: 1,
        cwd: "/tmp",
        agentState: "waiting" as const,
        canopy: { kind: "asked" as const, quote: "Run it?", readAt: 1, seen: false },
      })),
      changedAt: 2,
      degraded: false,
      lastSuccessfulAt: 2,
    });
  });
}

function makeTerminal(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "t1",
    kind: "terminal",
    title: "claude",
    location: "background",
    worktreeId: "wt-1",
    agentState: "idle" as AgentState,
    lastStateChange: 1700000000000,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    ...overrides,
  } as PtyPanelData;
}

beforeEach(() => {
  useFleetSnapshotStore.setState({ snapshot: null });
  markEscapeYieldedMock.mockReset();
  watchPanelMock.mockReset();
  unwatchPanelMock.mockReset();
  removePanelMock.mockReset();
  restoreBackgroundTerminalMock.mockReset();
  restoreBackgroundGroupMock.mockReset();
  activateTerminalMock.mockReset();
  pingTerminalMock.mockReset();
  fireWatchNotificationMock.mockReset();
  selectWorktreeMock.mockReset();
  trackTerminalFocusMock.mockReset();
  popoverHandlers.onPointerDownOutside = undefined;
  popoverHandlers.onInteractOutside = undefined;
  popoverHandlers.onEscapeKeyDown = undefined;
  mockTerminals = [];
  mockBackgroundedTerminals = new Map();
  mockWatchedPanels = new Set();
  __resetPanelCloseGuardsForTests();
});

function makeFilePanel(overrides: Record<string, unknown> = {}): PanelInstance {
  return {
    id: "f1",
    kind: "file",
    title: "notes.md",
    location: "background",
    worktreeId: "wt-1",
    filePath: "/tmp/notes.md",
    ...overrides,
  } as PanelInstance;
}

/** Where the real kill confirm holds focus: inside a backstop-managed dialog. */
function focusInsideBackstopDialog() {
  const dialog = screen.getByTestId("kill-confirm-dialog");
  dialog.setAttribute(ESCAPE_BACKSTOP_DIALOG_ATTR, "");
  within(dialog).getByRole("button", { name: "Cancel" }).focus();
}

describe("BackgroundContainer", () => {
  it("stays mounted but hidden when there are no backgrounded terminals", () => {
    // The pill keeps its DOM node so the .dock-status-pill CSS can run the
    // display/opacity exit transition; visibility is gated by data-visible.
    const { container } = render(<BackgroundContainer />);
    const pill = container.querySelector(".dock-status-pill");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-visible")).toBe("false");
  });

  it("marks the pill visible once a terminal is backgrounded", () => {
    mockTerminals = [makeTerminal({ id: "t1", agentState: "idle" })];
    const { container } = render(<BackgroundContainer />);
    expect(container.querySelector(".dock-status-pill")?.getAttribute("data-visible")).toBe("true");
  });

  describe("trigger label", () => {
    it("shows only the count when no terminals are waiting", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", agentState: "idle" }),
        makeTerminal({ id: "t2", agentState: "working" }),
        makeTerminal({ id: "t3", agentState: "completed" }),
      ];
      render(<BackgroundContainer />);
      const trigger = screen.getByRole("button", { name: /^Background: 3 panels/ });
      expect(trigger.getAttribute("aria-label")).toBe(
        "Background: 3 panels across all worktrees, all in this one"
      );
    });

    it("leaves a prompt that asks nothing out of the waiting count", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", agentState: "waiting" }),
        makeTerminal({ id: "t2", agentState: "waiting" }),
      ];
      render(<BackgroundContainer />);
      const trigger = screen.getByRole("button", { name: /^Background: 2 panels/ });
      expect(trigger.getAttribute("aria-label")).toBe(
        "Background: 2 panels across all worktrees, all in this one"
      );
    });

    it("appends waiting count when terminals are waiting", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", agentState: "waiting" }),
        makeTerminal({ id: "t2", agentState: "waiting" }),
        makeTerminal({ id: "t3", agentState: "working" }),
      ];
      deliverAsks(["t1", "t2", "t3"]);
      render(<BackgroundContainer />);
      const trigger = screen.getByRole("button", { name: /^Background: 3 panels/ });
      expect(trigger.getAttribute("aria-label")).toBe(
        "Background: 3 panels across all worktrees, all in this one, 2 waiting"
      );
    });
  });

  describe("row metadata", () => {
    it("renders worktree name, state label, headline, and live time", () => {
      mockTerminals = [
        makeTerminal({
          id: "t1",
          worktreeId: "wt-2",
          title: "Fix auth bug",
          agentState: "waiting",
          activityHeadline: "Asked for permission",
          lastStateChange: 1700000000123,
        }),
      ];
      deliverAsks(["t1"]);
      render(<BackgroundContainer />);
      const row = screen.getByTestId("background-single-item");
      const text = row.textContent ?? "";
      expect(text).toContain("Fix auth bug");
      expect(text).toContain("feature-ui");
      expect(text).toContain("waiting");
      expect(text).toContain("Asked for permission");
      expect(within(row).getByTestId("live-time-ago")).toBeTruthy();
    });

    it("splits rows by worktree and names the worktree only under other worktrees", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", title: "Local", worktreeId: "wt-1" }),
        makeTerminal({ id: "t2", title: "Remote", worktreeId: "wt-2" }),
      ];
      render(<BackgroundContainer />);
      const here = screen.getByRole("group", { name: "This worktree" }).textContent ?? "";
      const away = screen.getByRole("group", { name: "Other worktrees" }).textContent ?? "";
      expect(here).toContain("Local");
      expect(here).not.toContain("feature-auth");
      expect(away).toContain("Remote");
      expect(away).toContain("feature-ui");
    });

    it("carries agent state in the glyph and label, never in the row's surface", () => {
      // A popover row is highlighted by hover and focus alone, as in the other
      // three status popovers; a coloured rail per state was a second language.
      mockTerminals = [
        makeTerminal({ id: "t-wait", title: "a", agentState: "waiting" }),
        makeTerminal({ id: "t-work", title: "b", agentState: "working" }),
        makeTerminal({ id: "t-idle", title: "c", agentState: "idle" }),
      ];
      deliverAsks(["t-wait"]);
      render(<BackgroundContainer />);
      const rows = screen.getAllByTestId("background-single-item");
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.className)).size).toBe(1);
      for (const row of rows) expect(row.className).not.toMatch(/panel-state-|border-l-/);
      expect(screen.getAllByText(/waiting/i).length).toBeGreaterThan(0);
    });
  });

  describe("row glyphs from the fleet band", () => {
    it("draws each row the way its pane does: amber only for the unread ask", () => {
      mockTerminals = [
        makeTerminal({ id: "ask", title: "a", agentState: "waiting" }),
        makeTerminal({ id: "prompt", title: "b", agentState: "waiting" }),
        makeTerminal({ id: "review", title: "c", agentState: "waiting" }),
        makeTerminal({ id: "done", title: "d", agentState: "waiting" }),
      ];
      act(() => {
        useFleetSnapshotStore.getState().applySnapshot({
          runs: [
            {
              runId: "ask",
              canopy: { kind: "asked", quote: "Run it?", readAt: 1, seen: false } as const,
            },
            { runId: "prompt" },
            { runId: "review", handBack: { stoppedAt: 1 } },
            { runId: "done", handBack: { stoppedAt: 1, seenAt: 2 } },
          ].map((run): FleetRunRow => ({
            workspaceId: "p1",
            spawnedAt: 1,
            cwd: "/tmp",
            agentState: "waiting" as const,
            ...run,
          })),
          changedAt: 2,
          degraded: false,
          lastSuccessfulAt: 2,
        });
      });
      render(<BackgroundContainer />);
      const row = (title: string) =>
        screen
          .getAllByTestId("background-single-item")
          .find((r) => r.textContent?.startsWith(title))!;
      expect(row("a").querySelector(".text-state-waiting")).not.toBeNull();
      expect(row("a").textContent).toContain("waiting");
      for (const title of ["b", "c", "d"]) {
        expect(row(title).querySelector(".text-state-waiting")).toBeNull();
      }
      expect(row("b").textContent).not.toMatch(/waiting|unread|finished/);
      expect(row("c").textContent).toContain("unread");
      expect(row("d").textContent).toContain("finished");
    });
  });

  describe("row context menu", () => {
    it("scopes each row's right-click to that row's own panel", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", title: "first" }),
        makeTerminal({ id: "t2", title: "second" }),
      ];
      render(<BackgroundContainer />);
      const rows = screen.getAllByTestId("background-single-item");
      expect(
        rows.map((row) => row.closest("[data-menu-for]")?.getAttribute("data-menu-for"))
      ).toEqual(["t1", "t2"]);
    });
  });

  describe("watch toggle", () => {
    it("calls watchPanel for unwatched terminals not in a terminal state", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "working" })];
      mockWatchedPanels = new Set();
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-watch-button"));
      expect(watchPanelMock).toHaveBeenCalledWith("t1");
      expect(fireWatchNotificationMock).not.toHaveBeenCalled();
    });

    it("fires immediate notification for already-waiting terminals instead of subscribing", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "waiting", title: "claude task" })];
      mockWatchedPanels = new Set();
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-watch-button"));
      expect(fireWatchNotificationMock).toHaveBeenCalledWith("t1", "claude task", "waiting");
      expect(watchPanelMock).not.toHaveBeenCalled();
    });

    it("fires immediate notification for completed terminals", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "completed" })];
      mockWatchedPanels = new Set();
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-watch-button"));
      expect(fireWatchNotificationMock).toHaveBeenCalledWith("t1", "claude", "completed");
      expect(watchPanelMock).not.toHaveBeenCalled();
    });

    it("calls unwatchPanel when the terminal is already watched", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "working" })];
      mockWatchedPanels = new Set(["t1"]);
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-watch-button"));
      expect(unwatchPanelMock).toHaveBeenCalledWith("t1");
      expect(watchPanelMock).not.toHaveBeenCalled();
    });

    it("fires immediate notification for exited terminals instead of subscribing", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "exited", title: "claude task" })];
      mockWatchedPanels = new Set();
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-watch-button"));
      expect(fireWatchNotificationMock).toHaveBeenCalledWith("t1", "claude task", "exited");
      expect(watchPanelMock).not.toHaveBeenCalled();
    });

    it("keeps one name and carries the watch state on aria-pressed", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "working" })];
      mockWatchedPanels = new Set();
      const { unmount } = render(<BackgroundContainer />);
      const idle = screen.getByTestId("bg-watch-button");
      const idleName = idle.getAttribute("aria-label");
      expect(idle.getAttribute("aria-pressed")).toBe("false");
      unmount();
      mockWatchedPanels = new Set(["t1"]);
      render(<BackgroundContainer />);
      const watching = screen.getByTestId("bg-watch-button");
      expect(watching.getAttribute("aria-pressed")).toBe("true");
      expect(watching.getAttribute("aria-label")).toBe(idleName);
    });
  });

  describe("kill confirm flow", () => {
    it("opens the ConfirmDialog when kill is clicked, does not call removePanel yet", () => {
      mockTerminals = [makeTerminal({ id: "t1", title: "Fix auth" })];
      render(<BackgroundContainer />);
      expect(screen.queryByTestId("kill-confirm-dialog")).toBeNull();
      fireEvent.click(screen.getByTestId("bg-kill-button"));
      expect(screen.getByTestId("kill-confirm-dialog")).toBeTruthy();
      expect(screen.getByTestId("confirm-title").textContent).toBe("Kill terminal?");
      expect(removePanelMock).not.toHaveBeenCalled();
    });

    it("calls removePanel and closes the dialog when confirmed", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-kill-button"));
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
      expect(removePanelMock).toHaveBeenCalledWith("t1");
      expect(screen.queryByTestId("kill-confirm-dialog")).toBeNull();
    });

    it("does not call removePanel when the dialog is cancelled", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-kill-button"));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(removePanelMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("kill-confirm-dialog")).toBeNull();
    });
  });

  describe("restore action", () => {
    it("invokes restoreBackgroundTerminal and activateTerminal", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-restore-button"));
      expect(restoreBackgroundTerminalMock).toHaveBeenCalledWith("t1");
      expect(activateTerminalMock).toHaveBeenCalledWith("t1");
      expect(pingTerminalMock).toHaveBeenCalledWith("t1");
    });

    it("switches worktrees when restoring a terminal from a different worktree", () => {
      mockTerminals = [makeTerminal({ id: "t1", worktreeId: "wt-2" })];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-restore-button"));
      expect(trackTerminalFocusMock).toHaveBeenCalledWith("wt-2", "t1");
      expect(selectWorktreeMock).toHaveBeenCalledWith("wt-2");
    });

    it("does not switch worktrees when the terminal already belongs to the active worktree", () => {
      mockTerminals = [makeTerminal({ id: "t1", worktreeId: "wt-1" })];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-restore-button"));
      expect(selectWorktreeMock).not.toHaveBeenCalled();
    });
  });

  describe("popover dismiss guard during kill confirm", () => {
    it("does not prevent dismiss when no kill confirm is open", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<BackgroundContainer />);
      const preventDefault = vi.fn();
      popoverHandlers.onPointerDownOutside?.({ preventDefault });
      popoverHandlers.onInteractOutside?.({ preventDefault });
      popoverHandlers.onEscapeKeyDown?.({ preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(markEscapeYieldedMock).not.toHaveBeenCalled();
    });

    it("prevents dismiss when the kill confirm dialog is open", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<BackgroundContainer />);
      // Open kill confirm to enter the guarded state.
      fireEvent.click(screen.getByTestId("bg-kill-button"));
      expect(screen.getByTestId("kill-confirm-dialog")).toBeTruthy();

      focusInsideBackstopDialog();

      const pointer = { preventDefault: vi.fn() };
      const interact = { preventDefault: vi.fn() };
      const escape = { preventDefault: vi.fn() };
      popoverHandlers.onPointerDownOutside?.(pointer);
      popoverHandlers.onInteractOutside?.(interact);
      popoverHandlers.onEscapeKeyDown?.(escape);

      expect(pointer.preventDefault).toHaveBeenCalledTimes(1);
      expect(interact.preventDefault).toHaveBeenCalledTimes(1);
      expect(escape.preventDefault).toHaveBeenCalled();
      // Handed on to the confirm's backstop, or Escape closes nothing (#13081).
      expect(markEscapeYieldedMock).toHaveBeenCalledWith(escape);
    });

    it("keeps Escape from a surface it cannot hand the keypress to", () => {
      // Something above the confirm that the backstop does not manage: the
      // yield would close the confirm underneath it instead.
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByTestId("bg-kill-button"));
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      outside.focus();

      const escape = { preventDefault: vi.fn() };
      popoverHandlers.onEscapeKeyDown?.(escape);

      expect(escape.preventDefault).toHaveBeenCalled();
      expect(markEscapeYieldedMock).not.toHaveBeenCalled();
      outside.remove();
    });
  });

  describe("tab group default expansion", () => {
    it("renders tab groups expanded by default, matching the Waiting container", () => {
      const groupMetadata: TrashedTerminalGroupMetadata = {
        panelIds: ["t1", "t2"],
        activeTabId: "t1",
        location: "dock",
        worktreeId: "wt-1",
      };
      mockTerminals = [
        makeTerminal({ id: "t1", title: "claude" }),
        makeTerminal({ id: "t2", title: "gemini" }),
      ];
      mockBackgroundedTerminals = new Map([
        ["t1", { groupRestoreId: "g1", groupMetadata }],
        ["t2", { groupRestoreId: "g1", groupMetadata }],
      ]);
      render(<BackgroundContainer />);
      // Expanded by default → the toggle offers to collapse, not expand.
      expect(screen.getByRole("button", { name: "Collapse group" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Expand group" })).toBeNull();
    });

    it("counts only the group's unread Canopy ask as waiting, not its bare prompt", () => {
      const groupMetadata: TrashedTerminalGroupMetadata = {
        panelIds: ["t1", "t2"],
        activeTabId: "t1",
        location: "dock",
        worktreeId: "wt-1",
      };
      mockTerminals = [
        makeTerminal({ id: "t1", title: "claude", agentState: "waiting" }),
        makeTerminal({ id: "t2", title: "gemini", agentState: "waiting" }),
      ];
      mockBackgroundedTerminals = new Map([
        ["t1", { groupRestoreId: "g1", groupMetadata }],
        ["t2", { groupRestoreId: "g1", groupMetadata }],
      ]);
      deliverAsks(["t1"]);
      render(<BackgroundContainer />);
      const header = screen.getByRole("button", { name: "Collapse group" }).parentElement!;
      expect(header.textContent).toContain("· 1 waiting");
    });

    it("gives every member its own Restore, the row's keyboard target", () => {
      const groupMetadata: TrashedTerminalGroupMetadata = {
        panelIds: ["t1", "t2"],
        activeTabId: "t1",
        location: "dock",
        worktreeId: "wt-1",
      };
      mockTerminals = [
        makeTerminal({ id: "t1", title: "claude" }),
        makeTerminal({ id: "t2", title: "gemini" }),
      ];
      mockBackgroundedTerminals = new Map([
        ["t1", { groupRestoreId: "g1", groupMetadata }],
        ["t2", { groupRestoreId: "g1", groupMetadata }],
      ]);
      render(<BackgroundContainer />);
      for (const row of screen.getAllByTestId("background-single-item")) {
        const target = row.querySelector("[data-dock-row-target]");
        expect(target?.getAttribute("aria-label")).toMatch(/^Restore /);
      }
    });
  });

  describe("a panel that isn't a terminal", () => {
    it("shows the pill and counts it when it's the only backgrounded panel", () => {
      mockTerminals = [makeFilePanel()];
      const { container } = render(<BackgroundContainer />);
      expect(container.querySelector(".dock-status-pill")?.getAttribute("data-visible")).toBe(
        "true"
      );
      expect(screen.getByRole("button", { name: /^Background: 1 panel/ })).toBeTruthy();
    });

    it("counts alongside terminals, here and in other worktrees", () => {
      mockTerminals = [
        makeFilePanel({ id: "f1", worktreeId: "wt-1" }),
        makeFilePanel({ id: "f2", worktreeId: "wt-2" }),
        makeTerminal({ id: "t1", worktreeId: "wt-1" }),
      ];
      render(<BackgroundContainer />);
      expect(screen.getByRole("button", { name: /^Background: 3 panels/ })).toBeTruthy();
      expect(screen.getByText(/^3 panels across 2 worktrees/)).toBeTruthy();
      expect(screen.getAllByTestId("background-single-item")).toHaveLength(3);
    });

    it("offers no Watch, which only means something for an agent", () => {
      mockTerminals = [makeFilePanel()];
      render(<BackgroundContainer />);
      expect(screen.queryByTestId("bg-watch-button")).toBeNull();
      expect(screen.queryByTestId("live-time-ago")).toBeNull();
    });

    it("keeps Watch on a terminal listed beside it", () => {
      mockTerminals = [makeFilePanel(), makeTerminal({ id: "t1" })];
      render(<BackgroundContainer />);
      expect(screen.getAllByTestId("bg-watch-button")).toHaveLength(1);
    });

    it("keeps Restore the row's keyboard target without Watch beside it", () => {
      mockTerminals = [makeFilePanel()];
      render(<BackgroundContainer />);
      const target = screen
        .getByTestId("background-single-item")
        .querySelector("[data-dock-row-target]");
      expect(target?.getAttribute("aria-label")).toBe("Restore notes.md");
    });

    it("is never counted as waiting, whatever the fleet says about its id", () => {
      mockTerminals = [makeFilePanel()];
      deliverAsks(["f1"]);
      render(<BackgroundContainer />);
      expect(
        screen.getByRole("button", { name: /^Background: 1 panel/ }).textContent
      ).not.toContain("waiting");
    });

    it("falls back to its kind's name, not 'Terminal', when it has no title", () => {
      mockTerminals = [makeFilePanel({ title: "" })];
      render(<BackgroundContainer />);
      expect(screen.getByRole("button", { name: "Restore File viewer" })).toBeTruthy();
    });

    it("restores to its own worktree, as a terminal does", () => {
      mockTerminals = [makeFilePanel({ worktreeId: "wt-2" })];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByRole("button", { name: "Restore notes.md" }));
      expect(selectWorktreeMock).toHaveBeenCalledWith("wt-2");
      expect(trackTerminalFocusMock).toHaveBeenCalledWith("wt-2", "f1");
      expect(restoreBackgroundTerminalMock).toHaveBeenCalledWith("f1");
      expect(activateTerminalMock).toHaveBeenCalledWith("f1");
      expect(pingTerminalMock).toHaveBeenCalledWith("f1");
    });

    it("says Remove rather than Kill, and removes on confirm", () => {
      mockTerminals = [makeFilePanel()];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
      expect(screen.getByTestId("confirm-title").textContent).toBe("Remove 'notes.md'?");
      expect(removePanelMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Remove panel" }));
      expect(removePanelMock).toHaveBeenCalledWith("f1");
      expect(screen.queryByTestId("kill-confirm-dialog")).toBeNull();
    });

    it("keeps a terminal's Kill wording beside it", () => {
      mockTerminals = [makeFilePanel(), makeTerminal({ id: "t1", title: "claude" })];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByRole("button", { name: "Kill claude" }));
      expect(screen.getByTestId("confirm-title").textContent).toBe("Kill terminal?");
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
      expect(removePanelMock).toHaveBeenCalledWith("t1");
    });

    it("keeps a panel with unsaved work when its prompt is cancelled", async () => {
      const guard = vi.fn(async () => "cancel" as const);
      registerPanelCloseGuard("f1", guard);
      mockTerminals = [makeFilePanel()];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
      // The prompt is the confirmation: a second one in front of it asks twice.
      expect(screen.queryByTestId("kill-confirm-dialog")).toBeNull();
      await act(async () => {
        await Promise.resolve();
      });
      expect(guard).toHaveBeenCalledTimes(1);
      expect(removePanelMock).not.toHaveBeenCalled();
    });

    it("removes a panel with unsaved work once its prompt says to", async () => {
      registerPanelCloseGuard("f1", async () => "proceed");
      mockTerminals = [makeFilePanel()];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
      await vi.waitFor(() => expect(removePanelMock).toHaveBeenCalledWith("f1"));
    });

    it("holds the popover open behind the prompt, then lets it go", async () => {
      let answer!: (verdict: "proceed" | "cancel") => void;
      const guard = vi.fn(
        () =>
          new Promise<"proceed" | "cancel">((resolve) => {
            answer = resolve;
          })
      );
      registerPanelCloseGuard("f1", guard);
      mockTerminals = [makeFilePanel()];
      render(<BackgroundContainer />);
      fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
      await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(1));

      const whileUp = vi.fn();
      popoverHandlers.onPointerDownOutside?.({ preventDefault: whileUp });
      expect(whileUp).toHaveBeenCalledTimes(1);

      await act(async () => {
        answer("cancel");
        await Promise.resolve();
      });

      const afterwards = vi.fn();
      popoverHandlers.onPointerDownOutside?.({ preventDefault: afterwards });
      expect(afterwards).not.toHaveBeenCalled();
    });

    it("asks once when Remove is pressed again while the prompt is up", async () => {
      let answer!: (verdict: "proceed" | "cancel") => void;
      const guard = vi.fn(
        () =>
          new Promise<"proceed" | "cancel">((resolve) => {
            answer = resolve;
          })
      );
      registerPanelCloseGuard("f1", guard);
      mockTerminals = [makeFilePanel()];
      render(<BackgroundContainer />);
      const remove = screen.getByRole("button", { name: "Remove notes.md" });
      fireEvent.click(remove);
      await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(1));
      fireEvent.click(remove);
      await act(async () => {
        answer("proceed");
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(removePanelMock).toHaveBeenCalledTimes(1));
      expect(guard).toHaveBeenCalledTimes(1);
    });

    it("groups with a terminal it shared tabs with, and restores with it", () => {
      const groupMetadata: TrashedTerminalGroupMetadata = {
        panelIds: ["f1", "t1"],
        activeTabId: "f1",
        location: "grid",
        worktreeId: "wt-1",
      };
      mockTerminals = [makeFilePanel(), makeTerminal({ id: "t1" })];
      mockBackgroundedTerminals = new Map([
        ["f1", { groupRestoreId: "g1", groupMetadata }],
        ["t1", { groupRestoreId: "g1", groupMetadata }],
      ]);
      render(<BackgroundContainer />);
      expect(screen.getByText(/Tab group \(2 tabs\)/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Restore all" }));
      expect(restoreBackgroundGroupMock).toHaveBeenCalledWith("g1");
      expect(activateTerminalMock).toHaveBeenCalledWith("f1");
    });

    it("reads a group of non-terminal tabs as one group", () => {
      const groupMetadata: TrashedTerminalGroupMetadata = {
        panelIds: ["f1", "f2"],
        activeTabId: "f2",
        location: "grid",
        worktreeId: "wt-1",
      };
      mockTerminals = [makeFilePanel({ id: "f1" }), makeFilePanel({ id: "f2", title: "todo.md" })];
      mockBackgroundedTerminals = new Map([
        ["f1", { groupRestoreId: "g1", groupMetadata }],
        ["f2", { groupRestoreId: "g1", groupMetadata }],
      ]);
      render(<BackgroundContainer />);
      expect(screen.getByRole("region", { name: "Group panels" })).toBeTruthy();
      expect(screen.queryByTestId("bg-watch-button")).toBeNull();
    });
  });
});
