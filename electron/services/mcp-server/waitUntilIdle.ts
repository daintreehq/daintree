import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import { events } from "../events.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import {
  type WaitUntilIdleResult,
  type WaitUntilIdleBatchResult,
  type WaitUntilIdleBatchEntry,
  type WaitUntilIdleBatchMode,
  DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  MAX_WAIT_UNTIL_IDLE_BATCH_TERMINALS,
} from "../../../shared/types/terminalWaitUntilIdle.js";
import { mapAgentStateToBusyState, mapAgentStateToIdleReason } from "./shared.js";
import type { AgentAvailabilityStore } from "../AgentAvailabilityStore.js";

export interface WaitUntilIdleOptions {
  /**
   * Hard ceiling for the effective wait, applied to both the default and any
   * explicit `timeoutMs`. The session server passes the interactive cap for
   * help-session tiers so a long block can never freeze a conversation a
   * human is sitting in; external (api-key) sessions get the global max.
   */
  maxTimeoutMs?: number;
}

export async function handleWaitUntilIdle(
  rawArgs: unknown,
  signal: AbortSignal,
  options?: WaitUntilIdleOptions
): Promise<WaitUntilIdleResult> {
  const argsObj =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : null;
  if (!argsObj) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "terminal.waitUntilIdle requires an object argument with a `terminalId` field."
    );
  }
  const terminalIdRaw = argsObj["terminalId"];
  if (typeof terminalIdRaw !== "string" || terminalIdRaw.trim() === "") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "terminal.waitUntilIdle requires a non-empty `terminalId` string."
    );
  }
  const terminalId = terminalIdRaw;

  const ceilingMs = Math.min(
    options?.maxTimeoutMs ?? MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
    MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS
  );
  let timeoutMs = Math.min(DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS, ceilingMs);
  const rawTimeout = argsObj["timeoutMs"];
  if (rawTimeout !== undefined) {
    if (
      typeof rawTimeout !== "number" ||
      !Number.isFinite(rawTimeout) ||
      rawTimeout < 0 ||
      Math.floor(rawTimeout) !== rawTimeout
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "terminal.waitUntilIdle `timeoutMs` must be a non-negative integer."
      );
    }
    timeoutMs = Math.min(rawTimeout, ceilingMs);
  }

  if (signal.aborted) {
    throw new McpError(ErrorCode.RequestTimeout, "Request was cancelled.");
  }

  const store = getAgentAvailabilityStore();
  const agentId = store.getAgentIdForTerminal(terminalId);

  if (!agentId) {
    return {
      terminalId,
      busyState: "idle",
      idleReason: "unknown",
      timedOut: false,
    };
  }

  let unsubscribe: (() => void) | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let settled = false;

  const cleanup = () => {
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (err) {
        console.error("[MCP] waitUntilIdle: unsubscribe failed:", err);
      }
      unsubscribe = undefined;
    }
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  };

  type Settlement =
    | {
        kind: "transition";
        state: AgentState;
        previousState: AgentState;
        timestamp: number;
        waitingReason?: WaitingReason;
        exitCode?: number | null;
        exitSignal?: number;
      }
    | { kind: "already-idle"; state: AgentState; waitingReason?: WaitingReason }
    | { kind: "timeout" }
    | { kind: "abort" };

  // Exit metadata only makes sense once the agent has finished. Build the
  // partial object lazily so a still-working/waiting result stays clean.
  const exitFields = (
    state: AgentState,
    exitCode: number | null | undefined,
    exitSignal: number | undefined
  ): { exitCode?: number | null; exitSignal?: number } => {
    if (state !== "completed" && state !== "exited") return {};
    return {
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(exitSignal !== undefined ? { exitSignal } : {}),
    };
  };

  const previousState = store.getState(agentId);

  try {
    const settlement = await new Promise<Settlement>((resolve) => {
      const settle = (value: Settlement) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      unsubscribe = events.on("agent:state-changed", (payload) => {
        if (payload.terminalId !== terminalId) return;
        if (payload.state === "working") return;
        settle({
          kind: "transition",
          state: payload.state,
          previousState: payload.previousState,
          timestamp: payload.timestamp,
          waitingReason: payload.waitingReason,
          // Read straight off the settling event so the result never depends on
          // subscriber ordering relative to AgentAvailabilityStore's cache.
          exitCode: payload.exitCode,
          exitSignal: payload.exitSignal,
        });
      });

      const currentState = store.getState(agentId);
      if (currentState !== "working") {
        settle({
          kind: "already-idle",
          state: currentState ?? "idle",
          waitingReason: store.getWaitingReason(agentId),
        });
        return;
      }

      if (signal.aborted) {
        settle({ kind: "abort" });
        return;
      }
      abortListener = () => settle({ kind: "abort" });
      signal.addEventListener("abort", abortListener, { once: true });

      timeoutHandle = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
    });

    if (settlement.kind === "abort") {
      throw new McpError(ErrorCode.RequestTimeout, "Request was cancelled.");
    }

    if (settlement.kind === "timeout") {
      return {
        terminalId,
        agentId,
        busyState: "working",
        previousBusyState: mapAgentStateToBusyState(previousState),
        lastTransitionAt: store.getLastStateChange(agentId),
        timedOut: true,
      };
    }

    if (settlement.kind === "transition") {
      const idleReason = mapAgentStateToIdleReason(settlement.state);
      return {
        terminalId,
        agentId,
        busyState: mapAgentStateToBusyState(settlement.state),
        idleReason,
        ...(idleReason === "waiting_for_user" && settlement.waitingReason
          ? { waitingReason: settlement.waitingReason }
          : {}),
        previousBusyState: mapAgentStateToBusyState(settlement.previousState),
        lastTransitionAt: settlement.timestamp,
        ...exitFields(settlement.state, settlement.exitCode, settlement.exitSignal),
        timedOut: false,
      };
    }

    const idleReason = mapAgentStateToIdleReason(settlement.state);
    return {
      terminalId,
      agentId,
      busyState: mapAgentStateToBusyState(settlement.state),
      idleReason,
      ...(idleReason === "waiting_for_user" && settlement.waitingReason
        ? { waitingReason: settlement.waitingReason }
        : {}),
      previousBusyState: mapAgentStateToBusyState(previousState),
      lastTransitionAt: store.getLastStateChange(agentId),
      // already-idle: the completion happened before this call, so the live
      // payload is gone — fall back to the store's cached exit metadata.
      ...exitFields(settlement.state, store.getExitCode(agentId), store.getExitSignal(agentId)),
      timedOut: false,
    };
  } finally {
    cleanup();
  }
}

// Mutable per-terminal tracking state for the batched wait. Lifted to its own
// type so the snapshot, the transition handler, and the result builder all share
// one shape.
type BatchTrack = {
  terminalId: string;
  agentId?: string;
  settled: boolean;
  busyState: "working" | "idle";
  idleReason?: WaitUntilIdleBatchEntry["idleReason"];
  waitingReason?: WaitingReason;
  previousBusyState?: "working" | "idle";
  lastTransitionAt?: number;
  exitCode?: number | null;
  exitSignal?: number;
};

function batchExitFields(
  state: AgentState,
  exitCode: number | null | undefined,
  exitSignal: number | undefined
): { exitCode?: number | null; exitSignal?: number } {
  if (state !== "completed" && state !== "exited") return {};
  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(exitSignal !== undefined ? { exitSignal } : {}),
  };
}

// Fill a track from an agent already in a non-working state (read from the
// store, not a live transition payload). `previousState` is the best guess for
// what it transitioned from — at call time we only know the current state, so
// the caller passes it through.
function settleTrackFromState(
  store: AgentAvailabilityStore,
  track: BatchTrack,
  agentId: string,
  state: AgentState,
  previousState: AgentState
): void {
  const idleReason = mapAgentStateToIdleReason(state);
  track.settled = true;
  track.busyState = mapAgentStateToBusyState(state);
  track.idleReason = idleReason;
  if (idleReason === "waiting_for_user") {
    const reason = store.getWaitingReason(agentId);
    if (reason !== undefined) track.waitingReason = reason;
  }
  track.previousBusyState = mapAgentStateToBusyState(previousState);
  track.lastTransitionAt = store.getLastStateChange(agentId);
  Object.assign(
    track,
    batchExitFields(state, store.getExitCode(agentId), store.getExitSignal(agentId))
  );
}

function buildBatchResult(
  tracks: Map<string, BatchTrack>,
  orderedIds: string[],
  mode: WaitUntilIdleBatchMode,
  timedOut: boolean
): WaitUntilIdleBatchResult {
  const results: WaitUntilIdleBatchEntry[] = orderedIds.map((id) => {
    const t = tracks.get(id)!;
    const entry: WaitUntilIdleBatchEntry = {
      terminalId: t.terminalId,
      busyState: t.busyState,
      settled: t.settled,
    };
    if (t.agentId !== undefined) entry.agentId = t.agentId;
    if (t.idleReason !== undefined) entry.idleReason = t.idleReason;
    if (t.waitingReason !== undefined) entry.waitingReason = t.waitingReason;
    if (t.previousBusyState !== undefined) entry.previousBusyState = t.previousBusyState;
    if (t.lastTransitionAt !== undefined) entry.lastTransitionAt = t.lastTransitionAt;
    if (t.exitCode !== undefined) entry.exitCode = t.exitCode;
    if (t.exitSignal !== undefined) entry.exitSignal = t.exitSignal;
    return entry;
  });
  const settledTerminalIds = orderedIds.filter((id) => tracks.get(id)!.settled);
  return { mode, results, settledTerminalIds, timedOut };
}

/**
 * Batched sibling of {@link handleWaitUntilIdle}: watch N terminals on one
 * subscription and resolve on the first (or all) leaving `working`. Same
 * main-process rationale (the MCP AbortSignal can't cross IPC; external sessions
 * may block for hours), same tier-clamped ceiling via `options.maxTimeoutMs`.
 */
export async function handleWaitUntilIdleBatch(
  rawArgs: unknown,
  signal: AbortSignal,
  options?: WaitUntilIdleOptions
): Promise<WaitUntilIdleBatchResult> {
  const argsObj =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : null;
  if (!argsObj) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "terminal.waitUntilIdleBatch requires an object argument with a `terminalIds` array."
    );
  }

  const rawIds = argsObj["terminalIds"];
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "terminal.waitUntilIdleBatch requires a non-empty `terminalIds` array."
    );
  }
  // Cap the RAW array (not the de-duped set) — the main-process short-circuit
  // bypasses the renderer's `max(256)` schema check, so a payload of thousands
  // of duplicate ids must not slip past the advertised limit.
  if (rawIds.length > MAX_WAIT_UNTIL_IDLE_BATCH_TERMINALS) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `terminal.waitUntilIdleBatch accepts at most ${MAX_WAIT_UNTIL_IDLE_BATCH_TERMINALS} terminalIds.`
    );
  }
  // De-dupe while preserving request order; reject blanks early.
  const orderedIds: string[] = [];
  const seenIds = new Set<string>();
  for (const id of rawIds) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "terminal.waitUntilIdleBatch `terminalIds` must be non-empty strings."
      );
    }
    if (!seenIds.has(id)) {
      seenIds.add(id);
      orderedIds.push(id);
    }
  }

  let mode: WaitUntilIdleBatchMode = "first";
  const rawMode = argsObj["mode"];
  if (rawMode !== undefined) {
    if (rawMode !== "first" && rawMode !== "all") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "terminal.waitUntilIdleBatch `mode` must be 'first' or 'all'."
      );
    }
    mode = rawMode;
  }

  const ceilingMs = Math.min(
    options?.maxTimeoutMs ?? MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
    MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS
  );
  let timeoutMs = Math.min(DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS, ceilingMs);
  const rawTimeout = argsObj["timeoutMs"];
  if (rawTimeout !== undefined) {
    if (
      typeof rawTimeout !== "number" ||
      !Number.isFinite(rawTimeout) ||
      rawTimeout < 0 ||
      Math.floor(rawTimeout) !== rawTimeout
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "terminal.waitUntilIdleBatch `timeoutMs` must be a non-negative integer."
      );
    }
    timeoutMs = Math.min(rawTimeout, ceilingMs);
  }

  if (signal.aborted) {
    throw new McpError(ErrorCode.RequestTimeout, "Request was cancelled.");
  }

  const store = getAgentAvailabilityStore();

  // Resolve agentId per terminal and seed tracks. Untracked terminals (no agent)
  // have nothing to wait on and count as already-idle, mirroring the
  // single-terminal handler's no-agent branch.
  const tracks = new Map<string, BatchTrack>();
  for (const terminalId of orderedIds) {
    const agentId = store.getAgentIdForTerminal(terminalId);
    if (!agentId) {
      tracks.set(terminalId, {
        terminalId,
        settled: true,
        busyState: "idle",
        idleReason: "unknown",
        previousBusyState: "idle",
      });
      continue;
    }
    tracks.set(terminalId, {
      terminalId,
      agentId,
      settled: false,
      busyState: "working",
      previousBusyState: "working",
      // Mirror the single handler's timeout result, which reports the last
      // transition even while still working. Settled tracks overwrite this with
      // their transition timestamp.
      lastTransitionAt: store.getLastStateChange(agentId),
    });
  }

  const predicateMet = (): boolean => {
    if (mode === "first") {
      for (const t of tracks.values()) if (t.settled) return true;
      return false;
    }
    for (const t of tracks.values()) if (!t.settled) return false;
    return true;
  };

  let unsubscribe: (() => void) | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let settled = false;

  const cleanup = () => {
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (err) {
        console.error("[MCP] waitUntilIdleBatch: unsubscribe failed:", err);
      }
      unsubscribe = undefined;
    }
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
  };

  try {
    const outcome = await new Promise<"settled" | "timeout" | "abort">((resolve) => {
      const finish = (value: "settled" | "timeout" | "abort") => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      // Subscribe BEFORE the authoritative state read so a transition landing in
      // the gap can't be missed (mirrors the single-terminal ordering).
      unsubscribe = events.on("agent:state-changed", (payload) => {
        if (payload.terminalId === undefined) return;
        const track = tracks.get(payload.terminalId);
        if (!track || track.settled) return;
        if (payload.state === "working") return;
        const idleReason = mapAgentStateToIdleReason(payload.state);
        track.settled = true;
        track.busyState = mapAgentStateToBusyState(payload.state);
        track.idleReason = idleReason;
        if (idleReason === "waiting_for_user" && payload.waitingReason) {
          track.waitingReason = payload.waitingReason;
        }
        track.previousBusyState = mapAgentStateToBusyState(payload.previousState);
        track.lastTransitionAt = payload.timestamp;
        Object.assign(track, batchExitFields(payload.state, payload.exitCode, payload.exitSignal));
        if (predicateMet()) finish("settled");
      });

      // Authoritative snapshot now that we're subscribed: settle any terminal
      // already non-working. Mirror the single handler — an agent that is mapped
      // but has no recorded state (`undefined`) counts as already-idle, not
      // working, so `mode: "all"` can't hang on a stateless terminal.
      for (const track of tracks.values()) {
        if (track.settled || !track.agentId) continue;
        const state = store.getState(track.agentId);
        if (state !== "working") {
          settleTrackFromState(store, track, track.agentId, state ?? "idle", state ?? "idle");
        }
      }

      if (predicateMet()) {
        finish("settled");
        return;
      }
      if (signal.aborted) {
        finish("abort");
        return;
      }
      abortListener = () => finish("abort");
      signal.addEventListener("abort", abortListener, { once: true });
      timeoutHandle = setTimeout(() => finish("timeout"), timeoutMs);
    });

    if (outcome === "abort") {
      throw new McpError(ErrorCode.RequestTimeout, "Request was cancelled.");
    }
    return buildBatchResult(tracks, orderedIds, mode, outcome === "timeout");
  } finally {
    cleanup();
  }
}
