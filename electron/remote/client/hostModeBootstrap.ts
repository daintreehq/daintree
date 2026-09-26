import type {
  HostProbeResult,
  StartHostModeResult,
} from "../../../shared/types/ipc/remoteHosts.js";
import {
  ENABLE_HOST_MODE_FLAG,
  HOST_MODE_FLAG,
  HOST_MODE_HANDOFF_FLAG,
  HOST_MODE_HANDOFF_NOBODY_EXIT_CODE,
} from "../../boot/hostModeLaunch.js";
import { AppError } from "../../utils/errorTypes.js";
import { APPIMAGE_EXTRACT_AND_RUN_ENV, systemdUnitFor } from "../host/startAtLogin.js";
import type { CommandResult } from "./commandRunner.js";
import { DEB_EXECUTABLE, LINUX_UNIT_NAME, MAC_APP_PATH, type ProbeOutcome } from "./hostProbe.js";
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
 */

const MARK = "@@dt:";
const SAFE_EXECUTABLE = /^\/[A-Za-z0-9._\-/ ]{1,1024}$/;
const LISTEN_TIMEOUT_MS = 60_000;
const CONFIRM_TIMEOUT_MS = 60_000;
const KEYCHAIN_SETTLE_MS = 12_000;
const POLL_MS = 2_000;

export interface HostModeBootstrapDeps {
  channel: HostCommandChannel;
  probe(): Promise<ProbeOutcome>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now?: () => number;
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

/** The Linux launch target for what the probe found installed. */
export function linuxLaunchTarget(probe: HostProbeResult): {
  executable: string;
  appPath: null;
  appImageExtractAndRun: boolean;
} {
  const install = probe.install;
  let executable: string | null = null;
  if (install?.packaging === "deb") executable = DEB_EXECUTABLE;
  else if (install?.packaging === "appimage") executable = install.path;
  if (!executable || !SAFE_EXECUTABLE.test(executable) || executable.includes("..")) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "No Daintree install on the host that setup can start",
      userMessage:
        "Daintree on this host isn't a deb or an AppImage setup knows how to start. Install it from here first.",
    });
  }
  return {
    executable,
    appPath: null,
    appImageExtractAndRun: install?.packaging === "appimage" && probe.advice.fuse === false,
  };
}

/** The script that writes the unit from stdin and enables it; one line of sh. */
export function writeUnitScript(): string {
  const dir = `"$HOME/.config/systemd/user"`;
  const file = `"$HOME/.config/systemd/user/${LINUX_UNIT_NAME}"`;
  const tmp = `"$HOME/.config/systemd/user/${LINUX_UNIT_NAME}.tmp"`;
  return `mkdir -p ${dir} && cat > ${tmp} && chmod 644 ${tmp} && mv -f ${tmp} ${file} && systemctl --user daemon-reload && systemctl --user enable ${LINUX_UNIT_NAME}`;
}

export const START_UNIT_SCRIPT = `systemctl --user start ${LINUX_UNIT_NAME}`;
export const ENABLE_LINGER_SCRIPT = "loginctl enable-linger";
/** Undo a unit this setup wrote: nothing is left to start at the next login after a failure. */
export const REMOVE_UNIT_SCRIPT = `systemctl --user disable --now ${LINUX_UNIT_NAME} >/dev/null 2>&1; rm -f "$HOME/.config/systemd/user/${LINUX_UNIT_NAME}"; systemctl --user daemon-reload >/dev/null 2>&1; true`;

/** Hand `--enable-host-mode` to the Daintree running on a Linux host; prints its exit status. */
export function linuxHandoffScript(target: ReturnType<typeof linuxLaunchTarget>): string {
  const env = target.appImageExtractAndRun ? `${APPIMAGE_EXTRACT_AND_RUN_ENV}=1 ` : "";
  return `${env}${sq(target.executable)} ${HOST_MODE_FLAG} ${ENABLE_HOST_MODE_FLAG} ${HOST_MODE_HANDOFF_FLAG} </dev/null >/dev/null 2>&1; echo "${MARK}handoff $?"`;
}

/** Launch (or hand over to) Daintree on a Mac, in its logged-in session. */
export const MAC_ENABLE_SCRIPT = `open -n -g -a ${sq(MAC_APP_PATH)} --args ${HOST_MODE_FLAG} ${ENABLE_HOST_MODE_FLAG}`;

/** Host mode is on for good there: listening, saved, and start at login in place. */
export function hostModeConfirmed(outcome: ProbeOutcome): boolean {
  const { result, parsed } = outcome;
  const state = result.hostModeState;
  if (!result.hostModeListening || !state) return false;
  // Recorded by the live process that is listening now, not left from an earlier run.
  if (parsed?.hostPid == null || state.pid !== parsed.hostPid) return false;
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
  sshTarget: string,
  before: ProbeOutcome,
  deps: HostModeBootstrapDeps
): Promise<StartHostModeResult> {
  const now = deps.now ?? Date.now;
  const signal = new AbortController().signal;
  const probe = before.result;
  if (hostModeConfirmed(before)) return { probe, lingerRefused: null };
  if (!probe.install) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "Daintree is not installed on the host",
      userMessage: "Install Daintree on this host first.",
    });
  }
  if (probe.matchesClient === false) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "The host runs a different build",
      userMessage: `Update Daintree on ${sshTarget} first: it runs a different build.`,
    });
  }

  const pollUntil = async (
    done: (outcome: ProbeOutcome) => boolean,
    timeoutMs: number
  ): Promise<ProbeOutcome> => {
    const deadline = now() + timeoutMs;
    let outcome = await deps.probe();
    while (!done(outcome) && now() < deadline) {
      await deps.sleep(POLL_MS, signal);
      outcome = await deps.probe();
    }
    return outcome;
  };

  let lingerRefused: string | null = null;
  // Set once this setup wrote a unit where there was none: undone if setup fails.
  let wroteUnit = false;
  let confirmed: ProbeOutcome;
  try {
    if (probe.platform === "darwin") {
      const started = await deps.channel.exec(MAC_ENABLE_SCRIPT, { timeoutMs: 30_000, signal });
      if (started.code !== 0) {
        throw new AppError({
          code: "INTERNAL",
          message: `Couldn't start Host mode: ${failureDetail(started, "ssh failed")}`,
          userMessage: `Couldn't start Daintree on ${sshTarget}. Log in there once and open it.`,
        });
      }
    } else {
      const target = linuxLaunchTarget(probe);
      // Without lingering the user's services stop with their last login.
      if (probe.advice.linger !== true) {
        const linger = await deps.channel.exec(ENABLE_LINGER_SCRIPT, { timeoutMs: 30_000, signal });
        if (linger.code !== 0) lingerRefused = failureDetail(linger, "loginctl failed");
      }
      const running = probe.hostModeListening || probe.appRunning;
      if (!running) {
        wroteUnit = probe.advice.hostModeUnit !== true;
        await run(
          deps.channel,
          writeUnitScript(),
          "Couldn't install the Host mode service (systemctl --user)",
          60_000,
          systemdUnitFor(target)
        );
        await run(deps.channel, START_UNIT_SCRIPT, "Couldn't start the Host mode service");
        const up = await pollUntil((o) => o.result.hostModeListening, LISTEN_TIMEOUT_MS);
        if (!up.result.hostModeListening) {
          throw failed(
            `The Host mode service started on ${sshTarget}, but Daintree didn't start listening`,
            `see journalctl --user -u ${LINUX_UNIT_NAME} there`
          );
        }
      }
      // Unpacking an AppImage without FUSE takes a while before it can hand over.
      const handoff = await run(
        deps.channel,
        linuxHandoffScript(target),
        "Couldn't reach Daintree on the host",
        target.appImageExtractAndRun ? 5 * 60_000 : 120_000
      );
      const code = markerValue(handoff.stdout, "handoff");
      if (code === String(HOST_MODE_HANDOFF_NOBODY_EXIT_CODE)) {
        throw failed(
          `Daintree stopped running on ${sshTarget} before Host mode could be switched on`
        );
      }
      if (code !== "0") {
        throw failed(
          `Daintree on ${sshTarget} didn't take the request`,
          `exit status ${code ?? "?"}`
        );
      }
    }

    confirmed = await pollUntil(hostModeConfirmed, CONFIRM_TIMEOUT_MS);
    if (!hostModeConfirmed(confirmed)) throw failed(unconfirmedReason(confirmed, sshTarget));
  } catch (error) {
    if (wroteUnit) {
      await deps.channel
        .exec(REMOVE_UNIT_SCRIPT, { timeoutMs: 60_000, signal })
        .catch(() => undefined);
    }
    throw error;
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
