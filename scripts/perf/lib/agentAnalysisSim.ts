// Deterministic simulation harness for the agent-output analysis pipeline
// (PERF-035). Drives the REAL production worker stack — AnalysisWorkerRuntime
// → AnalysisSession (headless xterm mirror + ActivityMonitor + Osc94Parser +
// AgentActivityTemperature) — plus the host-side FSM layer (AgentStateService
// + SemanticBufferManager), exactly the wiring TerminalProcess uses in worker
// mode, for N concurrent simulated agents.
//
// Everything runs under a virtual clock (Date.now, performance.now, and the
// global timer functions are patched), so the full production timer topology
// — 50ms polling cycles, 30ms pattern-scan throttle, 8s idle debounce, xterm's
// deferred write queue — fires deterministically in virtual time while real
// CPU cost is measured with process.cpuUsage(). This yields two orthogonal
// numbers per run:
//
//   * the TAX: real CPU ms per MB of streamed output (and per agent-second)
//   * the QUALITY: virtual-time detection latency from the stream going quiet
//     to the FSM flipping working→waiting, and from output resuming to the
//     waiting→working flip
//
// Any optimization must lower the first without raising the second; the
// runner throws if an agent's FSM timeline deviates from the canonical
// sequence, so a "fast but blind" regression fails the scenario outright.

import { AnalysisWorkerRuntime } from "../../../electron/services/pty/analysis/AnalysisWorkerRuntime";
import { AgentStateService } from "../../../electron/services/pty/AgentStateService";
import { SemanticBufferManager } from "../../../electron/services/pty/SemanticBufferManager";
import { events } from "../../../electron/services/events";
import type { WorkerToHostMessage } from "../../../electron/services/pty/analysisWorkerProtocol";
import type { TerminalInfo } from "../../../electron/services/pty/types";
import type { AgentState } from "../../../shared/types/agent";

// === Virtual clock ===

interface ScheduledTimer {
  id: number;
  at: number;
  intervalMs?: number;
  fn: (...args: unknown[]) => void;
  args: unknown[];
}

interface VirtualTimerHandle {
  __virtualId: number;
  unref: () => VirtualTimerHandle;
  ref: () => VirtualTimerHandle;
  refresh: () => VirtualTimerHandle;
  hasRef: () => boolean;
  [Symbol.toPrimitive]: () => number;
}

/**
 * Patches Date.now / performance.now / setTimeout / setInterval /
 * clearTimeout / clearInterval with a deterministic virtual scheduler.
 * `tick(ms)` advances virtual time, firing due timers in timestamp order and
 * flushing microtasks between callbacks so promise chains (xterm's write
 * queue) settle deterministically. Always pair install() with uninstall() in
 * a try/finally — a leaked patch would corrupt every subsequent scenario.
 */
export class VirtualClock {
  private nowMs: number;
  private nextId = 1;
  private timers = new Map<number, ScheduledTimer>();
  private originals:
    | {
        dateNow: () => number;
        setTimeout: typeof globalThis.setTimeout;
        clearTimeout: typeof globalThis.clearTimeout;
        setInterval: typeof globalThis.setInterval;
        clearInterval: typeof globalThis.clearInterval;
        performanceNow: () => number;
      }
    | undefined;

  constructor(startMs = 1_800_000_000_000) {
    this.nowMs = startMs;
  }

  now(): number {
    return this.nowMs;
  }

  install(): void {
    if (this.originals) return;
    const g = globalThis as Record<string, unknown>;
    this.originals = {
      dateNow: Date.now,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      performanceNow: performance.now.bind(performance),
    };

    Date.now = () => this.nowMs;
    // AgentStateService's hysteresis window is performance.now-based; without
    // this patch, virtual seconds elapse in real microseconds and the 500ms
    // lock would suppress transitions that production would emit.
    performance.now = () => this.nowMs;

    g.setTimeout = ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      this.schedule(fn, delay ?? 0, undefined, args)) as unknown as typeof globalThis.setTimeout;
    g.setInterval = ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      this.schedule(
        fn,
        delay ?? 0,
        Math.max(1, delay ?? 1),
        args
      )) as unknown as typeof globalThis.setInterval;
    g.clearTimeout = ((handle: unknown) =>
      this.cancel(handle)) as unknown as typeof globalThis.clearTimeout;
    g.clearInterval = ((handle: unknown) =>
      this.cancel(handle)) as unknown as typeof globalThis.clearInterval;
  }

  uninstall(): void {
    if (!this.originals) return;
    Date.now = this.originals.dateNow;
    performance.now = this.originals.performanceNow;
    globalThis.setTimeout = this.originals.setTimeout;
    globalThis.clearTimeout = this.originals.clearTimeout;
    globalThis.setInterval = this.originals.setInterval;
    globalThis.clearInterval = this.originals.clearInterval;
    this.originals = undefined;
    this.timers.clear();
  }

  private schedule(
    fn: (...a: unknown[]) => void,
    delayMs: number,
    intervalMs: number | undefined,
    args: unknown[]
  ): VirtualTimerHandle {
    const id = this.nextId++;
    const timer: ScheduledTimer = {
      id,
      at: this.nowMs + Math.max(0, delayMs),
      intervalMs,
      fn,
      args,
    };
    this.timers.set(id, timer);
    const handle: VirtualTimerHandle = {
      __virtualId: id,
      unref: () => handle,
      ref: () => handle,
      refresh: () => {
        timer.at = this.nowMs + Math.max(0, delayMs);
        this.timers.set(id, timer);
        return handle;
      },
      hasRef: () => true,
      [Symbol.toPrimitive]: () => id,
    };
    return handle;
  }

  private cancel(handle: unknown): void {
    if (handle == null) return;
    const id =
      typeof handle === "number"
        ? handle
        : typeof handle === "object" && "__virtualId" in handle
          ? (handle as VirtualTimerHandle).__virtualId
          : undefined;
    if (id !== undefined) {
      this.timers.delete(id);
    }
  }

  async tick(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      let earliest: ScheduledTimer | undefined;
      for (const timer of this.timers.values()) {
        if (timer.at <= target && (!earliest || timer.at < earliest.at)) {
          earliest = timer;
        }
      }
      if (!earliest) break;
      this.nowMs = Math.max(this.nowMs, earliest.at);
      if (earliest.intervalMs !== undefined) {
        earliest.at = this.nowMs + earliest.intervalMs;
      } else {
        this.timers.delete(earliest.id);
      }
      earliest.fn(...earliest.args);
      await flushMicrotasks();
    }
    this.nowMs = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

// === Workload script ===
//
// Synthetic but production-shaped Claude-style agent session. Shapes are
// modeled on the recorded fixtures in
// electron/services/__tests__/fixtures/activity-monitor/: status-line
// rewrites (\r\x1b[2K + spinner + interrupt hint + token counter), SGR-colored
// tool-output bursts, OSC 9;4 progress pulses, a boxed prompt on settle.

export interface WorkloadPhases {
  /** Working phase: 10Hz spinner rewrites + periodic tool-output bursts. */
  workingMs: number;
  /** Heavy streaming phase: sustained appended output (~24 KB/s). */
  heavyMs: number;
  /** Quiet settle after the prompt box renders (must exceed the 8s idle debounce to observe the waiting flip). */
  settleMs: number;
  /** Resume phase: spinner rewrites again (drives the waiting→working flip). */
  resumeMs: number;
  /** Trailing quiet so the last transition settles before teardown. */
  tailMs: number;
}

export const DEFAULT_PHASES: WorkloadPhases = {
  workingMs: 5_000,
  heavyMs: 2_000,
  settleMs: 10_000,
  resumeMs: 3_000,
  tailMs: 500,
};

interface WorkloadEvent {
  atMs: number;
  data: string;
}

interface WorkloadScript {
  events: WorkloadEvent[];
  /** Timestamp of the last chunk before the settle quiet begins. */
  quietStartMs: number;
  /** Timestamp of the first chunk of the resume phase. */
  resumeStartMs: number;
  totalMs: number;
  totalBytes: number;
}

const SPINNER = ["✢", "✳", "✶", "✻", "✽"];

function makeWorkloadScript(phases: WorkloadPhases, agentIndex: number): WorkloadScript {
  const events: WorkloadEvent[] = [];
  // Stagger agents so their chunk schedules and poll phases don't collide in
  // artificial lockstep (production agents are independent processes).
  const offset = (agentIndex * 17) % 50;
  let at = offset;
  let bytes = 0;

  const push = (atMs: number, data: string): void => {
    events.push({ atMs, data });
    bytes += data.length;
  };

  // Boot banner (matches the claude bootCompletePatterns).
  push(at, "\x1b[?2004h\x1b[?25lClaude Code v2.1.79 (Sonnet 4.6)\r\n> \r\n");
  at += 200;

  // Working: 10Hz status-line rewrites + a 3-chunk SGR burst every 2s + an
  // OSC 9;4 indeterminate-progress pulse every 500ms.
  const workingEnd = at + phases.workingMs;
  let frame = 0;
  while (at < workingEnd) {
    const spin = SPINNER[frame % SPINNER.length];
    const secs = Math.floor(frame / 10) + 1;
    push(
      at,
      `\r\x1b[2K\x1b[38;5;215m${spin}\x1b[0m Deliberating… (esc to interrupt · ${secs}s · ↓ ${
        (frame * 13) % 1200
      } tokens)`
    );
    if (frame % 5 === 0) {
      push(at + 10, "\x1b]9;4;3;0\x07");
    }
    if (frame % 20 === 19) {
      for (let b = 0; b < 3; b++) {
        let burst = "\r\x1b[2K";
        for (let l = 0; l < 14; l++) {
          burst += `\x1b[38;5;245m  ⎿ src/services/module${(frame + l) % 40}.ts:${
            (l * 37 + frame) % 400
          } — updated handler ${b}.${l} with retry/backoff logic\x1b[0m\r\n`;
        }
        push(at + 20 + b * 15, burst);
      }
    }
    frame += 1;
    at += 100;
  }

  // Heavy streaming: appended log-ish output, ~2.4KB chunks at 10Hz (~24KB/s).
  const heavyEnd = at + phases.heavyMs;
  let line = 0;
  while (at < heavyEnd) {
    let chunk = "";
    for (let l = 0; l < 24; l++) {
      line += 1;
      chunk += `  reading ${line % 7 === 0 ? "\x1b[1m" : ""}packages/core/src/file${line % 97}.ts\x1b[0m — ${
        (line * 991) % 4096
      } bytes, ${(line * 17) % 100}% analyzed\r\n`;
    }
    push(at, chunk);
    at += 100;
  }

  // Settle: final answer + boxed prompt, then quiet.
  push(
    at,
    "\r\x1b[2K\r\nDone. Updated 12 handlers; all call sites now retry with exponential backoff.\r\n\r\n" +
      "╭──────────────────────────────────────────────────────────╮\r\n" +
      "│ > \x1b[7m \x1b[0m                                                      │\r\n" +
      "╰──────────────────────────────────────────────────────────╯\r\n" +
      "  ? for shortcuts\r\n"
  );
  const quietStartMs = at;
  at += phases.settleMs;

  // Resume: spinner rewrites again.
  const resumeStartMs = at;
  const resumeEnd = at + phases.resumeMs;
  frame = 0;
  while (at < resumeEnd) {
    const spin = SPINNER[frame % SPINNER.length];
    push(at, `\r\x1b[2K${spin} Reticulating… (esc to interrupt · ${frame / 10 + 1}s)`);
    frame += 1;
    at += 100;
  }

  at += phases.tailMs;

  return { events, quietStartMs, resumeStartMs, totalMs: at, totalBytes: bytes };
}

// === Fleet runner ===

export interface AgentAnalysisSimOptions {
  agents: number;
  agentId?: string;
  phases?: WorkloadPhases;
  cols?: number;
  rows?: number;
  scrollback?: number;
}

export interface AgentAnalysisSimResult {
  agents: number;
  fedBytes: number;
  virtualMs: number;
  wallMs: number;
  cpuMs: number;
  cpuMsPerMb: number;
  cpuMsPerAgentSecond: number;
  /** Median across agents; virtual ms from last output to the FSM waiting flip. */
  waitFlipLatencyMs: number;
  /** Median across agents; virtual ms from resumed output to the FSM working flip. */
  resumeFlipLatencyMs: number;
  /**
   * FSM state-change records the analysis pipeline actually emitted, and the
   * agents that produced each canonical flip.
   *
   * The scenario reports CPU rates and virtual-time latencies, all of which a
   * sim that analysed nothing would win outright. These are the readings it
   * could not produce: they come off the `agent:state-changed` stream, not off
   * the bytes that were fed in.
   */
  stateChangeRecords: number;
  agentsWithWaitFlip: number;
  agentsWithResumeFlip: number;
  /**
   * Bytes the workload scripts contain, totalled as they were built.
   *
   * `fedBytes` is the feed loop's own tally and it is the denominator of every
   * rate this sim reports, so the two agreeing is what proves the fleet was
   * charged for the whole workload. A feed loop that quietly stopped short
   * would report a lower tax over a smaller job.
   */
  scriptedBytes: number;
}

interface FsmRecord {
  atMs: number;
  state: AgentState;
}

let simSeq = 0;

/**
 * Run N simulated agents through the full analysis pipeline. Deterministic in
 * virtual time; CPU cost is real. Throws when any agent's FSM timeline
 * deviates from the canonical working→waiting→working sequence — a benchmark
 * that silently stopped detecting states must fail, not report a great tax.
 */
export async function runAgentAnalysisSim(
  options: AgentAnalysisSimOptions
): Promise<AgentAnalysisSimResult> {
  const agentCount = options.agents;
  const agentId = options.agentId ?? "claude";
  const phases = options.phases ?? DEFAULT_PHASES;
  const cols = options.cols ?? 120;
  const rows = options.rows ?? 30;
  const scrollback = options.scrollback ?? 5000;

  const clock = new VirtualClock();
  try {
    // Inside the try so a partial install still restores from the originals
    // captured before any global was patched.
    clock.install();
    const startVirtual = clock.now();
    const virtualMs = () => clock.now() - startVirtual;

    const service = new AgentStateService();
    const runId = ++simSeq;

    interface AgentSlot {
      terminalId: string;
      terminal: TerminalInfo;
      semanticBuffer: SemanticBufferManager;
      script: WorkloadScript;
      cursor: number;
      fsm: FsmRecord[];
    }

    const slots: AgentSlot[] = [];
    const byTerminalId = new Map<string, AgentSlot>();
    let scriptedBytes = 0;

    const onStateChanged = (payload: { terminalId?: string; state: AgentState }): void => {
      const slot = payload.terminalId ? byTerminalId.get(payload.terminalId) : undefined;
      if (!slot) return;
      slot.fsm.push({ atMs: virtualMs(), state: payload.state });
    };
    events.on("agent:state-changed", onStateChanged);

    const emit = (msg: WorkerToHostMessage): void => {
      if (msg.type === "activity-state") {
        const slot = byTerminalId.get(msg.terminalId);
        if (slot) service.handleActivityState(slot.terminal, msg.state, msg.metadata);
      } else if (msg.type === "waiting-timeout") {
        const slot = byTerminalId.get(msg.terminalId);
        if (slot) service.updateAgentState(slot.terminal, { type: "watchdog-timeout" });
      }
      // data-ack / viewport / boot-complete are host bookkeeping — no FSM effect.
    };

    const runtime = new AnalysisWorkerRuntime(emit);

    try {
      for (let i = 0; i < agentCount; i++) {
        const terminalId = `perf-agent-${runId}-${i}`;
        const terminal = {
          id: terminalId,
          cwd: "/perf",
          shell: "/bin/zsh",
          spawnedAt: Date.now(),
          analysisEnabled: true,
          lastInputTime: 0,
          lastOutputTime: 0,
          lastCheckTime: 0,
          restartCount: 0,
          launchAgentId: agentId,
          agentState: "idle",
          ptyProcess: {} as never,
          outputBuffer: "",
          semanticBuffer: [] as string[],
        } as unknown as TerminalInfo;

        const slot: AgentSlot = {
          terminalId,
          terminal,
          semanticBuffer: new SemanticBufferManager(terminal),
          script: makeWorkloadScript(phases, i),
          cursor: 0,
          fsm: [],
        };
        slots.push(slot);
        byTerminalId.set(terminalId, slot);
        scriptedBytes += slot.script.totalBytes;

        runtime.handleMessage({
          type: "create",
          terminalId,
          cols,
          rows,
          scrollback,
          restore: false,
          spawnedAt: Date.now(),
          epoch: 0,
        });
        runtime.handleMessage({
          type: "monitor-start",
          terminalId,
          agentId,
          initialState: "busy",
          skipInitialStateEmit: false,
          hasProcessValidator: false,
          pollingIntervalMs: 50,
        });
      }

      const totalVirtualMs = Math.max(...slots.map((slot) => slot.script.totalMs));
      let fedBytes = 0;

      const wallStart = process.hrtime.bigint();
      const cpuStart = process.cpuUsage();

      // Merged timeline: advance in small steps, feeding each agent's due
      // chunks (mirrors production, where PTY data callbacks interleave with
      // the monitors' own timers — which fire inside tick()).
      const STEP_MS = 10;
      for (let now = 0; now <= totalVirtualMs; now += STEP_MS) {
        for (const slot of slots) {
          while (
            slot.cursor < slot.script.events.length &&
            slot.script.events[slot.cursor]!.atMs <= now
          ) {
            const { data } = slot.script.events[slot.cursor]!;
            slot.cursor += 1;
            fedBytes += data.length;
            slot.semanticBuffer.onData(data);
            runtime.handleMessage({
              type: "data",
              terminalId: slot.terminalId,
              data,
              flags: {
                agentLive: true,
                agentState: slot.terminal.agentState,
              },
              epoch: 0,
            });
          }
        }
        await clock.tick(STEP_MS);
      }

      const cpuEnd = process.cpuUsage(cpuStart);
      const wallEnd = process.hrtime.bigint();

      // Correctness guard: every agent's FSM timeline must be exactly the
      // canonical working → waiting → working sequence at the right phase
      // boundaries. Premature flips (a spurious waiting mid-stream), missing
      // flips, and unexpected states (completed/exited) all fail the run —
      // the workload is deterministic, so any deviation is a semantic change.
      const waitLatencies: number[] = [];
      const resumeLatencies: number[] = [];
      let stateChangeRecords = 0;
      for (const slot of slots) {
        stateChangeRecords += slot.fsm.length;
        const seq = slot.fsm;
        // Annotated on the variable, not just the arrow: control-flow analysis
        // only treats a call as unreachable when the *binding* is typed, so
        // without this the `if (!flip) fail()` guards below narrow nothing.
        const fail: (reason: string) => never = (reason) => {
          throw new Error(
            `[agentAnalysisSim] FSM timeline broken for ${slot.terminalId}: ${reason} — ` +
              JSON.stringify(seq) +
              ` (quietStartMs=${slot.script.quietStartMs}, resumeStartMs=${slot.script.resumeStartMs})`
          );
        };
        const unexpected = seq.find((r) => r.state !== "working" && r.state !== "waiting");
        if (unexpected) fail(`unexpected state "${unexpected.state}"`);
        const firstWorking = seq.find((r) => r.state === "working");
        if (!firstWorking) fail("never entered working");
        const prematureWaiting = seq.find(
          (r) => r.state === "waiting" && r.atMs < slot.script.quietStartMs
        );
        if (prematureWaiting) {
          fail(`spurious waiting at ${prematureWaiting.atMs}ms while output was streaming`);
        }
        const waitingFlip = seq.find(
          (r) => r.state === "waiting" && r.atMs >= slot.script.quietStartMs
        );
        if (!waitingFlip) fail("never flipped to waiting after the stream went quiet");
        if (waitingFlip.atMs >= slot.script.resumeStartMs) {
          fail("waiting flip landed after the resume phase started");
        }
        const resumeFlip = seq.find(
          (r) => r.state === "working" && r.atMs >= slot.script.resumeStartMs
        );
        if (!resumeFlip) fail("never recovered to working after output resumed");
        waitLatencies.push(waitingFlip.atMs - slot.script.quietStartMs);
        resumeLatencies.push(resumeFlip.atMs - slot.script.resumeStartMs);
      }

      const cpuMs = (cpuEnd.user + cpuEnd.system) / 1000;
      const wallMs = Number(wallEnd - wallStart) / 1e6;
      const agentSeconds = (agentCount * totalVirtualMs) / 1000;

      return {
        agents: agentCount,
        fedBytes,
        virtualMs: totalVirtualMs,
        wallMs,
        cpuMs,
        cpuMsPerMb: cpuMs / (fedBytes / 1e6),
        cpuMsPerAgentSecond: cpuMs / agentSeconds,
        waitFlipLatencyMs: median(waitLatencies),
        resumeFlipLatencyMs: median(resumeLatencies),
        stateChangeRecords,
        agentsWithWaitFlip: waitLatencies.length,
        agentsWithResumeFlip: resumeLatencies.length,
        scriptedBytes,
      };
    } finally {
      for (const slot of slots) {
        runtime.handleMessage({ type: "free", terminalId: slot.terminalId });
        slot.semanticBuffer.dispose();
      }
      events.off("agent:state-changed", onStateChanged);
    }
  } finally {
    clock.uninstall();
  }
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
