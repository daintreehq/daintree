// @vitest-environment jsdom
/**
 * ContentPanel's container behaviour with the terminal header and the store
 * graph stubbed: the panel-root focus target, fleet-preview dimming, grid
 * selection chrome, and inline title rename.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { act, render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { AgentState } from "@shared/types/agent";

// Mutable mock state — the chrome branches are gated on a preference and on a
// hook return, so the suite needs to drive both rather than pin them off.
const mockState = {
  showGridAgentHighlights: false,
  dockBlockedState: null as string | null,
  headerAgentState: undefined as AgentState | undefined,
  pluginActivity: null as { pluginId: string; shown: string; description: string } | null,
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
  getTerminalAgentDisplayState: () => mockState.headerAgentState,
}));

vi.mock("../PluginPanelActivity", () => ({
  usePluginPanelActivity: () => mockState.pluginActivity,
  PluginPanelActivityIndicator: () => null,
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
import { focusPanelInput } from "../panelFocusRegistry";
import { inlineRenameFieldClassName } from "../inlineRenameField";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";

describe("ContentPanel focus", () => {
  /**
   * ContentPanel — panel-root focus target for non-PTY kinds (#11109).
   *
   * Macro-grid Enter used to reach xterm only, so it silently no-opped on
   * browser/dev-preview/file panels. ContentPanel now registers its root as the
   * focus target for every non-PTY kind. PTY kinds are deliberately excluded:
   * TerminalPane owns their registry entry and routes focus to xterm or the
   * hybrid input bar.
   */
  // `acme.dashboard` stands in for a plugin-contributed kind: unregistered in this
  // suite, so it also pins `panelKindHasPty`'s `?? false` fallback — an unknown
  // kind must still get a focus target rather than being mistaken for a PTY (#11228).
  type PanelKind = "terminal" | "browser" | "dev-preview" | "review" | "file" | "acme.dashboard";

  const NON_PTY_KINDS: PanelKind[] = ["browser", "dev-preview", "review", "file", "acme.dashboard"];

  interface RenderExtras {
    tabIndex?: number;
    ref?: React.Ref<HTMLDivElement>;
    isFocused?: boolean;
    children?: React.ReactNode;
    onFocus?: () => void;
  }

  function panelElement(id: string, kind: PanelKind, extra?: RenderExtras) {
    return (
      <ContentPanel
        id={id}
        title={`Panel ${id}`}
        kind={kind}
        isFocused={extra?.isFocused ?? false}
        onFocus={extra?.onFocus ?? (() => {})}
        onClose={() => {}}
        tabIndex={extra?.tabIndex}
        ref={extra?.ref}
      >
        {extra?.children ?? <div data-testid="panel-body" />}
      </ContentPanel>
    );
  }

  function renderPanel(id: string, kind: PanelKind = "browser", extra?: RenderExtras) {
    const view = render(panelElement(id, kind, extra));
    return {
      ...view,
      focus: (isFocused: boolean) =>
        act(() => {
          view.rerender(panelElement(id, kind, { ...extra, isFocused }));
        }),
    };
  }

  function panelRoot(container: HTMLElement, id: string): HTMLElement {
    const root = container.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
    if (!root) throw new Error(`panel root ${id} not rendered`);
    return root;
  }

  describe("ContentPanel focus target (#11109)", () => {
    afterEach(cleanup);

    it.each<PanelKind>(NON_PTY_KINDS)(
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

      // Negative, not specifically -1: the invariant is "script-focusable but not
      // Tab-reachable". The focus-handoff tests above prove the focusability half.
      expect(panelRoot(container, "p-1").tabIndex).toBeLessThan(0);
    });

    it("still forwards the root element to a caller's ref", () => {
      // TerminalPane forwards a ref here and observes the same node for resize
      // and visibility — composing the internal focus ref must not displace it.
      const ref = createRef<HTMLDivElement>();
      const { container } = renderPanel("p-1", "browser", { ref });

      expect(ref.current).toBe(panelRoot(container, "p-1"));
    });

    it("runs a callback ref's React 19 cleanup on unmount", () => {
      // React skips the usual `null` call when a ref callback returns a cleanup,
      // so a composed ref that swallows the cleanup leaks the caller's teardown.
      const teardown = vi.fn<() => void>();
      const { container, unmount } = renderPanel("p-1", "browser", {
        ref: (node) => (node ? teardown : undefined),
      });

      expect(panelRoot(container, "p-1")).toBeTruthy();
      expect(teardown).not.toHaveBeenCalled();

      unmount();

      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it("releases the registry entry on unmount", () => {
      const { unmount } = renderPanel("p-1", "browser");
      unmount();

      expect(focusPanelInput("p-1")).toBe(false);
    });
  });

  /**
   * Focus *selection*, as distinct from the focus *delivery* covered above:
   * clicking a pane has to write `focusedId`, or panel-scoped actions keep
   * resolving `terminalId ?? focusedId` to whatever was selected before — which
   * is how Cmd+W ended up closing the previously focused agent (#11228).
   */
  describe("ContentPanel click-to-select (#11228)", () => {
    afterEach(cleanup);

    // handleClick doesn't branch on kind, so one representative kind covers the
    // path; the plugin kind is the issue's subject. (The per-kind variation that
    // matters — panelKindHasPty's unknown-kind fallback — is exercised by the
    // focus-registration matrices above, not here.)
    it("selects the panel when a click bubbles out of its content", () => {
      const onFocus = vi.fn<() => void>();
      const { container } = renderPanel("p-1", "acme.dashboard", {
        onFocus,
        children: <button data-testid="plugin-child">Inside the plugin</button>,
      });

      // Click the deepest child, not the root: the bug was that content clicks
      // never reached any focus wiring at all.
      container.querySelector<HTMLElement>('[data-testid="plugin-child"]')!.click();

      expect(onFocus).toHaveBeenCalledTimes(1);
    });

    it("lets content opt out of selection by preventing the click", () => {
      const onFocus = vi.fn<() => void>();
      const { container } = renderPanel("p-1", "acme.dashboard", {
        onFocus,
        children: (
          <button
            data-testid="plugin-child"
            onClick={(e) => {
              e.preventDefault();
            }}
          >
            Handled by the plugin
          </button>
        ),
      });

      container.querySelector<HTMLElement>('[data-testid="plugin-child"]')!.click();

      expect(onFocus).not.toHaveBeenCalled();
    });
  });

  /**
   * The registry alone only covers macro-grid Enter and in-group tab switches.
   * Arrow navigation, Cmd+1..9, focusNext/Previous and agent-state cycling all
   * just write `focusedId` — so becoming the focused pane has to move DOM focus
   * on its own, or the pane paints as selected while keystrokes keep landing in
   * whatever held the keyboard before.
   */
  describe("ContentPanel reactive focus (#11133)", () => {
    afterEach(cleanup);

    it.each<PanelKind>(NON_PTY_KINDS)(
      "claims DOM focus for a %s panel that becomes focused without the registry",
      (kind) => {
        const outside = document.createElement("button");
        document.body.appendChild(outside);
        outside.focus();

        const { container, focus } = renderPanel("p-1", kind);
        expect(document.activeElement).toBe(outside);

        focus(true);

        expect(document.activeElement).toBe(panelRoot(container, "p-1"));
        outside.remove();
      }
    );

    it("leaves focus on the panel's own input rather than yanking it to the root", () => {
      // FilePane's search box lives inside the root. Becoming the focused pane
      // must not pull the caret out of the field the user is typing in.
      const { container, focus } = renderPanel("p-1", "file", {
        children: <input data-testid="search" />,
      });
      const search = container.querySelector<HTMLInputElement>('[data-testid="search"]')!;
      act(() => search.focus());

      focus(true);

      expect(document.activeElement).toBe(search);
    });

    it("reports a handoff as accepted when the panel already owns the keyboard", () => {
      const { container } = renderPanel("p-1", "file", {
        children: <input data-testid="search" />,
      });
      const search = container.querySelector<HTMLInputElement>('[data-testid="search"]')!;
      act(() => search.focus());

      let accepted = false;
      act(() => {
        accepted = focusPanelInput("p-1");
      });

      // The pane has focus — that is the outcome the caller asked for, so the
      // handoff completed even though nothing moved.
      expect(accepted).toBe(true);
      expect(document.activeElement).toBe(search);
    });

    // The page behind a browser pane's alert() can't take a key until it has its
    // answer, so the dialog is where the pane's keyboard goes (#15037).
    it("hands a page dialog over the pane the keyboard instead of the root", () => {
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      outside.focus();

      const { container, focus } = renderPanel("p-1", "browser", {
        children: (
          <div role="dialog" data-pane-dialog="">
            <button data-confirm-role="confirm">OK</button>
          </div>
        ),
      });

      focus(true);

      expect(document.activeElement).toBe(container.querySelector('[data-confirm-role="confirm"]'));
      outside.remove();
    });

    it("reports a handoff into a page dialog over the pane as accepted", () => {
      const { container } = renderPanel("p-1", "browser", {
        children: (
          <div role="dialog" data-pane-dialog="">
            <button data-confirm-role="confirm">OK</button>
          </div>
        ),
      });

      let accepted = false;
      act(() => {
        accepted = focusPanelInput("p-1");
      });

      expect(accepted).toBe(true);
      expect(document.activeElement).toBe(container.querySelector('[data-confirm-role="confirm"]'));
    });

    it("does not reactively claim focus for PTY kinds", () => {
      // TerminalPane routes PTY focus to xterm or the hybrid input bar. A second
      // claimant here would land focus on the container instead.
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      outside.focus();

      const { focus } = renderPanel("t-1", "terminal");
      focus(true);

      expect(document.activeElement).toBe(outside);
      outside.remove();
    });
  });
});

describe("ContentPanel fleet preview", () => {
  /**
   * ContentPanel — fleet preview "dim unmatched" container behavior (#8696).
   *
   * When a fleet state-preset menu item is hovered, panes that *would* be armed
   * pick up the title-bar lift (`data-fleet-previewed`). Panes that would NOT
   * be armed receive the `data-fleet-dimmed` attribute on the outer container,
   * which is paired with the `.fleet-pane-dimmed` class that drops opacity to
   * 0.5. With no preview active, neither attribute is set.
   */
  function renderPanel(id: string, kind: "terminal" | "browser" | "dev-preview" = "terminal") {
    return render(
      <ContentPanel
        id={id}
        title={`Panel ${id}`}
        kind={kind}
        isFocused={false}
        onFocus={() => {}}
        onClose={() => {}}
      >
        <div data-testid="panel-body" />
      </ContentPanel>
    );
  }

  describe("ContentPanel fleet-dim unmatched panes (#8696)", () => {
    beforeEach(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
    });

    afterEach(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
      cleanup();
    });

    it("does not dim when no preview is active", () => {
      const { container } = renderPanel("t-1");
      const panel = container.querySelector('[data-panel-id="t-1"]');
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute("data-fleet-dimmed")).toBeNull();
      expect(panel?.className.includes("fleet-pane-dimmed")).toBe(false);
    });

    it("dims when a preview is active and this pane is not in the set", () => {
      const { container } = renderPanel("t-1");
      act(() => {
        useFleetArmingStore.setState({ previewArmedIds: new Set(["t-2", "t-3"]) });
      });
      const panel = container.querySelector('[data-panel-id="t-1"]');
      expect(panel?.getAttribute("data-fleet-dimmed")).toBe("true");
      expect(panel?.className.includes("fleet-pane-dimmed")).toBe(true);
    });

    it("does not dim when this pane IS in the preview set", () => {
      const { container } = renderPanel("t-1");
      act(() => {
        useFleetArmingStore.setState({ previewArmedIds: new Set(["t-1", "t-2"]) });
      });
      const panel = container.querySelector('[data-panel-id="t-1"]');
      expect(panel?.getAttribute("data-fleet-dimmed")).toBeNull();
      expect(panel?.className.includes("fleet-pane-dimmed")).toBe(false);
    });

    it("never dims non-terminal panes (browser, dev-preview)", () => {
      // Browser and dev-preview panes are never arm-eligible, so dimming
      // them during a fleet preview would imply they could have been armed.
      const { container: browser } = renderPanel("b-1", "browser");
      const { container: devPreview } = renderPanel("d-1", "dev-preview");
      act(() => {
        useFleetArmingStore.setState({ previewArmedIds: new Set(["t-2"]) });
      });
      expect(
        browser.querySelector('[data-panel-id="b-1"]')?.getAttribute("data-fleet-dimmed")
      ).toBeNull();
      expect(
        devPreview.querySelector('[data-panel-id="d-1"]')?.getAttribute("data-fleet-dimmed")
      ).toBeNull();
    });

    it("returns to undimmed when the preview clears", () => {
      const { container } = renderPanel("t-1");
      act(() => {
        useFleetArmingStore.setState({ previewArmedIds: new Set(["t-2"]) });
      });
      let panel = container.querySelector('[data-panel-id="t-1"]');
      expect(panel?.getAttribute("data-fleet-dimmed")).toBe("true");
      expect(panel?.className.includes("fleet-pane-dimmed")).toBe(true);
      act(() => {
        useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
      });
      panel = container.querySelector('[data-panel-id="t-1"]');
      expect(panel?.getAttribute("data-fleet-dimmed")).toBeNull();
      expect(panel?.className.includes("fleet-pane-dimmed")).toBe(false);
    });
  });

  describe("PanelHeader fleet-preview enter overlay (#8995)", () => {
    beforeEach(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
    });

    afterEach(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
      cleanup();
    });

    it("has no enter overlay when the pane is not previewed", () => {
      const { container } = renderPanel("t-1");
      expect(container.querySelector('[data-testid="fleet-preview-enter-overlay"]')).toBeNull();
    });

    it("scopes the overlay per-pane during a multi-pane preview", () => {
      // Two panes rendered; only one is in the preview set. The non-previewed
      // pane must not pick up the enter cue — this is the core differentiator
      // between the kinetic preview cue and the global multi-select state.
      const { container: previewed } = renderPanel("t-1");
      const { container: untouched } = renderPanel("t-2");
      act(() => {
        useFleetArmingStore.setState({ previewArmedIds: new Set(["t-1"]) });
      });
      expect(previewed.querySelector('[data-testid="fleet-preview-enter-overlay"]')).not.toBeNull();
      expect(untouched.querySelector('[data-testid="fleet-preview-enter-overlay"]')).toBeNull();
    });
  });
});

describe("ContentPanel selection chrome", () => {
  /**
   * ContentPanel — grid container selection chrome.
   *
   * A lone grid pane wears the same `terminal-selected` frame as a pane in a
   * multi-pane grid: after the user clicks away and back, the pane that holds
   * the keystrokes has to be visible even with nothing beside it. The ambient
   * states (arming, agent state) stay multi-pane only.
   */
  const MACRO_FOCUS_DEFAULTS = {
    focusedRegion: null,
    visibility: { grid: true, dock: false, sidebar: true, portal: false, assistant: false },
  } as const;

  /**
   * The oracle is "which state won", not "is this class present". The resolver
   * returns one state, except that waiting and failed keep their edge over the
   * selected fill: those are the only legal pairs. Neutral chrome is expressed
   * as the absence of every semantic class rather than by pinning the
   * fallback's utility string, which a purely visual refactor would churn
   * without changing behaviour.
   */
  const CHROME_STATES = [
    { state: "arming", className: "panel-state-arming" },
    { state: "selected", className: "terminal-selected" },
    { state: "waiting", className: "panel-state-waiting" },
    { state: "failed", className: "panel-state-failed" },
    { state: "working", className: "panel-state-working" },
  ] as const;

  const COMPOSITE_STATES = ["selected+waiting", "selected+failed"] as const;

  type ChromeState =
    (typeof CHROME_STATES)[number]["state"] | (typeof COMPOSITE_STATES)[number] | "none";

  const KNOWN_CHROME_STATES: readonly ChromeState[] = [
    ...CHROME_STATES.map(({ state }) => state),
    ...COMPOSITE_STATES,
  ];

  function chromeOf(container: HTMLElement, id = "t-1"): ChromeState {
    const panel = container.querySelector(`[data-panel-id="${id}"]`);
    expect(panel, `panel ${id} rendered`).not.toBeNull();
    const present = CHROME_STATES.filter(({ className }) => panel?.classList.contains(className));
    const key = present.map(({ state }) => state).join("+");
    expect(
      present.length < 2 || (COMPOSITE_STATES as readonly string[]).includes(key),
      `expected one chrome state or a legal pair, got [${key}]`
    ).toBe(true);
    return KNOWN_CHROME_STATES.find((state) => state === key) ?? "none";
  }

  interface PanelOverrides {
    isFocused?: boolean;
    isSelected?: boolean;
    isMultiPanelGrid?: boolean;
    isMaximized?: boolean;
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

  /** The fleet reads an unread Canopy ask on t-1: the one thing pane chrome draws amber for. */
  function askFromFleet() {
    mockState.headerAgentState = "waiting";
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [
          {
            runId: "t-1",
            workspaceId: "p1",
            spawnedAt: 0,
            cwd: "/repo",
            agentState: "waiting",
            canopy: { kind: "asked", quote: "Ship it?", readAt: 0, seen: false },
          },
        ],
        changedAt: 0,
        degraded: false,
        lastSuccessfulAt: null,
      },
    });
  }

  function clearAsk() {
    mockState.headerAgentState = undefined;
    useFleetSnapshotStore.setState({ snapshot: null });
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
    mockState.headerAgentState = undefined;
    mockState.pluginActivity = null;
    useFleetSnapshotStore.setState({ snapshot: null });
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

  describe("ContentPanel plugin-reported activity chrome (#13820)", () => {
    function reported(shown: string) {
      mockState.pluginActivity = { pluginId: "acme", shown, description: `Reported by Acme` };
    }

    it.each([
      ["waiting", "waiting"],
      ["working", "working"],
      ["unread", "none"],
      ["failed", "none"],
    ] as const)("draws a %s report as %s chrome in a multi-pane grid", (shown, chrome) => {
      mockState.showGridAgentHighlights = true;
      reported(shown);
      const { container } = renderPanel({ isFocused: false });
      expect(chromeOf(container)).toBe(chrome);
    });

    it("draws a waiting report even with grid highlights off, but not a working one", () => {
      reported("waiting");
      const waiting = renderPanel({ isFocused: false });
      expect(chromeOf(waiting.container)).toBe("waiting");
      waiting.unmount();
      reported("working");
      const working = renderPanel({ isFocused: false });
      expect(chromeOf(working.container)).toBe("none");
    });

    it("yields the border to an agent Daintree observes in the panel", () => {
      mockState.showGridAgentHighlights = true;
      mockState.headerAgentState = "working";
      reported("waiting");
      const { container } = renderPanel({ isFocused: false, agentState: "working" });
      expect(chromeOf(container)).toBe("working");
    });

    it("keeps its waiting edge over the selected fill", () => {
      mockState.showGridAgentHighlights = true;
      reported("waiting");
      const { container } = renderPanel();
      expect(chromeOf(container)).toBe("selected+waiting");
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

    it("ranks voice arming above selection", () => {
      const { container } = renderPanel({ isMultiPanelGrid: true, isVoiceArming: true });
      expect(chromeOf(container)).toBe("arming");
    });

    it("keeps the waiting edge over the selected fill and ranks selection above working", () => {
      mockState.showGridAgentHighlights = true;
      askFromFleet();
      const asking = renderPanel({ isMultiPanelGrid: true, agentState: "working" });
      expect(chromeOf(asking.container)).toBe("selected+waiting");
      asking.unmount();
      clearAsk();
      const working = renderPanel({ isMultiPanelGrid: true, agentState: "working" });
      expect(chromeOf(working.container)).toBe("selected");
    });

    it("ranks waiting above working once selection releases", () => {
      mockState.showGridAgentHighlights = true;
      askFromFleet();
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

    it("suppresses working when the highlight preference is off, but never waiting", () => {
      mockState.showGridAgentHighlights = false;
      const working = renderPanel({
        isMultiPanelGrid: true,
        isFocused: false,
        agentState: "working",
      });
      expect(chromeOf(working.container)).toBe("none");
      working.unmount();
      askFromFleet();
      const asking = renderPanel({
        isMultiPanelGrid: true,
        isFocused: false,
        agentState: "working",
      });
      expect(chromeOf(asking.container)).toBe("waiting");
    });

    it("withholds every ambient state from a lone pane", () => {
      // The ambient states are all gated on `showGridAttention`, so a single
      // pane must never reach them — only selection or bare.
      mockState.showGridAgentHighlights = true;
      askFromFleet();
      const { container } = renderPanel({
        isMultiPanelGrid: false,
        isFocused: false,
        isVoiceArming: true,
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
      askFromFleet();
      const { container } = renderPanel({ isMultiPanelGrid: true });
      showAssistant(true);
      focusAssistant(true);
      expect(chromeOf(container)).toBe("waiting");
    });
  });
});

describe("ContentPanel title", () => {
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

  function renderPanel(onTitleChange = vi.fn()) {
    render(
      <ContentPanel
        id="p-1"
        title="Docs"
        kind="browser"
        isFocused
        onFocus={() => {}}
        onClose={() => {}}
        onTitleChange={onTitleChange}
      >
        <div />
      </ContentPanel>
    );
    return onTitleChange;
  }

  const titleButton = () => screen.getByRole("button", { name: /^Browser title: Docs/ });
  const titleField = () =>
    screen.getByRole<HTMLInputElement>("textbox", { name: "Edit browser title" });

  describe("ContentPanel title rename", () => {
    afterEach(cleanup);

    it.each(["Enter", "Escape"])(
      "hands focus back to the title after a keyboard rename ends with %s",
      async (key) => {
        renderPanel();
        const title = titleButton();
        title.focus();
        fireEvent.keyDown(title, { key: "F2" });
        await act(nextFrame);
        const field = titleField();
        field.focus();
        fireEvent.change(field, { target: { value: "API docs" } });
        fireEvent.keyDown(field, { key });
        await act(nextFrame);
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(document.activeElement).toBe(titleButton());
      }
    );

    it("commits on Enter and discards on Escape", async () => {
      const onTitleChange = renderPanel();
      for (const key of ["Escape", "Enter"]) {
        fireEvent.keyDown(titleButton(), { key: "F2" });
        await act(nextFrame);
        fireEvent.change(titleField(), { target: { value: `after ${key}` } });
        fireEvent.keyDown(titleField(), { key });
        await act(nextFrame);
      }
      expect(onTitleChange.mock.calls).toEqual([["after Enter"]]);
    });

    it("claims the Escape that cancels the rename", async () => {
      renderPanel();
      fireEvent.keyDown(titleButton(), { key: "F2" });
      await act(nextFrame);

      // fireEvent returns false once a handler prevented the default.
      expect(fireEvent.keyDown(titleField(), { key: "Escape" })).toBe(false);
    });

    it("does not re-select text typed in the moment after the field opens", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        renderPanel();
        fireEvent.keyDown(titleButton(), { key: "F2" });
        const field = titleField();
        field.focus();
        fireEvent.keyDown(field, { key: "A" });
        fireEvent.change(field, { target: { value: "API" } });
        field.setSelectionRange(3, 3);
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect([field.selectionStart, field.selectionEnd]).toEqual([3, 3]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not undo a caret move made in the moment after the field opens", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        renderPanel();
        fireEvent.keyDown(titleButton(), { key: "F2" });
        const field = titleField();
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
        fireEvent.keyDown(field, { key: "ArrowRight" });
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(field.selectionStart).toBe(field.value.length);
      } finally {
        vi.useRealTimers();
      }
    });

    it("still selects the whole name when nothing has been typed yet", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        renderPanel();
        fireEvent.keyDown(titleButton(), { key: "F2" });
        const field = titleField();
        field.setSelectionRange(0, 0);
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("wears the shared inline rename look and treats the name as an identifier", () => {
      renderPanel();
      fireEvent.doubleClick(titleButton());
      const field = titleField();
      const classes = field.className.split(/\s+/);
      for (const token of inlineRenameFieldClassName.split(/\s+/)) {
        expect(classes).toContain(token);
      }
      expect(field.getAttribute("spellcheck")).toBe("false");
      expect(field.getAttribute("autocomplete")).toBe("off");
    });
  });
});
