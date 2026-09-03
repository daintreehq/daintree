/**
 * Terminal snapshot handlers - getSerializedState, getInfo.
 */

import { z } from "zod";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";
import { TerminalReplayHistoryPayloadSchema } from "../../../schemas/index.js";
import { logDebug, logInfo, logWarn } from "../../../utils/logger.js";
import { getAgentAvailabilityStore } from "../../../services/AgentAvailabilityStore.js";
import {
  buildTerminalInventory,
  consumeTerminalInventoryPrefetch,
} from "../../../services/terminalInventoryPrefetch.js";
import { markPerformance } from "../../../utils/performance.js";
import { PERF_MARKS } from "../../../../shared/perf/marks.js";
import { getProjectIdFromSenderUrl } from "../../senderIdentity.js";
import { defineIpcNamespace, op, opValidated } from "../../define.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import type { SerializedTerminalSnapshot } from "../../../../shared/types/terminal.js";

type ValidatedReplayHistoryPayload = z.output<typeof TerminalReplayHistoryPayloadSchema>;

/**
 * The workspace a reconnect request speaks for, resolved from the sender alone.
 *
 * `ctx.projectId` — the webContents→project registry, which spans every window
 * — is authoritative once the view is bound. But reconnect runs during cold-boot
 * hydration, and the startup-restore renderer issues it while `registerInitialView`
 * may not have bound the view yet: main dispatches `loadURL` without awaiting it,
 * then yields several times (PATH refresh, PTY readiness, store init) before
 * binding, and the renderer mounts and hydrates inside that gap. `?projectId=`
 * on that renderer's URL is the only sender-local identity there, and it is the
 * same fallback `app:boot` already resolves hydration's own workspace id through,
 * so the two agree by construction rather than by timing.
 *
 * Registry first: a bound view must never be overridden by a stale query string.
 *
 * Must be called before the first `await` — the context is a snapshot of the
 * sender at invoke time, and re-resolving after a PTY round-trip would race the
 * very binding this works around.
 */
function resolveSenderWorkspaceId(ctx: IpcContext): string | null {
  return ctx.projectId ?? getProjectIdFromSenderUrl(ctx.event.sender);
}

export function registerTerminalSnapshotHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }

  const handleTerminalGetSerializedState = async (
    terminalId: string
  ): Promise<SerializedTerminalSnapshot | null> => {
    try {
      if (typeof terminalId !== "string" || !terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const serializedState = await ptyClient.getSerializedStateAsync(terminalId);

      if (process.env.DAINTREE_VERBOSE) {
        logDebug(
          `terminal:getSerializedState(${terminalId}): ${serializedState ? `${serializedState.data.length} bytes @ ${serializedState.cols}x${serializedState.rows}` : "null"}`
        );
      }
      return serializedState;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get serialized terminal state");
      throw new Error(`Failed to get serialized terminal state: ${errorMessage}`);
    }
  };

  const handleTerminalGetSerializedStates = async (
    terminalIds: string[]
  ): Promise<Record<string, SerializedTerminalSnapshot | null>> => {
    if (!Array.isArray(terminalIds)) {
      throw new Error("Invalid terminal IDs: must be an array");
    }

    if (terminalIds.length > 256) {
      throw new Error("Invalid terminal IDs: maximum 256 IDs allowed");
    }

    const normalizedIds = Array.from(
      new Set(
        terminalIds.map((id) => {
          if (typeof id !== "string" || !id.trim()) {
            throw new Error("Invalid terminal ID in batch payload");
          }
          return id;
        })
      )
    );

    const results = await Promise.all(
      normalizedIds.map(async (terminalId) => {
        try {
          const serializedState = await ptyClient.getSerializedStateAsync(terminalId);
          return [terminalId, serializedState] as const;
        } catch (error) {
          logWarn(`terminal:getSerializedStates(${terminalId}) failed`, { error });
          return [terminalId, null] as const;
        }
      })
    );

    return Object.fromEntries(results);
  };

  const handleTerminalGetInfo = async (
    id: string
  ): Promise<import("../../../../shared/types/ipc.js").TerminalInfoPayload> => {
    try {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const terminalInfo = await ptyClient.getTerminalInfo(id);

      if (!terminalInfo) {
        throw new Error(`Terminal ${id} not found`);
      }

      return terminalInfo;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get terminal info");
      throw new Error(`Failed to get terminal info: ${errorMessage}`);
    }
  };

  const handleTerminalGetSharedBuffers = async (): Promise<{
    visualBuffers: SharedArrayBuffer[];
    signalBuffer: SharedArrayBuffer | null;
  }> => {
    try {
      return ptyClient.getSharedBuffers();
    } catch (error) {
      logWarn("Failed to get shared buffers", { error });
      return { visualBuffers: [], signalBuffer: null };
    }
  };

  const handleTerminalGetAnalysisBuffer = async (): Promise<SharedArrayBuffer | null> => {
    try {
      return ptyClient.getAnalysisBuffer();
    } catch (error) {
      logWarn("Failed to get analysis buffer", { error });
      return null;
    }
  };

  const handleTerminalReplayHistory = async ({
    terminalId,
    maxLines,
  }: ValidatedReplayHistoryPayload) => {
    try {
      const replayed = await ptyClient.replayHistoryAsync(terminalId, maxLines);

      logInfo(`terminal:replayHistory(${terminalId}): replayed ${replayed} lines`);
      return { replayed };
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to replay terminal history");
      throw new Error(`Failed to replay terminal history: ${errorMessage}`);
    }
  };

  const handleTerminalGetForProject = async (
    projectId: string
  ): Promise<import("../../../../shared/types/ipc.js").BackendTerminalInfo[]> => {
    try {
      if (typeof projectId !== "string" || !projectId) {
        throw new Error("Invalid project ID: must be a non-empty string");
      }

      // A cold switch starts this fetch the moment it reaches main; serving
      // the in-flight result here keeps the pty-host round trip off the
      // hydration critical path. A rejected prefetch falls back to a live one.
      const prefetched = consumeTerminalInventoryPrefetch(projectId);
      if (prefetched) {
        try {
          const terminals = await prefetched;
          markPerformance(PERF_MARKS.TERMINAL_INVENTORY_PREFETCH, { projectId, hit: true });
          return terminals;
        } catch {
          // fall through to a live fetch
        }
      }
      markPerformance(PERF_MARKS.TERMINAL_INVENTORY_PREFETCH, { projectId, hit: false });
      return await buildTerminalInventory(ptyClient, projectId);
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get terminals for project");
      throw new Error(`Failed to get terminals for project: ${errorMessage}`);
    }
  };

  const handleTerminalGetAvailable = async (): Promise<
    import("../../../../shared/types/ipc.js").BackendTerminalInfo[]
  > => {
    try {
      const terminals = await ptyClient.getAvailableTerminalsAsync();

      const sanitized = terminals
        .filter((t) => t.kind !== "dev-preview")
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          kind: t.kind,

          launchAgentId: t.launchAgentId,
          title: t.title,
          cwd: t.cwd,
          worktreeId: t.worktreeId,
          agentState: t.agentState,
          waitingReason: t.waitingReason,
          lastStateChange: t.lastStateChange,
          spawnedAt: t.spawnedAt,
          isTrashed: t.isTrashed,
          trashExpiresAt: t.trashExpiresAt,
          activityTier: t.activityTier,
          hasPty: t.hasPty,
          agentSessionId: t.agentSessionId,
          agentLaunchFlags: t.agentLaunchFlags,
          agentModelId: t.agentModelId,
          agentPresetId: t.agentPresetId,
          agentPresetColor: t.agentPresetColor,
          originalAgentPresetId: t.originalAgentPresetId,
          everDetectedAgent: t.everDetectedAgent,
          detectedAgentId: t.detectedAgentId,
          detectedProcessId: t.detectedProcessId,
        }));

      logInfo(`terminal:getAvailable: found ${sanitized.length} available terminals`);
      return sanitized;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get available terminals");
      throw new Error(`Failed to get available terminals: ${errorMessage}`);
    }
  };

  const handleTerminalGetByState = async (
    state: string
  ): Promise<import("../../../../shared/types/ipc.js").BackendTerminalInfo[]> => {
    try {
      if (typeof state !== "string" || !state) {
        throw new Error("Invalid state: must be a non-empty string");
      }

      const validStates = ["idle", "working", "waiting", "directing", "completed", "exited"];
      if (!validStates.includes(state)) {
        throw new Error(`Invalid state: must be one of ${validStates.join(", ")}`);
      }

      const terminals = await ptyClient.getTerminalsByStateAsync(
        state as import("../../../../shared/types/agent.js").AgentState
      );

      const sanitized = terminals
        .filter((t) => t.kind !== "dev-preview")
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          kind: t.kind,

          launchAgentId: t.launchAgentId,
          title: t.title,
          cwd: t.cwd,
          worktreeId: t.worktreeId,
          agentState: t.agentState,
          waitingReason: t.waitingReason,
          lastStateChange: t.lastStateChange,
          spawnedAt: t.spawnedAt,
          isTrashed: t.isTrashed,
          trashExpiresAt: t.trashExpiresAt,
          activityTier: t.activityTier,
          hasPty: t.hasPty,
          agentSessionId: t.agentSessionId,
          agentLaunchFlags: t.agentLaunchFlags,
          agentModelId: t.agentModelId,
          agentPresetId: t.agentPresetId,
          agentPresetColor: t.agentPresetColor,
          originalAgentPresetId: t.originalAgentPresetId,
          everDetectedAgent: t.everDetectedAgent,
          detectedAgentId: t.detectedAgentId,
          detectedProcessId: t.detectedProcessId,
        }));

      logInfo(`terminal:getByState(${state}): found ${sanitized.length} terminals`);
      return sanitized;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get terminals by state");
      throw new Error(`Failed to get terminals by state: ${errorMessage}`);
    }
  };

  const handleTerminalGetAll = async (): Promise<
    import("../../../../shared/types/ipc.js").BackendTerminalInfo[]
  > => {
    try {
      const terminals = await ptyClient.getAllTerminalsAsync();

      const sanitized = terminals
        .filter((t) => t.kind !== "dev-preview")
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          kind: t.kind,

          launchAgentId: t.launchAgentId,
          title: t.title,
          cwd: t.cwd,
          worktreeId: t.worktreeId,
          agentState: t.agentState,
          waitingReason: t.waitingReason,
          lastStateChange: t.lastStateChange,
          spawnedAt: t.spawnedAt,
          isTrashed: t.isTrashed,
          trashExpiresAt: t.trashExpiresAt,
          activityTier: t.activityTier,
          hasPty: t.hasPty,
          agentSessionId: t.agentSessionId,
          agentLaunchFlags: t.agentLaunchFlags,
          agentModelId: t.agentModelId,
          agentPresetId: t.agentPresetId,
          agentPresetColor: t.agentPresetColor,
          originalAgentPresetId: t.originalAgentPresetId,
          everDetectedAgent: t.everDetectedAgent,
          detectedAgentId: t.detectedAgentId,
          detectedProcessId: t.detectedProcessId,
        }));

      logInfo(`terminal:getAll: found ${sanitized.length} terminals`);
      return sanitized;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get all terminals");
      throw new Error(`Failed to get all terminals: ${errorMessage}`);
    }
  };

  const handleTerminalSearchSemanticBuffers = async (
    query: string,
    isRegex: boolean
  ): Promise<import("../../../../shared/types/ipc/terminal.js").SemanticSearchMatch[]> => {
    if (typeof query !== "string") {
      throw new Error("Invalid query: must be a string");
    }
    if (typeof isRegex !== "boolean") {
      throw new Error("Invalid isRegex: must be a boolean");
    }
    // Cap query length so a pathological regex can't lock up the pty-host
    // event loop scanning every terminal's buffer.
    if (query.length === 0 || query.length > 500) {
      return [];
    }
    try {
      return await ptyClient.searchSemanticBuffersAsync(query, isRegex);
    } catch (error) {
      logWarn("terminal:searchSemanticBuffers failed", { error });
      return [];
    }
  };

  /**
   * Probe one terminal on behalf of an already-resolved sender workspace.
   *
   * Split out so the bulk variant resolves the sender's identity once, up front,
   * instead of re-deriving it per id after an await has already elapsed.
   */
  const probeTerminalForWorkspace = async (
    senderWorkspaceId: string | null,
    terminalId: string
  ): Promise<import("../../../../shared/types/ipc.js").TerminalReconnectResult> => {
    try {
      if (typeof terminalId !== "string" || !terminalId) {
        throw new Error("Invalid terminal ID: must be a non-empty string");
      }

      const terminal = await ptyClient.getTerminalAsync(terminalId);

      if (!terminal) {
        logWarn(`terminal:reconnect: Terminal ${terminalId} not found`);
        return { exists: false };
      }

      // Ownership gate (#11652). Terminal ids are globally unique, so an id
      // alone resolved a terminal in ANY project — and the result carries the
      // live `projectId`/`cwd`, which the renderer trusts over its own saved
      // snapshot. A foreign id in a project's saved state (#11651) therefore
      // let that project adopt another's running terminal.
      //
      // Null is an identity here, not a wildcard: an unbound window (Cmd+N,
      // project picker) still reconnects its own projectless terminal, but it
      // cannot reach a project-owned one, and a project-bound sender cannot
      // reach an unowned one.
      //
      // `conflict` marks this as "live, but not yours" rather than plain "not
      // found". Both withhold every field, but restore reuses the saved id when
      // a terminal is merely gone — and that id is still live here, so reusing
      // it would re-place the owner's PTY in PtyClient.terminalOwners before the
      // host could reject the duplicate. The flag makes restore mint a fresh id
      // instead, exactly as it already does for a timed-out reconnect.
      const ownerWorkspaceId = terminal.projectId ?? null;
      if (ownerWorkspaceId !== senderWorkspaceId) {
        logWarn(`terminal:reconnect: refusing ${terminalId} — owned by another workspace`, {
          terminalId,
          ownerWorkspaceId,
          senderWorkspaceId,
        });
        return { exists: false, conflict: true };
      }

      if (getAgentAvailabilityStore().isHelpTerminal(terminal.id)) {
        logInfo(`terminal:reconnect: Skipping help terminal ${terminalId}`);
        return { exists: false };
      }

      logInfo(`terminal:reconnect: Reconnecting to ${terminalId}`);

      return {
        exists: true,
        id: terminal.id,
        projectId: terminal.projectId,
        kind: terminal.kind,

        launchAgentId: terminal.launchAgentId,
        title: terminal.title,
        titleMode: terminal.titleMode,
        cwd: terminal.cwd,
        // Same contract as getForProject: the fallback restore path rebuilds
        // its xterm on the live PTY grid rather than the 80×24 default.
        ptyCols: terminal.ptyCols,
        ptyRows: terminal.ptyRows,
        agentState: terminal.agentState,
        waitingReason: terminal.waitingReason,
        lastStateChange: terminal.lastStateChange,
        spawnedAt: terminal.spawnedAt,
        activityTier: terminal.activityTier,
        hasPty: terminal.hasPty,
        agentSessionId: terminal.agentSessionId,
        agentLaunchFlags: terminal.agentLaunchFlags,
        agentModelId: terminal.agentModelId,
        agentPresetId: terminal.agentPresetId,
        agentPresetColor: terminal.agentPresetColor,
        originalAgentPresetId: terminal.originalAgentPresetId,
        everDetectedAgent: terminal.everDetectedAgent,
        detectedAgentId: terminal.detectedAgentId,
        detectedProcessId: terminal.detectedProcessId,
      };
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to reconnect to terminal");
      throw new Error(`Failed to reconnect to terminal: ${errorMessage}`);
    }
  };

  const handleTerminalReconnect = async (
    ctx: IpcContext,
    terminalId: string
  ): Promise<import("../../../../shared/types/ipc.js").TerminalReconnectResult> =>
    probeTerminalForWorkspace(resolveSenderWorkspaceId(ctx), terminalId);

  // Bulk variant for the cold-boot panel-restore prefetch (#10390): one IPC
  // round-trip probes every saved panel id instead of N serialized probes
  // inside the spawn queue. Mirrors getSerializedStates' batch contract —
  // per-id failures degrade to { exists: false } rather than failing the batch.
  const handleTerminalReconnectBulk = async (
    ctx: IpcContext,
    terminalIds: string[]
  ): Promise<Record<string, import("../../../../shared/types/ipc.js").TerminalReconnectResult>> => {
    // Resolved once, before any await: every id in this batch is judged against
    // the sender as it was at invoke time.
    const senderWorkspaceId = resolveSenderWorkspaceId(ctx);

    if (!Array.isArray(terminalIds)) {
      throw new Error("Invalid terminal IDs: must be an array");
    }

    if (terminalIds.length > 256) {
      throw new Error("Invalid terminal IDs: maximum 256 IDs allowed");
    }

    const normalizedIds = Array.from(
      new Set(
        terminalIds.map((id) => {
          if (typeof id !== "string" || !id.trim()) {
            throw new Error("Invalid terminal ID in batch payload");
          }
          return id;
        })
      )
    );

    const results = await Promise.all(
      normalizedIds.map(async (terminalId) => {
        try {
          return [
            terminalId,
            await probeTerminalForWorkspace(senderWorkspaceId, terminalId),
          ] as const;
        } catch (error) {
          logWarn(`terminal:reconnect-bulk(${terminalId}) failed`, { error });
          return [terminalId, { exists: false as const }] as const;
        }
      })
    );

    return Object.fromEntries(results);
  };

  const namespace = defineIpcNamespace({
    name: "terminalSnapshots",
    ops: {
      getSerializedState: op(
        CHANNELS.TERMINAL_GET_SERIALIZED_STATE,
        handleTerminalGetSerializedState
      ),
      getSerializedStates: op(
        CHANNELS.TERMINAL_GET_SERIALIZED_STATES,
        handleTerminalGetSerializedStates
      ),
      getInfo: op(CHANNELS.TERMINAL_GET_INFO, handleTerminalGetInfo),
      getSharedBuffers: op(CHANNELS.TERMINAL_GET_SHARED_BUFFERS, handleTerminalGetSharedBuffers),
      getAnalysisBuffer: op(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER, handleTerminalGetAnalysisBuffer),
      replayHistory: opValidated(
        CHANNELS.TERMINAL_REPLAY_HISTORY,
        TerminalReplayHistoryPayloadSchema,
        handleTerminalReplayHistory
      ),
      getForProject: op(CHANNELS.TERMINAL_GET_FOR_PROJECT, handleTerminalGetForProject),
      getAvailable: op(CHANNELS.TERMINAL_GET_AVAILABLE, handleTerminalGetAvailable),
      getByState: op(CHANNELS.TERMINAL_GET_BY_STATE, handleTerminalGetByState),
      getAll: op(CHANNELS.TERMINAL_GET_ALL, handleTerminalGetAll),
      searchSemanticBuffers: op(
        CHANNELS.TERMINAL_SEARCH_SEMANTIC_BUFFERS,
        handleTerminalSearchSemanticBuffers
      ),
      reconnect: op(CHANNELS.TERMINAL_RECONNECT, handleTerminalReconnect, { withContext: true }),
      reconnectBulk: op(CHANNELS.TERMINAL_RECONNECT_BULK, handleTerminalReconnectBulk, {
        withContext: true,
      }),
    },
  });

  return namespace.register();
}
