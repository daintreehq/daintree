import type {
  PluginTerminalKind,
  PluginTerminalLifecycleEvent,
  PluginTerminalLifecycleEventType,
} from "../types/plugin.js";

/**
 * The main-process `terminal:lifecycle` bus payload. Declared here, structurally,
 * so the projection below stays in `shared/` and the worker side can re-project
 * without pulling a main-process module across the boundary. Carries routing
 * metadata only — the observer that emits it never reads a command line, cwd,
 * title or output.
 */
export interface TerminalLifecycleObservation {
  type: PluginTerminalLifecycleEventType;
  terminalId: string;
  /** Owning workspace as the PTY layer recorded it at launch. */
  projectId?: string;
  worktreeId?: string;
  kind: PluginTerminalKind;
  agentId?: string;
  exitCode?: number;
  signal?: number;
  observedAt?: number;
  timestamp: number;
}

/** Host-resolved context the value itself does not carry. */
export interface PluginTerminalLifecycleContext {
  /** Owning workspace of the terminal; absent or `null` when it has none. */
  workspaceId?: string | null;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<PluginTerminalLifecycleEventType>([
  "spawned",
  "exited",
  "trashed",
  "restored",
  "rate-limit-observed",
]);

const KINDS: ReadonlySet<string> = new Set<PluginTerminalKind>(["agent", "shell", "plugin"]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Build a frozen {@link PluginTerminalLifecycleEvent} from an untrusted value —
 * the internal bus payload, or a plugin event rebuilt by the worker port's
 * structured clone — by explicit assignment, never a spread, so no field the
 * allowlist does not name can survive. `null` when the value is not a
 * well-formed event.
 *
 * With a `context`, the workspace comes from it (main resolves it from the
 * payload's `projectId`); without one, from the value's own `workspaceId`.
 */
export function toPluginTerminalLifecycleEvent(
  value: unknown,
  context?: PluginTerminalLifecycleContext
): PluginTerminalLifecycleEvent | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) return null;
  if (!isNonEmptyString(raw.terminalId)) return null;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) return null;
  if (!isFiniteNumber(raw.timestamp)) return null;

  const base: {
    terminalId: string;
    workspaceId?: string;
    worktreeId?: string;
    kind: PluginTerminalKind;
    agentId?: string;
    timestamp: number;
  } = {
    terminalId: raw.terminalId,
    kind: raw.kind as PluginTerminalKind,
    timestamp: raw.timestamp,
  };
  const workspaceId = context ? context.workspaceId : raw.workspaceId;
  if (isNonEmptyString(workspaceId)) base.workspaceId = workspaceId;
  if (isNonEmptyString(raw.worktreeId)) base.worktreeId = raw.worktreeId;
  if (isNonEmptyString(raw.agentId)) base.agentId = raw.agentId;

  switch (type as PluginTerminalLifecycleEventType) {
    case "exited": {
      if (!isFiniteNumber(raw.exitCode)) return null;
      const exited: typeof base & { type: "exited"; exitCode: number; signal?: number } = {
        ...base,
        type: "exited",
        exitCode: raw.exitCode,
      };
      // Zero is "no signal" on every platform that reports one at all.
      if (isFiniteNumber(raw.signal) && raw.signal > 0) exited.signal = raw.signal;
      return Object.freeze(exited);
    }
    case "rate-limit-observed":
      if (!isFiniteNumber(raw.observedAt)) return null;
      return Object.freeze({ ...base, type: "rate-limit-observed", observedAt: raw.observedAt });
    case "spawned":
      return Object.freeze({ ...base, type: "spawned" });
    case "trashed":
      return Object.freeze({ ...base, type: "trashed" });
    case "restored":
      return Object.freeze({ ...base, type: "restored" });
  }
}
