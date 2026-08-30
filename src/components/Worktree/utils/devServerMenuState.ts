import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { isLiveDevServerStatus } from "@/lib/worktreeFilters";
import type { WorktreeDevServerMenuState } from "../WorktreeMenuItems";

/**
 * What the worktree menu can truthfully offer for a worktree's dev server.
 *
 * The subtlety is `stopped`, which is ambiguous. `stopAndRemoveSession`
 * broadcasts `stopped` and THEN deletes the session (panel closed, project
 * hibernated, worktree deleted), while the renderer cache deliberately retains
 * the last snapshot — so a stopped record may describe a session the main
 * process no longer has. `restartByWorktree` then finds neither a live session
 * nor a restore manifest and returns an empty placeholder without spawning,
 * which is exactly the silent no-op row this redesign set out to remove.
 *
 * `panelExists` is the discriminator: of the three removal paths, only "panel
 * closed" leaves the card rendered to be misled by its own stale snapshot.
 * `restored-stopped` needs no panel — the service keeps a restore manifest for
 * precisely that case.
 */
export function devServerMenuState(
  session: DevPreviewSessionState | undefined,
  panelExists: boolean
): WorktreeDevServerMenuState {
  if (!session) return "none";
  // "Live" is the app-wide reading of the term, which counts `error`: a
  // readiness timeout leaves the process running, so Stop still has something
  // to stop. `stopping` joins it — a session being torn down is not something
  // to offer a start for.
  if (isLiveDevServerStatus(session.status) || session.status === "stopping") return "running";
  if (session.status === "restored-stopped") return "restorable";
  if (session.status === "stopped" && panelExists) return "restorable";
  return "none";
}
