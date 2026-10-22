// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Scratch } from "@shared/types";
import { resolvePresentation } from "@shared/config/presentationProfile";
import { buildPluginWhenContext } from "@shared/utils/pluginContextKeys";
import { evaluateWhenClause } from "@shared/utils/whenClause";
import { buildChromeWhenContext, getChromeWhenContext } from "../chromeWhenContext";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { usePluginContextKeyStore } from "@/store/pluginContextKeyStore";
import { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";
import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "@/store/projectPresentationStore";

function project(id: string, gitBacked: boolean): Project {
  return { id, name: id, path: `/repos/${id}`, emoji: "", lastOpened: 0, gitBacked };
}

function scratch(id: string): Scratch {
  return { id, name: id, path: `/scratches/${id}`, createdAt: 0, lastOpened: 0 };
}

function seedView(id: string | null): void {
  if (id === null) delete window.__DAINTREE_INITIAL_PROJECT__;
  else window.__DAINTREE_INITIAL_PROJECT__ = { id };
}

afterEach(() => {
  seedView(null);
  useProjectStore.setState({ projects: [], currentProject: null });
  useScratchStore.setState({ scratches: [], currentScratch: null });
  usePluginContextKeyStore.setState({ keysByPlugin: {}, whenContext: {} });
  useSidebarViewStore.setState({ activeSidebarView: WORKTREES_SIDEBAR_VIEW_ID });
  _resetProjectPresentationStoreForTest();
});

describe("buildChromeWhenContext", () => {
  const presentation = resolvePresentation({}, { gitBacked: true });

  it("answers no workspace with an empty kind and no git", () => {
    const ctx = buildChromeWhenContext({
      pluginContext: {},
      workspace: null,
      activeSidebarView: "worktrees",
      presentation,
    });
    expect(evaluateWhenClause("workspaceKind", ctx)).toBe(false);
    expect(evaluateWhenClause("isGitBacked", ctx)).toBe(false);
  });

  it("never lets a plugin key replace a host fact", () => {
    const ctx = buildChromeWhenContext({
      pluginContext: { isGitBacked: true, workspaceKind: "project" },
      workspace: { kind: "scratch", isGitBacked: false },
      activeSidebarView: "worktrees",
      presentation,
    });
    expect(ctx.isGitBacked).toBe(false);
    expect(ctx.workspaceKind).toBe("scratch");
  });

  it("keeps plugin keys under their manifest name", () => {
    const ctx = buildChromeWhenContext({
      pluginContext: buildPluginWhenContext({ "acme.beads": { needsYou: true } }),
      workspace: { kind: "project", isGitBacked: true },
      activeSidebarView: "acme.beads.board",
      presentation,
    });
    expect(
      evaluateWhenClause("acme.beads.needsYou && activeSidebarView == 'acme.beads.board'", ctx)
    ).toBe(true);
  });
});

describe("getChromeWhenContext", () => {
  it("describes this view's own project, not the globally current one", () => {
    const own = project("a".repeat(64), false);
    const other = project("b".repeat(64), true);
    seedView(own.id);
    useProjectStore.setState({ projects: [own, other], currentProject: other });

    const ctx = getChromeWhenContext();
    expect(ctx.workspaceKind).toBe("project");
    expect(ctx.isGitBacked).toBe(false);
    // Forge stats need a repository, and this view's folder has none.
    expect(ctx.presentationForgeStats).toBe("hidden");
  });

  it("applies the presentation profile main loaded for this view's project", () => {
    const own = project("a".repeat(64), true);
    const other = project("b".repeat(64), true);
    seedView(own.id);
    useProjectStore.setState({ projects: [own, other], currentProject: other });
    useProjectPresentationStore.setState({
      loaded: true,
      projectId: own.id,
      levels: { forgeStats: "demoted" },
    });

    expect(getChromeWhenContext().presentationForgeStats).toBe("demoted");
  });

  it("reports a scratch view as a scratch with no git, even with a project current", () => {
    const view = scratch("scratch-1");
    seedView(view.id);
    useProjectStore.setState({ projects: [], currentProject: project("c".repeat(64), true) });
    useScratchStore.setState({ scratches: [view], currentScratch: null });

    const ctx = getChromeWhenContext();
    expect(ctx.workspaceKind).toBe("scratch");
    expect(ctx.isGitBacked).toBe(false);
    expect(ctx.presentationForgeStats).toBe("hidden");
  });

  it("reads the active sidebar view and plugin keys at call time", () => {
    expect(evaluateWhenClause("activeSidebarView == 'worktrees'", getChromeWhenContext())).toBe(
      true
    );

    useSidebarViewStore.getState().setActiveSidebarView("acme.beads.board");
    const keysByPlugin = { "acme.beads": { ready: true } };
    usePluginContextKeyStore.setState({
      keysByPlugin,
      whenContext: buildPluginWhenContext(keysByPlugin),
    });

    expect(
      evaluateWhenClause(
        "activeSidebarView == 'acme.beads.board' && acme.beads.ready",
        getChromeWhenContext()
      )
    ).toBe(true);
  });
});
