import { MAX_ASSISTANT_SLOTS } from "../../shared/config/assistantSlots.js";
import { isGlobalAssistantId } from "../../shared/config/globalAssistant.js";
import {
  AGENT_DIRECTORY_ENTRIES_MAX,
  cutAgentLabel,
  unreadAgentDirectory,
  type AgentDirectory,
  type AgentDirectoryEntry,
  type AgentDirectoryLiveEntry,
  type AgentDirectoryResumableEntry,
} from "../../shared/types/agentDirectory.js";
import type { PtyClient } from "./PtyClient.js";
import type { RunningLane, RunningLaneSession } from "./HelpSessionService.js";
import { classifyRun } from "./projectAgentCounts.js";

type PtyTerminal = Awaited<
  ReturnType<PtyClient["getAllTerminalsWithCompletenessAsync"]>
>["terminals"][number];

export interface ResumableLane {
  projectId: string;
  slot: number;
  agentId: string | null;
  capturedAt: number;
}

export interface AgentDirectoryReadOptions {
  projectId?: string;
  /** Leave workers out before the cap, for a person's assistant picker (#14163). */
  assistantsOnly?: boolean;
}

export interface AgentDirectorySources {
  hostId: string;
  now(): number;
  listRunningLanes(): RunningLane[];
  getRunningLaneSession(projectId: string, slot: number): RunningLaneSession | null;
  /** The launch generation main tracks for a terminal; null when it tracks none. */
  getLiveGeneration(terminalId: string): number | null;
  readTerminals(): Promise<{ terminals: readonly PtyTerminal[]; degraded: boolean }>;
  isHelpTerminal(terminalId: string): boolean;
  /**
   * Stored resume pointers, read without claiming or clearing any. `complete`
   * is false when the projects looked in were fewer than the ones that exist.
   */
  resumableLanes(
    projectId?: string
  ): Promise<{ lanes: readonly ResumableLane[]; complete: boolean }>;
}

/**
 * One read of this machine's agents, passive throughout: the lane list, the
 * pty inventory and the stored resume pointers are looked at, and no session is
 * started, resumed, claimed or marked seen to produce it. Assistants join only
 * through their lanes, so a stamped terminal no lane binds appears nowhere,
 * and a worker listing never picks one up.
 */
export async function collectAgentDirectory(
  sources: AgentDirectorySources,
  options: AgentDirectoryReadOptions = {}
): Promise<AgentDirectory> {
  const { projectId, assistantsOnly = false } = options;
  // Lane runs are known before the pty is read; a run that changed while it was
  // read must not borrow the old run's observations.
  const lanesBefore = sources
    .listRunningLanes()
    .filter((lane) => projectId === undefined || lane.projectId === projectId)
    .map((lane) => {
      const running = sources.getRunningLaneSession(lane.projectId, lane.slot);
      return {
        lane,
        running,
        generation: running ? sources.getLiveGeneration(running.terminalId) : null,
      };
    });
  const { terminals, degraded } = await sources.readTerminals();
  const byId = new Map(terminals.map((terminal) => [terminal.id, terminal]));
  let complete = !degraded;

  const live: AgentDirectoryLiveEntry[] = [];
  const liveLanes = new Set<string>();

  lanesBefore.sort(
    (a, b) => a.lane.projectId.localeCompare(b.lane.projectId) || a.lane.slot - b.lane.slot
  );
  for (const { lane, running, generation } of lanesBefore) {
    if (!running || generation === null) continue;
    const incarnation = sources.getLiveGeneration(running.terminalId);
    // No run to name: not a live lane, and not a conclusion about its PTY either.
    if (incarnation === null) continue;
    liveLanes.add(`${lane.projectId}\u0000${lane.slot}`);
    const replaced = incarnation !== generation;
    if (replaced) complete = false;
    const terminal = replaced ? undefined : byId.get(running.terminalId);
    live.push(
      liveEntry({
        role: "assistant",
        hostId: sources.hostId,
        projectId: lane.projectId,
        terminalId: running.terminalId,
        incarnation,
        // The global session is held as a lane of its reserved id, but is named
        // by its own scope: a viewer resolving it as a project lane is refused.
        ...(isGlobalAssistantId(lane.projectId) ? { global: true } : { lane: lane.slot }),
        agentId: terminal?.detectedAgentId ?? terminal?.launchAgentId ?? lane.agentId,
        attached: lane.attached !== false,
        terminal,
      })
    );
  }

  const workers: AgentDirectoryLiveEntry[] = [];
  // A picker of assistants reads none: workers would only crowd them out of the cap.
  for (const terminal of assistantsOnly ? [] : terminals) {
    if (!terminal.projectId) continue;
    if (projectId !== undefined && terminal.projectId !== projectId) continue;
    if (classifyRun(terminal, (id) => sources.isHelpTerminal(id)) !== null) continue;
    const incarnation = sources.getLiveGeneration(terminal.id);
    if (incarnation === null) {
      // A worker with no run to name can't be targeted exactly, and can't be left out silently.
      complete = false;
      continue;
    }
    workers.push(
      liveEntry({
        role: "worker",
        hostId: sources.hostId,
        projectId: terminal.projectId,
        terminalId: terminal.id,
        incarnation,
        agentId: terminal.detectedAgentId ?? terminal.launchAgentId ?? null,
        attached: null,
        terminal,
      })
    );
  }
  workers.sort(
    (a, b) =>
      scopeProject(a).localeCompare(scopeProject(b)) ||
      (byId.get(a.subject.terminalId)?.spawnedAt ?? 0) -
        (byId.get(b.subject.terminalId)?.spawnedAt ?? 0) ||
      a.subject.terminalId.localeCompare(b.subject.terminalId)
  );

  const resumable: AgentDirectoryResumableEntry[] = [];
  const stored = await sources.resumableLanes(projectId);
  if (!stored.complete) complete = false;
  for (const pointer of stored.lanes) {
    if (pointer.slot < 0 || pointer.slot >= MAX_ASSISTANT_SLOTS) continue;
    // A live lane wins: a pointer recorded at launch coexists with its running session.
    if (liveLanes.has(`${pointer.projectId}\u0000${pointer.slot}`)) continue;
    resumable.push({
      state: "resumable",
      role: "assistant",
      hostId: sources.hostId,
      scope: { kind: "project", projectId: pointer.projectId },
      lane: pointer.slot,
      agentId: pointer.agentId,
      capturedAt: pointer.capturedAt,
    });
  }
  resumable.sort((a, b) => a.scope.projectId.localeCompare(b.scope.projectId) || a.lane - b.lane);

  const all: AgentDirectoryEntry[] = [...live, ...workers, ...resumable];
  const entries = all.slice(0, AGENT_DIRECTORY_ENTRIES_MAX);
  return {
    coverage: "ok",
    observedAt: sources.now(),
    complete,
    omitted: all.length - entries.length,
    entries,
  };
}

function scopeProject(entry: AgentDirectoryLiveEntry): string {
  return entry.subject.scope.kind === "project" ? entry.subject.scope.projectId : "";
}

function liveEntry(input: {
  role: "worker" | "assistant";
  hostId: string;
  projectId: string;
  terminalId: string;
  incarnation: number;
  lane?: number;
  global?: boolean;
  agentId: string | null;
  attached: boolean | null;
  terminal: PtyTerminal | undefined;
}): AgentDirectoryLiveEntry {
  const { terminal } = input;
  const agentState = terminal?.agentState ?? null;
  return {
    state: "live",
    role: input.role,
    subject: {
      hostId: input.hostId,
      scope: input.global ? { kind: "global" } : { kind: "project", projectId: input.projectId },
      terminalId: input.terminalId,
      incarnation: input.incarnation,
      ...(input.lane !== undefined ? { lane: input.lane } : {}),
    },
    agentId: input.agentId,
    agentState,
    waitingReason: agentState === "waiting" ? (terminal?.waitingReason ?? null) : null,
    since:
      typeof terminal?.lastStateChange === "number" && terminal.lastStateChange > 0
        ? terminal.lastStateChange
        : null,
    label: cutAgentLabel(terminal?.title ?? terminal?.lastObservedTitle),
    attached: input.attached,
    handback: terminal?.lastHandback ? { observedAt: terminal.lastHandback.observedAt } : null,
  };
}

/** How long a read may take before the last known directory answers instead. */
const AGENT_DIRECTORY_READ_MS = 4_000;

/** Scopes whose last known directory is kept; a project filter is caller-chosen. */
const LAST_KNOWN_SCOPES_MAX = 64;

/**
 * This machine's directory with the last known one kept: a read that throws
 * answers with what was seen before, dated when it was seen and marked stale,
 * and never as an empty inventory. Reads of one scope share a flight.
 */
export class LocalAgentDirectory {
  private readonly last = new Map<string, AgentDirectory>();
  private readonly inFlight = new Map<string, Promise<AgentDirectory>>();

  constructor(
    private readonly sources: AgentDirectorySources,
    private readonly deadlineMs: number = AGENT_DIRECTORY_READ_MS
  ) {}

  read(options: AgentDirectoryReadOptions = {}): Promise<AgentDirectory> {
    const key = `${options.assistantsOnly ? "a" : "*"}:${options.projectId ?? ""}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const keepLast = (): AgentDirectory => {
      const previous = this.last.get(key);
      return previous
        ? { ...previous, coverage: "stale", complete: false }
        : unreadAgentDirectory("unreachable");
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<AgentDirectory>((resolve) => {
      timer = setTimeout(() => resolve(keepLast()), this.deadlineMs);
    });
    const read = collectAgentDirectory(this.sources, options).then(
      (directory) => {
        // A failed pty shard is not an inventory: it must not replace one that was read.
        if (directory.coverage === "ok" && !directory.complete && this.last.has(key)) {
          const previous = this.last.get(key);
          if (previous && previous.complete) return keepLast();
        }
        this.last.delete(key);
        this.last.set(key, directory);
        if (this.last.size > LAST_KNOWN_SCOPES_MAX) {
          this.last.delete(this.last.keys().next().value as string);
        }
        return directory;
      },
      () => keepLast()
    );
    const flight = Promise.race([read, deadline]).finally(() => {
      clearTimeout(timer);
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, flight);
    return flight;
  }
}
