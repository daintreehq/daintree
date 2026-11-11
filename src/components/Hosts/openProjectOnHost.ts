import { notify } from "@/lib/notify";
import type { MenuActionSourceValue } from "@/components/ui/menu-source";
import { logWarn } from "@/utils/logger";
import { actionService } from "@/services/ActionService";

/**
 * Opens the switch dialog to go to the host's copy of the project as it is,
 * matched by its remotes, or to set one up there. The branch is left alone:
 * "Continue this branch on…" is what hands a branch over.
 */
export async function openProjectOnHost(
  hostId: string,
  projectId: string,
  newWindow: boolean,
  source: MenuActionSourceValue
): Promise<void> {
  const result = await actionService.dispatch(
    "project.openOnHost",
    { hostId, projectId, newWindow, navigateOnly: true },
    { source }
  );
  if (result.ok) return;
  logWarn("[Hosts] Opening a project on another host failed", { error: result.error });
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({
    type: "error",
    context: { eventKind: "connectivity" },
    title: "Couldn't open project on host",
    message: "The host switch dialog couldn't open. Try again from the host menu.",
  });
}
