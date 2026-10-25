import {
  DEFAULT_THROWAWAY_TIME_LIMIT_MS,
  MAX_THROWAWAY_TIME_LIMIT_MS,
  type HostThrowawayCall,
  type HostThrowawayFailure,
  type HostThrowawayRun,
  type HostThrowawayToolResult,
} from "../../../shared/types/hostThrowaway.js";
import { HOST_THROWAWAY_TERMINAL_PREFIX } from "../../../shared/config/hostThrowaway.js";
import { SEND_KEYS_GAP_MS, keySequence } from "../../../shared/utils/terminalKeys.js";
import type {
  HostThrowawayExecution,
  HostThrowawayExecutor,
  HostThrowawayOwner,
  HostThrowawayOwnerGone,
} from "../../remote/assistant/throwawayRelay.js";

export type { HostThrowawayOwner };

/** One run as the host holds it, for the `host.call` side and expiry to read. */
export interface HostThrowawayRunEntry {
  runId: string;
  owner: HostThrowawayOwner;
  agentId: string;
  terminalId: string;
  startedAt: number;
  timeLimitMs: number;
  state: "running" | "exited";
  endedAt: number | null;
}

export interface HostThrowawayScreen {
  content: string;
  lineCount: number;
  truncated: boolean;
}

export interface HostThrowawayRunsDeps {
  now(): number;
  newId(): string;
  sleep(ms: number): Promise<void>;
  /** Calls `fire` once `ms` have passed on the clock `now` reads; the returned function cancels it. */
  schedule(ms: number, fire: () => void): () => void;
  /** Records a run the host closed on its own, so a check that vanished can be explained. */
  logClosed(entry: HostThrowawayClosedEntry): void;
  /** Whether the host can launch this agent now. */
  isLaunchable(agentId: string): Promise<boolean>;
  /** Starts the agent in the host's throwaway folder under this terminal id; false when it didn't start. */
  spawn(spec: { terminalId: string; agentId: string }): Promise<boolean>;
  readScreen(terminalId: string, maxLines: number): Promise<HostThrowawayScreen | null>;
  submit(terminalId: string, command: string): Promise<void>;
  write(terminalId: string, data: string): Promise<void>;
  /** Ends the process outright: no trash, no graceful capture, nothing journaled. */
  kill(terminalId: string): void;
}

/**
 * Why the host closed a run nobody asked it to close: its time limit passed,
 * its owner can make no more calls, its terminal died with the pty-host and
 * isn't brought back, or the host stopped serving throwaway runs.
 */
export type HostThrowawayCloseReason =
  "expiry" | HostThrowawayOwnerGone | "terminal-lost" | "host-stopped";

export interface HostThrowawayClosedEntry {
  runId: string;
  agentId: string;
  owner: HostThrowawayOwner;
  reason: HostThrowawayCloseReason;
  ageMs: number;
  state: "running" | "exited";
}

export type HostThrowawayOutcome =
  { ok: true; result: HostThrowawayToolResult } | { ok: false; reason: HostThrowawayFailure };

/** Runs one host holds at once, across every owner. */
export const MAX_HOST_THROWAWAY_RUNS = 8;
/** How long an exited run stays readable before it goes as if closed. */
export const HOST_THROWAWAY_EXITED_RETENTION_MS = 10 * 60_000;
/** How long close waits for the process to end before it reports a failure. */
export const HOST_THROWAWAY_CLOSE_WAIT_MS = 5_000;
const DEFAULT_OUTPUT_LINES = 100;

interface Held extends HostThrowawayRunEntry {
  endReason: "exit" | "close" | null;
  cancelExpiry: () => void;
  /** A close has ended this run's process, so its exit is the close's. */
  closing: boolean;
  exited: Promise<void>;
  markExited: () => void;
}

const sameOwner = (a: HostThrowawayOwner, b: HostThrowawayOwner): boolean =>
  a.senderId === b.senderId && a.helpSessionId === b.helpSessionId;

/**
 * The throwaway agents this host runs for Shell assistants (#14445), with no
 * view and no project. Only the inventory is held here: a run's terminal is
 * the pty-host's, and once a run is closed nothing of it is kept anywhere.
 * Every run is its owner's alone: any other caller reads it as not found.
 */
export class HostThrowawayRuns implements HostThrowawayExecutor {
  private readonly runs = new Map<string, Held>();
  private readonly byTerminal = new Map<string, string>();
  /** Moves on each endAll, so a launch that straddles one never survives it. */
  private epoch = 0;
  /** Launches still checking their agent, so an owner that goes meanwhile cancels them. */
  private readonly checking = new Set<{ owner: HostThrowawayOwner; cancelled: boolean }>();

  constructor(private readonly deps: HostThrowawayRunsDeps) {}

  /** Every run the host holds, live or exited and not yet gone. */
  list(): HostThrowawayRunEntry[] {
    this.prune();
    return [...this.runs.values()].map((run) => ({
      runId: run.runId,
      owner: { ...run.owner },
      agentId: run.agentId,
      terminalId: run.terminalId,
      startedAt: run.startedAt,
      timeLimitMs: run.timeLimitMs,
      state: run.state,
      endedAt: run.endedAt,
    }));
  }

  /** Whether a terminal is one of these runs; a sweep of terminals leaves it alone. */
  ownsTerminal(terminalId: string): boolean {
    return this.byTerminal.has(terminalId);
  }

  /** One tool for the relay (#14446), which has checked consent and made it at most once. */
  async run(
    owner: HostThrowawayOwner,
    call: HostThrowawayCall,
    options: { callId: string; timeoutMs: number }
  ): Promise<HostThrowawayExecution> {
    const outcome = await this.call(
      owner,
      call,
      Math.min(HOST_THROWAWAY_CLOSE_WAIT_MS, options.timeoutMs)
    );
    return outcome.ok
      ? { status: "done", result: outcome.result }
      : { status: "failed", reason: outcome.reason };
  }

  async call(
    owner: HostThrowawayOwner,
    call: HostThrowawayCall,
    closeWaitMs = HOST_THROWAWAY_CLOSE_WAIT_MS
  ): Promise<HostThrowawayOutcome> {
    this.prune();
    if (call.tool === "throwaway.launch") {
      return this.launch(owner, call.args.agentId, call.args.timeLimitMs);
    }
    const run = this.runs.get(call.args.runId);
    if (!run || !sameOwner(run.owner, owner)) return { ok: false, reason: "not-found" };
    switch (call.tool) {
      case "throwaway.status":
        return { ok: true, result: { tool: call.tool, run: this.project(run) } };
      case "throwaway.output": {
        const maxLines = call.args.maxLines ?? DEFAULT_OUTPUT_LINES;
        const screen = await this.deps.readScreen(run.terminalId, maxLines).catch(() => null);
        // Closed while the screen was read: its output is gone with it.
        if (!this.holds(run)) return { ok: false, reason: "not-found" };
        return {
          ok: true,
          result: {
            tool: call.tool,
            run: this.project(run),
            ...(screen ?? { content: "", lineCount: 0, truncated: false }),
          },
        };
      }
      case "throwaway.sendCommand": {
        if (run.state !== "running") return { ok: false, reason: "exited" };
        try {
          await this.deps.submit(run.terminalId, call.args.command);
        } catch {
          return { ok: false, reason: "input-failed" };
        }
        return { ok: true, result: { tool: call.tool, run: this.project(run), accepted: true } };
      }
      case "throwaway.sendKeys": {
        if (run.state !== "running") return { ok: false, reason: "exited" };
        try {
          for (const [index, key] of call.args.keys.entries()) {
            if (index > 0) await this.deps.sleep(SEND_KEYS_GAP_MS);
            if (!this.holds(run)) return { ok: false, reason: "not-found" };
            if (run.state !== "running") return { ok: false, reason: "exited" };
            await this.deps.write(run.terminalId, keySequence(key));
          }
        } catch {
          return { ok: false, reason: "input-failed" };
        }
        return { ok: true, result: { tool: call.tool, run: this.project(run), accepted: true } };
      }
      case "throwaway.close":
        return this.close(run, closeWaitMs);
    }
  }

  /** The pty-host reported a terminal's process ended. */
  handleExit(terminalId: string): void {
    const runId = this.byTerminal.get(terminalId);
    const run = runId === undefined ? undefined : this.runs.get(runId);
    if (!run || run.state !== "running") return;
    run.state = "exited";
    run.endedAt = this.deps.now();
    run.endReason = run.closing ? "close" : "exit";
    run.markExited();
  }

  /** The pty-host lost a terminal and won't start it again; the run goes with it. */
  handleLost(terminalId: string): void {
    const runId = this.byTerminal.get(terminalId);
    const run = runId === undefined ? undefined : this.runs.get(runId);
    if (run) this.closeUnasked(run, "terminal-lost");
  }

  /** The pty-host is gone for good: none of the runs' terminals will come back. */
  handleHostLost(): void {
    for (const run of [...this.runs.values()]) this.closeUnasked(run, "terminal-lost");
  }

  /**
   * Closes the runs of an owner that will make no more calls: one help
   * session, or with no help session named, every run of the sender.
   */
  endOwner(
    owner: { senderId: string; helpSessionId?: string },
    reason: HostThrowawayOwnerGone
  ): void {
    const matches = (candidate: HostThrowawayOwner): boolean =>
      candidate.senderId === owner.senderId &&
      (owner.helpSessionId === undefined || candidate.helpSessionId === owner.helpSessionId);
    for (const launch of this.checking) {
      if (matches(launch.owner)) launch.cancelled = true;
    }
    for (const run of [...this.runs.values()]) {
      if (matches(run.owner)) this.closeUnasked(run, reason);
    }
  }

  /** Ends every run: the host stopped serving them, so no owner could reach them again. */
  endAll(): void {
    this.epoch++;
    for (const run of [...this.runs.values()]) this.closeUnasked(run, "host-stopped");
  }

  private async launch(
    owner: HostThrowawayOwner,
    agentId: string,
    requestedLimitMs: number | undefined
  ): Promise<HostThrowawayOutcome> {
    const epoch = this.epoch;
    if (this.runs.size >= MAX_HOST_THROWAWAY_RUNS) return { ok: false, reason: "launch-failed" };
    const check = { owner, cancelled: false };
    this.checking.add(check);
    const launchable = await this.deps.isLaunchable(agentId).catch(() => false);
    this.checking.delete(check);
    if (!launchable) return { ok: false, reason: "launch-failed" };
    // Checked again: launches that passed the first check together can't overshoot.
    if (check.cancelled || epoch !== this.epoch || this.runs.size >= MAX_HOST_THROWAWAY_RUNS) {
      return { ok: false, reason: "launch-failed" };
    }
    let markExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    // A fresh terminal id per run: an id is never reused, so a late exit of
    // one run can't end another.
    // A caller may shorten its run's limit, never stretch it past the ceiling.
    const timeLimitMs = Math.min(
      requestedLimitMs ?? DEFAULT_THROWAWAY_TIME_LIMIT_MS,
      MAX_THROWAWAY_TIME_LIMIT_MS
    );
    const run: Held = {
      runId: this.deps.newId(),
      owner: { ...owner },
      agentId,
      terminalId: `${HOST_THROWAWAY_TERMINAL_PREFIX}${this.deps.newId()}`,
      startedAt: this.deps.now(),
      timeLimitMs,
      state: "running",
      endedAt: null,
      endReason: null,
      cancelExpiry: () => {},
      closing: false,
      exited,
      markExited,
    };
    // Held before the spawn, so an exit that beats the spawn's answer lands on it,
    // and timed from now, so a spawn that hangs is ended on time too.
    this.runs.set(run.runId, run);
    this.byTerminal.set(run.terminalId, run.runId);
    run.cancelExpiry = this.deps.schedule(timeLimitMs, () => this.closeUnasked(run, "expiry"));
    const started = await this.deps
      .spawn({ terminalId: run.terminalId, agentId })
      .catch(() => false);
    if (!started || epoch !== this.epoch || !this.holds(run)) {
      // A spawn that answered late may still have left a process behind.
      this.end(run);
      return { ok: false, reason: "launch-failed" };
    }
    return { ok: true, result: { tool: "throwaway.launch", run: this.project(run) } };
  }

  private async close(run: Held, waitMs: number): Promise<HostThrowawayOutcome> {
    if (run.state === "running") {
      run.closing = true;
      this.deps.kill(run.terminalId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = await Promise.race([
        run.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), waitMs);
        }),
      ]);
      clearTimeout(timer);
      // Closed by the host meanwhile, its time limit or owner's end: gone either way.
      if (!this.holds(run)) return { ok: false, reason: "not-found" };
      if (!ended) {
        run.closing = false;
        return { ok: false, reason: "close-failed" };
      }
    }
    const ended = this.project(run);
    // Gone from the pty-host too: an exited agent's terminal is otherwise kept for its screen.
    this.end(run);
    return {
      ok: true,
      result: { tool: "throwaway.close", run: { ...ended, state: "closed" }, closed: true },
    };
  }

  /** Closes a run nobody asked to close, whatever state its agent is in, and says why. */
  private closeUnasked(run: Held, reason: HostThrowawayCloseReason): void {
    if (!this.holds(run)) return;
    this.deps.logClosed({
      runId: run.runId,
      agentId: run.agentId,
      owner: { ...run.owner },
      reason,
      ageMs: Math.max(0, this.deps.now() - run.startedAt),
      state: run.state,
    });
    this.end(run);
  }

  private holds(run: Held): boolean {
    return this.runs.get(run.runId) === run;
  }

  /** Drops a run and whatever of its terminal the pty-host still holds, exited or not. */
  private end(run: Held): void {
    this.forget(run);
    this.deps.kill(run.terminalId);
  }

  private forget(run: Held): void {
    run.cancelExpiry();
    // A close waiting on this run's exit wakes to find it gone.
    run.markExited();
    if (this.runs.get(run.runId) === run) this.runs.delete(run.runId);
    if (this.byTerminal.get(run.terminalId) === run.runId) this.byTerminal.delete(run.terminalId);
  }

  /**
   * Exited runs nobody closed go once their retention has passed, and any run
   * past its limit whose timer hasn't fired yet, as after the machine slept.
   */
  private prune(): void {
    const now = this.deps.now();
    const cutoff = now - HOST_THROWAWAY_EXITED_RETENTION_MS;
    for (const run of [...this.runs.values()]) {
      if (now >= run.startedAt + run.timeLimitMs) this.closeUnasked(run, "expiry");
      else if (run.endedAt !== null && run.endedAt <= cutoff) this.end(run);
    }
  }

  private project(run: Held): HostThrowawayRun {
    const now = this.deps.now();
    return {
      runId: run.runId,
      agentId: run.agentId,
      startedAt: run.startedAt,
      ageMs: Math.max(0, (run.endedAt ?? now) - run.startedAt),
      timeLimitMs: run.timeLimitMs,
      expiresAt: run.startedAt + run.timeLimitMs,
      state: run.state,
      endedAt: run.endedAt,
      endReason: run.endReason,
    };
  }
}
