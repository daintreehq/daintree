import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";

export interface SoundHandle {
  cancel(): void;
}

function spawnSilent(cmd: string, args: string[]): ChildProcess {
  return spawn(cmd, args, { stdio: "ignore", detached: false });
}

export function playSound(filePath: string, volume = 1.0): SoundHandle {
  if (!existsSync(filePath)) {
    return { cancel: () => {} };
  }

  let proc: ChildProcess | null = null;

  try {
    if (process.platform === "darwin") {
      const args = volume < 1.0 ? ["--volume", volume.toFixed(2), filePath] : [filePath];
      proc = spawnSilent("afplay", args);
    } else if (process.platform === "win32") {
      // PowerShell SoundPlayer has no volume API — volume param ignored
      const escapedPath = filePath.replace(/'/g, "''");
      proc = spawnSilent("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(New-Object System.Media.SoundPlayer '${escapedPath}').PlaySync()`,
      ]);
    } else {
      // Linux: try paplay first, fall back to aplay
      const paplayArgs =
        volume < 1.0 ? ["--volume", String(Math.round(volume * 65536)), filePath] : [filePath];
      proc = spawnSilent("paplay", paplayArgs);
      proc.on("error", () => {
        // aplay has no volume flag — fall back without volume control
        if (existsSync(filePath)) {
          const fallback = spawnSilent("aplay", [filePath]);
          fallback.on("error", () => {});
        }
      });
    }
  } catch {
    // Fail silently — sound is non-critical
  }

  proc?.on("error", () => {});

  return {
    cancel() {
      if (proc && !proc.killed) {
        try {
          proc.kill();
        } catch {
          // Ignore kill errors
        }
        proc = null;
      }
    },
  };
}
