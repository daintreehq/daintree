import type { AddTerminalArgs, SavedTerminalData } from "./statePatcher";

/**
 * Re-parks a panel that was saved in the background. The builders resolve a
 * grid/dock placement from the snapshot; a parked panel is born back in the
 * background instead, with the restore target it was saved with, so its live
 * PTY is neither mounted nor re-adopted as a grid orphan.
 */
export function parkIfSavedInBackground(args: AddTerminalArgs, saved: SavedTerminalData): void {
  if (saved.location !== "background") return;
  args.location = "background";
  args.backgroundRestoreLocation = saved.backgroundRestoreLocation === "dock" ? "dock" : "grid";
}
