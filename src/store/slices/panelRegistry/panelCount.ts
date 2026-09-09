/**
 * The one definition of "panels that count toward the panel limit".
 *
 * Three surfaces have to agree or the UI lies about the ceiling: the hard-limit
 * gate in `addPanel`, the batch preflight in `panelSpawning`, and the counter
 * `PanelPalette` renders against `hardLimit`. They previously each counted
 * "every non-trash panel" independently, which ignored `excludeFromPersistence`
 * despite that field's documented exclusion from "counts" — so the assistant
 * overlay silently consumed a limit slot, and a dialog-presented panel would
 * have too.
 */

/** A panel carrier entry — only the fields the count actually reads. */
import { panelKindHasPty } from "@shared/config/panelKindRegistry";

interface CountablePanel {
  location?: string;
  excludeFromPersistence?: boolean;
}

/** A panel as the client-metadata eligibility rule needs to see it. */
interface MetadataCandidatePanel extends CountablePanel {
  kind?: string;
  pluginId?: string;
}

/**
 * Panels an external MCP client may attach its own correlation record to
 * (#12340).
 *
 * Exactly the inverse of the plugin `extensionState` gate, so the two write
 * policies are disjoint by construction and the reserved key can never collide
 * with a bag a plugin owns. Ephemeral panels are excluded for the reason
 * `terminal.list` already excludes them: they are tooling-internal, and a
 * surface that cannot enumerate them must not be able to write to them either.
 *
 * It lives here rather than beside the setter because BOTH halves need it — the
 * listing gates its read on the same rule — and this module imports nothing, so
 * the action definitions can reach it without pulling the store's persistence
 * graph into every test that mocks `@/clients`.
 */
export function isClientMetadataEligible(panel: MetadataCandidatePanel | undefined): boolean {
  if (!panel) return false;
  // Asked of the registry rather than compared against `"terminal"`: what the
  // record attaches to is a terminal, and the registry is what decides which
  // kinds are one. A built-in PTY kind added later is eligible by construction.
  return (
    panelKindHasPty(panel.kind ?? "") && panel.pluginId === undefined && !isEphemeralPanel(panel)
  );
}

/**
 * Whether a panel occupies a slot against the panel limit.
 *
 * Trashed panels are pending TTL cleanup, and `excludeFromPersistence` panels
 * (the Daintree Assistant overlay, every `location: "dialog"` panel) are not
 * part of the user's working set — neither should push the user toward a
 * ceiling they can't see.
 */
export function countsTowardPanelLimit(panel: CountablePanel | undefined): boolean {
  if (!panel) return false;
  if (panel.location === "trash") return false;
  return !isEphemeralPanel(panel);
}

/**
 * Whether a panel is ephemeral — present in the registry but not part of the
 * user's working set of panels.
 *
 * Covers dialog-presented panels and anything flagged `excludeFromPersistence`
 * (the Daintree Assistant, tooling-internal terminals). Use this anywhere a
 * surface enumerates "the user's panels": counts, switchers, bulk actions,
 * close-all/kill-all targets, and MCP-facing listings.
 *
 * Location is checked intrinsically rather than relying on the flag alone: a
 * dialog panel is ephemeral by virtue of where it lives, and making that depend
 * on a caller remembering to stamp the flag would be a silent trap.
 *
 * Deliberately NOT PTY-narrowed. `excludeFromPersistence` moved onto the base
 * panel shape precisely because non-PTY panels (a file viewer presented as a
 * dialog) rely on it; an `isPtyPanel(...) &&` guard here would silently ignore
 * the flag for them.
 */
export function isEphemeralPanel(panel: CountablePanel | undefined): boolean {
  if (!panel) return false;
  return panel.location === "dialog" || panel.excludeFromPersistence === true;
}

/** Count the panels occupying a limit slot across a normalized panel map. */
export function countPanelsTowardLimit(
  panelsById: Record<string, CountablePanel | undefined>,
  panelIds: string[]
): number {
  let count = 0;
  for (const id of panelIds) {
    if (countsTowardPanelLimit(panelsById[id])) count++;
  }
  return count;
}
