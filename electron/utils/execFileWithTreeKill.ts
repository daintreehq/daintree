import { execFile } from "child_process";
import { promisify } from "node:util";
import { killWindowsProcessTreeInBackground, liveChildTreeTarget } from "./windowsTreeKill.js";

const execFileAsync = promisify(execFile);

/**
 * execFile's timeout and maxBuffer cleanup must reap children before their root exits.
 *
 * Windows: the verified tree kill runs in the background — this is reached from
 * Main's CLI probes, which must never block on a PowerShell start — and the
 * native kill follows once it settles, as the fallback for a tree kill that
 * could not run. The root stays alive until then, which the walk needs; execFile
 * settles on the root's `close`, so its caller still sees the tree gone first.
 */
export const execFileWithTreeKill: typeof execFileAsync = ((
  ...args: Parameters<typeof execFileAsync>
) => {
  const pending = execFileAsync(...args);
  const child = pending.child;
  if (process.platform === "win32" && child?.kill) {
    const kill = child.kill.bind(child);
    let treeKill: Promise<unknown> | null = null;
    child.kill = (signal) => {
      if (treeKill) return true;
      // Once the root has exited its PID is free for reuse: no tree kill.
      const target = liveChildTreeTarget(child);
      if (!target) return kill(signal);
      const nativeKill = () => {
        try {
          kill(signal);
        } catch (error) {
          console.warn("[CLI probe] Process cleanup failed", error);
        }
      };
      treeKill = killWindowsProcessTreeInBackground(target, "[CLI probe]", {
        timeoutMs: 3000,
      }).then(nativeKill, nativeKill);
      return true;
    };
  }
  return pending;
}) as typeof execFileAsync;
