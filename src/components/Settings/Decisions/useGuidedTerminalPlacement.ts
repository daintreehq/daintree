import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { useHomeTerminalPlacement } from "@/hooks/terminal/useHomeTerminalPlacement";

export type GuidedTerminalPlacement =
  | { ready: true; cwd: string; worktreeId: string | undefined }
  | { ready: false; reason?: "remote" | "no-project" };

/**
 * Where a guided decisions CLI pane (a relay deploy or removal) would go, or
 * why it can't go anywhere this window shows. It runs from the home folder in
 * the grid being looked at.
 */
export function useGuidedTerminalPlacement(): GuidedTerminalPlacement {
  const placement = useHomeTerminalPlacement();
  // Its terminals run on the Host, which reaches neither this browser's Cloudflare sign-in nor main.
  if (isRemoteWindow()) return { ready: false, reason: "remote" };
  return placement;
}
