// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, createEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  getPanelKindIds,
  getPanelKindConfig,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";

let mockRecipes: Array<{
  id: string;
  name: string;
  worktreeId?: string;
  projectId?: string;
  scope?: string;
  shadowedBy?: string;
}> = [];
let mockMruEntries: Array<{ id: string; score: number; lastAccessedAt: number }> = [];
const runRecipeWithResultsMock = vi.fn();
const notifySpawnFailuresMock = vi.fn();
const actionDispatchMock = vi.fn();
const recordActionMruMock = vi.fn();
const addPanelMock = vi.fn();
let popoverCloseAutoFocusSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let popoverPointerDownOutsideSpy: (() => void) | null = null;
let popoverEscapeKeyDownSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let popoverOpenAutoFocusSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let popoverOpenChangeSpy: ((open: boolean) => void) | null = null;
/** Which side the content anchored on — the one thing placement changes. */
let popoverSide: string | undefined;
let popoverModal: boolean | undefined = undefined;

// See dockLaunchItems.test.ts — avoid the real registry's eager TerminalPane import.
vi.mock("@/registry", () => ({
  getSpawnablePanelKinds: (): PanelKindConfig[] =>
    getPanelKindIds()
      .filter((id) => id !== "agent")
      .map((id) => getPanelKindConfig(id))
      .filter((c): c is PanelKindConfig => c !== undefined && c.showInPalette !== false),
  subscribeToPanelKindDefinitions: () => () => {},
  getPanelKindDefinitionsSnapshot: () => 0,
}));

// Callable as well as static: the launcher subscribes for the running pip and
// `activateDockLaunchItem` reaches the same store through `getState`.
const panelStoreState = {
  addPanel: addPanelMock,
  panelsById: { "panel-1": { location: "grid" } },
  panelIds: [] as string[],
};
vi.mock("@/store/panelStore", () => ({
  usePanelStore: Object.assign(
    (selector: (s: typeof panelStoreState) => unknown) => selector(panelStoreState),
    { getState: () => panelStoreState }
  ),
}));

vi.mock("@/components/PanelPalette/PanelKindIcon", () => ({
  PanelKindIcon: ({ iconId }: { iconId: string }) => <span data-icon={iconId} />,
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(
    (selector: (s: { recipes: typeof mockRecipes }) => unknown) =>
      selector({ recipes: mockRecipes }),
    {
      getState: () => ({ runRecipeWithResults: runRecipeWithResultsMock }),
    }
  ),
}));

vi.mock("@/utils/recipeNotify", () => ({
  notifyRecipeSpawnFailures: (...args: unknown[]) => notifySpawnFailuresMock(...args),
}));

const logErrorMock = vi.fn();
vi.mock("@/utils/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/logger")>()),
  logError: (...args: unknown[]) => logErrorMock(...args),
}));

// The real slice defines getSortedActionMruList ONCE and reads store state at
// call time, so its identity is stable across renders. The mock must match:
// handing back a fresh arrow each render would silently invalidate any memo
// keyed on it and hide staleness bugs this suite is meant to catch.
const getSortedActionMruListMock = () => mockMruEntries;

vi.mock("@/store/actionMruStore", () => ({
  useActionMruStore: Object.assign(
    (
      selector: (s: {
        getSortedActionMruList: () => typeof mockMruEntries;
        actionUsageEntries: Map<string, unknown>;
      }) => unknown
    ) =>
      selector({
        getSortedActionMruList: getSortedActionMruListMock,
        // Subscribed by the model purely to invalidate the recency band, so it
        // must be non-empty or the getter is short-circuited away.
        actionUsageEntries: new Map([["seed", { uses: [1] }]]),
      }),
    {
      getState: () => ({ recordActionMru: recordActionMruMock }),
    }
  ),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => actionDispatchMock(...args),
  },
}));

// Pin state. `dispatchToolbarVisibility` is deliberately NOT mocked — it is the
// seam Settings → Toolbar shares, and mocking it would let the launcher write
// the pin any way it liked while the suite still passed.
let mockAgentSettings: { agents?: Record<string, { pinned?: boolean }> } | null = { agents: {} };
let mockAgentAvailability: Record<string, string> = {};
let mockToolbarLayout: {
  pinnedButtons: Record<string, boolean>;
  leftButtons: string[];
  rightButtons: string[];
} = { pinnedButtons: {}, leftButtons: [], rightButtons: [] };
const setAgentPinnedMock = vi.fn();
const setPanelButtonOnToolbarMock = vi.fn();
const positionAgentButtonMock = vi.fn();
const toggleButtonVisibilityMock = vi.fn();

// `getState` alongside each selector: the real hooks carry Zustand's static API,
// and a factory that omits it turns a future `useXStore.getState()` anywhere in
// this component's import graph into an opaque collection failure. Each state
// reader is declared INSIDE its factory — `vi.mock` is hoisted above every
// top-level const, so referencing one at factory-evaluation time is a TDZ error
// (the `mock*` bindings below are fine because they are only read at call time).
const updateWorktreePresetMock = vi.fn(() => Promise.resolve());
const updateAgentMock = vi.fn(() => Promise.resolve());
const refreshAvailabilityMock = vi.fn(() => Promise.resolve());

vi.mock("@/store/agentSettingsStore", () => {
  const getState = () => ({
    settings: mockAgentSettings,
    setAgentPinned: setAgentPinnedMock,
    updateWorktreePreset: updateWorktreePresetMock,
    updateAgent: updateAgentMock,
  });
  return {
    useAgentSettingsStore: Object.assign(
      (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState }
    ),
  };
});

// Presets the launcher expands into sibling rows. Controlled per test.
let mockMergedPresets: Array<{ id: string; name: string; displayTitle?: string; color?: string }> =
  [];
vi.mock("@/config/agents", () => ({
  getMergedPresets: () => mockMergedPresets,
  getAgentConfig: (id: string) => ({ id, name: id, icon: undefined }),
  getAgentIds: () => ["claude", "gemini"],
}));

// Real bindings keyed by action id, so a row asserting a hint proves the row
// resolved the right ACTION — not merely that some string rendered.
const mockKeybindings: Record<string, string> = {};
vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useKeybindingDisplay: (actionId: string) => mockKeybindings[actionId] ?? "",
}));

vi.mock("@/components/KeyboardShortcuts", () => ({
  AgentShortcutCapture: ({
    agentId,
    onCapture,
    onCancel,
  }: {
    agentId: string;
    onCapture: (combo: string) => void;
    onCancel: () => void;
  }) => (
    <div data-testid={`capture-widget-${agentId}`}>
      <button type="button" onClick={() => onCapture("Ctrl+Shift+9")}>
        capture
      </button>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));

vi.mock("@/store/cliAvailabilityStore", () => {
  const getState = () => ({
    availability: mockAgentAvailability,
    hasRealData: true,
    // Re-probed when the launcher opens and on view visibility changes;
    // throttled in the real store.
    refresh: refreshAvailabilityMock,
  });
  return {
    useCliAvailabilityStore: Object.assign(
      (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState }
    ),
  };
});

// Onboarding state feeds useLauncherDiscovery, whose rules are asserted in
// useLauncherDiscovery.test.tsx. Pinned here so the trigger's badge depends on
// nothing but the availability fixture: the real store hydrates on a microtask
// and keeps its `loaded` flag for the rest of the file.
let mockSeenAgentIds: string[] = [];
vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => ({
  NEW_AGENT_TTL_MS: 14 * 24 * 60 * 60 * 1000,
  useAgentDiscoveryOnboarding: () => ({
    loaded: true,
    seenAgentIds: mockSeenAgentIds,
    availabilityFirstSeen: {},
    // Dismissed, so the welcome card never suppresses the cue.
    welcomeCardDismissed: true,
    markAgentsSeen: vi.fn(),
    recordAgentFirstSeen: vi.fn(),
  }),
}));

vi.mock("@/store/toolbarPreferencesStore", () => {
  const getState = () => ({
    layout: mockToolbarLayout,
    setPanelButtonOnToolbar: setPanelButtonOnToolbarMock,
    positionAgentButton: positionAgentButtonMock,
    toggleButtonVisibility: toggleButtonVisibilityMock,
  });
  return {
    useToolbarPreferencesStore: Object.assign(
      (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState }
    ),
  };
});

// Mock UI primitives so the test focuses on this component's behavior, not
// Radix's pointer-event semantics inside jsdom. Mirrors AgentButton.test.tsx.
// Radix's real focus/dismiss behaviour (mount autofocus winning the lazy-chunk
// race, document-level Escape capture, the modal focus trap) is covered by
// e2e/full/panels/core-dock-launcher-search.spec.ts.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/popover", () => ({
  // Content is rendered unconditionally (not gated on `open`) so the existing
  // row-level assertions keep working without an open step; open/close is
  // exercised through the captured onOpenChange.
  Popover: ({
    children,
    onOpenChange,
    modal,
  }: {
    children: ReactNode;
    open?: boolean;
    modal?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    popoverOpenChangeSpy = onOpenChange ?? null;
    popoverModal = modal;
    return <>{children}</>;
  },
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    onOpenAutoFocus,
    onCloseAutoFocus,
    onPointerDownOutside,
    onEscapeKeyDown,
    onFocus,
    onKeyDown,
    onMouseDown,
    side,
  }: {
    children: ReactNode;
    side?: string;
    onOpenAutoFocus?: (e: { preventDefault: () => void }) => void;
    onCloseAutoFocus?: (e: { preventDefault: () => void }) => void;
    onPointerDownOutside?: () => void;
    onEscapeKeyDown?: (e: { preventDefault: () => void }) => void;
    onFocus?: React.FocusEventHandler<HTMLDivElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  }) => {
    popoverOpenAutoFocusSpy = onOpenAutoFocus ?? null;
    popoverCloseAutoFocusSpy = onCloseAutoFocus ?? null;
    popoverPointerDownOutsideSpy = onPointerDownOutside ?? null;
    popoverEscapeKeyDownSpy = onEscapeKeyDown ?? null;
    popoverSide = side;
    // Radix renders FocusScope/DismissableLayer with asChild, so these land on
    // the same node the focus trap parks focus on. tabIndex mirrors that.
    return (
      <div
        data-testid="dock-launcher-content"
        tabIndex={-1}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
      >
        {children}
      </div>
    );
  },
}));

// The palette chrome is a shared, separately-tested surface; stubbing it keeps
// this suite on the launcher's own wiring and off ScrollShadow's ResizeObserver
// and the dialog escape-stack. Props are spread through so the input's ARIA and
// key handling stay under test.
vi.mock("@/components/ui/AppPaletteDialog", () => {
  const AppPaletteDialog = {
    // The marker is load-bearing, not decoration: the anchored shell delegates
    // its header mousedown redirect off this attribute, so a stub without it
    // silently stops exercising that handler.
    Header: ({ label, children }: { label: string; children: ReactNode }) => (
      <div data-testid="dock-launcher-header" data-palette-header="">
        <span>{label}</span>
        {children}
      </div>
    ),
    Input: ({
      inputRef,
      ...props
    }: {
      inputRef?: React.Ref<HTMLInputElement>;
    } & React.InputHTMLAttributes<HTMLInputElement>) => (
      <input ref={inputRef} type="text" {...props} />
    ),
    Body: ({
      children,
      onNavigationKeyDown,
    }: {
      children: ReactNode;
      ariaLabel: string;
      activeDescendant?: string;
      onNavigationKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
    }) => (
      <div data-testid="dock-launcher-body" onKeyDown={onNavigationKeyDown}>
        {children}
      </div>
    ),
    Empty: ({ query }: { query: string }) => (
      <div data-testid="dock-launcher-empty">{query.trim() ? "no matches" : "nothing"}</div>
    ),
  };
  return {
    AppPaletteDialog,
    PALETTE_SURFACE_WIDTHS: {
      // Sentinel values, not the production pixels: this mock only has to satisfy
      // the real AppPalettePopover's width lookup, and copying the shipped
      // classes here would couple every future resize to six mock factories.
      anchored: "mock-anchored-width",
      command: "mock-command-width",
    },
  };
});

import { DockLaunchButton } from "../DockLaunchButton";
import { TOOLBAR_CUSTOMIZE_LABEL } from "../toolbarMenuStrings";
import { SlidersHorizontal } from "lucide-react";
import type { DockLaunchAgent } from "../DockLaunchMenuItems";

const AGENTS: DockLaunchAgent[] = [
  { id: "claude", name: "Claude", availability: "ready" },
  { id: "gemini", name: "Gemini", availability: "blocked" },
];

function renderButton(props: Partial<Parameters<typeof DockLaunchButton>[0]> = {}) {
  return render(
    <DockLaunchButton
      agents={AGENTS}
      onLaunchAgent={vi.fn()}
      activeWorktreeId={null}
      cwd="/tmp"
      {...props}
    />
  );
}

const OPTION = '[role="option"]';
const SELECTED_OPTION = '[role="option"][aria-selected="true"]';

function options(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(OPTION));
}

function selectedOption(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(SELECTED_OPTION);
}

/** The launcher's search box — the only textbox inside the menu. */
function searchInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector("input");
  if (!input) throw new Error("search input not found");
  return input;
}

/**
 * The row's visible trailing qualifier, or "" when it renders none.
 *
 * Read off `data-launcher-qualifier` rather than a class string or a position:
 * the point of these tests is which INFORMATION reaches the row, and that has
 * to keep holding when the treatment changes again.
 */
function qualifierTextOf(row: HTMLElement): string {
  return row.querySelector("[data-launcher-qualifier]")?.textContent?.trim() ?? "";
}

function listbox(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>('[role="listbox"]');
  if (!node) throw new Error("listbox not found");
  return node;
}

const POINTER_FACTORIES = {
  pointermove: createEvent.pointerMove,
  pointerleave: createEvent.pointerLeave,
  pointerover: createEvent.pointerOver,
} as const;

/**
 * jsdom defaults `pointerType` to "" and offers no way to set `timeStamp`
 * through the init dict, so a plain `fireEvent.pointerMove` exercises neither
 * the mouse-only guard nor the velocity sampler — it just passes through.
 */
function firePointer(
  target: Element,
  type: keyof typeof POINTER_FACTORIES,
  sample: { x: number; y: number; t: number }
): void {
  const event = POINTER_FACTORIES[type](target, {
    pointerType: "mouse",
    clientX: sample.x,
    clientY: sample.y,
  });
  Object.defineProperty(event, "timeStamp", { value: sample.t, configurable: true });
  fireEvent(target, event);
}

/**
 * A row's `onPointerEnter` is synthesised by React from `pointerover`, so a
 * real `pointerenter` never reaches it — which is why react-testing-library
 * aliases `fireEvent.pointerEnter` to `pointerOver`. The gate's own listeners
 * are native and take the real thing.
 */
function fireRowEnter(row: Element, sample: { x: number; y: number; t: number }): void {
  firePointer(row, "pointerover", sample);
}

/** Two samples 30px apart in 10ms — well past the sweep threshold. */
function startSweep(container: HTMLElement): void {
  const list = listbox(container);
  firePointer(list, "pointermove", { x: 0, y: 0, t: 0 });
  firePointer(list, "pointermove", { x: 0, y: 30, t: 10 });
}

// jsdom implements no layout, so it ships no scrollIntoView at all. The
// launcher scrolls the active option into view on every selection move.
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  mockRecipes = [];
  mockMruEntries = [];
  runRecipeWithResultsMock.mockReset().mockResolvedValue({
    spawned: [{ index: 0, terminalId: "t-0" }],
    failed: [],
  });
  notifySpawnFailuresMock.mockReset();
  logErrorMock.mockReset();
  actionDispatchMock.mockReset().mockResolvedValue({ ok: true, result: null });
  recordActionMruMock.mockReset();
  addPanelMock.mockReset().mockResolvedValue("panel-1");
  popoverCloseAutoFocusSpy = null;
  popoverPointerDownOutsideSpy = null;
  popoverEscapeKeyDownSpy = null;
  popoverOpenAutoFocusSpy = null;
  popoverOpenChangeSpy = null;
  popoverSide = undefined;
  popoverModal = undefined;
  mockAgentSettings = { agents: {} };
  mockAgentAvailability = {};
  mockSeenAgentIds = [];
  refreshAvailabilityMock.mockClear();
  mockToolbarLayout = { pinnedButtons: {}, leftButtons: [], rightButtons: [] };
  setAgentPinnedMock.mockReset();
  setPanelButtonOnToolbarMock.mockReset();
  positionAgentButtonMock.mockReset();
  toggleButtonVisibilityMock.mockReset();
  updateWorktreePresetMock.mockReset();
  updateAgentMock.mockReset();
  mockMergedPresets = [];
  for (const key of Object.keys(mockKeybindings)) delete mockKeybindings[key];
});

describe("DockLaunchButton", () => {
  it("renders a launch button with accessible label", () => {
    const { getByLabelText } = renderButton();
    expect(getByLabelText("Open launcher")).toBeTruthy();
  });

  describe("discovery badge", () => {
    beforeEach(() => {
      // A launchable agent nobody has acted on yet — the one input that turns
      // the cue on. What makes an agent "new" is useLauncherDiscovery's job.
      mockAgentAvailability = { claude: "ready" };
    });

    it("announces detected agents on the toolbar trigger and lights the dot", () => {
      const { getByLabelText, getByTestId } = renderButton({ placement: "toolbar" });

      expect(getByLabelText("Launcher — new agents detected")).toBeTruthy();
      expect(getByTestId("launcher-discovery-badge").getAttribute("data-visible")).toBe("true");
    });

    it("keeps the plain label and darkens the dot once the agent has been seen", () => {
      mockSeenAgentIds = ["claude"];
      const { getByLabelText, getByTestId } = renderButton({ placement: "toolbar" });

      expect(getByLabelText("Launcher")).toBeTruthy();
      expect(getByTestId("launcher-discovery-badge").getAttribute("data-visible")).toBe("false");
    });

    it("leaves the dock trigger unbadged for the same discovery state", () => {
      // The dock rail carries no cue of its own; badging both would announce
      // the same detection twice.
      const { getByLabelText, queryByTestId } = renderButton({ placement: "dock" });

      expect(getByLabelText("Open launcher")).toBeTruthy();
      expect(queryByTestId("launcher-discovery-badge")).toBeNull();
    });
  });

  describe("availability re-probing", () => {
    it("re-probes when the launcher opens, not merely on mount", () => {
      renderButton();
      expect(refreshAvailabilityMock).not.toHaveBeenCalled();

      act(() => popoverOpenChangeSpy!(true));
      expect(refreshAvailabilityMock).toHaveBeenCalledTimes(1);
    });

    it("watches visibilitychange from the toolbar placement only", () => {
      const toolbar = renderButton({ placement: "toolbar" });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(refreshAvailabilityMock).toHaveBeenCalledTimes(1);
      toolbar.unmount();

      refreshAvailabilityMock.mockClear();
      renderButton({ placement: "dock" });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Both launchers are mounted at once, so a dock listener would double
      // every probe on resume for no extra signal.
      expect(refreshAvailabilityMock).not.toHaveBeenCalled();
    });
  });

  it("renders sectioned labels for agents, both panel destinations, and recipes", () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
    const { getAllByTestId } = renderButton();

    const labels = getAllByTestId("dock-launcher-band").map((el) => el.textContent);
    // Gemini is blocked in the fixture, so it lands under its own setup band
    // rather than being offered as a launch; "More" carries the footer cue.
    expect(labels).toEqual([
      "Launch agent",
      "Open in dock",
      "Open in grid",
      "Launch recipe",
      "Needs setup",
      "More",
    ]);
  });

  it("splits agents into Pinned/Other groups when pinnedCount is a strict subset", () => {
    // Two LAUNCHABLE agents: the split is counted against the launchable group,
    // so a blocked second agent would leave "Other" describing nothing.
    const { getAllByTestId, container } = renderButton({
      pinnedCount: 1,
      agents: [
        { id: "claude", name: "Claude", availability: "ready" },
        { id: "codex", name: "Codex", availability: "ready" },
      ],
    });

    const labels = getAllByTestId("dock-launcher-band").map((el) => el.textContent);
    expect(labels.slice(0, 2)).toEqual(["Pinned", "Other"]);

    // Assert document order so a regression that puts both agents under one
    // group (or swaps them) is caught: Pinned → Claude → Other → Codex.
    const text = container.textContent ?? "";
    expect(text.indexOf("Pinned")).toBeLessThan(text.indexOf("Claude"));
    expect(text.indexOf("Claude")).toBeLessThan(text.indexOf("Other"));
    expect(text.indexOf("Other")).toBeLessThan(text.indexOf("Codex"));
  });

  it("keeps a flat Launch agent group when all agents are pinned", () => {
    const { getAllByTestId } = renderButton({ pinnedCount: AGENTS.length });
    const labels = getAllByTestId("dock-launcher-band").map((el) => el.textContent);
    expect(labels[0]).toBe("Launch agent");
  });

  it("invokes onLaunchAgent for a launchable agent", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = renderButton({ onLaunchAgent });

    fireEvent.click(getByText("Claude"));
    expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined);
    expect(actionDispatchMock).not.toHaveBeenCalled();
    // The dock launch path must record MRU so the agent surfaces in the
    // recency band on the next open (previously this path recorded nothing).
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.claude");
  });

  it("launches non-launchable agent clicks instead of routing to settings", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = renderButton({ onLaunchAgent });

    fireEvent.click(getByText("Gemini"));
    // The launcher re-probes and answers with a session or the recovery gate;
    // deciding it here on a stale reading skipped the gate entirely (#11760).
    // `undefined` is the inherit-the-saved-preset sentinel, same as a
    // launchable row — an unavailable agent is not a different kind of launch.
    expect(onLaunchAgent).toHaveBeenCalledWith("gemini", undefined);
    expect(actionDispatchMock).not.toHaveBeenCalled();
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.gemini");
  });

  it("discriminates tooltip copy between blocked and installed-only agents", () => {
    const { getByText } = renderButton({
      agents: [
        { id: "claude", name: "Claude", availability: "ready" },
        { id: "gemini", name: "Gemini", availability: "blocked" },
        { id: "codex", name: "Codex", availability: "installed" },
      ],
    });

    // The name sits in its own span for truncation, so the warning lives on the
    // row itself.
    expect(getByText("Claude").closest(OPTION)?.getAttribute("title")).toBeNull();
    expect(getByText("Gemini").closest(OPTION)?.getAttribute("title")).toBe(
      "Gemini is blocked by endpoint security. Select to see recovery options"
    );
    expect(getByText("Codex").closest(OPTION)?.getAttribute("title")).toBe(
      "Codex needs setup. Select to see recovery options"
    );
  });

  it("treats unauthenticated agents as launchable (CLI handles auth at runtime)", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = renderButton({
      agents: [{ id: "codex", name: "Codex", availability: "unauthenticated" }],
      onLaunchAgent,
    });

    fireEvent.click(getByText("Codex"));
    expect(onLaunchAgent).toHaveBeenCalledWith("codex", undefined);
    // Soft dim and settings tooltip must not leak onto a launchable row.
    expect(getByText("Codex").getAttribute("title")).toBeNull();
  });

  it("keeps non-launchable rows selectable (no disabled attribute)", () => {
    const { getByText } = renderButton();
    // Regression guard: the pre-fix behavior was a disabled, dead-end row.
    expect(getByText("Gemini").hasAttribute("disabled")).toBe(false);
  });

  describe("complete panel offering (#11521)", () => {
    it("offers non-dockable kinds under the grid heading instead of hiding them", () => {
      // #11054 hid these because a dock-labelled item would be redirected to
      // the grid. The heading now states the destination, so they can appear.
      const { getByText, container } = renderButton();

      for (const name of ["Review", "File Browser", "Dev Preview"]) {
        expect(getByText(name)).toBeTruthy();
      }
      const text = container.textContent ?? "";
      expect(text.indexOf("Open in grid")).toBeLessThan(text.indexOf("Review"));
    });

    it("lists Terminal, Browser and File Viewer under the dock heading", () => {
      const { container } = renderButton();
      const text = container.textContent ?? "";
      const dockAt = text.indexOf("Open in dock");
      const gridAt = text.indexOf("Open in grid");

      for (const name of ["Terminal", "Browser", "File Viewer"]) {
        const at = text.indexOf(name);
        expect(at).toBeGreaterThan(dockAt);
        expect(at).toBeLessThan(gridAt);
      }
    });

    it("creates a grid-only kind through addPanel, not the agent launch path", () => {
      const onLaunchAgent = vi.fn();
      const { getByText } = renderButton({ onLaunchAgent, activeWorktreeId: "wt-1" });

      fireEvent.click(getByText("Review"));

      expect(onLaunchAgent).not.toHaveBeenCalled();
      expect(addPanelMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "review", location: "grid", worktreeId: "wt-1" })
      );
    });

    it("keeps Terminal on the agent launch path", () => {
      const onLaunchAgent = vi.fn();
      const { getByText } = renderButton({ onLaunchAgent });

      fireEvent.click(getByText("Terminal"));
      // Through the launch action its registry entry names, so a shell opened
      // here resolves its preset and command exactly as one opened elsewhere
      // does — never as a bare panel.
      expect(actionDispatchMock).toHaveBeenCalledWith(
        getPanelKindConfig("terminal")!.launchActionId,
        expect.objectContaining({ agentId: "terminal" }),
        { source: "menu" }
      );
      expect(addPanelMock).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("narrows the list to matches and drops the unfiltered band headings", () => {
      const { container, getAllByTestId, queryByText } = renderButton();

      fireEvent.change(searchInput(container), { target: { value: "review" } });

      const labels = getAllByTestId("dock-launcher-band").map((el) => el.textContent);
      expect(labels).toEqual(["Search results"]);
      expect(queryByText("Open in dock")).toBeNull();
      expect(queryByText("Claude")).toBeNull();
    });

    it("filters across agents, panels and recipes in one list", () => {
      mockRecipes = [{ id: "r-1", name: "Deploy site", worktreeId: undefined }];
      const { container, getByText, queryByText } = renderButton();
      const input = searchInput(container);

      // Each query must EXCLUDE the other categories — asserting only that the
      // match survives would pass on a filter that returns everything.
      fireEvent.change(input, { target: { value: "claude" } });
      expect(getByText("Claude")).toBeTruthy();
      expect(queryByText("Deploy site")).toBeNull();
      expect(queryByText("File Browser")).toBeNull();

      fireEvent.change(input, { target: { value: "deploy" } });
      expect(getByText("Deploy site")).toBeTruthy();
      expect(queryByText("Claude")).toBeNull();

      fireEvent.change(input, { target: { value: "browser" } });
      expect(getByText("Browser")).toBeTruthy();
      expect(queryByText("Deploy site")).toBeNull();
    });

    it("finds a panel by a registry search alias", () => {
      // "explorer" is a file-browser alias, not part of its display name.
      const { container, getByText, queryByText } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "explorer" } });
      expect(getByText("File Browser")).toBeTruthy();
      expect(queryByText("Claude")).toBeNull();
    });

    it("explains a blocked agent in the results with its setup tooltip", () => {
      // A filtered row that looks ordinary is worse than the unfiltered one,
      // which explains before you click that this lands on recovery rather than
      // a session. Asserted as the invariant "both rows say the same thing" so
      // it keeps holding when the copy changes. The dimming that accompanies it
      // is styling, so it isn't asserted here.
      const { container, getByText } = renderButton();
      const unfiltered = getByText("Gemini").closest(OPTION)?.getAttribute("title");

      fireEvent.change(searchInput(container), { target: { value: "gemini" } });
      const filtered = getByText("Gemini").closest(OPTION)?.getAttribute("title");

      expect(filtered).toBeTruthy();
      expect(filtered).toBe(unfiltered);
    });

    it("keeps the Overridden marker on a shadowed recipe in the results", () => {
      mockRecipes = [
        { id: "r-s", name: "Deploy", worktreeId: undefined, projectId: "p", shadowedBy: "Deploy" },
      ];
      const { container, getByText } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "deploy" } });

      // Activating resolves to the winning recipe, so the row must say so.
      expect(getByText(/Overridden by Team/)).toBeTruthy();
    });

    it("marks exactly one result row as selected", () => {
      const { container } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "e" } });

      expect(container.querySelectorAll(SELECTED_OPTION)).toHaveLength(1);
    });

    it("points aria-activedescendant at the selected option in both modes", () => {
      const { container } = renderButton();
      const input = searchInput(container);

      // Browsing and searching share one selection, so the input must name the
      // active option either way — not only once a query narrows the list.
      expect(input.getAttribute("aria-activedescendant")).toBe(selectedOption(container)?.id);

      fireEvent.change(input, { target: { value: "e" } });
      expect(input.getAttribute("aria-activedescendant")).toBe(selectedOption(container)?.id);
      expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    });

    it("stops advertising a listbox once nothing matches", () => {
      // The listbox is only rendered alongside results, so an unconditional
      // expanded/controls pair leaves the combobox naming an element that isn't
      // in the document — a dangling IDREF a screen reader can't resolve.
      const { container } = renderButton();
      const input = searchInput(container);

      expect(input.getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById(input.getAttribute("aria-controls")!)).not.toBeNull();

      fireEvent.change(input, { target: { value: "zzqqxxvv" } });

      expect(options(container)).toHaveLength(0);
      expect(input.getAttribute("aria-expanded")).toBe("false");
      expect(input.getAttribute("aria-controls")).toBeNull();
    });

    it("snaps the selection back to the top result on every query change", () => {
      // The hook reconciles selectedIndex in an effect, a frame behind. Left to
      // it, the render right after a query change still holds the old index —
      // highlighting nothing when it points past the narrowed list, or the
      // wrong row when it happens to stay in range. Neither was reachable
      // before browsing carried a selection of its own.
      const { container } = renderButton();
      const input = searchInput(container);

      // Walk to the end of the browse list, then narrow.
      fireEvent.keyDown(input, { key: "End" });
      expect(container.querySelectorAll(SELECTED_OPTION)).toHaveLength(1);

      fireEvent.change(input, { target: { value: "e" } });
      const rows = options(container);
      expect(rows.length).toBeGreaterThan(1);
      expect(selectedOption(container)).toBe(rows[0]);
      expect(input.getAttribute("aria-activedescendant")).toBe(rows[0]!.id);
    });

    it("Enter launches the top result after narrowing from deep in the browse list", () => {
      // Type-then-confirm in quick succession must fire on the row the user is
      // looking at, not on wherever the previous selection happened to sit.
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({ onLaunchAgent });
      const input = searchInput(container);

      fireEvent.keyDown(input, { key: "End" });
      fireEvent.change(input, { target: { value: "claude" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined);
    });

    it("Enter launches the top result", () => {
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({ onLaunchAgent });
      const input = searchInput(container);

      fireEvent.change(input, { target: { value: "claude" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined);
    });

    it("Enter activates the row moved to by ArrowDown, not the first one", () => {
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({ onLaunchAgent });
      const input = searchInput(container);

      fireEvent.change(input, { target: { value: "e" } });
      const firstName = selectedOption(container)?.textContent;

      fireEvent.keyDown(input, { key: "ArrowDown" });
      const moved = selectedOption(container);
      expect(moved?.textContent).not.toBe(firstName);

      // Actually confirm it — the previous version never pressed Enter, so it
      // proved nothing about what Enter would do.
      const movedName = moved?.textContent;
      fireEvent.keyDown(input, { key: "Enter" });
      // A row launches through whichever path its category uses: agents call
      // back, panels dispatch their launch action or create directly.
      const launched =
        onLaunchAgent.mock.calls.length > 0 ||
        addPanelMock.mock.calls.length > 0 ||
        actionDispatchMock.mock.calls.length > 0;
      expect(launched).toBe(true);
      expect(movedName).toBeTruthy();
    });

    it("Enter does nothing when the query matches no rows", () => {
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({ onLaunchAgent });
      const input = searchInput(container);

      fireEvent.change(input, { target: { value: "zzzzqqqq" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onLaunchAgent).not.toHaveBeenCalled();
      expect(addPanelMock).not.toHaveBeenCalled();
      expect(actionDispatchMock).not.toHaveBeenCalled();
    });

    it("drives the unfiltered bands with the same selection as the results", () => {
      // A Popover has no roving focus to fall through to, so the browse list is
      // navigated by selectedIndex exactly as the filtered list is. Arrows that
      // escaped to the container here would move nothing at all.
      const { container } = renderButton();
      const input = searchInput(container);

      const rows = options(container);
      expect(rows.length).toBeGreaterThan(1);
      expect(selectedOption(container)).toBe(rows[0]);

      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(selectedOption(container)).toBe(rows[1]);
      expect(container.querySelectorAll(SELECTED_OPTION)).toHaveLength(1);

      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(selectedOption(container)).toBe(rows[0]);

      fireEvent.keyDown(input, { key: "End" });
      expect(selectedOption(container)).toBe(rows[rows.length - 1]);

      fireEvent.keyDown(input, { key: "Home" });
      expect(selectedOption(container)).toBe(rows[0]);
    });

    it("Enter launches the selected row while unfiltered", () => {
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({ onLaunchAgent });
      const input = searchInput(container);

      // Claude is the first agent and the first browse row.
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined);
    });

    it("keeps the recency band navigable without highlighting its twin", () => {
      // The band repeats agents listed again below, so the two rows must be
      // keyed apart — sharing an id would light both up at once.
      mockMruEntries = [{ id: "agent.claude", score: 1, lastAccessedAt: 1000 }];
      const { container } = renderButton();

      const rows = options(container);
      const claudeRows = rows.filter((row) => row.textContent?.includes("Claude"));
      expect(claudeRows).toHaveLength(2);
      expect(claudeRows[0]!.id).not.toBe(claudeRows[1]!.id);
      expect(container.querySelectorAll(SELECTED_OPTION)).toHaveLength(1);
    });

    it("does not swallow modified keys, so app shortcuts still work", () => {
      const { container } = renderButton();
      const input = searchInput(container);

      const menuSaw = vi.fn();
      container.addEventListener("keydown", menuSaw);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true }));
      container.removeEventListener("keydown", menuSaw);

      expect(menuSaw).toHaveBeenCalledTimes(1);
    });

    it("ignores a keystroke that is still an IME composition", () => {
      const { container } = renderButton();
      const input = searchInput(container);
      fireEvent.change(input, { target: { value: "re" } });

      // Chromium reports keyCode 229 before isComposing flips true; treating it
      // as a real Enter would launch mid-composition.
      const menuSaw = vi.fn();
      container.addEventListener("keydown", menuSaw);
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })
      );
      container.removeEventListener("keydown", menuSaw);

      expect(menuSaw).toHaveBeenCalledTimes(1);
    });

    it("clears the query when a launch closes the menu via Enter", () => {
      // The Enter path closes directly rather than through Radix's
      // onOpenChange, so it must reset the query itself or the next open is
      // still filtered.
      const { container } = renderButton();
      const input = searchInput(container);

      fireEvent.change(input, { target: { value: "claude" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(searchInput(container).value).toBe("");
    });

    it("treats a whitespace-only query as unfiltered for Escape", () => {
      const { container } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "   " } });

      // The menu already looks unfiltered, so Escape must close rather than
      // being spent clearing invisible whitespace.
      const event = { preventDefault: vi.fn() };
      popoverEscapeKeyDownSpy!(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("ArrowDown does not reach the menu, so Radix cannot move focus off the input", () => {
      const { container } = renderButton();
      const input = searchInput(container);
      fireEvent.change(input, { target: { value: "e" } });

      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      const menuSaw = vi.fn();
      container.addEventListener("keydown", menuSaw);
      input.dispatchEvent(event);
      container.removeEventListener("keydown", menuSaw);

      expect(menuSaw).not.toHaveBeenCalled();
    });

    it("stops plain typing escaping to the app behind the launcher", () => {
      // A letter that reached the dock's own key handling would act on the
      // panel underneath while the user is only filling the search box.
      const { container } = renderButton();
      const input = searchInput(container);

      const outsideSaw = vi.fn();
      container.addEventListener("keydown", outsideSaw);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
      container.removeEventListener("keydown", outsideSaw);

      expect(outsideSaw).not.toHaveBeenCalled();
    });

    it("shows a recovery cue and no options when nothing matches", () => {
      const { container, getByTestId } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "zzzzqqqq" } });

      expect(getByTestId("dock-launcher-empty")).toBeTruthy();
      expect(options(container)).toHaveLength(0);
    });

    it("first Escape clears the query and blocks the close; second closes", () => {
      const { container } = renderButton();
      const input = searchInput(container);
      fireEvent.change(input, { target: { value: "review" } });

      // Radix dismisses from a document-capture listener that beats any handler
      // on the input, so the content handler both vetoes the close and clears.
      const withQuery = { preventDefault: vi.fn() };
      act(() => popoverEscapeKeyDownSpy!(withQuery));
      expect(withQuery.preventDefault).toHaveBeenCalledTimes(1);
      expect(input.value).toBe("");

      // Now empty, Escape is left alone so the launcher actually closes.
      const whenEmpty = { preventDefault: vi.fn() };
      act(() => popoverEscapeKeyDownSpy!(whenEmpty));
      expect(whenEmpty.preventDefault).not.toHaveBeenCalled();
    });

    it("opens modal so Tab cannot leave the launcher", () => {
      renderButton();
      expect(popoverModal).toBe(true);
    });

    it("takes over the mount autofocus and drives it into the input", () => {
      // Radix would otherwise focus the content wrapper. This is the handler
      // that covers a cold open, where the lazy Radix chunk resolves after the
      // open-state frame has already come and gone.
      const { container } = renderButton();
      expect(popoverOpenAutoFocusSpy).toBeTruthy();

      const event = { preventDefault: vi.fn() };
      act(() => popoverOpenAutoFocusSpy!(event));

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(searchInput(container));
    });

    it("re-focuses the input a frame after opening", async () => {
      // Second attempt behind the mount handler, for the warm open where the
      // content is already mounted when `open` flips.
      const { container } = renderButton();
      searchInput(container).blur();
      expect(document.activeElement).not.toBe(searchInput(container));

      act(() => popoverOpenChangeSpy!(true));

      // The focus is deferred a frame, so poll rather than racing it — a frame
      // awaited here would be scheduled before the effect's own.
      await waitFor(() => expect(document.activeElement).toBe(searchInput(container)));
    });

    it("hands focus back to the input when the focus trap parks it on the content", () => {
      // The modal FocusScope hauls focus onto the tabIndex={-1} content wrapper
      // whenever anything outside steals it. Left there, the wrapper owns no
      // keys and the next keystroke disappears.
      const { container, getByTestId } = renderButton();
      const content = getByTestId("dock-launcher-content");

      searchInput(container).blur();
      fireEvent.focus(content);

      expect(document.activeElement).toBe(searchInput(container));
    });

    it("still navigates when a key arrives with focus on the content", () => {
      // Covers the frame before the refocus above lands: the catch-all handler
      // on the content means Enter can never silently do nothing.
      const onLaunchAgent = vi.fn();
      const { container, getByTestId } = renderButton({ onLaunchAgent });
      const content = getByTestId("dock-launcher-content");

      const rows = options(container);
      fireEvent.keyDown(content, { key: "ArrowDown" });
      expect(selectedOption(container)).toBe(rows[1]);

      // Back to Claude, the one launchable agent in this fixture.
      fireEvent.keyDown(content, { key: "Home" });
      fireEvent.keyDown(content, { key: "Enter" });
      expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined);
    });

    it("does not double-handle a key the input already consumed", () => {
      // The input's capture handler stops propagation, so the content catch-all
      // must not move the selection a second time.
      const { container } = renderButton();
      const rows = options(container);

      fireEvent.keyDown(searchInput(container), { key: "ArrowDown" });
      expect(selectedOption(container)).toBe(rows[1]);
    });

    it("keeps focus in the input when the header around it is clicked", () => {
      // The padding around the input parks focus on Radix's tabIndex={-1} focus
      // scope, after which Escape dead-ends (the content vetoes the close while
      // only the input clears the query).
      const { container, getByTestId } = renderButton();
      const input = searchInput(container);

      expect(fireEvent.mouseDown(getByTestId("dock-launcher-header"))).toBe(false);
      expect(document.activeElement).toBe(input);
    });

    it("leaves the input's own mousedown alone so the caret can be placed", () => {
      // The row handler sees the input's mousedown on the way up; cancelling it
      // there would kill caret placement and drag-select inside the field.
      const { container } = renderButton();
      expect(fireEvent.mouseDown(searchInput(container))).toBe(true);
    });

    it("clears the query when the menu closes so the next open starts unfiltered", () => {
      const { container } = renderButton();
      const input = searchInput(container);
      fireEvent.change(input, { target: { value: "review" } });
      expect(input.value).toBe("review");

      act(() => popoverOpenChangeSpy!(false));
      expect(input.value).toBe("");
    });

    it("mirrors pointer hover into selection and keeps focus off the row", () => {
      const { container } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "e" } });

      const rows = options(container);
      expect(rows.length).toBeGreaterThan(1);

      const second = rows[1]!;
      fireEvent.pointerEnter(second);
      expect(second.getAttribute("aria-selected")).toBe("true");
      expect(container.querySelectorAll(SELECTED_OPTION)).toHaveLength(1);

      // preventDefault on pointerdown is what stops the click focusing the row
      // and pulling DOM focus off the search box.
      expect(fireEvent.pointerDown(second)).toBe(false);
    });

    it("hovering an unfiltered band row also moves the selection", () => {
      // The state the user is in the instant the launcher opens — the browse
      // rows were the ones left unguarded against pointer focus-steal.
      const { container } = renderButton();

      const rows = options(container);
      expect(rows.length).toBeGreaterThan(1);

      fireEvent.pointerEnter(rows[1]!);
      expect(selectedOption(container)).toBe(rows[1]);
      expect(fireEvent.pointerDown(rows[1]!)).toBe(false);
    });

    describe("pointer transit is not a choice of row (#11919)", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      /** The gate only watches an open launcher, and this mock renders rows regardless. */
      function openLauncher(): void {
        act(() => popoverOpenChangeSpy!(true));
      }

      it("leaves the selection alone while a sweep crosses rows to reach a lower one", () => {
        const { container } = renderButton();
        openLauncher();
        const input = searchInput(container);
        fireEvent.keyDown(input, { key: "ArrowDown" });
        const chosen = selectedOption(container);
        expect(chosen).not.toBeNull();

        startSweep(container);

        // Every row the sweep passes announces itself; none of them was picked.
        const rows = options(container);
        expect(rows.length).toBeGreaterThan(2);
        rows.slice(1).forEach((row, offset) => {
          fireRowEnter(row, { x: 0, y: 32 + offset * 32, t: 12 + offset });
          expect(selectedOption(container)).toBe(chosen);
        });
      });

      it("selects immediately on an ordinary mouse hover", () => {
        // The two bare-pointerEnter tests above carry no pointerType, so they
        // only prove the non-mouse bypass. This is the path a real mouse takes.
        const { container } = renderButton();
        openLauncher();
        const rows = options(container);
        const target = rows[1]!;

        fireRowEnter(target, { x: 0, y: 32, t: 0 });
        expect(selectedOption(container)).toBe(target);
      });

      it("settles onto the row the sweep stopped on", () => {
        const { container } = renderButton();
        openLauncher();
        const rows = options(container);
        expect(rows.length).toBeGreaterThan(2);
        const target = rows[2]!;

        startSweep(container);
        fireRowEnter(target, { x: 0, y: 30, t: 12 });
        expect(selectedOption(container)).not.toBe(target);

        // The pointer comes to rest: same position, far enough past the
        // minimum-suppression floor for the gesture to read as finished.
        firePointer(listbox(container), "pointermove", { x: 0, y: 30, t: 200 });
        expect(selectedOption(container)).toBe(target);
      });

      it("keeps the keyboard's row when the list scrolls under a resting cursor", () => {
        const { container } = renderButton();
        openLauncher();
        const input = searchInput(container);
        const list = listbox(container);

        fireEvent.keyDown(input, { key: "ArrowDown" });
        fireEvent.keyDown(input, { key: "ArrowDown" });
        const chosen = selectedOption(container);
        expect(chosen).not.toBeNull();

        vi.useFakeTimers();
        // What scrollIntoView does to a stationary pointer: the list moves, and
        // a row it never chose slides underneath.
        fireEvent.scroll(list);
        const slidUnder = options(container).find((row) => row !== chosen)!;
        fireRowEnter(slidUnder, { x: 0, y: 0, t: 200 });
        expect(selectedOption(container)).toBe(chosen);

        // And it must still be the keyboard's row once the list stops moving —
        // a scroll settling says nothing about where the user is pointing.
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(selectedOption(container)).toBe(chosen);
      });

      it("drops the row it was tracking rather than settling on whatever replaced it", () => {
        const { container } = renderButton();
        openLauncher();
        const rows = options(container);
        expect(rows.length).toBeGreaterThan(2);
        const trackedLabel = rows[2]!.textContent;

        startSweep(container);
        fireRowEnter(rows[2]!, { x: 0, y: 30, t: 12 });
        // Without this the test passes whether or not hover is gated at all.
        expect(selectedOption(container)).not.toBe(rows[2]!);

        fireEvent.change(searchInput(container), { target: { value: "claude" } });
        const filtered = options(container);
        expect(filtered.length).toBeGreaterThan(0);
        expect(filtered.map((row) => row.textContent)).not.toContain(trackedLabel);
        const before = selectedOption(container);

        firePointer(listbox(container), "pointermove", { x: 0, y: 30, t: 200 });
        expect(selectedOption(container)).toBe(before);
      });

      it("does not settle a sweep that left the list", () => {
        const { container } = renderButton();
        openLauncher();
        const input = searchInput(container);
        fireEvent.keyDown(input, { key: "ArrowDown" });
        const chosen = selectedOption(container);
        const target = options(container).find((row) => row !== chosen)!;

        vi.useFakeTimers();
        startSweep(container);
        fireRowEnter(target, { x: 0, y: 30, t: 12 });
        firePointer(listbox(container), "pointerleave", { x: 0, y: 400, t: 20 });

        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(selectedOption(container)).toBe(chosen);
      });

      it("lets a keystroke override a sweep that has not settled yet", () => {
        const { container } = renderButton();
        openLauncher();
        const input = searchInput(container);
        const rows = options(container);
        const swept = rows[2]!;

        vi.useFakeTimers();
        startSweep(container);
        fireRowEnter(swept, { x: 0, y: 30, t: 12 });

        // The keyboard makes a choice mid-gesture. The sweep's row is now an
        // older opinion and must not come back when the gesture settles.
        fireEvent.keyDown(input, { key: "ArrowDown" });
        const chosen = selectedOption(container);
        expect(chosen).not.toBe(swept);

        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(selectedOption(container)).toBe(chosen);
      });

      it("re-arms after the list empties and comes back", () => {
        const { container } = renderButton();
        openLauncher();
        const input = searchInput(container);

        // Zero results tears the listbox out entirely, taking the gate with it.
        fireEvent.change(input, { target: { value: "zzzznotarealrow" } });
        expect(container.querySelector('[role="listbox"]')).toBeNull();
        fireEvent.change(input, { target: { value: "" } });

        fireEvent.keyDown(input, { key: "ArrowDown" });
        const chosen = selectedOption(container);
        expect(chosen).not.toBeNull();

        startSweep(container);
        const target = options(container).find((row) => row !== chosen)!;
        fireRowEnter(target, { x: 0, y: 32, t: 12 });
        expect(selectedOption(container)).toBe(chosen);
      });
    });
  });

  it("shows a Create a recipe cue when no recipes match the active worktree", () => {
    mockRecipes = [];
    const { getByText } = renderButton({ activeWorktreeId: "wt-1" });
    expect(getByText("Launch recipe")).toBeTruthy();
    expect(getByText("Create a recipe")).toBeTruthy();
  });

  it("dispatches recipe.editor.open from the Create a recipe cue", () => {
    mockRecipes = [];
    const { getByText } = renderButton({ activeWorktreeId: "wt-1" });

    fireEvent.click(getByText("Create a recipe"));
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "recipe.editor.open",
      { worktreeId: "wt-1" },
      { source: "menu" }
    );
  });

  it("falls back to the recipe manager from the cue when no worktree is active", () => {
    // recipe.editor.open's handler hard-requires a string worktreeId and
    // silently no-ops on undefined — the common first-run case has no active
    // worktree, so the cue must route to the manager instead of dead-ending.
    mockRecipes = [];
    const { getByText } = renderButton();

    fireEvent.click(getByText("Create a recipe"));
    expect(actionDispatchMock).toHaveBeenCalledWith("recipe.manager.open", {}, { source: "menu" });
    expect(actionDispatchMock).not.toHaveBeenCalledWith(
      "recipe.editor.open",
      expect.anything(),
      expect.anything()
    );
  });

  it("footers the More band with both action cues under one heading", () => {
    const { container, getAllByTestId } = renderButton();

    // Walk the listbox in DOM order and file each option under the heading
    // above it. Counting headings alone would not do: a row that drifted into
    // another band leaves exactly one "More" behind and still renders its label
    // somewhere on screen, which is all a `getByText` pair can see.
    const under = new Map<string, string[]>();
    let heading = "";
    for (const node of listbox(container).querySelectorAll<HTMLElement>(
      '[data-testid="dock-launcher-band"], [role="option"]'
    )) {
      if (node.getAttribute("data-testid") === "dock-launcher-band") {
        heading = node.textContent ?? "";
        continue;
      }
      under.set(heading, [...(under.get(heading) ?? []), node.textContent ?? ""]);
    }

    expect(
      getAllByTestId("dock-launcher-band").filter((el) => el.textContent === "More")
    ).toHaveLength(1);
    const more = under.get("More") ?? [];
    expect(more).toHaveLength(2);
    expect(more[0]).toContain("Manage agents");
    expect(more[1]).toContain(TOOLBAR_CUSTOMIZE_LABEL);
  });

  it("draws the Customize toolbar cue with a glyph of its own", () => {
    // Compared against a live render of the icon rather than Lucide's class
    // string, which is the package's business and not a contract. Without this
    // the row could regress to the `Workflow` the old cue ternary fell through
    // to, or to the `Settings2` the row directly above it already carries, and
    // every other assertion here would stay green.
    const { container } = renderButton();
    const glyphOf = (label: string) => {
      const row = options(container).find((option) => option.textContent?.includes(label));
      if (!row) throw new Error(`no option row for ${label}`);
      return row.querySelector("svg")!.innerHTML;
    };
    const slidersGlyph = render(<SlidersHorizontal />).container.querySelector("svg")!.innerHTML;

    expect(glyphOf(TOOLBAR_CUSTOMIZE_LABEL)).toBe(slidersGlyph);
    expect(glyphOf(TOOLBAR_CUSTOMIZE_LABEL)).not.toBe(glyphOf("Manage agents"));
  });

  it("leaves the action cues out of search results", () => {
    // Fuse is built from `searchItems` — agents, panels and recipes — and the
    // placeholder promises exactly those. A cue that leaked into the ranked list
    // would be an action offered where the user is picking something to launch.
    const { container, queryByText } = renderButton();

    fireEvent.change(searchInput(container), { target: { value: "customize" } });

    expect(queryByText(TOOLBAR_CUSTOMIZE_LABEL)).toBeNull();
    expect(queryByText("Manage agents")).toBeNull();
  });

  it("opens the toolbar settings tab from the Customize toolbar cue", () => {
    const { getByText } = renderButton();

    fireEvent.click(getByText(TOOLBAR_CUSTOMIZE_LABEL));
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "toolbar" },
      { source: "menu" }
    );
  });

  it("lands on the Customize toolbar cue at the end of the browse list", () => {
    // The footer is the last thing End can reach, so this is also the assertion
    // that the row took an index in the flat navigation space at all.
    const { container } = renderButton();
    const input = searchInput(container);

    fireEvent.keyDown(input, { key: "End" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(actionDispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "toolbar" },
      { source: "menu" }
    );
  });

  it("does not render the Create a recipe cue when recipes exist", () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
    const { queryByText, getByText } = renderButton({ activeWorktreeId: "wt-1" });
    expect(getByText("My recipe")).toBeTruthy();
    expect(queryByText("Create a recipe")).toBeNull();
  });

  it("lists project-wide recipes and recipes scoped to the active worktree", () => {
    mockRecipes = [
      { id: "r-global", name: "Project recipe", worktreeId: undefined },
      { id: "r-wt", name: "Worktree recipe", worktreeId: "wt-1" },
      { id: "r-other", name: "Other worktree recipe", worktreeId: "wt-2" },
    ];

    const { getByText, queryByText } = renderButton({ activeWorktreeId: "wt-1" });

    expect(getByText("Project recipe")).toBeTruthy();
    expect(getByText("Worktree recipe")).toBeTruthy();
    expect(queryByText("Other worktree recipe")).toBeNull();
  });

  it("distinguishes same-named recipes by scope (#11510)", () => {
    mockRecipes = [
      { id: "r-global", name: "Work", worktreeId: undefined, projectId: undefined },
      { id: "r-local", name: "Work", worktreeId: undefined, projectId: "proj-1" },
    ];

    const { getByText } = renderButton({ activeWorktreeId: "wt-1" });

    expect(getByText("Global")).toBeTruthy();
    expect(getByText("Project-wide")).toBeTruthy();
  });

  it("keeps a shadowed recipe listed, marked, and launchable (#11510)", async () => {
    mockRecipes = [
      {
        id: "r-shadowed",
        name: "Work",
        worktreeId: undefined,
        projectId: "proj-1",
        shadowedBy: "Work",
      },
    ];
    runRecipeWithResultsMock.mockResolvedValue({});

    const { getByText } = renderButton({ activeWorktreeId: "wt-1" });

    expect(getByText(/Overridden by Team/)).toBeTruthy();

    fireEvent.click(getByText("Work"));

    // The raw id goes through; the store resolves it to the winning recipe.
    await waitFor(() => {
      expect(runRecipeWithResultsMock).toHaveBeenCalledWith(
        "r-shadowed",
        "/tmp",
        "wt-1",
        undefined
      );
    });
  });

  it("calls preventDefault on pointer close so the trigger does not keep its focus ring (issue #6119)", () => {
    renderButton();
    expect(popoverCloseAutoFocusSpy).toBeTruthy();
    expect(popoverPointerDownOutsideSpy).toBeTruthy();

    // Keyboard close with nothing launched (no prior pointer-down-outside) must
    // NOT preventDefault — WAI-ARIA requires the return on a bare dismissal.
    // Enter that activates a launch row is the deliberate exception, covered by
    // the #11664 block below.
    const keyboardPreventDefault = vi.fn();
    popoverCloseAutoFocusSpy!({ preventDefault: keyboardPreventDefault });
    expect(keyboardPreventDefault).not.toHaveBeenCalled();

    // Pointer close suppresses the focus ring.
    popoverPointerDownOutsideSpy!();
    const pointerPreventDefault = vi.fn();
    popoverCloseAutoFocusSpy!({ preventDefault: pointerPreventDefault });
    expect(pointerPreventDefault).toHaveBeenCalledTimes(1);

    // The pointer flag must reset after one onCloseAutoFocus or a later
    // keyboard-driven close would inherit suppression and break focus return.
    const resetPreventDefault = vi.fn();
    popoverCloseAutoFocusSpy!({ preventDefault: resetPreventDefault });
    expect(resetPreventDefault).not.toHaveBeenCalled();
  });

  describe("focus return after activation (#11664)", () => {
    /** Radix's restore runs after the close; this is what would cancel it. */
    function fireCloseAutoFocus() {
      const preventDefault = vi.fn();
      act(() => popoverCloseAutoFocusSpy!({ preventDefault }));
      return preventDefault;
    }

    it("cancels the return when a clicked row launches an agent", () => {
      const { getByText } = renderButton();

      fireEvent.click(getByText("Claude"));

      // Without this the trigger takes focus back once the content's exit
      // animation ends — after the new panel already had it.
      expect(fireCloseAutoFocus()).toHaveBeenCalledTimes(1);
    });

    it("cancels the return when a clicked row creates a panel", () => {
      const { getByText } = renderButton({ activeWorktreeId: "wt-1" });

      fireEvent.click(getByText("Review"));

      expect(fireCloseAutoFocus()).toHaveBeenCalledTimes(1);
    });

    it("cancels the return when Enter launches the top result", () => {
      const { container } = renderButton();
      const input = searchInput(container);

      fireEvent.change(input, { target: { value: "claude" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(fireCloseAutoFocus()).toHaveBeenCalledTimes(1);
    });

    it("cancels the return when a clicked row launches a terminal", () => {
      // Terminal dispatches its launch action rather than creating a bare
      // panel — the exact path the issue was reported against.
      const onLaunchAgent = vi.fn();
      const { getByText } = renderButton({ onLaunchAgent });

      fireEvent.click(getByText("Terminal"));

      expect(actionDispatchMock).toHaveBeenCalledWith(
        getPanelKindConfig("terminal")!.launchActionId,
        expect.objectContaining({ agentId: "terminal" }),
        { source: "menu" }
      );
      expect(fireCloseAutoFocus()).toHaveBeenCalledTimes(1);
    });

    it("cancels the return when a clicked row runs a recipe", async () => {
      mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
      const { getByText } = renderButton();

      fireEvent.click(getByText("My recipe"));

      // Decided on intent: the spawn is still in flight when the close lands.
      expect(fireCloseAutoFocus()).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(notifySpawnFailuresMock).toHaveBeenCalled());
    });

    it("decides afresh on every close instead of staying suppressed", () => {
      const { getByText } = renderButton();

      fireEvent.click(getByText("Claude"));
      expect(fireCloseAutoFocus()).toHaveBeenCalledTimes(1);

      // Dismissed without launching: the WAI-ARIA return has to come back, or
      // the launcher strands the keyboard on every later Escape.
      act(() => popoverOpenChangeSpy!(false));
      expect(fireCloseAutoFocus()).not.toHaveBeenCalled();

      fireEvent.click(getByText("Claude"));
      expect(fireCloseAutoFocus()).toHaveBeenCalledTimes(1);
    });

    it("does not carry a launch's suppression into a later dismissal", () => {
      // Reopening inside the content's exit animation makes Radix cancel the
      // unmount, so that launch's close never reaches close-autofocus and its
      // answer is never spent. The next dismissal must still get its return.
      const { getByText } = renderButton();

      fireEvent.click(getByText("Claude"));
      act(() => popoverOpenChangeSpy!(true));
      act(() => popoverOpenChangeSpy!(false));

      expect(fireCloseAutoFocus()).not.toHaveBeenCalled();
    });

    // An unavailable agent opens the recovery panel, which claims focus exactly
    // like a terminal — so the trigger must not pull focus back from it either
    // (#11760). Cue rows keep the return; they navigate rather than launch.
    it("cancels the return for an unavailable agent row now that it launches", () => {
      const onLaunchAgent = vi.fn();
      const { getByText } = renderButton({ onLaunchAgent });

      fireEvent.click(getByText("Gemini"));

      expect(onLaunchAgent).toHaveBeenCalledWith("gemini", undefined);
      expect(fireCloseAutoFocus()).toHaveBeenCalledTimes(1);
    });

    it("keeps the return for the Create a recipe cue", () => {
      mockRecipes = [];
      const { getByText } = renderButton({ activeWorktreeId: "wt-1" });

      fireEvent.click(getByText("Create a recipe"));

      expect(fireCloseAutoFocus()).not.toHaveBeenCalled();
    });

    it("keeps the return when an opened launcher is dismissed without activating a row", () => {
      renderButton();

      act(() => popoverOpenChangeSpy!(true));
      act(() => popoverOpenChangeSpy!(false));

      expect(fireCloseAutoFocus()).not.toHaveBeenCalled();
    });
  });

  it("invokes runRecipeWithResults with cwd, worktreeId, and recipe context when a recipe is selected", async () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];

    const recipeContext = {
      issueNumber: 42,
      prNumber: 100,
      branchName: "feature/abc",
      worktreePath: "/path/to/wt",
    };

    const { getByText } = renderButton({
      activeWorktreeId: "wt-1",
      cwd: "/path/to/wt",
      recipeContext,
    });

    fireEvent.click(getByText("My recipe"));
    expect(runRecipeWithResultsMock).toHaveBeenCalledWith(
      "r-1",
      "/path/to/wt",
      "wt-1",
      recipeContext
    );
    // Spawn results route through the failure notifier (which no-ops on success).
    await waitFor(() =>
      expect(notifySpawnFailuresMock).toHaveBeenCalledWith(
        { spawned: [{ index: 0, terminalId: "t-0" }], failed: [] },
        { recipeName: "My recipe" }
      )
    );
  });

  it("surfaces spawn failures from dock-launched recipes via the notifier", async () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
    const results = {
      spawned: [],
      failed: [{ index: 0, error: "Panel limit reached" }],
    };
    runRecipeWithResultsMock.mockResolvedValue(results);

    const { getByText } = renderButton();

    fireEvent.click(getByText("My recipe"));
    await waitFor(() =>
      expect(notifySpawnFailuresMock).toHaveBeenCalledWith(results, { recipeName: "My recipe" })
    );
  });

  it("logs dock recipe launch rejections without notifying", async () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
    runRecipeWithResultsMock.mockRejectedValue(new Error("recipe gone"));

    const { getByText } = renderButton();

    fireEvent.click(getByText("My recipe"));
    await waitFor(() =>
      expect(logErrorMock).toHaveBeenCalledWith("Recipe launch from dock failed", expect.any(Error))
    );
    expect(notifySpawnFailuresMock).not.toHaveBeenCalled();
  });

  describe("Recently launched band", () => {
    const MANY: DockLaunchAgent[] = [
      { id: "claude", name: "Claude", availability: "ready" },
      { id: "gemini", name: "Gemini", availability: "ready" },
      { id: "codex", name: "Codex", availability: "ready" },
      { id: "cursor", name: "Cursor", availability: "ready" },
    ];

    it("hides the band when the MRU is empty", () => {
      mockMruEntries = [];
      const { queryByText } = renderButton({ agents: MANY });
      expect(queryByText("Recently launched")).toBeNull();
    });

    it("renders recent agents in frecency order, capped at 3", () => {
      // Pre-sorted as getSortedActionMruList would return them; the component
      // does not re-sort. Four entries, cap is 3 — Gemini (4th) is dropped.
      mockMruEntries = [
        { id: "agent.claude", score: 4, lastAccessedAt: 4000 },
        { id: "agent.codex", score: 3, lastAccessedAt: 3000 },
        { id: "agent.cursor", score: 2, lastAccessedAt: 2000 },
        { id: "agent.gemini", score: 1, lastAccessedAt: 1000 },
      ];

      const { getByText, getAllByText, getAllByTestId, container } = renderButton({
        agents: MANY,
      });

      const labels = getAllByTestId("dock-launcher-band").map((el) => el.textContent);
      expect(labels[0]).toBe("Recently launched");
      expect(getByText("Recently launched")).toBeTruthy();

      // Band entries are duplicated below in the flat agent group — the band is
      // a shortcut, not a replacement grouping. Capped entries appear twice;
      // the dropped 4th appears only once (in the group).
      expect(getAllByText("Claude").length).toBe(2);
      expect(getAllByText("Codex").length).toBe(2);
      expect(getAllByText("Cursor").length).toBe(2);
      expect(getAllByText("Gemini").length).toBe(1);

      const text = container.textContent ?? "";
      expect(text.indexOf("Claude")).toBeLessThan(text.indexOf("Codex"));
      expect(text.indexOf("Codex")).toBeLessThan(text.indexOf("Cursor"));
    });

    it("excludes never-launched cold-start entries (lastAccessedAt === 0)", () => {
      mockMruEntries = [{ id: "agent.claude", score: 5, lastAccessedAt: 0 }];
      const { queryByText } = renderButton({ agents: MANY });
      expect(queryByText("Recently launched")).toBeNull();
    });

    it("ignores non-agent MRU entries", () => {
      mockMruEntries = [{ id: "recipe.editor.open", score: 5, lastAccessedAt: 5000 }];
      const { queryByText } = renderButton({ agents: MANY });
      expect(queryByText("Recently launched")).toBeNull();
    });

    it("drops stale MRU entries for agents no longer present", () => {
      mockMruEntries = [{ id: "agent.ghost", score: 5, lastAccessedAt: 5000 }];
      const { queryByText } = renderButton({ agents: MANY });
      expect(queryByText("Recently launched")).toBeNull();
    });

    it("launching a band row records MRU and invokes onLaunchAgent", () => {
      mockMruEntries = [{ id: "agent.codex", score: 3, lastAccessedAt: 3000 }];
      const onLaunchAgent = vi.fn();
      const { getAllByText } = renderButton({ agents: MANY, onLaunchAgent });

      // First "Codex" is the band row.
      const codexElement = getAllByText("Codex")[0];
      expect(codexElement).toBeDefined();
      fireEvent.click(codexElement!);
      expect(onLaunchAgent).toHaveBeenCalledWith("codex", undefined);
      expect(recordActionMruMock).toHaveBeenCalledWith("agent.codex");
    });

    it("picks up an agent launched since the menu was last opened", () => {
      // Regression pin: `getSortedActionMruList` is a stable function reference
      // reading store state at call time, so subscribing to it never triggers a
      // re-render. Memoizing the band on it froze the pre-launch order — launch
      // an agent, reopen, and it was still missing.
      mockMruEntries = [];
      const { queryByText, getByText } = renderButton({ agents: MANY });
      expect(queryByText("Recently launched")).toBeNull();

      // A launch elsewhere records MRU while this component stays mounted.
      mockMruEntries = [{ id: "agent.codex", score: 1, lastAccessedAt: 7000 }];

      act(() => popoverOpenChangeSpy!(false));
      act(() => popoverOpenChangeSpy!(true));

      expect(getByText("Recently launched")).toBeTruthy();
    });

    it("anchors the reopened selection to a row the recency band inserted while closed", () => {
      // Same no-re-render MRU update as above, but aimed at the selection: the
      // open handler's closure still describes the pre-launch rows, so
      // re-anchoring from there would land on the row the opening render is
      // about to displace and the hook would then follow it down to index 1.
      mockMruEntries = [];
      const { container } = renderButton({ agents: MANY });
      expect(options(container)[0]?.textContent).not.toContain("Codex");

      mockMruEntries = [{ id: "agent.codex", score: 1, lastAccessedAt: 7000 }];

      act(() => popoverOpenChangeSpy!(false));
      act(() => popoverOpenChangeSpy!(true));

      const rows = options(container);
      expect(rows[0]?.textContent).toContain("Codex");
      expect(selectedOption(container)).toBe(rows[0]);
    });

    it("survives an unfiltered reopen after a search is cleared", () => {
      mockMruEntries = [{ id: "agent.codex", score: 3, lastAccessedAt: 3000 }];
      const { container, queryByText, getByText } = renderButton({ agents: MANY });
      const input = searchInput(container);

      fireEvent.change(input, { target: { value: "codex" } });
      expect(queryByText("Recently launched")).toBeNull();

      fireEvent.change(input, { target: { value: "" } });
      expect(getByText("Recently launched")).toBeTruthy();
    });

    it("re-anchors the selection to the top row on reopen", () => {
      // Closing only clears the query, so the hook's follow-anchor still points
      // at wherever browsing ended. A reopened popover mounts its scroller at
      // the top and the active row keeps its id, so the scroll effect never
      // re-runs — leaving the highlight offscreen while Enter still launches
      // the row the user walked to in the previous session.
      const { container } = renderButton({ agents: MANY });
      const input = searchInput(container);

      fireEvent.keyDown(input, { key: "End" });
      const before = options(container);
      expect(selectedOption(container)).toBe(before[before.length - 1]);

      act(() => popoverOpenChangeSpy!(false));
      act(() => popoverOpenChangeSpy!(true));

      expect(selectedOption(container)).toBe(options(container)[0]);
      expect(container.querySelectorAll(SELECTED_OPTION)).toHaveLength(1);
    });
  });

  describe("toolbar pin affordance", () => {
    /** The option whose label text matches, whatever band it landed in. */
    function rowFor(container: HTMLElement, name: string): HTMLElement {
      const row = options(container).find((option) =>
        Array.from(option.querySelectorAll("span")).some((s) => s.textContent === name)
      );
      if (!row) throw new Error(`no option row for ${name}`);
      return row;
    }

    /** Structural, not by label: the pin is the row's toggle-state control. */
    function pinControl(row: HTMLElement): HTMLElement | null {
      return row.querySelector<HTMLElement>("[data-launcher-pin]");
    }

    it("renders each option as a container with sibling buttons, never a nested button", () => {
      // The structural precondition for a secondary control: a <button> cannot
      // legally contain another, so the row itself stopped being one.
      const { container } = renderButton();
      for (const option of options(container)) {
        expect(option.tagName).not.toBe("BUTTON");
        expect(option.closest("button")).toBeNull();
        expect(option.querySelector("button button")).toBeNull();
      }
    });

    it("names each option without absorbing its pin button's label", () => {
      // The pin is a child of the option, so a content-derived name would end
      // every pinnable row with "Pin to toolbar: X" — while the destination,
      // which is what the name is for, got buried in the middle.
      const { container } = renderButton();
      const claude = rowFor(container, "Claude").getAttribute("aria-label");

      expect(claude).toContain("Claude");
      expect(claude).toContain("Agent");
      expect(claude).not.toContain("Pin");
      expect(rowFor(container, "Review").getAttribute("aria-label")).toContain("Grid");
    });

    it("offers a pin on built-in agents and on panels that have a toolbar button", () => {
      mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
      const { container } = renderButton();

      expect(pinControl(rowFor(container, "Claude"))).toBeTruthy();
      expect(pinControl(rowFor(container, "Terminal"))).toBeTruthy();
      expect(pinControl(rowFor(container, "Browser"))).toBeTruthy();
      expect(pinControl(rowFor(container, "File Browser"))).toBeTruthy();
      // The kind is `dev-preview`, the button is `dev-server`. Testing the id
      // directly against the toolbar list would drop exactly this row.
      expect(pinControl(rowFor(container, "Dev Preview"))).toBeTruthy();
    });

    it("withholds the pin from rows with nothing to pin to", () => {
      mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
      const { container } = renderButton({
        agents: [{ id: "my-plugin-agent", name: "Plugin agent", availability: "ready" }],
      });

      expect(pinControl(rowFor(container, "My recipe"))).toBeNull();
      expect(pinControl(rowFor(container, "Review"))).toBeNull();
      // Not a built-in agent, so there is no toolbar button id to write.
      expect(pinControl(rowFor(container, "Plugin agent"))).toBeNull();
    });

    it("withholds the pin from the create-recipe cue", () => {
      mockRecipes = [];
      const { container } = renderButton();
      expect(pinControl(rowFor(container, "Create a recipe"))).toBeNull();
    });

    it("reports an installed agent with no toolbar position as unpinned", () => {
      // Since #11680 an installed CLI no longer implies a toolbar slot, so the
      // pin has to read the position too or it describes a button that is not
      // rendered anywhere.
      const { container } = renderButton();
      expect(pinControl(rowFor(container, "Claude"))?.getAttribute("data-pinned")).toBe("false");
    });

    it("reports an agent positioned on either side as pinned", () => {
      mockToolbarLayout = { pinnedButtons: {}, leftButtons: [], rightButtons: ["claude"] };
      const { container } = renderButton();
      expect(pinControl(rowFor(container, "Claude"))?.getAttribute("data-pinned")).toBe("true");
    });

    it("lets an explicit pin outrank a missing position, and an explicit hide outrank one", () => {
      mockAgentSettings = { agents: { claude: { pinned: true }, gemini: { pinned: false } } };
      mockToolbarLayout = { pinnedButtons: {}, leftButtons: ["gemini"], rightButtons: [] };
      const { container } = renderButton();

      expect(pinControl(rowFor(container, "Claude"))?.getAttribute("data-pinned")).toBe("true");
      expect(pinControl(rowFor(container, "Gemini"))?.getAttribute("data-pinned")).toBe("false");
    });

    it("writes an agent pin through the dispatcher that also gives it a position", () => {
      const { container } = renderButton();
      const pin = pinControl(rowFor(container, "Claude"))!;
      expect(pin.getAttribute("data-pinned")).toBe("false");

      fireEvent.click(pin);

      // Both halves: a pin with no position renders no button at all.
      expect(positionAgentButtonMock).toHaveBeenCalledWith("claude");
      expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", true);
    });

    it("unpins without asking for a new position", () => {
      mockToolbarLayout = { pinnedButtons: {}, leftButtons: ["claude"], rightButtons: [] };
      const { container } = renderButton();
      const pin = pinControl(rowFor(container, "Claude"))!;
      expect(pin.getAttribute("data-pinned")).toBe("true");

      fireEvent.click(pin);

      expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", false);
      expect(positionAgentButtonMock).not.toHaveBeenCalled();
    });

    it("writes a panel pin to the toolbar button id, not the panel kind id", () => {
      const { container } = renderButton();
      fireEvent.click(pinControl(rowFor(container, "Dev Preview"))!);

      expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("dev-server", true);
      expect(setAgentPinnedMock).not.toHaveBeenCalled();
    });

    it("inverts whatever the current panel state is", () => {
      mockToolbarLayout = { pinnedButtons: { browser: true }, leftButtons: [], rightButtons: [] };
      const { container } = renderButton();
      const pin = pinControl(rowFor(container, "Browser"))!;
      expect(pin.getAttribute("data-pinned")).toBe("true");

      fireEvent.click(pin);

      expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("browser", false);
    });

    it("pins without launching, closing, or clearing the query", () => {
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({ onLaunchAgent });
      fireEvent.change(searchInput(container), { target: { value: "claude" } });

      fireEvent.click(pinControl(rowFor(container, "Claude"))!);

      expect(setAgentPinnedMock).toHaveBeenCalled();
      expect(onLaunchAgent).not.toHaveBeenCalled();
      expect(recordActionMruMock).not.toHaveBeenCalled();
      // Still open, still filtered — pinning is a change to the list, not an
      // exit from it.
      expect(searchInput(container).value).toBe("claude");
    });

    it("keeps focus off the pin and lets Radix see the pointer sequence", () => {
      const { container } = renderButton();
      const pin = pinControl(rowFor(container, "Claude"))!;

      // preventDefault keeps DOM focus on the search box...
      expect(fireEvent.pointerDown(pin)).toBe(false);

      // ...but propagation must NOT be stopped, or Radix's DismissableLayer
      // stops seeing the pointerdown it needs to classify the next outside
      // click as a dismissal.
      const seen = vi.fn();
      document.addEventListener("pointerdown", seen);
      fireEvent.pointerDown(pin);
      document.removeEventListener("pointerdown", seen);
      expect(seen).toHaveBeenCalled();
    });

    it("does not swallow a second click that lands immediately after the first", () => {
      // No time-window debounce here: only `click` toggles (pointerdown does
      // not), so there is no synthesized pair to swallow, and a window would
      // just make a fast pin-then-unpin depend on how quickly the user moved.
      // The store mock is not reactive, so both clicks read the same state —
      // what this pins down is that the second one reaches the write path.
      const { container } = renderButton();
      const pin = pinControl(rowFor(container, "Claude"))!;

      fireEvent.click(pin);
      fireEvent.click(pin);

      expect(setAgentPinnedMock).toHaveBeenCalledTimes(2);
    });

    it("announces the pin on the option and keeps the control out of the tab order", () => {
      const { container } = renderButton();
      const row = rowFor(container, "Claude");
      const pin = pinControl(row)!;

      // The control is presentational — children of `role="option"` are, and a
      // real button there trips `nested-interactive` — so the chord and the verb
      // have to be announced by the option that owns it. The control keeps only
      // the mouse tooltip, which is not an accessibility surface.
      expect(row.getAttribute("aria-keyshortcuts")).toBe("Alt+P");
      expect(row.getAttribute("aria-label")).toContain("Alt+P");
      expect(pin.getAttribute("title")).toContain("Alt+P");
      // No second tab stop inside a row: the palette moves selection, not focus,
      // and a focusable control here would break that model.
      expect(pin.tabIndex).toBe(-1);
      expect(pin.getAttribute("role")).toBe("presentation");
    });

    it("names the pin shortcut's effect in the option's own name, flipped by state", () => {
      // Children of `role="option"` are presentational, so the pin button's own
      // label never reaches a screen reader — without the verb in the option's
      // name a user hears only a bare "Alt+P" and cannot tell a pinned row from
      // an unpinned one.
      mockToolbarLayout = { pinnedButtons: {}, leftButtons: ["claude"], rightButtons: [] };
      const { container } = renderButton();

      const pinned = rowFor(container, "Claude").getAttribute("aria-label") ?? "";
      const unpinned = rowFor(container, "Gemini").getAttribute("aria-label") ?? "";

      expect(pinned).toContain("Press Alt+P to unpin from toolbar");
      expect(unpinned).toContain("Press Alt+P to pin to toolbar");
      expect(pinned).not.toContain("pin to toolbar");
      expect(unpinned).not.toContain("unpin from toolbar");
    });

    it("leaves the pin phrase off rows that cannot be pinned", () => {
      // The phrase is a promise about a key that works — a recipe row has no
      // pin target, so announcing Alt+P there would send the user nowhere.
      mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
      const { container } = renderButton();

      expect(rowFor(container, "My recipe").getAttribute("aria-label")).not.toContain("Alt+P");
      expect(rowFor(container, "My recipe").getAttribute("aria-keyshortcuts")).toBeNull();
    });

    it("leaves the unavailable-agent warning to the description, not the name", () => {
      // Gemini is blocked in the fixture. `title` beside an `aria-label`
      // computes as the option's description, so the warning still reaches a
      // screen reader — putting it in both would announce it twice.
      const { container } = renderButton();
      const row = rowFor(container, "Gemini");

      expect(row.getAttribute("title")).toContain("blocked by endpoint security");
      expect(row.getAttribute("aria-label")).not.toContain("blocked by endpoint security");
    });

    it("never restates on a row the word its band heading already said", () => {
      // The rule, not the wording. Every browse band is type-homogeneous, so a
      // qualifier that repeats its own heading is spending the row's scarcest
      // width on nothing. Restating the check against a literal list of banned
      // words would need editing every time a band is renamed; comparing the two
      // rendered strings keeps holding whatever they are called.
      const { container, getAllByTestId } = renderButton({ pinnedCount: 0 });

      const nodes = Array.from(
        listbox(container).querySelectorAll<HTMLElement>(
          '[data-testid="dock-launcher-band"], [role="option"]'
        )
      );
      let heading = "";
      const offenders: string[] = [];
      for (const node of nodes) {
        if (node.getAttribute("data-testid") === "dock-launcher-band") {
          heading = (node.textContent ?? "").trim().toLowerCase();
          continue;
        }
        const qualifier = qualifierTextOf(node);
        if (!qualifier || !heading) continue;
        // "Open in dock" states "dock"; "Launch agent" states "agent".
        const headingWords = new Set(heading.split(/\s+/));
        for (const word of qualifier.toLowerCase().split(/[\s·]+/)) {
          if (headingWords.has(word)) offenders.push(`${heading} → ${qualifier}`);
        }
      }

      expect(getAllByTestId("dock-launcher-band").length).toBeGreaterThan(1);
      expect(offenders).toEqual([]);
    });

    it("gives every mixed search result a category, since no heading places it", () => {
      // The complement of the rule above, and the reason it is safe: browse can
      // drop the category because a heading carries it, and search cannot,
      // because one flat "Search results" band mixes all three kinds. Asserted
      // as "every row has one" rather than "this row says Panel" so it survives
      // the category words being renamed.
      mockRecipes = [{ id: "r-1", name: "Review", worktreeId: undefined }];
      const { container } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "review" } });

      const rows = options(container);
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) {
        expect(qualifierTextOf(row)).toBeTruthy();
      }
    });

    it("marks a pinned row with the same glyph as an unpinned one, not a negated one", () => {
      // A pin with a slash through it is the "off/muted/unavailable" mark
      // everywhere that defines one, so wearing it at rest made a pinned row
      // advertise the opposite of its state — and paired with `aria-pressed`
      // it read as a double negative. The rule is that the two states differ by
      // treatment, not by swapping in a contradictory glyph.
      // A toolbar position is what makes a row pinned; `pinnedCount` only
      // decides where the Pinned/Other band line falls.
      mockToolbarLayout = { pinnedButtons: {}, leftButtons: [], rightButtons: ["claude"] };
      const { container } = renderButton();

      const glyphNameOf = (row: HTMLElement): string | undefined => {
        const control = pinControl(row);
        const svg = control?.querySelector("svg");
        return Array.from(svg?.classList ?? []).find((c) => c.startsWith("lucide-"));
      };

      const pressed = options(container).filter(
        (row) => pinControl(row)?.getAttribute("data-pinned") === "true"
      );
      const unpressed = options(container).filter(
        (row) => pinControl(row)?.getAttribute("data-pinned") === "false"
      );
      expect(pressed.length).toBeGreaterThan(0);
      expect(unpressed.length).toBeGreaterThan(0);
      expect(glyphNameOf(pressed[0]!)).toBe(glyphNameOf(unpressed[0]!));
      for (const row of pressed) {
        expect(glyphNameOf(row)).not.toContain("off");
      }
    });

    it("keeps a band's heading while its first row is recording a shortcut", () => {
      // The recorder replaces the whole option, and the heading used to be a
      // child of it — so recording on the first agent deleted "Launch agent"
      // and left the rows beneath it under no heading at all.
      const { container, getAllByTestId } = renderButton();
      const before = getAllByTestId("dock-launcher-band").map((el) => el.textContent);

      const edit = container.querySelector<HTMLElement>('[data-testid^="launcher-shortcut-edit-"]');
      expect(edit).not.toBeNull();
      fireEvent.click(edit!);

      expect(getAllByTestId("dock-launcher-band").map((el) => el.textContent)).toEqual(before);
    });

    it("reserves the same trailing slots for every row under one heading", () => {
      // jsdom has no layout, so this checks the structure the alignment rests on
      // rather than the width. The rule is per BAND, not per row: revealing a
      // control on hover must not shift the row under the pointer, and two rows
      // under one heading must end their labels on one edge. It is no longer
      // "every row in the list" — a recipe can hold neither control in any
      // state, and reserving 48px on the band with the longest names in the
      // palette bought alignment with a band it is not in.
      mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
      const { container } = renderButton();

      const slotsOf = (row: HTMLElement) =>
        Array.from(row.querySelectorAll("[data-launcher-slot]"))
          .map((el) => el.getAttribute("data-launcher-slot"))
          .join(",");

      // Walk the listbox in DOM order, grouping rows under the heading above
      // them, and require one slot signature per group.
      const groups = new Map<string, Set<string>>();
      let heading = "";
      for (const node of listbox(container).querySelectorAll<HTMLElement>(
        '[data-testid="dock-launcher-band"], [role="option"]'
      )) {
        if (node.getAttribute("data-testid") === "dock-launcher-band") {
          heading = node.textContent ?? "";
          continue;
        }
        // Cue rows carry no trailing label, so they have no edge to align.
        if (node.getAttribute("data-row-kind") === "cue") continue;
        const set = groups.get(heading) ?? new Set<string>();
        set.add(slotsOf(node));
        groups.set(heading, set);
      }

      expect(groups.size).toBeGreaterThan(1);
      for (const [band, signatures] of groups) {
        expect([band, signatures.size]).toEqual([band, 1]);
      }

      // The rows that can hold a control still reserve both, so revealing one on
      // hover moves nothing; the recipe band keeps only its disclosure column.
      expect(slotsOf(rowFor(container, "Claude"))).toBe("disclosure,shortcut,pin");
      expect(slotsOf(rowFor(container, "My recipe"))).toBe("disclosure");
      expect(pinControl(rowFor(container, "My recipe"))).toBeNull();
    });

    it("activates from the row itself, not only from an inner control", () => {
      // The row highlights as one thing, so all of it has to launch. When
      // activation lived on an inner button it covered only its own content
      // box, leaving the row's padding and its trailing slot inert.
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({ onLaunchAgent });

      fireEvent.click(rowFor(container, "Claude"));

      expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined);
    });

    it("survives a render before agent settings have hydrated", () => {
      mockAgentSettings = null;
      const { container } = renderButton();

      const pin = pinControl(rowFor(container, "Claude"));
      expect(pin?.getAttribute("data-pinned")).toBe("false");
      fireEvent.click(pin!);
      expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", true);
    });

    describe("Alt+P", () => {
      it("toggles the selected row", () => {
        const { container } = renderButton();
        const input = searchInput(container);
        fireEvent.change(input, { target: { value: "claude" } });

        fireEvent.keyDown(input, { key: "p", code: "KeyP", altKey: true });

        expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", true);
      });

      it("leaves a bare p to the search box", () => {
        // The row is a type-ahead field: an unmodified P is the second letter
        // of "python", not a command.
        const { container } = renderButton();
        const input = searchInput(container);
        fireEvent.change(input, { target: { value: "claude" } });

        fireEvent.keyDown(input, { key: "p", code: "KeyP" });

        expect(setAgentPinnedMock).not.toHaveBeenCalled();
      });

      it("leaves the app's own Cmd/Ctrl combinations alone", () => {
        const { container } = renderButton();
        const input = searchInput(container);
        fireEvent.change(input, { target: { value: "claude" } });

        fireEvent.keyDown(input, { key: "p", code: "KeyP", metaKey: true });
        fireEvent.keyDown(input, { key: "p", code: "KeyP", altKey: true, metaKey: true });
        fireEvent.keyDown(input, { key: "p", code: "KeyP", altKey: true, shiftKey: true });
        // AltGr on Windows/Linux synthesizes ctrl+alt and must keep producing
        // international characters.
        fireEvent.keyDown(input, { key: "p", code: "KeyP", altKey: true, ctrlKey: true });

        expect(setAgentPinnedMock).not.toHaveBeenCalled();
      });

      it("declines a keystroke that reports AltGraph, whatever else it sets", () => {
        // Non-US layouts reach a character through AltGr; swallowing it here
        // would make the affected key untypable while the launcher is open.
        // Built by hand because `getModifierState` is a prototype method — an
        // init-dict entry is silently dropped and the key would appear plain.
        const { container } = renderButton();
        const input = searchInput(container);
        fireEvent.change(input, { target: { value: "claude" } });

        const event = new KeyboardEvent("keydown", {
          key: "p",
          code: "KeyP",
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "getModifierState", {
          value: (mod: string) => mod === "AltGraph",
        });
        fireEvent(input, event);

        expect(setAgentPinnedMock).not.toHaveBeenCalled();
      });

      // The physical-key mapping macOS needs (Option+P arrives as "π") belongs
      // to `normalizeKeyForBinding`, which the launcher calls and which owns
      // that behaviour under a mocked platform in KeybindingService.test.ts.
      // Re-asserting it here would only prove jsdom reports a non-Mac platform.

      it("does not flip repeatedly while the key is held", () => {
        const { container } = renderButton();
        const input = searchInput(container);
        fireEvent.change(input, { target: { value: "claude" } });

        fireEvent.keyDown(input, { key: "p", code: "KeyP", altKey: true, repeat: true });

        expect(setAgentPinnedMock).not.toHaveBeenCalled();
      });

      it("does nothing when the selected row has nothing to pin", () => {
        mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
        const { container } = renderButton();
        const input = searchInput(container);
        fireEvent.change(input, { target: { value: "my recipe" } });

        fireEvent.keyDown(input, { key: "p", code: "KeyP", altKey: true });

        expect(setAgentPinnedMock).not.toHaveBeenCalled();
        expect(setPanelButtonOnToolbarMock).not.toHaveBeenCalled();
      });
    });
  });
});

// Coverage migrated from the deleted `LauncherMenuButton` suite: the affordances
// #11691 required to survive the swap, re-expressed against the flat
// search-first list that replaced the Radix menu.
describe("DockLaunchButton — migrated toolbar affordances (#11691)", () => {
  const READY = [{ id: "claude", name: "Claude", availability: "ready" as const }];

  function rowByName(container: HTMLElement, name: string): HTMLElement {
    const row = options(container).find((o) =>
      o.getAttribute("aria-label")?.startsWith(`${name},`)
    );
    if (!row) throw new Error(`no row for ${name}`);
    return row;
  }
  const presetRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="option"][data-row-kind="preset"]'));

  describe("preset rows", () => {
    beforeEach(() => {
      mockMergedPresets = [
        { id: "fast", name: "Fast" },
        { id: "slow", name: "Slow" },
      ];
    });

    it("does not expand until asked, and keeps presets out of the flat list", () => {
      const { container } = renderButton({ agents: READY });
      expect(presetRows(container)).toHaveLength(0);
      // The row advertises what it can do rather than doing it.
      expect(rowByName(container, "Claude").getAttribute("aria-expanded")).toBe("false");
    });

    it("expands into sibling options on ArrowRight and collapses on ArrowLeft", () => {
      const { container } = renderButton({ agents: READY });
      const input = searchInput(container);

      fireEvent.keyDown(input, { key: "ArrowRight" });
      // Default plus both named presets, as siblings in the same listbox.
      expect(presetRows(container).map((r) => r.textContent)).toEqual([
        expect.stringContaining("Default"),
        expect.stringContaining("Fast"),
        expect.stringContaining("Slow"),
      ]);
      expect(rowByName(container, "Claude").getAttribute("aria-expanded")).toBe("true");

      fireEvent.keyDown(input, { key: "ArrowLeft" });
      expect(presetRows(container)).toHaveLength(0);
    });

    it("keeps one heading per band when an agent's presets are spliced in", () => {
      // Two agents, expanding the first: the bug only shows when a row of the
      // parent's band FOLLOWS the preset block. Preset rows are siblings in the
      // same flat list spliced inside their parent's band, so comparing each
      // row's band with the row immediately before it made Gemini look like the
      // start of a second "Launch agent" group.
      const two = [
        { id: "claude", name: "Claude", availability: "ready" as const },
        { id: "gemini", name: "Gemini", availability: "ready" as const },
      ];
      const { container, getAllByTestId } = renderButton({ agents: two });
      const bandsOf = () => getAllByTestId("dock-launcher-band").map((el) => el.textContent);
      const before = bandsOf();

      fireEvent.keyDown(searchInput(container), { key: "ArrowRight" });
      expect(presetRows(container).length).toBeGreaterThan(0);

      const after = bandsOf();
      expect(after.filter((label, i) => after.indexOf(label) !== i)).toEqual([]);
      // The expansion contributes its own heading and disturbs no other.
      expect(after).toEqual(expect.arrayContaining(before));
    });

    it("selects the first preset once the expansion has rendered", () => {
      // The selection cannot move in the same handler that expands: the rows it
      // would point at do not exist yet.
      const { container } = renderButton({ agents: READY });
      fireEvent.keyDown(searchInput(container), { key: "ArrowRight" });
      expect(selectedOption(container)?.textContent).toContain("Default");
    });

    it("keeps every expanded row in one navigation space", () => {
      const { container } = renderButton({ agents: READY });
      const input = searchInput(container);
      fireEvent.keyDown(input, { key: "ArrowRight" });
      // Arrowing down from Default reaches the next preset, not a nested list.
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(selectedOption(container)?.textContent).toContain("Fast");
      // Exactly one option is ever selected across the whole flat list.
      expect(container.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(1);
    });

    it("launches the explicit default from a toolbar parent and the chosen id from a child", () => {
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({
        agents: READY,
        onLaunchAgent,
        placement: "toolbar",
      });

      // The toolbar's parent row means explicit Default — `null`, the sentinel
      // that clears a saved preset — matching the split trigger it replaced.
      fireEvent.click(rowByName(container, "Claude"));
      expect(onLaunchAgent).toHaveBeenCalledWith("claude", null);

      onLaunchAgent.mockReset();
      const { container: c2 } = renderButton({ agents: READY, onLaunchAgent });
      fireEvent.keyDown(searchInput(c2), { key: "ArrowRight" });
      fireEvent.click(presetRows(c2)[1]!);
      expect(onLaunchAgent).toHaveBeenCalledWith("claude", "fast");
    });

    it("inherits the saved preset from a dock parent row", () => {
      // The dock never offered presets, so its rows launched whatever was
      // saved. A plain click must not silently reset that — explicit Default
      // is still reachable as the first row of the expansion.
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({ agents: READY, onLaunchAgent, placement: "dock" });

      fireEvent.click(rowByName(container, "Claude"));
      expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined);

      // ...and the Default row still reaches the explicit sentinel.
      onLaunchAgent.mockReset();
      fireEvent.keyDown(searchInput(container), { key: "ArrowRight" });
      fireEvent.click(presetRows(container)[0]!);
      expect(onLaunchAgent).toHaveBeenCalledWith("claude", null);
    });

    it("passes undefined for an agent with no presets so its saved default resolves", () => {
      mockMergedPresets = [];
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({
        agents: READY,
        onLaunchAgent,
        placement: "toolbar",
      });
      fireEvent.click(rowByName(container, "Claude"));
      expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined);
    });

    it("leaves a text selection to the arrow keys instead of collapsing presets", () => {
      const { container } = renderButton({ agents: READY });
      const input = searchInput(container);

      fireEvent.change(input, { target: { value: "claude" } });
      input.setSelectionRange(6, 6);
      fireEvent.keyDown(input, { key: "ArrowRight" });
      expect(presetRows(container).length).toBeGreaterThan(0);

      // A range selection is text the arrow should collapse, so it counts as
      // being at neither edge — ArrowLeft belongs to the caret, not the list.
      input.setSelectionRange(0, 6);
      fireEvent.keyDown(input, { key: "ArrowLeft" });
      expect(presetRows(container).length).toBeGreaterThan(0);

      // With the caret genuinely at the start, it collapses.
      input.setSelectionRange(0, 0);
      fireEvent.keyDown(input, { key: "ArrowLeft" });
      expect(presetRows(container)).toHaveLength(0);
    });

    it("collapses the expansion when the query changes", () => {
      const { container } = renderButton({ agents: READY });
      const input = searchInput(container);
      fireEvent.keyDown(input, { key: "ArrowRight" });
      expect(presetRows(container).length).toBeGreaterThan(0);

      fireEvent.change(input, { target: { value: "term" } });
      expect(presetRows(container)).toHaveLength(0);
    });

    it("leaves ArrowRight to the caret while there is text to move through", () => {
      const { container } = renderButton({ agents: READY });
      const input = searchInput(container);
      fireEvent.change(input, { target: { value: "claude" } });
      input.setSelectionRange(0, 0);

      fireEvent.keyDown(input, { key: "ArrowRight" });
      expect(presetRows(container)).toHaveLength(0);
    });
  });

  describe("shortcut capture", () => {
    const openCapture = (container: HTMLElement) => {
      const edit = rowByName(container, "Claude").querySelector<HTMLButtonElement>(
        '[data-testid="launcher-shortcut-edit-claude"]'
      );
      fireEvent.click(edit!);
    };

    it("replaces the row with a recorder that is not an option", () => {
      const { container } = renderButton({ agents: READY });
      openCapture(container);

      expect(container.querySelector('[data-testid="capture-widget-claude"]')).toBeTruthy();
      // The recorder's controls have to be reachable, which they cannot be
      // inside a `role="option"` — its children are presentational.
      expect(
        options(container).some((o) => o.getAttribute("aria-label")?.startsWith("Claude,"))
      ).toBe(false);
    });

    it("stops recorder keystrokes from reaching the list behind it", () => {
      const { container } = renderButton({ agents: READY });
      openCapture(container);
      const widget = container.querySelector('[data-testid="capture-widget-claude"]')!;

      // Fired ON the recorder, not the container: a container-only assertion
      // passes even when the row lets keys through.
      const before = selectedOption(container)?.id;
      fireEvent.keyDown(widget, { key: "ArrowDown", bubbles: true });
      expect(selectedOption(container)?.id).toBe(before);
    });

    it("cancels in place on Escape and leaves the launcher open", () => {
      const { container } = renderButton({ agents: READY });
      openCapture(container);
      expect(container.querySelector('[data-testid="capture-widget-claude"]')).toBeTruthy();

      // The shell runs the consumer veto ahead of its own query-clear rule.
      const event = { preventDefault: vi.fn(), defaultPrevented: false };
      popoverEscapeKeyDownSpy?.(event as unknown as KeyboardEvent);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("clears the recorder when the launcher closes", () => {
      const { container } = renderButton({ agents: READY });
      openCapture(container);
      act(() => popoverOpenChangeSpy!(false));
      // Reset on the single close path, so a half-open recording can't survive
      // into the next open.
      expect(container.querySelector('[data-testid="capture-widget-claude"]')).toBeNull();
    });

    it("saves through the keybinding action and closes on success", async () => {
      const { container } = renderButton({ agents: READY });
      openCapture(container);
      const capture = container.querySelector('[data-testid="capture-widget-claude"]')!;

      await act(async () => {
        fireEvent.click(capture.querySelector("button")!);
      });
      expect(actionDispatchMock).toHaveBeenCalledWith(
        "keybinding.setOverride",
        { actionId: "agent.claude", combo: ["Ctrl+Shift+9"] },
        { source: "user" }
      );
    });

    it("stays open when the save is refused", async () => {
      actionDispatchMock.mockResolvedValue({ ok: false, error: new Error("nope") });
      const { container } = renderButton({ agents: READY });
      openCapture(container);

      await act(async () => {
        fireEvent.click(
          container.querySelector('[data-testid="capture-widget-claude"]')!.querySelector("button")!
        );
      });
      expect(container.querySelector('[data-testid="capture-widget-claude"]')).toBeTruthy();
    });
  });

  describe("disabled rows stay reachable", () => {
    it("marks a gated panel aria-disabled while leaving it selectable and pinnable", () => {
      const { container } = renderButton({ agents: READY, hasWorkspace: false });
      const row = rowByName(container, "File Browser");

      expect(row.getAttribute("aria-disabled")).toBe("true");
      // Reachable: it is still an option, so arrow keys land on it...
      expect(options(container)).toContain(row);
      // ...and its pin is still there, which is the whole reason it stays.
      expect(row.querySelector("[data-launcher-pin]")).toBeTruthy();
    });

    it("opens nothing and stays open when a gated row is activated", () => {
      const { container } = renderButton({ agents: READY, hasWorkspace: false });
      // A typed query is the observable proxy for the close path: every close
      // runs through `closeLauncher`, which clears it. A press that opened
      // nothing must not read as a launch that closed.
      fireEvent.change(searchInput(container), { target: { value: "file" } });
      fireEvent.click(rowByName(container, "File Browser"));

      expect(addPanelMock).not.toHaveBeenCalled();
      expect(searchInput(container).value).toBe("file");
    });

    it("still pins a gated row", () => {
      const { container } = renderButton({ agents: READY, hasWorkspace: false });
      const pin = rowByName(container, "File Browser").querySelector<HTMLElement>(
        "[data-launcher-pin]"
      )!;
      fireEvent.click(pin);
      expect(setPanelButtonOnToolbarMock).toHaveBeenCalledWith("file-browser", true);
    });
  });

  describe("restored menu affordances", () => {
    it("shows a panel row's shortcut, resolved through its own action", () => {
      // The launcher row is keyed by panel KIND; the binding lives on the action
      // behind that kind's toolbar button. A row resolving the wrong action
      // would render nothing, or another panel's combo.
      mockKeybindings["agent.terminal"] = "⌘⌥T";
      mockKeybindings["worktree.openFileBrowserPanel"] = "⌘⌥E";
      const { container } = renderButton({ agents: READY });

      expect(rowByName(container, "Terminal").textContent).toContain("⌘⌥T");
      expect(rowByName(container, "File Browser").textContent).toContain("⌘⌥E");
      // ...and a row with no binding renders no stray hint.
      expect(rowByName(container, "Browser").textContent).not.toContain("⌘");
    });

    it("shows an agent row's own binding", () => {
      mockKeybindings["agent.claude"] = "⌘1";
      const { container } = renderButton({ agents: READY });
      expect(rowByName(container, "Claude").textContent).toContain("⌘1");
    });

    it("says it is still detecting rather than showing an empty agent inventory", () => {
      const { container, queryByTestId } = renderButton({
        agents: [],
        agentInventoryState: "loading",
      });
      expect(queryByTestId("dock-launcher-loading")).toBeTruthy();
      expect(container.textContent).toContain("Checking agents");
    });

    it("drops the detecting notice once the inventory is real", () => {
      const { queryByTestId } = renderButton({
        agents: READY,
        agentInventoryState: "installed",
      });
      expect(queryByTestId("dock-launcher-loading")).toBeNull();
    });

    it("heads each preset provenance group only when more than one exists", () => {
      mockMergedPresets = [
        { id: "ccr-fast", name: "CCR: Fast" },
        { id: "mine", name: "Mine" },
      ];
      const { container } = renderButton({ agents: READY });
      fireEvent.keyDown(searchInput(container), { key: "ArrowRight" });

      const headings = Array.from(
        container.querySelectorAll('[data-testid="dock-launcher-preset-group"]')
      ).map((el) => el.textContent);
      expect(headings).toEqual(["CCR Routes", "Custom"]);
    });

    it("omits provenance headings when every preset shares one group", () => {
      mockMergedPresets = [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ];
      const { container } = renderButton({ agents: READY });
      fireEvent.keyDown(searchInput(container), { key: "ArrowRight" });

      // One group — a heading would just restate what every row under it is.
      expect(container.querySelectorAll('[data-testid="dock-launcher-preset-group"]')).toHaveLength(
        0
      );
    });
  });

  describe("preset persistence", () => {
    beforeEach(() => {
      mockMergedPresets = [{ id: "fast", name: "Fast" }];
    });

    it("clears the saved preset when the toolbar launches explicit Default", () => {
      const { container } = renderButton({
        agents: READY,
        placement: "toolbar",
        activeWorktreeId: "wt-1",
      });
      fireEvent.click(rowByName(container, "Claude"));

      // Both halves of "explicit default": the agent-level preset and the
      // worktree-scoped override.
      expect(updateAgentMock).toHaveBeenCalledWith("claude", { presetId: undefined });
      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-1", undefined);
    });

    it("persists a chosen preset to the active worktree", () => {
      const { container } = renderButton({ agents: READY, activeWorktreeId: "wt-1" });
      fireEvent.keyDown(searchInput(container), { key: "ArrowRight" });
      fireEvent.click(presetRows(container)[1]!);

      expect(updateWorktreePresetMock).toHaveBeenCalledWith("claude", "wt-1", "fast");
      // A named pick is not a reset, so the agent-level preset is left alone.
      expect(updateAgentMock).not.toHaveBeenCalled();
    });

    it("writes no scope when there is no active worktree", () => {
      const { container } = renderButton({
        agents: READY,
        placement: "toolbar",
        activeWorktreeId: null,
      });
      fireEvent.click(rowByName(container, "Claude"));
      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
    });

    it("persists nothing when a dock row inherits its saved preset", () => {
      const { container } = renderButton({
        agents: READY,
        placement: "dock",
        activeWorktreeId: "wt-1",
      });
      fireEvent.click(rowByName(container, "Claude"));

      expect(updateAgentMock).not.toHaveBeenCalled();
      expect(updateWorktreePresetMock).not.toHaveBeenCalled();
    });
  });

  describe("placement variants", () => {
    it("anchors below the trigger in the toolbar and above it in the dock", () => {
      expect(renderButton({ placement: "toolbar" }).container).toBeTruthy();
      expect(popoverSide).toBe("bottom");
      expect(renderButton({ placement: "dock" }).container).toBeTruthy();
      expect(popoverSide).toBe("top");
    });

    it("forwards data-toolbar-item so the toolbar's roving focus can see it", () => {
      const { getByLabelText } = renderButton({
        placement: "toolbar",
        "data-toolbar-item": "",
      });
      expect(getByLabelText("Launcher").hasAttribute("data-toolbar-item")).toBe(true);
    });

    it("leaves the dock trigger out of the toolbar sweep", () => {
      const { getByLabelText } = renderButton({ placement: "dock" });
      expect(getByLabelText("Open launcher").hasAttribute("data-toolbar-item")).toBe(false);
    });

    it("offers the same inventory in both placements", () => {
      const names = (c: HTMLElement) =>
        options(c).map((o) => o.getAttribute("aria-label")?.split(",")[0]);
      const toolbar = names(renderButton({ agents: READY, placement: "toolbar" }).container);
      const dock = names(renderButton({ agents: READY, placement: "dock" }).container);
      // One launcher, two placements, same inventory — the issue's end state.
      expect(new Set(toolbar)).toEqual(new Set(dock));
    });
  });
});
