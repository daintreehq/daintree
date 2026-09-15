// @vitest-environment jsdom
/**
 * The agent state glyph's home is the far right of the pane header, past the
 * close button, in a box that never moves. #12378 once folded it into the
 * metadata row by accident, so this renders the real ContentPanel wiring —
 * PanelHeader, TerminalHeaderContent and TerminalAgentIndicator unmocked — and
 * pins where the glyph actually lands.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";
import type { TabInfo } from "../TabButton";
import type { TerminalChromeDescriptor } from "@/utils/terminalChrome";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Layout/useDockBlockedState", () => ({
  useDockBlockedState: () => null,
}));

const chrome: TerminalChromeDescriptor = {
  iconId: null,
  label: "Shell",
  isAgent: false,
  agentId: null,
  processId: null,
  runtimeKind: "process",
  hasExited: false,
};

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => chrome,
}));

vi.mock("@/components/Terminal/SubagentChip", () => ({
  SubagentChip: () => null,
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (
    selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: true }),
  usePanelStore: (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
    selector({ panelsById: { "t-1": { id: "t-1", kind: "terminal" } } }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

import { ContentPanel } from "../ContentPanel";

afterEach(cleanup);

const agentChrome: TerminalChromeDescriptor = {
  ...chrome,
  label: "Claude",
  isAgent: true,
  agentId: "claude",
  runtimeKind: "agent",
};

function panel(props: {
  agentState?: AgentState;
  agentId?: string;
  kind?: "terminal" | "browser";
  tabs?: TabInfo[];
  completedWithNoChanges?: boolean;
}) {
  return (
    <ContentPanel
      id="t-1"
      title="Panel"
      kind={props.kind ?? "terminal"}
      agentId={props.agentId}
      isFocused
      onFocus={() => {}}
      onClose={() => {}}
      onToggleMaximize={() => {}}
      agentState={props.agentState}
      completedWithNoChanges={props.completedWithNoChanges}
      tabs={props.tabs}
      onTabClick={props.tabs ? () => {} : undefined}
    >
      <div data-testid="panel-body" />
    </ContentPanel>
  );
}

const agentGlyphs = () =>
  screen
    .queryAllByRole("status")
    .filter((el) => (el.getAttribute("aria-label") ?? "").startsWith("Agent state:"));

describe("ContentPanel agent glyph placement", () => {
  it("renders the glyph once, in the far-right box past the close button", () => {
    render(panel({ agentId: "claude", agentState: "working" }));

    const glyphs = agentGlyphs();
    expect(glyphs).toHaveLength(1);
    const glyph = glyphs[0]!;
    const box = screen.getByTestId("panel-header-agent-indicator");
    const close = screen.getByTestId("panel-close");

    expect(box.contains(glyph)).toBe(true);
    expect(screen.getByTestId("panel-header-content").contains(glyph)).toBe(false);
    expect(screen.getByTestId("panel-header-status").contains(glyph)).toBe(false);
    expect(screen.getByTestId("panel-header-controls").contains(glyph)).toBe(false);
    expect(close.compareDocumentPosition(glyph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("panel-header-controls").nextElementSibling).toBe(box);
  });

  it("keeps the box and the controls put while the glyph comes and goes", () => {
    const { rerender } = render(panel({ agentId: "claude" }));
    const box = screen.getByTestId("panel-header-agent-indicator");
    const controls = screen.getByTestId("panel-header-controls").innerHTML;
    expect(agentGlyphs()).toHaveLength(0);
    expect(box.childElementCount).toBe(0);

    rerender(panel({ agentId: "claude", agentState: "working" }));
    expect(screen.getByTestId("panel-header-agent-indicator")).toBe(box);
    expect(box.contains(agentGlyphs()[0]!)).toBe(true);
    expect(screen.getByTestId("panel-header-controls").innerHTML).toBe(controls);

    rerender(panel({ agentId: "claude", agentState: "waiting" }));
    expect(box.contains(agentGlyphs()[0]!)).toBe(true);

    rerender(panel({ agentId: "claude" }));
    expect(screen.getByTestId("panel-header-agent-indicator")).toBe(box);
    expect(box.childElementCount).toBe(0);
    expect(screen.getByTestId("panel-header-controls").innerHTML).toBe(controls);
  });

  it("keeps both trailing boxes while a mixed group shows its browser tab", () => {
    const tabs: TabInfo[] = [
      { id: "t-1", title: "Browser", kind: "browser", chrome, isActive: true },
      { id: "t-2", title: "Claude", kind: "terminal", chrome: agentChrome, isActive: false },
    ];
    render(panel({ kind: "browser", tabs }));

    expect(screen.getByTestId("panel-header-status").childElementCount).toBe(0);
    expect(screen.getByTestId("panel-header-agent-indicator").childElementCount).toBe(0);
  });

  it("reserves no glyph box for a plain terminal", () => {
    render(panel({}));

    expect(screen.queryByTestId("panel-header-status")).not.toBeNull();
    expect(screen.queryByTestId("panel-header-agent-indicator")).toBeNull();
  });

  it("keeps the glyph box for a group whose launched agent has exited", () => {
    const exitedChrome: TerminalChromeDescriptor = { ...chrome, hasExited: true };
    const tabs: TabInfo[] = [
      { id: "t-1", title: "Shell", kind: "terminal", chrome, isActive: true },
      {
        id: "t-2",
        title: "Claude",
        kind: "terminal",
        chrome: exitedChrome,
        launchAgentId: "claude",
        isActive: false,
      },
    ];
    render(panel({ tabs }));

    expect(screen.getByTestId("panel-header-agent-indicator").childElementCount).toBe(0);
  });

  it("shows the glyph while agent state arrives ahead of identity", () => {
    render(panel({ agentState: "working" }));

    const box = screen.getByTestId("panel-header-agent-indicator");
    expect(box.contains(agentGlyphs()[0]!)).toBe(true);
  });

  it("reserves no glyph box for a group of plain terminals", () => {
    const tabs: TabInfo[] = [
      { id: "t-1", title: "One", kind: "terminal", chrome, isActive: true },
      { id: "t-2", title: "Two", kind: "terminal", chrome, isActive: false },
    ];
    render(panel({ tabs }));

    expect(screen.queryByTestId("panel-header-agent-indicator")).toBeNull();
  });

  it("reserves no boxes for a lone non-terminal pane", () => {
    render(panel({ kind: "browser" }));

    expect(screen.queryByTestId("panel-header-status")).toBeNull();
    expect(screen.queryByTestId("panel-header-agent-indicator")).toBeNull();
  });

  it("hands the metadata row the lifecycle state, not the glyph's display state", () => {
    // The glyph folds `completed` into `waiting` on purpose (the CLI is still
    // alive and idle). The row's settled trace — cost, "Finished, no changes" —
    // keys off the lifecycle state and must still be reachable.
    render(panel({ agentState: "completed", completedWithNoChanges: true }));
    expect(screen.queryByText("Finished, no changes")).not.toBeNull();
  });

  it("names the body as the tab panel of the active tab in a tab group", () => {
    const tabs: TabInfo[] = [
      { id: "t-1", title: "One", kind: "terminal", chrome, isActive: true },
      { id: "t-2", title: "Two", kind: "terminal", chrome, isActive: false },
    ];
    render(panel({ tabs }));
    const tabpanel = screen.getByRole("tabpanel");
    const active = screen.getByRole("tab", { selected: true });
    expect(tabpanel.getAttribute("aria-labelledby")).toBe(active.id);
    expect(active.getAttribute("aria-controls")).toBe(tabpanel.id);
  });
});
