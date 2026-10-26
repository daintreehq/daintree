import { resolveWorktreePathScope } from "@shared/utils/path";
import { currentHostId, isRemoteWindow } from "@/hooks/useHostPlatform";
import { logWarn } from "@/utils/logger";

/**
 * A remote window's host serves only files inside the project, except one the
 * person opened from a terminal link or selection: tell the host about that
 * file before the viewer asks for it. Best effort; a refusal leaves the viewer
 * to say why it can't show the file. A file inside a worktree needs nothing,
 * so it costs no round trip.
 */
export async function grantClickedHostFile(absolutePath: string): Promise<void> {
  if (!isRemoteWindow()) return;
  const fileTransfer = window.electron?.fileTransfer;
  if (!fileTransfer?.grantClickedFile) return;
  // Lazy, as in FileLinksAddon: the worktree store's module graph reaches `@/clients`.
  const { getCurrentViewStoreOrNull } = await import("@/store/createWorktreeStore");
  const worktrees = getCurrentViewStoreOrNull()?.getState().worktrees;
  if (worktrees && resolveWorktreePathScope(absolutePath, worktrees.values())) return;
  try {
    await fileTransfer.grantClickedFile({ hostId: currentHostId(), hostPath: absolutePath });
  } catch (error) {
    logWarn("[clickedHostFile] The host refused a clicked file", {
      code: (error as { code?: unknown } | null)?.code,
    });
  }
}
