import type {
  HostThrowawayCall,
  HostThrowawayFailure,
  HostThrowawayRun,
  HostThrowawayToolResult,
} from "../../../shared/types/hostThrowaway.js";
import { HOST_THROWAWAY_TERMINAL_PREFIX } from "../../../shared/config/hostThrowaway.js";
import { SEND_KEYS_GAP_MS, keySequence } from "../../../shared/utils/terminalKeys.js";

/** Who launched a run: the Shell sender the host authenticated and its help session. */
export interface HostThrowawayOwner {
  senderId: string;
  helpSessionId: string;
}

/** One run as the host holds it, for the `host.call` side and expiry to read. */
export interface HostThrowawayRunEntry {
  runId: string;
  owner: HostThrowawayOwner;
  agentId: string;
  terminalId: string;
  startedAt: number;
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
export class HostThrowawayRuns {
  private readonly runs = new Map<string, Held>();
  private readonly byTerminal = new Map<string, string>();
  /** Moves on each endAll, so a launch that straddles one never survives it. */
  private epoch = 0;

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
      state: run.state,
      endedAt: run.endedAt,
    }));
  }

  /** Whether a terminal is one of these runs; a sweep of terminals leaves it alone. */
  ownsTerminal(terminalId: string): boolean {
    return this.byTerminal.has(terminalId);
  }

  async call(owner: HostThrowawayOwner, call: HostThrowawayCall): Promise<HostThrowawayOutcome> {
    this.prune();
    if (call.tool === "throwaway.launch") return this.launch(owner, call.args.agentId);
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
        return this.close(run);
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

  /** Ends every run: the host stopped serving them, so no owner could reach them again. */
  endAll(): void {
    this.epoch++;
    for (const run of [...this.runs.values()]) this.end(run);
  }

  private async launch(owner: HostThrowawayOwner, agentId: string): Promise<HostThrowawayOutcome> {
    const epoch = this.epoch;
    if (this.runs.size >= MAX_HOST_THROWAWAY_RUNS) return { ok: false, reason: "launch-failed" };
    if (!(await this.deps.isLaunchable(agentId).catch(() => false))) {
      return { ok: false, reason: "launch-failed" };
    }
    // Checked again: launches that passed the first check together can't overshoot.
    if (epoch !== this.epoch || this.runs.size >= MAX_HOST_THROWAWAY_RUNS) {
      return { ok: false, reason: "launch-failed" };
    }
    let markExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    // A fresh terminal id per run: an id is never reused, so a late exit of
    // one run can't end another.
    const run: Held = {
      runId: this.deps.newId(),
      owner: { ...owner },
      agentId,
      terminalId: `${HOST_THROWAWAY_TERMINAL_PREFIX}${this.deps.newId()}`,
      startedAt: this.deps.now(),
      state: "running",
      endedAt: null,
      endReason: null,
      closing: false,
      exited,
      markExited,
    };
    // Held before the spawn, so an exit that beats the spawn's answer lands on it.
    this.runs.set(run.runId, run);
    this.byTerminal.set(run.terminalId, run.runId);
    const started = await this.deps
      .spawn({ terminalId: run.terminalId, agentId })
      .catch(() => false);
    if (!started || epoch !== this.epoch) {
      // A spawn that answered late may still have left a process behind.
      this.end(run);
      return { ok: false, reason: "launch-failed" };
    }
    return { ok: true, result: { tool: "throwaway.launch", run: this.project(run) } };
  }

  private async close(run: Held): Promise<HostThrowawayOutcome> {
    if (run.state === "running") {
      run.closing = true;
      this.deps.kill(run.terminalId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = await Promise.race([
        run.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), HOST_THROWAWAY_CLOSE_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
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

  private holds(run: Held): boolean {
    return this.runs.get(run.runId) === run;
  }

  /** Drops a run and whatever of its terminal the pty-host still holds, exited or not. */
  private end(run: Held): void {
    this.forget(run);
    this.deps.kill(run.terminalId);
  }

  private forget(run: Held): void {
    if (this.runs.get(run.runId) === run) this.runs.delete(run.runId);
    if (this.byTerminal.get(run.terminalId) === run.runId) this.byTerminal.delete(run.terminalId);
  }

  /** Exited runs nobody closed go once their retention has passed. */
  private prune(): void {
    const cutoff = this.deps.now() - HOST_THROWAWAY_EXITED_RETENTION_MS;
    for (const run of [...this.runs.values()]) {
      if (run.endedAt !== null && run.endedAt <= cutoff) this.end(run);
    }
  }

  private project(run: Held): HostThrowawayRun {
    const now = this.deps.now();
    return {
      runId: run.runId,
      agentId: run.agentId,
      startedAt: run.startedAt,
      ageMs: Math.max(0, (run.endedAt ?? now) - run.startedAt),
      timeLimitMs: null,
      expiresAt: null,
      state: run.state,
      endedAt: run.endedAt,
      endReason: run.endReason,
    };
  }
}
