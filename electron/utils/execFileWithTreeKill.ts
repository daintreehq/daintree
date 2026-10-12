import { execFile, spawnSync } from "child_process";
import { promisify } from "node:util";

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
          const result = spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(child.pid)], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 3000,
          });
          if (result?.error || (result && result.status !== 0 && result.status !== 128)) {
            console.warn("[CLI probe] Process tree cleanup failed", result.error ?? result.status);
          }
        } catch (error) {
          console.warn("[CLI probe] Process tree cleanup failed", error);
        }
      }
      return kill(signal);
    };
  }
  return pending;
}) as typeof execFileAsync;
