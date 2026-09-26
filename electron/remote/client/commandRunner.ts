import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * Runs a local program (ssh, scp, tailscale, dns-sd, ditto) with bounded
 * output and a deadline. Everything that probes, discovers or installs takes
 * one of these so tests can replay recorded output with no network.
 */

export interface CommandResult {
  /** Null when the program was stopped (deadline, `collectForMs`, abort). */
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

export const defaultCommandRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        spawnError: (err as Error).message,
        timedOut: false,
      });
      return;
    }
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (collectTimer) clearTimeout(collectTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const stop = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    };
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) stop();

    const input = options.input;
    if (input && child.stdin) {
      // The program may exit before reading everything (a refused login): not our error.
      child.stdin.on("error", () => {});
      if ("text" in input) {
        child.stdin.end(input.text);
      } else {
        const source = fs.createReadStream(input.file);
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
    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const collectTimer =
      options.collectForMs !== undefined ? setTimeout(stop, options.collectForMs) : null;
    child.on("error", (err) =>
      finish({ code: null, stdout, stderr, spawnError: err.message, timedOut })
    );
    child.on("close", (code) => finish({ code, stdout, stderr, spawnError: null, timedOut }));
  });
