import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import { events } from "../events.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import {
  type WaitUntilIdleResult,
  DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
} from "../../../shared/types/terminalWaitUntilIdle.js";
import { mapAgentStateToBusyState, mapAgentStateToIdleReason } from "./shared.js";

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
