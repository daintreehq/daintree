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
    const result = await actionService.dispatch(
      actionId,
      {
        agentId: kindId,
        location,
        cwd,
        // Empty ids are rejected by the stricter arg schemas, and mean the same
        // thing as an absent one: resolve the target from context.
        worktreeId: worktreeId || undefined,
        activateDockOnCreate,
      },
      { source }
    );
    return { route: "action", actionId, result };
  }

  const panelId = await usePanelStore.getState().addPanel({
    kind: kindId,
    cwd,
    worktreeId: worktreeId ?? undefined,
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
