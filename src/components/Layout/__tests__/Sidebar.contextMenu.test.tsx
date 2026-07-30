// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import type { Project } from "@shared/types";
import type { WorkspaceRoot } from "@/hooks/useWorkspaceRoot";

/**
 * Mounting the sidebar in every workspace kind (#11499) exposed its background
 * context menu to workspaces that have no worktrees. The entries that only make
 * sense against git have to be absent there, not disabled — a greyed-out "New
 * Worktree…" in a scratch is the same dead-control lie in a quieter font.
 */

const workspaceRoot = vi.fn<() => WorkspaceRoot | null>(() => null);
let currentProject: Project | null = null;

vi.mock("@/hooks/useWorkspaceRoot", () => ({ useWorkspaceRoot: () => workspaceRoot() }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: Project | null }) => unknown) =>
    selector({ currentProject }),
}));
vi.mock("@/store/macroFocusStore", () => ({
  useMacroFocusStore: Object.assign(() => false, {
    getState: () => ({ setRegionRef: () => {} }),
  }),
}));
vi.mock("@/components/Project", () => ({
  ProjectResourceBadge: () => null,
  QuickRun: () => null,
}));

// Records the actionId of every menu entry that actually renders, so a test can
// assert on absence rather than on a disabled attribute. Partial (spreading
// `importOriginal`) rather than a full replacement: `ContextMenuActionItem`
// renders `ContextMenuItem` from this same module, so a factory listing only
// the components Sidebar names directly makes vitest throw on the exports
// reached through the module's own graph.
vi.mock("@/components/ui/context-menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/context-menu")>()),
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuSeparator: () => <hr data-testid="menu-separator" />,
  ContextMenuActionItem: ({
    actionId,
    args,
    children,
  }: {
    actionId: string;
    args?: unknown;
    children: ReactNode;
  }) => (
    <div role="menuitem" data-action-id={actionId} data-args={JSON.stringify(args ?? null)}>
      {children}
    </div>
  ),
}));

const { Sidebar } = await import("../Sidebar");

const GIT_PROJECT: WorkspaceRoot = {
  kind: "project",
  id: "proj-1",
  path: "/repos/daintree",
  name: "Daintree",
  isGitBacked: true,
};
const SCRATCH: WorkspaceRoot = {
  kind: "scratch",
  id: "scratch-1",
  path: "/scratches/scratch-1",
  name: "Quick test",
  isGitBacked: false,
};
const PLAIN_FOLDER: WorkspaceRoot = {
  kind: "project",
  id: "proj-2",
  path: "/home/me/notes",
  name: "Notes",
  isGitBacked: false,
};

function renderSidebar() {
  return render(<Sidebar width={280} onResize={() => {}} />);
}

function renderedActionIds(): string[] {
  return screen
    .getAllByRole("menuitem")
    .map((el) => el.getAttribute("data-action-id") ?? "")
    .filter(Boolean);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentProject = null;
  workspaceRoot.mockReturnValue(null);
});

describe("Sidebar background context menu — workspace kind (#11499)", () => {
  it("keeps every worktree entry for a git-backed project", () => {
    currentProject = {
      id: GIT_PROJECT.id,
      path: GIT_PROJECT.path,
      name: GIT_PROJECT.name,
      emoji: "🌳",
      lastOpened: 0,
    };
    workspaceRoot.mockReturnValue(GIT_PROJECT);

    renderSidebar();

    // The positive half matters: without it, hiding the whole menu would
    // satisfy the absence assertions below.
    expect(renderedActionIds()).toEqual([
      "worktree.createDialog.open",
      "worktree.refresh",
      "system.openPath",
      "project.settings.open",
      "ui.sidebar.resetWidth",
      "app.settings.openTab",
    ]);
  });

  it("drops every worktree entry in a scratch", () => {
    workspaceRoot.mockReturnValue(SCRATCH);

    renderSidebar();
    const ids = renderedActionIds();

    expect(ids).not.toContain("worktree.createDialog.open");
    expect(ids).not.toContain("worktree.refresh");
    expect(ids).not.toContain("app.settings.openTab");
    // A scratch has no project row, so project settings would open nothing.
    expect(ids).not.toContain("project.settings.open");
  });

  it("leaves the workspace-level entries reachable in a scratch", () => {
    workspaceRoot.mockReturnValue(SCRATCH);

    renderSidebar();
    const ids = renderedActionIds();

    expect(ids).toContain("system.openPath");
    expect(ids).toContain("ui.sidebar.resetWidth");
  });

  it("reveals the scratch's own folder, which currentProject could not supply", () => {
    workspaceRoot.mockReturnValue(SCRATCH);

    renderSidebar();

    const reveal = screen
      .getAllByRole("menuitem")
      .find((el) => el.getAttribute("data-action-id") === "system.openPath");
    expect(reveal?.getAttribute("data-args")).toBe(JSON.stringify({ path: SCRATCH.path }));
    expect(reveal?.textContent).toContain("Reveal Workspace in Finder");
  });

  it("keeps project settings for a folder opened without git, but not its worktree entries", () => {
    currentProject = {
      id: PLAIN_FOLDER.id,
      path: PLAIN_FOLDER.path,
      name: PLAIN_FOLDER.name,
      emoji: "📁",
      lastOpened: 0,
    };
    workspaceRoot.mockReturnValue(PLAIN_FOLDER);

    renderSidebar();
    const ids = renderedActionIds();

    // A plain folder is still a project — it has real settings and a name.
    expect(ids).toContain("project.settings.open");
    expect(ids).not.toContain("worktree.createDialog.open");
    expect(ids).not.toContain("app.settings.openTab");
  });

  it("renders no leading, doubled or trailing separator in any workspace kind", () => {
    for (const root of [GIT_PROJECT, SCRATCH]) {
      currentProject =
        root.kind === "project"
          ? { id: root.id, path: root.path, name: root.name, emoji: "🌳", lastOpened: 0 }
          : null;
      workspaceRoot.mockReturnValue(root);

      const { unmount } = renderSidebar();
      const content = screen.getByTestId("context-menu-content");
      const children = Array.from(content.children);
      const isSeparator = (el: Element) => el.getAttribute("data-testid") === "menu-separator";

      expect(isSeparator(children[0]!)).toBe(false);
      expect(isSeparator(children[children.length - 1]!)).toBe(false);
      expect(
        children.some((el, i) => i > 0 && isSeparator(el) && isSeparator(children[i - 1]!))
      ).toBe(false);
      unmount();
    }
  });
});
