import { execFileSync } from "node:child_process";
import os from "node:os";

type Run = (command: string, args: string[]) => string;

const runSync: Run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 1_000, windowsHide: true });

/**
 * How a host names this machine to people (who drives a project, which
 * machines are attached): a Mac's own computer name, as its Sharing settings
 * show it, else the hostname without the mDNS ".local" it carries on a Mac.
 */
export function machineDisplayName(
  platform: NodeJS.Platform = process.platform,
  hostname: string = os.hostname(),
  run: Run = runSync
): string {
  if (platform === "darwin") {
    try {
      const name = run("scutil", ["--get", "ComputerName"]).trim();
      if (name) return name.slice(0, 256);
    } catch {
      // No computer name set, or scutil unavailable: the hostname below.
    }
  }
  return hostname.replace(/\.local\.?$/i, "").slice(0, 256) || hostname;
}
