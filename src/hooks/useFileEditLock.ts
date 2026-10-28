import { useState } from "react";
import { useDriveLeaseView } from "@/components/Recovery/driveLeaseState";
import { drivenElsewhereBy } from "@/hooks/useHostConnection";

/**
 * Whether a file pane may offer Edit while another screen drives this view's
 * project, whose host refuses a save from here (#13920). Edit isn't offered
 * then, except to keep what is already open: a standing draft, or an editor in
 * view when control was taken. That editor stays mounted, with whatever it
 * holds that isn't a draft yet (a composition, a keystroke not yet published),
 * until the pane leaves Edit.
 *
 * `editing` is whether the pane shows its editor with nobody else driving.
 */
export function useFileEditLock(
  editing: boolean,
  hasDraft: boolean
): { lockedBy: string | null; mayEdit: boolean } {
  const lockedBy = drivenElsewhereBy(useDriveLeaseView());
  const [seen, setSeen] = useState({ lockedBy, held: false });
  let held = seen.held && editing && lockedBy !== null;
  if (seen.lockedBy !== lockedBy) {
    held = lockedBy !== null && (seen.lockedBy === null ? editing : held);
  }
  if (seen.lockedBy !== lockedBy || seen.held !== held) setSeen({ lockedBy, held });
  return { lockedBy, mayEdit: lockedBy === null || hasDraft || held };
}
