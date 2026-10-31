import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * Runs a local program (ssh, scp, tailscale, netbird, dns-sd, ditto) with bounded
 * output and a deadline. Everything that probes, discovers or installs takes
 * one of these so tests can replay recorded output with no network. Once a run
 * is stopped, its result arrives within `COMMAND_STOP_GRACE_MS`, even when the
 * program ignores SIGTERM or something else still holds its output.
 */

export interface CommandResult {
  /** Null when the run was stopped (deadline, `collectForMs`, abort, unreadable input file). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program could not be started at all (not installed, not executable). */
  spawnError: string | null;
  timedOut: boolean;
}

export interface CommandOptions {
  timeoutMs?: number;
  /**
   * For programs that never exit on their own (`dns-sd -B`): stop them after
   * this long and return what they printed. The run is not a failure.
   */
  collectForMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Fed to the program's stdin, which is otherwise closed. */
  input?: CommandInput;
  /** Variables set for the program on top of this process's environment. */
  env?: Readonly<Record<string, string>>;
}

export type CommandInput = { text: string } | { file: string };

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions
) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;
const MAX_STDERR = 8 * 1024;
/** How long a stopped program gets to exit on SIGTERM before it is killed outright. */
export const COMMAND_STOP_GRACE_MS = 2_000;
/**
 * How long output is still read once a stopped program has exited. Another
 * process can hold its pipes open for as long as it likes (an ssh
 * ControlMaster keeps a mux client's stdio until the remote command ends), so
 * their closing isn't waited for beyond this.
 */
export const COMMAND_DRAIN_GRACE_MS = 1_000;

export const defaultCommandRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const notRun = (spawnError: string | null): CommandResult => ({
      code: null,
      stdout: "",
      stderr: "",
      spawnError,
      timedOut: false,
    });
    if (options.signal?.aborted) {
      resolve(notRun(null));
      return;
    }
    const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stopped = false;
    let exited = false;
    let exitCode: number | null = null;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(options.env && { env: { ...process.env, ...options.env } }),
      });
    } catch (err) {
      resolve(notRun((err as Error).message));
      return;
    }
    let source: fs.ReadStream | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let collectTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => stop();
    const releaseInput = () => {
      source?.destroy();
      child.stdin?.destroy();
    };
    const finish = (spawnError: string | null = null) => {
      if (settled) return;
      settled = true;
      for (const timer of [deadline, collectTimer, killTimer, drainTimer]) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      releaseInput();
      // Close this side's ends so nothing still holding the others keeps them open.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code: stopped ? null : exitCode, stdout, stderr, spawnError, timedOut });
    };
    const signalChild = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    const drain = () => {
      drainTimer ??= setTimeout(() => finish(), COMMAND_DRAIN_GRACE_MS);
    };
    const stop = () => {
      if (settled || stopped) return;
      stopped = true;
      clearTimeout(deadline);
      clearTimeout(collectTimer);
      releaseInput();
      // Armed before signalling: the run settles by now whatever the program does.
      killTimer = setTimeout(() => {
        if (!exited) signalChild("SIGKILL");
        finish();
      }, COMMAND_STOP_GRACE_MS);
      if (exited) drain();
      else signalChild("SIGTERM");
    };

    const input = options.input;
    if (input && child.stdin) {
      // The program may exit before reading everything (a refused login): not our error.
      child.stdin.on("error", () => {});
      if ("text" in input) {
        child.stdin.end(input.text);
      } else {
        source = fs.createReadStream(input.file);
        source.on("error", (err) => {
          stderr = (stderr + `Couldn't read ${input.file}: ${err.message}`).slice(-MAX_STDERR);
          stop();
        });
        source.pipe(child.stdin);
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout += chunk.toString("utf8").slice(0, maxOutput);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR);
    });
    child.on("error", (err) => {
      // Only a program that never started has no pid. A failed kill lands here
      // too, and the stop timer settles that run.
      if (child.pid === undefined) finish(err.message);
    });
    child.on("exit", (code) => {
      if (settled) return;
      exited = true;
      exitCode = code;
      releaseInput();
      // Left to itself, a program's output is read until its pipes close (or the
      // deadline): something it started may still be writing.
      if (stopped) drain();
    });
    child.on("close", (code) => {
      exitCode = code;
      finish();
    });

    deadline = setTimeout(() => {
      if (stopped) return;
      timedOut = true;
      stop();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (options.collectForMs !== undefined) collectTimer = setTimeout(stop, options.collectForMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
