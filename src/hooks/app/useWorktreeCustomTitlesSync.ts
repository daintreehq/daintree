import { useEffect } from "react";
import { startWorktreeCustomTitlesSync } from "@/store/worktreeFilterStore";

/**
 * Keeps this view's custom worktree titles in step with main's (#14022), and
 * hands main the ones kept in localStorage before it held any. Lives at the
 * app, not in the sidebar, so a collapsed sidebar still hears a rename made in
 * another window and plugins still get this project's titles.
 */
export function useWorktreeCustomTitlesSync(): void {
  useEffect(() => startWorktreeCustomTitlesSync(), []);
}
