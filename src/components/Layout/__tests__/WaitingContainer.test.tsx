// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TerminalInstance } from "@/store";
import type { TabGroup, AgentState } from "@/types";

const activateTerminalMock = vi.fn();
const pingTerminalMock = vi.fn();
const removePanelMock = vi.fn();
const setActiveTabMock = vi.fn();
const selectWorktreeMock = vi.fn();
const trackTerminalFocusMock = vi.fn();

let mockTerminals: TerminalInstance[] = [];
let mockTabGroups = new Map<string, TabGroup>();

vi.mock("@/hooks/useTerminalSelectors", () => ({
  useWaitingTerminals: () => mockTerminals,
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

import { WaitingContainer } from "../WaitingContainer";

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t1",
    kind: "terminal",
    title: "claude",
    location: "grid",
    worktreeId: "wt-1",
    agentState: "waiting" as AgentState,
    lastStateChange: 1700000000000,
    ...overrides,
  } as TerminalInstance;
}

function makeGroup(overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id: "g1",
    location: "grid",
    worktreeId: "wt-1",
    activeTabId: "t1",
    panelIds: ["t1", "t2"],
    ...overrides,
  };
}

beforeEach(() => {
  activateTerminalMock.mockReset();
  pingTerminalMock.mockReset();
  removePanelMock.mockReset();
  setActiveTabMock.mockReset();
  selectWorktreeMock.mockReset();
  trackTerminalFocusMock.mockReset();
  popoverHandlers.onPointerDownOutside = undefined;
  popoverHandlers.onInteractOutside = undefined;
  popoverHandlers.onEscapeKeyDown = undefined;
  mockTerminals = [];
  mockTabGroups = new Map();
});

describe("WaitingContainer", () => {
  it("renders nothing when there are no waiting terminals", () => {
    const { container } = render(<WaitingContainer />);
    expect(container.textContent).toBe("");
  });

  describe("trigger", () => {
    it("renders HollowCircle (simple circle SVG) not AlertCircle", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      const { container } = render(<WaitingContainer />);
      const svgs = container.querySelectorAll("svg");
      expect(svgs.length).toBeGreaterThan(0);

      const hasHollowCircle = Array.from(svgs).some((svg) => {
        const circles = svg.querySelectorAll("circle");
        return (
          circles.length === 1 &&
          circles[0]!.getAttribute("cx") === "8" &&
          circles[0]!.getAttribute("cy") === "8" &&
          circles[0]!.getAttribute("r") === "6"
        );
      });
      expect(hasHollowCircle).toBe(true);
    });

    it("shows the waiting count in the trigger label", () => {
      mockTerminals = [
        makeTerminal({ id: "t1" }),
        makeTerminal({ id: "t2" }),
        makeTerminal({ id: "t3" }),
      ];
      render(<WaitingContainer />);
      const trigger = screen.getByRole("button", { name: "Waiting (3)" });
      expect(trigger).toBeTruthy();
    });
  });

  describe("row metadata", () => {
    it("renders worktree name, state label, headline, and live time", () => {
      mockTerminals = [
        makeTerminal({
          id: "t1",
          title: "Fix auth bug",
          activityHeadline: "Awaiting permission",
          lastStateChange: 1700000000123,
        }),
      ];
      render(<WaitingContainer />);
      const row = screen.getByTestId("waiting-single-item");
      const text = row.textContent ?? "";
      expect(text).toContain("Fix auth bug");
      expect(text).toContain("feature-auth");
      expect(text).toContain("waiting");
      expect(text).toContain("Awaiting permission");
      expect(within(row).getByTestId("live-time-ago")).toBeTruthy();
    });

    it("uses a transparent border placeholder (no amber tint on every row)", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      const row = screen.getByTestId("waiting-single-item");
      expect(row.className).toContain("border-l-2");
      expect(row.className).toContain("border-l-transparent");
      expect(row.className).not.toContain("color-activity-waiting");
      expect(row.className).not.toContain("panel-state-waiting");
    });

    it("does not render a watch button", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      expect(screen.queryByTestId("bg-watch-button")).toBeNull();
      expect(screen.queryByTestId("waiting-watch-button")).toBeNull();
    });

    it("does not nest a <button> inside a <button> (invalid HTML)", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      const { container } = render(<WaitingContainer />);
      const nested = container.querySelectorAll("button button");
      expect(nested.length).toBe(0);
    });

    it("exposes the row as a button via role + tabIndex (not a native <button>)", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      const row = screen.getByTestId("waiting-single-item");
      expect(row.tagName).toBe("DIV");
      expect(row.getAttribute("role")).toBe("button");
      expect(row.getAttribute("tabindex")).toBe("0");
    });
  });

  describe("row activation", () => {
    it("activates a single (non-grouped) terminal without setActiveTab", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      fireEvent.click(screen.getByTestId("waiting-single-item"));
      expect(activateTerminalMock).toHaveBeenCalledWith("t1");
      expect(pingTerminalMock).toHaveBeenCalledWith("t1");
      expect(setActiveTabMock).not.toHaveBeenCalled();
    });

    it("switches worktrees when activating a terminal from another worktree", () => {
      mockTerminals = [makeTerminal({ id: "t1", worktreeId: "wt-2" })];
      render(<WaitingContainer />);
      fireEvent.click(screen.getByTestId("waiting-single-item"));
      expect(trackTerminalFocusMock).toHaveBeenCalledWith("wt-2", "t1");
      expect(selectWorktreeMock).toHaveBeenCalledWith("wt-2");
    });

    it("does not switch worktrees when the terminal belongs to the active worktree", () => {
      mockTerminals = [makeTerminal({ id: "t1", worktreeId: "wt-1" })];
      render(<WaitingContainer />);
      fireEvent.click(screen.getByTestId("waiting-single-item"));
      expect(selectWorktreeMock).not.toHaveBeenCalled();
    });
  });

  describe("kill confirm flow", () => {
    it("opens the ConfirmDialog when kill is clicked, does not call removePanel yet", () => {
      mockTerminals = [makeTerminal({ id: "t1", title: "Fix auth" })];
      render(<WaitingContainer />);
      expect(screen.queryByTestId("kill-confirm-dialog")).toBeNull();
      fireEvent.click(screen.getByTestId("waiting-kill-button"));
      expect(screen.getByTestId("kill-confirm-dialog")).toBeTruthy();
      expect(removePanelMock).not.toHaveBeenCalled();
    });

    it("calls removePanel and closes the dialog when confirmed", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      fireEvent.click(screen.getByTestId("waiting-kill-button"));
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
      expect(removePanelMock).toHaveBeenCalledWith("t1");
      expect(screen.queryByTestId("kill-confirm-dialog")).toBeNull();
    });

    it("does not call removePanel when the dialog is cancelled", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      fireEvent.click(screen.getByTestId("waiting-kill-button"));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(removePanelMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("kill-confirm-dialog")).toBeNull();
    });

    it("does not bubble the kill click through to the row activation handler", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      fireEvent.click(screen.getByTestId("waiting-kill-button"));
      expect(activateTerminalMock).not.toHaveBeenCalled();
    });
  });

  describe("tab-group rendering", () => {
    it("groups multiple waiting members of the same tab group under a group row", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", title: "A" }),
        makeTerminal({ id: "t2", title: "B" }),
      ];
      mockTabGroups = new Map([["g1", makeGroup({ panelIds: ["t1", "t2"] })]]);
      render(<WaitingContainer />);
      const rows = screen.getAllByTestId("waiting-single-item");
      expect(rows.length).toBe(2);
      expect(screen.getByRole("button", { name: "Collapse group" })).toBeTruthy();
    });

    it("falls through to a single row when the group has only one waiting member", () => {
      mockTerminals = [makeTerminal({ id: "t1", title: "A" })];
      mockTabGroups = new Map([["g1", makeGroup({ panelIds: ["t1", "t-other"] })]]);
      render(<WaitingContainer />);
      expect(screen.queryByRole("button", { name: /group/i })).toBeNull();
      expect(screen.getAllByTestId("waiting-single-item").length).toBe(1);
    });

    it("collapses and expands a group row when the chevron is clicked", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", title: "A" }),
        makeTerminal({ id: "t2", title: "B" }),
      ];
      mockTabGroups = new Map([["g1", makeGroup({ panelIds: ["t1", "t2"] })]]);
      render(<WaitingContainer />);
      expect(screen.getAllByTestId("waiting-single-item").length).toBe(2);
      fireEvent.click(screen.getByRole("button", { name: "Collapse group" }));
      expect(screen.queryAllByTestId("waiting-single-item").length).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Expand group" }));
      expect(screen.getAllByTestId("waiting-single-item").length).toBe(2);
    });

    it("calls setActiveTab BEFORE activateTerminal for grouped panels", () => {
      mockTerminals = [
        makeTerminal({ id: "t1", title: "A" }),
        makeTerminal({ id: "t2", title: "B" }),
      ];
      mockTabGroups = new Map([["g1", makeGroup({ panelIds: ["t1", "t2"] })]]);

      const callOrder: string[] = [];
      setActiveTabMock.mockImplementation(() => callOrder.push("setActiveTab"));
      activateTerminalMock.mockImplementation(() => callOrder.push("activateTerminal"));

      render(<WaitingContainer />);
      const rows = screen.getAllByTestId("waiting-single-item");
      fireEvent.click(rows[0]!);

      expect(setActiveTabMock).toHaveBeenCalledWith("g1", "t1");
      expect(activateTerminalMock).toHaveBeenCalledWith("t1");
      expect(callOrder).toEqual(["setActiveTab", "activateTerminal"]);
    });

    it("does not call setActiveTab for ungrouped panels", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      fireEvent.click(screen.getByTestId("waiting-single-item"));
      expect(setActiveTabMock).not.toHaveBeenCalled();
    });

    it("renders independent collapse state across multiple groups", () => {
      mockTerminals = [
        makeTerminal({ id: "a1" }),
        makeTerminal({ id: "a2" }),
        makeTerminal({ id: "b1" }),
        makeTerminal({ id: "b2" }),
      ];
      mockTabGroups = new Map([
        ["gA", makeGroup({ id: "gA", panelIds: ["a1", "a2"], activeTabId: "a1" })],
        ["gB", makeGroup({ id: "gB", panelIds: ["b1", "b2"], activeTabId: "b1" })],
      ]);
      render(<WaitingContainer />);
      expect(screen.getAllByTestId("waiting-single-item").length).toBe(4);
      const collapseButtons = screen.getAllByRole("button", { name: "Collapse group" });
      expect(collapseButtons.length).toBe(2);
      fireEvent.click(collapseButtons[0]!);
      expect(screen.getAllByTestId("waiting-single-item").length).toBe(2);
    });
  });

  describe("popover dismiss guard during kill confirm", () => {
    it("does not prevent dismiss when no kill confirm is open", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      const preventDefault = vi.fn();
      popoverHandlers.onPointerDownOutside?.({ preventDefault });
      popoverHandlers.onInteractOutside?.({ preventDefault });
      popoverHandlers.onEscapeKeyDown?.({ preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("prevents dismiss when the kill confirm dialog is open", () => {
      mockTerminals = [makeTerminal({ id: "t1" })];
      render(<WaitingContainer />);
      fireEvent.click(screen.getByTestId("waiting-kill-button"));
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
