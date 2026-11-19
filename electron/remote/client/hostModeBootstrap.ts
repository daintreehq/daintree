import type {
  HostProbeResult,
  StartHostModeResult,
} from "../../../shared/types/ipc/remoteHosts.js";
import { formatHostConnection, type HostConnection } from "../../../shared/types/remoteHosts.js";
import {
  ENABLE_HOST_MODE_FLAG,
  HEADLESS_OZONE_SWITCH,
  HOST_MODE_FLAG,
  HOST_MODE_HANDOFF_FLAG,
  HOST_MODE_HANDOFF_NOBODY_EXIT_CODE,
  UPDATE_CHANNEL_FLAG,
} from "../../boot/hostModeLaunch.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { LINUX_RUNTIME_DIR_NAME } from "../host/hostSocketPath.js";
import {
  APPIMAGE_EXTRACT_AND_RUN_ENV,
  hostModeLaunchArguments,
  systemdUnitFor,
} from "../host/startAtLogin.js";
import type { CommandResult } from "./commandRunner.js";
import {
  DEB_EXECUTABLE,
  LINUX_UNIT_NAME,
  MAC_APP_PATH,
  processStartShell,
  type ProbeOutcome,
} from "./hostProbe.js";
import type { UpdateChannel } from "./installPlan.js";
import { failureDetail, type HostCommandChannel } from "./remoteShell.js";

/**
 * Turn Host mode on for good on a machine, from setup on this one. The host's
 * own Daintree does the switching, exactly as its Settings switch would (the
 * setting saved, start at login installed, the keychain checked): this side
 * only gets it running with `--enable-host-mode`, then reads back what it
 * recorded and reports success only once that says so.
 *
 * - macOS: `open -n` launches through LaunchServices into the logged-in
 *   session, never as a child of this SSH login. A running Daintree gets the
 *   request handed over by the new instance, which then quits.
 * - Linux: with no Daintree running, the Daintree-owned `systemd --user` unit
 *   is written (the same text the host writes for itself), enabled and
 *   started, and lingering asked for so it outlives the login. The request
 *   then goes to the running Daintree with `--host-mode-handoff`, which quits
 *   at once instead of starting a backend under SSH if nothing is running.
 * - Linux with no init system (PID 1 isn't systemd, so no unit can run):
 *   Daintree is started in a session of its own that outlives the SSH login,
 *   carrying the enable request itself. Nothing restarts it after a reboot
 *   or a stop; a Shell's connection starts it again (see `ensureHostRunning`).
 */

const MARK = "@@dt:";
const SAFE_EXECUTABLE = /^\/[A-Za-z0-9._\-/ ]{1,1024}$/;
const LISTEN_TIMEOUT_MS = 60_000;
const CONFIRM_TIMEOUT_MS = 60_000;
const KEYCHAIN_SETTLE_MS = 12_000;
const POLL_MS = 2_000;
/** Restarts after which a service that never listened is crash-looping, not starting slowly. */
const CRASH_LOOP_RESTARTS = 2;

export interface HostModeBootstrapDeps {
  channel: HostCommandChannel;
  probe(): Promise<ProbeOutcome>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now?: () => number;
  /**
   * This machine's update channel. A host whose Daintree has never run there
   * (no settings yet, so nobody chose one) is handed it with the enable
   * request; any other keeps its own.
   */
  updateChannel?: UpdateChannel;
}

function sq(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function markerValue(stdout: string, key: string): string | null {
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(`${MARK}${key} `);
    if (at >= 0) return line.slice(at + MARK.length + key.length + 1).trim();
  }
  return null;
}

function failed(message: string, detail?: string): AppError {
  return new AppError({
    code: "INTERNAL",
    message: detail ? `${message}: ${detail}` : message,
    userMessage: detail ? `${message}: ${detail}` : message,
  });
}

export interface LinuxLaunchTarget {
  executable: string;
  appPath: null;
  appImageExtractAndRun: boolean;
}

/**
 * A Linux launch target for an executable: a deb's, or an AppImage (unpacked
 * to run where there is no FUSE). Refuses a path that isn't plainly one.
 */
export function linuxTargetFor(
  executable: string | null,
  appImage: boolean,
  fuse: boolean | null
): LinuxLaunchTarget {
  if (!executable || !SAFE_EXECUTABLE.test(executable) || executable.includes("..")) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "No Daintree install on the host that setup can start",
      userMessage:
        "Daintree on this host isn't a deb or an AppImage setup knows how to start. Install it from here first.",
    });
  }
  return { executable, appPath: null, appImageExtractAndRun: appImage && fuse === false };
}

/** The Linux launch target for what the probe found installed. */
export function linuxLaunchTarget(
  probe: Pick<HostProbeResult, "install" | "advice">
): LinuxLaunchTarget {
  const install = probe.install;
  let executable: string | null = null;
  if (install?.packaging === "deb") executable = DEB_EXECUTABLE;
  else if (install?.packaging === "appimage") executable = install.path;
  return linuxTargetFor(executable, install?.packaging === "appimage", probe.advice.fuse);
}

/** The script that writes the unit from stdin and enables it; one line of sh. */
export function writeUnitScript(): string {
  const dir = `"$HOME/.config/systemd/user"`;
  const file = `"$HOME/.config/systemd/user/${LINUX_UNIT_NAME}"`;
  const tmp = `"$HOME/.config/systemd/user/${LINUX_UNIT_NAME}.tmp"`;
  return `mkdir -p ${dir} && cat > ${tmp} && chmod 644 ${tmp} && mv -f ${tmp} ${file} && systemctl --user daemon-reload && systemctl --user enable ${LINUX_UNIT_NAME}`;
}

export const START_UNIT_SCRIPT = `systemctl --user start ${LINUX_UNIT_NAME}`;

const UNIT_DIR = "$HOME/.config/systemd/user";
const UNIT_FILE = `"${UNIT_DIR}/${LINUX_UNIT_NAME}"`;
/** Where a failed setup's copy of the earlier unit is left when it can't be put back. */
export const UNIT_BACKUP_PATH = `~/.config/systemd/user/${LINUX_UNIT_NAME}.daintree-setup-backup`;
const UNIT_BACKUP = `"${UNIT_DIR}/${LINUX_UNIT_NAME}.daintree-setup-backup"`;
/** The one link `systemctl --user enable` makes for the unit (it is `WantedBy=default.target`). */
const WANTS_LINK = `"${UNIT_DIR}/default.target.wants/${LINUX_UNIT_NAME}"`;
const RUNNING_STATES = new Set(["active", "activating", "reloading", "refreshing"]);
const STOPPED_STATES = new Set(["inactive", "failed", "deactivating", "maintenance"]);

/**
 * Before setup touches the unit: keep a copy of any that is there (a symlink,
 * such as a mask, stays a symlink), and note whether it was already enabled
 * through the link setup's enable makes and whether it was running, so a
 * failed setup puts back exactly what it found. A copy left by an earlier
 * setup whose undo never ran is moved aside, never overwritten.
 */
export const SAVE_UNIT_SCRIPT = `k=ok; if [ -e ${UNIT_BACKUP} ] || [ -L ${UNIT_BACKUP} ]; then mv -f ${UNIT_BACKUP} "${UNIT_DIR}/${LINUX_UNIT_NAME}.daintree-setup-backup.$(date +%s).$$" || k=no; fi; if [ "$k" != ok ]; then echo "${MARK}unitsaved failed"; elif [ -e ${UNIT_FILE} ] || [ -L ${UNIT_FILE} ]; then if cp -P -p ${UNIT_FILE} ${UNIT_BACKUP}; then echo "${MARK}unitsaved yes"; else echo "${MARK}unitsaved failed"; fi; if [ -e ${WANTS_LINK} ] || [ -L ${WANTS_LINK} ]; then echo "${MARK}unitwanted yes"; else echo "${MARK}unitwanted no"; fi; echo "${MARK}unitactive $(systemctl --user is-active ${LINUX_UNIT_NAME} 2>/dev/null)"; else echo "${MARK}unitsaved no"; fi`;

export interface PreviousUnit {
  existed: boolean;
  /** The `default.target.wants` link was there already, so setup's enable added nothing. */
  wanted: boolean;
  active: boolean;
}

/** What {@link SAVE_UNIT_SCRIPT} found; null when anything about it couldn't be read. */
export function parseSavedUnit(stdout: string): PreviousUnit | null {
  const saved = markerValue(stdout, "unitsaved");
  if (saved === "no") return { existed: false, wanted: false, active: false };
  if (saved !== "yes") return null;
  const wanted = markerValue(stdout, "unitwanted");
  const active = markerValue(stdout, "unitactive") ?? "";
  if (wanted !== "yes" && wanted !== "no") return null;
  if (!RUNNING_STATES.has(active) && !STOPPED_STATES.has(active)) return null;
  return { existed: true, wanted: wanted === "yes", active: RUNNING_STATES.has(active) };
}

/**
 * Put back the unit that was there before setup: its contents, then only the
 * enable setup did undone (every other link is left as it was), then running
 * or stopped. Prints nothing; fails if the unit couldn't be put back or started.
 */
export function restoreUnitScript(previous: PreviousUnit): string {
  const unlink = previous.wanted ? "" : `rm -f ${WANTS_LINK} && `;
  const run = previous.active
    ? `systemctl --user start ${LINUX_UNIT_NAME}`
    : `{ systemctl --user stop ${LINUX_UNIT_NAME} >/dev/null 2>&1; true; }`;
  return `${unlink}mv -f ${UNIT_BACKUP} ${UNIT_FILE} && systemctl --user daemon-reload && ${run}`;
}

export const DROP_UNIT_BACKUP_SCRIPT = `rm -f ${UNIT_BACKUP}`;
export const ENABLE_LINGER_SCRIPT = "loginctl enable-linger";
/** Undo a unit this setup wrote where there was none: nothing is left to start at the next login after a failure. */
export const REMOVE_UNIT_SCRIPT = `systemctl --user disable --now ${LINUX_UNIT_NAME} >/dev/null 2>&1; rm -f "$HOME/.config/systemd/user/${LINUX_UNIT_NAME}"; systemctl --user daemon-reload >/dev/null 2>&1; true`;

/** The service's restart count, and the journal of its runs. */
export const SERVICE_STATE_SCRIPT = `systemctl --user show -p NRestarts --value ${LINUX_UNIT_NAME} 2>/dev/null | sed 's/^/${MARK}restarts /'`;
export const SERVICE_JOURNAL_SCRIPT = `journalctl --user -u ${LINUX_UNIT_NAME} -n 200 --no-pager -o cat 2>/dev/null | tail -n 200`;

export function parseServiceRestarts(stdout: string): number | null {
  const value = markerValue(stdout, "restarts");
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * The first error the service's last run printed, without Chromium's
 * `[pid:time:ERROR:file]` prefix: what a person would look for in the journal.
 */
export function lastRunError(journal: string): string | null {
  const lines = journal.split("\n").map((line) => line.trim());
  let start = 0;
  lines.forEach((line, index) => {
    if (/^Started .*daintree/i.test(line)) start = index + 1;
  });
  for (const line of lines.slice(start)) {
    if (
      /^(Main process exited|Failed with result|Consumed |Scheduled restart|Stopped )/.test(line)
    ) {
      continue;
    }
    const chromium = /^\[[^\]]*:(?:ERROR|FATAL):[^\]]*\]\s*(.+)$/.exec(line);
    if (chromium) return chromium[1]!.slice(0, 300);
    if (/error while loading shared libraries|\b(?:Error|FATAL|Fatal)\b/.test(line)) {
      return line.slice(0, 300);
    }
  }
  return null;
}

function channelArg(updateChannel: UpdateChannel | undefined): string {
  return updateChannel ? ` ${UPDATE_CHANNEL_FLAG}=${updateChannel}` : "";
}

/** Hand `--enable-host-mode` to the Daintree running on a Linux host; prints its exit status. */
export function linuxHandoffScript(
  target: LinuxLaunchTarget,
  updateChannel?: UpdateChannel
): string {
  const env = target.appImageExtractAndRun ? `${APPIMAGE_EXTRACT_AND_RUN_ENV}=1 ` : "";
  return `${env}${sq(target.executable)} ${HOST_MODE_FLAG} ${ENABLE_HOST_MODE_FLAG}${channelArg(updateChannel)} ${HOST_MODE_HANDOFF_FLAG} </dev/null >/dev/null 2>&1; echo "${MARK}handoff $?"`;
}

const CACHE_DIR = `$HOME/.cache/${LINUX_RUNTIME_DIR_NAME}`;
const RECEIPT = `"${CACHE_DIR}/host-launch.pid"`;

/**
 * Sets `$lp` to the pid of the last start {@link detachedStartScript} made,
 * while that process still runs (by its recorded start time), else to nothing.
 */
export const DETACHED_LAUNCH_READ = `lp=""; if [ -f ${RECEIPT} ]; then lt=""; read -r lp lt < ${RECEIPT}; case "$lp" in ''|*[!0-9]*) lp="" ;; *) ${processStartShell("lp", "ln")}; if [ -z "$lt" ] || [ "$ln" != "$lt" ]; then lp=""; fi ;; esac; fi`;
/** Where a host started on connect writes its output: what a failed start is read from. */
export const DETACHED_LOG_PATH = `~/.cache/${LINUX_RUNTIME_DIR_NAME}/host.log`;
const DETACHED_LOG_ROTATE_BYTES = 1024 * 1024;
/** The end of that log, enough to find the last start's first error. */
export const DETACHED_LOG_SCRIPT = `tail -c 16384 "${CACHE_DIR}/host.log" 2>/dev/null`;
/** systemd's own default for a user manager's services. */
const SERVICE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Start Daintree in Host mode where no init system can (see the file
 * comment), as a unit would run it: headless, in a clean environment, in a
 * session of its own so the SSH login ending doesn't take it along, with its
 * output appended to {@link DETACHED_LOG_PATH} and nothing left on the SSH
 * channel. Prints `launched <pid> <start time> <new|running>`.
 *
 * The launch is recorded (pid and start time) in `host-launch.pid`, and one
 * still alive is reported rather than started again: an AppImage unpacking
 * without FUSE takes minutes before it is a `daintree` process or listens,
 * and a second launch meanwhile would come back after the first had quit.
 */
export function detachedStartScript(
  target: LinuxLaunchTarget,
  flags: readonly string[] = []
): string {
  const argv = [...hostModeLaunchArguments(target), HEADLESS_OZONE_SWITCH, ...flags];
  const env = [
    `HOME="$HOME"`,
    `USER="$u"`,
    `LOGNAME="$u"`,
    `SHELL="\${SHELL:-/bin/sh}"`,
    `PATH=${SERVICE_PATH}`,
    ...(target.appImageExtractAndRun ? [`${APPIMAGE_EXTRACT_AND_RUN_ENV}=1`] : []),
  ];
  return [
    `umask 077`,
    `c="${CACHE_DIR}"`,
    `mkdir -p "$c" || exit 1`,
    `cd "$HOME" || exit 1`,
    `r="$c/host-launch.pid"`,
    `l="$c/host.log"`,
    DETACHED_LAUNCH_READ,
    `if [ -n "$lp" ]; then echo "${MARK}launched $lp $lt running"; exit 0; fi`,
    `if [ -f "$l" ] && [ "$(wc -c < "$l")" -gt ${DETACHED_LOG_ROTATE_BYTES} ]; then mv -f "$l" "$l.1"; fi`,
    `echo "Started Daintree host $(date)" >> "$l"`,
    `u=$(id -un)`,
    `set -- ${env.join(" ")}`,
    // Only what a user manager would hand a service; any setting it knows about too.
    `if [ -n "\${LANG:-}" ]; then set -- "$@" LANG="$LANG"; fi`,
    `if [ -n "\${XDG_CONFIG_HOME:-}" ]; then set -- "$@" XDG_CONFIG_HOME="$XDG_CONFIG_HOME"; fi`,
    `s=""; if command -v setsid >/dev/null 2>&1; then s=setsid; fi`,
    `nohup $s env -i "$@" ${argv.map(sq).join(" ")} </dev/null >>"$l" 2>&1 &`,
    `lp=$!`,
    processStartShell("lp", "ln"),
    `printf '%s %s\\n' "$lp" "$ln" > "$r.tmp" && mv -f "$r.tmp" "$r"`,
    `echo "${MARK}launched $lp $ln new"`,
  ].join("; ");
}

export interface DetachedLaunch {
  pid: number;
  /** When it started, as /proc says; null when that couldn't be read. */
  startedAt: string | null;
  /** This call started it, rather than finding an earlier launch still alive. */
  fresh: boolean;
}

/** What {@link detachedStartScript} reported; null when it didn't say. */
export function parseDetachedLaunch(stdout: string): DetachedLaunch | null {
  const value = markerValue(stdout, "launched");
  const match = value ? /^(\d{1,10}) (\d{1,20})? ?(new|running)$/.exec(value) : null;
  if (!match) return null;
  return { pid: Number(match[1]), startedAt: match[2] ?? null, fresh: match[3] === "new" };
}

/** Runs `then` while the launch is still the process it was, by its start time. */
function whileSameLaunch(launch: DetachedLaunch, then: string): string {
  return `p=${launch.pid}; ${processStartShell("p", "n")}; if [ -n "$n" ] && [ "$n" = ${sq(launch.startedAt ?? "")} ]; then ${then}; fi`;
}

/**
 * Prints whether a launch is still running. Without a start time to tell it
 * from a later process given its pid, any process with it counts.
 */
export function detachedAliveScript(launch: DetachedLaunch): string {
  const yes = `echo "${MARK}alive yes"`;
  return launch.startedAt
    ? whileSameLaunch(launch, yes)
    : `if kill -0 ${launch.pid} 2>/dev/null; then ${yes}; fi`;
}

export function parseDetachedAlive(stdout: string): boolean {
  return markerValue(stdout, "alive") === "yes";
}

/** Ask a launch that is still the process it was to quit; anything since given its pid is left alone. */
export function detachedStopScript(launch: DetachedLaunch): string {
  return `${whileSameLaunch(launch, `kill -TERM "$p" 2>/dev/null`)}; true`;
}

/**
 * Start a host that is already set up, exactly as it was set up: Host mode for
 * this run on a Mac (no saved setting touched, unlike {@link macEnableScript}),
 * the existing user service on Linux (never written here).
 */
// `-n`: without it LaunchServices only reactivates a Daintree already running
// (one whose listener failed) and drops the arguments; a new instance hands
// them to it through second-instance, or becomes Daintree if none is running.
export function macStartScript(appPath: string = MAC_APP_PATH): string {
  return `open -n -g -a ${sq(appPath)} --args ${HOST_MODE_FLAG}`;
}
export const LINUX_START_SCRIPT = `systemctl --user start ${LINUX_UNIT_NAME}`;

/** Launch (or hand over to) Daintree on a Mac, in its logged-in session. */
export function macEnableScript(
  updateChannel?: UpdateChannel,
  appPath: string = MAC_APP_PATH
): string {
  return `open -n -g -a ${sq(appPath)} --args ${HOST_MODE_FLAG} ${ENABLE_HOST_MODE_FLAG}${channelArg(updateChannel)}`;
}

export const MAC_ENABLE_SCRIPT = macEnableScript();

/**
 * Host mode is on for good there: listening, saved, and start at login in
 * place, or, where nothing can start it at login, recorded as started on connect.
 */
export function hostModeConfirmed(outcome: ProbeOutcome): boolean {
  const { result, parsed } = outcome;
  const state = result.hostModeState;
  if (!result.hostModeListening || !state) return false;
  // Recorded by the live process that is listening now, not left from an earlier run.
  if (parsed?.hostPid == null || state.pid !== parsed.hostPid) return false;
  if (result.startsOnConnect) return state.enabled && state.startMethod === "on-connect";
  return (
    state.enabled &&
    state.startAtLogin &&
    state.startAtLoginInstalled === true &&
    result.advice.startAtLoginInstalled === true
  );
}

/** Why a read-back fell short, in terms of what was seen. */
function unconfirmedReason(outcome: ProbeOutcome, hostName: string): string {
  const { result, parsed } = outcome;
  const state = result.hostModeState;
  if (!result.reachable) return `${hostName} stopped answering over SSH`;
  if (!result.hostModeListening) return `Daintree didn't start listening on ${hostName}`;
  if (!state || (parsed?.hostPid != null && state.pid !== parsed.hostPid)) {
    return `Host mode is listening on ${hostName}, but Daintree there didn't record that it was switched on`;
  }
  if (!state.enabled) {
    return `Host mode is listening on ${hostName}, but its setting there didn't read back as on`;
  }
  if (result.startsOnConnect) {
    return `Host mode is on at ${hostName}, but Daintree there didn't record that it runs without systemd. Update Daintree there, then try again`;
  }
  if (state.startAtLoginError) {
    return `Host mode is on at ${hostName}, but start at login couldn't be installed there: ${state.startAtLoginError}`;
  }
  return `Host mode is on at ${hostName}, but its start-at-login item isn't in place there`;
}

async function run(
  channel: HostCommandChannel,
  script: string,
  what: string,
  timeoutMs = 60_000,
  input?: string
): Promise<CommandResult> {
  const signal = new AbortController().signal;
  const result =
    input === undefined
      ? await channel.exec(script, { timeoutMs, signal })
      : await channel.execWithInput(script, { text: input }, { timeoutMs, signal });
  if (result.code !== 0) throw failed(what, failureDetail(result, "ssh failed"));
  return result;
}

export async function bootstrapHostMode(
  connection: HostConnection,
  before: ProbeOutcome,
  deps: HostModeBootstrapDeps
): Promise<StartHostModeResult> {
  const hostLabel = formatHostConnection(connection);
  const now = deps.now ?? Date.now;
  const signal = new AbortController().signal;
  const probe = before.result;
  if (hostModeConfirmed(before)) return { probe, lingerRefused: null };
  // Left on its default, a nightly host would "update" to the stable release its version sorts below.
  const updateChannel = before.parsed?.hasSettings === false ? deps.updateChannel : undefined;
  if (!probe.install) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "Daintree is not installed on the host",
      userMessage: "Install Daintree on this host first.",
    });
  }
  // A different build is turned on as it is: it connects best effort, with a warning.

  /** Hand `--enable-host-mode` to the Daintree running there. */
  const handOver = async (target: LinuxLaunchTarget): Promise<void> => {
    // Unpacking an AppImage without FUSE takes a while before it can hand over.
    const handoff = await run(
      deps.channel,
      linuxHandoffScript(target, updateChannel),
      "Couldn't reach Daintree on the host",
      target.appImageExtractAndRun ? 5 * 60_000 : 120_000
    );
    const code = markerValue(handoff.stdout, "handoff");
    if (code === String(HOST_MODE_HANDOFF_NOBODY_EXIT_CODE)) {
      throw failed(
        `Daintree stopped running on ${hostLabel} before Host mode could be switched on`
      );
    }
    if (code !== "0") {
      throw failed(
        `Daintree on ${hostLabel} didn't take the request`,
        `exit status ${code ?? "?"}`
      );
    }
  };

  const pollUntil = async (
    done: (outcome: ProbeOutcome) => boolean,
    timeoutMs: number,
    giveUp?: () => Promise<boolean>
  ): Promise<ProbeOutcome> => {
    const deadline = now() + timeoutMs;
    let outcome = await deps.probe();
    while (!done(outcome) && now() < deadline) {
      if (giveUp && (await giveUp())) break;
      await deps.sleep(POLL_MS, signal);
      outcome = await deps.probe();
    }
    return outcome;
  };

  let lingerRefused: string | null = null;
  // What the unit was before this setup touched it: put back if setup fails.
  let previousUnit: PreviousUnit | null = null;
  // A Daintree this setup started on a machine with no init system: stopped if setup fails.
  let launched: DetachedLaunch | null = null;
  let confirmed: ProbeOutcome;
  try {
    if (probe.platform === "darwin") {
      const started = await deps.channel.exec(macEnableScript(updateChannel, probe.install?.path), {
        timeoutMs: 30_000,
        signal,
      });
      if (started.code !== 0) {
        throw new AppError({
          code: "INTERNAL",
          message: `Couldn't start Host mode: ${failureDetail(started, "ssh failed")}`,
          userMessage: `Couldn't start Daintree on ${hostLabel}. Log in there once and open it.`,
        });
      }
    } else if (probe.startsOnConnect) {
      const target = linuxLaunchTarget(probe);
      // A fresh launch carries the request itself; anything already running is handed it.
      let handOff = probe.hostModeListening || probe.appRunning;
      if (!handOff) {
        const started = await run(
          deps.channel,
          detachedStartScript(target, [
            ENABLE_HOST_MODE_FLAG,
            ...(updateChannel ? [`${UPDATE_CHANNEL_FLAG}=${updateChannel}`] : []),
          ]),
          "Couldn't start Daintree on the host"
        );
        const launch = parseDetachedLaunch(started.stdout);
        if (!launch) {
          throw failed(`Couldn't start Daintree on ${hostLabel}`, "it didn't say what it started");
        }
        if (launch.fresh) launched = launch;
        // An earlier start still unpacking took no request: it is handed over once listening.
        else handOff = true;
        let exited = false;
        const up = await pollUntil(
          (o) => o.result.hostModeListening,
          LISTEN_TIMEOUT_MS,
          async () => {
            const alive = await deps.channel
              .exec(detachedAliveScript(launch), { timeoutMs: 15_000, signal })
              .catch(() => null);
            exited = alive !== null && alive.code === 0 && !parseDetachedAlive(alive.stdout);
            return exited;
          }
        );
        if (!up.result.hostModeListening) {
          const log = await deps.channel
            .exec(DETACHED_LOG_SCRIPT, { timeoutMs: 15_000, signal })
            .catch(() => null);
          const error = log ? lastRunError(log.stdout) : null;
          const where = `${DETACHED_LOG_PATH} there`;
          throw failed(
            exited
              ? `Daintree exited on ${hostLabel} as it started`
              : `Daintree started on ${hostLabel}, but didn't start listening`,
            error ? `${error} (more in ${where})` : `see ${where}`
          );
        }
      }
      if (handOff) await handOver(target);
    } else {
      const target = linuxLaunchTarget(probe);
      // Without lingering the user's services stop with their last login. A WSL
      // distro keeps that login for as long as it runs, so it isn't asked.
      if (connection.kind !== "wsl" && probe.advice.linger !== true) {
        const linger = await deps.channel.exec(ENABLE_LINGER_SCRIPT, { timeoutMs: 30_000, signal });
        if (linger.code !== 0) lingerRefused = failureDetail(linger, "loginctl failed");
      }
      const running = probe.hostModeListening || probe.appRunning;
      if (!running) {
        const saved = await run(
          deps.channel,
          SAVE_UNIT_SCRIPT,
          "Couldn't read the Host mode service already there"
        );
        previousUnit = parseSavedUnit(saved.stdout);
        if (!previousUnit) {
          throw failed(
            `Couldn't keep a copy of the Host mode service already on ${hostLabel}`,
            `~/.config/systemd/user/${LINUX_UNIT_NAME}`
          );
        }
        await run(
          deps.channel,
          writeUnitScript(),
          "Couldn't install the Host mode service (systemctl --user)",
          60_000,
          systemdUnitFor(target)
        );
        await run(deps.channel, START_UNIT_SCRIPT, "Couldn't start the Host mode service");
        // Counted from here: an earlier failed setup may have left restarts on the unit.
        const restartsAt = async () =>
          parseServiceRestarts(
            (await deps.channel.exec(SERVICE_STATE_SCRIPT, { timeoutMs: 15_000, signal })).stdout
          );
        const baseline = (await restartsAt()) ?? 0;
        let crashLooping = false;
        const up = await pollUntil(
          (o) => o.result.hostModeListening,
          LISTEN_TIMEOUT_MS,
          async () => {
            const restarts = await restartsAt();
            crashLooping = restarts !== null && restarts - baseline >= CRASH_LOOP_RESTARTS;
            return crashLooping;
          }
        );
        if (!up.result.hostModeListening) {
          const journal = await deps.channel
            .exec(SERVICE_JOURNAL_SCRIPT, { timeoutMs: 15_000, signal })
            .catch(() => null);
          const error = journal ? lastRunError(journal.stdout) : null;
          const where = `journalctl --user -u ${LINUX_UNIT_NAME} there`;
          if (crashLooping) {
            throw failed(
              `Daintree's Host mode service on ${hostLabel} keeps exiting as it starts`,
              error ? `${error} (more in ${where})` : `see ${where}`
            );
          }
          throw failed(
            `The Host mode service started on ${hostLabel}, but Daintree didn't start listening`,
            error ? `${error} (more in ${where})` : `see ${where}`
          );
        }
      }
      await handOver(target);
    }

    confirmed = await pollUntil(hostModeConfirmed, CONFIRM_TIMEOUT_MS);
    if (!hostModeConfirmed(confirmed)) throw failed(unconfirmedReason(confirmed, hostLabel));
  } catch (error) {
    if (launched) {
      await deps.channel
        .exec(detachedStopScript(launched), { timeoutMs: 30_000, signal })
        .catch(() => undefined);
    }
    if (previousUnit && !previousUnit.existed) {
      await deps.channel
        .exec(REMOVE_UNIT_SCRIPT, { timeoutMs: 60_000, signal })
        .catch(() => undefined);
    } else if (previousUnit) {
      const undone = await deps.channel
        .exec(restoreUnitScript(previousUnit), { timeoutMs: 60_000, signal })
        .catch(() => null);
      if (undone?.code !== 0) {
        const why = formatErrorMessage(error, "Host mode setup failed");
        throw failed(
          `${why}. Setup couldn't put back the Host mode service that was already on ${hostLabel}`,
          `its copy is at ${UNIT_BACKUP_PATH} there${undone ? ` (${failureDetail(undone, "ssh failed")})` : ""}`
        );
      }
    }
    throw error;
  }
  if (previousUnit?.existed) {
    await deps.channel
      .exec(DROP_UNIT_BACKUP_SCRIPT, { timeoutMs: 30_000, signal })
      .catch(() => undefined);
  }
  let after = confirmed;
  // The keychain check runs there right after; its answer belongs in the advice.
  if (after.result.hostModeState?.keychain.checked !== true) {
    const settled = await pollUntil(
      (o) => hostModeConfirmed(o) && o.result.hostModeState?.keychain.checked === true,
      KEYCHAIN_SETTLE_MS
    );
    if (hostModeConfirmed(settled)) after = settled;
  }
  return { probe: after.result, lingerRefused };
}
