import {
  openInstallCommandInTerminal,
  type InstallTarget,
} from "@/services/terminal/installCommandHandoff";
import { useHomeTerminalPlacement } from "./useHomeTerminalPlacement";

export type InstallCommandRunner = (line: string, target: InstallTarget) => void;

/**
 * Opens an install command in a new terminal of this window's grid, typed but
 * not run. Null while there is no grid to open one in (no project or scratch),
 * so a surface shows the command as copy-only until there is.
 */
export function useInstallCommandRunner(): InstallCommandRunner | null {
  const placement = useHomeTerminalPlacement();
  if (!placement.ready) return null;
  const { cwd, worktreeId } = placement;
  return (line, target) => {
    void openInstallCommandInTerminal({ line, target, cwd, worktreeId });
  };
}
