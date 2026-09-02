import { PERF_MARKS } from "@shared/perf/marks";
import type { ProjectSwitchEntryPoint, ProjectSwitchTrace } from "@shared/types/ipc/project";
import { markRendererPerformance } from "./performance";

/**
 * Renderer half of the project-switch perf trace.
 *
 * A switch starts as a gesture in the OUTGOING view (keydown, palette pick,
 * toolbar click) and ends in the INCOMING view, which is a different V8
 * context. The gesture site mints the trace and parks it as "pending"; the
 * store consumes it when `switchProject` runs so the `switchId` rides the IPC
 * to main. The incoming view learns its trace from main's targeted sends and
 * keeps it as "active" so its own marks join the same trace.
 */

/**
 * A pending trace older than this is a gesture that never became a switch
 * (the palette closed on the current project, the MRU toggle had nowhere to
 * go) — it must not attach to an unrelated switch minutes later.
 */
const PENDING_TRACE_TTL_MS = 5_000;

/** The trace this view is inside; `entryPoint` arrives with `project:on-switch`. */
export type ActiveSwitchTrace = { switchId: string; entryPoint?: ProjectSwitchEntryPoint };

let pending: { trace: ProjectSwitchTrace; startedAt: number } | null = null;
let active: ActiveSwitchTrace | null = null;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// Counter fallback only for exotic test contexts without WebCrypto; a real
// renderer always has `crypto.randomUUID`.
let fallbackCounter = 0;

function newSwitchId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `switch-${Date.now().toString(36)}-${fallbackCounter}`;
}

/** Mint a trace at the gesture site and mark its keydown/click instant. */
export function beginSwitchTrace(entryPoint: ProjectSwitchEntryPoint): ProjectSwitchTrace {
  const trace: ProjectSwitchTrace = { switchId: newSwitchId(), entryPoint };
  pending = { trace, startedAt: now() };
  markRendererPerformance(PERF_MARKS.PROJECT_SWITCH_KEYDOWN, { ...trace });
  return trace;
}

/** Take the pending trace if it is still fresh; clears it either way. */
export function consumeSwitchTrace(): ProjectSwitchTrace | null {
  const current = pending;
  pending = null;
  if (!current) return null;
  if (now() - current.startedAt > PENDING_TRACE_TTL_MS) return null;
  return current.trace;
}

export function setActiveSwitchTrace(trace: ActiveSwitchTrace | null): void {
  active = trace;
}

export function getActiveSwitchTrace(): ActiveSwitchTrace | null {
  return active;
}

/**
 * Emit a renderer mark stamped with the trace this view is in: the active
 * (incoming-side) trace wins, else the pending (outgoing-side) one. Explicit
 * `meta` overrides so a caller can pass the trace it already holds.
 */
export function markSwitch(mark: string, meta?: Record<string, unknown>): void {
  const trace = active ?? pending?.trace ?? null;
  markRendererPerformance(mark, { ...(trace ?? {}), ...(meta ?? {}) });
}

/** Test-only reset. */
export function resetSwitchTraceForTesting(): void {
  pending = null;
  active = null;
}
