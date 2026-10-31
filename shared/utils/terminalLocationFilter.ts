/**
 * The `location` filter `terminal.list` and `terminal.getStatus` take, shared by
 * the view, the windowless host and the MCP merge of host-started panes so the
 * three can't disagree about which panes a call covers (#15732).
 *
 * `"all"` is a filter, never a place a panel sits: each row still reports its
 * own location. Omitted, the trash and the background are left out.
 */
export const TERMINAL_LOCATION_FILTERS = ["grid", "dock", "trash", "background", "all"] as const;

export type TerminalLocationFilter = (typeof TERMINAL_LOCATION_FILTERS)[number];

export function matchesTerminalLocationFilter(
  location: string | undefined,
  filter: TerminalLocationFilter | undefined
): boolean {
  if (filter === "all") return true;
  if (filter !== undefined) return location === filter;
  return location !== "trash" && location !== "background";
}
