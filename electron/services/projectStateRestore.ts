import type { z } from "zod";

import { TerminalSnapshotSchema, filterValidTerminalEntries } from "../schemas/ipc.js";

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
 * restorable set narrowed to entries that carry a `launchAgentId`.
 *
 * `launchAgentId` is the whole test. A panel that has one is replayed through
 * the resume election in `panelRestorePhase`, which builds its resume command
 * from the persisted snapshot alone — so a panel whose agent has long since
 * exited still counts, because opening the project still brings it back. Live
 * process state is deliberately not consulted: it isn't what restores.
 *
 * Kind is not re-tested either. `TerminalSnapshotSchema` already refuses a
 * PTY-backed kind without a `cwd`, and adding a second `panelKindHasPty` gate
 * here would be a filter the restore payload itself doesn't apply — the count
 * would then promise fewer panels than actually come back.
 */
export function countResumableAgentPanels(terminals: unknown, context: string): number {
  return filterRestorableTerminalSnapshots(terminals, context).filter(
    (t) => t.launchAgentId !== undefined
  ).length;
}
