// @vitest-environment jsdom
/**
 * ContentPanel — grid container selection chrome.
 *
 * A lone grid pane wears the same `terminal-selected` frame as a pane in a
 * multi-pane grid: after the user clicks away and back, the pane that holds
 * the keystrokes has to be visible even with nothing beside it. The ambient
 * states (arming, agent state, hibernation) stay multi-pane only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";

// Mutable mock state — the chrome branches are gated on a preference and on a
// hook return, so the suite needs to drive both rather than pin them off.
const mockState = {
  showGridAgentHighlights: false,
  dockBlockedState: null as string | null,
};

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
  useWorktreeStoreOptional: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Layout/useDockBlockedState", () => ({
  useDockBlockedState: () => mockState.dockBlockedState,
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
  ) =>
    selector({
      showGridAgentHighlights: mockState.showGridAgentHighlights,
      showAgentTaskTitles: true,
    }),
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
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

const MACRO_FOCUS_DEFAULTS = {
  focusedRegion: null,
  visibility: { grid: true, dock: false, sidebar: true, portal: false, assistant: false },
} as const;

/**
 * The resolver returns exactly one class, so the oracle is "which state won",
 * not "is this class present". Neutral chrome is expressed as the absence of
 * every semantic class rather than by pinning the fallback's utility string,
 * which a purely visual refactor would churn without changing behaviour.
 */
const CHROME_STATES = [
  { state: "arming", className: "panel-state-arming" },
  { state: "selected", className: "terminal-selected" },
  { state: "waiting", className: "panel-state-waiting" },
  { state: "working", className: "panel-state-working" },
  { state: "hibernated", className: "panel-state-hibernated" },
] as const;

type ChromeState = (typeof CHROME_STATES)[number]["state"] | "none";

function chromeOf(container: HTMLElement, id = "t-1"): ChromeState {
  const panel = container.querySelector(`[data-panel-id="${id}"]`);
  expect(panel, `panel ${id} rendered`).not.toBeNull();
  const present = CHROME_STATES.filter(({ className }) => panel?.classList.contains(className));
  expect(
    present.length,
    `expected one chrome state, got [${present.map(({ state }) => state).join(", ")}]`
  ).toBeLessThan(2);
  return present[0]?.state ?? "none";
}

interface PanelOverrides {
  isFocused?: boolean;
  isSelected?: boolean;
  isMultiPanelGrid?: boolean;
  isMaximized?: boolean;
  isHibernated?: boolean;
  isVoiceArming?: boolean;
  agentState?: AgentState;
  location?: "grid" | "dock" | "dialog";
  className?: string;
}

function renderPanel(overrides: PanelOverrides = {}, id = "t-1") {
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

function resetStores() {
  useMacroFocusStore.setState({ ...MACRO_FOCUS_DEFAULTS });
  useVoiceRecordingStore.setState({ lockedTarget: null });
  mockState.showGridAgentHighlights = false;
  mockState.dockBlockedState = null;
}

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  // The stores are module singletons — leaving the Assistant visible or a
  // dictation lock in place would change the starting state of later suites.
  resetStores();
});

describe("ContentPanel lone-pane selection chrome", () => {
  it("frames a lone focused pane", () => {
    const { container } = renderPanel({ isMultiPanelGrid: false });
    expect(chromeOf(container)).toBe("selected");
  });

  it("releases the frame to the Assistant and takes it back", () => {
    const { container } = renderPanel({ isMultiPanelGrid: false });
    showAssistant(true);
    expect(chromeOf(container)).toBe("selected");

    focusAssistant(true);
    expect(chromeOf(container)).toBe("none");

    focusAssistant(false);
    expect(chromeOf(container)).toBe("selected");
  });

  it("does not frame an unfocused lone pane", () => {
    const { container } = renderPanel({ isMultiPanelGrid: false, isFocused: false });
    expect(chromeOf(container)).toBe("none");
  });

  it("does not frame a lone pane that is armed but not focused", () => {
    // The frame follows focus alone: an armed pane keeps its title-bar lift
    // (PanelHeader), but only the pane the keystrokes go to wears the frame.
    const { container } = renderPanel({
      isMultiPanelGrid: false,
      isFocused: false,
      isSelected: true,
    });
    expect(chromeOf(container)).toBe("none");
  });

  it.each([
    ["maximized", { isMaximized: true }],
    ["docked", { location: "dock" as const }],
    ["dialog-hosted", { location: "dialog" as const }],
  ])("never frames a %s pane", (_label, overrides) => {
    const { container } = renderPanel({ isMultiPanelGrid: false, ...overrides });
    expect(chromeOf(container)).toBe("none");
  });

  it("keeps the frame alongside a dictation lock", () => {
    const { container } = renderPanel({ isMultiPanelGrid: false });
    act(() => {
      useVoiceRecordingStore.setState({ lockedTarget: { panelId: "t-1" } });
    });
    const panel = container.querySelector('[data-panel-id="t-1"]');
    expect(panel?.classList.contains("panel-voice-dictation-locked")).toBe(true);
    expect(chromeOf(container)).toBe("selected");
  });
});

describe("ContentPanel grid chrome priority", () => {
  // The extraction of `resolveGridPanelChromeClass` had to preserve the old
  // ternary's order exactly. These pin the order itself, not the class values:
  // each case supplies TWO competing states and asserts the higher-priority
  // one wins, so swapping any pair of branches fails.
  it("frames the focused pane and not an armed follower (fleet)", () => {
    // Question one on this surface is "which pane am I typing into". A
    // follower is lifted and striped by the header; if it also wore the focus
    // frame, every receiver in the fleet would look like the primary.
    const primary = renderPanel({ isMultiPanelGrid: true, isFocused: true, isSelected: true });
    expect(chromeOf(primary.container)).toBe("selected");
    primary.unmount();
    const follower = renderPanel({ isMultiPanelGrid: true, isFocused: false, isSelected: true });
    expect(chromeOf(follower.container)).toBe("none");
  });

  it("gives a focused multi-pane the full-strength class", () => {
    const { container } = renderPanel({ isMultiPanelGrid: true });
    expect(chromeOf(container)).toBe("selected");
  });

  it("ranks voice arming above selection", () => {
    const { container } = renderPanel({ isMultiPanelGrid: true, isVoiceArming: true });
    expect(chromeOf(container)).toBe("arming");
  });

  it("ranks selection above the waiting and working ambient states", () => {
    mockState.showGridAgentHighlights = true;
    mockState.dockBlockedState = "waiting";
    const { container } = renderPanel({ isMultiPanelGrid: true, agentState: "working" });
    expect(chromeOf(container)).toBe("selected");
  });

  it("ranks waiting above working once selection releases", () => {
    mockState.showGridAgentHighlights = true;
    mockState.dockBlockedState = "waiting";
    const { container } = renderPanel({
      isMultiPanelGrid: true,
      isFocused: false,
      agentState: "working",
    });
    expect(chromeOf(container)).toBe("waiting");
  });

  it("falls through to working when nothing is waiting", () => {
    mockState.showGridAgentHighlights = true;
    const { container } = renderPanel({
      isMultiPanelGrid: true,
      isFocused: false,
      agentState: "working",
    });
    expect(chromeOf(container)).toBe("working");
  });

  it("suppresses the agent states when the highlight preference is off", () => {
    mockState.showGridAgentHighlights = false;
    mockState.dockBlockedState = "waiting";
    const { container } = renderPanel({
      isMultiPanelGrid: true,
      isFocused: false,
      agentState: "working",
    });
    expect(chromeOf(container)).toBe("none");
  });

  it("ranks working above hibernation", () => {
    // The adjacent pair the waiting-vs-hibernated case below does not reach —
    // without this, swapping the working and hibernated branches passes.
    mockState.showGridAgentHighlights = true;
    const { container } = renderPanel({
      isMultiPanelGrid: true,
      isFocused: false,
      isHibernated: true,
      agentState: "working",
    });
    expect(chromeOf(container)).toBe("working");
  });

  it("ranks hibernation below the agent states but above bare", () => {
    mockState.showGridAgentHighlights = true;
    const { container } = renderPanel({
      isMultiPanelGrid: true,
      isFocused: false,
      isHibernated: true,
    });
    expect(chromeOf(container)).toBe("hibernated");

    mockState.dockBlockedState = "waiting";
    const { container: waiting } = renderPanel(
      { isMultiPanelGrid: true, isFocused: false, isHibernated: true },
      "t-2"
    );
    expect(chromeOf(waiting, "t-2")).toBe("waiting");
  });

  it("withholds every ambient state from a lone pane", () => {
    // The ambient states are all gated on `showGridAttention`, so a single
    // pane must never reach them — only selection or bare.
    mockState.showGridAgentHighlights = true;
    mockState.dockBlockedState = "waiting";
    const { container } = renderPanel({
      isMultiPanelGrid: false,
      isFocused: false,
      isVoiceArming: true,
      isHibernated: true,
      agentState: "working",
    });
    expect(chromeOf(container)).toBe("none");
  });
});

describe("ContentPanel multi-pane chrome and the Assistant", () => {
  it("keeps the full-strength class when the Assistant is merely open", () => {
    // Visibility alone must not downgrade a multi-pane selection — only the
    // Assistant actually holding focus releases it.
    const { container } = renderPanel({ isMultiPanelGrid: true });
    showAssistant(true);
    expect(chromeOf(container)).toBe("selected");
  });

  it("releases multi-pane chrome to bare when the Assistant takes focus", () => {
    const { container } = renderPanel({ isMultiPanelGrid: true });
    showAssistant(true);
    focusAssistant(true);
    expect(chromeOf(container)).toBe("none");
  });

  it("still shows the ambient agent state while the Assistant holds focus", () => {
    // The docblock's promise: chrome follows the keystrokes, but the ambient
    // panel-state-* borders keep rendering.
    mockState.showGridAgentHighlights = true;
    mockState.dockBlockedState = "waiting";
    const { container } = renderPanel({ isMultiPanelGrid: true });
    showAssistant(true);
    focusAssistant(true);
    expect(chromeOf(container)).toBe("waiting");
  });
});
