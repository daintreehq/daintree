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
 * (#15991): one Daintree-owned `systemd --user` timer whose `OnCalendar=`
 * lines hold every such schedule's occurrences, and the service it starts,
 * which runs Daintree with `--run-due-schedules`.
 *
 * The service runs Daintree itself, so a Daintree it started is that
 * service's main process. Nothing here ever stops or restarts the service:
 * a rewrite reloads and restarts only the timer, which leaves the service
 * running, and removal stops only the timer.
 *
 * It only ever writes, enables, starts and stops its own two units. It is not
 * Host mode's start-at-login unit, which stays as it is.
 */

type Cadence = Pick<ScheduleCadence, "cron" | "timeZone">;

const SYSTEMCTL = "systemctl";
const UNIT_PREFIX = "daintree-schedules";
/** systemctl answers a status read at once; one that doesn't is hung, not slow. */
const SHOW_TIMEOUT_MS = 5_000;
const CHANGE_TIMEOUT_MS = 30_000;
/**
 * How long the service waits for a desktop session, in 2-second looks. The
 * catch-up for a run missed while the machine was off fires as the user
 * manager starts at login, before the session has said where its display is.
 */
const DISPLAY_LOOKS = 150;

export interface SystemdScheduleTarget {
  /** The binary the service runs: the AppImage when running from one, else the executable. */
  executable: string;
  /** Dev builds run the Electron binary against an app folder. */
  appPath: string | null;
  /** This profile, so the service starts the Daintree whose schedules it holds. */
  userDataDir: string;
  /** An AppImage on a machine without FUSE, which its runtime unpacks and runs instead. */
  appImageExtractAndRun: boolean;
}

export type SystemdScheduleTargetResult =
  { ok: true; target: SystemdScheduleTarget } | { ok: false; unavailable: string };

/** What this running Daintree's service should start, or why there can't be one. */
export function systemdScheduleTargetFor(input: {
  execPath: string;
  appImage: string | null;
  appPath: string | null;
  userDataDir: string;
  appImageExtractAndRun: boolean;
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
      // An AppImage's execPath is inside its temporary mount; the service must run the image.
      executable: input.appImage ?? input.execPath,
      appPath: input.appPath,
      userDataDir: input.userDataDir,
      appImageExtractAndRun: input.appImage !== null && input.appImageExtractAndRun,
    },
  };
}

/**
 * One pair of units per profile: two profiles' schedules are two timers, and
 * two copies of the app sharing a profile share one, which the copy that ran
 * last points at itself.
 */
export function scheduleSystemdUnitBase(userDataDir: string): string {
  const digest = createHash("sha256").update(userDataDir).digest("hex").slice(0, 12);
  return `${UNIT_PREFIX}-${digest}`;
}

export function scheduleSystemdArguments(target: SystemdScheduleTarget): string[] {
  return [
    target.executable,
    ...(target.appPath ? [target.appPath] : []),
    `--user-data-dir=${target.userDataDir}`,
    RUN_DUE_SCHEDULES_FLAG,
  ];
}

/**
 * Waits until the user manager's environment names a display, which the
 * desktop session puts there once it is up, so Daintree starts in it and can
 * open a window later. Each command a service runs takes the manager's
 * environment as it is then, so Daintree, started next, sees the display too.
 * A machine with no desktop session starts nothing.
 */
export const DISPLAY_WAIT_SCRIPT = `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR; i=0; until systemctl --user show-environment 2>/dev/null | grep -Eq '^(DISPLAY|WAYLAND_DISPLAY)=.'; do i=$((i + 1)); if [ "$i" -ge ${DISPLAY_LOOKS} ]; then echo "No desktop session to start Daintree in" >&2; exit 1; fi; sleep 2; done`;

function command(args: readonly string[]): string {
  return args.map(systemdQuote).join(" ");
}

export function buildScheduleServiceUnit(target: SystemdScheduleTarget): string {
  return [
    `[Unit]`,
    `Description=Daintree scheduled runs (starts Daintree when a schedule is due)`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStartPre=${command(["/bin/sh", "-c", DISPLAY_WAIT_SCRIPT])}`,
    `ExecStart=${command(scheduleSystemdArguments(target))}`,
    ...(target.appImageExtractAndRun
      ? [
          `Environment=${APPIMAGE_EXTRACT_AND_RUN_ENV}=1`,
          `ExecStop=${command(["/bin/sh", "-c", APPIMAGE_STOP_SCRIPT])}`,
        ]
      : []),
    // Longer than the wait for a desktop session, which counts toward it.
    `TimeoutStartSec=${Math.ceil((DISPLAY_LOOKS * 2) / 60) + 1}min`,
    // A stop (only ever the session ending) signals Daintree alone and lets it
    // close its own helpers; its own shutdown gives up after 20 s.
    `KillMode=mixed`,
    `TimeoutStopSec=30`,
    ``,
  ].join("\n");
}

export function buildScheduleTimerUnit(input: {
  service: string;
  specs: readonly string[];
}): string {
  return [
    `[Unit]`,
    `Description=Start Daintree for scheduled runs`,
    ``,
    `[Timer]`,
    ...input.specs.map((spec) => `OnCalendar=${spec}`),
    // Fires once at the next start of the user manager (a boot and login) for
    // an occurrence missed while it wasn't running.
    `Persistent=true`,
    // Within a second, not the minute systemd allows by default: a launch more
    // than a minute after its occurrence counts it as missed.
    `AccuracySec=1s`,
    `Unit=${input.service}`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n");
}

/** Every eligible schedule's lines, each written once, in a stable order. */
export function scheduleTimerSpecs(cadences: readonly Cadence[], systemTimeZone: string): string[] {
  const specs = new Set<string>();
  for (const cadence of cadences) {
    const calendar = systemdCalendarFor(cadence, systemTimeZone);
    if (!calendar.ok) continue;
    for (const spec of calendar.specs) specs.add(spec);
  }
  return [...specs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

interface UnitState {
  loadState: string;
  activeState: string;
  unitFileState: string;
  needDaemonReload: boolean;
}

/** `systemctl show` blocks by unit id; null when either unit is missing from them. */
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
   * it fires during the install, moments before the process quits, and the
   * service would otherwise start the deleted image until Daintree next ran.
   */
  followAppImageMove(relocation: { previous: string; next: string }): void;
}

export function createSystemdScheduleJob(deps: {
  homeDir: string;
  target: SystemdScheduleTargetResult;
  userDataDir: string;
  run: CommandRunner;
  /** `systemctl --user daemon-reload`, run to completion; used only by followAppImageMove. */
  reloadSync: () => void;
  fs?: ScheduleJobFs;
}): SystemdScheduleJob {
  const files = deps.fs ?? nodeScheduleJobFs;
  const base = scheduleSystemdUnitBase(deps.userDataDir);
  const timer = `${base}.timer`;
  const service = `${base}.service`;
  const unitDir = path.posix.join(deps.homeDir, ".config", "systemd", "user");
  const timerFile = path.posix.join(unitDir, timer);
  const serviceFile = path.posix.join(unitDir, service);
  // What `systemctl --user enable` links for `WantedBy=timers.target`.
  const wantsLink = path.posix.join(unitDir, "timers.target.wants", timer);
  let target = deps.target.ok ? deps.target.target : null;

  const systemctl = (args: readonly string[], timeoutMs = CHANGE_TIMEOUT_MS) =>
    deps.run(SYSTEMCTL, ["--user", ...args], { timeoutMs });

  const desiredUnits = (
    cadences: readonly Cadence[],
    systemTimeZone: string
  ): { timer: string; service: string } | null => {
    const specs = scheduleTimerSpecs(cadences, systemTimeZone);
    if (specs.length === 0 || !target) return null;
    return {
      timer: buildScheduleTimerUnit({ service, specs }),
      service: buildScheduleServiceUnit(target),
    };
  };

  /** Null when systemctl couldn't say. */
  const readStates = async (): Promise<{ timer: UnitState; service: UnitState } | null> => {
    const result = await systemctl(
      [
        "show",
        timer,
        service,
        "-p",
        "Id",
        "-p",
        "LoadState",
        "-p",
        "ActiveState",
        "-p",
        "UnitFileState",
        "-p",
        "NeedDaemonReload",
      ],
      SHOW_TIMEOUT_MS
    );
    if (result.code !== 0) return null;
    const states = parseUnitStates(result.stdout, [timer, service]);
    return states ? { timer: states.get(timer)!, service: states.get(service)! } : null;
  };

  /**
   * Whether the job is in effect. With a job to have: the timer is waiting,
   * enabled for the next login, and loaded from the files now on disk. With
   * none: anything of it still waiting or enabled.
   */
  const inEffect = (
    states: { timer: UnitState; service: UnitState } | null,
    wanted: boolean
  ): boolean | null => {
    if (!states) return null;
    const armed = states.timer.activeState === "active";
    const enabled = states.timer.unitFileState === "enabled";
    if (!wanted) return armed || enabled;
    return (
      armed &&
      enabled &&
      states.timer.loadState === "loaded" &&
      !states.timer.needDaemonReload &&
      !states.service.needDaemonReload
    );
  };

  const readFiles = async () => {
    // A file that can't be read is neither current nor known to be gone.
    let unreadable = false;
    const read = (file: string) =>
      files.readFile(file).catch(() => {
        unreadable = true;
        return null;
      });
    const [timerOnDisk, serviceOnDisk] = await Promise.all([read(timerFile), read(serviceFile)]);
    return { timerOnDisk, serviceOnDisk, unreadable };
  };

  const remove = async (states: { timer: UnitState; service: UnitState } | null) => {
    const failures: string[] = [];
    if (inEffect(states, false) !== false) {
      const disabled = await systemctl(["disable", "--now", timer]);
      if (disabled.code !== 0) {
        failures.push(describeSystemctl("Couldn't stop the systemd timer", disabled));
      }
    }
    // The link goes too, so a disable that failed can't leave the next login a timer to start.
    for (const file of [wantsLink, timerFile, serviceFile]) {
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
      const desired = desiredUnits(cadences, systemTimeZone);
      const [{ timerOnDisk, serviceOnDisk, unreadable }, states] = await Promise.all([
        readFiles(),
        readStates(),
      ]);
      if (desired === null) {
        if (timerOnDisk === null && serviceOnDisk === null && !unreadable) {
          if (inEffect(states, false) === false) return;
        }
        await remove(states);
        return;
      }
      if (
        !options.reload &&
        timerOnDisk === desired.timer &&
        serviceOnDisk === desired.service &&
        inEffect(states, true) === true
      ) {
        return;
      }
      // The service first, so the timer never names one it can't find.
      if (serviceOnDisk !== desired.service) await files.writeFile(serviceFile, desired.service);
      if (timerOnDisk !== desired.timer) await files.writeFile(timerFile, desired.timer);
      const reloaded = await systemctl(["daemon-reload"]);
      if (reloaded.code !== 0) {
        throw new Error(describeSystemctl("Couldn't reload systemd's user units", reloaded));
      }
      const enabled = await systemctl(["enable", timer]);
      if (enabled.code !== 0) {
        throw new Error(describeSystemctl("Couldn't enable the systemd timer", enabled));
      }
      // A waiting timer has already taken the new calendar from the reload, so
      // start does nothing to it; a repair restarts it all the same.
      const started = await systemctl([options.reload ? "restart" : "start", timer]);
      if (started.code !== 0) {
        throw new Error(describeSystemctl("Couldn't start the systemd timer", started));
      }
      if (inEffect(await readStates(), true) !== true) {
        throw new Error("systemd didn't take the timer that starts Daintree");
      }
    },

    async observe(cadences, systemTimeZone): Promise<ScheduleOsJobObservation> {
      const desired = desiredUnits(cadences, systemTimeZone);
      const [{ timerOnDisk, serviceOnDisk }, states] = await Promise.all([
        readFiles(),
        readStates(),
      ]);
      return {
        installed: timerOnDisk !== null || serviceOnDisk !== null,
        current:
          desired === null
            ? timerOnDisk === null && serviceOnDisk === null
            : timerOnDisk === desired.timer && serviceOnDisk === desired.service,
        loaded: inEffect(states, desired !== null),
      };
    },

    followAppImageMove({ previous, next }) {
      if (!target || target.executable !== previous) return;
      const moved = { ...target, executable: next };
      target = moved;
      try {
        let onDisk: string;
        try {
          onDisk = fs.readFileSync(serviceFile, "utf8");
        } catch {
          return;
        }
        // Only the unit this install wrote; another install's stays as it is.
        if (onDisk !== buildScheduleServiceUnit({ ...moved, executable: previous })) return;
        resilientAtomicWriteFileSync(serviceFile, buildScheduleServiceUnit(moved), "utf-8", {
          mode: 0o644,
        });
        deps.reloadSync();
      } catch (error) {
        console.warn("[ScheduleOsJob] Couldn't point the systemd service at the updated AppImage:", error);
      }
    },
  };
}
