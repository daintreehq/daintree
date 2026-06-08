/**
 * Merge the global + project environment variables for a PTY-pool warm hint.
 *
 * On session restore the pty-host needs to predictively warm (panelCwd,
 * projectEnvHash) slots in addition to the env-empty (panelCwd) slots warmed
 * by #9774. The hash is computed in the pty-host from the merged env, so this
 * module only produces the merged env payload — no hashing here (#9810).
 *
 * Pure: no I/O, no side effects. Easy to unit test in isolation. The pty-host
 * treats `null` as "fall back to the env-empty warm path" (no per-cwd envHash
 * key to warm).
 */
export function mergeProjectEnv(
  globalEnv: Record<string, string> | undefined,
  projectEnv: Record<string, string> | undefined
): Record<string, string> | null {
  const global = globalEnv ?? {};
  const project = projectEnv ?? {};

  if (Object.keys(global).length === 0 && Object.keys(project).length === 0) {
    return null;
  }

  // Project keys intentionally override global keys on collision — the project
  // layer is the more specific scope, mirroring how the spawn path applies
  // `options.env` on top of the filtered process env in
  // `buildTerminalEnv` (terminalSpawn.ts:88-93).
  return { ...global, ...project };
}
