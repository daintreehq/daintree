// @vitest-environment jsdom
/**
 * ContentPanel — panel-root focus target for non-PTY kinds (#11109).
 *
 * Macro-grid Enter used to reach xterm only, so it silently no-opped on
 * browser/dev-preview/file panels. ContentPanel now registers its root as the
 * focus target for every non-PTY kind. PTY kinds are deliberately excluded:
 * TerminalPane owns their registry entry and routes focus to xterm or the
 * hybrid input bar.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRef } from "react";
import { act, render, cleanup } from "@testing-library/react";

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

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({
    agentId: undefined,
    iconId: undefined,
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
    selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: true }),
  usePanelStore: (selector: (s: { panelsById: Record<string, never> }) => unknown) =>
    selector({ panelsById: {} }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ContentPanel } from "../ContentPanel";
import { focusPanelInput } from "../panelFocusRegistry";

type PanelKind = "terminal" | "browser" | "dev-preview" | "review" | "file";

function renderPanel(
  id: string,
  kind: PanelKind = "browser",
  extra?: { tabIndex?: number; ref?: React.Ref<HTMLDivElement> }
) {
  return render(
    <ContentPanel
      id={id}
      title={`Panel ${id}`}
      kind={kind}
      isFocused={false}
      onFocus={() => {}}
      onClose={() => {}}
      tabIndex={extra?.tabIndex}
      ref={extra?.ref}
    >
      <div data-testid="panel-body" />
    </ContentPanel>
  );
}

function panelRoot(container: HTMLElement, id: string): HTMLElement {
  const root = container.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
  if (!root) throw new Error(`panel root ${id} not rendered`);
  return root;
}

describe("ContentPanel focus target (#11109)", () => {
  afterEach(cleanup);

  it.each<PanelKind>(["browser", "dev-preview", "review", "file"])(
    "moves focus to the panel root and confirms the handoff for %s panels",
    (kind) => {
      const { container } = renderPanel("p-1", kind);
      const root = panelRoot(container, "p-1");

      let accepted = false;
      act(() => {
        accepted = focusPanelInput("p-1");
      });

      expect(accepted).toBe(true);
      expect(document.activeElement).toBe(root);
    }
  );

  it("does not claim the registry entry for PTY kinds", () => {
    // TerminalPane registers the handler for terminals — a second owner here
    // would race it for the same panel id and could strand focus on the
    // container instead of xterm or the hybrid input bar.
    renderPanel("t-1", "terminal");

    expect(focusPanelInput("t-1")).toBe(false);
  });

  it("keeps an explicit tabIndex so TerminalPane stays in the Tab sequence", () => {
    const { container } = renderPanel("t-1", "terminal", { tabIndex: 0 });

    expect(panelRoot(container, "t-1").getAttribute("tabindex")).toBe("0");
  });

  it("keeps the panel root out of the Tab sequence when no tabIndex is given", () => {
    const { container } = renderPanel("p-1", "browser");

    expect(panelRoot(container, "p-1").getAttribute("tabindex")).toBe("-1");
  });

  it("still forwards the root element to a caller's ref", () => {
    // TerminalPane forwards a ref here and observes the same node for resize
    // and visibility — composing the internal focus ref must not displace it.
    const ref = createRef<HTMLDivElement>();
    const { container } = renderPanel("p-1", "browser", { ref });

    expect(ref.current).toBe(panelRoot(container, "p-1"));
  });

  it("releases the registry entry on unmount", () => {
    const { unmount } = renderPanel("p-1", "browser");
    unmount();

    expect(focusPanelInput("p-1")).toBe(false);
  });
});
