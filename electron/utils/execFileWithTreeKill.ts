import { execFile } from "child_process";
import { promisify } from "node:util";
import { describeWindowsTreeKillProblem, killWindowsProcessTreeSync } from "./windowsTreeKill.js";

const execFileAsync = promisify(execFile);

/** execFile's timeout and maxBuffer cleanup must reap children before their root exits. */
export const execFileWithTreeKill: typeof execFileAsync = ((
  ...args: Parameters<typeof execFileAsync>
) => {
  const pending = execFileAsync(...args);
  const child = pending.child;
  if (process.platform === "win32" && child?.kill) {
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      if (child.pid !== undefined) {
        try {
          const problem = describeWindowsTreeKillProblem(
            killWindowsProcessTreeSync(child.pid, { timeoutMs: 3000 })
          );
          if (problem) console.warn("[CLI probe] Process tree cleanup failed", problem);
        } catch (error) {
          console.warn("[CLI probe] Process tree cleanup failed", error);
        }
      }
      return kill(signal);
    };
  }
  return pending;
}) as typeof execFileAsync;
