// @vitest-environment jsdom
/**
 * Which part of a panel opens the panel menu (#13422): the whole pane for a
 * terminal, whose content has no menu of its own, and the title bar alone for
 * every other kind. The real ContentPanel and PanelHeader render here; the menu
 * is stubbed down to the trigger it hands out.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Terminal/TerminalContextMenu", async () => {
  const { PanelContextMenuTriggerContext } =
    await import("@/components/Terminal/PanelContextMenuTrigger");
  return {
    TerminalContextMenu: ({
      terminalId,
      triggerScope,
      children,
    }: {
      terminalId: string;
      triggerScope?: "surface" | "header";
      children: React.ReactNode;
    }) => {
      const triggerProps = {
        "data-context-trigger": terminalId,
        onContextMenu: () => {},
        onPointerDown: () => {},
      };
      if (triggerScope === "header") {
        return (
          <PanelContextMenuTriggerContext.Provider value={triggerProps}>
            {children}
          </PanelContextMenuTriggerContext.Provider>
        );
      }
      return (
        <div className="contents" {...triggerProps}>
          {children}
        </div>
      );
    },
  };
});
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

function renderPanel(kind: string) {
  return render(
    <ContentPanel
      id="p-1"
      title="Ledger"
      kind={kind}
      worktreeId="wt-1"
      location="grid"
      isFocused
      onFocus={() => {}}
      onClose={() => {}}
      onToggleMaximize={() => {}}
    >
      <div data-testid="panel-body">Body</div>
    </ContentPanel>
  );
}

function trigger(): HTMLElement {
  const triggers = document.querySelectorAll<HTMLElement>('[data-context-trigger="p-1"]');
  expect(triggers).toHaveLength(1);
  return triggers[0]!;
}

describe("ContentPanel — panel menu trigger scope", () => {
  it.each(["browser", "file", "acme.ledger.ledger"])(
    "hands a %s panel's menu to its title bar alone",
    (kind) => {
      renderPanel(kind);
      const el = trigger();
      expect(el.querySelector("[data-panel-id]")).toBeNull();
      expect(el.contains(screen.getByTestId("panel-body"))).toBe(false);
      expect(el.textContent).toContain("Ledger");
    }
  );

  it("keeps a terminal's whole pane as the trigger", () => {
    renderPanel("terminal");
    expect(trigger().contains(screen.getByTestId("panel-body"))).toBe(true);
  });
});
