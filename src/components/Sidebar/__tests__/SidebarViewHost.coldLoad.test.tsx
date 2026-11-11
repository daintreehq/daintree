// @vitest-environment jsdom
// Its own file so its module cache starts cold: the hosted-view chunk loads on
// the first plugin view the sidebar shows here and no sooner (#16802).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PluginSidebarHostedViewDescriptor } from "@shared/types/plugin";
import { resolveSidebarViewOptions, type SidebarViewOption } from "@/lib/sidebarViews";

const h = vi.hoisted(() => {
  let release: () => void = () => {};
  const chunk = new Promise<void>((resolve) => (release = resolve));
  return {
    chunk,
    release: () => release(),
    imported: vi.fn(),
    options: [] as SidebarViewOption[],
  };
});

vi.mock("@/hooks/useSidebarViews", () => ({
  useSidebarViewOptions: () => h.options,
}));
vi.mock("@/hooks/useWorkspaceRoot", () => ({
  useWorkspaceRoot: () => ({ kind: "project", isGitBacked: true }),
}));
vi.mock("@/hooks/useTerminalSelectors", () => ({
  useTerminalNotificationCounts: () => ({ waitingCount: 0 }),
}));
// Held back until the test lets the chunk land.
vi.mock("@/components/Plugin/PluginHostedView", async () => {
  h.imported();
  await h.chunk;
  return {
    PluginHostedView: () => (
      <div data-testid="plugin-content">
        <button type="button">Plugin control</button>
      </div>
    ),
  };
});

import { SidebarViewHost } from "../SidebarViewHost";
import { SidebarViewHeading, _resetSidebarViewSwitcherForTest } from "../SidebarViewSwitcher";
import { preloadPluginHostedView } from "@/components/Plugin/LazyPluginHostedView";
import { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";

const BOARD_ID = "acme.beads.board";

const board: PluginSidebarHostedViewDescriptor = {
  id: "plugin-view:acme.beads/board",
  pluginId: "acme.beads",
  viewId: "board",
  location: "sidebar",
  name: "Acme Beads Board",
  title: "Board",
  pluginName: "Acme Beads",
  iconId: "list",
  priority: 10,
  componentPath: "plugin://acme.beads/__dtv-1/board.js",
};

const ui = () => (
  <SidebarViewHost>
    <SidebarViewHeading className="truncate">Worktrees</SidebarViewHeading>
    <div role="grid" aria-label="Worktrees" tabIndex={0} />
  </SidebarViewHost>
);

async function pick(name: RegExp) {
  const trigger = screen.getByTestId("sidebar-view-switcher");
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: "Enter" });
  const item = await screen.findByRole("menuitemradio", { name });
  fireEvent.keyDown(item, { key: "Enter" });
}

afterEach(() => {
  cleanup();
  _resetSidebarViewSwitcherForTest();
});

describe("SidebarViewHost, first plugin view (#16802)", () => {
  it("keeps the header, switcher and focus hand-off working while the view's chunk loads", async () => {
    h.options = resolveSidebarViewOptions([board], {});
    useSidebarViewStore.setState({
      chosenSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
      defaultAnswers: {},
      activeSidebarView: WORKTREES_SIDEBAR_VIEW_ID,
    });
    render(ui());
    // A view on offer loads nothing until it is shown.
    expect(h.imported).not.toHaveBeenCalled();

    await pick(/Board/);
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(BOARD_ID);
    expect(screen.getByTestId("sidebar-builtin-view").hasAttribute("inert")).toBe(true);
    const box = screen.getByTestId("sidebar-plugin-view-box");
    expect(screen.queryByTestId("plugin-content")).toBeNull();
    // The keyboard pick's hand-off lands on the plugin layer's switcher, with
    // the view still loading below it.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("sidebar-view-switcher"))
    );
    expect(
      screen.getByTestId("sidebar-view-switcher").closest("[data-testid='sidebar-plugin-view']")
    ).not.toBeNull();
    expect(box.isConnected).toBe(true);

    // The way back works before the view ever arrives.
    await pick(/Worktrees/);
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull();
    expect(screen.getByTestId("sidebar-builtin-view").hasAttribute("inert")).toBe(false);

    await act(async () => {
      h.release();
      await preloadPluginHostedView();
    });
    expect(screen.queryByTestId("plugin-content")).toBeNull();

    // Loaded now, so the next showing draws the view in the commit that shows it.
    await pick(/Board/);
    expect(screen.getByTestId("plugin-content")).toBeTruthy();
  });
});
