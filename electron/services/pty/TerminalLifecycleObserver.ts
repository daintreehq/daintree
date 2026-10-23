import type { PanelKind } from "../../../shared/types/panel.js";
import type { SpawnResult } from "../../../shared/types/pty-host.js";
import type { PluginTerminalKind } from "../../../shared/types/plugin.js";
import type { TerminalLifecycleObservation } from "../../../shared/utils/pluginTerminalLifecycle.js";
import { events } from "../events.js";
import { createLogger } from "../../utils/logger.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

const logger = createLogger("main:TerminalLifecycleObserver");

/**
 * Terminals that are no longer running whose metadata is kept so a later trash
 * or restore can still be attributed — an exit is commonly followed by the pane
 * being trashed. Live terminals are never evicted; only retired records past
 * this count are.
 */
export const MAX_RETAINED_EXITED_TERMINALS = 256;

/**
 * Live records past this count trigger a sweep for ones the client no longer
 * holds any launch for — a terminal killed just before its host died, or one
 * whose crash respawn was never confirmed. Far above any real terminal count,
 * so the sweep is a backstop, not a hot path.
 */
export const LIVE_RECORD_SWEEP_THRESHOLD = 1024;

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
  /** Its exit was reported; a second one is not. */
  exited: boolean;
}

export interface TerminalLifecycleObserverOptions {
  getAttribution: (id: string) => TerminalLaunchAttribution | null;
  emit: (observation: TerminalLifecycleObservation) => void;
  now?: () => number;
  maxRetainedExited?: number;
  liveRecordSweepThreshold?: number;
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
    exited: false,
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
 *
 * A terminal killed before its spawn was confirmed is reported not at all: the
 * client forgets it on kill, so its success has nothing to attribute to.
 */
export class TerminalLifecycleObserver {
  private readonly records = new Map<string, TerminalRecord>();
  /** Records of terminals no longer running, oldest first; always a subset of `records`. */
  private readonly retired = new Set<string>();
  private readonly getAttribution: (id: string) => TerminalLaunchAttribution | null;
  private readonly emitObservation: (observation: TerminalLifecycleObservation) => void;
  private readonly now: () => number;
  private readonly maxRetainedExited: number;
  private readonly liveRecordSweepThreshold: number;

  constructor(options: TerminalLifecycleObserverOptions) {
    this.getAttribution = options.getAttribution;
    this.emitObservation = options.emit;
    this.now = options.now ?? Date.now;
    this.maxRetainedExited = options.maxRetainedExited ?? MAX_RETAINED_EXITED_TERMINALS;
    this.liveRecordSweepThreshold = options.liveRecordSweepThreshold ?? LIVE_RECORD_SWEEP_THRESHOLD;
  }

  handleSpawnResult(id: string, result: SpawnResult): void {
    if (!result.success) {
      // A failed launch that leaves the client holding nothing under this id —
      // a crash respawn that did not take — ends whatever ran there before,
      // with no exit to say so. Retired, not marked exited: should that
      // predecessor's own exit still arrive, it is reported.
      if (this.getAttribution(id) === null) this.retire(id);
      return;
    }
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
      !previous.exited &&
      previous.launchGeneration !== undefined &&
      previous.launchGeneration === attribution.launchGeneration
    ) {
      return;
    }
    const record = toRecord(attribution);
    this.records.set(id, record);
    this.retired.delete(id);
    if (this.records.size - this.retired.size > this.liveRecordSweepThreshold) {
      this.retireAbandoned();
    }
    this.publish("spawned", id, record);
  }

  handleExit(id: string, exitCode: number, signal?: number): void {
    const record = this.records.get(id);
    if (!record || record.exited) return;
    record.exited = true;
    this.publish("exited", id, record, {
      exitCode,
      ...(typeof signal === "number" && signal > 0 && { signal }),
    });
    this.retire(id);
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
    this.retired.clear();
  }

  /**
   * The record for a terminal, with its worktree brought up to date from the
   * client's spawn cache while the terminal is still live there. Launch facts
   * (project, kind, agent) are fixed at spawn and never re-derived.
   */
  private refresh(id: string): TerminalRecord | undefined {
    const record = this.records.get(id);
    if (!record || this.retired.has(id)) return record;
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

  /** Move a terminal's record into the bounded set of ones no longer running. */
  private retire(id: string): void {
    if (!this.records.has(id)) return;
    this.retired.delete(id);
    this.retired.add(id);
    while (this.retired.size > this.maxRetainedExited) {
      const oldest = this.retired.values().next().value;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
      this.records.delete(oldest);
    }
  }

  /** Retire every live record the client no longer holds any launch for. */
  private retireAbandoned(): void {
    for (const id of [...this.records.keys()]) {
      if (!this.retired.has(id) && this.getAttribution(id) === null) this.retire(id);
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
        error: formatErrorMessage(error, "unknown subscriber error"),
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
