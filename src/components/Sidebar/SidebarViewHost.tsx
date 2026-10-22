import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { FolderGit2, FolderOpen } from "lucide-react";
import { PluginHostedView } from "@/components/Plugin/PluginHostedView";
import { useSidebarViewOptions } from "@/hooks/useSidebarViews";
import { useWorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { resolveActiveSidebarView } from "@/lib/sidebarViews";
import { cn } from "@/lib/utils";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";
import { SIDEBAR_HEADER_ROW } from "./sidebarHeader";
import {
  SidebarViewHeading,
  SidebarViewSwitcherContext,
  getMountedSidebarViewTrigger,
  requestSidebarViewFocusHandOff,
  takeSidebarViewFocusHandOff,
  type SidebarViewSwitcherModel,
} from "./SidebarViewSwitcher";

/**
 * The sidebar's views: the built-in worktree list (`children`) and whichever
 * plugin sidebar view is chosen, switched from the header.
 *
 * Always rendered, in the same shape, whether or not any plugin view is on
 * offer, so the first one arriving never remounts the worktree list. The list
 * stays mounted while a plugin view shows — its selection, scroll and
 * Virtuoso measurements survive the round trip — but hidden without giving up
 * its box (`invisible`, not `display: none`, which would zero what Virtuoso
 * measured) and `inert`, so its grid leaves the tab order and the sidebar
 * stays the one F6 region it was. Only the chosen plugin view is mounted; one
 * switched away from unmounts, and its dispose signal releases what it held.
 */
export function SidebarViewHost({ children }: { children: ReactNode }) {
  const options = useSidebarViewOptions();
  const chosen = useSidebarViewStore((s) => s.chosenSidebarView);
  const chooseSidebarView = useSidebarViewStore((s) => s.chooseSidebarView);
  const setActiveSidebarView = useSidebarViewStore((s) => s.setActiveSidebarView);
  const active = resolveActiveSidebarView(options, chosen);
  const activeView = active.view;
  const workspace = useWorkspaceRoot();
  const builtInLayerRef = useRef<HTMLDivElement>(null);

  // Published before paint, so a `when` clause never sees a view that isn't the
  // one on screen. A fallback is never written back as the choice: the chosen
  // view returns as soon as it is on offer again.
  useLayoutEffect(() => {
    setActiveSidebarView(active.id);
  }, [active.id, setActiveSidebarView]);

  const builtInIsWorkspace = workspace !== null && !workspace.isGitBacked;
  const model = useMemo<SidebarViewSwitcherModel>(
    () => ({
      options,
      activeId: active.id,
      builtIn: builtInIsWorkspace
        ? { title: "Workspace", icon: FolderOpen }
        : { title: "Worktrees", icon: FolderGit2 },
      choose: chooseSidebarView,
    }),
    [options, active.id, builtInIsWorkspace, chooseSidebarView]
  );

  const showBuiltIn = useCallback(() => {
    requestSidebarViewFocusHandOff();
    chooseSidebarView(WORKTREES_SIDEBAR_VIEW_ID);
  }, [chooseSidebarView]);

  const handOff = useSidebarLayerFocusHandOff(activeView !== null, builtInLayerRef);

  return (
    <SidebarViewSwitcherContext.Provider value={model}>
      <div className="relative h-full">
        <div
          ref={builtInLayerRef}
          className={cn("h-full", activeView !== null && "invisible opacity-0")}
          inert={activeView !== null || undefined}
          data-testid="sidebar-builtin-view"
        >
          {children}
        </div>
        {activeView !== null && (
          <PluginViewLayer onRetire={handOff.notePluginLayerRetired}>
            {/* The header holds the switcher and nothing else: a plugin draws its
                own controls inside its view. */}
            <div className={cn(SIDEBAR_HEADER_ROW, "border-b border-divider")}>
              <SidebarViewHeading
                viewId={active.id}
                className="min-w-0 text-text-primary font-semibold text-sm tracking-wide"
              >
                {activeView.title}
              </SidebarViewHeading>
            </div>
            {/* Right-clicks stop here, so the sidebar's own background menu (New
                worktree…, Refresh) never opens over a plugin's view — the view
                still sees the event and can draw its own menu. */}
            <div
              className="flex min-h-0 flex-1 flex-col"
              onContextMenu={(event) => event.stopPropagation()}
            >
              <PluginHostedView
                key={active.id}
                source={{ from: "hosted", view: activeView }}
                host="sidebar"
                mountId={`sidebar:${active.id}`}
                onRequestClose={showBuiltIn}
                requestCloseLabel={`Show ${model.builtIn.title.toLowerCase()}`}
                className="flex-1"
                testId="sidebar-plugin-view-box"
              />
            </div>
          </PluginViewLayer>
        )}
      </div>
    </SidebarViewSwitcherContext.Provider>
  );
}

/**
 * The plugin view's layer, which reports as it unmounts whether focus was
 * inside it. Its own component on purpose: React runs a deleted component's
 * layout cleanup while the DOM it rendered is still attached, whereas the
 * host's cleanup runs after the layer is gone and focus has already fallen to
 * the body.
 */
function PluginViewLayer({
  onRetire,
  children,
}: {
  onRetire: (hadFocus: boolean) => void;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = layerRef.current;
    return () => onRetire(layer !== null && layer.contains(document.activeElement));
  }, [onRetire]);
  return (
    <div
      ref={layerRef}
      className="absolute inset-0 flex flex-col"
      data-testid="sidebar-plugin-view"
    >
      {children}
    </div>
  );
}

/**
 * Keep keyboard focus in the sidebar when the view showing moves between the
 * built-in layer and a plugin's. Either way the element that held focus is
 * retired — inert with the worktree list, or unmounted with the plugin view —
 * so focus would otherwise fall to the document, which strands a keyboard
 * user and loses the sidebar's region.
 *
 * Owed when the switcher's own pick crossed layers (it asks, with whether the
 * pick came from the keyboard), or when focus was inside the layer that just
 * left. A view change nobody was looking at — the saved choice arriving with
 * the first plugin snapshot at boot — moves nothing.
 */
function useSidebarLayerFocusHandOff(
  pluginShowing: boolean,
  builtInLayerRef: React.RefObject<HTMLDivElement | null>
) {
  const shownRef = useRef(pluginShowing);
  const pluginLayerHadFocusRef = useRef(false);

  const notePluginLayerRetired = useCallback((hadFocus: boolean) => {
    pluginLayerHadFocusRef.current = hadFocus;
  }, []);

  useLayoutEffect(() => {
    if (shownRef.current === pluginShowing) return;
    shownRef.current = pluginShowing;
    // Inert does not move focus synchronously, so a worktree list just
    // retired still holds it here.
    const leftLayerHadFocus = pluginShowing
      ? (builtInLayerRef.current?.contains(document.activeElement) ?? false)
      : pluginLayerHadFocusRef.current;
    pluginLayerHadFocusRef.current = false;
    const handOff = takeSidebarViewFocusHandOff() ?? (leftLayerHadFocus ? {} : null);
    if (handOff === null) return;
    // A task later, after Radix's own close-time restoration, which aimed at the
    // trigger this change retired.
    const timer = setTimeout(() => {
      const target =
        getMountedSidebarViewTrigger() ?? useMacroFocusStore.getState().refs.get("sidebar");
      target?.focus({
        preventScroll: true,
        ...(handOff.focusVisible !== undefined ? { focusVisible: handOff.focusVisible } : {}),
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [pluginShowing, builtInLayerRef]);

  return { notePluginLayerRetired };
}

export { WORKTREES_SIDEBAR_VIEW_ID };
