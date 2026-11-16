/**
 * Panes this view brought back from the trash with their focus already
 * decided (#17107). The host answers each restore with a "restored" event,
 * and those normally focus the pane; a batch undo has focused the one that
 * had focus, so each member's echo would otherwise take focus in whatever
 * order the host answered.
 */
const settled = new Set<string>();

export function settleRestoreFocus(id: string): void {
  settled.add(id);
}

/** Whether this restore's focus was settled here, consuming the mark. */
export function takeSettledRestoreFocus(id: string): boolean {
  return settled.delete(id);
}
