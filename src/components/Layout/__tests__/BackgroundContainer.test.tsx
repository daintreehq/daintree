// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import type { AgentState } from "@/types";
import type { TrashedTerminalGroupMetadata } from "@/store/slices";

const watchPanelMock = vi.fn();
const unwatchPanelMock = vi.fn();
const removePanelMock = vi.fn();
const restoreBackgroundTerminalMock = vi.fn();
const activateTerminalMock = vi.fn();
const pingTerminalMock = vi.fn();
const fireWatchNotificationMock = vi.fn();
const selectWorktreeMock = vi.fn();
const trackTerminalFocusMock = vi.fn();

let mockTerminals: PtyPanelData[] = [];
let mockBackgroundedTerminals = new Map<
  string,
  { groupRestoreId?: string; groupMetadata?: TrashedTerminalGroupMetadata }
>();
let mockWatchedPanels = new Set<string>();

vi.mock("@/hooks/useTerminalSelectors", () => ({
  useBackgroundedTerminals: () => mockTerminals,
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({
    worktreeMap: new Map([
      ["wt-1", { id: "wt-1", name: "feature-auth" }],
      ["wt-2", { id: "wt-2", name: "feature-ui" }],
    ]),
  }),
}));

vi.mock("@/store", () => ({
  usePanelStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      backgroundedTerminals: mockBackgroundedTerminals,
      watchedPanels: mockWatchedPanels,
      restoreBackgroundTerminal: restoreBackgroundTerminalMock,
      restoreBackgroundGroup: vi.fn(),
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
  deriveTerminalChrome: () => ({
    iconId: null,
    label: "Terminal",
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
  watchPanelMock.mockReset();
  unwatchPanelMock.mockReset();
  removePanelMock.mockReset();
  restoreBackgroundTerminalMock.mockReset();
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
});

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

    it("appends waiting count when terminals are waiting", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", agentState: "waiting" }),
        makeTerminal({ id: "t2", agentState: "waiting" }),
        makeTerminal({ id: "t3", agentState: "working" }),
      ];
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
          activityHeadline: "Awaiting permission",
          lastStateChange: 1700000000123,
        }),
      ];
      render(<BackgroundContainer />);
      const row = screen.getByTestId("background-single-item");
      const text = row.textContent ?? "";
      expect(text).toContain("Fix auth bug");
      expect(text).toContain("feature-ui");
      expect(text).toContain("waiting");
      expect(text).toContain("Awaiting permission");
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
      render(<BackgroundContainer />);
      const rows = screen.getAllByTestId("background-single-item");
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.className)).size).toBe(1);
      for (const row of rows) expect(row.className).not.toMatch(/panel-state-|border-l-/);
      expect(screen.getAllByText(/waiting/i).length).toBeGreaterThan(0);
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
    });

    it("prevents dismiss when the kill confirm dialog is open", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<BackgroundContainer />);
      // Open kill confirm to enter the guarded state.
      fireEvent.click(screen.getByTestId("bg-kill-button"));
      expect(screen.getByTestId("kill-confirm-dialog")).toBeTruthy();

      const pointer = { preventDefault: vi.fn() };
      const interact = { preventDefault: vi.fn() };
      const escape = { preventDefault: vi.fn() };
      popoverHandlers.onPointerDownOutside?.(pointer);
      popoverHandlers.onInteractOutside?.(interact);
      popoverHandlers.onEscapeKeyDown?.(escape);

      expect(pointer.preventDefault).toHaveBeenCalledTimes(1);
      expect(interact.preventDefault).toHaveBeenCalledTimes(1);
      expect(escape.preventDefault).toHaveBeenCalledTimes(1);
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
});
