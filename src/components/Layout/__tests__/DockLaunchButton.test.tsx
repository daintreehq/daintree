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
let dropdownCloseAutoFocusSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let dropdownPointerDownOutsideSpy: (() => void) | null = null;
let dropdownEscapeKeyDownSpy: ((e: { preventDefault: () => void }) => void) | null = null;
let dropdownOpenChangeSpy: ((open: boolean) => void) | null = null;

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
  usePanelStore: { getState: () => ({ addPanel: addPanelMock }) },
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

// Mock UI primitives so the test focuses on this component's behavior, not
// Radix's pointer-event semantics inside jsdom. Mirrors AgentButton.test.tsx.
// Radix's real focus/dismiss behaviour (pointer-move focus steal, document-level
// Escape capture) is covered by e2e/full/panels/core-dock-launcher.spec.ts.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  // Content is rendered unconditionally (not gated on `open`) so the existing
  // item-level assertions keep working without an open step; open/close is
  // exercised through the captured onOpenChange.
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    dropdownOpenChangeSpy = onOpenChange ?? null;
    return <>{children}</>;
  },
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({
    children,
    onCloseAutoFocus,
    onPointerDownOutside,
    onEscapeKeyDown,
  }: {
    children: ReactNode;
    onCloseAutoFocus?: (e: { preventDefault: () => void }) => void;
    onPointerDownOutside?: () => void;
    onEscapeKeyDown?: (e: { preventDefault: () => void }) => void;
  }) => {
    dropdownCloseAutoFocusSpy = onCloseAutoFocus ?? null;
    dropdownPointerDownOutsideSpy = onPointerDownOutside ?? null;
    dropdownEscapeKeyDownSpy = onEscapeKeyDown ?? null;
    return <div data-testid="dock-launcher-content">{children}</div>;
  },
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    title,
    className,
    onPointerMove,
    id,
    ...rest
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    title?: string;
    className?: string;
    onPointerMove?: (e: unknown) => void;
    id?: string;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      onClick={() => onSelect?.()}
      disabled={disabled}
      title={title}
      className={className}
      id={id}
      onPointerMove={onPointerMove}
      data-selected-row={rest["data-selected-row"] as string | undefined}
    >
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div data-testid="dock-launcher-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr data-testid="dock-launcher-separator" />,
}));

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

/** The launcher's search box — the only textbox inside the menu. */
function searchInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector("input");
  if (!input) throw new Error("search input not found");
  return input;
}

beforeEach(() => {
  mockRecipes = [];
  mockMruEntries = [];
  runRecipeWithResultsMock.mockReset().mockResolvedValue({
    spawned: [{ index: 0, terminalId: "t-0" }],
    failed: [],
  });
  notifySpawnFailuresMock.mockReset();
  logErrorMock.mockReset();
  actionDispatchMock.mockReset();
  recordActionMruMock.mockReset();
  addPanelMock.mockReset();
  dropdownCloseAutoFocusSpy = null;
  dropdownPointerDownOutsideSpy = null;
  dropdownEscapeKeyDownSpy = null;
  dropdownOpenChangeSpy = null;
});

describe("DockLaunchButton", () => {
  it("renders a launch button with accessible label", () => {
    const { getByLabelText } = renderButton();
    expect(getByLabelText("Open launcher")).toBeTruthy();
  });

  it("renders sectioned labels for agents, both panel destinations, and recipes", () => {
    mockRecipes = [{ id: "r-1", name: "My recipe", worktreeId: undefined }];
    const { getAllByTestId } = renderButton();

    const labels = getAllByTestId("dock-launcher-label").map((el) => el.textContent);
    expect(labels).toEqual(["Launch agent", "Open in dock", "Open in grid", "Launch recipe"]);
  });

  it("splits agents into Pinned/Other groups when pinnedCount is a strict subset", () => {
    const { getAllByTestId, container } = renderButton({ pinnedCount: 1 });

    const labels = getAllByTestId("dock-launcher-label").map((el) => el.textContent);
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
    const labels = getAllByTestId("dock-launcher-label").map((el) => el.textContent);
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

    expect(getByText("Claude").getAttribute("title")).toBeNull();
    expect(getByText("Gemini").getAttribute("title")).toBe(
      "Gemini is blocked by endpoint security. Click to configure."
    );
    expect(getByText("Codex").getAttribute("title")).toBe("Codex needs setup. Click to configure.");
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
      expect(onLaunchAgent).toHaveBeenLastCalledWith("terminal");
      expect(addPanelMock).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("narrows the list to matches and drops the unfiltered band headings", () => {
      const { container, getAllByTestId, queryByText } = renderButton();

      fireEvent.change(searchInput(container), { target: { value: "review" } });

      const labels = getAllByTestId("dock-launcher-label").map((el) => el.textContent);
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

    it("dims a blocked agent in the results and keeps its setup tooltip", () => {
      // A filtered row that looks ordinary but silently opens Settings is worse
      // than the unfiltered one, which dims and explains itself.
      const { container, getByText } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "gemini" } });

      const row = getByText("Gemini").closest("button");
      expect(row?.className).toContain("opacity-70");
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

      const selected = container.querySelectorAll("[data-selected-row='true']");
      expect(selected).toHaveLength(1);
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
      const firstName = container.querySelector("[data-selected-row='true']")?.textContent;

      fireEvent.keyDown(input, { key: "ArrowDown" });
      const moved = container.querySelector("[data-selected-row='true']");
      expect(moved?.textContent).not.toBe(firstName);

      // Actually confirm it — the previous version never pressed Enter, so it
      // proved nothing about what Enter would do.
      const movedName = moved?.textContent;
      fireEvent.keyDown(input, { key: "Enter" });
      const launched = onLaunchAgent.mock.calls.length > 0 || addPanelMock.mock.calls.length > 0;
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

    it("leaves arrow keys to the menu while unfiltered so items stay reachable", () => {
      // The unfiltered bands have no selected-row styling, so swallowing arrows
      // here would strand keyboard users with an invisible selection.
      const { container } = renderButton();
      const input = searchInput(container);

      const menuSaw = vi.fn();
      container.addEventListener("keydown", menuSaw);
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })
      );
      container.removeEventListener("keydown", menuSaw);

      expect(menuSaw).toHaveBeenCalledTimes(1);
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
      dropdownEscapeKeyDownSpy!(event);
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

    it("stops printable keys reaching Radix's typeahead", () => {
      const { container } = renderButton();
      const input = searchInput(container);

      const menuSaw = vi.fn();
      container.addEventListener("keydown", menuSaw);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
      container.removeEventListener("keydown", menuSaw);

      expect(menuSaw).not.toHaveBeenCalled();
    });

    it("shows a recovery cue when nothing matches", () => {
      const { container, getByText } = renderButton();
      fireEvent.change(searchInput(container), { target: { value: "zzzzqqqq" } });
      expect(getByText("Try a different search")).toBeTruthy();
    });

    it("first Escape clears the query and blocks the menu close; second closes", () => {
      const { container } = renderButton();
      const input = searchInput(container);
      fireEvent.change(input, { target: { value: "review" } });

      // With a query present the content handler vetoes dismissal...
      const withQuery = { preventDefault: vi.fn() };
      dropdownEscapeKeyDownSpy!(withQuery);
      expect(withQuery.preventDefault).toHaveBeenCalledTimes(1);

      // ...and the input clears it.
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input.value).toBe("");

      // Now empty, Escape is left alone so the menu actually closes.
      const whenEmpty = { preventDefault: vi.fn() };
      dropdownEscapeKeyDownSpy!(whenEmpty);
      expect(whenEmpty.preventDefault).not.toHaveBeenCalled();
    });

    it("moves focus to the input once the menu is open", async () => {
      // Radix's mount autofocus lands on the first item synchronously, so the
      // launcher re-focuses on the next frame. e2e covers the real race; here we
      // only pin that opening drives focus to the search box at all.
      const { container } = renderButton();
      expect(document.activeElement).not.toBe(searchInput(container));

      act(() => dropdownOpenChangeSpy!(true));

      // The focus is deferred a frame, so poll rather than racing it — a frame
      // awaited here would be scheduled before the effect's own.
      await waitFor(() => expect(document.activeElement).toBe(searchInput(container)));
    });

    it("clears the query when the menu closes so the next open starts unfiltered", () => {
      const { container } = renderButton();
      const input = searchInput(container);
      fireEvent.change(input, { target: { value: "review" } });
      expect(input.value).toBe("review");

      act(() => dropdownOpenChangeSpy!(false));
      expect(input.value).toBe("");
    });

    it("mirrors pointer hover into selection without letting Radix steal focus", () => {
      const { container } = renderButton();
      const input = searchInput(container);
      fireEvent.change(input, { target: { value: "e" } });

      const rows = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button[data-selected-row]")
      );
      expect(rows.length).toBeGreaterThan(1);

      const second = rows[1]!;
      const moved = fireEvent.pointerMove(second);
      // preventDefault is what stops Radix's item-focus handler from running.
      expect(moved).toBe(false);
      expect(second.getAttribute("data-selected-row")).toBe("true");
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
    expect(dropdownCloseAutoFocusSpy).toBeTruthy();
    expect(dropdownPointerDownOutsideSpy).toBeTruthy();

    // Keyboard close (no prior pointer-down-outside) must NOT preventDefault
    // — focus restoration is required for WAI-ARIA Escape/Enter.
    const keyboardPreventDefault = vi.fn();
    dropdownCloseAutoFocusSpy!({ preventDefault: keyboardPreventDefault });
    expect(keyboardPreventDefault).not.toHaveBeenCalled();

    // Pointer close suppresses the focus ring.
    dropdownPointerDownOutsideSpy!();
    const pointerPreventDefault = vi.fn();
    dropdownCloseAutoFocusSpy!({ preventDefault: pointerPreventDefault });
    expect(pointerPreventDefault).toHaveBeenCalledTimes(1);

    // The pointer flag must reset after one onCloseAutoFocus or a later
    // keyboard-driven close would inherit suppression and break focus return.
    const resetPreventDefault = vi.fn();
    dropdownCloseAutoFocusSpy!({ preventDefault: resetPreventDefault });
    expect(resetPreventDefault).not.toHaveBeenCalled();
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

      const labels = getAllByTestId("dock-launcher-label").map((el) => el.textContent);
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

      act(() => dropdownOpenChangeSpy!(false));
      act(() => dropdownOpenChangeSpy!(true));

      expect(getByText("Recently launched")).toBeTruthy();
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
  });
});
