// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TerminalInstance } from "@/store";
import type { AgentState } from "@/types";

const watchPanelMock = vi.fn();
const unwatchPanelMock = vi.fn();
const removePanelMock = vi.fn();
const restoreBackgroundTerminalMock = vi.fn();
const activateTerminalMock = vi.fn();
const pingTerminalMock = vi.fn();
const fireWatchNotificationMock = vi.fn();
const selectWorktreeMock = vi.fn();
const trackTerminalFocusMock = vi.fn();

let mockTerminals: TerminalInstance[] = [];
let mockBackgroundedTerminals = new Map<string, { groupRestoreId?: string }>();
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
    ...props
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
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

import { BackgroundContainer } from "../BackgroundContainer";

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t1",
    kind: "terminal",
    title: "claude",
    location: "background",
    worktreeId: "wt-1",
    agentState: "idle" as AgentState,
    lastStateChange: 1700000000000,
    ...overrides,
  } as TerminalInstance;
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
  it("renders nothing when there are no backgrounded terminals", () => {
    const { container } = render(<BackgroundContainer />);
    expect(container.textContent).toBe("");
  });

  describe("trigger label", () => {
    it("shows only the count when no terminals are waiting", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", agentState: "idle" }),
        makeTerminal({ id: "t2", agentState: "working" }),
        makeTerminal({ id: "t3", agentState: "completed" }),
      ];
      render(<BackgroundContainer />);
      const trigger = screen.getByRole("button", { name: /Background \(3\)/ });
      expect(trigger).toBeTruthy();
      expect(trigger.getAttribute("aria-label")).toBe("Background (3)");
    });

    it("appends waiting count when terminals are waiting", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", agentState: "waiting" }),
        makeTerminal({ id: "t2", agentState: "waiting" }),
        makeTerminal({ id: "t3", agentState: "working" }),
      ];
      render(<BackgroundContainer />);
      const trigger = screen.getByRole("button", {
        name: /Background \(3 · 2 waiting\)/,
      });
      expect(trigger).toBeTruthy();
      expect(trigger.getAttribute("aria-label")).toBe("Background (3 · 2 waiting)");
    });
  });

  describe("row metadata", () => {
    it("renders worktree name, state label, headline, and live time", () => {
      mockTerminals = [
        makeTerminal({
          id: "t1",
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
      expect(text).toContain("feature-auth");
      expect(text).toContain("waiting");
      expect(text).toContain("Awaiting permission");
      expect(within(row).getByTestId("live-time-ago")).toBeTruthy();
    });

    it("uses ambient border + tint for waiting state, not panel-state classes", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "waiting" })];
      render(<BackgroundContainer />);
      const row = screen.getByTestId("background-single-item");
      expect(row.className).toContain("border-l-2");
      expect(row.className).toContain("border-l-[color:var(--color-activity-waiting)]");
      expect(row.className).toContain(
        "bg-[color-mix(in_oklab,var(--color-activity-waiting)_8%,transparent)]"
      );
      expect(row.className).not.toContain("panel-state-waiting");
    });

    it("uses working ambient styling without panel-state classes", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "working" })];
      render(<BackgroundContainer />);
      const row = screen.getByTestId("background-single-item");
      expect(row.className).toContain("border-l-[color:var(--color-activity-working)]");
      expect(row.className).not.toContain("panel-state-working");
    });

    it("uses a transparent border placeholder for passive states (no layout shift)", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "idle" })];
      render(<BackgroundContainer />);
      const row = screen.getByTestId("background-single-item");
      expect(row.className).toContain("border-l-2");
      expect(row.className).toContain("border-l-transparent");
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

    it("uses a state-matched aria-label so screen readers announce the toggle target", () => {
      mockTerminals = [makeTerminal({ id: "t1", agentState: "working" })];
      mockWatchedPanels = new Set();
      const { unmount } = render(<BackgroundContainer />);
      expect(screen.getByTestId("bg-watch-button").getAttribute("aria-label")).toBe(
        "Watch for completion"
      );
      unmount();
      mockWatchedPanels = new Set(["t1"]);
      render(<BackgroundContainer />);
      expect(screen.getByTestId("bg-watch-button").getAttribute("aria-label")).toBe(
        "Stop watching"
      );
    });
  });

  describe("kill confirm flow", () => {
    it("opens the ConfirmDialog when kill is clicked, does not call removePanel yet", () => {
      mockTerminals = [makeTerminal({ id: "t1", title: "Fix auth" })];
      render(<BackgroundContainer />);
      expect(screen.queryByTestId("kill-confirm-dialog")).toBeNull();
      fireEvent.click(screen.getByTestId("bg-kill-button"));
      expect(screen.getByTestId("kill-confirm-dialog")).toBeTruthy();
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
});
