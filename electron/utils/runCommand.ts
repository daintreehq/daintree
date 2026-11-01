import { execFile } from "node:child_process";

/**
 * Runs a system tool and answers with its exit, never throwing: a missing
 * tool, a timeout and a failed run each come back as a result. Behind a seam
 * so tests never run the tool.
 */

export interface CommandResult {
  /** Exit code; null when the command never ran or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why there is no clean exit code: the tool is absent, or it overran its timeout. */
  failure?: "not-found" | "timeout" | "error";
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export const runCommand: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err });
          return;
        }
        const e = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        if (e.code === "ENOENT") {
          resolve({ code: null, stdout: out, stderr: err, failure: "not-found" });
        } else if (e.killed) {
          resolve({ code: null, stdout: out, stderr: err, failure: "timeout" });
        } else if (typeof e.code === "number") {
          resolve({ code: e.code, stdout: out, stderr: err });
        } else {
          resolve({ code: null, stdout: out, stderr: err, failure: "error" });
        }
      }
    );
  });
