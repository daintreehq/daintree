import { isLinux, isWindows } from "@/lib/platform";
import { buildDefaultKeybindings, KEYBINDING_PRIORITY } from "@shared/config/defaultKeybindings";

// The table itself lives in shared/config/defaultKeybindings.ts so the main
// process can derive native menu accelerators from the same source the
// renderer resolves against. This wrapper only binds the renderer's platform.
export const DEFAULT_KEYBINDINGS = buildDefaultKeybindings(isWindows(), isLinux());

export { KEYBINDING_PRIORITY };
