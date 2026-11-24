/**
 * The project window's shell: everything only a project view evaluates (the
 * panel registry, store orchestration, the worktree store context, App). The
 * renderer entry (`src/main.tsx`) is shared by every window role, so the build
 * emits the shell as a chunk of its own and the entry loads it only for a
 * project view (`scripts/lib/vite-project-shell.ts`).
 *
 * Root-relative source path, matching its Vite manifest key.
 */
export const PROJECT_SHELL_SOURCE = "src/projectWindow/projectShell.tsx";

/** Stable name of the emitted shell chunk (its file is `project-shell-<hash>.js`). */
export const PROJECT_SHELL_CHUNK_NAME = "project-shell";
