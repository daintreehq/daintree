import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import { events } from "../events.js";
import type { AgentState } from "../../../shared/types/agent.js";
import {
  type WaitUntilIdleResult,
  DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  mapAgentStateToBusyState,
  mapAgentStateToIdleReason,
} from "./shared.js";

export async function handleWaitUntilIdle(
  rawArgs: unknown,
  signal: AbortSignal
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

  let timeoutMs = DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS;
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
    timeoutMs = Math.min(rawTimeout, MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS);
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
      }
    | { kind: "already-idle"; state: AgentState }
    | { kind: "timeout" }
    | { kind: "abort" };

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
        });
      });

      const currentState = store.getState(agentId);
      if (currentState !== "working") {
        settle({ kind: "already-idle", state: currentState ?? "idle" });
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
      return {
        terminalId,
        agentId,
        busyState: mapAgentStateToBusyState(settlement.state),
        idleReason: mapAgentStateToIdleReason(settlement.state),
        previousBusyState: mapAgentStateToBusyState(settlement.previousState),
        lastTransitionAt: settlement.timestamp,
        timedOut: false,
      };
    }

    return {
      terminalId,
      agentId,
      busyState: mapAgentStateToBusyState(settlement.state),
      idleReason: mapAgentStateToIdleReason(settlement.state),
      previousBusyState: mapAgentStateToBusyState(previousState),
      lastTransitionAt: store.getLastStateChange(agentId),
      timedOut: false,
    };
  } finally {
    cleanup();
  }
}
