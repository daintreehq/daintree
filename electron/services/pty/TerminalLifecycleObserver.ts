import type { PanelKind } from "../../../shared/types/panel.js";
import type { SpawnResult } from "../../../shared/types/pty-host.js";
import type { PluginTerminalKind } from "../../../shared/types/plugin.js";
import type { TerminalLifecycleObservation } from "../../../shared/utils/pluginTerminalLifecycle.js";
import { events } from "../events.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:TerminalLifecycleObserver");

/**
 * Exited terminals whose metadata is kept so a later trash or restore can still
 * be attributed — an exit is commonly followed by the pane being trashed. Live
 * terminals are never evicted; only exited records past this count are.
 */
export const MAX_RETAINED_EXITED_TERMINALS = 256;

/**
 * The routing facts a terminal was launched with, as
 * `PtyClient.getTerminalLaunchAttribution` reads them off its spawn cache.
 */
export interface TerminalLaunchAttribution {
  projectId?: string;
  worktreeId?: string;
  kind?: PanelKind;
  launchAgentId?: string;
  pluginPanelKindId?: string;
  launchGeneration?: number;
  isAssistantTerminal?: boolean;
}

/** The slice of `PtyClient` the observer reads and listens to. */
export interface TerminalLifecycleSource {
  getTerminalLaunchAttribution(id: string): TerminalLaunchAttribution | null;
  on(event: "spawn-result", listener: (id: string, result: SpawnResult) => void): unknown;
  on(
    event: "exit",
    listener: (id: string, exitCode: number, signal?: number, preserveSession?: boolean) => void
  ): unknown;
  off(event: "spawn-result", listener: (id: string, result: SpawnResult) => void): unknown;
  off(
    event: "exit",
    listener: (id: string, exitCode: number, signal?: number, preserveSession?: boolean) => void
  ): unknown;
}

interface TerminalRecord {
  projectId?: string;
  worktreeId?: string;
  kind: PluginTerminalKind;
  agentId?: string;
  launchGeneration?: number;
}

export interface TerminalLifecycleObserverOptions {
  getAttribution: (id: string) => TerminalLaunchAttribution | null;
  emit: (observation: TerminalLifecycleObservation) => void;
  now?: () => number;
  maxRetainedExited?: number;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function toRecord(attribution: TerminalLaunchAttribution): TerminalRecord {
  const launchAgentId = nonEmpty(attribution.launchAgentId);
  const kind: PluginTerminalKind =
    nonEmpty(attribution.pluginPanelKindId) !== undefined
      ? "plugin"
      : launchAgentId !== undefined
        ? "agent"
        : "shell";
  return {
    projectId: nonEmpty(attribution.projectId),
    worktreeId: nonEmpty(attribution.worktreeId),
    kind,
    agentId: kind === "agent" ? launchAgentId : undefined,
    launchGeneration: attribution.launchGeneration,
  };
}

/**
 * Turns the PTY client's spawn/exit stream, plus the trash, restore, worktree
 * and rate-limit bus events, into one ordered `terminal:lifecycle` stream of
 * metadata (#13814) — what the plugin host's `onDidChangeTerminalLifecycle`
 * reads.
 *
 * It keeps its own per-terminal record because the client's does not outlive
 * the exit: a natural exit drops the spawn cache before the event is emitted,
 * and a kill drops it before the exit arrives at all. Records hold routing
 * facts only, never the command, cwd, env, title or output.
 *
 * Never consumes the client's restart-exit suppression: that flag belongs to
 * the renderer's exit path, and the public `exit` it reads here is already
 * filtered of superseded (predecessor-generation) exits.
 */
export class TerminalLifecycleObserver {
  private readonly records = new Map<string, TerminalRecord>();
  /** Exited terminals with a retained record, oldest first. */
  private readonly exited = new Set<string>();
  private readonly getAttribution: (id: string) => TerminalLaunchAttribution | null;
  private readonly emitObservation: (observation: TerminalLifecycleObservation) => void;
  private readonly now: () => number;
  private readonly maxRetainedExited: number;

  constructor(options: TerminalLifecycleObserverOptions) {
    this.getAttribution = options.getAttribution;
    this.emitObservation = options.emit;
    this.now = options.now ?? Date.now;
    this.maxRetainedExited = options.maxRetainedExited ?? MAX_RETAINED_EXITED_TERMINALS;
  }

  handleSpawnResult(id: string, result: SpawnResult): void {
    if (!result.success) return;
    const attribution = this.getAttribution(id);
    // A spawn the client no longer holds, or a stale success from a killed
    // predecessor under the same id, is not the terminal now running.
    if (!attribution || attribution.isAssistantTerminal) return;
    if (
      result.launchGeneration !== undefined &&
      attribution.launchGeneration !== undefined &&
      result.launchGeneration !== attribution.launchGeneration
    ) {
      return;
    }
    const previous = this.records.get(id);
    // The same launch confirmed twice (a deferred-start replay) is one spawn.
    if (
      previous !== undefined &&
      !this.exited.has(id) &&
      previous.launchGeneration !== undefined &&
      previous.launchGeneration === attribution.launchGeneration
    ) {
      return;
    }
    const record = toRecord(attribution);
    this.records.set(id, record);
    this.exited.delete(id);
    this.publish("spawned", id, record);
  }

  handleExit(id: string, exitCode: number, signal?: number): void {
    const record = this.records.get(id);
    if (!record || this.exited.has(id)) return;
    this.publish("exited", id, record, {
      exitCode,
      ...(typeof signal === "number" && signal > 0 && { signal }),
    });
    this.retainExited(id);
  }

  handleTrashed(id: string): void {
    const record = this.refresh(id);
    if (record) this.publish("trashed", id, record);
  }

  handleRestored(id: string): void {
    const record = this.refresh(id);
    if (record) this.publish("restored", id, record);
  }

  handleRateLimitObserved(id: string, observedAt: number): void {
    const record = this.refresh(id);
    if (record) this.publish("rate-limit-observed", id, record, { observedAt });
  }

  /** A pane re-filed onto another worktree: carry the move into the record. */
  handleWorktreeChanged(id: string): void {
    this.refresh(id);
  }

  clear(): void {
    this.records.clear();
    this.exited.clear();
  }

  /**
   * The record for a terminal, with its worktree brought up to date from the
   * client's spawn cache while the terminal is still live there. Launch facts
   * (project, kind, agent) are fixed at spawn and never re-derived.
   */
  private refresh(id: string): TerminalRecord | undefined {
    const record = this.records.get(id);
    if (!record || this.exited.has(id)) return record;
    const attribution = this.getAttribution(id);
    if (!attribution) return record;
    if (
      record.launchGeneration !== undefined &&
      attribution.launchGeneration !== undefined &&
      record.launchGeneration !== attribution.launchGeneration
    ) {
      return record;
    }
    record.worktreeId = nonEmpty(attribution.worktreeId);
    return record;
  }

  private retainExited(id: string): void {
    this.exited.delete(id);
    this.exited.add(id);
    while (this.exited.size > this.maxRetainedExited) {
      const oldest = this.exited.values().next().value;
      if (oldest === undefined) break;
      this.exited.delete(oldest);
      this.records.delete(oldest);
    }
  }

  private publish(
    type: TerminalLifecycleObservation["type"],
    terminalId: string,
    record: TerminalRecord,
    extra: { exitCode?: number; signal?: number; observedAt?: number } = {}
  ): void {
    const observation: TerminalLifecycleObservation = {
      type,
      terminalId,
      kind: record.kind,
      timestamp: this.now(),
    };
    if (record.projectId !== undefined) observation.projectId = record.projectId;
    if (record.worktreeId !== undefined) observation.worktreeId = record.worktreeId;
    if (record.agentId !== undefined) observation.agentId = record.agentId;
    if (extra.exitCode !== undefined) observation.exitCode = extra.exitCode;
    if (extra.signal !== undefined) observation.signal = extra.signal;
    if (extra.observedAt !== undefined) observation.observedAt = extra.observedAt;
    // Emitted from inside the PTY client's own event dispatch: a throwing
    // subscriber must not cut off the client's other exit/spawn listeners.
    try {
      this.emitObservation(observation);
    } catch (error) {
      logger.warn("terminal:lifecycle subscriber threw", {
        type,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Start observing `source` for the life of the process, publishing to the main
 * event bus. Returns a disposer that detaches every listener.
 */
export function startTerminalLifecycleObserver(source: TerminalLifecycleSource): () => void {
  const observer = new TerminalLifecycleObserver({
    getAttribution: (id) => source.getTerminalLaunchAttribution(id),
    emit: (observation) => events.emit("terminal:lifecycle", observation),
  });
  const onSpawnResult = (id: string, result: SpawnResult): void =>
    observer.handleSpawnResult(id, result);
  const onExit = (id: string, exitCode: number, signal?: number): void =>
    observer.handleExit(id, exitCode, signal);
  source.on("spawn-result", onSpawnResult);
  source.on("exit", onExit);
  const unsubscribers = [
    events.on("terminal:trashed", ({ id }) => observer.handleTrashed(id)),
    events.on("terminal:restored", ({ id }) => observer.handleRestored(id)),
    events.on("terminal:worktree-changed", ({ id }) => observer.handleWorktreeChanged(id)),
    events.on("agent:rate-limit-observed", ({ terminalId, observedAt }) =>
      observer.handleRateLimitObserved(terminalId, observedAt)
    ),
  ];
  return () => {
    source.off("spawn-result", onSpawnResult);
    source.off("exit", onExit);
    for (const unsubscribe of unsubscribers) unsubscribe();
    observer.clear();
  };
}
