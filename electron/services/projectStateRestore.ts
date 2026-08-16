import type { z } from "zod";

import { TerminalSnapshotSchema, filterValidTerminalEntries } from "../schemas/ipc.js";
import { panelKindHasPty } from "../../shared/config/panelKindRegistry.js";
import { inferKind } from "../../shared/utils/inferPanelKind.js";

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
  terminals: unknown,
  context: string
): TerminalSnapshot[] {
  const validated = filterValidTerminalEntries(terminals, TerminalSnapshotSchema, context);
  return validated.filter((t) => t.location !== "trash");
}

/**
 * How many agent panels a project would bring back with it (#11801) — the
 * restorable set narrowed to entries that come back as a running agent.
 *
 * A panel qualifies when it carries a `launchAgentId` AND its kind is one that
 * restore actually respawns a PTY for. Both halves are load-bearing, because
 * the count is a promise the row makes out loud:
 *
 * - `launchAgentId` alone is not enough. The schema permits it on every kind,
 *   so a browser or dev-preview panel can carry stale launch metadata, and a
 *   legacy `assistant` snapshot is dropped by `panelRestorePhase` outright.
 *   Counting those announces agents that never arrive.
 * - Kind is resolved through the same {@link inferKind} the restore path uses,
 *   rather than read off the field, so the two agree about a snapshot whose
 *   `kind` is absent or written in a legacy spelling.
 *
 * Live process state is deliberately not consulted: it isn't what restores. The
 * resume command is built from the persisted snapshot alone, so a panel whose
 * agent exited long ago still counts — opening the project still brings it
 * back.
 */
export function countResumableAgentPanels(terminals: unknown, context: string): number {
  return filterRestorableTerminalSnapshots(terminals, context).filter((t) => {
    if (t.launchAgentId === undefined) return false;
    const kind = inferKind(t);
    // `assistant` is named explicitly rather than left to `panelKindHasPty`:
    // restore skips it by name, so the count has to skip it by name too or the
    // two drift the moment that kind's PTY-backing changes.
    return kind !== "assistant" && panelKindHasPty(kind);
  }).length;
}
