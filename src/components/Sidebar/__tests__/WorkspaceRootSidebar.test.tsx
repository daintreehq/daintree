// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NO_WORKTREE } from "@/store/slices/panelRegistry/worktreeIndex";
import type { AgentState } from "@/types";
import type { WorkspaceRoot } from "@/hooks/useWorkspaceRoot";

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

// Radix keeps the row's context menu closed, so its items never reach the DOM
// and an "absent, not disabled" assertion over the real menu would pass
// vacuously. Rendering the content inline is what makes that contract testable.
// Partial, for the same reason as Sidebar.contextMenu.test.tsx: this module's
// components render each other, so a full replacement throws on whichever
// export the graph reaches that the factory didn't list.
vi.mock("@/components/ui/context-menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/context-menu")>()),
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="row-context-menu">{children}</div>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuActionItem: ({
    actionId,
    children,
  }: {
    actionId: string;
    args?: unknown;
    children: ReactNode;
  }) => (
    <div role="menuitem" data-action-id={actionId}>
      {children}
    </div>
  ),
}));

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

    expect(dispatch).toHaveBeenCalledWith("worktree.openFileBrowser", undefined, {
      source: "user",
    });
  });

  it("carries only the row actions a worktree-less workspace can honour", () => {
    // Absent, not disabled. A row that looks like a worktree row with half its
    // menu inert is a bigger lie than the dead toggle this replaces. Asserted as
    // an exact set so a git-shaped action can't be added back unnoticed.
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);

    const actionIds = screen
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("data-action-id"));

    expect(actionIds).toEqual(["worktree.openFileBrowser", "system.openPath"]);
  });

  it("exposes no worktree-shaped control outside the menu either", () => {
    render(<WorkspaceRootSidebar workspace={SCRATCH} />);

    for (const forbidden of [/review/i, /commit/i, /diff/i, /branch/i, /arm/i, /refresh/i]) {
      expect(screen.queryAllByRole("button", { name: forbidden })).toHaveLength(0);
      expect(screen.queryAllByRole("menuitem", { name: forbidden })).toHaveLength(0);
    }
  });
});
