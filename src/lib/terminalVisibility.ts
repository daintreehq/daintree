import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";

// Carrier element from the legacy `panelsById` shape, sourced through
// `getNarrowPanel`'s parameter so this file doesn't import the deprecated
// `TerminalInstance` alias by name. Lets external callers that still hand
// out raw carrier entries pass through these predicates while the rest of
// the renderer migrates to `getNarrowPanel` (#8957).
type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

export function isTerminalOrphaned(terminal: CarrierPanel, worktreeIds: Set<string>): boolean {
  const worktreeId = typeof terminal.worktreeId === "string" ? terminal.worktreeId.trim() : "";
  if (!worktreeId) return false;
  if (worktreeIds.size === 0) return false;
  return !worktreeIds.has(worktreeId);
}

export function isTerminalVisible(
  terminal: CarrierPanel,
  isInTrash: (id: string) => boolean,
  worktreeIds: Set<string>
): boolean {
  if (isInTrash(terminal.id)) return false;
  if (terminal.location === "trash") return false;
  if (terminal.location === "background") return false;
  // Overlay panels (the Daintree Assistant) and dialog panels are never a
  // member of the visible terminal set — counts, switchers, and waiting lists
  // must skip them (#9699).
  if (terminal.location === "overlay") return false;
  if (terminal.location === "dialog") return false;
  // Not PTY-narrowed: `excludeFromPersistence` lives on the base panel shape,
  // and non-PTY panels (a file viewer presented as a dialog) carry it too.
  if (terminal.excludeFromPersistence === true) return false;
  if (isTerminalOrphaned(terminal, worktreeIds)) return false;
  return true;
}
