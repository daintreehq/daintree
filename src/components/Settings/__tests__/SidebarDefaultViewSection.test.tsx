// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SidebarViewOption } from "@/lib/sidebarViews";

const h = vi.hoisted(() => ({
  options: [] as SidebarViewOption[],
  workspace: { isGitBacked: true } as { isGitBacked: boolean } | null,
}));

vi.mock("@/hooks/useSidebarViews", () => ({ useSidebarViewOptions: () => h.options }));
vi.mock("@/hooks/useWorkspaceRoot", () => ({ useWorkspaceRoot: () => h.workspace }));

import { SidebarDefaultViewSection } from "../SidebarDefaultViewSection";
import { useSidebarViewStore } from "@/store/sidebarViewStore";

const builtIn: SidebarViewOption = { id: "worktrees", priority: 0, view: null };

beforeEach(() => {
  h.options = [builtIn];
  h.workspace = { isGitBacked: true };
  useSidebarViewStore.setState({ chosenSidebarView: null, defaultAnswers: {} });
});

afterEach(cleanup);

describe("SidebarDefaultViewSection", () => {
  it("stays out of the way when nothing is on offer or remembered", () => {
    render(<SidebarDefaultViewSection />);
    expect(screen.queryByTestId("project-sidebar-default")).toBeNull();
  });

  it("names the built-in view after the workspace in a folder without git", () => {
    h.workspace = { isGitBacked: false };
    useSidebarViewStore.setState({ chosenSidebarView: "worktrees" });
    render(<SidebarDefaultViewSection />);
    expect(screen.getByTestId("project-sidebar-default-row").textContent).toContain(
      "Workspace. Your pick"
    );
  });

  it("resets the pick and the remembered answers", () => {
    useSidebarViewStore.setState({
      chosenSidebarView: "worktrees",
      defaultAnswers: { "project:acme.beads.board": "worktrees" },
    });
    render(<SidebarDefaultViewSection />);
    act(() => {
      fireEvent.click(screen.getByTestId("project-sidebar-default-reset"));
    });
    expect(useSidebarViewStore.getState().chosenSidebarView).toBeNull();
    expect(useSidebarViewStore.getState().defaultAnswers).toEqual({});
  });
});
