import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";

export interface SoundHandle {
  cancel(): void;
}

function spawnSilent(cmd: string, args: string[]): ChildProcess {
  return spawn(cmd, args, { stdio: "ignore", detached: false });
}

export function playSound(filePath: string): SoundHandle {
  if (!existsSync(filePath)) {
    return { cancel: () => {} };
  }

  let proc: ChildProcess | null = null;

  try {
    if (process.platform === "darwin") {
      proc = spawnSilent("afplay", [filePath]);
    } else if (process.platform === "win32") {
      // Use PowerShell SoundPlayer (WAV only — bundle WAV files)
      const escapedPath = filePath.replace(/'/g, "''");
      proc = spawnSilent("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(New-Object System.Media.SoundPlayer '${escapedPath}').PlaySync()`,
      ]);
    } else {
      // Linux: try paplay first, fall back to aplay
      proc = spawnSilent("paplay", [filePath]);
      proc.on("error", () => {
        if (existsSync(filePath)) {
          proc = spawnSilent("aplay", [filePath]);
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
