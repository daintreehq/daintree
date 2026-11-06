import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";
import {
  HEADLESS_OZONE_SWITCH,
  HIDDEN_LAUNCH_FLAG,
  isAttachStdioRequested,
  isHostModeHandoffOnly,
  isHostModeRequested,
} from "../../boot/hostModeLaunch.js";
import { isDueScheduleCheckRequested } from "../../boot/dueScheduleLaunch.js";
import { hostLocation } from "./hostLocation.js";
import { HOST_MODE_STATUS_NAME, parseHostModeStatus } from "./hostModeStatusFile.js";
import { systemdUnitName } from "./startAtLogin.js";
import { armRelaunch } from "../../lifecycle/armRelaunch.js";

/**
 * A Linux desktop launch that finds Daintree already running here as a
 * headless Host. Its service starts it at login with no display, so it can
 * never draw a window; this launch can, so it offers to restart Daintree with
 * one. The restart ends everything running in the host, which is why it asks.
 */

/**
 * Carried by the relaunch after a confirmed takeover. A Shell elsewhere may
 * start the host's service again before the relaunch takes the lock; the
 * relaunch then stops it without asking a second time, once.
 */
export const HOST_TAKEOVER_FLAG = "--host-takeover";

export interface HeadlessHost {
  pid: number;
  /** The process's start time, so a reused pid is never mistaken for it. */
  startTime: string;
  /** The systemd user unit it runs under, when it does. */
  unit: string | null;
}

/** A launch that wants a window, on a desktop that can show one. */
export function wantsDesktopWindow(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return !(
    isHostModeRequested(argv) ||
    isAttachStdioRequested(argv) ||
    isHostModeHandoffOnly(argv) ||
    isDueScheduleCheckRequested(argv) ||
    argv.includes(HIDDEN_LAUNCH_FLAG)
  );
}

/** Chromium rewrites its own process title, so arguments may be joined by spaces rather than NULs. */
function commandLineTokens(cmdline: string): string[] {
  return cmdline.split(/[\0\s]+/).filter(Boolean);
}

/** Whether a process's `/proc/<pid>/cmdline` is a headless Host-mode Daintree. */
export function isHeadlessHostCommandLine(cmdline: string): boolean {
  const argv = commandLineTokens(cmdline);
  return argv.includes(HEADLESS_OZONE_SWITCH) && isHostModeRequested(argv);
}

/** The profile a launch names with `--user-data-dir=`, or null for the default one. */
export function userDataDirArg(argv: readonly string[]): string | null {
  const flag = argv.find((arg) => arg.startsWith("--user-data-dir="));
  return flag ? flag.slice("--user-data-dir=".length) : null;
}

/** Field 22 of `/proc/<pid>/stat`, read past the command name, which may hold spaces. */
export function processStartTime(stat: string): string | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19] ?? null;
}

/** The Daintree host unit a process runs under, from its `/proc/<pid>/cgroup`. */
export function hostUnitFromCgroup(cgroup: string, packaged: boolean): string | null {
  const unit = systemdUnitName(packaged);
  return cgroup.split("\n").some((line) => path.posix.basename(line.trim()) === unit) ? unit : null;
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function startTimeOf(pid: number): string | null {
  const stat = readOrNull(`/proc/${pid}/stat`);
  return stat ? processStartTime(stat) : null;
}

/**
 * The headless Host of this build and profile, if one runs here. Its pid comes
 * from the status file it writes, and only counts while that process is a
 * headless Host-mode launch on the same profile as this one.
 */
export function findHeadlessHost(argv: readonly string[] = process.argv): HeadlessHost | null {
  const status = readOrNull(path.join(hostLocation().dir, HOST_MODE_STATUS_NAME));
  const pid = status ? parseHostModeStatus(status)?.pid : undefined;
  if (!pid || pid === process.pid) return null;
  const cmdline = readOrNull(`/proc/${pid}/cmdline`);
  if (!cmdline || !isHeadlessHostCommandLine(cmdline)) return null;
  if (userDataDirArg(commandLineTokens(cmdline)) !== userDataDirArg(argv)) return null;
  const startTime = startTimeOf(pid);
  if (!startTime) return null;
  const cgroup = readOrNull(`/proc/${pid}/cgroup`) ?? "";
  return { pid, startTime, unit: hostUnitFromCgroup(cgroup, app.isPackaged) };
}

function stillRunning(host: HeadlessHost): boolean {
  return startTimeOf(host.pid) === host.startTime;
}

function stopHost(host: HeadlessHost): Promise<void> {
  if (!host.unit) {
    try {
      process.kill(host.pid, "SIGTERM");
    } catch (error) {
      // Gone already: nothing to stop.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return Promise.resolve();
  }
  // Through systemd, so it records a stop rather than a failure to restart from.
  return new Promise((resolve, reject) => {
    execFile(
      "systemctl",
      ["--user", "stop", host.unit!],
      { timeout: 60_000 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve();
      }
    );
  });
}

async function waitForExit(host: HeadlessHost, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (stillRunning(host)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
}

function relaunch(argv: readonly string[], takeover: boolean): void {
  const args = argv.slice(1).filter((arg) => arg !== HOST_TAKEOVER_FLAG);
  armRelaunch({ args: takeover ? [...args, HOST_TAKEOVER_FLAG] : args });
  app.exit(0);
}

/** Ends every terminal in the host, so Enter keeps it running, as the quit and update prompts do. */
export const TAKEOVER_PROMPT: Electron.MessageBoxOptions = {
  type: "question",
  title: "Daintree",
  message: "Restart Daintree with a window?",
  detail:
    "Daintree is already running on this machine in Host mode, with no window, for other machines to use. Restarting it closes the terminals and agents running in it, including any that another machine is using.",
  buttons: ["Restart with a window", "Cancel"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
};

/**
 * Ask (unless this launch is the relaunch of a takeover already agreed to),
 * then either restart Daintree with a window (stop the host, relaunch this
 * launch) or leave it as it is. Exits this process either way.
 */
export async function offerHeadlessHostTakeover(
  host: HeadlessHost,
  argv: readonly string[] = process.argv
): Promise<void> {
  await app.whenReady();
  const agreed = argv.includes(HOST_TAKEOVER_FLAG);
  if (!agreed) {
    const { response } = await dialog.showMessageBox(TAKEOVER_PROMPT);
    if (response !== 0) {
      app.exit(0);
      return;
    }
  }
  // Looked up again: while the dialog was up the host may have gone, or its
  // service may have started a new one in its place.
  const current = findHeadlessHost(argv) ?? (stillRunning(host) ? host : null);
  try {
    if (current) {
      await stopHost(current);
      if (!(await waitForExit(current, 30_000))) {
        throw new Error("It was still running 30 seconds after being asked to stop.");
      }
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Daintree",
      message: "Couldn't restart Daintree",
      detail: `The Daintree running in Host mode didn't stop: ${(error as Error).message}`,
      buttons: ["Close"],
    });
    app.exit(1);
    return;
  }
  // The takeover marker goes on the first relaunch only.
  relaunch(argv, !agreed);
}
