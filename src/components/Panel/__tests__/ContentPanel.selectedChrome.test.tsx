// @vitest-environment jsdom
/**
 * ContentPanel — grid container selection chrome (#11837).
 *
 * A single-pane grid skips `showGridAttention` entirely, so before this fix it
 * rendered the bare `border-overlay` fallback whether the pane owned the
 * keystrokes or the Daintree Assistant did. The lone-pane cue closes that gap
 * with `terminal-selected-quiet` — the perimeter of `terminal-selected` minus
 * its surface-lift fill — and only while the Assistant is on screen to compete
 * for focus, so the bare lone pane stays the default otherwise (the outcome
 * ba71e9d35 restored after #7544 removed the guard outright).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { useMacroFocusStore } from "@/store/macroFocusStore";

interface PanelOverrides {
  isFocused?: boolean;
  isSelected?: boolean;
  isMultiPanelGrid?: boolean;
  isMaximized?: boolean;
  location?: "grid" | "dock" | "dialog";
}

function renderPanel(id: string, overrides: PanelOverrides = {}) {
  const { isFocused = true, ...rest } = overrides;
  return render(
    <ContentPanel
      id={id}
      title={`Panel ${id}`}
      kind="terminal"
      isFocused={isFocused}
      onFocus={() => {}}
      onClose={() => {}}
      {...rest}
    >
      <div data-testid="panel-body" />
    </ContentPanel>
  );
}

/**
 * `classList` rather than a className substring: "terminal-selected" is a
 * prefix of "terminal-selected-quiet", so substring matching reports the
 * full-strength class as present whenever the quiet cue is applied.
 */
function chromeOf(container: HTMLElement, id: string) {
  const panel = container.querySelector(`[data-panel-id="${id}"]`);
  expect(panel, `panel ${id} rendered`).not.toBeNull();
  const classes = panel!.classList;
  return {
    selected: classes.contains("terminal-selected"),
    quiet: classes.contains("terminal-selected-quiet"),
    bare: classes.contains("border-overlay"),
  };
}

function showAssistant(visible: boolean) {
  act(() => {
    useMacroFocusStore.getState().setVisibility("assistant", visible);
  });
}

function focusAssistant(focused: boolean) {
  act(() => {
    useMacroFocusStore.setState({ focusedRegion: focused ? "assistant" : null });
  });
}

describe("ContentPanel lone-pane selection chrome (#11837)", () => {
  beforeEach(() => {
    useMacroFocusStore.setState({
      focusedRegion: null,
      visibility: { grid: true, dock: false, sidebar: true, portal: false, assistant: false },
    });
  });

  afterEach(() => {
    cleanup();
    // The store is a module singleton — leaving the Assistant visible or
    // focused would silently change the starting state of later suites.
    useMacroFocusStore.setState({
      focusedRegion: null,
      visibility: { grid: true, dock: false, sidebar: true, portal: false, assistant: false },
    });
  });

  it("leaves a lone pane bare while the Assistant is closed", () => {
    // The historical default ba71e9d35 restored: nothing to disambiguate
    // against, so no chrome at all.
    const { container } = renderPanel("t-1", { isMultiPanelGrid: false });
    expect(chromeOf(container, "t-1")).toEqual({ selected: false, quiet: false, bare: true });
  });

  it("lights the quiet cue on a lone focused pane once the Assistant is open", () => {
    const { container } = renderPanel("t-1", { isMultiPanelGrid: false });
    showAssistant(true);
    expect(chromeOf(container, "t-1")).toEqual({ selected: false, quiet: true, bare: false });
  });

  it("releases the quiet cue to the Assistant and takes it back", () => {
    // The whole point of the issue: these two states must not look alike.
    const { container } = renderPanel("t-1", { isMultiPanelGrid: false });
    showAssistant(true);
    expect(chromeOf(container, "t-1").quiet).toBe(true);

    focusAssistant(true);
    expect(chromeOf(container, "t-1")).toEqual({ selected: false, quiet: false, bare: true });

    focusAssistant(false);
    expect(chromeOf(container, "t-1").quiet).toBe(true);
  });

  it("returns a lone pane to bare when the Assistant is closed again", () => {
    const { container } = renderPanel("t-1", { isMultiPanelGrid: false });
    showAssistant(true);
    expect(chromeOf(container, "t-1").quiet).toBe(true);
    showAssistant(false);
    expect(chromeOf(container, "t-1")).toEqual({ selected: false, quiet: false, bare: true });
  });

  it("does not light an unfocused, unselected lone pane", () => {
    const { container } = renderPanel("t-1", { isMultiPanelGrid: false, isFocused: false });
    showAssistant(true);
    expect(chromeOf(container, "t-1")).toEqual({ selected: false, quiet: false, bare: true });
  });

  it("lights a lone pane that is selected rather than focused", () => {
    // `showSelectedChrome` is (isFocused || isSelected); the cue inherits that
    // meaning rather than narrowing to DOM focus.
    const { container } = renderPanel("t-1", {
      isMultiPanelGrid: false,
      isFocused: false,
      isSelected: true,
    });
    showAssistant(true);
    expect(chromeOf(container, "t-1").quiet).toBe(true);
  });

  it("never applies the quiet cue to a maximized or non-grid pane", () => {
    for (const overrides of [
      { isMultiPanelGrid: false, isMaximized: true },
      { isMultiPanelGrid: false, location: "dock" as const },
      { isMultiPanelGrid: false, location: "dialog" as const },
    ]) {
      const { container, unmount } = renderPanel("t-1", overrides);
      showAssistant(true);
      const panel = container.querySelector('[data-panel-id="t-1"]');
      expect(panel?.classList.contains("terminal-selected-quiet")).toBe(false);
      unmount();
    }
  });
});

describe("ContentPanel multi-pane selection chrome is unchanged (#11837 regression guard)", () => {
  beforeEach(() => {
    useMacroFocusStore.setState({
      focusedRegion: null,
      visibility: { grid: true, dock: false, sidebar: true, portal: false, assistant: false },
    });
  });

  afterEach(() => {
    cleanup();
    useMacroFocusStore.setState({
      focusedRegion: null,
      visibility: { grid: true, dock: false, sidebar: true, portal: false, assistant: false },
    });
  });

  it("gives a focused multi-pane the full-strength class, never the quiet one", () => {
    const { container } = renderPanel("t-1", { isMultiPanelGrid: true });
    expect(chromeOf(container, "t-1")).toEqual({ selected: true, quiet: false, bare: false });
  });

  it("keeps the full-strength class when the Assistant is merely open", () => {
    // Visibility alone must not downgrade a multi-pane selection — only the
    // Assistant actually holding focus releases it.
    const { container } = renderPanel("t-1", { isMultiPanelGrid: true });
    showAssistant(true);
    expect(chromeOf(container, "t-1").selected).toBe(true);
  });

  it("releases multi-pane chrome to bare when the Assistant takes focus", () => {
    // Multi-pane falls back to bare rather than the quiet cue — the cue is
    // scoped to the lone-pane ambiguity and must not leak into the grid.
    const { container } = renderPanel("t-1", { isMultiPanelGrid: true });
    showAssistant(true);
    focusAssistant(true);
    expect(chromeOf(container, "t-1")).toEqual({ selected: false, quiet: false, bare: true });
  });
});
