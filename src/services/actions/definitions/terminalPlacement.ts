import { z } from "zod";
import { terminalClient } from "@/clients";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import { panelKindIsDockable } from "@shared/config/panelKindRegistry";
import type { PanelKind, PanelLocation } from "@shared/types/panel";
import {
  TerminalInOtherProjectError,
  formatNoPanelMessage,
} from "@shared/utils/terminalInOtherProject";

/**
 * Fail a named terminal that is not in this view, saying whether it is running
 * in another project's instead of reporting every miss as gone (#13120). Only
 * the miss path pays for the lookup, and it only ever throws: nothing outside
 * this view is acted on. The receiving workspace is read before the await, and
 * an unknown one or a same-workspace owner keeps the ordinary miss — the code
 * claims another project, never a local/backend discrepancy. Callers bound to
 * one view get the ordinary miss either way; main masks the code for them.
 */
export async function throwTerminalMiss(actionId: string, terminalId: string): Promise<never> {
  const ownWorkspaceId = getViewWorkspaceId();
  if (ownWorkspaceId) {
    const location = await terminalClient.locate(terminalId).catch(() => null);
    if (location?.found && location.projectId !== ownWorkspaceId) {
      throw new TerminalInOtherProjectError(actionId, {
        terminalId,
        projectId: location.projectId,
        viewResident: location.viewResident,
      });
    }
  }
  throw new Error(formatNoPanelMessage(actionId, terminalId));
}

export const PanelPlacementResultSchema = z.object({
  location: z
    .enum(["grid", "dock", "background"])
    .nullable()
    .describe(
      "Where the panel is now. Null means nothing was targeted (no panel named and none focused)."
    ),
});

export type PanelPlacementResult = z.infer<typeof PanelPlacementResultSchema>;

export type PlacementDestination = "grid" | "dock" | "background";

interface PlacementPanel {
  location?: PanelLocation;
  kind?: PanelKind;
}

interface PlacementState {
  focusedId: string | null;
  panelsById: Record<string, PlacementPanel | undefined>;
  getPanelGroup: (panelId: string) => { panelIds: string[] } | undefined;
}

/**
 * The panel a placement action acts on, once a named-but-missing id has been
 * failed with {@link throwTerminalMiss}. An unnamed call falls back to focus and
 * stays quiet when nothing real is focused, as a keybinding with no target
 * always has. `Object.hasOwn` because `panelsById` is a plain object, so an id
 * like "constructor" would otherwise resolve off the prototype.
 */
export function resolvePlacementTarget(
  terminalId: string | undefined,
  state: PlacementState
): string | null {
  const targetId = terminalId ?? state.focusedId;
  if (!targetId || !Object.hasOwn(state.panelsById, targetId)) return null;
  return targetId;
}

function placementOf(panel: PlacementPanel): PanelLocation {
  return panel.location ?? "grid";
}

/**
 * Refuse a move the panel cannot make, before anything mutates or an undo
 * snapshot is taken. A grouped panel moves with its group, so every member that
 * still exists has to be able to make the move too: the store would otherwise
 * background a member that is already somewhere else, or rescue a dock request
 * into the grid (#11375) and report it as docked.
 *
 * Returns true when the panel is already at the destination — an idempotent
 * success the caller acknowledges without moving anything.
 */
export function assertPlacementAllowed(
  actionId: string,
  panelId: string,
  destination: PlacementDestination,
  state: PlacementState
): boolean {
  const panel = state.panelsById[panelId]!;
  const current = placementOf(panel);
  if (current === destination) {
    if (destination === "dock" && !panelKindIsDockable(panel.kind ?? "terminal")) {
      throw new UnactionableTargetError(
        `${actionId}: panel "${panelId}" is a kind the dock cannot show — move it to the grid instead.`
      );
    }
    return true;
  }

  const memberIds = state.getPanelGroup(panelId)?.panelIds ?? [panelId];
  for (const memberId of memberIds) {
    const member = Object.hasOwn(state.panelsById, memberId)
      ? state.panelsById[memberId]
      : undefined;
    if (!member) continue;
    const memberLocation = placementOf(member);
    if (memberLocation !== "grid" && memberLocation !== "dock") {
      throw new UnactionableTargetError(describeRefusal(actionId, panelId, memberId, memberLocation));
    }
    if (destination === "dock" && !panelKindIsDockable(member.kind ?? "terminal")) {
      throw new UnactionableTargetError(
        memberId === panelId
          ? `${actionId}: panel "${panelId}" is a kind the dock cannot show.`
          : `${actionId}: panel "${panelId}" is grouped with "${memberId}", a kind the dock cannot show, and a group moves together.`
      );
    }
  }
  return false;
}

function describeRefusal(
  actionId: string,
  panelId: string,
  memberId: string,
  location: PanelLocation
): string {
  const reason =
    location === "trash"
      ? "is in the trash — restore it first"
      : location === "background"
        ? "is in the background — restore it first"
        : location === "overlay"
          ? "is an overlay panel, which places itself"
          : "is a dialog panel, owned by its dialog";
  return memberId === panelId
    ? `${actionId}: panel "${panelId}" ${reason}.`
    : `${actionId}: panel "${panelId}" is grouped with "${memberId}", which ${reason}.`;
}

/**
 * Read where the panel landed from committed state. The movers return nothing
 * useful, so the postcondition is the only honest answer; a move that left the
 * panel elsewhere fails rather than claiming the destination.
 */
export function confirmPlacement(
  actionId: string,
  panelId: string,
  destination: PlacementDestination,
  panel: PlacementPanel | undefined
): PanelPlacementResult {
  if (!panel || placementOf(panel) !== destination) {
    throw new Error(`${actionId}: panel "${panelId}" did not move to the ${destination}.`);
  }
  return { location: destination };
}
