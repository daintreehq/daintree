import type { TerminalInfo } from "../services/pty/types.js";
import { isTerminalAgentLive } from "../services/pty/agentLiveness.js";
import type { RendererConnection } from "./handlers/types.js";

export interface AnsweringViewDeps {
  getTerminal: (id: string) => TerminalInfo | undefined;
  rendererConnections: ReadonlyMap<number, RendererConnection>;
  windowProjectMap: ReadonlyMap<number, string | null>;
  fallbackEligibleProjects: ReadonlySet<string>;
  frozenViewProjects: ReadonlySet<string>;
  /** Whether input from this port connection would reach the terminal. */
  mayDriveFrom: (terminalId: string, connectionId: number) => boolean;
  /** Whether input from this machine's own views would reach the terminal. */
  mayDriveLocally: (terminalId: string) => boolean;
}

/**
 * Whether some view is parsing a terminal's live output and may write to it,
 * so its xterm.js answers the program's queries and the headless mirror must
 * not answer them again (#18185).
 *
 * A port counts only when it is scoped to the terminal's own project: a
 * window with no project yet (a project picker) is routed every terminal's
 * bytes but hydrates none of them, so nothing there parses them. A remote
 * endpoint counts only while its client is there to read; its bridge keeps
 * the port open while the client is away. Views off the port path parse what
 * the IPC fallback brings them, unless every one may be frozen, when the
 * router skips a plain terminal's copies altogether.
 */
export function createAnsweringViewProbe(deps: AnsweringViewDeps): (terminalId: string) => boolean {
  const {
    getTerminal,
    rendererConnections,
    windowProjectMap,
    fallbackEligibleProjects,
    frozenViewProjects,
    mayDriveFrom,
    mayDriveLocally,
  } = deps;

  return (terminalId) => {
    const terminal = getTerminal(terminalId);
    const projectId = terminal?.projectId ?? null;
    if (terminal === undefined || projectId === null) return false;

    for (const [connectionId, connection] of rendererConnections) {
      if (windowProjectMap.get(connectionId) !== projectId) continue;
      if (connection.clientAway === true) continue;
      if (mayDriveFrom(terminalId, connectionId)) return true;
    }

    if (!fallbackEligibleProjects.has(projectId)) return false;
    if (frozenViewProjects.has(projectId) && !isTerminalAgentLive(terminal)) return false;
    return mayDriveLocally(terminalId);
  };
}
