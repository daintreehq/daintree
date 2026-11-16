import { PROJECT_SHELL_SOURCE } from "@shared/config/projectShell";

// Rewritten by projectShellChunkPlugin (scripts/lib/vite-project-shell.ts) to
// the emitted shell chunk's hashed file name. Kept in this module so it lands
// in the same chunk as the `import.meta.url` it resolves against, and passed as
// a binding rather than a literal so Vite's `new URL(…, import.meta.url)` asset
// handling leaves it alone.
const BUILT_SHELL_FILE = "__DAINTREE_PROJECT_SHELL_FILE__";

/**
 * Where `src/main.tsx` loads the project window's shell from: the source
 * module on the dev server, the shell's own chunk in a build.
 */
export const PROJECT_SHELL_URL: string = import.meta.env.DEV
  ? `/${PROJECT_SHELL_SOURCE}`
  : new URL(BUILT_SHELL_FILE, import.meta.url).href;
