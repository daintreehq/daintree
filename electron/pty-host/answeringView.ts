import type { TerminalInfo } from "../services/pty/types.js";
import { isTerminalAgentLive } from "../services/pty/agentLiveness.js";
import type { RendererConnection, TerminalWorkerConnection } from "./handlers/types.js";

export interface AnsweringViewDeps {
  getTerminal: (id: string) => TerminalInfo | undefined;
  rendererConnections: ReadonlyMap<number, RendererConnection>;
  terminalWorkerConnections: ReadonlyMap<number, ReadonlyMap<string, TerminalWorkerConnection>>;
  windowProjectMap: ReadonlyMap<number, string | null>;
  fallbackEligibleProjects: ReadonlySet<string>;
  frozenViewProjects: ReadonlySet<string>;
  /** Whether input from this port connection would reach the terminal. */
  mayDriveFrom: (terminalId: string, connectionId: number) => boolean;
  /** Whether input from this machine's own views would reach the terminal. */
  mayDriveLocally: (terminalId: string) => boolean;
  /** Whether the latest chunk for the terminal's cached views was skipped rather than sent. */
  isHiddenCopySkipped: (terminalId: string) => boolean;
}

/**
 * Whether some view is parsing a terminal's live output and may write to it,
 * so its xterm.js answers the program's queries and the headless mirror must
 * not answer them again (#18185).
 *
 * A port counts only when it is scoped to exactly the terminal's project: a
 * window with no project yet (a project picker) is routed every terminal's
 * bytes but hydrates none of a project's, while a projectless terminal is
 * shown by the unbound window it belongs to. A remote endpoint counts only
 * while its client is there to read, since its bridge keeps the port open
 * while the client is away, and a window whose renderer moved the terminal
 * onto a parse worker doesn't count, since that worker answers nothing.
 * Views off the port path parse what the IPC fallback brings them, unless
 * every one may be frozen or their copies are being skipped, when the router
 * sends them nothing to answer.
 */
export function createAnsweringViewProbe(deps: AnsweringViewDeps): (terminalId: string) => boolean {
  const {
    getTerminal,
    rendererConnections,
    terminalWorkerConnections,
    windowProjectMap,
    fallbackEligibleProjects,
    frozenViewProjects,
    mayDriveFrom,
    mayDriveLocally,
    isHiddenCopySkipped,
  } = deps;

  return (terminalId) => {
    const terminal = getTerminal(terminalId);
    if (terminal === undefined) return false;
    const projectId = terminal.projectId ?? null;

    for (const [connectionId, connection] of rendererConnections) {
      if (windowProjectMap.get(connectionId) !== projectId) continue;
      if (connection.clientAway === true) continue;
      if (terminalWorkerConnections.get(connectionId)?.get(terminalId)?.engaged === true) continue;
      if (mayDriveFrom(terminalId, connectionId)) return true;
    }

    if (projectId === null || !fallbackEligibleProjects.has(projectId)) return false;
    if (frozenViewProjects.has(projectId) && !isTerminalAgentLive(terminal)) return false;
    if (isHiddenCopySkipped(terminalId)) return false;
    return mayDriveLocally(terminalId);
  };
}
