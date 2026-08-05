import { resolvePanelKindLaunchActionId } from "@shared/config/panelKindRegistry";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import type { ActionSource, ActionDispatchResult } from "@shared/types";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";

export interface LaunchPanelKindOptions {
  kindId: string;
  /** Where the surface told the user this panel would land. */
  location: "dock" | "grid";
  cwd?: string;
  /**
   * The surface's ambient worktree. Used to place a directly-created panel; it
   * is deliberately NOT forwarded to a launch action, which resolves its own
   * target from the dispatch context — see {@link launchPanelKind}.
   */
  worktreeId: string | null;
  source: ActionSource;
}

/**
 * A kind with a `launchActionId` was activated by dispatching it; the caller
 * gets the dispatch result so it can present a refusal in its own voice.
 */
export interface PanelKindActionLaunch {
  route: "action";
  actionId: string;
  result: ActionDispatchResult;
}

/** A kind with no launch action was created directly. */
export interface PanelKindPanelLaunch {
  route: "panel";
  /** `null` when `addPanel` refused — it has already reported why. */
  panelId: string | null;
  /** Where the panel actually landed, which is not always what was requested. */
  location: string | null;
}

export type PanelKindLaunchOutcome = PanelKindActionLaunch | PanelKindPanelLaunch;

/**
 * Activate a panel kind the way its registry entry says it activates, so the
 * launcher surfaces (dock `+`, panel palette, …) can't drift from each other or
 * from the toolbar (#11668). Curation and presentation stay with each surface —
 * this only answers "how does this kind launch", and never notifies.
 *
 * Kinds that name a `launchActionId` dispatch it and let it own target
 * resolution, titles and dedup. Everything else is created through `addPanel`
 * exactly as before.
 */
export async function launchPanelKind({
  kindId,
  location,
  cwd,
  worktreeId,
  source,
}: LaunchPanelKindOptions): Promise<PanelKindLaunchOutcome> {
  const activateDockOnCreate = location === "dock";
  const actionId = resolvePanelKindLaunchActionId(kindId);

  if (actionId !== undefined) {
    // One bag for every launch action: each declares the fields it wants and
    // `ActionService` hands `run()` the parsed args, so the rest are dropped
    // before they reach it. `agentId` is what `agent.launch` calls the kind —
    // its schema admits the synthetic `terminal`/`browser`/`dev-preview` ids.
    //
    // No `worktreeId`: a launcher's ambient selection is not a named target,
    // and the two resolve differently on purpose. `resolveLaunchTarget` keeps
    // an inherited ghost id so the panel joins its worktree's surviving
    // terminals but makes an explicit one throw (#10812/#11232), and
    // `resolveFileBrowserTarget` prefers the focused worktree over the active
    // one. Forwarding the surface's id would assert a target nobody named and
    // override both. Every launch action reads the dispatch context instead.
    const result = await actionService.dispatch(
      actionId,
      { agentId: kindId, location, cwd: cwd || undefined, activateDockOnCreate },
      { source }
    );
    return { route: "action", actionId, result };
  }

  const panelId = await usePanelStore.getState().addPanel({
    kind: kindId,
    cwd,
    // An empty id would place the panel in a bucket nothing renders, so it
    // means the same as an absent one.
    worktreeId: worktreeId || undefined,
    location,
    // Folds dock activation into the same set() that commits the panel, so the
    // offscreen-container watchdog can't close it in the render gap (#6590).
    activateDockOnCreate,
    // Plugin kinds are deliberately outside the built-in AddPanelOptions union
    // (a `string & {}` member would defeat discriminated narrowing), so
    // widening happens here at the integration boundary.
  } as AddPanelOptions);

  // The committed location, not the requested one: a non-dockable kind asked
  // for the dock lands in the grid instead.
  const committed = panelId
    ? (usePanelStore.getState().panelsById[panelId]?.location ?? null)
    : null;
  return { route: "panel", panelId: panelId ?? null, location: committed };
}
