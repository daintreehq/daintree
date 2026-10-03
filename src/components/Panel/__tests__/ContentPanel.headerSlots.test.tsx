// @vitest-environment jsdom
/**
 * Two things a plugin panel's header gets that a built-in one doesn't: the
 * kind's own buttons through `headerToolbar`, and no worktree branch chip. The
 * real ContentPanel and PanelHeader render here; only their store graph is
 * stubbed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const worktrees = new Map([["wt-1", { id: "wt-1", branch: "feature/quotes" }]]);
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees }),
  useWorktreeStoreOptional: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => ({ "wt-1": "var(--theme-category-blue)" }),
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Layout/useDockBlockedState", () => ({
  useDockBlockedState: () => null,
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (
    selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: true }),
  usePanelStore: (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
    selector({ panelsById: {} }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

import { ContentPanel } from "../ContentPanel";

afterEach(cleanup);

function panel(kind: string, headerToolbar?: React.ReactNode) {
  return (
    <ContentPanel
      id="p-1"
      title="Ledger"
      kind={kind}
      worktreeId="wt-1"
      isFocused
      onFocus={() => {}}
      onClose={() => {}}
      onToggleMaximize={() => {}}
      headerToolbar={headerToolbar}
    >
      <div data-testid="panel-body" />
    </ContentPanel>
  );
}

const branchChip = () => screen.queryByLabelText(/worktree on feature\/quotes/);

describe("ContentPanel header slots", () => {
  it("names the worktree branch on a built-in panel, with a tooltip that says what it is", () => {
    render(panel("browser"));

    expect(branchChip()?.textContent).toBe("feature/quotes");
    const tips = screen.getAllByTestId("tooltip-content").map((t) => t.textContent);
    expect(tips).toContain("Belongs to the worktree on feature/quotes");
  });

  it("names no branch on a plugin panel bound to the same worktree", () => {
    render(panel("acme.ledger.ledger"));

    expect(branchChip()).toBeNull();
    const tips = screen.queryAllByTestId("tooltip-content").map((t) => t.textContent ?? "");
    expect(tips.some((t) => t.includes("feature/quotes"))).toBe(false);
  });

  it("draws headerToolbar in the header, ahead of the window controls", () => {
    render(
      panel(
        "acme.ledger.ledger",
        <div role="toolbar" aria-label="Ledger actions">
          <button type="button">Refresh prices</button>
        </div>
      )
    );

    const toolbar = screen.getByRole("toolbar", { name: "Ledger actions" });
    const controls = screen.getByTestId("panel-header-controls");
    expect(toolbar.parentElement).toBe(controls.parentElement);
    expect(toolbar.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    // Not in the overflow menu, which is where `headerActions` goes.
    expect(screen.getByTestId("panel-body").contains(toolbar)).toBe(false);
  });
});
