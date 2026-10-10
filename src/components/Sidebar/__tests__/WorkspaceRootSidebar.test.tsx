// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, act } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NO_WORKTREE } from "@/store/slices/panelRegistry/worktreeIndex";
import type { AgentState } from "@/types";
import type { WorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { fileManagerRevealLabel } from "@/lib/platform";

// The row's name, path and session pips are all tooltip triggers, and Radix
// throws outright without a provider in scope. AppLayout supplies one in the
// real tree.
const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

const openGitInitDialog = vi.fn<(path: string, opts: { step: string }) => void>();
const dispatch = vi.fn<(id: string, args?: unknown, opts?: unknown) => void>();

interface Counts {
  total: number;
  byState: Record<AgentState, number>;
}
let counts: Counts = {
  total: 0,
  byState: { working: 0, waiting: 0, directing: 0, idle: 0, completed: 0, exited: 0 },
};
const useWorktreeTerminals = vi.fn<(id: string) => { counts: Counts }>(() => ({ counts }));

vi.mock("@/hooks/useWorktreeTerminals", () => ({
  useWorktreeTerminals: (id: string) => useWorktreeTerminals(id),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ openGitInitDialog }) },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (id: string, args?: unknown, opts?: unknown) => dispatch(id, args, opts),
  },
}));

const handleCopyTree = vi.fn<(worktree: unknown) => Promise<void>>(() => Promise.resolve());
const copyWithToast = vi.fn<(label: string, value: string) => void>();
const notifyRecipeSpawnFailures = vi.fn();
const runRecipeWithResults = vi.fn<
  (id: string, path: string, worktreeId?: string, context?: unknown) => Promise<unknown>
>(() => Promise.resolve({ spawned: [], failed: [] }));
let recipes: Array<{ id: string; name: string; worktreeId?: string }> = [];

vi.mock("@/hooks/useWorktreeActions", () => ({
  useWorktreeActions: () => ({ handleCopyTree }),
}));
vi.mock("@/lib/copyWithToast", () => ({
  copyWithToast: (label: string, value: string) => copyWithToast(label, value),
}));
vi.mock("@/utils/recipeNotify", () => ({
  notifyRecipeSpawnFailures: (...args: unknown[]) => notifyRecipeSpawnFailures(...args),
}));
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { agents: { claude: { pinned: true } } } }),
}));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: unknown) => unknown) =>
    selector({ availability: { claude: "ready" } }),
}));
vi.mock("@/store/recipeStore", () => {
  const state = () => ({
    recipes,
    runRecipeWithResults,
    currentProjectId: null,
    getRecipeById: (id: string) => recipes.find((r) => r.id === id),
  });
  const useRecipeStore = (selector: (s: unknown) => unknown) => selector(state());
  useRecipeStore.getState = state;
  return { useRecipeStore };
});

// Radix keeps the row's context menu closed, so its items never reach the DOM
// and an "absent, not disabled" assertion over the real menu would pass
// vacuously. Rendering the content inline is what makes that contract testable.
// Partial, for the same reason as Sidebar.contextMenu.test.tsx: this module's
// components render each other, so a full replacement throws on whichever
// export the graph reaches that the factory didn't list.
vi.mock("@/components/ui/context-menu", async (importOriginal) => {
  const Item = ({
    children,
    onSelect,
    disabled,
  }: {
    children?: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <div role="menuitem" aria-disabled={disabled} onClick={disabled ? undefined : onSelect}>
      {children}
    </div>
  );
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    ...(await importOriginal<typeof import("@/components/ui/context-menu")>()),
    ContextMenu: Pass,
    ContextMenuTrigger: Pass,
    ContextMenuContent: ({ children }: { children: ReactNode }) => (
      <div data-testid="row-context-menu">{children}</div>
    ),
    ContextMenuItem: Item,
    ContextMenuLabel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ContextMenuSeparator: () => <hr />,
    ContextMenuShortcut: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ContextMenuMeta: ({ children }: { children?: ReactNode }) => (
      <span aria-hidden="true">{children}</span>
    ),
    ContextMenuSub: ({ children }: { children?: ReactNode }) => (
      <div data-testid="menu-sub">{children}</div>
    ),
    ContextMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
      <div role="menuitem" data-sub-trigger="">
        {children}
      </div>
    ),
    ContextMenuSubContent: Pass,
    ContextMenuRadioGroup: Pass,
    ContextMenuRadioItem: Item,
  };
});

/** The right-click menu's root rows — submenu triggers and flat items, in order. */
function contextMenuRootRows(): string[] {
  const menu = screen.getByTestId("row-context-menu");
  return Array.from(
    menu.querySelectorAll(
      ":scope > [role='menuitem'], :scope > [data-testid='menu-sub'] > [data-sub-trigger]"
    )
  ).map((el) => el.textContent?.trim() ?? "");
}

function dispatchedIds(): string[] {
  return dispatch.mock.calls.map(([id]) => id);
}

function clickMenuItem(name: string) {
  const menu = screen.getByTestId("row-context-menu");
  const item = Array.from(menu.querySelectorAll("[role='menuitem']")).find(
    (el) => el.textContent?.trim() === name
  );
  if (!item) throw new Error(`no menu item "${name}"`);
  fireEvent.click(item);
}

const { WorkspaceRootSidebar } = await import("../WorkspaceRootSidebar");

const SCRATCH: WorkspaceRoot = {
  kind: "scratch",
  id: "scratch-1",
  path: "/home/me/.daintree/scratches/scratch-1",
  name: "Quick test",
  isGitBacked: false,
};

const PLAIN_FOLDER: WorkspaceRoot = {
  kind: "project",
  id: "proj-1",
  path: "/home/me/notes",
  name: "Notes",
  isGitBacked: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  counts = {
    total: 0,
    byState: { working: 0, waiting: 0, directing: 0, idle: 0, completed: 0, exited: 0 },
  };
  useWorktreeTerminals.mockImplementation(() => ({ counts }));
  recipes = [];
});

describe("WorkspaceRootSidebar", () => {
  it("gives a scratch a row, so the toggle that opened the sidebar did something", () => {
    const { container } = render(<WorkspaceRootSidebar workspace={SCRATCH} />);

    expect(container.querySelectorAll("[data-workspace-root-row]")).toHaveLength(1);
    expect(screen.getByText("Quick test")).toBeTruthy();
  });

  it("claims no grid semantics it cannot honour", () => {
    // The worktree list is a real grid — single tab stop, aria-activedescendant,
    // arrow-key navigation over its rows. This row has no selection and nothing
    // to navigate, so grid/row/gridcell roles would announce a keyboard widget
    // that isn't there: the same shape of lie as the toggle this fixes.
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);

    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
    expect(screen.queryAllByRole("gridcell")).toHaveLength(0);
  });

  it("does not call the slot Worktrees for a workspace that has none", () => {
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);

    expect(screen.queryByText("Worktrees")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Workspace");
  });

  it("names the kind so nobody arrives expecting worktree parity", () => {
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);
    expect(screen.getByText("Scratch")).toBeTruthy();
  });

  it("distinguishes a plain folder from a scratch", () => {
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} />);
    expect(screen.getByText("Folder")).toBeTruthy();
    expect(screen.queryByText("Scratch")).toBeNull();
  });

  it("tildifies the path when the home dir is known", () => {
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} homeDir="/home/me" />);
    expect(screen.getByText("~/notes")).toBeTruthy();
  });

  it("leaves the path absolute when the home dir has not resolved yet", () => {
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} />);
    expect(screen.getByText("/home/me/notes")).toBeTruthy();
  });

  it("reads live agent state from the bucket worktree-less panels actually land in", () => {
    // Panels launched without a worktree are indexed under NO_WORKTREE, not
    // under the workspace's own id. Keying the row on the workspace id would
    // render a permanently-empty row beside live agents.
    counts = {
      total: 3,
      byState: { working: 2, waiting: 1, directing: 0, idle: 0, completed: 0, exited: 0 },
    };
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);

    expect(useWorktreeTerminals).toHaveBeenCalledWith(NO_WORKTREE);
    // The regression this guards: keying the row on the workspace's own id
    // renders a permanently-empty row beside live agents.
    expect(useWorktreeTerminals).not.toHaveBeenCalledWith(SCRATCH.id);
    expect(screen.getByRole("img", { name: /3 sessions/ })).toBeTruthy();
  });

  it("shows no session indicators when nothing is running", () => {
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);
    expect(screen.queryByTestId("collapsed-session-indicators")).toBeNull();
  });

  it("offers the initialize upgrade to a plain folder", () => {
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} />);

    const button = screen.getByRole("button", { name: "Initialize repository" });
    button.click();

    expect(openGitInitDialog).toHaveBeenCalledWith("/home/me/notes", { step: "initialize" });
  });

  it("never offers to initialize a scratch, which is app-managed and disposable", () => {
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);
    expect(screen.queryByRole("button", { name: "Initialize repository" })).toBeNull();
  });

  it("keeps Browse files reachable — the file browser stays a grid panel", () => {
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);

    screen.getByRole("button", { name: "Browse files" }).click();

    expect(dispatch).toHaveBeenCalledWith("worktree.openFileBrowserPanel", undefined, {
      source: "user",
    });
  });

  it("carries only the menu groups a worktree-less workspace can honour", () => {
    // Absent, not disabled. A row that looks like a worktree row with half its
    // menu inert is a bigger lie than the dead toggle this replaces. Asserted as
    // an exact list so a git-shaped group can't be added back unnoticed.
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);
    expect(contextMenuRootRows()).toEqual(["Launch", "Open", "Copy"]);
  });

  it("puts the more-actions button last in the row, after Browse files", () => {
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} />);

    const browse = screen.getByRole("button", { name: "Browse files" });
    const more = screen.getByRole("button", { name: "More actions" });
    expect(browse.parentElement).toBe(more.parentElement);
    expect(more.parentElement?.lastElementChild).toBe(more);
  });

  it("copies the workspace root, not a worktree", () => {
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} />);

    clickMenuItem("Full context");
    clickMenuItem("Path");

    expect(handleCopyTree).toHaveBeenCalledWith(null);
    expect(copyWithToast).toHaveBeenCalledWith("Path", "/home/me/notes");
  });

  it("opens and reveals the workspace path itself", () => {
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} />);

    clickMenuItem("Open in editor");
    clickMenuItem(fileManagerRevealLabel());

    expect(dispatch).toHaveBeenCalledWith(
      "file.openInEditor",
      { path: "/home/me/notes" },
      { source: "user" }
    );
    expect(dispatch).toHaveBeenCalledWith(
      "system.openPath",
      { path: "/home/me/notes" },
      { source: "user" }
    );
    // `worktree.openEditor` resolves a worktree id and returns without one.
    expect(dispatchedIds()).not.toContain("worktree.openEditor");
  });

  it("launches at the workspace root with no worktree id", () => {
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);

    clickMenuItem("Terminal");

    expect(dispatch).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "terminal", location: "grid", cwd: SCRATCH.path },
      { source: "user" }
    );
  });

  it("runs a project-wide recipe at the workspace root", async () => {
    recipes = [
      { id: "r1", name: "Two agents" },
      { id: "r2", name: "Elsewhere", worktreeId: "wt-9" },
    ];
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} />);

    expect(contextMenuRootRows()).toEqual(["Launch", "Open", "Recipes", "Copy"]);
    expect(screen.queryByText("Elsewhere")).toBeNull();

    await act(async () => {
      clickMenuItem("Two agents");
    });

    expect(runRecipeWithResults).toHaveBeenCalledWith("r1", "/home/me/notes", undefined, {
      worktreePath: "/home/me/notes",
    });
    expect(notifyRecipeSpawnFailures).toHaveBeenCalledWith(
      { spawned: [], failed: [] },
      expect.objectContaining({ recipeName: "Two agents" })
    );
  });

  it("runs a recipe once per press, and again after a failed run settles", async () => {
    recipes = [{ id: "r1", name: "Two agents" }];
    let reject!: (error: Error) => void;
    runRecipeWithResults.mockImplementationOnce(() => new Promise((_, rej) => (reject = rej)));
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} />);

    // Both presses land before the running state commits — only the ref stops
    // the second.
    act(() => {
      clickMenuItem("Two agents");
      clickMenuItem("Two agents");
    });
    expect(runRecipeWithResults).toHaveBeenCalledTimes(1);

    await act(async () => {
      reject(new Error("spawn exploded"));
    });

    await act(async () => {
      clickMenuItem("Two agents");
    });
    expect(runRecipeWithResults).toHaveBeenCalledTimes(2);
  });

  it("opens the same menu from the more-actions button", () => {
    render(<WorkspaceRootSidebar workspace={PLAIN_FOLDER} />);

    const trigger = screen.getByRole("button", { name: "More actions" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    const dropdown = screen.getByRole("menu");
    const rows = Array.from(dropdown.querySelectorAll("[role='menuitem']")).map(
      (el) => el.textContent?.trim() ?? ""
    );
    expect(rows).toEqual(["Launch", "Open", "Copy"]);
  });

  it("exposes no worktree-shaped control outside the menu either", () => {
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);

    // Word-bounded: Launch's "Dev preview" is not a review action.
    for (const forbidden of [/\breview/i, /commit/i, /diff/i, /branch/i, /\barm/i, /refresh/i]) {
      expect(screen.queryAllByRole("button", { name: forbidden })).toHaveLength(0);
      expect(screen.queryAllByRole("menuitem", { name: forbidden })).toHaveLength(0);
    }
  });
});
