import fs from "node:fs/promises";
import path from "node:path";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import type {
  HostInstallPlan,
  InstallHostPayload,
  InstallHostResult,
} from "../../../shared/types/ipc/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { CommandRunner } from "./commandRunner.js";
import {
  APPIMAGE_BUILD_INFO_SUFFIX,
  BUILD_INFO_PATTERN,
  LINUX_UNIT_NAME,
  MAC_APP_PATH,
  formatBuildInfo,
  type ProbeOutcome,
} from "./hostProbe.js";
import { type ClientBuild, debInstallCommand, planInstall } from "./installPlan.js";
import { failureDetail, type RemoteShell } from "./remoteShell.js";

/**
 * Carry out an install or update on a host: stage the new build next to the
 * old one, wait (or refuse) while the host reports working agents, stop
 * Daintree there, swap the build in, start it again the way it was running,
 * and check the host comes back on this client's build. Restarting ends the
 * host's terminals, which is why the agent gate sits right before the stop.
 */

export interface InstallProgress {
  stage: string;
  fraction: number | null;
  message: string | null;
}

export interface InstallerDeps {
  shell: RemoteShell;
  /** Local programs (ditto). */
  run: CommandRunner;
  client: ClientBuild;
  probe(signal: AbortSignal): Promise<ProbeOutcome>;
  /** Agents the host reports working now; null when that can't be observed. */
  workingAgents(hostId: HostId | null): Promise<number | null>;
  download(url: string, destination: string, signal: AbortSignal): Promise<void>;
  /** A directory on this machine for this host's downloaded or packed bundles. */
  cacheDir: string;
  /** Dial the host again and say whether it came back on this build; null when not in the list. */
  reconnect?(hostId: HostId): Promise<boolean | null>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now?: () => number;
  idlePollMs?: number;
  comeBackTimeoutMs?: number;
}

const MARK = "@@dt:";
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._\-/ ]{1,1024}$/;
const SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\-/+]+$/;

function sq(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function remotePath(value: string): string {
  if (!SAFE_REMOTE_PATH.test(value) || value.includes("..")) {
    throw new AppError({ code: "VALIDATION", message: `Unusual path on the host: ${value}` });
  }
  return sq(value);
}

function markerValue(stdout: string, key: string): string | null {
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(`${MARK}${key} `);
    if (at >= 0) return line.slice(at + MARK.length + key.length + 1).trim();
  }
  return null;
}

function cancelled(): AppError {
  return new AppError({ code: "CANCELLED", message: "Install cancelled" });
}

function failed(message: string, detail?: string): AppError {
  return new AppError({
    code: "INTERNAL",
    message: detail ? `${message}: ${detail}` : message,
    userMessage: message,
  });
}

async function exec(
  deps: InstallerDeps,
  script: string,
  signal: AbortSignal,
  what: string,
  timeoutMs = 120_000
): Promise<string> {
  const result = await deps.shell.exec(script, { signal, timeoutMs });
  if (signal.aborted) throw cancelled();
  if (result.code !== 0) throw failed(what, failureDetail(result, "ssh failed"));
  return result.stdout;
}

/** The staged file name on the host for a plan. */
function stagedName(plan: HostInstallPlan): string {
  if (plan.artifactName) return plan.artifactName;
  return plan.packaging === "app-bundle" ? "bundle.zip" : "Daintree.AppImage";
}

async function stage(
  deps: InstallerDeps,
  plan: HostInstallPlan,
  signal: AbortSignal,
  report: (p: InstallProgress) => void
): Promise<{ dir: string; file: string }> {
  const out = await exec(
    deps,
    `d=$(mktemp -d "\${TMPDIR:-/tmp}/daintree-stage.XXXXXX") && chmod 755 "$d" && echo "${MARK}stage $d"`,
    signal,
    "Couldn't make a staging folder on the host"
  );
  const dir = markerValue(out, "stage");
  if (!dir || !SAFE_REMOTE_PATH.test(dir))
    throw failed("Couldn't make a staging folder on the host");
  const file = path.posix.join(dir, stagedName(plan));

  if (plan.delivery === "host-fetch") {
    const url = plan.artifactUrl!;
    if (!SAFE_URL.test(url)) throw failed("The release URL isn't usable", url);
    report({ stage: "downloading", fraction: 0.2, message: "The host is downloading the build" });
    await exec(
      deps,
      `cd ${remotePath(dir)} && if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o ${remotePath(file)} ${sq(url)}; else wget -q -O ${remotePath(file)} ${sq(url)}; fi`,
      signal,
      "The host couldn't download the build",
      30 * 60_000
    );
    return { dir, file };
  }

  await fs.mkdir(deps.cacheDir, { recursive: true, mode: 0o700 });
  let local: string;
  if (plan.delivery === "push-bundle") {
    const bundle = deps.client.bundle;
    if (bundle.kind === "app-bundle") {
      report({ stage: "packing", fraction: 0.15, message: "Packing this machine's build" });
      local = path.join(deps.cacheDir, `Daintree-${plan.version}-${deps.client.arch}.zip`);
      await fs.rm(local, { force: true });
      const packed = await deps.run("ditto", ["-c", "-k", "--keepParent", bundle.path, local], {
        signal,
        timeoutMs: 10 * 60_000,
      });
      if (signal.aborted) throw cancelled();
      if (packed.code !== 0)
        throw failed("Couldn't pack this machine's build", failureDetail(packed, "ditto failed"));
    } else if (bundle.kind === "appimage") {
      local = bundle.path;
    } else {
      throw failed("This machine has no build to copy");
    }
  } else {
    report({ stage: "downloading", fraction: 0.2, message: "Downloading the build" });
    local = path.join(deps.cacheDir, plan.artifactName!);
    await deps.download(plan.artifactUrl!, local, signal);
  }

  report({ stage: "copying", fraction: 0.45, message: "Copying the build to the host" });
  const copied = await deps.shell.upload(local, file, { signal, timeoutMs: 30 * 60_000 });
  // The app's own AppImage is never removed; packed and downloaded copies are.
  if (local !== (deps.client.bundle.kind === "appimage" ? deps.client.bundle.path : null)) {
    await fs.rm(local, { force: true }).catch(() => {});
  }
  if (signal.aborted) throw cancelled();
  if (copied.code !== 0)
    throw failed("Couldn't copy the build to the host", failureDetail(copied, "scp failed"));
  return { dir, file };
}

/** Unpack and check the staged build, so nothing is stopped for a bad download. */
async function verifyStaged(
  deps: InstallerDeps,
  plan: HostInstallPlan,
  staged: { dir: string; file: string },
  signal: AbortSignal
): Promise<void> {
  if (plan.packaging === "app-bundle") {
    const out = await exec(
      deps,
      `ditto -x -k ${remotePath(staged.file)} ${remotePath(`${staged.dir}/x`)} && echo "${MARK}version $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' ${remotePath(`${staged.dir}/x/Daintree.app/Contents/Info.plist`)} 2>/dev/null)"; b=$(grep -a -o -m 1 -E ${sq(BUILD_INFO_PATTERN)} ${remotePath(`${staged.dir}/x/Daintree.app/Contents/Resources/app.asar`)} 2>/dev/null | head -n 1); echo "${MARK}buildinfo $b"`,
      signal,
      "Couldn't unpack the build on the host",
      10 * 60_000
    );
    if (markerValue(out, "version") !== plan.version) {
      throw failed(
        "The staged build isn't the expected version",
        markerValue(out, "version") ?? ""
      );
    }
    // A build without the marker (older, or a dev build) can't be checked this way.
    const marker = markerValue(out, "buildinfo");
    if (marker && marker !== formatBuildInfo(plan.version, plan.commit)) {
      throw failed("The staged build isn't the expected commit", marker);
    }
    return;
  }
  await exec(
    deps,
    `test -s ${remotePath(staged.file)} && chmod ${plan.packaging === "deb" ? "644" : "755"} ${remotePath(staged.file)}`,
    signal,
    "The staged build is missing on the host"
  );
}

async function waitForIdle(
  deps: InstallerDeps,
  hostId: HostId | null,
  signal: AbortSignal,
  report: (p: InstallProgress) => void
): Promise<void> {
  const poll = deps.idlePollMs ?? 15_000;
  for (;;) {
    if (signal.aborted) throw cancelled();
    const working = await deps.workingAgents(hostId);
    if (working === 0) return;
    if (working === null) {
      // Waiting on something that can't be seen would never end.
      throw new AppError({
        code: "UNSUPPORTED",
        message: "The host's agent activity can't be observed",
        userMessage:
          "This host doesn't report agent activity, so Daintree can't wait for it to be idle.",
      });
    }
    report({
      stage: "waiting-for-idle",
      fraction: null,
      message: `Waiting for ${working} working agent${working === 1 ? "" : "s"} on the host`,
    });
    await deps.sleep(poll, signal);
  }
}

function stopScript(
  platform: "darwin" | "linux",
  hostPid: number | null,
  hasUnit: boolean
): string {
  const name = platform === "darwin" ? "Daintree" : "daintree";
  const unitStop = hasUnit ? `systemctl --user stop ${LINUX_UNIT_NAME} 2>/dev/null; ` : "";
  const signalIt =
    hostPid !== null
      ? `kill -TERM ${hostPid} 2>/dev/null || pkill -TERM -o -x ${name}`
      : `pkill -TERM -o -x ${name}`;
  return `${unitStop}if pgrep -x ${name} >/dev/null 2>&1; then ${signalIt}; fi; i=0; while pgrep -x ${name} >/dev/null 2>&1 && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done; if pgrep -x ${name} >/dev/null 2>&1; then echo "${MARK}stopped no"; else echo "${MARK}stopped yes"; fi`;
}

/** Put the staged build in place, keeping the previous one beside it until the host is back. */
function swapScript(
  plan: HostInstallPlan,
  staged: { dir: string; file: string },
  target: string
): string {
  if (plan.packaging === "app-bundle") {
    const app = remotePath(MAC_APP_PATH);
    const old = remotePath(`${MAC_APP_PATH}.old`);
    return `rm -rf ${old}; if [ -d ${app} ]; then mv ${app} ${old} || exit 1; fi; if mv ${remotePath(`${staged.dir}/x/Daintree.app`)} ${app}; then rm -rf ${remotePath(staged.dir)}; else if [ -d ${old} ]; then mv ${old} ${app}; fi; exit 1; fi`;
  }
  const marker = sq(formatBuildInfo(plan.version, plan.commit));
  const t = remotePath(target);
  const old = remotePath(`${target}.old`);
  const info = remotePath(`${target}${APPIMAGE_BUILD_INFO_SUFFIX}`);
  return `mkdir -p ${remotePath(path.posix.dirname(target))} && rm -f ${old} && if [ -f ${t} ]; then cp -p ${t} ${old}; fi && mv -f ${remotePath(staged.file)} ${t} && chmod 755 ${t} && printf '%s' ${marker} > ${info} && rm -rf ${remotePath(staged.dir)}`;
}

/** Put the previous build back after a failed swap or a host that didn't come back. */
function rollbackScript(plan: HostInstallPlan, target: string): string {
  if (plan.packaging === "app-bundle") {
    const app = remotePath(MAC_APP_PATH);
    const old = remotePath(`${MAC_APP_PATH}.old`);
    return `if [ -d ${old} ]; then rm -rf ${app} && mv ${old} ${app}; fi`;
  }
  const old = remotePath(`${target}.old`);
  return `if [ -f ${old} ]; then mv -f ${old} ${remotePath(target)} && rm -f ${remotePath(`${target}${APPIMAGE_BUILD_INFO_SUFFIX}`)}; fi`;
}

function dropBackupScript(plan: HostInstallPlan, target: string): string {
  return plan.packaging === "app-bundle"
    ? `rm -rf ${remotePath(`${MAC_APP_PATH}.old`)}`
    : `rm -f ${remotePath(`${target}.old`)}`;
}

function startScript(plan: HostInstallPlan, hostMode: boolean, hasUnit: boolean): string | null {
  if (plan.packaging === "app-bundle") {
    return hostMode
      ? `open -g -a ${remotePath(MAC_APP_PATH)} --args --host-mode`
      : `open -g -a ${remotePath(MAC_APP_PATH)}`;
  }
  // Never run the backend from this SSH session: only the user's own unit may start it.
  return hasUnit ? `systemctl --user start ${LINUX_UNIT_NAME}` : null;
}

export async function runHostInstall(
  payload: InstallHostPayload,
  deps: InstallerDeps,
  signal: AbortSignal,
  report: (p: InstallProgress) => void
): Promise<InstallHostResult> {
  const hostId = payload.hostId ?? null;
  report({ stage: "checking", fraction: 0.05, message: "Checking the host" });
  const before = await deps.probe(signal);
  if (signal.aborted) throw cancelled();
  if (!before.parsed) {
    throw new AppError({
      code: "HOST_DISCONNECTED",
      message: `Couldn't reach ${payload.sshTarget}: ${before.result.sshError ?? "ssh failed"}`,
      userMessage: before.result.sshError ?? "Couldn't reach the host over SSH.",
    });
  }
  const probe = before.result;
  const plan = planInstall({ client: deps.client, probe, linuxPackage: payload.linuxPackage });
  if (plan.kind === "up-to-date") return { status: "up-to-date", probe };
  if (plan.kind === "unsupported") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: plan.reason ?? "Can't install",
      userMessage: plan.reason ?? undefined,
    });
  }

  const whileWorking = payload.whileWorking ?? "refuse";
  if (plan.restartsHost && whileWorking === "refuse") {
    const working = await deps.workingAgents(hostId);
    if (working !== 0) return { status: "agents-working", working };
  }

  const staged = await stage(deps, plan, signal, report);
  report({ stage: "verifying", fraction: 0.6, message: "Checking the staged build" });
  await verifyStaged(deps, plan, staged, signal);

  if (plan.packaging === "deb") {
    const after = await deps.probe(signal);
    return {
      status: "needs-user-command",
      command: {
        label: "Install the package on the host",
        command: debInstallCommand(staged.file),
      },
      probe: after.result,
    };
  }

  if (plan.restartsHost) {
    if (whileWorking === "wait-for-idle") await waitForIdle(deps, hostId, signal, report);
    else if (whileWorking === "refuse") {
      // Checked again right before the restart: work may have started while staging.
      const working = await deps.workingAgents(hostId);
      if (working !== 0) {
        await deps.shell
          .exec(`rm -rf ${remotePath(staged.dir)}`, { timeoutMs: 30_000 })
          .catch(() => {});
        return { status: "agents-working", working };
      }
    }
  }
  if (signal.aborted) throw cancelled();

  const platform = probe.platform!;
  const parsed = before.parsed;
  const hasUnit = parsed.advice.hostModeUnit === true;
  const wasHostMode = parsed.hostModeListening;
  const wasRunning = parsed.appRunning || wasHostMode;
  const start = wasRunning ? startScript(plan, wasHostMode, hasUnit) : null;
  if (wasRunning && start === null) {
    await deps.shell
      .exec(`rm -rf ${remotePath(staged.dir)}`, { timeoutMs: 30_000 })
      .catch(() => {});
    throw new AppError({
      code: "UNSUPPORTED",
      message: "No way to restart Daintree on the host",
      userMessage:
        "Daintree is running on the host without its Host mode service, so it couldn't be restarted from here. Quit it there and try again.",
    });
  }
  // An AppImage replaces the one in use in place, so a unit that runs it keeps working.
  let target = MAC_APP_PATH;
  if (plan.packaging === "appimage") {
    target =
      probe.install?.packaging === "appimage"
        ? probe.install.path
        : `${await homeOf(deps, signal)}/Applications/Daintree.AppImage`;
  }
  if (signal.aborted) throw cancelled();

  if (wasRunning) {
    report({ stage: "stopping", fraction: 0.7, message: "Stopping Daintree on the host" });
    const out = await exec(
      deps,
      stopScript(platform, parsed.hostPid, hasUnit),
      signal,
      "Couldn't stop Daintree on the host"
    );
    if (markerValue(out, "stopped") !== "yes") {
      throw failed("Daintree on the host didn't quit, so nothing was replaced");
    }
  }

  // Past this point the host is stopped: finish even if cancelled, so it isn't left down.
  const settle = new AbortController().signal;
  const restartOld = async () => {
    await deps.shell.exec(rollbackScript(plan, target), { timeoutMs: 120_000 }).catch(() => {});
    if (start) await deps.shell.exec(start, { timeoutMs: 30_000 }).catch(() => {});
  };

  report({ stage: "installing", fraction: 0.8, message: "Installing the new build" });
  try {
    await exec(
      deps,
      swapScript(plan, staged, target),
      settle,
      "Couldn't put the new build in place"
    );
    if (start) {
      report({ stage: "restarting", fraction: 0.9, message: "Starting Daintree on the host" });
      await exec(deps, start, settle, "Couldn't start Daintree on the host");
    }
  } catch (err) {
    await restartOld();
    throw err;
  }

  let after = await deps.probe(settle);
  if (wasHostMode) {
    const deadline = (deps.now ?? Date.now)() + (deps.comeBackTimeoutMs ?? 90_000);
    while (!after.result.hostModeListening && (deps.now ?? Date.now)() < deadline) {
      await deps.sleep(2_000, settle);
      after = await deps.probe(settle);
    }
  }
  if (!after.result.reachable) {
    throw failed("The host stopped answering after the install; check it at the machine");
  }
  if (after.result.matchesClient === false) {
    await deps.shell
      .exec(`pkill -TERM -o -x ${platform === "darwin" ? "Daintree" : "daintree"}`, {
        timeoutMs: 30_000,
      })
      .catch(() => {});
    await restartOld();
    throw failed(
      "The host still reported a different build after installing, so the previous one was put back"
    );
  }
  if (wasHostMode && !after.result.hostModeListening) {
    throw failed("Daintree was installed, but Host mode didn't come back on the host");
  }
  await deps.shell.exec(dropBackupScript(plan, target), { timeoutMs: 120_000 }).catch(() => {});
  let reconnected: boolean | null = null;
  if (hostId && deps.reconnect && after.result.hostModeListening) {
    report({ stage: "reconnecting", fraction: 0.95, message: "Reconnecting to the host" });
    reconnected = await deps.reconnect(hostId);
  }
  return { status: "installed", probe: after.result, reconnected };
}

async function homeOf(deps: InstallerDeps, signal: AbortSignal): Promise<string> {
  const out = await exec(
    deps,
    `echo "${MARK}home $HOME"`,
    signal,
    "Couldn't read the host's home folder"
  );
  const home = markerValue(out, "home");
  if (!home || !SAFE_REMOTE_PATH.test(home)) throw failed("The host's home folder isn't usable");
  return home;
}
