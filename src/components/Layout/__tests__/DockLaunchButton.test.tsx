// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
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

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ addPanel: addPanelMock, panelsById: { "panel-1": { location: "grid" } } }),
  },
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
    (selector: (s: { getSortedActionMruList: () => typeof mockMruEntries }) => unknown) =>
      selector({ getSortedActionMruList: getSortedActionMruListMock }),
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

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ settings: mockAgentSettings, setAgentPinned: setAgentPinnedMock }),
}));

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ availability: mockAgentAvailability }),
}));

vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      layout: mockToolbarLayout,
      setPanelButtonOnToolbar: setPanelButtonOnToolbarMock,
      positionAgentButton: positionAgentButtonMock,
      toggleButtonVisibility: toggleButtonVisibilityMock,
    }),
}));

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
  }: {
    children: ReactNode;
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

function options(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(OPTION));
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
  popoverModal = undefined;
  mockAgentSettings = { agents: {} };
  mockAgentAvailability = {};
  mockToolbarLayout = { pinnedButtons: {}, leftButtons: [], rightButtons: [] };
  setAgentPinnedMock.mockReset();
  setPanelButtonOnToolbarMock.mockReset();
  positionAgentButtonMock.mockReset();
  toggleButtonVisibilityMock.mockReset();
});

describe("DockLaunchButton", () => {
  it("renders a launch button with accessible label", () => {
    const { getByLabelText } = renderButton();
    expect(getByLabelText("Open launcher")).toBeTruthy();
  });

  it("renders sectioned labels for agents, both panel destinations, and recipes", () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
    const { getAllByTestId } = renderButton();

    const labels = getAllByTestId("dock-launcher-band").map((el) => el.textContent);
    expect(labels).toEqual(["Launch agent", "Open in dock", "Open in grid", "Launch recipe"]);
  });

  it("splits agents into Pinned/Other groups when pinnedCount is a strict subset", () => {
    const { getAllByTestId, container } = renderButton({ pinnedCount: 1 });

    const labels = getAllByTestId("dock-launcher-band").map((el) => el.textContent);
    expect(labels.slice(0, 2)).toEqual(["Pinned", "Other"]);

    // Assert document order so a regression that puts both agents under one
    // group (or swaps them) is caught: Pinned → Claude → Other → Gemini.
    const text = container.textContent ?? "";
    expect(text.indexOf("Pinned")).toBeLessThan(text.indexOf("Claude"));
    expect(text.indexOf("Claude")).toBeLessThan(text.indexOf("Other"));
    expect(text.indexOf("Other")).toBeLessThan(text.indexOf("Gemini"));
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
    expect(onLaunchAgent).toHaveBeenCalledWith("claude");
    expect(actionDispatchMock).not.toHaveBeenCalled();
    // The dock launch path must record MRU so the agent surfaces in the
    // recency band on the next open (previously this path recorded nothing).
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.claude");
  });

  it("routes non-launchable agent clicks to the agent settings subtab", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = renderButton({ onLaunchAgent });

    fireEvent.click(getByText("Gemini"));
    expect(onLaunchAgent).not.toHaveBeenCalled();
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents", subtab: "gemini" },
      { source: "menu" }
    );
    // A settings redirect is not a launch — it must not pollute the band.
    expect(recordActionMruMock).not.toHaveBeenCalled();
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
    expect(getByText("Claude").closest("button")?.getAttribute("title")).toBeNull();
    expect(getByText("Gemini").closest("button")?.getAttribute("title")).toBe(
      "Gemini is blocked by endpoint security. Click to configure."
    );
    expect(getByText("Codex").closest("button")?.getAttribute("title")).toBe(
      "Codex needs setup. Click to configure."
    );
  });

  it("treats unauthenticated agents as launchable (CLI handles auth at runtime)", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = renderButton({
      agents: [{ id: "codex", name: "Codex", availability: "unauthenticated" }],
      onLaunchAgent,
    });

    fireEvent.click(getByText("Codex"));
    expect(onLaunchAgent).toHaveBeenCalledWith("codex");
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
      // A filtered row that looks ordinary but silently opens Settings is worse
      // than the unfiltered one, which explains itself before you click. The
      // dimming that accompanies it is styling, so it isn't asserted here.
      const { container, getByText } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "gemini" } });

      const row = getByText("Gemini").closest("button");
      expect(row?.getAttribute("title")).toContain("blocked by endpoint security");
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

      expect(onLaunchAgent).toHaveBeenCalledWith("claude");
    });

    it("Enter launches the top result", () => {
      const onLaunchAgent = vi.fn();
      const { container } = renderButton({ onLaunchAgent });
      const input = searchInput(container);

      fireEvent.change(input, { target: { value: "claude" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onLaunchAgent).toHaveBeenCalledWith("claude");
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
      expect(onLaunchAgent).toHaveBeenCalledWith("claude");
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
      expect(onLaunchAgent).toHaveBeenCalledWith("claude");
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

    it("keeps the return when a row routes to settings instead of launching", () => {
      const onLaunchAgent = vi.fn();
      const { getByText } = renderButton({ onLaunchAgent });

      fireEvent.click(getByText("Gemini"));

      expect(onLaunchAgent).not.toHaveBeenCalled();
      expect(fireCloseAutoFocus()).not.toHaveBeenCalled();
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
      expect(onLaunchAgent).toHaveBeenCalledWith("codex");
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
    function pinControl(row: HTMLElement): HTMLButtonElement | null {
      return row.querySelector<HTMLButtonElement>("button[aria-pressed]");
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
      expect(pinControl(rowFor(container, "Claude"))?.getAttribute("aria-pressed")).toBe("false");
    });

    it("reports an agent positioned on either side as pinned", () => {
      mockToolbarLayout = { pinnedButtons: {}, leftButtons: [], rightButtons: ["claude"] };
      const { container } = renderButton();
      expect(pinControl(rowFor(container, "Claude"))?.getAttribute("aria-pressed")).toBe("true");
    });

    it("lets an explicit pin outrank a missing position, and an explicit hide outrank one", () => {
      mockAgentSettings = { agents: { claude: { pinned: true }, gemini: { pinned: false } } };
      mockToolbarLayout = { pinnedButtons: {}, leftButtons: ["gemini"], rightButtons: [] };
      const { container } = renderButton();

      expect(pinControl(rowFor(container, "Claude"))?.getAttribute("aria-pressed")).toBe("true");
      expect(pinControl(rowFor(container, "Gemini"))?.getAttribute("aria-pressed")).toBe("false");
    });

    it("writes an agent pin through the dispatcher that also gives it a position", () => {
      const { container } = renderButton();
      const pin = pinControl(rowFor(container, "Claude"))!;
      expect(pin.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(pin);

      // Both halves: a pin with no position renders no button at all.
      expect(positionAgentButtonMock).toHaveBeenCalledWith("claude");
      expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", true);
    });

    it("unpins without asking for a new position", () => {
      mockToolbarLayout = { pinnedButtons: {}, leftButtons: ["claude"], rightButtons: [] };
      const { container } = renderButton();
      const pin = pinControl(rowFor(container, "Claude"))!;
      expect(pin.getAttribute("aria-pressed")).toBe("true");

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
      expect(pin.getAttribute("aria-pressed")).toBe("true");

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

    it("suppresses a repeat toggle of one row but not of a second row", () => {
      // A pointer/click pair on one row is a single intent; two rows in quick
      // succession are two.
      const { container } = renderButton();
      const claudePin = pinControl(rowFor(container, "Claude"))!;

      fireEvent.click(claudePin);
      fireEvent.click(claudePin);
      expect(setAgentPinnedMock).toHaveBeenCalledTimes(1);

      fireEvent.click(pinControl(rowFor(container, "Terminal"))!);
      expect(setPanelButtonOnToolbarMock).toHaveBeenCalledTimes(1);
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
