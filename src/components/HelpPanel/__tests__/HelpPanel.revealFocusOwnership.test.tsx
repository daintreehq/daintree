// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { StrictMode, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for #11472: a background update to the assistant's own panel
// object must never move keyboard focus out of whatever the user is actually
// typing in. A live assistant replaces `panelsById[terminalId]` constantly
// (`updateAgentState`, `updateLastObservedTitle` on every distinct OSC title,
// and the RAF-coalesced activity buffer), and the reveal effect used to list
// that whole object as a dependency — so every one of those writes re-ran it and
// re-grabbed focus, yanking the caret out of Ask Codex in another pane.
//
// The contract this file pins:
//   1. Only open / reveal / focusRequest authorize taking focus from elsewhere.
//   2. Structural churn (terminal appears, finishes spawning, is replaced) may
//      only re-target focus the assistant ALREADY owns.
//   3. Ownership is re-checked on the final deferred frame, not in the effect.
//   4. Both focus writers — HybridInputBar and the raw xterm fallback — share
//      the identical gate (#11465: gating only one path is inert).
//   5. Cleanup cancels HybridInputBar's nested frame so it can't land late.

const { focusMock, helpPanelState, panelStoreState, hybridHandle } = vi.hoisted(() => ({
  focusMock: vi.fn(),
  helpPanelState: {
    clearDroppedPreferredAgent: vi.fn(),
    setAutoLaunchEnabled: vi.fn(),
    requestFocus: vi.fn(),
    setActiveFigureNumber: vi.fn(),
    addFigure: vi.fn(),
    setActiveSlot: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    // #12108: the panel reads its lane pointer; the mocked selectors
    // above project this same flat object as that lane.
    activeSlot: 0,
    sessions: {} as Record<number, unknown>,
    isOpen: true,
    width: 380,
    terminalId: "t-1" as string | null,
    agentId: "claude" as string | null,
    // "claude" rather than null: these suites exercise the PTY LAUNCH path, and the
    // Daintree Assistant is now the default surface when no agent is chosen — a null
    // preference renders the native panel and never launches a terminal at all. Naming
    // a terminal-backed agent keeps each test about the thing it is testing.
    preferredAgentId: "claude" as string | null,
    sessionId: null as string | null,
    introDismissed: true,
    conversationTouched: false,
    hibernateSessions: {} as Record<string, unknown>,
    focusRequest: 0,
    figures: [] as unknown[],
    markConversationStarted: vi.fn(),
    setWidth: vi.fn(),
    setOpen: vi.fn(),
    clearTerminal: vi.fn(),
    setPreferredAgent: vi.fn(),
    setTerminal: vi.fn(),
    dismissIntro: vi.fn(),
    setHibernateSession: vi.fn(),
    clearHibernateSession: vi.fn(),
  },
  panelStoreState: {
    panelIds: [] as string[],
    panelsById: {} as Record<
      string,
      { agentState?: string; cwd?: string; spawnStatus?: string; isInputLocked?: boolean }
    >,
    preferredTerminalFocusTarget: "hybridInput" as "hybridInput" | "xterm",
    removePanel: vi.fn(),
    addPanel: vi.fn().mockResolvedValue(""),
  },
  // Stands in for HybridInputBar's imperative handle. `focusWithCursorAtEnd`
  // schedules the real focus inside its own rAF behind a generation token, and
  // `cancelPendingFocus` invalidates it — the exact shape HelpPanel must drive.
  hybridHandle: {
    generation: 0,
    scheduled: 0,
    editor: null as HTMLElement | null,
    focusWithCursorAtEnd: vi.fn(),
    cancelPendingFocus: vi.fn(),
  },
}));

const snapshot = {
  showResumeBanner: false,
  tierMismatch: null,
  isApprovingTier: false,
  assistantVersionTooOld: null,
};

// Controls `shouldShowHybridInputBar` per test without re-mocking the module.
let hybridBarVisible = true;
// Controls whether the mocked bar publishes an imperative handle — `null` models
// the lazy Suspense window where the ref hasn't attached yet.
let hybridHandleAttached = true;

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  DropdownMenuTrigger: ({ children }: { children?: unknown }) => <>{children as never}</>,
  DropdownMenuContent: ({ children }: { children?: unknown }) => (
    <div data-testid="overflow-menu">{children as never}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children?: unknown;
    onSelect?: (e: Event) => void;
  }) => (
    <button type="button" onClick={() => onSelect?.(new Event("select"))}>
      {children as never}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/controllers/HelpSessionController", () => ({
  HelpSessionController: class {
    start = vi.fn();
    stop = vi.fn();
    subscribe = (_cb: () => void) => () => {};
    getSnapshot = () => snapshot;
    syncInputs = vi.fn();
    handleTerminalPanelMissing = vi.fn();
    handleAgentExited = vi.fn();
    handleViewRevealed = vi.fn();
    selectAgent = vi.fn();
    newSession = vi.fn();
    runAnyway = vi.fn();
    dismissResumeBanner = vi.fn();
    dismissTierMismatch = vi.fn();
    approveTierOnce = vi.fn();
    alwaysAllowTier = vi.fn();
  },
}));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));
vi.mock("@/components/icons/DaintreeIcon", () => ({ DaintreeIcon: () => null }));

// The assistant's xterm lives inside the aside, so its helper textarea is a real
// descendant of `panelRef` — that containment is what makes `isAssistantFocused()`
// true after the xterm fallback fires.
vi.mock("@/components/Terminal/XtermAdapter", () => ({
  XtermAdapter: () => (
    <div data-testid="xterm-adapter">
      <textarea className="xterm-helper-textarea" data-testid="xterm-textarea" />
    </div>
  ),
}));

vi.mock("@/components/Terminal/HybridInputBar", () => ({
  HybridInputBar: ({ ref }: { ref?: React.Ref<unknown> }) => {
    useImperativeHandle(ref, () => (hybridHandleAttached ? hybridHandle : null), []);
    return (
      <div className="cm-editor" data-testid="assistant-cm-editor">
        {/* The element the deferred grab really focuses. Publishing it to the
            handle keeps `isAssistantFocused()` honest: a landed grab leaves
            `document.activeElement` genuinely inside the assistant root. */}
        <textarea
          data-testid="assistant-cm-input"
          ref={(el) => {
            hybridHandle.editor = el;
          }}
        />
      </div>
    );
  },
}));

vi.mock("@/components/Terminal/MissingCliGate", () => ({ MissingCliGate: () => null }));
vi.mock("@/components/Terminal/terminalFocus", async (importOriginal) => {
  // Keep the real `getTerminalFocusTarget` so target resolution is exercised
  // for real; only the visibility predicate is driven per test.
  const actual = await importOriginal<typeof import("@/components/Terminal/terminalFocus")>();
  return { ...actual, shouldShowHybridInputBar: () => hybridBarVisible };
});
vi.mock("./HelpIntroBanner", () => ({ HelpIntroBanner: () => null }));
vi.mock("./HelpPanelHeader", () => ({ HelpPanelHeader: () => null }));
vi.mock("./HelpPanelBanners", () => ({ HelpPanelBanners: () => null }));
vi.mock("./HelpPanelVersionGate", () => ({ HelpPanelVersionGate: () => null }));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    focus: (...args: unknown[]) => focusMock(...args),
    setFocused: vi.fn(),
    notifyUserInput: vi.fn(),
    repaintForReveal: vi.fn(),
  },
}));

vi.mock("@/clients", () => ({ terminalClient: { submit: vi.fn(), sendKey: vi.fn() } }));
vi.mock("@shared/config/agentIds", () => ({
  BUILT_IN_AGENT_IDS: ["claude", "codex", "claude-code"] as const,
  ASSISTANT_ONLY_AGENT_IDS: [] as const,
  LAUNCHABLE_AGENT_IDS: ["claude", "codex", "claude-code"] as const,
  isBuiltInAgentId: (v: unknown): v is string =>
    typeof v === "string" && ["claude", "codex", "claude-code"].includes(v),
  isAssistantOnlyAgentId: () => false,
}));
vi.mock("../../../shared/utils/agentAvailability", () => ({ isAgentInstalled: () => true }));
vi.mock("@/lib/accessibility", () => ({ TABBABLE_SELECTOR: "button" }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(), getContext: () => ({}) },
}));
vi.mock("@/lib/sidebarToggle", () => ({ suppressSidebarResizes: vi.fn() }));
vi.mock("@/hooks/useEscapeStack", () => ({ useEscapeStack: vi.fn() }));
vi.mock("@/types", () => ({ TerminalRefreshTier: { BACKGROUND: 0, ACTIVE: 1 } }));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) =>
    ({
      claude: { name: "Claude", icon: () => null },
      codex: { name: "Codex", icon: () => null },
      "claude-code": { name: "Claude Code", icon: () => null },
    })[id],
  getAssistantSupportedAgentIds: () => ["claude", "codex", "claude-code"],
}));

vi.mock("@/store/helpPanelStore", () => {
  const store = (selector?: (s: typeof helpPanelState) => unknown) =>
    selector ? selector(helpPanelState) : helpPanelState;
  store.getState = () => helpPanelState;
  return {
    useHelpPanelStore: store,
    HELP_PANEL_MIN_WIDTH: 320,
    HELP_PANEL_MAX_WIDTH: 800,
    // #12108 selectors. Fixtures stay flat, so these project the same object
    // as the lane and every existing assertion keeps working.
    selectSlot: (s: typeof helpPanelState) => s,
    selectActiveSlot: (s: typeof helpPanelState) => s,
    selectOpenSlots: () => [0],
    selectSlotTerminalIds: (s: typeof helpPanelState) => (s.terminalId ? [s.terminalId] : []),
    selectSlotForTerminal: (s: typeof helpPanelState, id: string) =>
      s.terminalId === id && id ? 0 : null,
  };
});

vi.mock("@/store", () => {
  const panelStore = (selector?: (s: typeof panelStoreState) => unknown) =>
    selector ? selector(panelStoreState) : panelStoreState;
  panelStore.getState = () => panelStoreState;

  const cliState = {
    availability: { claude: "ready", codex: "ready", "claude-code": "ready" } as Record<
      string,
      string
    >,
    isInitialized: true,
    hasRealData: true,
    details: {} as Record<string, unknown>,
  };
  const cliStore = (selector?: (s: typeof cliState) => unknown) =>
    selector ? selector(cliState) : cliState;
  cliStore.getState = () => cliState;

  const projectState = { currentProject: { id: "proj-1", path: "/repo" } };
  const projectStore = (selector?: (s: typeof projectState) => unknown) =>
    selector ? selector(projectState) : projectState;
  projectStore.getState = () => projectState;

  const worktreeState = { activeWorktreeId: null as string | null };
  const worktreeStore = (selector?: (s: typeof worktreeState) => unknown) =>
    selector ? selector(worktreeState) : worktreeState;
  worktreeStore.getState = () => worktreeState;

  const terminalInputState = { hybridInputEnabled: true };
  const terminalInputStore = (selector?: (s: typeof terminalInputState) => unknown) =>
    selector ? selector(terminalInputState) : terminalInputState;
  terminalInputStore.getState = () => terminalInputState;

  return {
    usePanelStore: panelStore,
    useCliAvailabilityStore: cliStore,
    useProjectStore: projectStore,
    useWorktreeSelectionStore: worktreeStore,
    useTerminalInputStore: terminalInputStore,
    getTerminalRefreshTier: () => 0,
  };
});

// Faithful macro-focus mock: `setRegionRef` really records the assistant root so
// `isAssistantFocused()` resolves containment against the live DOM exactly as
// macroFocusStore.ts:94 does. The whole fix turns on that answer, so a stubbed
// constant here would make every assertion below meaningless.
vi.mock("@/store/macroFocusStore", () => {
  let assistantRoot: HTMLElement | null = null;
  const state = {
    focusedRegion: null as string | null,
    setRegionRef: vi.fn((region: string, el: HTMLElement | null) => {
      if (region === "assistant") assistantRoot = el;
    }),
  };
  const store = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  store.getState = () => state;
  store.setState = (partial: Partial<typeof state>) => Object.assign(state, partial);
  return {
    useMacroFocusStore: store,
    isAssistantFocused: () =>
      state.focusedRegion === "assistant" ||
      Boolean(assistantRoot && assistantRoot.contains(document.activeElement)),
  };
});

vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../FigureRail", () => ({ FigureRail: () => null }));

import { HelpPanel } from "../HelpPanel";
import { __resetHelpSessionControllersForTests } from "@/controllers/helpSessionControllerRegistry";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import {
  _resetForTests as resetTooltipDismissRegistry,
  isTooltipFocusOpenSuppressed,
  registerTooltipDismiss,
} from "@/lib/tooltipDismissRegistry";

// rAF mock so every deferred focus frame is driven explicitly. A flush runs only
// the callbacks already queued, so HybridInputBar's nested frame needs a second
// flush — which is exactly the window the cleanup gap lived in.
const rafQueue = new Map<number, FrameRequestCallback>();
let rafIdCounter = 0;
function flushFrame(): void {
  const pending = [...rafQueue.entries()];
  rafQueue.clear();
  for (const [, cb] of pending) cb(0);
}

// A focusable element standing in for Ask Codex's CodeMirror in another pane.
let foreignEditor: HTMLTextAreaElement;

function focusForeignEditor(): void {
  act(() => {
    foreignEditor.focus();
    // Losing the macro region is part of clicking into another pane, and it is not the
    // focus() call that does it: `AppLayout`'s window-level capture mousedown handler
    // clears the claim whenever a press lands outside the focused region's ref. Nothing
    // in this file mounts AppLayout, so the same effect is applied here — otherwise the
    // assistant keeps a region it no longer has any claim to and every "another pane
    // owns focus" assertion below is testing the wrong state.
    useMacroFocusStore.setState({ focusedRegion: null });
  });
}

/**
 * The assistant taking ownership the way a user does: a press inside the panel.
 *
 * NOT `panelRoot.focus()`, which is what this used to do. The panel root deliberately
 * carries no `tabindex` at rest — a permanently focusable region collapses any selection
 * drag started inside it — so focusing it is now a no-op, and a test that did it would
 * assert against an ownership state the app can no longer be in. The press is the real
 * path: `HelpPanel`'s own `onMouseDown` claims the macro region from it.
 */
function claimAssistantFocus(): void {
  const root = document.getElementById("daintree-assistant-panel");
  if (!root) throw new Error("the assistant panel is not rendered");
  // A press on non-focusable panel chrome does two things in a browser, and both matter
  // to what the reveal effect decides: it BLURS whatever child held focus, and it claims
  // the macro region. jsdom performs neither for a synthetic event, so both are done by
  // hand — the blur first, because "focus is parked on the panel rather than in the
  // editor" is the precondition these tests are setting up.
  const active = document.activeElement;
  if (active instanceof HTMLElement && root.contains(active)) active.blur();
  root.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  if (useMacroFocusStore.getState().focusedRegion !== "assistant") {
    throw new Error(
      `the press did not claim the macro region (got ${String(useMacroFocusStore.getState().focusedRegion)})`
    );
  }
}

function setPanel(id: string, spawnStatus = "ready", agentState = "idle"): void {
  panelStoreState.panelIds = [id];
  panelStoreState.panelsById = { [id]: { agentState, cwd: "/repo", spawnStatus } };
}

/** Replace the panel object's identity without changing anything load-bearing —
 *  what `updateLastObservedTitle` / the activity buffer do on every tick. */
function churnPanelIdentity(id: string): void {
  const prev = panelStoreState.panelsById[id];
  panelStoreState.panelsById = { [id]: { ...prev } };
}

function clearFocusSpies(): void {
  focusMock.mockClear();
  hybridHandle.focusWithCursorAtEnd.mockClear();
  hybridHandle.cancelPendingFocus.mockClear();
  hybridHandle.scheduled = 0;
}

/** True when either focus writer fired — the paired-path assertion (#11465). */
function anyFocusWriterCalled(): boolean {
  return focusMock.mock.calls.length > 0 || hybridHandle.focusWithCursorAtEnd.mock.calls.length > 0;
}

beforeEach(() => {
  // #12108: controllers live in a per-view registry, not component
  // state, so they outlive a render and must be reset between tests.
  __resetHelpSessionControllersForTests();
  resetTooltipDismissRegistry();
  rafQueue.clear();
  rafIdCounter = 0;
  hybridBarVisible = true;
  hybridHandleAttached = true;
  clearFocusSpies();

  hybridHandle.generation = 0;
  hybridHandle.editor = null;
  // Model HybridInputBar.tsx:626-652: capture the generation, defer the real
  // focus to a frame, and bail if the generation moved on in the meantime.
  hybridHandle.focusWithCursorAtEnd.mockImplementation(() => {
    const gen = hybridHandle.generation;
    hybridHandle.scheduled += 1;
    requestAnimationFrame(() => {
      if (hybridHandle.generation !== gen) return;
      hybridHandle.editor?.focus();
    });
    return true;
  });
  hybridHandle.cancelPendingFocus.mockImplementation(() => {
    hybridHandle.generation += 1;
  });
  // The real service focuses xterm synchronously. Doing it here too means the
  // xterm route is proved by where focus actually landed, not just by a spy.
  focusMock.mockImplementation(() => {
    document.querySelector<HTMLTextAreaElement>("[data-testid=xterm-textarea]")?.focus();
  });

  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = ++rafIdCounter;
    rafQueue.set(id, cb);
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number): void => {
    rafQueue.delete(id);
  }) as typeof globalThis.cancelAnimationFrame;

  helpPanelState.isOpen = true;
  helpPanelState.terminalId = "t-1";
  helpPanelState.agentId = "claude";
  helpPanelState.preferredAgentId = null;
  helpPanelState.conversationTouched = false;
  helpPanelState.focusRequest = 0;
  panelStoreState.preferredTerminalFocusTarget = "hybridInput";
  setPanel("t-1");

  foreignEditor = document.createElement("textarea");
  foreignEditor.className = "cm-editor";
  document.body.appendChild(foreignEditor);

  Object.defineProperty(globalThis, "window", {
    value: {
      electron: {
        // The native assistant panel mounts whenever no terminal-backed agent is
        // chosen, so the HelpPanel harness has to model its IPC namespace. Without
        // it the panel throws on subscribe and every test in the file fails for a
        // reason that has nothing to do with what it asserts.
        assistantHost: {
          start: vi.fn().mockResolvedValue({ sessionId: "assistant-test-session" }),
          send: vi.fn().mockResolvedValue({ delivered: true }),
          stop: vi.fn().mockResolvedValue({ stopped: true }),
          onEvent: vi.fn(() => () => {}),
          onPeerPrompt: () => () => {},
          onSequenceGap: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
        },
        help: { getPinnedActionContext: vi.fn().mockResolvedValue({}) },
        app: { onViewRevealed: () => () => {} },
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  foreignEditor.remove();
});

/** Render, settle the authorized open grab, then hand focus to the other pane. */
function renderSettledWithForeignFocus() {
  const view = render(<HelpPanel width={380} />);
  act(() => flushFrame());
  act(() => flushFrame());
  focusForeignEditor();
  clearFocusSpies();
  return view;
}

describe("HelpPanel — reveal focus ownership (#11472)", () => {
  describe("background churn must not steal focus", () => {
    it("ignores a panel-identity replacement while another pane owns focus", () => {
      const { rerender } = renderSettledWithForeignFocus();

      churnPanelIdentity("t-1");
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      expect(anyFocusWriterCalled()).toBe(false);
      expect(document.activeElement).toBe(foreignEditor);
    });

    it("ignores an agent-state transition while another pane owns focus", () => {
      const { rerender } = renderSettledWithForeignFocus();

      // The Codex completionPatterns case from the issue: working -> completed
      // -> working repeatedly inside a single turn.
      for (const next of ["completed", "working", "completed"]) {
        setPanel("t-1", "ready", next);
        rerender(<HelpPanel width={380} />);
        act(() => flushFrame());
        act(() => flushFrame());
      }

      expect(anyFocusWriterCalled()).toBe(false);
      expect(document.activeElement).toBe(foreignEditor);
    });

    it("does not re-grab focus when the terminal is replaced in the background", () => {
      const { rerender } = renderSettledWithForeignFocus();

      helpPanelState.terminalId = "t-2";
      setPanel("t-2");
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      expect(anyFocusWriterCalled()).toBe(false);
      expect(document.activeElement).toBe(foreignEditor);
    });

    // #11465's lesson: gating only the HybridInputBar path leaves the raw xterm
    // fallback as a silent bypass. Same structural trigger, hybrid bar hidden,
    // so the xterm writer is the one under test.
    it("gates the raw xterm fallback too, not just the HybridInputBar path", () => {
      hybridBarVisible = false;
      setPanel("t-1", "spawning");
      const { rerender } = render(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());
      focusForeignEditor();
      clearFocusSpies();

      setPanel("t-1", "ready");
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      expect(focusMock).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(foreignEditor);
    });

    it("blocks a structural retry when focus leaves between the effect and its frame", () => {
      setPanel("t-1", "spawning");
      const { rerender } = render(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());
      act(() => {
        claimAssistantFocus();
      });
      clearFocusSpies();

      // The assistant still owns focus when the structural change commits...
      setPanel("t-1", "ready");
      rerender(<HelpPanel width={380} />);
      // ...but the user clicks into the other pane before the frame runs, so
      // the recheck inside the frame — not the effect body — has to catch it.
      focusForeignEditor();
      act(() => flushFrame());
      act(() => flushFrame());

      expect(anyFocusWriterCalled()).toBe(false);
      expect(document.activeElement).toBe(foreignEditor);
    });

    // The bar defers the real focus to a frame of its own, so ownership can
    // still change AFTER HelpPanel's frame has already asked for focus. That
    // last frame is the one the issue calls the "final deferred frame".
    it("revokes the bar's pending focus when ownership is lost in the final frame", () => {
      setPanel("t-1", "spawning");
      const { rerender } = render(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());
      act(() => {
        claimAssistantFocus();
      });
      clearFocusSpies();

      setPanel("t-1", "ready");
      rerender(<HelpPanel width={380} />);
      // Frame 1: HelpPanel asks the bar for focus; the bar queues its own frame.
      act(() => flushFrame());
      expect(hybridHandle.focusWithCursorAtEnd).toHaveBeenCalled();
      expect(hybridHandle.scheduled).toBe(1);

      // The user clicks into the other pane in the gap.
      focusForeignEditor();
      hybridHandle.cancelPendingFocus.mockClear();

      // Frame 2: the guard runs ahead of the bar's callback and revokes it.
      act(() => flushFrame());

      // Asserted on where focus ended up, not just on the spy — the bar's
      // callback runs in this same flush, so the caret moving would show here.
      expect(hybridHandle.cancelPendingFocus).toHaveBeenCalled();
      expect(document.activeElement).toBe(foreignEditor);
      expect(document.activeElement).not.toBe(
        document.querySelector("[data-testid=assistant-cm-input]")
      );
    });
  });

  describe("legitimate focus requests still land", () => {
    it("focuses the assistant on open even when another pane owns focus", () => {
      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      focusForeignEditor();
      clearFocusSpies();

      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());

      expect(hybridHandle.focusWithCursorAtEnd).toHaveBeenCalled();
    });

    it("focuses the assistant on reveal even when another pane owns focus", () => {
      const { rerender } = render(<HelpPanel width={0} isVisible={false} />);
      focusForeignEditor();
      clearFocusSpies();

      rerender(<HelpPanel width={380} isVisible />);
      act(() => flushFrame());

      expect(hybridHandle.focusWithCursorAtEnd).toHaveBeenCalled();
    });

    it("re-focuses a blurred but open panel on a focusRequest bump (Cmd+L)", () => {
      const { rerender } = renderSettledWithForeignFocus();

      helpPanelState.focusRequest += 1;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());

      expect(hybridHandle.focusWithCursorAtEnd).toHaveBeenCalled();
    });

    it("retries the grab on spawning -> ready while the assistant owns focus", () => {
      // Cold open against a still-spawning terminal parks focus on the panel
      // root rather than the editor. Becoming ready is a structural retry, and
      // the assistant still owning focus is what authorizes it.
      setPanel("t-1", "spawning");
      const { rerender } = render(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());
      act(() => {
        claimAssistantFocus();
      });
      clearFocusSpies();

      setPanel("t-1", "ready");
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());

      expect(hybridHandle.focusWithCursorAtEnd).toHaveBeenCalled();
    });

    it("does not retry on spawning -> ready when another pane owns focus", () => {
      setPanel("t-1", "spawning");
      const { rerender } = render(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());
      focusForeignEditor();
      clearFocusSpies();

      setPanel("t-1", "ready");
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      expect(anyFocusWriterCalled()).toBe(false);
      expect(document.activeElement).toBe(foreignEditor);
    });

    // Mounting already-open is what puts the open branch through StrictMode's
    // setup/cleanup/setup replay. The first setup's frame is cancelled and its
    // pending bar focus revoked, so only tracking the last *completed* trigger
    // (rather than the last setup) lets the replay reissue the grab.
    it("still lands focus under StrictMode's mount/cleanup/mount replay", () => {
      foreignEditor.focus();
      expect(document.activeElement).toBe(foreignEditor);

      render(
        <StrictMode>
          <HelpPanel width={380} />
        </StrictMode>
      );
      act(() => flushFrame());
      act(() => flushFrame());

      expect(hybridHandle.focusWithCursorAtEnd).toHaveBeenCalled();
      expect(document.activeElement).toBe(
        document.querySelector("[data-testid=assistant-cm-input]")
      );
    });

    it("actually lands focus in the assistant input, not just dispatches the request", () => {
      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      focusForeignEditor();
      clearFocusSpies();

      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      // Frame 1 asks the bar; frame 2 is where the bar actually focuses.
      act(() => flushFrame());
      expect(document.activeElement).toBe(foreignEditor);
      act(() => flushFrame());

      expect(document.activeElement).toBe(
        document.querySelector("[data-testid=assistant-cm-input]")
      );
    });
  });

  describe("the remembered target picks the surface, and never authorizes", () => {
    it("focuses xterm instead of the input bar when the preference is xterm", () => {
      panelStoreState.preferredTerminalFocusTarget = "xterm";
      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      focusForeignEditor();
      clearFocusSpies();

      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      // The bar's own preference check would have aborted silently, leaving an
      // authorized open request with focus still in the other pane.
      expect(hybridHandle.focusWithCursorAtEnd).not.toHaveBeenCalled();
      expect(focusMock).toHaveBeenCalledWith("t-1");
    });

    it("routes to xterm when the assistant input is locked", () => {
      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      focusForeignEditor();
      clearFocusSpies();

      panelStoreState.panelsById = {
        "t-1": { agentState: "idle", cwd: "/repo", spawnStatus: "ready", isInputLocked: true },
      };
      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      expect(hybridHandle.focusWithCursorAtEnd).not.toHaveBeenCalled();
      expect(focusMock).toHaveBeenCalledWith("t-1");
    });

    // The preference must not become a back door around the ownership gate.
    it("does not let the xterm preference authorize a background structural retry", () => {
      panelStoreState.preferredTerminalFocusTarget = "xterm";
      setPanel("t-1", "spawning");
      const { rerender } = render(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());
      focusForeignEditor();
      clearFocusSpies();

      setPanel("t-1", "ready");
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      expect(anyFocusWriterCalled()).toBe(false);
      expect(document.activeElement).toBe(foreignEditor);
    });
  });

  describe("restoring focus on close", () => {
    it("returns focus to the opener when the assistant still owns it", () => {
      const opener = document.createElement("button");
      document.body.appendChild(opener);
      opener.focus();

      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      helpPanelState.isOpen = false;
      rerender(<HelpPanel width={380} />);

      expect(document.activeElement).toBe(opener);
      opener.remove();
    });

    it("leaves focus alone when the user has already moved to another pane", () => {
      const opener = document.createElement("button");
      document.body.appendChild(opener);
      opener.focus();

      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      // The user leaves the assistant for another pane, then closes it from a
      // global shortcut. Restoring the opener here would be the same steal.
      focusForeignEditor();
      helpPanelState.isOpen = false;
      rerender(<HelpPanel width={380} />);

      expect(document.activeElement).toBe(foreignEditor);
      opener.remove();
    });

    it("dismisses tooltips before handing focus back, not after", () => {
      // Radix opens tooltips on focus, and the usual opener IS a tooltip
      // trigger (the toolbar assistant button). Suppressing after the focus
      // lands is inert, so the order is the whole fix.
      const order: string[] = [];
      const unregister = registerTooltipDismiss(() => order.push("dismiss"));
      const opener = document.createElement("button");
      opener.addEventListener("focus", () => order.push("focus"));
      document.body.appendChild(opener);
      opener.focus();
      order.length = 0;

      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      expect(isTooltipFocusOpenSuppressed()).toBe(false);

      helpPanelState.isOpen = false;
      rerender(<HelpPanel width={380} />);

      // Arming is dismissAllTooltips()'s own contract, pinned in the registry
      // suite — asserting it here too would only add a wall-clock race against
      // the 250ms window.
      expect(order).toEqual(["dismiss", "focus"]);
      unregister();
      opener.remove();
    });

    it("leaves tooltips alone when it declines to restore focus", () => {
      // Guards against hoisting the call out of the restore predicate: no focus
      // moves here, so there is nothing to suppress but plenty to swallow.
      const dismissed = vi.fn();
      const unregister = registerTooltipDismiss(dismissed);
      const opener = document.createElement("button");
      document.body.appendChild(opener);
      opener.focus();

      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());
      act(() => flushFrame());

      focusForeignEditor();
      helpPanelState.isOpen = false;
      rerender(<HelpPanel width={380} />);

      expect(dismissed).not.toHaveBeenCalled();
      expect(isTooltipFocusOpenSuppressed()).toBe(false);
      unregister();
      opener.remove();
    });
  });

  describe("live panel reads and deferred-frame cancellation", () => {
    it("does not target a terminal removed between the effect and its frame", () => {
      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      clearFocusSpies();

      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      // The panel disappears before the deferred frame runs — only a live read
      // at frame time can see this.
      panelStoreState.panelIds = [];
      panelStoreState.panelsById = {};
      act(() => flushFrame());

      expect(anyFocusWriterCalled()).toBe(false);
    });

    it.each(["failed", "missing-cli"])(
      "does not target a terminal that turned %s before its frame",
      (status) => {
        helpPanelState.isOpen = false;
        const { rerender } = render(<HelpPanel width={380} />);
        clearFocusSpies();

        helpPanelState.isOpen = true;
        rerender(<HelpPanel width={380} />);
        setPanel("t-1", status);
        act(() => flushFrame());

        expect(anyFocusWriterCalled()).toBe(false);
      }
    );

    it("cancels HybridInputBar's nested frame when the panel closes mid-grab", () => {
      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      clearFocusSpies();

      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      // First frame: HelpPanel's own rAF runs and asks the bar for focus, which
      // defers the real `view.focus()` to a frame of its own.
      act(() => flushFrame());
      expect(hybridHandle.scheduled).toBe(1);

      const editor = document.createElement("textarea");
      document.body.appendChild(editor);
      hybridHandle.editor = editor;

      // The panel closes in that gap. Without cancelPendingFocus() the bar's
      // queued frame would still fire and focus a closed panel's editor.
      helpPanelState.isOpen = false;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());

      expect(hybridHandle.cancelPendingFocus).toHaveBeenCalled();
      expect(document.activeElement).not.toBe(editor);
      editor.remove();
    });

    it("falls back to xterm when the bar is mounted but its editor is not ready", () => {
      // `focusWithCursorAtEnd()` returning false means no view was mounted and
      // nothing was scheduled, so the xterm fallback is safe rather than a
      // second competing grab.
      hybridHandle.focusWithCursorAtEnd.mockImplementation(() => false);
      helpPanelState.isOpen = false;
      const { rerender } = render(<HelpPanel width={380} />);
      clearFocusSpies();

      helpPanelState.isOpen = true;
      rerender(<HelpPanel width={380} />);
      act(() => flushFrame());

      expect(hybridHandle.focusWithCursorAtEnd).toHaveBeenCalled();
      expect(focusMock).toHaveBeenCalledWith("t-1");
    });
  });
});
