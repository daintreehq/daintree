// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PluginSidebarHostedViewDescriptor } from "@shared/types/plugin";
import { resolveSidebarViewOptions, type SidebarViewOption } from "@/lib/sidebarViews";

interface HostedMountProps {
  source: { from: string; view: PluginSidebarHostedViewDescriptor };
  host: string;
  mountId: string;
  onRequestClose?: () => void;
  requestCloseLabel?: string;
}

const h = vi.hoisted(() => ({
  options: [] as SidebarViewOption[],
  workspace: { kind: "project", isGitBacked: true } as {
    kind: string;
    isGitBacked: boolean;
  } | null,
  waitingCount: 0,
  mounts: [] as HostedMountProps[],
}));

vi.mock("@/hooks/useSidebarViews", () => ({
  useSidebarViewOptions: () => h.options,
}));
vi.mock("@/hooks/useWorkspaceRoot", () => ({
  useWorkspaceRoot: () => h.workspace,
}));
vi.mock("@/hooks/useTerminalSelectors", () => ({
  useTerminalNotificationCounts: () => ({ waitingCount: h.waitingCount }),
}));
vi.mock("@/components/Plugin/PluginHostedView", () => ({
  // The real host loads a `plugin://` module and has its own suite; here it
  // records what the sidebar handed it.
  PluginHostedView: (props: HostedMountProps) => {
    h.mounts.push(props);
    return (
      <div data-testid="plugin-content">
        <button type="button">Plugin control</button>
      </div>
    );
  },
}));

import { SidebarViewHost } from "../SidebarViewHost";
import { SidebarViewHeading, _resetSidebarViewSwitcherForTest } from "../SidebarViewSwitcher";
import { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";

const BOARD_ID = "acme.beads.board";

function board(priority = 10): PluginSidebarHostedViewDescriptor {
  return {
    id: "plugin-view:acme.beads/board",
    pluginId: "acme.beads",
    viewId: "board",
    location: "sidebar",
    name: "Acme Beads Board",
    title: "Board",
    pluginName: "Acme Beads",
    iconId: "list",
    priority,
    componentPath: "plugin://acme.beads/__dtv-1/board.js",
  };
}

function offer(views: PluginSidebarHostedViewDescriptor[]) {
  h.options = resolveSidebarViewOptions(views, {});
}

function BuiltIn() {
  return (
    <div>
      <SidebarViewHeading className="truncate">Worktrees</SidebarViewHeading>
      <div role="grid" aria-label="Worktrees" tabIndex={0} />
    </div>
  );
}

const ui = () => (
  <SidebarViewHost>
    <BuiltIn />
  </SidebarViewHost>
);

async function openSwitcher() {
  const trigger = screen.getByTestId("sidebar-view-switcher");
  act(() => {
    trigger.focus();
  });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findAllByRole("menuitemradio");
}

beforeEach(() => {
  h.options = resolveSidebarViewOptions(null, {});
  h.workspace = { kind: "project", isGitBacked: true };
  h.waitingCount = 0;
  h.mounts = [];
  useSidebarViewStore.setState({
    chosenSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
    activeSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
  });
});

afterEach(() => {
  cleanup();
  _resetSidebarViewSwitcherForTest();
});

describe("SidebarViewHost", () => {
  it("keeps the plain heading when no plugin sidebar view is on offer", () => {
    render(ui());
    const heading = screen.getByRole("heading", { name: "Worktrees" });
    expect(heading.tagName).toBe("H2");
    expect(heading.querySelector("button")).toBeNull();
    expect(screen.queryByTestId("sidebar-view-switcher")).toBeNull();
    expect(screen.getByTestId("sidebar-builtin-view").hasAttribute("inert")).toBe(false);
  });

  it("turns the heading into a switcher listing every view by priority, each plugin entry attributed", async () => {
    offer([board(10)]);
    render(ui());
    const items = await openSwitcher();
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
      "Board, from Acme Beads",
      "Worktrees",
    ]);
    expect(items[1]?.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the count of waiting agents on the worktree entry", async () => {
    offer([board()]);
    h.waitingCount = 2;
    render(ui());
    const items = await openSwitcher();
    const worktrees = items.find(
      (item) => item.dataset.testid === `sidebar-view-option-${WORKTREES_SIDEBAR_VIEW_ID}`
    );
    expect(worktrees?.getAttribute("aria-label")).toBe("Worktrees, 2 agents are waiting");
    expect(worktrees?.textContent).toContain("2 waiting");
  });

  it("shows a chosen plugin view in the sidebar host, hiding the worktree list from focus", async () => {
    offer([board()]);
    render(ui());
    const items = await openSwitcher();
    fireEvent.click(items[0]!);

    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(BOARD_ID);
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(BOARD_ID);
    const builtIn = screen.getByTestId("sidebar-builtin-view");
    expect(builtIn.hasAttribute("inert")).toBe(true);
    // Hidden without giving up its box, so the list underneath keeps its measurements.
    expect(builtIn.className).toContain("invisible");
    expect(builtIn.style.display).not.toBe("none");

    const mount = h.mounts.at(-1);
    expect(mount?.host).toBe("sidebar");
    expect(mount?.source.view.viewId).toBe("board");
    expect(mount?.requestCloseLabel).toBe("Show worktrees");
    // The header holds the switcher alone, titled with the plugin view's name.
    expect(screen.getByTestId("sidebar-view-switcher").textContent).toBe("Board");
  });

  it("falls back to the worktree list while the chosen view is withdrawn, and keeps the choice", () => {
    offer([board()]);
    useSidebarViewStore.setState({ chosenSidebarView: BOARD_ID });
    const { rerender } = render(ui());
    expect(screen.queryByTestId("sidebar-plugin-view")).not.toBeNull();

    offer([]);
    rerender(ui());
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull();
    expect(screen.getByTestId("sidebar-builtin-view").hasAttribute("inert")).toBe(false);
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(BOARD_ID);

    offer([board()]);
    rerender(ui());
    expect(screen.queryByTestId("sidebar-plugin-view")).not.toBeNull();
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(BOARD_ID);
  });

  it("returns to the worktree list from a failed view's recovery button", () => {
    offer([board()]);
    useSidebarViewStore.setState({ chosenSidebarView: BOARD_ID });
    render(ui());
    act(() => {
      h.mounts.at(-1)?.onRequestClose?.();
    });
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull();
  });

  it("names the built-in view after the workspace in a folder without git", async () => {
    offer([board()]);
    h.workspace = { kind: "project", isGitBacked: false };
    useSidebarViewStore.setState({ chosenSidebarView: BOARD_ID });
    render(ui());
    expect(h.mounts.at(-1)?.requestCloseLabel).toBe("Show workspace");
    const items = await openSwitcher();
    expect(items.map((item) => item.getAttribute("aria-label"))).toContain("Workspace");
  });

  it("keeps a right-click inside a plugin view from reaching the sidebar's own menu", () => {
    offer([board()]);
    useSidebarViewStore.setState({ chosenSidebarView: BOARD_ID });
    const backgroundMenu = vi.fn();
    render(<div onContextMenu={backgroundMenu}>{ui()}</div>);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Plugin control" }));
    expect(backgroundMenu).not.toHaveBeenCalled();
  });

  it("keeps focus in the sidebar when the plugin view holding it is withdrawn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const docs: PluginSidebarHostedViewDescriptor = {
        ...board(),
        id: "plugin-view:acme.beads/docs",
        viewId: "docs",
        title: "Docs",
      };
      offer([board(), docs]);
      useSidebarViewStore.setState({ chosenSidebarView: BOARD_ID });
      const { rerender } = render(ui());
      act(() => screen.getByRole("button", { name: "Plugin control" }).focus());

      // Board's plugin hides it here; Docs still applies, so the worktree list
      // comes back with its switcher.
      offer([docs]);
      rerender(ui());
      await act(async () => {
        vi.runAllTimers();
      });
      const trigger = screen.getByTestId("sidebar-view-switcher");
      expect(trigger.closest("[data-testid='sidebar-builtin-view']")).not.toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves no focus when the remembered view arrives on its own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      useSidebarViewStore.setState({ chosenSidebarView: BOARD_ID });
      const { rerender } = render(ui());
      offer([board()]);
      rerender(ui());
      await act(async () => {
        vi.runAllTimers();
      });
      expect(screen.queryByTestId("sidebar-plugin-view")).not.toBeNull();
      expect(document.activeElement).toBe(document.body);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands focus to the plugin view's switcher when a keyboard pick leaves the worktree list", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      offer([board()]);
      render(ui());
      const items = await vi.waitFor(() => {
        const trigger = screen.getByTestId("sidebar-view-switcher");
        act(() => trigger.focus());
        fireEvent.keyDown(trigger, { key: "Enter" });
        const radios = screen.getAllByRole("menuitemradio");
        if (radios.length === 0) throw new Error("menu not open");
        return radios;
      });
      act(() => {
        items[0]!.focus();
      });
      fireEvent.keyDown(items[0]!, { key: "Enter" });
      await act(async () => {
        vi.runAllTimers();
      });
      const trigger = screen.getByTestId("sidebar-view-switcher");
      expect(trigger.closest("[data-testid='sidebar-plugin-view']")).not.toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      vi.useRealTimers();
    }
  });
});
