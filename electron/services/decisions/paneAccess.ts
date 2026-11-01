import type { PaneAuthenticator, PaneIdentity, QuestionOrigin } from "@daintreehq/decisions-client";
import type { NotifyTerminalInfo } from "../mcp-server/terminalNotify.js";
import { incarnationOf, type DecisionGenerationReader } from "./decisionWake.js";

/** What a pane bearer was minted for, as the pane config service holds it. */
export interface PaneBearer {
  paneId: string;
  principal: string;
  /** The project the pane's launch bound its MCP calls to, when it bound one (#12486). */
  workspaceId?: string;
}

/** The pane record's fields a question's origin is taken from. */
export type PaneTerminalInfo = Pick<
  NotifyTerminalInfo,
  | "projectId"
  | "detectedAgentId"
  | "launchAgentId"
  | "hasPty"
  | "isTrashed"
  | "isExited"
  | "launchGeneration"
  | "agentIncarnation"
  | "agentSessionId"
  | "worktreeId"
> & { cwd?: string; isAssistantTerminal?: boolean };

export interface PaneTerminalReader extends DecisionGenerationReader {
  getTerminalAsync(
    id: string,
    submissionToken: undefined,
    options: { strict: true }
  ): Promise<PaneTerminalInfo | null>;
}

export interface PaneAccessSources {
  /**
   * The pane a bearer belongs to, from the live pane-token map; null for any
   * other token. Help and API-key tokens are never in that map.
   */
  bearerFor(token: string): PaneBearer | null;
  /** The pane's current ownership principal; null while it holds no bearer. */
  principalFor(paneId: string): string | null;
  /** This machine's Decisions host id; null before a relay identity exists. */
  hostId(): string | null;
  getPtyClient(): PaneTerminalReader | null;
}

export interface PaneAccess {
  authenticator: PaneAuthenticator;
  /** Whether `pane` is still exactly the run it was authenticated as. */
  isCurrent(pane: PaneIdentity): boolean;
}

/**
 * Who may use `/mcp/decisions` (#16011): an agent pane holding a live pane
 * bearer, and nothing else. The question's origin comes from the bearer and
 * the pane's own record, never from the request: host, pane, launch
 * generation, ownership principal, agent incarnation and session, project and
 * worktree. A bearer that can't be tied to one exact, running run is refused
 * (401). A pane record that couldn't be read in time throws, which the handler
 * answers 500, so a slow host isn't taken for a bad credential.
 */
export function createPaneAccess(sources: PaneAccessSources): PaneAccess {
  const isCurrent = (pane: PaneIdentity): boolean => {
    if (sources.hostId() !== pane.host_id) return false;
    if (sources.principalFor(pane.pane_id) !== pane.ownership_principal) return false;
    const client = sources.getPtyClient();
    return (
      client !== null &&
      client.getLiveGeneration(pane.pane_id) === pane.terminal_generation &&
      client.isLiveGeneration(pane.pane_id, pane.terminal_generation)
    );
  };

  const authenticate = async (token: string): Promise<{ origin: QuestionOrigin } | null> => {
    const bearer = sources.bearerFor(token);
    const hostId = sources.hostId();
    if (bearer === null || hostId === null) return null;
    const client = sources.getPtyClient();
    if (client === null) throw new Error("No terminal host to read the pane from");
    const generation = client.getLiveGeneration(bearer.paneId);
    if (generation === null || !client.isLiveGeneration(bearer.paneId, generation)) return null;
    const info = await client.getTerminalAsync(bearer.paneId, undefined, { strict: true });
    const origin = info === null ? null : originOf(hostId, bearer, generation, info);
    if (origin === null) return null;
    // The pane may have exited, relaunched or lost its bearer while it was read.
    const after = sources.bearerFor(token);
    if (after?.paneId !== bearer.paneId || after.principal !== bearer.principal) return null;
    return isCurrent(origin) ? { origin } : null;
  };

  return { authenticator: { authenticate }, isCurrent };
}

function originOf(
  hostId: string,
  bearer: PaneBearer,
  generation: number,
  info: PaneTerminalInfo
): QuestionOrigin | null {
  if (info.isExited === true || info.hasPty === false || info.isTrashed === true) return null;
  // The Assistant is reached through its own tools, never as an agent pane.
  if (info.isAssistantTerminal === true) return null;
  if (info.launchGeneration !== undefined && info.launchGeneration !== generation) return null;
  const incarnation = incarnationOf(info);
  const agentKind = info.detectedAgentId ?? info.launchAgentId;
  const projectId = info.projectId;
  const worktreeId = info.worktreeId;
  if (incarnation === null || !agentKind || !projectId || !worktreeId) return null;
  // A pane's calls belong to the project it was launched in, for its whole life.
  if (bearer.workspaceId !== undefined && bearer.workspaceId !== projectId) return null;
  return {
    host_id: hostId,
    pane_id: bearer.paneId,
    terminal_generation: generation,
    ownership_principal: bearer.principal,
    agent_incarnation: incarnation,
    agent_kind: agentKind,
    agent_session_id: info.agentSessionId ?? null,
    project_id: projectId,
    worktree_id: worktreeId,
    // The directory the pane was launched in: local only, never sent.
    worktree_root: info.cwd ?? "",
    // The origin's gate is trusted policy, so it is never the agent's to name.
    workflow_gate_id: null,
  };
}
