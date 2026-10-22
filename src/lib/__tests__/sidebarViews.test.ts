import { describe, expect, it } from "vitest";
import type {
  PluginHostedViewDescriptor,
  PluginSidebarHostedViewDescriptor,
} from "@shared/types/plugin";
import { makeProjectPluginInstanceKey } from "@shared/types/plugin";
import {
  resolveActiveSidebarView,
  resolveSidebarViewOptions,
  sidebarViewPublicId,
} from "../sidebarViews";
import { WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";

function sidebarView(
  viewId: string,
  extra: Partial<PluginSidebarHostedViewDescriptor> = {}
): PluginSidebarHostedViewDescriptor {
  const pluginId = extra.pluginId ?? "acme.beads";
  return {
    id: `plugin-view:${pluginId}/${viewId}`,
    pluginId,
    viewId,
    location: "sidebar",
    name: `Acme ${viewId}`,
    title: viewId,
    pluginName: "Acme",
    priority: 0,
    componentPath: `plugin://acme/${viewId}.js`,
    ...extra,
  };
}

const settingsView: PluginHostedViewDescriptor = {
  id: "plugin-view:acme.beads/prefs",
  pluginId: "acme.beads",
  viewId: "prefs",
  location: "settings",
  name: "Acme settings",
  componentPath: "plugin://acme/prefs.js",
};

const ids = (hosted: PluginHostedViewDescriptor[] | null, context = {}) =>
  resolveSidebarViewOptions(hosted, context).map((option) => option.id);

describe("sidebarViewPublicId", () => {
  it("names an installed plugin's view by manifest name and view id", () => {
    expect(sidebarViewPublicId({ pluginId: "acme.beads", viewId: "board" })).toBe(
      "acme.beads.board"
    );
  });

  it("marks a project plugin's view without naming the project, so both copies stay apart", () => {
    const pluginId = makeProjectPluginInstanceKey("p1", "acme.beads");
    expect(sidebarViewPublicId({ pluginId, viewId: "board" })).toBe("project:acme.beads.board");
    expect(sidebarViewPublicId({ pluginId, viewId: "board" })).not.toBe(
      sidebarViewPublicId({ pluginId: "acme.beads", viewId: "board" })
    );
  });
});

describe("resolveSidebarViewOptions", () => {
  it("offers the worktree list alone before the first snapshot and with no sidebar views", () => {
    expect(ids(null)).toEqual([WORKTREES_SIDEBAR_VIEW_ID]);
    expect(ids([settingsView])).toEqual([WORKTREES_SIDEBAR_VIEW_ID]);
  });

  it("orders by priority, highest first, the worktree list winning a tie", () => {
    const hosted = [
      sidebarView("low", { priority: -5 }),
      sidebarView("tied", { priority: 0 }),
      sidebarView("high", { priority: 10 }),
    ];
    expect(ids(hosted)).toEqual([
      "acme.beads.high",
      WORKTREES_SIDEBAR_VIEW_ID,
      "acme.beads.tied",
      "acme.beads.low",
    ]);
  });

  it("breaks a tie between plugin views by id, not by load order", () => {
    const forward = [sidebarView("b"), sidebarView("a")];
    expect(ids(forward)).toEqual(ids([...forward].reverse()));
    expect(ids(forward)).toEqual([WORKTREES_SIDEBAR_VIEW_ID, "acme.beads.a", "acme.beads.b"]);
  });

  it("offers a view only while its when holds", () => {
    const hosted = [sidebarView("board", { when: "isGitBacked" })];
    expect(ids(hosted, { isGitBacked: false })).toEqual([WORKTREES_SIDEBAR_VIEW_ID]);
    expect(ids(hosted, { isGitBacked: true })).toEqual([
      WORKTREES_SIDEBAR_VIEW_ID,
      "acme.beads.board",
    ]);
  });

  it("evaluates when without activeSidebarView, so availability never depends on what shows", () => {
    const hosted = [sidebarView("board", { when: "activeSidebarView == 'worktrees'" })];
    expect(ids(hosted, { activeSidebarView: "worktrees" })).toEqual([WORKTREES_SIDEBAR_VIEW_ID]);
  });

  it("lists an installed and a project copy of one plugin as two views", () => {
    const hosted = [
      sidebarView("board"),
      sidebarView("board", { pluginId: makeProjectPluginInstanceKey("p1", "acme.beads") }),
    ];
    expect(ids(hosted)).toEqual([
      WORKTREES_SIDEBAR_VIEW_ID,
      "acme.beads.board",
      "project:acme.beads.board",
    ]);
  });
});

describe("resolveActiveSidebarView", () => {
  const options = resolveSidebarViewOptions([sidebarView("board")], {});

  it("shows the chosen view while it is on offer", () => {
    expect(resolveActiveSidebarView(options, "acme.beads.board").view?.viewId).toBe("board");
  });

  it("falls back to the worktree list for a choice not on offer", () => {
    expect(resolveActiveSidebarView(options, "acme.gone.view").id).toBe(WORKTREES_SIDEBAR_VIEW_ID);
  });
});
