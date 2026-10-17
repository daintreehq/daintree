// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";
import type { TabGroup, AgentState } from "@/types";

const activateTerminalMock = vi.fn();
const pingTerminalMock = vi.fn();
const removePanelMock = vi.fn();
const setActiveTabMock = vi.fn();
const selectWorktreeMock = vi.fn();
const trackTerminalFocusMock = vi.fn();

let mockTerminals: PtyPanelData[] = [];
let mockTabGroups = new Map<string, TabGroup>();

vi.mock("@/hooks/useTerminalSelectors", () => ({
  useUnreadTerminals: () => mockTerminals,
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
      tabGroups: mockTabGroups,
      activateTerminal: activateTerminalMock,
      pingTerminal: pingTerminalMock,
      removePanel: removePanelMock,
      setActiveTab: setActiveTabMock,
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

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-testid="terminal-icon" />,
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
    id,
    onPointerDownOutside,
    onInteractOutside,
    onEscapeKeyDown,
  }: {
    children: React.ReactNode;
    id?: string;
    onPointerDownOutside?: DismissHandler;
    onInteractOutside?: DismissHandler;
    onEscapeKeyDown?: DismissHandler;
  }) => {
    popoverHandlers.onPointerDownOutside = onPointerDownOutside;
    popoverHandlers.onInteractOutside = onInteractOutside;
    popoverHandlers.onEscapeKeyDown = onEscapeKeyDown;
    return (
      <div data-testid="popover-content" id={id}>
        {children}
      </div>
    );
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

import { UnreadContainer } from "../UnreadContainer";

function makeTerminal(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "t1",
    kind: "terminal",
    title: "claude",
    location: "grid",
    worktreeId: "wt-1",
    agentState: "completed" as AgentState,
    lastStateChange: 1700000000000,
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    ...overrides,
  } as PtyPanelData;
}

beforeEach(() => {
  markEscapeYieldedMock.mockReset();
  activateTerminalMock.mockReset();
  pingTerminalMock.mockReset();
  removePanelMock.mockReset();
  setActiveTabMock.mockReset();
  selectWorktreeMock.mockReset();
  trackTerminalFocusMock.mockReset();
  mockTerminals = [];
  mockTabGroups = new Map();
});

describe("UnreadContainer", () => {
  it("stays mounted but hidden with nothing unread", () => {
    const { container } = render(<UnreadContainer />);
    expect(container.querySelector(".dock-status-pill")?.getAttribute("data-visible")).toBe(
      "false"
    );
  });

  it("counts unread hand-backs project-wide and names this worktree's share", () => {
    mockTerminals = [makeTerminal({ id: "t1" }), makeTerminal({ id: "t2", worktreeId: "wt-2" })];
    const { container } = render(<UnreadContainer />);
    expect(container.querySelector(".dock-status-pill")?.getAttribute("data-visible")).toBe("true");
    const trigger = screen.getByRole("button", {
      name: "Unread: 2 agents across all worktrees, 1 in this one",
    });
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).not.toBe("waiting-container-popover");
    expect(document.getElementById(controls!)?.getAttribute("data-testid")).toBe("popover-content");
  });

  it("names no reason on a row, even when the wait underneath is a question", () => {
    mockTerminals = [
      makeTerminal({
        id: "t1",
        agentState: "waiting",
        waitingReason: "question",
        activityHeadline: "Asked a question",
      }),
    ];
    render(<UnreadContainer />);

    expect(screen.queryByTestId("waiting-reason-badge-t1")).toBeNull();
    const row = screen.getByTestId("unread-single-item");
    expect(row.getAttribute("aria-label")).toBe("Focus claude");
    expect(row.textContent).not.toContain("Asked a question");
    // The observation itself still rides on the row.
    expect(row.getAttribute("data-waiting-reason")).toBe("question");
  });

  it("lists the longest-unread first rather than ranking by reason", () => {
    mockTerminals = [
      makeTerminal({
        id: "newer-question",
        title: "newer",
        agentState: "waiting",
        waitingReason: "question",
        lastStateChange: 1700000005000,
      }),
      makeTerminal({ id: "older", title: "older", lastStateChange: 1700000001000 }),
    ];
    render(<UnreadContainer />);

    const titles = screen
      .getAllByTestId("unread-single-item")
      .map((row) => row.getAttribute("aria-label"));
    expect(titles).toEqual(["Focus older", "Focus newer"]);
  });

  it("gathers a tab group's unread members under one header, still naming no reason", () => {
    mockTerminals = [
      makeTerminal({ id: "t1" }),
      makeTerminal({ id: "t2", title: "codex", agentState: "waiting", waitingReason: "question" }),
    ];
    mockTabGroups = new Map([
      [
        "g1",
        {
          id: "g1",
          location: "grid",
          worktreeId: "wt-1",
          activeTabId: "t1",
          panelIds: ["t1", "t2"],
        } as TabGroup,
      ],
    ]);
    render(<UnreadContainer />);

    const header = screen.getByRole("button", { name: /Tab group \(2 unread\)/ });
    const region = document.getElementById(header.getAttribute("aria-controls")!);
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.querySelectorAll('[data-testid="unread-single-item"]')).toHaveLength(2);
    expect(screen.queryByTestId("waiting-reason-badge-t2")).toBeNull();
    expect(screen.getByRole("button", { name: "Focus codex" })).toBeTruthy();
  });

  it("focuses the hand-back it was opened for", () => {
    mockTerminals = [makeTerminal({ id: "t1", worktreeId: "wt-2" })];
    render(<UnreadContainer />);

    fireEvent.click(screen.getByTestId("unread-single-item"));
    expect(trackTerminalFocusMock).toHaveBeenCalledWith("wt-2", "t1");
    expect(selectWorktreeMock).toHaveBeenCalledWith("wt-2");
    expect(activateTerminalMock).toHaveBeenCalledWith("t1");
  });
});
