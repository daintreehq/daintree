// @vitest-environment jsdom
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: Map<string, unknown> }) => unknown) =>
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

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({
    agentId: undefined,
    iconId: "monitor-play",
    runtimeKind: "shell",
    isAgent: false,
  }),
}));

vi.mock("@/utils/terminalAgentDisplayState", () => ({
  getTerminalAgentDisplayState: () => undefined,
}));

vi.mock("@/components/Terminal/TerminalHeaderContent", () => ({
  TerminalHeaderContent: () => null,
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (
    selector: (state: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: true }),
  usePanelStore: (selector: (state: { panelsById: Record<string, never> }) => unknown) =>
    selector({ panelsById: {} }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { DevPreviewPaneFallback } from "../DevPreviewPaneFallback";

describe("DevPreviewPaneFallback", () => {
  it("keeps the real panel chrome interactive around a quiet loading canvas", () => {
    const onFocus = vi.fn();
    const onClose = vi.fn();
    const onToggleMaximize = vi.fn();

    const { container } = render(
      <DevPreviewPaneFallback
        id="preview-1"
        title="Dev preview"
        isFocused
        isMultiPanelGrid
        onFocus={onFocus}
        onClose={onClose}
        onToggleMaximize={onToggleMaximize}
      />
    );

    const panel = container.querySelector('[data-panel-id="preview-1"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("data-panel-location")).toBe("grid");
    expect(screen.getAllByText("Dev preview").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "More panel actions" })).toBeTruthy();

    const loadingCanvas = screen.getByRole("status", { name: "Loading dev preview panel" });
    expect(loadingCanvas.getAttribute("aria-busy")).toBe("true");
    expect(
      container.querySelectorAll(".animate-pulse-immediate, .animate-pulse-delayed")
    ).toHaveLength(0);

    fireEvent.click(panel!);
    expect(onFocus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId("panel-close"));
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
