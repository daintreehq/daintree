import { createHash } from "node:crypto";
import path from "node:path";
import { RUN_DUE_SCHEDULES_FLAG } from "../../boot/dueScheduleLaunch.js";
import type { CommandResult, CommandRunner } from "../../remote/host/hostCommands.js";
import { nodeStartAtLoginFs, type StartAtLoginFs } from "../../remote/host/startAtLogin.js";
import {
  launchdCalendarFor,
  launchdIntervalKey,
  type LaunchdCalendarInterval,
} from "../../../shared/utils/launchdCalendar.js";
import type { ScheduleCadence } from "../../../shared/types/scheduledRuns.js";
import type { ScheduleOsJobAdapter, ScheduleOsJobObservation } from "./ScheduleOsJobService.js";

/**
 * The macOS OS job for schedules set to run when Daintree isn't running
 * (#15990): one Daintree-owned LaunchAgent whose calendar holds every such
 * schedule's occurrences, and which runs Daintree with `--run-due-schedules`.
 *
 * The job runs `open -n -g -a <app>`, never the Daintree binary itself, so
 * LaunchServices owns the Daintree it starts. Rewriting the calendar has to
 * unload the job (`launchctl bootout`), which signals the job's own process; a
 * Daintree the job had started as that process would be quit by any edit.
 * `-n` starts a new process even while Daintree runs, since only a new process
 * gets the arguments; it hands the flag to the running one and exits. `-g`
 * keeps it in the background.
 *
 * It only ever writes, loads and unloads its own label and file. It is not
 * Host mode's start-at-login agent, which stays as it is.
 */

const OPEN = "/usr/bin/open";
const LAUNCHCTL = "/bin/launchctl";
const LABEL_PREFIX = "org.daintree.app.schedules";
const BUNDLE_SUFFIX = ".app/Contents/MacOS/";
const UNLOAD_POLLS = 10;
const UNLOAD_POLL_MS = 200;
const BOOTSTRAP_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_MS = 500;

export interface LaunchAgentTarget {
  /** The `.app` bundle `open` launches. */
  bundlePath: string;
  /** Dev builds run Electron.app against an app folder. */
  appPath: string | null;
  /** This profile, so the job starts the Daintree whose schedules it holds. */
  userDataDir: string;
  bundleId: string;
}

export type LaunchAgentTargetResult =
  { ok: true; target: LaunchAgentTarget } | { ok: false; unavailable: string };

/** Where this running Daintree's app bundle is, or why a job can't point at it. */
export function launchAgentTargetFor(input: {
  execPath: string;
  appPath: string | null;
  userDataDir: string;
  bundleId: string;
}): LaunchAgentTargetResult {
  const index = input.execPath.lastIndexOf(BUNDLE_SUFFIX);
  if (index === -1) {
    return { ok: false, unavailable: "Daintree isn't running from an app bundle" };
  }
  const bundlePath = input.execPath.slice(0, index + ".app".length);
  // A quarantined app opened from Downloads runs from a randomized read-only
  // copy that is gone after it quits.
  if (bundlePath.includes("/AppTranslocation/")) {
    return {
      ok: false,
      unavailable:
        "macOS is running Daintree from a temporary copy. Move Daintree to Applications and open it from there",
    };
  }
  return {
    ok: true,
    target: {
      bundlePath,
      appPath: input.appPath,
      userDataDir: input.userDataDir,
      bundleId: input.bundleId,
    },
  };
}

/**
 * One label per profile: two profiles' schedules are two jobs, and two copies
 * of the app sharing a profile share one, which the copy that ran last points
 * at itself.
 */
export function scheduleLaunchAgentLabel(userDataDir: string): string {
  const digest = createHash("sha256").update(userDataDir).digest("hex").slice(0, 12);
  return `${LABEL_PREFIX}.${digest}`;
}

export function scheduleLaunchAgentArguments(target: LaunchAgentTarget): string[] {
  return [
    OPEN,
    "-n",
    "-g",
    "-a",
    target.bundlePath,
    "--args",
    ...(target.appPath ? [target.appPath] : []),
    `--user-data-dir=${target.userDataDir}`,
    RUN_DUE_SCHEDULES_FLAG,
  ];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const INTERVAL_KEYS: readonly (keyof LaunchdCalendarInterval)[] = [
  "Month",
  "Day",
  "Weekday",
  "Hour",
  "Minute",
];

export function buildScheduleLaunchAgentPlist(input: {
  label: string;
  programArguments: readonly string[];
  calendar: readonly LaunchdCalendarInterval[];
  bundleId: string;
}): string {
  const args = input.programArguments.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`);
  const calendar = input.calendar.flatMap((interval) => [
    `\t\t<dict>`,
    ...INTERVAL_KEYS.flatMap((key) =>
      interval[key] === undefined
        ? []
        : [`\t\t\t<key>${key}</key>`, `\t\t\t<integer>${interval[key]}</integer>`]
    ),
    `\t\t</dict>`,
  ]);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t<string>${xmlEscape(input.label)}</string>`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    ...args,
    `\t</array>`,
    `\t<key>StartCalendarInterval</key>`,
    `\t<array>`,
    ...calendar,
    `\t</array>`,
    // Only in the logged-in GUI session: the Daintree it starts needs one for
    // its windows later, and an SSH login must never start it.
    `\t<key>LimitLoadToSessionType</key>`,
    `\t<string>Aqua</string>`,
    `\t<key>AssociatedBundleIdentifiers</key>`,
    `\t<array>`,
    `\t\t<string>${xmlEscape(input.bundleId)}</string>`,
    `\t</array>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** Every eligible schedule's entries, each written once, in a stable order. */
export function scheduleJobCalendar(
  cadences: readonly Pick<ScheduleCadence, "cron" | "timeZone">[],
  systemTimeZone: string
): LaunchdCalendarInterval[] {
  const byKey = new Map<string, LaunchdCalendarInterval>();
  for (const cadence of cadences) {
    const calendar = launchdCalendarFor(cadence, systemTimeZone);
    if (!calendar.ok) continue;
    for (const interval of calendar.intervals) byKey.set(launchdIntervalKey(interval), interval);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, interval]) => interval);
}

function describeLaunchctl(step: string, result: CommandResult): string {
  if (result.failure === "not-found") return `${step}: launchctl isn't available`;
  if (result.failure === "timeout") return `${step}: launchctl didn't answer`;
  const detail = result.stderr.trim().split("\n")[0] ?? "";
  return `${step}${result.code !== null ? ` (launchctl exited ${result.code})` : ""}${detail ? `: ${detail}` : ""}`;
}

export function createLaunchAgentScheduleJob(deps: {
  homeDir: string;
  uid: number;
  target: LaunchAgentTargetResult;
  userDataDir: string;
  run: CommandRunner;
  fs?: StartAtLoginFs;
  delay?: (ms: number) => Promise<void>;
}): ScheduleOsJobAdapter {
  const files = deps.fs ?? nodeStartAtLoginFs;
  const delay = deps.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const label = scheduleLaunchAgentLabel(deps.userDataDir);
  const file = path.posix.join(deps.homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${deps.uid}`;
  const service = `${domain}/${label}`;
  const target = deps.target.ok ? deps.target.target : null;

  const desiredContent = (
    cadences: readonly Pick<ScheduleCadence, "cron" | "timeZone">[],
    systemTimeZone: string
  ): string | null => {
    const calendar = scheduleJobCalendar(cadences, systemTimeZone);
    if (calendar.length === 0 || !target) return null;
    return buildScheduleLaunchAgentPlist({
      label,
      programArguments: scheduleLaunchAgentArguments(target),
      calendar,
      bundleId: target.bundleId,
    });
  };

  /** Null when launchctl couldn't say. */
  const isLoaded = async (): Promise<boolean | null> => {
    const result = await deps.run(LAUNCHCTL, ["print", service]);
    if (result.failure) return null;
    return result.code === 0;
  };

  /** Unloading is asynchronous: launchd can still list the job for a moment. */
  const unload = async (): Promise<void> => {
    const result = await deps.run(LAUNCHCTL, ["bootout", service]);
    for (let poll = 0; poll < UNLOAD_POLLS; poll++) {
      if ((await isLoaded()) === false) return;
      await delay(UNLOAD_POLL_MS);
    }
    throw new Error(describeLaunchctl("Couldn't unload the old macOS job", result));
  };

  const load = async (): Promise<void> => {
    let result: CommandResult | null = null;
    for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
      if (attempt > 0) await delay(BOOTSTRAP_RETRY_MS);
      result = await deps.run(LAUNCHCTL, ["bootstrap", domain, file]);
      if (result.code === 0) break;
    }
    if ((await isLoaded()) === true) return;
    throw new Error(describeLaunchctl("Couldn't load the macOS job", result!));
  };

  return {
    kind: "launch-agent",
    unavailable: deps.target.ok ? null : deps.target.unavailable,

    async sync(cadences, systemTimeZone, options) {
      // A copy that can't point a job at itself leaves the one installed alone.
      if (!deps.target.ok) throw new Error(deps.target.unavailable);
      const desired = desiredContent(cadences, systemTimeZone);
      const [onDisk, loaded] = await Promise.all([files.readFile(file), isLoaded()]);
      if (desired === null) {
        if (onDisk === null && loaded === false) return;
        // The file goes even when unloading fails, so the next login can't load it.
        let failure: unknown = null;
        if (loaded !== false) await unload().catch((error: unknown) => (failure = error));
        await files.remove(file);
        if (failure) throw failure;
        return;
      }
      if (!options.reload && onDisk === desired && loaded === true) return;
      // Unloaded before the file changes: a job left loaded from older content
      // keeps the file older too, so a file that reads current was loaded.
      if (loaded !== false) await unload();
      await files.writeFile(file, desired);
      await load();
    },

    async observe(cadences, systemTimeZone): Promise<ScheduleOsJobObservation> {
      const desired = desiredContent(cadences, systemTimeZone);
      const [onDisk, loaded] = await Promise.all([
        files.readFile(file).catch(() => null),
        isLoaded(),
      ]);
      return {
        installed: onDisk !== null,
        current: onDisk === desired,
        loaded,
      };
    },
  };
}
