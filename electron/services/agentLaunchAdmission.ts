import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentLaunchLimit } from "../../shared/config/agentLaunchCapacity.js";
import type {
  AgentLaunchAdmission,
  AgentLaunchObservation,
} from "../../shared/types/agentLaunchAdmission.js";
import { parseCgroupBytes, parseProcSelfCgroup } from "../remote/metrics/parsers.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { checkKernelPressureCritical } from "./SystemMemoryPressureMonitor.js";

/**
 * Longest an admitted launch holds its place before it shows up as a live
 * terminal. Its spawn normally lands in well under a second; a launch whose
 * pane closed before it spawned simply lets the place go.
 */
export const AGENT_LAUNCH_RESERVATION_TTL_MS = 60_000;

/** How long a total-memory reading answers before it is read again. */
const MEMORY_TOTAL_CACHE_MS = 60_000;
const CGROUP_ROOT = "/sys/fs/cgroup";

/** The fields of a terminal record that say whether it is a live agent. */
export interface AgentCountableTerminal {
  id: string;
  launchAgentId?: string;
  hasPty?: boolean;
  isExited?: boolean;
  isAssistantTerminal?: boolean;
  agentState?: string;
}

/**
 * A terminal an agent was launched into, its agent still there. Whatever else
 * its state says: an idle agent at a prompt still has a session to come back
 * to. One whose agent was seen to exit is a shell now, and costs little. The
 * assistant is tooling, not a run the user started.
 */
export function isLiveAgentTerminal(terminal: AgentCountableTerminal): boolean {
  return (
    Boolean(terminal.launchAgentId) &&
    terminal.hasPty !== false &&
    terminal.isExited !== true &&
    terminal.agentState !== "exited" &&
    terminal.isAssistantTerminal !== true
  );
}

export interface AgentLaunchAdmissionSources {
  /** Every terminal on this host; null when there is no PTY client. */
  readTerminals(): Promise<{ terminals: AgentCountableTerminal[]; degraded: boolean } | null>;
  readMemoryTotalBytes(): Promise<number | null>;
  isKernelCritical(): Promise<boolean>;
  now(): number;
}

export interface AgentLaunchAdmissionController {
  /** What the host looks like now, reserving nothing: for a hold's poll. */
  observe(): Promise<AgentLaunchObservation>;
  /** Admit one launch, keeping its place until its terminal shows up live. */
  request(terminalId: string): Promise<AgentLaunchAdmission>;
}

export function createAgentLaunchAdmission(
  sources: AgentLaunchAdmissionSources
): AgentLaunchAdmissionController {
  // terminal id -> when its place lapses
  const reservations = new Map<string, number>();
  // One read-and-judge at a time: a read taken before a launch showed up live
  // must not be judged after a newer read let that launch's place go.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  async function read() {
    const [snapshot, total, critical] = await Promise.all([
      sources.readTerminals().catch(() => null),
      sources.readMemoryTotalBytes().catch(() => null),
      sources.isKernelCritical().catch(() => false),
    ]);
    return { snapshot, total, critical };
  }

  // Synchronous from here on, so two launches that read the same host can't
  // both take its last place.
  function judge(
    { snapshot, total, critical }: Awaited<ReturnType<typeof read>>,
    requesterId: string | null
  ): AgentLaunchAdmission {
    const now = sources.now();
    const live = new Set<string>();
    for (const terminal of snapshot?.terminals ?? []) {
      if (isLiveAgentTerminal(terminal)) live.add(terminal.id);
    }
    for (const [id, expiresAt] of reservations) {
      if (expiresAt <= now || live.has(id)) reservations.delete(id);
    }
    let startingAgents = 0;
    for (const id of reservations.keys()) {
      if (id !== requesterId) startingAgents += 1;
    }
    // A shard that didn't answer would undercount: no count rather than a low one.
    const runningAgents = snapshot && !snapshot.degraded ? live.size : null;
    const limit = agentLaunchLimit(total);
    // Already running here (another view started it): attaching starts nothing new.
    const alreadyLive = requesterId !== null && live.has(requesterId);
    const observation: AgentLaunchObservation = {
      kernelCritical: critical,
      runningAgents,
      startingAgents,
      agentLaunchLimit: limit,
      memoryTotalBytes: total,
    };
    const atCapacity =
      !alreadyLive &&
      runningAgents !== null &&
      limit !== null &&
      runningAgents + startingAgents >= limit;
    return {
      holdReason: critical ? "kernel-critical" : atCapacity ? "agent-capacity" : null,
      observation,
    };
  }

  return {
    observe() {
      return serially(async () => judge(await read(), null).observation);
    },
    request(terminalId) {
      return serially(async () => {
        const reading = await read();
        const admission = judge(reading, terminalId);
        const live = reading.snapshot?.terminals.some(
          (terminal) => terminal.id === terminalId && isLiveAgentTerminal(terminal)
        );
        if (admission.holdReason === null && !live) {
          reservations.set(terminalId, sources.now() + AGENT_LAUNCH_RESERVATION_TTL_MS);
        } else {
          reservations.delete(terminalId);
        }
        return admission;
      });
    },
  };
}

/**
 * The tightest memory ceiling this process runs under: the machine's RAM, or
 * a cgroup v2 `memory.max` on its own cgroup or an ancestor. Null when unknown.
 */
export async function readEffectiveMemoryTotalBytes(
  readText: (file: string) => Promise<string | null> = readTextOrNull,
  platform: NodeJS.Platform = process.platform,
  totalmem: () => number = os.totalmem
): Promise<number | null> {
  const machine = totalmem();
  let total = Number.isFinite(machine) && machine > 0 ? machine : null;
  if (platform !== "linux") return total;
  const segments = parseProcSelfCgroup(await readText("/proc/self/cgroup"));
  if (!segments) return total;
  // The mount root too: a container's own limit sits there when it is all one cgroup.
  const limits = await Promise.all(
    Array.from({ length: segments.length + 1 }, (_, depth) =>
      readText(path.posix.join(CGROUP_ROOT, ...segments.slice(0, depth), "memory.max"))
    )
  );
  for (const text of limits) {
    const limit = parseCgroupBytes(text);
    if (limit !== null && limit > 0 && (total === null || limit < total)) total = limit;
  }
  return total;
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

let cachedTotal: { value: number | null; readAt: number } | null = null;

async function cachedMemoryTotalBytes(): Promise<number | null> {
  const now = Date.now();
  if (cachedTotal && now - cachedTotal.readAt >= 0 && now - cachedTotal.readAt < MEMORY_TOTAL_CACHE_MS) {
    return cachedTotal.value;
  }
  const value = await readEffectiveMemoryTotalBytes();
  cachedTotal = { value, readAt: now };
  return value;
}

let admission: AgentLaunchAdmissionController | null = null;

/** This host's admission, shared by every project view that launches on it. */
export function getAgentLaunchAdmission(): AgentLaunchAdmissionController {
  admission ??= createAgentLaunchAdmission({
    readTerminals: async () => {
      const pty = getPtyClient();
      return pty ? pty.getAllTerminalsWithCompletenessAsync() : null;
    },
    readMemoryTotalBytes: cachedMemoryTotalBytes,
    isKernelCritical: () => checkKernelPressureCritical(),
    now: Date.now,
  });
  return admission;
}
