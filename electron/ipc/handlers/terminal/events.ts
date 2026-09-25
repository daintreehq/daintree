/**
 * Terminal event handlers - forwards events to renderer.
 */

import { CHANNELS } from "../../channels.js";
import {
  broadcastToProjectRenderers,
  broadcastToProjectRenderersExcept,
  broadcastToRenderer,
} from "../../utils.js";
import { resolveLiveWebContents } from "../../../window/webContentsRegistry.js";
import { logInfo, logWarn } from "../../../utils/logger.js";
import { events, type DaintreeEventMap } from "../../../services/events.js";
import { mcpPaneConfigService } from "../../../services/McpPaneConfigService.js";
import { getMcpServerServiceRef } from "../../../window/serviceRefs.js";
import {
  acceptCapturedAgentSession,
  releaseSupersededCapturedSession,
} from "../../../services/pty/agentSessionCapturePersistence.js";
import type {
  SpawnResult,
  TerminalResizeResult,
  BroadcastWriteResultPayload,
  FdGrowthPayload,
  TerminalSubmitStatusPayload,
} from "../../../../shared/types/pty-host.js";
import type { PtyDataRouting } from "../../../services/pty/types.js";
import {
  setSpawnConfirmationTimeoutHandler,
  settleSpawnConfirmation,
} from "./spawnConfirmation.js";
import type { HandlerDependencies } from "../../types.js";

export function registerTerminalEventHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }
  const handlers: Array<() => void> = [];

  // PTY data/exit/error events. `terminal:data` stays on its dedicated channel
  // (high-frequency binary — keeping it off the event bus avoids envelope overhead
  // and JSON/base64 churn; see lessons #4899/#4862/#4639). Project-scoped: only
  // the owning project's views host a panel for the terminal, and its cached
  // views must still get every byte, since there is no resync on reactivation.
  const handlePtyData = (id: string, data: string | Uint8Array, routing?: PtyDataRouting) => {
    // Recovery for one view whose port threw mid-flush (#12557). Every other
    // destination already has these bytes, so this goes to that view alone — a
    // re-broadcast would double-deliver to the siblings that took it on their
    // own ports and to the port-less views the supplementary fallback already
    // fed. The host names the view by the identity Main gave it at connect
    // time, so a project switch completing in between cannot redirect it.
    if (routing?.portRecoveryWebContentsId !== undefined) {
      const holder = resolveLiveWebContents(routing.portRecoveryWebContentsId);
      if (!holder) return;
      try {
        holder.send(CHANNELS.TERMINAL_DATA, id, data);
      } catch {
        // Renderer disposed mid-send; the port teardown already ran.
      }
      return;
    }

    // The host only sends this list when it deliberately kept the fallback open
    // for a view its MessagePort routing cannot reach (#12557). These views
    // already have the chunk; every other view of the project — cached and
    // mid-handoff ones included — still needs it. The ids are the recipients
    // the host actually wrote to, so no re-derivation can go stale here.
    const delivered = routing?.portDeliveredWebContentsIds;
    const exclude = delivered && delivered.length > 0 ? new Set(delivered) : null;
    broadcastToProjectRenderersExcept(
      ptyClient.getTerminalProjectId(id),
      exclude,
      CHANNELS.TERMINAL_DATA,
      id,
      data
    );
  };
  ptyClient.on("data", handlePtyData);
  handlers.push(() => ptyClient.off("data", handlePtyData));

  const handlePtyExit = (id: string, exitCode: number) => {
    settleSpawnConfirmation(id);
    // Best-effort: revoke any per-pane MCP token + delete the managed config
    // file. Idempotent — no-ops if no pane config was minted for this terminal.
    mcpPaneConfigService.revokePaneConfig(id).catch((err) => {
      console.error("[MCP] Failed to revoke pane config on exit:", err);
    });
    // A hand-over ends with the terminal that was handed over (#12490). The
    // orchestrator's side ends with its bearer, which the revocation above
    // covers. Unloaded means nothing was ever handed over.
    getMcpServerServiceRef()?.handleTerminalExit(id);
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "terminal:exit",
      payload: [id, exitCode],
    });
  };
  ptyClient.on("exit", handlePtyExit);
  handlers.push(() => ptyClient.off("exit", handlePtyExit));

  const handlePtyError = (id: string, error: string) => {
    broadcastToRenderer(CHANNELS.TERMINAL_ERROR, id, error);
  };
  ptyClient.on("error", handlePtyError);
  handlers.push(() => ptyClient.off("error", handlePtyError));

  // Submit-lane status (#11875). Project-scoped for the same reason as
  // `terminal:status` below: only views of the owning project host a panel for
  // this terminal, so don't pay a clone + IPC task per unrelated view.
  const handleSubmitStatus = (payload: TerminalSubmitStatusPayload) => {
    broadcastToProjectRenderers(ptyClient.getTerminalProjectId(payload.id), CHANNELS.EVENTS_PUSH, {
      name: "terminal:submit-status",
      payload,
    });
  };
  ptyClient.on("submit-status", handleSubmitStatus);
  handlers.push(() => ptyClient.off("submit-status", handleSubmitStatus));

  // Spawn result events (success or failure)
  const handleSpawnResult = (id: string, result: SpawnResult) => {
    settleSpawnConfirmation(id);
    // A hand-over is of one process (#12490): a later launch under the id, or
    // the handed-over launch failing to start, ends it.
    getMcpServerServiceRef()?.handleTerminalSpawnResult(id, result);
    if (result.success) {
      // A confirmed relaunch may supersede a session a natural exit left on
      // the pane (#12433); a refused one leaves the running process's id alone.
      releaseSupersededCapturedSession(id, result.launchGeneration);
    } else {
      // Async pty-host spawn rejection (PENDING_SPAWNS_CAPPED, bad shell path,
      // etc.) doesn't throw from ptyClient.spawn(). Revoke any minted pane
      // config so the token doesn't outlive the never-running PTY.
      mcpPaneConfigService.revokePaneConfig(id).catch((err) => {
        console.error("[MCP] Failed to revoke pane config on spawn failure:", err);
      });
    }
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "terminal:spawn-result",
      payload: [id, result],
    });
  };
  ptyClient.on("spawn-result", handleSpawnResult);
  handlers.push(() => ptyClient.off("spawn-result", handleSpawnResult));

  // No answer from the host at all (#12754). Same renderer event as a real
  // rejection so the pane gets the spawn-error banner, but deliberately not
  // routed through handleSpawnResult: the spawn may still land, so nothing
  // main-side may act on it as a final failure.
  handlers.push(
    setSpawnConfirmationTimeoutHandler((id, error) => {
      logWarn("[TerminalSpawn] pty-host has not confirmed spawn", { id, error: error.message });
      const result: SpawnResult = { success: false, id, error };
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
        name: "terminal:spawn-result",
        payload: [id, result],
      });
    })
  );

  // Geometry the PTY actually holds after a resize. The renderer compares it
  // against its own xterm grid to detect a split the two sides cannot otherwise
  // see (#11641). Already generation-filtered by the router. Project-scoped for
  // the same reason as `terminal:status` below — only views of the owning
  // project host panels for the terminal, and every other view drops the echo
  // in `recordPtyResizeResult` after paying for the clone.
  const handleResizeResult = (id: string, result: TerminalResizeResult) => {
    broadcastToProjectRenderers(ptyClient.getTerminalProjectId(id), CHANNELS.EVENTS_PUSH, {
      name: "terminal:resize-result",
      payload: [id, result],
    });
  };
  ptyClient.on("resize-result", handleResizeResult);
  handlers.push(() => ptyClient.off("resize-result", handleResizeResult));

  // Terminal status for flow control visibility. Per-terminal pulses are
  // inherently project-scoped — only views of the owning project host panels
  // for the terminal, so don't pay a clone + IPC task per unrelated view.
  const handleTerminalStatus = (payload: {
    id: string;
    status: string;
    bufferUtilization?: number;
    pauseDuration?: number;
    droppedBytes?: number;
    timestamp: number;
  }) => {
    broadcastToProjectRenderers(
      ptyClient.getTerminalProjectId(payload.id),
      CHANNELS.TERMINAL_STATUS,
      payload
    );
  };
  ptyClient.on("terminal-status", handleTerminalStatus);
  handlers.push(() => ptyClient.off("terminal-status", handleTerminalStatus));

  // Per-target results from a fleet broadcast write. Drives the failure chip
  // and auto-disarm of dead-pipe targets in the renderer.
  const handleBroadcastWriteResult = (payload: BroadcastWriteResultPayload) => {
    broadcastToRenderer(CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT, payload);
  };
  ptyClient.on("broadcast-write-result", handleBroadcastWriteResult);
  handlers.push(() => ptyClient.off("broadcast-write-result", handleBroadcastWriteResult));

  // Agent lifecycle events (agent:state-changed, agent:all-clear, agent:detected,
  // agent:exited, agent:fallback-triggered) are relayed by `registerEventsHandlers`
  // via the multiplexed events:push channel. Emitters continue to publish on
  // `TypedEventBus` (`events.emit(...)`); do not duplicate relays here.

  // Artifact events
  const unsubArtifactDetected = events.on("artifact:detected", (payload: unknown) => {
    broadcastToRenderer(CHANNELS.ARTIFACT_DETECTED, payload);
  });
  handlers.push(unsubArtifactDetected);

  // Resource metrics (batched from pty-host)
  const handleResourceMetrics = (metrics: unknown, timestamp: unknown) => {
    broadcastToRenderer(CHANNELS.TERMINAL_RESOURCE_METRICS, { metrics, timestamp });
  };
  ptyClient.on("resource-metrics", handleResourceMetrics);
  handlers.push(() => ptyClient.off("resource-metrics", handleResourceMetrics));

  // FD growth — the pty-host already emits once per episode transition, so
  // this writes exactly one record each. It is logged here, not relayed: every
  // project view is its own renderer, and a renderer-side log line repeated
  // once per open view (#12520).
  const handleFdGrowth = (payload: FdGrowthPayload) => {
    const message = formatFdGrowth(payload);
    if (payload.state === "elevated") {
      logWarn(message, { ...payload });
    } else {
      logInfo(message, { ...payload });
    }
  };
  ptyClient.on("fd-growth", handleFdGrowth);
  handlers.push(() => ptyClient.off("fd-growth", handleFdGrowth));

  // Terminal activity — per-terminal headline updates, project-scoped like
  // the status pulses above.
  const unsubTerminalActivity = events.on(
    "terminal:activity",
    (payload: DaintreeEventMap["terminal:activity"]) => {
      broadcastToProjectRenderers(
        ptyClient.getTerminalProjectId(payload.terminalId),
        CHANNELS.TERMINAL_ACTIVITY,
        payload
      );
    }
  );
  handlers.push(unsubTerminalActivity);

  // Terminal trash/restore
  const unsubTerminalTrashed = events.on(
    "terminal:trashed",
    (payload: { id: string; expiresAt: number }) => {
      broadcastToRenderer(CHANNELS.TERMINAL_TRASHED, payload);
    }
  );
  handlers.push(unsubTerminalTrashed);

  const unsubTerminalRestored = events.on("terminal:restored", (payload: { id: string }) => {
    broadcastToRenderer(CHANNELS.TERMINAL_RESTORED, payload);
  });
  handlers.push(unsubTerminalRestored);

  // Resume records captured by the pty-host (trash expiry, natural agent
  // exit, `/quit` demotion). Main is the single writer of both the journal and
  // the saved pane — the pty-host writing either itself would race main's own
  // close-path writes (two processes, two write queues, one file). Accepted
  // synchronously so a quit can drain what is already in flight (#12433).
  const unsubSessionCaptured = events.on(
    "agent-session:captured",
    (payload: DaintreeEventMap["agent-session:captured"]) => {
      acceptCapturedAgentSession(payload);
    }
  );
  handlers.push(unsubSessionCaptured);

  return () => handlers.forEach((cleanup) => cleanup());
}

function formatFdGrowth(payload: FdGrowthPayload): string {
  const owners =
    `${payload.terminals} terminals, ${payload.pooledPtys} pooled PTYs, ` +
    `${payload.pluginPtys} plugin PTYs, ${payload.analysisWorkers} analysis workers`;
  // The configured cadence, not a measured spacing: the monitor guarantees the
  // samples were consecutive, not that they were evenly spread — the level can
  // change mid-streak, and pressure overrides it outright.
  const span =
    `for ${payload.sustainedSamples} samples at the current ` +
    `${Math.round(payload.sampleIntervalMs / 1000)}s sample interval`;
  const counts =
    `${payload.fdCount} open descriptors, ${payload.expectedFds} expected for ${owners}; ` +
    `growth ${payload.growth} over the post-restore baseline of ${payload.baselineFds}`;

  if (payload.state === "recovered") {
    // An episode outlives a clock stepped backwards, which would otherwise
    // date its recovery before it started.
    const elapsedMs = payload.timestamp - payload.episodeStartedAt;
    const since = elapsedMs >= 0 ? `, ${Math.round(elapsedMs / 60000)} min after it rose` : "";
    return (
      `[TerminalDiagnostics] pty-host ${payload.hostPid} FD count back near baseline: ` +
      `${counts} ${span}${since}.`
    );
  }

  const types = payload.descriptorTypes
    ? Object.entries(payload.descriptorTypes)
        .filter(([, count]) => count > 0)
        .map(([type, count]) => `${type} ${count}`)
        .join(", ")
    : "";
  return (
    `[TerminalDiagnostics] pty-host ${payload.hostPid} FD count elevated: ` +
    `${counts} ${span}.` +
    (types ? ` Descriptor types: ${types}.` : "")
  );
}
