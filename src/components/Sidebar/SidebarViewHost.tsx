import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { FolderGit2, FolderOpen } from "lucide-react";
import { PluginHostedView } from "@/components/Plugin/PluginHostedView";
import { useSidebarViewOptions } from "@/hooks/useSidebarViews";
import { useWorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { isProjectSidebarView, resolveActiveSidebarView } from "@/lib/sidebarViews";
import { cn } from "@/lib/utils";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } from "@/store/sidebarViewStore";
import { SIDEBAR_HEADER_ROW } from "./sidebarHeader";
import { SidebarDefaultNotice } from "./SidebarDefaultNotice";
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
  const defaultAnswers = useSidebarViewStore((s) => s.defaultAnswers);
  const answerDefaultView = useSidebarViewStore((s) => s.answerDefaultView);
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

  // Asked when a project plugin's view is showing because it is the default,
  // not because the user picked it. An installed plugin's view only shows by
  // pick, so it never asks.
  const askAboutDefault =
    activeView !== null &&
    isProjectSidebarView(activeView) &&
    chosen !== active.id &&
    defaultAnswers[active.id] === undefined;

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
            {askAboutDefault && (
              <SidebarDefaultNotice
                view={activeView}
                builtInTitle={model.builtIn.title}
                onKeep={() => {
                  answerDefaultView(active.id, "keep");
                  focusSidebarSwitcher(undefined);
                }}
                onShowBuiltIn={() => {
                  requestSidebarViewFocusHandOff();
                  answerDefaultView(active.id, "worktrees");
                }}
              />
            )}
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

/** How often an owed hand-off looks again while focus still has somewhere to be. */
const FOCUS_HAND_OFF_POLL_MS = 50;
/**
 * How long an owed hand-off waits for focus to strand: long enough for a
 * retiring overlay's exit animation (the worktree list's popovers keep their
 * portalled content for one), short enough that nothing later is mistaken
 * for this change's doing.
 */
const FOCUS_HAND_OFF_DEADLINE_MS = 600;

interface OwedFocusHandOff {
  focusVisible?: boolean;
  /** Looks left before giving up, counted rather than timed so it can't outrun its own polling. */
  checksLeft: number;
}

const FOCUS_HAND_OFF_CHECKS = Math.ceil(FOCUS_HAND_OFF_DEADLINE_MS / FOCUS_HAND_OFF_POLL_MS);

/** Focus the sidebar's switcher, or its region when there is none. */
function focusSidebarSwitcher(focusVisible: boolean | undefined): void {
  const target =
    getMountedSidebarViewTrigger() ?? useMacroFocusStore.getState().refs.get("sidebar");
  target?.focus({
    preventScroll: true,
    ...(focusVisible !== undefined ? { focusVisible } : {}),
  });
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
 * moves nothing.
 *
 * An owed hand-off outlives the change that owed it. Focus strands only once
 * whatever held it is truly gone, which can be a beat later — a popover the
 * worktree list closed still animates out, then hands focus to a trigger now
 * inert — and further changes can land meanwhile. So it waits, across them,
 * until focus strands (then the switcher takes it), finds a home of its own,
 * or the deadline passes; it never moves focus that has somewhere to be.
 */
function useSidebarViewFocusHandOff(activeId: string) {
  const focusOwnerRef = useRef<SidebarLayer | null>(null);
  const shownRef = useRef(activeId);
  const owedRef = useRef<OwedFocusHandOff | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Capture on the document runs before React's own listeners, so any focus
  // clears the owner and a layer's handler, if it is that layer's, sets it
  // back. Focus that lands somewhere real also settles an owed hand-off.
  useEffect(() => {
    const onFocusIn = () => {
      focusOwnerRef.current = null;
      if (owedRef.current !== null && !isFocusStranded()) owedRef.current = null;
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      owedRef.current = null;
    };
  }, []);

  const markFocus = useCallback((layer: SidebarLayer) => {
    focusOwnerRef.current = layer;
  }, []);

  const settle = useCallback(() => {
    // A task later, at the soonest: inert moves focus off the worktree list
    // only at the next rendering update, and Radix's own close-time
    // restoration aims at a trigger this change has retired.
    const check = () => {
      timerRef.current = null;
      const owed = owedRef.current;
      if (owed === null) return;
      if (isFocusStranded()) {
        owedRef.current = null;
        focusSidebarSwitcher(owed.focusVisible);
        return;
      }
      owed.checksLeft -= 1;
      if (owed.checksLeft <= 0) {
        owedRef.current = null;
        return;
      }
      timerRef.current = setTimeout(check, FOCUS_HAND_OFF_POLL_MS);
    };
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(check, 0);
  }, []);

  useLayoutEffect(() => {
    const left = shownRef.current;
    if (left === activeId) return;
    shownRef.current = activeId;
    const leftLayer: SidebarLayer = left === WORKTREES_SIDEBAR_VIEW_ID ? "builtin" : "plugin";
    const requested = takeSidebarViewFocusHandOff();
    const pending = owedRef.current;
    if (requested === null && pending === null && focusOwnerRef.current !== leftLayer) return;
    owedRef.current = {
      focusVisible: requested?.focusVisible ?? pending?.focusVisible,
      checksLeft: FOCUS_HAND_OFF_CHECKS,
    };
    settle();
  }, [activeId, settle]);

  return { markFocus };
}

export { WORKTREES_SIDEBAR_VIEW_ID };
