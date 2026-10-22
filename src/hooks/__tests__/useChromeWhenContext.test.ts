// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Project, Scratch } from "@shared/types";
import { buildPluginWhenContext } from "@shared/utils/pluginContextKeys";
import { useChromeWhenContext, useWhenClause } from "../useChromeWhenContext";
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

function seedPluginKeys(keysByPlugin: Parameters<typeof buildPluginWhenContext>[0]): void {
  usePluginContextKeyStore.setState({
    keysByPlugin,
    whenContext: buildPluginWhenContext(keysByPlugin),
  });
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

describe("useWhenClause", () => {
  it("holds for an entry with no clause", () => {
    const { result } = renderHook(() => useWhenClause(undefined));
    expect(result.current).toBe(true);
  });

  it("follows the plugin's published keys as they change", () => {
    const { result } = renderHook(() => useWhenClause("acme.beads.needsYou"));
    expect(result.current).toBe(false);

    act(() => seedPluginKeys({ "acme.beads": { needsYou: true } }));
    expect(result.current).toBe(true);

    act(() => seedPluginKeys({ "acme.beads": { needsYou: false } }));
    expect(result.current).toBe(false);
  });

  it("follows the active sidebar view", () => {
    const { result } = renderHook(() => useWhenClause("activeSidebarView == 'acme.beads.board'"));
    expect(result.current).toBe(false);

    act(() => {
      useSidebarViewStore.getState().setActiveSidebarView("acme.beads.board");
    });
    expect(result.current).toBe(true);

    act(() => {
      useSidebarViewStore.getState().setActiveSidebarView(WORKTREES_SIDEBAR_VIEW_ID);
    });
    expect(result.current).toBe(false);
  });

  it("follows whether the project is git-backed", () => {
    const repo = project("a".repeat(64), true);
    act(() => {
      useProjectStore.setState({ currentProject: repo });
    });
    const { result } = renderHook(() => useWhenClause("isGitBacked"));
    expect(result.current).toBe(true);

    act(() => {
      useProjectStore.setState({ currentProject: { ...repo, gitBacked: false } });
    });
    expect(result.current).toBe(false);
  });

  it("follows what kind of workspace the view has, empty once there is none", () => {
    act(() => {
      useProjectStore.setState({ currentProject: project("a".repeat(64), false) });
    });
    const { result } = renderHook(() => ({
      project: useWhenClause("workspaceKind == 'project'"),
      scratch: useWhenClause("workspaceKind == 'scratch'"),
      none: useWhenClause("workspaceKind == ''"),
    }));
    expect(result.current).toEqual({ project: true, scratch: false, none: false });

    act(() => {
      useProjectStore.setState({ currentProject: null });
      useScratchStore.setState({ currentScratch: scratch("scratch-1") });
    });
    expect(result.current).toEqual({ project: false, scratch: true, none: false });

    act(() => {
      useScratchStore.setState({ currentScratch: null });
    });
    expect(result.current).toEqual({ project: false, scratch: false, none: true });
  });

  it("follows a presentation level main sends for this project", () => {
    const repo = project("a".repeat(64), true);
    act(() => {
      useProjectStore.setState({ currentProject: repo });
    });
    const { result } = renderHook(() => useWhenClause("presentationForgeStats == 'shown'"));
    expect(result.current).toBe(true);

    act(() => {
      useProjectPresentationStore.setState({
        loaded: true,
        projectId: repo.id,
        levels: { forgeStats: "hidden" },
      });
    });
    expect(result.current).toBe(false);
  });

  it("follows this view's own project while another is current", () => {
    const own = project("a".repeat(64), true);
    const other = project("b".repeat(64), false);
    seedView(own.id);
    act(() => {
      useProjectStore.setState({ projects: [own, other], currentProject: other });
      useProjectPresentationStore.setState({
        loaded: true,
        projectId: own.id,
        levels: { forgeStats: "demoted" },
      });
    });

    const { result } = renderHook(() =>
      useWhenClause("isGitBacked && presentationForgeStats == 'demoted'")
    );
    expect(result.current).toBe(true);

    // The globally current project moving changes nothing here.
    act(() => {
      useProjectStore.setState({
        projects: [own, { ...other, gitBacked: true }],
        currentProject: { ...other, gitBacked: true },
      });
    });
    expect(result.current).toBe(true);

    act(() => {
      useProjectStore.setState({
        projects: [{ ...own, gitBacked: false }, other],
        currentProject: other,
      });
    });
    expect(result.current).toBe(false);
  });

  it("drops this view's project once it is closed", () => {
    const own = project("a".repeat(64), true);
    seedView(own.id);
    act(() => {
      useProjectStore.setState({ projects: [own], currentProject: null });
    });
    const { result } = renderHook(() => useWhenClause("workspaceKind == 'project'"));
    expect(result.current).toBe(true);

    act(() => {
      useProjectStore.setState({ projects: [{ ...own, status: "closed" }] });
    });
    expect(result.current).toBe(false);
  });

  it("fails closed on a clause that does not parse", () => {
    const { result } = renderHook(() => useWhenClause("isGitBacked &&"));
    expect(result.current).toBe(false);
  });
});

describe("useChromeWhenContext", () => {
  it("keeps the same context object across an edit that moves no key", () => {
    const repo = project("a".repeat(64), true);
    act(() => {
      useProjectStore.setState({ currentProject: repo });
    });
    const { result } = renderHook(() => useChromeWhenContext());
    const first = result.current;

    act(() => {
      useProjectStore.setState({ currentProject: { ...repo, name: "Renamed" } });
    });
    expect(result.current).toBe(first);

    act(() => {
      useSidebarViewStore.getState().setActiveSidebarView("acme.beads.board");
    });
    expect(result.current).not.toBe(first);
  });
});
