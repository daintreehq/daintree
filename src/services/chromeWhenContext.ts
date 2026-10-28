import type { WhenClauseContext } from "@shared/utils/whenClause/types";
import {
  buildPresentationWhenContext,
  type ResolvedPresentation,
} from "@shared/config/presentationProfile";
import { usePluginContextKeyStore } from "@/store/pluginContextKeyStore";
import { useSidebarViewStore } from "@/store/sidebarViewStore";
import { getResolvedPresentation } from "@/hooks/useResolvedPresentation";
import { getWorkspaceRoot, type WorkspaceRoot } from "@/hooks/useWorkspaceRoot";

export interface ChromeWhenFacts {
  /** Keys plugins publish with `host.setContext`, nested under each manifest name. */
  pluginContext: WhenClauseContext;
  workspace: Pick<WorkspaceRoot, "kind" | "isGitBacked"> | null;
  activeSidebarView: string;
  presentation: ResolvedPresentation;
}

/**
 * The context every renderer plugin `when` clause sees: plugin keys plus the
 * host's facts about this view's project — the documented contract in
 * docs/plugins/contribution-points.md. Every host key is a stable public API:
 * additions are fine, renames and semantic changes are breaking.
 *
 * Plugin keys sit under lowercase manifest names and host keys are camelCase,
 * so neither can shadow the other; host keys are spread last regardless.
 * Surfaces add their own keys on top (a context menu's `worktreeId`, the
 * keybinding focus keys).
 */
export function buildChromeWhenContext(facts: ChromeWhenFacts): WhenClauseContext {
  return {
    ...facts.pluginContext,
    // False with no workspace at all, not just for a folder without git.
    isGitBacked: facts.workspace?.isGitBacked ?? false,
    // Empty when the view has no workspace, so a bare `workspaceKind` is false.
    workspaceKind: facts.workspace?.kind ?? "",
    activeSidebarView: facts.activeSidebarView,
    // One key per presentation feature (`presentationForgeStats == 'hidden'`).
    ...buildPresentationWhenContext(facts.presentation),
  };
}

/** Non-reactive snapshot, for paths that resolve once per event (keybinding `when` clauses). */
export function getChromeWhenContext(): WhenClauseContext {
  return buildChromeWhenContext({
    pluginContext: usePluginContextKeyStore.getState().whenContext,
    workspace: getWorkspaceRoot(),
    activeSidebarView: useSidebarViewStore.getState().activeSidebarView,
    presentation: getResolvedPresentation(),
  });
}
