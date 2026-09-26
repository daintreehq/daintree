import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import type {
  HostInstallPlan,
  InstallHostPayload,
  InstallHostResult,
} from "../../../shared/types/ipc/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import type { CommandResult, CommandRunner } from "./commandRunner.js";
import {
  APPIMAGE_BUILD_INFO_SUFFIX,
  BUILD_INFO_PATTERN,
  LINUX_UNIT_NAME,
  MAC_APP_PATH,
  formatBuildInfo,
  type ProbeOutcome,
} from "./hostProbe.js";
import { type ClientBuild, debInstallCommand, planInstall } from "./installPlan.js";
import { failureDetail, type HostCommandChannel } from "./remoteShell.js";

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
  shell: HostCommandChannel;
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
  try {
    await deliver(deps, plan, file, signal, report);
  } catch (err) {
    // Nothing is in place yet: the host keeps no half-delivered build.
    await deps.shell.exec(`rm -rf ${remotePath(dir)}`, { timeoutMs: 30_000 }).catch(() => {});
    throw err;
  }
  return { dir, file };
}

/** Get the build to `file` on the host: pushed from here, or fetched there with this machine as the fallback. */
async function deliver(
  deps: InstallerDeps,
  plan: HostInstallPlan,
  file: string,
  signal: AbortSignal,
  report: (p: InstallProgress) => void
): Promise<void> {
  if (plan.delivery === "host-fetch") {
    const url = plan.artifactUrl!;
    if (!SAFE_URL.test(url)) throw failed("The release URL isn't usable", url);
    report({ stage: "downloading", fraction: 0.2, message: "The host is downloading the build" });
    const fetched = await deps.shell.exec(
      `if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o ${remotePath(file)} ${sq(url)}; else wget -q -O ${remotePath(file)} ${sq(url)}; fi`,
      { signal, timeoutMs: 30 * 60_000 }
    );
    if (signal.aborted) throw cancelled();
    if (fetched.code === 0) return;
    // Having curl or wget doesn't mean the host can reach the release feed:
    // this machine fetches the same artifact and copies it over.
    const hostReason = failureDetail(fetched, "download failed");
    await deps.shell.exec(`rm -f ${remotePath(file)}`, { timeoutMs: 30_000 }).catch(() => {});
    report({
      stage: "downloading",
      fraction: 0.25,
      message: "The host couldn't download the build, so this machine is fetching it",
    });
    const local = await downloadHere(deps, plan, signal, hostReason);
    await pushFile(deps, local, file, signal, report, true);
    return;
  }

  if (plan.delivery === "push-bundle") {
    const bundle = deps.client.bundle;
    if (bundle.kind === "app-bundle") {
      await fs.mkdir(deps.cacheDir, { recursive: true, mode: 0o700 });
      report({ stage: "packing", fraction: 0.15, message: "Packing this machine's build" });
      const local = path.join(deps.cacheDir, `Daintree-${plan.version}-${deps.client.arch}.zip`);
      await fs.rm(local, { force: true });
      const packed = await deps.run("ditto", ["-c", "-k", "--keepParent", bundle.path, local], {
        signal,
        timeoutMs: 10 * 60_000,
      });
      if (signal.aborted) throw cancelled();
      if (packed.code !== 0)
        throw failed("Couldn't pack this machine's build", failureDetail(packed, "ditto failed"));
      await pushFile(deps, local, file, signal, report, true);
      return;
    }
    if (bundle.kind === "appimage") {
      // The app's own AppImage is never removed.
      await pushFile(deps, bundle.path, file, signal, report, false);
      return;
    }
    throw failed("This machine has no build to copy");
  }

  report({ stage: "downloading", fraction: 0.2, message: "Downloading the build" });
  const local = await downloadHere(deps, plan, signal, null);
  await pushFile(deps, local, file, signal, report, true);
}

async function downloadHere(
  deps: InstallerDeps,
  plan: HostInstallPlan,
  signal: AbortSignal,
  hostReason: string | null
): Promise<string> {
  await fs.mkdir(deps.cacheDir, { recursive: true, mode: 0o700 });
  const local = path.join(deps.cacheDir, plan.artifactName!);
  try {
    await deps.download(plan.artifactUrl!, local, signal);
  } catch (err) {
    if (signal.aborted) throw cancelled();
    if (hostReason === null) throw err;
    throw failed(
      "Neither the host nor this machine could download the build",
      `on the host: ${hostReason}; here: ${formatErrorMessage(err, "download failed")}`
    );
  }
  if (signal.aborted) throw cancelled();
  return local;
}

async function sha256Of(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Prints the file's sha256 with whichever tool the host has (Linux sha256sum, macOS shasum). */
export function remoteSha256Script(file: string): string {
  const f = remotePath(file);
  return `if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum ${f}); else h=$(shasum -a 256 ${f}); fi && echo "${MARK}sha256 \${h%% *}"`;
}

/**
 * Copy a local file to the host and check the copy's sha256 there against
 * this one's, so a truncated or altered transfer never reaches the swap.
 */
async function pushFile(
  deps: InstallerDeps,
  local: string,
  remote: string,
  signal: AbortSignal,
  report: (p: InstallProgress) => void,
  removeLocal: boolean
): Promise<void> {
  try {
    const expected = await sha256Of(local);
    report({ stage: "copying", fraction: 0.45, message: "Copying the build to the host" });
    const copied = await deps.shell.sendFile(local, remote, { signal, timeoutMs: 30 * 60_000 });
    if (signal.aborted) throw cancelled();
    if (copied.code !== 0)
      throw failed("Couldn't copy the build to the host", failureDetail(copied, "copy failed"));
    const out = await exec(
      deps,
      remoteSha256Script(remote),
      signal,
      "Couldn't check the copy on the host",
      10 * 60_000
    );
    const actual = markerValue(out, "sha256");
    if (actual !== expected) {
      throw failed(
        "The copy on the host doesn't match this machine's (sha256), so it wasn't used",
        actual ?? "unreadable"
      );
    }
  } finally {
    if (removeLocal) await fs.rm(local, { force: true }).catch(() => {});
  }
}

/**
 * Unpack and check the staged build, so nothing is stopped for a bad
 * download. Returns the build marker read out of the build itself: a build
 * without one can't be told apart from any other and is refused.
 */
async function verifyStaged(
  deps: InstallerDeps,
  plan: HostInstallPlan,
  staged: { dir: string; file: string },
  signal: AbortSignal
): Promise<string | null> {
  const expected = formatBuildInfo(plan.version, plan.commit);
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
    checkMarker(markerValue(out, "buildinfo"), expected);
    return expected;
  }
  if (plan.packaging === "appimage") {
    // The image's own runtime unpacks just the archive (no FUSE needed), so
    // the build is read from what will run rather than from its file name.
    const root = `${staged.dir}/squashfs-root`;
    const out = await exec(
      deps,
      `test -s ${remotePath(staged.file)} || exit 3; chmod 755 ${remotePath(staged.file)} && cd ${remotePath(staged.dir)} && ${remotePath(staged.file)} --appimage-extract resources/app.asar >/dev/null 2>&1; b=$(grep -a -o -m 1 -E ${sq(BUILD_INFO_PATTERN)} ${remotePath(`${root}/resources/app.asar`)} 2>/dev/null | head -n 1); rm -rf ${remotePath(root)}; echo "${MARK}buildinfo $b"`,
      signal,
      "The staged build is missing on the host",
      5 * 60_000
    );
    const marker = markerValue(out, "buildinfo");
    checkMarker(marker, expected);
    return marker;
  }
  await exec(
    deps,
    `test -s ${remotePath(staged.file)} && chmod 644 ${remotePath(staged.file)}`,
    signal,
    "The staged build is missing on the host"
  );
  return null;
}

function checkMarker(marker: string | null, expected: string): void {
  if (!marker) {
    throw failed(
      "The staged build carries no build marker, so it can't be confirmed as this machine's build"
    );
  }
  if (marker !== expected) throw failed("The staged build isn't the expected commit", marker);
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
  target: string,
  marker: string | null
): string {
  if (plan.packaging === "app-bundle") {
    const app = remotePath(MAC_APP_PATH);
    const old = remotePath(`${MAC_APP_PATH}.old`);
    return `rm -rf ${old}; if [ -d ${app} ]; then mv ${app} ${old} || exit 1; fi; if mv ${remotePath(`${staged.dir}/x/Daintree.app`)} ${app}; then rm -rf ${remotePath(staged.dir)}; else if [ -d ${old} ]; then mv ${old} ${app}; fi; exit 1; fi`;
  }
  const t = remotePath(target);
  const old = remotePath(`${target}.old`);
  const info = remotePath(`${target}${APPIMAGE_BUILD_INFO_SUFFIX}`);
  const infoOld = remotePath(`${target}${APPIMAGE_BUILD_INFO_SUFFIX}.old`);
  // The marker written beside the image is the one read out of it at staging.
  return `mkdir -p ${remotePath(path.posix.dirname(target))} && rm -f ${old} ${infoOld} && if [ -f ${t} ]; then cp -p ${t} ${old}; fi && if [ -f ${info} ]; then cp -p ${info} ${infoOld}; fi && mv -f ${remotePath(staged.file)} ${t} && chmod 755 ${t} && printf '%s' ${sq(marker ?? "")} > ${info} && rm -rf ${remotePath(staged.dir)}`;
}

/** Put the previous build (and its marker) back. Says what it did, so a restore is never assumed. */
function rollbackScript(plan: HostInstallPlan, target: string): string {
  if (plan.packaging === "app-bundle") {
    const app = remotePath(MAC_APP_PATH);
    const old = remotePath(`${MAC_APP_PATH}.old`);
    return `if [ -d ${old} ]; then if rm -rf ${app} && mv ${old} ${app}; then echo "${MARK}rolledback yes"; else echo "${MARK}rolledback failed"; fi; else echo "${MARK}rolledback none"; fi`;
  }
  const t = remotePath(target);
  const old = remotePath(`${target}.old`);
  const info = remotePath(`${target}${APPIMAGE_BUILD_INFO_SUFFIX}`);
  const infoOld = remotePath(`${target}${APPIMAGE_BUILD_INFO_SUFFIX}.old`);
  return `if [ -f ${old} ]; then if mv -f ${old} ${t}; then if [ -f ${infoOld} ]; then mv -f ${infoOld} ${info}; else rm -f ${info}; fi; echo "${MARK}rolledback yes"; else echo "${MARK}rolledback failed"; fi; else echo "${MARK}rolledback none"; fi`;
}

function dropBackupScript(plan: HostInstallPlan, target: string): string {
  return plan.packaging === "app-bundle"
    ? `rm -rf ${remotePath(`${MAC_APP_PATH}.old`)}`
    : `rm -f ${remotePath(`${target}.old`)} ${remotePath(`${target}${APPIMAGE_BUILD_INFO_SUFFIX}.old`)}`;
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
  const plan = planInstall({
    client: deps.client,
    probe,
    linuxPackage: payload.linuxPackage,
    appImageConflict: before.parsed.appImageConflict,
  });
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
  let marker: string | null;
  try {
    marker = await verifyStaged(deps, plan, staged, signal);
  } catch (err) {
    // A build that didn't check out is never left on the host.
    await deps.shell
      .exec(`rm -rf ${remotePath(staged.dir)}`, { timeoutMs: 30_000 })
      .catch(() => {});
    throw err;
  }

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
  const dropStaged = () =>
    deps.shell.exec(`rm -rf ${remotePath(staged.dir)}`, { timeoutMs: 30_000 }).catch(() => {});
  if (wasRunning && start === null) {
    await dropStaged();
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
  if (signal.aborted) {
    await dropStaged();
    throw cancelled();
  }

  // From the first stop on, every step runs to completion whatever the
  // cancel does, and any failure or cancel goes through `recover`, so the host
  // is never left stopped or half-replaced.
  const settle = new AbortController().signal;
  const now = deps.now ?? Date.now;
  let swapped = false;

  const probeUntilBack = async (): Promise<ProbeOutcome> => {
    let after = await deps.probe(settle);
    if (wasHostMode) {
      const deadline = now() + (deps.comeBackTimeoutMs ?? 90_000);
      while (!after.result.hostModeListening && now() < deadline) {
        await deps.sleep(2_000, settle);
        after = await deps.probe(settle);
      }
    }
    return after;
  };

  const run = (script: string, timeoutMs: number) =>
    deps.shell.exec(script, { signal: settle, timeoutMs }).catch((err: unknown): CommandResult => ({
      code: null,
      stdout: "",
      stderr: formatErrorMessage(err, "ssh failed"),
      spawnError: null,
      timedOut: false,
    }));

  type Recovery = "unchanged" | "restarted" | "restored" | "no-previous" | "not-restored";

  /** Stop whatever the swap started, put the previous build back, start it, and check it. */
  const recover = async (): Promise<Recovery> => {
    let previous = true;
    if (swapped) {
      if (wasRunning) await run(stopScript(platform, null, hasUnit), 120_000);
      const rolled = await run(rollbackScript(plan, target), 120_000);
      const state = rolled.code === 0 ? markerValue(rolled.stdout, "rolledback") : null;
      if (state !== "yes" && state !== "none") return "not-restored";
      previous = state === "yes";
    } else {
      await dropStaged();
    }
    if (!wasRunning && !swapped) return "unchanged";
    if (!wasRunning && !previous) return "no-previous";
    if (wasRunning) {
      const started = await run(start!, 30_000);
      if (started.code !== 0) return "not-restored";
    }
    const back = await probeUntilBack();
    const running =
      !wasRunning || (wasHostMode ? back.result.hostModeListening : back.result.appRunning);
    const sameBuild =
      back.result.install?.version === probe.install?.version &&
      back.result.install?.commit === probe.install?.commit;
    if (!back.result.reachable || !running || !sameBuild) return "not-restored";
    return swapped ? "restored" : "restarted";
  };

  const RECOVERY_NOTE: Record<Exclude<Recovery, "unchanged">, string> = {
    restarted: "Daintree was started again on the host.",
    restored: wasRunning
      ? "The previous build was put back and is running again."
      : "The previous build was put back.",
    "no-previous": "There was no previous build to put back.",
    "not-restored": "Daintree couldn't be restored on the host; check it at the machine.",
  };

  const withRecovery = async (err: unknown): Promise<never> => {
    const outcome = await recover();
    const base =
      err instanceof AppError
        ? err
        : failed("The install failed", formatErrorMessage(err, "unknown error"));
    if (outcome === "unchanged") throw base;
    const note = RECOVERY_NOTE[outcome];
    throw new AppError({
      code: base.code,
      message: `${base.message}. ${note}`,
      userMessage: `${base.userMessage ?? base.message}. ${note}`,
    });
  };

  let after: ProbeOutcome;
  try {
    if (wasRunning) {
      report({ stage: "stopping", fraction: 0.7, message: "Stopping Daintree on the host" });
      const out = await exec(
        deps,
        stopScript(platform, parsed.hostPid, hasUnit),
        settle,
        "Couldn't stop Daintree on the host"
      );
      if (markerValue(out, "stopped") !== "yes") {
        throw failed("Daintree on the host didn't quit, so nothing was replaced");
      }
    }
    if (signal.aborted) throw cancelled();

    report({ stage: "installing", fraction: 0.8, message: "Installing the new build" });
    swapped = true;
    await exec(
      deps,
      swapScript(plan, staged, target, marker),
      settle,
      "Couldn't put the new build in place"
    );
    if (signal.aborted) throw cancelled();
    if (start) {
      report({ stage: "restarting", fraction: 0.9, message: "Starting Daintree on the host" });
      await exec(deps, start, settle, "Couldn't start Daintree on the host");
    }

    after = await probeUntilBack();
    if (!after.result.reachable) {
      throw failed("The host stopped answering after the install");
    }
    // The installed build must be read back as exactly this one; a build that
    // can't be read is not taken on trust.
    if (after.result.matchesClient !== true) {
      throw failed(
        after.result.matchesClient === false
          ? "The host still reported a different build after installing"
          : "The installed build couldn't be read back on the host"
      );
    }
    if (wasHostMode && !after.result.hostModeListening) {
      throw failed("Host mode didn't come back on the host after installing");
    }
  } catch (err) {
    return withRecovery(err);
  }

  // The running host is the final word: its handshake names the version and
  // commit it actually runs. The backup stays until that passes.
  let reconnected: boolean | null = null;
  if (hostId && deps.reconnect && after.result.hostModeListening) {
    report({ stage: "reconnecting", fraction: 0.95, message: "Reconnecting to the host" });
    reconnected = await deps.reconnect(hostId).catch(() => null);
    if (reconnected === false) {
      return withRecovery(failed("The running host reported a different build after installing"));
    }
    if (reconnected === null) {
      throw failed(
        "The new build is in place, but the host didn't answer a connection, so the build it runs couldn't be confirmed. The previous build is kept beside it."
      );
    }
  }
  await deps.shell.exec(dropBackupScript(plan, target), { timeoutMs: 120_000 }).catch(() => {});
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
