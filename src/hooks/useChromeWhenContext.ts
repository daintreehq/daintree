import { useEffect, useMemo } from "react";
import { evaluateWhenClause, type WhenClauseContext } from "@shared/utils/whenClause";
import { usePluginContextKeyStore } from "@/store/pluginContextKeyStore";
import { useSidebarViewStore } from "@/store/sidebarViewStore";
import { buildChromeWhenContext } from "@/services/chromeWhenContext";
import { useResolvedPresentation } from "@/hooks/useResolvedPresentation";
import { useWorkspaceRoot } from "@/hooks/useWorkspaceRoot";

/**
 * The live context for plugin chrome `when` clauses (see
 * {@link buildChromeWhenContext}), rebuilt only when a key in it changes: the
 * plugin keys, this view's workspace kind and git backing, the active sidebar
 * view, or a presentation level. A list surface calls this once and filters
 * its entries with `evaluateWhenClause`, rather than a hook per entry.
 *
 * A `when` only decides whether an entry is shown. Dispatch never consults it.
 */
export function useChromeWhenContext(): WhenClauseContext {
  const pluginContext = usePluginContextKeyStore((s) => s.whenContext);
  const initPluginContext = usePluginContextKeyStore((s) => s.init);
  const workspace = useWorkspaceRoot();
  const activeSidebarView = useSidebarViewStore((s) => s.activeSidebarView);
  const presentation = useResolvedPresentation();

  useEffect(() => {
    initPluginContext();
  }, [initPluginContext]);

  // Primitives, not the root: a rename moves neither fact.
  const kind = workspace?.kind;
  const isGitBacked = workspace?.isGitBacked;

  return useMemo(
    () =>
      buildChromeWhenContext({
        pluginContext,
        workspace: kind === undefined ? null : { kind, isGitBacked: isGitBacked === true },
        activeSidebarView,
        presentation,
      }),
    [pluginContext, kind, isGitBacked, activeSidebarView, presentation]
  );
}

/** Whether a single chrome entry's `when` holds right now; a missing clause always does. */
export function useWhenClause(expression: string | undefined): boolean {
  const context = useChromeWhenContext();
  return evaluateWhenClause(expression, context);
}
