import { spawn } from "node:child_process";

/**
 * The system tools Host mode reads and drives (pmset, loginctl, systemctl,
 * dns-sd, avahi-publish-service), behind seams so tests never run them.
 */

export { runCommand, type CommandResult, type CommandRunner } from "../../utils/runCommand.js";

/** A long-running child Host mode owns for as long as it advertises. */
export interface OwnedProcess {
  /** Undefined when the spawn failed before a process existed. */
  readonly pid?: number;
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
    pid: child.pid,
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
