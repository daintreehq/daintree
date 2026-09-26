import { execFile, spawn } from "node:child_process";

/**
 * The system tools Host mode reads and drives (pmset, loginctl, systemctl,
 * dns-sd, avahi-publish-service), behind seams so tests never run them.
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

/** A long-running child Host mode owns for as long as it advertises. */
export interface OwnedProcess {
  kill(): void;
  onExit(listener: (info: { code: number | null; notFound: boolean }) => void): void;
}

export type ProcessSpawner = (file: string, args: readonly string[]) => OwnedProcess;

export const spawnOwnedProcess: ProcessSpawner = (file, args) => {
  const child = spawn(file, [...args], { stdio: "ignore", windowsHide: true });
  let exited = false;
  const listeners = new Set<(info: { code: number | null; notFound: boolean }) => void>();
  const finish = (info: { code: number | null; notFound: boolean }): void => {
    if (exited) return;
    exited = true;
    for (const listener of listeners) listener(info);
  };
  child.once("error", (error: NodeJS.ErrnoException) => {
    finish({ code: null, notFound: error.code === "ENOENT" });
  });
  child.once("exit", (code) => finish({ code, notFound: false }));
  return {
    kill() {
      if (exited) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    },
    onExit(listener) {
      listeners.add(listener);
    },
  };
};
