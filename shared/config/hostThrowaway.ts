/**
 * Where a host runs the throwaway agents a Shell's assistant starts on it
 * (#14445). The id is an opaque workspace id like the global assistant's: a
 * spawn naming it resolves to no Project, so it inherits none of one's
 * settings, presets, MCP servers or saved state, and nothing that sweeps
 * terminals by project counts its runs.
 */
export const HOST_THROWAWAY_WORKSPACE_ID = "daintree:host-throwaway";

/**
 * Folder under userData every run starts in, the same one each time, so an
 * agent's folder-trust answer given once holds for the next run.
 */
export const HOST_THROWAWAY_DIR_NAME = "throwaway-agents";

export function isHostThrowawayWorkspaceId(projectId: string | null | undefined): boolean {
  return projectId === HOST_THROWAWAY_WORKSPACE_ID;
}

/**
 * Every throwaway run's terminal id starts with this, so the pty-host, which
 * knows a terminal only by its id, never writes one's screen to disk.
 */
export const HOST_THROWAWAY_TERMINAL_PREFIX = "daintree-throwaway-";

export function isHostThrowawayTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(HOST_THROWAWAY_TERMINAL_PREFIX);
}
