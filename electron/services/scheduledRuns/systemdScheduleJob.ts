import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RUN_DUE_SCHEDULES_FLAG } from "../../boot/dueScheduleLaunch.js";
import { resilientAtomicWriteFileSync } from "../../utils/fs.js";
import type { CommandResult, CommandRunner } from "../../utils/runCommand.js";
import {
  APPIMAGE_EXTRACT_AND_RUN_ENV,
  APPIMAGE_STOP_SCRIPT,
  systemdQuote,
} from "../../utils/systemdUnit.js";
import { systemdCalendarFor } from "../../../shared/utils/systemdCalendar.js";
import type { ScheduleCadence } from "../../../shared/types/scheduledRuns.js";
import { nodeScheduleJobFs, type ScheduleJobFs } from "./launchAgentScheduleJob.js";
import type { ScheduleOsJobAdapter, ScheduleOsJobObservation } from "./ScheduleOsJobService.js";

/**
 * The Linux OS job for schedules set to run when Daintree isn't running
 * (#15991): three Daintree-owned `systemd --user` units.
 *
 * - The timer, whose `OnCalendar=` lines hold every such schedule's occurrences.
 * - The launcher it starts, which waits for a desktop session and then starts
 *   the app unit and ends.
 * - The app unit, which runs Daintree with `--run-due-schedules`.
 *
 * The timer never starts Daintree itself: a timer counts the unit it starts as
 * running for as long as it is active, and once that unit stops it fires at
 * once for every occurrence that passed meanwhile, so quitting a Daintree the
 * timer had started would start it again. The launcher ends as soon as the
 * app unit is asked to start.
 *
 * Nothing here stops, restarts or reloads the app unit, which may be the
 * running Daintree: a rewrite reloads the unit files and restarts only the
 * timer, and removal stops only the timer and the launcher. It only ever
 * touches its own three units. It is not Host mode's start-at-login unit,
 * which stays as it is.
 */

type Cadence = Pick<ScheduleCadence, "cron" | "timeZone">;

const SYSTEMCTL = "systemctl";
const UNIT_PREFIX = "daintree-schedules";
const ZONEINFO = "/usr/share/zoneinfo";
/** systemctl answers a status read at once; one that doesn't is hung, not slow. */
const SHOW_TIMEOUT_MS = 5_000;
const CHANGE_TIMEOUT_MS = 15_000;
/** Looks at 2 s for the first five minutes of waiting for a desktop session, then at 30 s. */
const QUICK_DISPLAY_LOOKS = 150;

export interface SystemdScheduleTarget {
  /** The binary the app unit runs: the AppImage when running from one, else the executable. */
  executable: string;
  /** Dev builds run the Electron binary against an app folder. */
  appPath: string | null;
  /** This profile, so the app unit starts the Daintree whose schedules it holds. */
  userDataDir: string;
  /** An AppImage on a machine without FUSE, which its runtime unpacks and runs instead. */
  appImageExtractAndRun: boolean;
  /** A dev run Chromium can't sandbox (scripts/dev-electron.mjs) needs the same switch here. */
  noSandbox: boolean;
}

export type SystemdScheduleTargetResult =
  { ok: true; target: SystemdScheduleTarget } | { ok: false; unavailable: string };

/** What this running Daintree's app unit should start, or why there can't be one. */
export function systemdScheduleTargetFor(input: {
  execPath: string;
  appImage: string | null;
  appPath: string | null;
  userDataDir: string;
  appImageExtractAndRun: boolean;
  /** This is a dev run started with `--no-sandbox`. */
  devNoSandbox: boolean;
  systemdRunning: boolean;
}): SystemdScheduleTargetResult {
  if (!input.systemdRunning) {
    return {
      ok: false,
      unavailable: "This computer doesn't run systemd, which starts Daintree for schedules",
    };
  }
  return {
    ok: true,
    target: {
      // An AppImage's execPath is inside its temporary mount; the unit must run the image.
      executable: input.appImage ?? input.execPath,
      appPath: input.appPath,
      userDataDir: input.userDataDir,
      appImageExtractAndRun: input.appImage !== null && input.appImageExtractAndRun,
      noSandbox: input.appPath !== null && input.devNoSandbox,
    },
  };
}

/**
 * One set of units per profile: two profiles' schedules are two timers, and
 * two copies of the app sharing a profile share one, which the copy that ran
 * last points at itself.
 */
export function scheduleSystemdUnitBase(userDataDir: string): string {
  const digest = createHash("sha256").update(userDataDir).digest("hex").slice(0, 12);
  return `${UNIT_PREFIX}-${digest}`;
}

export interface ScheduleSystemdUnits {
  timer: string;
  launcher: string;
  app: string;
}

export function scheduleSystemdUnits(userDataDir: string): ScheduleSystemdUnits {
  const base = scheduleSystemdUnitBase(userDataDir);
  return { timer: `${base}.timer`, launcher: `${base}.service`, app: `${base}-app.service` };
}

export function scheduleSystemdArguments(target: SystemdScheduleTarget): string[] {
  return [
    target.executable,
    ...(target.appPath ? [target.appPath] : []),
    ...(target.noSandbox ? ["--no-sandbox"] : []),
    `--user-data-dir=${target.userDataDir}`,
    RUN_DUE_SCHEDULES_FLAG,
  ];
}

/**
 * Waits until the user manager's environment names a display, which the
 * desktop session puts there once it is up: the catch-up for a run missed
 * while the machine was off fires as the user manager starts at login, before
 * the session has. Each unit's command takes the manager's environment as it
 * is then, so Daintree, started after this, starts in the session and can
 * open a window later. It waits for as long as it takes, so a first login over
 * SSH, or a boot with lingering on, still catches up at the desktop login.
 */
export const DISPLAY_WAIT_SCRIPT = `i=0; until systemctl --user show-environment 2>/dev/null | grep -Eq '^(DISPLAY|WAYLAND_DISPLAY)=.'; do i=$((i + 1)); if [ "$i" -le ${QUICK_DISPLAY_LOOKS} ]; then sleep 2; else sleep 30; fi; done`;

function command(args: readonly string[]): string {
  return args.map(systemdQuote).join(" ");
}

export function buildScheduleLauncherUnit(units: ScheduleSystemdUnits): string {
  return [
    `[Unit]`,
    `Description=Start Daintree for a due schedule once the desktop session is up`,
    ``,
    `[Service]`,
    `Type=oneshot`,
    // Linger starts the user manager before any login, without it.
    `Environment=XDG_RUNTIME_DIR=/run/user/%U`,
    `ExecStartPre=${command(["/bin/sh", "-c", DISPLAY_WAIT_SCRIPT])}`,
    `ExecStart=${command([SYSTEMCTL, "--user", "start", "--no-block", units.app])}`,
    // The wait has no end of its own.
    `TimeoutStartSec=infinity`,
    ``,
  ].join("\n");
}

export function buildScheduleAppUnit(target: SystemdScheduleTarget): string {
  return [
    `[Unit]`,
    `Description=Daintree, started for scheduled runs`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${command(scheduleSystemdArguments(target))}`,
    ...(target.appImageExtractAndRun
      ? [
          `Environment=${APPIMAGE_EXTRACT_AND_RUN_ENV}=1`,
          `ExecStop=${command(["/bin/sh", "-c", APPIMAGE_STOP_SCRIPT])}`,
        ]
      : []),
    // A stop (only ever the session ending) signals Daintree alone and lets it
    // close its own helpers; its own shutdown gives up after 20 s.
    `KillMode=mixed`,
    `TimeoutStopSec=30`,
    ``,
  ].join("\n");
}

export function buildScheduleTimerUnit(input: {
  units: ScheduleSystemdUnits;
  specs: readonly string[];
}): string {
  return [
    `[Unit]`,
    `Description=Start Daintree for scheduled runs`,
    ``,
    `[Timer]`,
    ...input.specs.map((spec) => `OnCalendar=${spec}`),
    // Fires once, at the next start of the user manager, for an occurrence
    // missed while it wasn't running (the machine was off).
    `Persistent=true`,
    // Within a second, not the minute systemd allows by default: a launch more
    // than a minute after its occurrence counts it as missed.
    `AccuracySec=1s`,
    `Unit=${input.units.launcher}`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n");
}

/**
 * Every eligible schedule's lines, each written once, in a stable order. Each
 * names the zone the schedule was checked against, so the user manager reads
 * it in that zone whatever its own, unless the system's time zone database
 * has no such name, when the manager's own zone (the same one) is left to it.
 */
export function scheduleTimerSpecs(
  cadences: readonly Cadence[],
  systemTimeZone: string,
  zoneKnown: (zone: string) => boolean
): string[] {
  const specs = new Set<string>();
  for (const cadence of cadences) {
    const calendar = systemdCalendarFor(cadence, systemTimeZone);
    if (!calendar.ok) continue;
    for (const spec of calendar.specs) specs.add(spec);
  }
  const suffix = zoneKnown(systemTimeZone) ? ` ${systemTimeZone}` : "";
  return [...specs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((spec) => spec + suffix);
}

function zoneinfoHas(zone: string): boolean {
  // An IANA name never climbs out of the database.
  if (zone.split("/").includes("..")) return false;
  try {
    return fs.statSync(path.join(ZONEINFO, zone)).isFile();
  } catch {
    return false;
  }
}

interface UnitState {
  loadState: string;
  activeState: string;
  unitFileState: string;
  needDaemonReload: boolean;
}

/** `systemctl show` blocks by unit id; null when any unit is missing from them. */
export function parseUnitStates(
  stdout: string,
  ids: readonly string[]
): Map<string, UnitState> | null {
  const states = new Map<string, UnitState>();
  for (const block of stdout.split(/\n\s*\n/)) {
    const props = new Map<string, string>();
    for (const line of block.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) props.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    const id = props.get("Id");
    if (!id) continue;
    states.set(id, {
      loadState: props.get("LoadState") ?? "",
      activeState: props.get("ActiveState") ?? "",
      unitFileState: props.get("UnitFileState") ?? "",
      needDaemonReload: props.get("NeedDaemonReload") === "yes",
    });
  }
  return ids.every((id) => states.has(id)) ? states : null;
}

function describeSystemctl(step: string, result: CommandResult): string {
  if (result.failure === "not-found") return `${step}: systemctl isn't available`;
  if (result.failure === "timeout") return `${step}: systemctl didn't answer`;
  const detail = result.stderr.trim().split("\n")[0] ?? "";
  return `${step}${result.code !== null ? ` (systemctl exited ${result.code})` : ""}${detail ? `: ${detail}` : ""}`;
}

export interface SystemdScheduleJob extends ScheduleOsJobAdapter {
  /**
   * Follows the updater renaming the AppImage this process runs from, at once:
   * it renames during the install, moments before the process quits, and the
   * app unit would otherwise start the deleted image until Daintree next ran.
   */
  followAppImageMove(relocation: { previous: string; next: string }): void;
}

type States = Record<keyof ScheduleSystemdUnits, UnitState>;

export function createSystemdScheduleJob(deps: {
  homeDir: string;
  target: SystemdScheduleTargetResult;
  userDataDir: string;
  run: CommandRunner;
  /** `systemctl --user daemon-reload`, run to completion; only followAppImageMove uses it. */
  reloadSync: () => void;
  fs?: ScheduleJobFs;
  zoneKnown?: (zone: string) => boolean;
}): SystemdScheduleJob {
  const files = deps.fs ?? nodeScheduleJobFs;
  const zoneKnown = deps.zoneKnown ?? zoneinfoHas;
  const units = scheduleSystemdUnits(deps.userDataDir);
  const unitDir = path.posix.join(deps.homeDir, ".config", "systemd", "user");
  const fileOf = (unit: string) => path.posix.join(unitDir, unit);
  // What `systemctl --user enable` links for `WantedBy=timers.target`.
  const wantsLink = path.posix.join(unitDir, "timers.target.wants", units.timer);
  const names = [units.timer, units.launcher, units.app];
  let target = deps.target.ok ? deps.target.target : null;

  const systemctl = (args: readonly string[], timeoutMs = CHANGE_TIMEOUT_MS) =>
    deps.run(SYSTEMCTL, ["--user", ...args], { timeoutMs });

  const desiredFiles = (
    cadences: readonly Cadence[],
    systemTimeZone: string
  ): Record<keyof ScheduleSystemdUnits, string> | null => {
    const specs = scheduleTimerSpecs(cadences, systemTimeZone, zoneKnown);
    if (specs.length === 0 || !target) return null;
    return {
      timer: buildScheduleTimerUnit({ units, specs }),
      launcher: buildScheduleLauncherUnit(units),
      app: buildScheduleAppUnit(target),
    };
  };

  /** Null when systemctl couldn't say. */
  const readStates = async (): Promise<States | null> => {
    const props = ["Id", "LoadState", "ActiveState", "UnitFileState", "NeedDaemonReload"];
    const result = await systemctl(
      ["show", ...names, ...props.flatMap((prop) => ["-p", prop])],
      SHOW_TIMEOUT_MS
    );
    if (result.code !== 0) return null;
    const states = parseUnitStates(result.stdout, names);
    if (!states) return null;
    return {
      timer: states.get(units.timer)!,
      launcher: states.get(units.launcher)!,
      app: states.get(units.app)!,
    };
  };

  /**
   * Whether the job is in effect. With a job to have: the timer is waiting,
   * enabled for the next login, and every unit loaded from its file as it is
   * now. With none: the timer still waiting or enabled, or the launcher still
   * waiting to start Daintree. The app unit's own state never counts: it is
   * Daintree, or a Daintree that handed over and exited.
   */
  const inEffect = (states: States | null, wanted: boolean): boolean | null => {
    if (!states) return null;
    const armed = states.timer.activeState === "active";
    const enabled = states.timer.unitFileState === "enabled";
    if (!wanted) return armed || enabled || states.launcher.activeState === "activating";
    return (
      armed &&
      enabled &&
      states.timer.loadState === "loaded" &&
      Object.values(states).every((state) => !state.needDaemonReload)
    );
  };

  const readFiles = async () => {
    // A file that can't be read is neither current nor known to be gone.
    let unreadable = false;
    const read = (unit: string) =>
      files.readFile(fileOf(unit)).catch(() => {
        unreadable = true;
        return null;
      });
    const [timer, launcher, app] = await Promise.all([
      read(units.timer),
      read(units.launcher),
      read(units.app),
    ]);
    const onDisk: Record<keyof ScheduleSystemdUnits, string | null> = { timer, launcher, app };
    return { onDisk, unreadable };
  };

  const remove = async (states: States | null) => {
    const failures: string[] = [];
    if (inEffect(states, false) !== false) {
      const disabled = await systemctl(["disable", "--now", units.timer]);
      if (disabled.code !== 0) {
        failures.push(describeSystemctl("Couldn't stop the systemd timer", disabled));
      }
      // A launcher still waiting for a desktop session would start Daintree
      // later. It never is Daintree, so stopping it is safe.
      const stopped = await systemctl(["stop", units.launcher]);
      if (stopped.code !== 0) {
        failures.push(describeSystemctl("Couldn't stop the waiting launcher", stopped));
      }
    }
    // Its record of the last firing: a timer installed again later would
    // otherwise fire at once for what passed since. Older systemd can't.
    await systemctl(["clean", "--what=state", units.timer]);
    // The link goes too, so a disable that failed can't leave the next login a timer to start.
    for (const file of [wantsLink, ...names.map(fileOf)]) {
      await files.remove(file).catch((error: unknown) => {
        failures.push(
          `Couldn't remove ${file}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
    const reloaded = await systemctl(["daemon-reload"]);
    if (reloaded.code !== 0) {
      failures.push(describeSystemctl("Couldn't reload systemd's user units", reloaded));
    }
    if (failures.length > 0) throw new Error(failures[0]);
  };

  return {
    kind: "systemd-timer",
    unavailable: deps.target.ok ? null : deps.target.unavailable,

    async sync(cadences, systemTimeZone, options) {
      // A copy that can't point a job at itself leaves the one installed alone.
      if (!deps.target.ok) throw new Error(deps.target.unavailable);
      const writing = target;
      const desired = desiredFiles(cadences, systemTimeZone);
      const [{ onDisk, unreadable }, states] = await Promise.all([readFiles(), readStates()]);
      if (desired === null) {
        const anyFile = Object.values(onDisk).some((content) => content !== null);
        if (!anyFile && !unreadable && inEffect(states, false) === false) return;
        await remove(states);
        return;
      }
      const filesCurrent =
        onDisk.timer === desired.timer &&
        onDisk.launcher === desired.launcher &&
        onDisk.app === desired.app;
      if (!options.reload && filesCurrent && inEffect(states, true) === true) return;
      // What the timer starts before the timer, so it never names a unit that isn't there.
      for (const unit of ["app", "launcher", "timer"] as const) {
        if (onDisk[unit] === desired[unit]) continue;
        // An AppImage move while this pass ran wrote the app unit already.
        if (target !== writing) throw new Error("Daintree moved while its systemd units were written");
        await files.writeFile(fileOf(units[unit]), desired[unit]);
      }
      const reloaded = await systemctl(["daemon-reload"]);
      if (reloaded.code !== 0) {
        throw new Error(describeSystemctl("Couldn't reload systemd's user units", reloaded));
      }
      const enabled = await systemctl(["enable", units.timer]);
      if (enabled.code !== 0) {
        throw new Error(describeSystemctl("Couldn't enable the systemd timer", enabled));
      }
      // A waiting timer has already taken the new calendar from the reload, so
      // start does nothing to it; a repair restarts it all the same.
      const started = await systemctl([options.reload ? "restart" : "start", units.timer]);
      if (started.code !== 0) {
        throw new Error(describeSystemctl("Couldn't start the systemd timer", started));
      }
      if (inEffect(await readStates(), true) !== true) {
        throw new Error("systemd didn't take the timer that starts Daintree");
      }
    },

    async observe(cadences, systemTimeZone): Promise<ScheduleOsJobObservation> {
      const desired = desiredFiles(cadences, systemTimeZone);
      const [{ onDisk }, states] = await Promise.all([readFiles(), readStates()]);
      const present = Object.values(onDisk);
      return {
        installed: present.some((content) => content !== null),
        current:
          desired === null
            ? present.every((content) => content === null)
            : onDisk.timer === desired.timer &&
              onDisk.launcher === desired.launcher &&
              onDisk.app === desired.app,
        loaded: inEffect(states, desired !== null),
      };
    },

    followAppImageMove({ previous, next }) {
      if (!target || target.executable !== previous) return;
      const ours = buildScheduleAppUnit(target);
      target = { ...target, executable: next };
      const file = fileOf(units.app);
      try {
        let onDisk: string;
        try {
          onDisk = fs.readFileSync(file, "utf8");
        } catch {
          return;
        }
        // Only the unit this install wrote; another install's stays as it is.
        if (onDisk !== ours) return;
        resilientAtomicWriteFileSync(file, buildScheduleAppUnit(target), "utf-8", { mode: 0o644 });
        deps.reloadSync();
      } catch (error) {
        console.warn("[ScheduleOsJob] Couldn't point Daintree's systemd unit at the updated AppImage:", error);
      }
    },
  };
}
