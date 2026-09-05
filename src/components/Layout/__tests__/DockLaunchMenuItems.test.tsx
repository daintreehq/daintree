// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  getPanelKindIds,
  getPanelKindConfig,
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";

// #11593 split the `+` launcher onto its own palette renderer, leaving this
// component to the two right-click menus alone. These pin the contract those
// consumers depend on — the banded list, the recency shortcut, and activation
// through a caller-supplied menu primitive — so a later launcher-side change
// can't quietly take the context menus with it.

let mockRecipes: Array<{ id: string; name: string; worktreeId?: string }> = [];
let mockMruEntries: Array<{ id: string; score: number; lastAccessedAt: number }> = [];
const actionDispatchMock = vi.fn();
const recordActionMruMock = vi.fn();
const addPanelMock = vi.fn();

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

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(
    (selector: (s: { recipes: typeof mockRecipes }) => unknown) =>
      selector({ recipes: mockRecipes }),
    { getState: () => ({ runRecipeWithResults: vi.fn() }) }
  ),
}));

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
    { getState: () => ({ recordActionMru: recordActionMruMock }) }
  ),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => actionDispatchMock(...args) },
}));

vi.mock("@/utils/recipeNotify", () => ({ notifyRecipeSpawnFailures: vi.fn() }));

vi.mock("@/components/PanelPalette/PanelKindIcon", () => ({
  PanelKindIcon: ({ iconId }: { iconId: string }) => <span data-icon={iconId} />,
}));

import { DockLaunchMenuItems, type DockLaunchAgent } from "../DockLaunchMenuItems";

// Stand-ins for the Radix ContextMenu primitives the real consumers pass. The
// point is that this component drives them through `onSelect`, not `onClick`.
const MENU_COMPONENTS = {
  Item: ({
    children,
    onSelect,
    title,
    className,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    title?: string;
    className?: string;
  }) => (
    <button type="button" onClick={() => onSelect?.()} title={title} className={className}>
      {children}
    </button>
  ),
  Label: ({ children }: { children: ReactNode }) => <div data-testid="label">{children}</div>,
  Separator: () => <hr data-testid="separator" />,
};

const AGENTS: DockLaunchAgent[] = [
  { id: "claude", name: "Claude", availability: "ready" },
  { id: "gemini", name: "Gemini", availability: "blocked" },
];

function renderItems(props: Partial<Parameters<typeof DockLaunchMenuItems>[0]> = {}) {
  return render(
    <DockLaunchMenuItems
      components={MENU_COMPONENTS}
      agents={AGENTS}
      activeWorktreeId={null}
      cwd="/tmp"
      onLaunchAgent={vi.fn()}
      surface="dock"
      {...props}
    />
  );
}

beforeEach(() => {
  mockRecipes = [];
  mockMruEntries = [];
  actionDispatchMock.mockReset();
  recordActionMruMock.mockReset();
  addPanelMock.mockReset();
});

describe("DockLaunchMenuItems", () => {
  it("renders the banded list for a dock surface", () => {
    mockRecipes = [{ id: "r-1", name: "My recipe" }];
    const { getAllByTestId } = renderItems();

    expect(getAllByTestId("label").map((el) => el.textContent)).toEqual([
      "Launch agent",
      "Open in dock",
      "Open in grid",
      "Launch recipe",
    ]);
  });

  it("collapses to one panel heading on the grid surface, where nothing docks", () => {
    const { getAllByTestId } = renderItems({ surface: "grid" });
    expect(getAllByTestId("label").map((el) => el.textContent)).toContain("Launch panel");
  });

  it("splits agents into Pinned/Other for a strict subset", () => {
    // Two LAUNCHABLE agents: the split is counted against the launchable group,
    // so a blocked second agent would leave nothing for "Other" to hold.
    const { getAllByTestId, container } = renderItems({
      agents: [
        { id: "claude", name: "Claude", availability: "ready" },
        { id: "codex", name: "Codex", availability: "ready" },
      ],
      pinnedCount: 1,
    });

    expect(
      getAllByTestId("label")
        .map((el) => el.textContent)
        .slice(0, 2)
    ).toEqual(["Pinned", "Other"]);
    const text = container.textContent ?? "";
    expect(text.indexOf("Pinned")).toBeLessThan(text.indexOf("Claude"));
    expect(text.indexOf("Claude")).toBeLessThan(text.indexOf("Other"));
  });

  it("keeps the recency band as a duplicate shortcut above the agent group", () => {
    mockMruEntries = [{ id: "agent.claude", score: 1, lastAccessedAt: 1000 }];
    const { getAllByText, getByText } = renderItems();

    expect(getByText("Recently launched")).toBeTruthy();
    // Listed twice: once as the shortcut, once in the group it belongs to.
    expect(getAllByText("Claude")).toHaveLength(2);
  });

  it("launches an agent through onSelect and records MRU", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = renderItems({ onLaunchAgent });

    fireEvent.click(getByText("Claude"));
    expect(onLaunchAgent).toHaveBeenCalledWith("claude", undefined);
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.claude");
  });

  // Convergence (#11760): the dock and context menus must recover the same way
  // the toolbar and palette do, so a blocked agent launches into the gate here
  // too rather than being redirected on a possibly-stale probe.
  it("launches a blocked agent rather than redirecting it to settings", () => {
    const onLaunchAgent = vi.fn();
    const { getByText } = renderItems({ onLaunchAgent, source: "context-menu" });

    fireEvent.click(getByText("Gemini"));
    expect(onLaunchAgent).toHaveBeenCalledWith("gemini", undefined);
    expect(recordActionMruMock).toHaveBeenCalledWith("agent.gemini");
    expect(actionDispatchMock).not.toHaveBeenCalled();
  });

  it("routes the create-recipe cue to the manager when no worktree is active", () => {
    const { getByText } = renderItems();

    fireEvent.click(getByText("Create a recipe"));
    expect(actionDispatchMock).toHaveBeenCalledWith("recipe.manager.open", {}, { source: "menu" });
  });

  it("scopes the create-recipe cue to the active worktree when there is one", () => {
    const { getByText } = renderItems({ activeWorktreeId: "wt-1" });

    fireEvent.click(getByText("Create a recipe"));
    expect(actionDispatchMock).toHaveBeenCalledWith(
      "recipe.editor.open",
      { worktreeId: "wt-1" },
      { source: "menu" }
    );
  });

  it("creates a grid-only panel at the location its heading advertises", () => {
    const { getByText } = renderItems();

    fireEvent.click(getByText("Review"));
    expect(addPanelMock).toHaveBeenCalledWith(expect.objectContaining({ location: "grid" }));
  });
});

describe("DockLaunchMenuItems — panel origin", () => {
  const GLOBAL_KIND = "acme.dashboard.overview";
  const PROJECT_KIND = "project:proj-1/acme.notes/scratch";

  function registerKind(id: string, name: string, over: Partial<PanelKindConfig> = {}) {
    registerPanelKind({
      id,
      name,
      iconId: "package",
      color: "#fff",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      dockable: false,
      extensionId: "acme.dashboard",
      ...over,
    });
  }

  afterEach(() => {
    unregisterPanelKind(GLOBAL_KIND);
    unregisterPanelKind(PROJECT_KIND);
  });

  /** The menu item carrying a name, by the text a reader gets from it. */
  function itemNamed(container: HTMLElement, name: string): HTMLElement {
    const node = Array.from(container.querySelectorAll<HTMLElement>("button")).find((el) =>
      Array.from(el.querySelectorAll("span")).some((s) => s.textContent === name)
    );
    if (!node) throw new Error(`no menu item named ${name}`);
    return node;
  }

  it("names both plugin tiers on the item itself", () => {
    // The menu has no aria-label of its own — a menuitem's accessible name is
    // its text content, so rendering the marker is what makes it spoken.
    registerKind(GLOBAL_KIND, "Dashboard");
    registerKind(PROJECT_KIND, "Scratch", { projectId: "proj-1" });
    const { container } = renderItems();

    expect(itemNamed(container, "Dashboard").textContent).toContain("Plugin");
    expect(itemNamed(container, "Scratch").textContent).toContain("Project plugin");
  });

  it("leaves a built-in item's text as just its name", () => {
    const { container } = renderItems();

    expect(itemNamed(container, "Review").textContent).toBe("Review");
  });

  it("still launches the kind the marked row names", () => {
    registerKind(PROJECT_KIND, "Scratch", { projectId: "proj-1" });
    const { container } = renderItems();

    fireEvent.click(itemNamed(container, "Scratch"));
    expect(addPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: PROJECT_KIND, location: "grid" })
    );
  });
});
