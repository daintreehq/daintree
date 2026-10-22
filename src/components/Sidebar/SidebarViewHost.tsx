import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
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
  getMountedSidebarViewTrigger,
  requestSidebarViewFocusHandOff,
  takeSidebarViewFocusHandOff,
} from "./SidebarViewSwitcher";
import { SidebarViewSwitcherContext, type SidebarViewSwitcherModel } from "./sidebarViewContext";

type SidebarLayer = "builtin" | "plugin";

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

  // Published before paint, so a `when` clause never sees a view that isn't the
  // one on screen. A fallback is never written back as the choice: the chosen
  // view returns as soon as it is on offer again.
  useLayoutEffect(() => {
    setActiveSidebarView(active.id);
  }, [active.id, setActiveSidebarView]);
  // With no sidebar there is no sidebar view showing; the choice stays.
  useLayoutEffect(
    () => () => setActiveSidebarView(WORKTREES_SIDEBAR_VIEW_ID),
    [setActiveSidebarView]
  );

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

  const { markFocus } = useSidebarViewFocusHandOff(active.id);

  return (
    <SidebarViewSwitcherContext.Provider value={model}>
      <div className="relative h-full">
        <div
          className={cn("h-full", activeView !== null && "invisible opacity-0")}
          inert={activeView !== null || undefined}
          onFocusCapture={() => markFocus("builtin")}
          data-testid="sidebar-builtin-view"
        >
          {children}
        </div>
        {activeView !== null && (
          // Right-clicks stop at the layer, so the sidebar's own background menu
          // (New worktree…, Refresh) never opens anywhere over a plugin's view,
          // its header included — the view still sees the event and can draw
          // its own menu.
          <div
            className="absolute inset-0 flex flex-col"
            onFocusCapture={() => markFocus("plugin")}
            onContextMenu={(event) => event.stopPropagation()}
            data-testid="sidebar-plugin-view"
          >
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
        )}
      </div>
    </SidebarViewSwitcherContext.Provider>
  );
}

/** Focus has nowhere to be: the document, a node gone from it, or one gone inert. */
function isFocusStranded(): boolean {
  const element = document.activeElement;
  return (
    element === null ||
    element === document.body ||
    !element.isConnected ||
    element.closest("[inert]") !== null
  );
}

/**
 * Keep keyboard focus in the sidebar when the view showing changes. Whatever
 * held focus in the view that left is retired — inert with the worktree list,
 * or unmounted with a plugin's view — so focus would otherwise fall to the
 * document, which strands a keyboard user and loses the sidebar's region.
 *
 * Owed when the switcher's own pick moved between the layers (it asks, saying
 * whether the pick came from the keyboard), or when the view that left held
 * focus. Which layer holds it is read from React's focus events, which reach a
 * layer from its portalled menus and popovers too, rather than from the DOM:
 * the menu a pick was made in is not inside the layer it belongs to. A change
 * nobody was in — the remembered view arriving with the first plugin snapshot —
 * moves nothing, and nothing moves focus that already has somewhere to be.
 */
function useSidebarViewFocusHandOff(activeId: string) {
  const focusOwnerRef = useRef<SidebarLayer | null>(null);
  const shownRef = useRef(activeId);

  // Capture on the document runs before React's own listeners, so any focus
  // clears the owner and a layer's handler, if it is that layer's, sets it back.
  useEffect(() => {
    const clearOwner = () => {
      focusOwnerRef.current = null;
    };
    document.addEventListener("focusin", clearOwner, true);
    return () => document.removeEventListener("focusin", clearOwner, true);
  }, []);

  const markFocus = useCallback((layer: SidebarLayer) => {
    focusOwnerRef.current = layer;
  }, []);

  useLayoutEffect(() => {
    const left = shownRef.current;
    if (left === activeId) return;
    shownRef.current = activeId;
    const leftLayer: SidebarLayer = left === WORKTREES_SIDEBAR_VIEW_ID ? "builtin" : "plugin";
    const requested = takeSidebarViewFocusHandOff();
    if (requested === null && focusOwnerRef.current !== leftLayer) return;
    // A task later, once the commit has settled: inert moves focus off the
    // worktree list only at the next rendering update, and Radix's own
    // close-time restoration aims at a trigger this change has retired.
    const timer = setTimeout(() => {
      if (!isFocusStranded()) return;
      const target =
        getMountedSidebarViewTrigger() ?? useMacroFocusStore.getState().refs.get("sidebar");
      target?.focus({
        preventScroll: true,
        ...(requested?.focusVisible !== undefined ? { focusVisible: requested.focusVisible } : {}),
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [activeId]);

  return { markFocus };
}

export { WORKTREES_SIDEBAR_VIEW_ID };
