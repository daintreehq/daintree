import type { z } from "zod";

import { TerminalSnapshotSchema, filterValidTerminalEntries } from "../schemas/ipc.js";
import { panelKindHasPty } from "../../shared/config/panelKindRegistry.js";
import type { PanelKind } from "../../shared/types/panel.js";
import { inferKind } from "../../shared/utils/inferPanelKind.js";
import { resolveRespawnAgentId } from "../../shared/utils/savedAgentIdentity.js";

type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;

/**
 * The panels a project actually gets back when it opens: schema-valid snapshots
 * that aren't in the trash.
 *
 * Both restore paths — `handleAppHydrate` on startup and
 * `buildSwitchHydrateResult` on a switch — built this list inline, which meant
 * the definition of "what comes back" lived in two places that had to be kept
 * in step by hand. It now lives here, so the switcher's resume count (#11801)
 * is derived from the same predicate that builds the payload rather than a
 * lookalike that could drift away from it.
 */
export function filterRestorableTerminalSnapshots(
  terminals: unknown[] | null | undefined,
  context: string
): TerminalSnapshot[] {
  const validated = filterValidTerminalEntries(terminals, TerminalSnapshotSchema, context);
  return validated.filter((t) => t.location !== "trash");
}

/**
 * How many agent panels a project would bring back with it (#11801) — the
 * restorable set narrowed to entries that come back as a running agent.
 *
 * A panel qualifies on two counts, and both are load-bearing because the number
 * becomes a promise the row makes out loud:
 *
 * - It resolves to an agent identity, through the same
 *   {@link resolveRespawnAgentId} the respawn uses. Reading `launchAgentId`
 *   directly would undercount the oldest rows — the ones that most need the
 *   mark — because a legacy snapshot names its agent in `type` or `agentId`,
 *   or only in the title under the old `kind: "agent"` marker, and restore
 *   honours all of those.
 * - Its kind is one restore actually respawns a PTY for, resolved through the
 *   same {@link inferKind}. The schema permits launch metadata on every kind,
 *   so a browser or dev-preview panel can carry a stale agent id, and a legacy
 *   `assistant` snapshot is dropped by `panelRestorePhase` outright. Counting
 *   those announces agents that never arrive.
 *
 * Live process state is deliberately not consulted: it isn't what restores. The
 * resume command is built from the persisted snapshot alone, so a panel whose
 * agent exited between sessions still counts — reopening the project brings it
 * back. The one case this overstates is an agent that exits while the app keeps
 * running: its backend record survives with no PTY, and restore drops it by
 * design rather than resurrect a phantom idle panel. That row is live, not
 * dormant, so the mark is gated away from it in the common case.
 */
export function countResumableAgentPanels(
  terminals: unknown[] | null | undefined,
  context: string
): number {
  return filterRestorableTerminalSnapshots(terminals, context).filter((t) => {
    const kind = inferKind(t);
    // `assistant` is named explicitly rather than left to `panelKindHasPty`:
    // restore skips it by name, so the count has to skip it by name too or the
    // two drift the moment that kind's PTY-backing changes.
    if (kind === "assistant" || !panelKindHasPty(kind)) return false;
    // The raw `kind` is passed, not the inferred one: the title-based recovery
    // is scoped to the legacy `"agent"` marker, which inference collapses away.
    return resolveRespawnAgentId(t, t.kind as PanelKind | undefined) !== undefined;
  }).length;
}
