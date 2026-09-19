/**
 * Pure measurement logic for the idle harness (#12521): parsing the process
 * sampler, whole-tree CPU and wakeup accounting across a window, the spawn
 * census, and the run configuration. Kept free of Electron so every number the
 * harness reports can be checked in a unit test.
 *
 * Accounting model. The sampler reports, per live process, its own cumulative
 * CPU and the cumulative CPU of the children it has reaped. The tree's total at
 * an instant is the sum of both over every live process in it, and that total
 * is conserved when a process exits: its CPU moves into its reaper's child
 * counter. So the window's cost is the end total minus the start total, and
 * short-lived children that were born and reaped inside the window — the `ps`
 * forks this issue is about — are counted without ever being seen.
 *
 * A process that exited mid-window folded its whole lifetime into its reaper,
 * including CPU spent before the window opened. That pre-window share is known
 * from the start sample and is charged back against the reaper, so each
 * process's figure is its cost inside the window, not merely the tree total.
 */

export interface ProcessSample {
  pid: number;
  ppid: number;
  /** Process start time in epoch microseconds; with the pid, one incarnation. */
  startUs: number;
  selfNs: number;
  childNs: number;
  idleWakeups: number;
  interruptWakeups: number;
  childIdleWakeups: number;
  childInterruptWakeups: number;
  name: string;
}

export interface SamplerSnapshot {
  atUs: number;
  processes: Map<number, ProcessSample>;
}

const SAMPLER_FIELDS = 10;

export function parseSamplerOutput(stdout: string): SamplerSnapshot {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  const header = lines[0]?.split("\t");
  if (!header || header[0] !== "v1" || !/^\d+$/.test(header[1] ?? "")) {
    throw new Error(`sampler output has no v1 header (got ${JSON.stringify(lines[0] ?? "")})`);
  }
  const processes = new Map<number, ProcessSample>();
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    if (fields.length < SAMPLER_FIELDS) continue;
    const numbers = fields.slice(0, SAMPLER_FIELDS - 1).map(Number);
    if (!numbers.every((value) => Number.isFinite(value) && value >= 0)) continue;
    const [pid, ppid, startUs, selfNs, childNs, idle, interrupt, childIdle, childInterrupt] =
      numbers as [number, number, number, number, number, number, number, number, number];
    processes.set(pid, {
      pid,
      ppid,
      startUs,
      selfNs,
      childNs,
      idleWakeups: idle,
      interruptWakeups: interrupt,
      childIdleWakeups: childIdle,
      childInterruptWakeups: childInterrupt,
      name: fields.slice(SAMPLER_FIELDS - 1).join("\t"),
    });
  }
  return { atUs: Number(header[1]), processes };
}

/**
 * BSD `ps` cumulative `time`: `[dd-][hh:]mm:ss.cc`. Minutes are not bounded at
 * 60 on macOS (a long-lived daemon prints `1238:55.38`). Null when unparseable
 * — a missing reading must never become zero CPU.
 */
export function parsePsCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  );
}

export interface DaemonCpuReading {
  pid: number;
  cpuSeconds: number;
}

/**
 * Pick named system daemons out of `ps -axo pid=,time=,comm=`. The sampler
 * cannot read them — they run as root — but `ps` is setuid and can. Matched on
 * the executable's basename; a daemon that is not running is simply absent.
 */
export function parseDaemonCpu(
  stdout: string,
  names: readonly string[]
): Record<string, DaemonCpuReading> {
  const wanted = new Set(names);
  const out: Record<string, DaemonCpuReading> = {};
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[3]!.split("/").pop()!;
    if (!wanted.has(name) || out[name]) continue;
    const cpuSeconds = parsePsCpuTime(match[2]!);
    if (cpuSeconds === null) continue;
    out[name] = { pid: Number(match[1]), cpuSeconds };
  }
  return out;
}

export interface ProcessUsage {
  pid: number;
  ppid: number;
  name: string;
  label: string;
  /** Not present when the window opened. */
  born: boolean;
  /** This process's own CPU inside the window. */
  cpuNs: number;
  /** CPU of children it reaped inside the window, pre-window share removed. */
  reapedChildCpuNs: number;
  idleWakeups: number;
  interruptWakeups: number;
  reapedChildIdleWakeups: number;
  reapedChildInterruptWakeups: number;
}

export interface DepartedProcess {
  pid: number;
  name: string;
  label: string;
  /** The live ancestor its pre-window share was charged against, if any. */
  chargedToPid: number | null;
}

export interface LabelUsage {
  processes: number;
  cpuNs: number;
  idleWakeups: number;
  interruptWakeups: number;
}

export interface TreeUsage {
  elapsedMs: number;
  totalCpuNs: number;
  totalIdleWakeups: number;
  totalInterruptWakeups: number;
  processes: ProcessUsage[];
  byLabel: Record<string, LabelUsage>;
  departed: DepartedProcess[];
  /**
   * Pre-window CPU of departed processes with no live ancestor to charge it
   * to. Already excluded from every total; reported so a non-zero value (the
   * tree lost a branch to reparenting) is visible rather than silent.
   */
  unattributedNs: number;
}

function identity(sample: ProcessSample): string {
  return `${sample.pid}:${sample.startUs}`;
}

/** The root and everything below it, following each sample's ppid. */
export function descendantsOf(snapshot: SamplerSnapshot, rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const sample of snapshot.processes.values()) {
    if (sample.pid === sample.ppid) continue;
    const list = children.get(sample.ppid);
    if (list) list.push(sample.pid);
    else children.set(sample.ppid, [sample.pid]);
  }
  const out = new Set<number>();
  if (!snapshot.processes.has(rootPid)) return out;
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (out.has(pid)) continue;
    out.add(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return out;
}

/**
 * A process's label, or its nearest labelled ancestor's with `/child`
 * appended — so a live `ps` fork of the pty-host reads `pty-host/child` and the
 * streaming terminal's workload reads `terminal:stream/child`.
 */
export function resolveLabel(
  snapshot: SamplerSnapshot,
  pid: number,
  labels: ReadonlyMap<number, string>
): string {
  const own = labels.get(pid);
  if (own) return own;
  const seen = new Set<number>([pid]);
  let current = snapshot.processes.get(pid);
  while (current && !seen.has(current.ppid)) {
    seen.add(current.ppid);
    const label = labels.get(current.ppid);
    if (label) return `${label}/child`;
    current = snapshot.processes.get(current.ppid);
  }
  return "other";
}

export function computeTreeUsage({
  start,
  end,
  rootPid,
  labels,
}: {
  start: SamplerSnapshot;
  end: SamplerSnapshot;
  rootPid: number;
  labels: ReadonlyMap<number, string>;
}): TreeUsage {
  const startTree = descendantsOf(start, rootPid);
  const endTree = descendantsOf(end, rootPid);
  if (endTree.size === 0) {
    throw new Error(`root pid ${rootPid} is missing from the closing sample`);
  }

  const startByIdentity = new Map<string, ProcessSample>();
  for (const pid of startTree) {
    const sample = start.processes.get(pid)!;
    startByIdentity.set(identity(sample), sample);
  }
  const endIdentities = new Set<string>();
  for (const sample of end.processes.values()) endIdentities.add(identity(sample));

  // A start-tree process still alive but no longer under the root (reparented
  // away) keeps being accounted, or its CPU would drop out of the end total.
  const accounted = new Set(endTree);
  for (const [key, sample] of startByIdentity) {
    if (endIdentities.has(key) && !endTree.has(sample.pid)) accounted.add(sample.pid);
  }

  const usageByPid = new Map<number, ProcessUsage>();
  for (const pid of accounted) {
    const now = end.processes.get(pid)!;
    const before = startByIdentity.get(identity(now));
    usageByPid.set(pid, {
      pid,
      ppid: now.ppid,
      name: now.name,
      label: resolveLabel(end, pid, labels),
      born: !before,
      cpuNs: now.selfNs - (before?.selfNs ?? 0),
      reapedChildCpuNs: now.childNs - (before?.childNs ?? 0),
      idleWakeups: now.idleWakeups - (before?.idleWakeups ?? 0),
      interruptWakeups: now.interruptWakeups - (before?.interruptWakeups ?? 0),
      reapedChildIdleWakeups: now.childIdleWakeups - (before?.childIdleWakeups ?? 0),
      reapedChildInterruptWakeups: now.childInterruptWakeups - (before?.childInterruptWakeups ?? 0),
    });
  }

  const departed: DepartedProcess[] = [];
  let unattributedNs = 0;
  for (const [key, sample] of startByIdentity) {
    if (endIdentities.has(key)) continue;
    // Walk the start-time ancestry to the first process still alive as the
    // same incarnation — the one whose child counter absorbed this lifetime.
    let chargedTo: ProcessUsage | undefined;
    let ancestor = start.processes.get(sample.ppid);
    const seen = new Set<number>([sample.pid]);
    while (ancestor && !seen.has(ancestor.pid)) {
      seen.add(ancestor.pid);
      if (endIdentities.has(identity(ancestor))) {
        chargedTo = usageByPid.get(ancestor.pid);
        break;
      }
      ancestor = start.processes.get(ancestor.ppid);
    }
    const lifetimeNs = sample.selfNs + sample.childNs;
    if (chargedTo) {
      chargedTo.reapedChildCpuNs -= lifetimeNs;
      chargedTo.reapedChildIdleWakeups -= sample.idleWakeups + sample.childIdleWakeups;
      chargedTo.reapedChildInterruptWakeups -=
        sample.interruptWakeups + sample.childInterruptWakeups;
    } else {
      unattributedNs += lifetimeNs;
    }
    departed.push({
      pid: sample.pid,
      name: sample.name,
      label: resolveLabel(start, sample.pid, labels),
      chargedToPid: chargedTo?.pid ?? null,
    });
  }

  const processes = [...usageByPid.values()].sort(
    (a, b) => b.cpuNs + b.reapedChildCpuNs - (a.cpuNs + a.reapedChildCpuNs)
  );
  const byLabel: Record<string, LabelUsage> = {};
  let totalCpuNs = 0;
  let totalIdleWakeups = 0;
  let totalInterruptWakeups = 0;
  for (const usage of processes) {
    const cpuNs = usage.cpuNs + usage.reapedChildCpuNs;
    const idle = usage.idleWakeups + usage.reapedChildIdleWakeups;
    const interrupt = usage.interruptWakeups + usage.reapedChildInterruptWakeups;
    totalCpuNs += cpuNs;
    totalIdleWakeups += idle;
    totalInterruptWakeups += interrupt;
    const bucket = (byLabel[usage.label] ??= {
      processes: 0,
      cpuNs: 0,
      idleWakeups: 0,
      interruptWakeups: 0,
    });
    bucket.processes++;
    bucket.cpuNs += cpuNs;
    bucket.idleWakeups += idle;
    bucket.interruptWakeups += interrupt;
  }

  return {
    elapsedMs: (end.atUs - start.atUs) / 1000,
    totalCpuNs,
    totalIdleWakeups,
    totalInterruptWakeups,
    processes,
    byLabel,
    departed,
    unattributedNs,
  };
}

/** Percent of one core over `elapsedMs`. */
export function cpuPercent(cpuNs: number, elapsedMs: number): number {
  return elapsedMs > 0 ? (cpuNs / 1e6 / elapsedMs) * 100 : Number.NaN;
}

export interface CensusFileLike {
  role: string;
  pid: number;
  flushedAtMs: number;
  exited: boolean;
  buckets: Record<string, Record<string, number>>;
}

export interface CensusSlice {
  /** role:command -> launches inside the window. */
  byCommand: Record<string, number>;
  total: number;
  /** Processes whose last flush predates the window's close without exiting. */
  stale: Array<{ role: string; pid: number; flushedAtMs: number }>;
  files: number;
}

/**
 * Sum one-second buckets wholly inside `[startMs, endMs)`. The harness opens
 * and closes its window on whole seconds, so "wholly inside" loses nothing.
 */
export function sliceSpawnCensus(
  files: readonly CensusFileLike[],
  startMs: number,
  endMs: number
): CensusSlice {
  const byCommand: Record<string, number> = {};
  const stale: CensusSlice["stale"] = [];
  let total = 0;
  for (const file of files) {
    if (!file.exited && file.flushedAtMs < endMs) {
      stale.push({ role: file.role, pid: file.pid, flushedAtMs: file.flushedAtMs });
    }
    for (const [secondText, counts] of Object.entries(file.buckets)) {
      const bucketStart = Number(secondText) * 1000;
      if (!(bucketStart >= startMs && bucketStart + 1000 <= endMs)) continue;
      for (const [command, count] of Object.entries(counts)) {
        const key = `${file.role}:${command}`;
        byCommand[key] = (byCommand[key] ?? 0) + count;
        total += count;
      }
    }
  }
  return { byCommand, total, stale, files: files.length };
}

export const IDLE_HARNESS_CONFIG_ENV = "DAINTREE_IDLE_HARNESS_CONFIG";

export interface IdleHarnessConfig {
  /** Cell name, for the report only. */
  cell: string;
  /** Terminals per project, the active project first. Its length is the project count. */
  terminalsPerProject: number[];
  /** Run a fixed-rate output workload in the active project's first terminal. */
  stream: boolean;
  blurred: boolean;
  /**
   * Cached project whose first terminal carries a live agent state, so the
   * efficiency freeze skips its view. Null when the cell has none.
   */
  protectedProjectIndex: number | null;
  windowMs: number;
  settleMs: number;
  samplerPath: string;
}

const MAX_PROJECTS = 5;
const MAX_TERMINALS_PER_PROJECT = 30;

/** Validate the runner's config. Returns the problems rather than guessing. */
export function parseIdleHarnessConfig(
  raw: string | undefined
): { config: IdleHarnessConfig } | { errors: string[] } {
  if (!raw) return { errors: [`${IDLE_HARNESS_CONFIG_ENV} is not set`] };
  let value: Partial<IdleHarnessConfig>;
  try {
    value = JSON.parse(raw) as Partial<IdleHarnessConfig>;
  } catch {
    return { errors: [`${IDLE_HARNESS_CONFIG_ENV} is not JSON`] };
  }
  const errors: string[] = [];
  const terminals = value.terminalsPerProject;
  if (
    !Array.isArray(terminals) ||
    terminals.length < 1 ||
    terminals.length > MAX_PROJECTS ||
    !terminals.every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_TERMINALS_PER_PROJECT)
  ) {
    errors.push(
      `terminalsPerProject must list 1-${MAX_PROJECTS} projects of 0-${MAX_TERMINALS_PER_PROJECT} terminals`
    );
  }
  const counts = Array.isArray(terminals) ? terminals : [];
  if (typeof value.stream !== "boolean") errors.push("stream must be a boolean");
  if (value.stream && !(counts[0]! >= 1)) {
    errors.push("stream needs at least one terminal in the active project");
  }
  if (typeof value.blurred !== "boolean") errors.push("blurred must be a boolean");
  const protectedIndex = value.protectedProjectIndex;
  if (protectedIndex !== null) {
    if (
      !Number.isInteger(protectedIndex) ||
      protectedIndex! < 1 ||
      protectedIndex! >= counts.length
    ) {
      errors.push("protectedProjectIndex must name a cached project (1..projects-1) or be null");
    } else if (!(counts[protectedIndex!]! >= 1)) {
      errors.push("the protected project needs at least one terminal to hold its agent");
    }
  }
  for (const key of ["windowMs", "settleMs"] as const) {
    const n = value[key];
    if (!Number.isInteger(n) || n! < 0) errors.push(`${key} must be a non-negative integer`);
  }
  if (typeof value.samplerPath !== "string" || value.samplerPath.length === 0) {
    errors.push("samplerPath must be set");
  }
  if (typeof value.cell !== "string") errors.push("cell must be a string");
  return errors.length > 0 ? { errors } : { config: value as IdleHarnessConfig };
}

export interface CellObservation {
  /** One per requested project, in config order. */
  views: Array<{ state: string | null; rendererPid: number | null }>;
  /** Live PTYs per project, in config order. */
  liveTerminals: number[];
  inventoryDegraded: boolean;
  windowVisible: boolean;
  windowMinimized: boolean;
  windowFocused: boolean;
  /** `document.hasFocus()` in the active view; null when it did not answer. */
  documentHasFocus: boolean | null;
  /** Null when the cell has no protected project. */
  protectedAgentActive: boolean | null;
  /** Null when the cell does not stream. */
  streamWorkloadAlive: boolean | null;
}

/**
 * Did the cell the runner asked for actually exist? A reading taken from a
 * smaller or different fixture than requested is the easiest way for this
 * harness to report a flattering wrong number, so every mismatch is a failure.
 */
export function checkMaterialised(
  config: IdleHarnessConfig,
  observed: CellObservation,
  phase: "start" | "end"
): string[] {
  const failures: string[] = [];
  const at = `at window ${phase}`;
  config.terminalsPerProject.forEach((expected, index) => {
    const view = observed.views[index];
    const wanted = index === 0 ? "active" : "cached";
    if (!view || view.state !== wanted) {
      failures.push(
        `project ${index + 1} view is ${view?.state ?? "missing"}, expected ${wanted} ${at}`
      );
    } else if (!view.rendererPid) {
      failures.push(`project ${index + 1} has no live renderer ${at}`);
    }
    const live = observed.liveTerminals[index] ?? 0;
    if (live !== expected) {
      failures.push(`project ${index + 1} has ${live} live terminals, expected ${expected} ${at}`);
    }
  });
  const pids = observed.views.map((view) => view.rendererPid).filter((pid) => pid);
  if (new Set(pids).size !== pids.length) {
    failures.push(`project views share a renderer process ${at}; per-view cost is not separable`);
  }
  if (observed.inventoryDegraded) {
    failures.push(`a pty-host shard did not answer the terminal inventory ${at}`);
  }
  if (!observed.windowVisible || observed.windowMinimized) {
    failures.push(`window is not visible ${at}`);
  }
  if (observed.windowFocused === config.blurred) {
    failures.push(
      `window is ${observed.windowFocused ? "focused" : "blurred"} ${at}, the cell asks otherwise`
    );
  }
  if (observed.documentHasFocus !== null && observed.documentHasFocus === config.blurred) {
    failures.push(`active view document.hasFocus() is ${observed.documentHasFocus} ${at}`);
  }
  if (config.protectedProjectIndex !== null && observed.protectedAgentActive !== true) {
    failures.push(
      `protected project has no active agent state ${at}; the freeze would not skip it`
    );
  }
  if (config.stream && observed.streamWorkloadAlive !== true) {
    failures.push(`streaming workload is not running ${at}`);
  }
  return failures;
}

/** A renderer replaced inside the window means the reading spans two processes. */
export function checkRendererContinuity(start: CellObservation, end: CellObservation): string[] {
  const failures: string[] = [];
  start.views.forEach((view, index) => {
    const after = end.views[index]?.rendererPid;
    if (view.rendererPid && after && view.rendererPid !== after) {
      failures.push(
        `project ${index + 1}'s renderer was replaced inside the window (pid ${view.rendererPid} -> ${after})`
      );
    }
  });
  return failures;
}

export interface WindowEvents {
  windowEndMs: number;
  terminalExits: number;
  focusChanges: number;
  processesGone: number;
  protectedAgentStates: string[];
  /** Last output time of the streaming terminal; undefined when the cell does not stream. */
  streamLastOutputAt?: number;
  /**
   * The protected view's recorded `freeze`/`resume` events, or why they could
   * not be read (a frozen view does not answer); undefined without one.
   */
  protectedLifecycle?: Array<[string, number]> | string;
}

/** A streaming terminal must have produced output this recently at the close. */
export const STREAM_FRESHNESS_MS = 3_000;

/** What happened inside the window that makes its reading not the requested cell's. */
export function checkWindowEvents(events: WindowEvents): string[] {
  const failures: string[] = [];
  if (events.terminalExits > 0) {
    failures.push(`${events.terminalExits} fixture terminal(s) exited inside the window`);
  }
  if (events.focusChanges > 0) {
    failures.push("window focus changed inside the window — someone used the machine");
  }
  if (events.processesGone > 0) {
    failures.push("a process crashed or was killed inside the window");
  }
  if (events.protectedAgentStates.length > 0) {
    failures.push(
      `protected agent changed state inside the window (${events.protectedAgentStates.join(", ")})`
    );
  }
  if (
    events.streamLastOutputAt !== undefined &&
    events.windowEndMs - events.streamLastOutputAt > STREAM_FRESHNESS_MS
  ) {
    failures.push("streaming terminal had gone quiet by the end of the window");
  }
  const lifecycle = events.protectedLifecycle;
  if (
    typeof lifecycle === "string" ||
    (Array.isArray(lifecycle) &&
      lifecycle.some(([type, atMs]) => type === "freeze" && atMs < events.windowEndMs))
  ) {
    failures.push(
      "the protected view was frozen, so the freeze-exempt population was not measured"
    );
  }
  return failures;
}
