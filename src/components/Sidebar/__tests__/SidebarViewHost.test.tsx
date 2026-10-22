// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import {
  makeProjectPluginInstanceKey,
  type PluginSidebarHostedViewDescriptor,
} from "@shared/types/plugin";
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
import { useBuiltInSidebarViewHidden } from "../sidebarViewContext";
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

function BuiltIn({ popover = false }: { popover?: boolean }) {
  const hidden = useBuiltInSidebarViewHidden();
  return (
    <div>
      <SidebarViewHeading className="truncate">Worktrees</SidebarViewHeading>
      <div role="grid" aria-label="Worktrees" tabIndex={0} data-hidden={String(hidden)} />
      {/* A popover the list owns, portalled out of the layer like the filter popover. */}
      {popover &&
        createPortal(
          <button type="button" data-testid="list-popover-field">
            Filter
          </button>,
          document.body
        )}
    </div>
  );
}

const ui = ({ popover = false }: { popover?: boolean } = {}) => (
  <SidebarViewHost>
    <BuiltIn popover={popover} />
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
    defaultAnswers: {},
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
    // Still mounted under the plugin view, and told so: its drop targets and
    // announcements stand down while it keeps its state.
    expect(screen.getByRole("grid", { name: "Worktrees", hidden: true }).dataset.hidden).toBe(
      "true"
    );

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
      const tree = () => (
        <>
          <button type="button">Terminal</button>
          {ui()}
        </>
      );
      const { rerender } = render(tree());
      const elsewhere = screen.getByRole("button", { name: "Terminal" });
      act(() => elsewhere.focus());
      offer([board()]);
      rerender(tree());
      await act(async () => {
        vi.runAllTimers();
      });
      expect(screen.queryByTestId("sidebar-plugin-view")).not.toBeNull();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps focus in the sidebar when an action swaps the plugin view that held it", async () => {
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
      render(ui());
      act(() => screen.getByRole("button", { name: "Plugin control" }).focus());
      act(() => useSidebarViewStore.getState().chooseSidebarView("acme.beads.docs"));
      await act(async () => {
        vi.runAllTimers();
      });
      const trigger = screen.getByTestId("sidebar-view-switcher");
      expect(trigger.textContent).toBe("Docs");
      expect(document.activeElement).toBe(trigger);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an owed hand-off across a second change made before it settled", async () => {
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
      render(ui());
      act(() => screen.getByRole("button", { name: "Plugin control" }).focus());
      act(() => useSidebarViewStore.getState().chooseSidebarView(WORKTREES_SIDEBAR_VIEW_ID));
      act(() => useSidebarViewStore.getState().chooseSidebarView("acme.beads.docs"));
      await act(async () => {
        vi.runAllTimers();
      });
      const trigger = screen.getByTestId("sidebar-view-switcher");
      expect(trigger.textContent).toBe("Docs");
      expect(document.activeElement).toBe(trigger);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a popover the worktree list owns to finish retiring before taking focus", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      offer([board()]);
      const { rerender } = render(ui({ popover: true }));
      const field = screen.getByTestId("list-popover-field");
      act(() => field.focus());
      act(() => useSidebarViewStore.getState().chooseSidebarView(BOARD_ID));
      // Still animating out: focus has somewhere to be, so nothing moves.
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(document.activeElement).toBe(field);
      // Gone at last, focus falls to the document — the switcher takes it.
      rerender(ui());
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(document.activeElement).toBe(screen.getByTestId("sidebar-view-switcher"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a right-click on the plugin view's header from reaching the sidebar's own menu", () => {
    offer([board()]);
    useSidebarViewStore.setState({ chosenSidebarView: BOARD_ID });
    const backgroundMenu = vi.fn();
    render(<div onContextMenu={backgroundMenu}>{ui()}</div>);
    fireEvent.contextMenu(screen.getByTestId("sidebar-view-switcher"));
    expect(backgroundMenu).not.toHaveBeenCalled();
  });

  it("stops publishing a plugin view once the sidebar is gone, keeping the choice", () => {
    offer([board()]);
    useSidebarViewStore.setState({ chosenSidebarView: BOARD_ID });
    const { unmount } = render(ui());
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(BOARD_ID);
    unmount();
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(BOARD_ID);
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
      // A press inside the menu first, then the keyboard pick: the pick still
      // counts as the keyboard's, so the hand-off rings the new trigger.
      fireEvent.pointerDown(screen.getByRole("menu"));
      const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
      fireEvent.keyDown(items[0]!, { key: "Enter" });
      await act(async () => {
        vi.runAllTimers();
      });
      const trigger = screen.getByTestId("sidebar-view-switcher");
      expect(trigger.closest("[data-testid='sidebar-plugin-view']")).not.toBeNull();
      expect(document.activeElement).toBe(trigger);
      const handOff = focusSpy.mock.contexts.lastIndexOf(trigger);
      expect(focusSpy.mock.calls[handOff]?.[0]).toMatchObject({ focusVisible: true });
      focusSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SidebarViewHost default view", () => {
  const PROJECT_BOARD_ID = "project:acme.beads.board";
  const projectBoard = (priority = 10): PluginSidebarHostedViewDescriptor => ({
    ...board(priority),
    pluginId: makeProjectPluginInstanceKey("p1", "acme.beads"),
  });

  beforeEach(() => {
    useSidebarViewStore.setState({ chosenSidebarView: null });
  });

  it("opens on a project plugin's view that outranks worktrees, and asks once", () => {
    offer([projectBoard()]);
    render(ui());
    expect(screen.queryByTestId("sidebar-plugin-view")).not.toBeNull();
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(PROJECT_BOARD_ID);
    expect(useSidebarViewStore.getState().chosenSidebarView).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Acme Beads set up this project");
  });

  it("keeps the view and stops asking when the user answers Keep", () => {
    offer([projectBoard()]);
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("sidebar-plugin-view")).not.toBeNull();
    expect(useSidebarViewStore.getState().defaultAnswers).toEqual({ [PROJECT_BOARD_ID]: "keep" });
    expect(useSidebarViewStore.getState().chosenSidebarView).toBeNull();
  });

  it("shows worktrees as the user's own pick when they answer Show worktrees", () => {
    offer([projectBoard()]);
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Show worktrees" }));
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull();
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
    expect(useSidebarViewStore.getState().defaultAnswers[PROJECT_BOARD_ID]).toBe("worktrees");
  });

  it("does not ask again about a view already answered", () => {
    useSidebarViewStore.setState({ defaultAnswers: { [PROJECT_BOARD_ID]: "keep" } });
    offer([projectBoard()]);
    render(ui());
    expect(screen.queryByTestId("sidebar-plugin-view")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("only offers an installed plugin's view: worktrees stay until the user picks it", async () => {
    offer([board(100)]);
    render(ui());
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    const items = await openSwitcher();
    fireEvent.click(items.find((item) => item.textContent?.includes("Board"))!);
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(BOARD_ID);
    expect(screen.queryByTestId("sidebar-plugin-view")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("never asks when the user's own pick is what shows", () => {
    useSidebarViewStore.setState({ chosenSidebarView: PROJECT_BOARD_ID });
    offer([projectBoard()]);
    render(ui());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("falls back to worktrees at once when the project plugin's view is withdrawn", () => {
    offer([projectBoard()]);
    const { rerender } = render(ui());
    offer([]);
    rerender(ui());
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull();
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
    expect(useSidebarViewStore.getState().chosenSidebarView).toBeNull();
  });
});
