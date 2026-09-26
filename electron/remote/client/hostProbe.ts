import type {
  HostArch,
  HostConnection,
  HostHandshakeInfo,
  HostPlatform,
} from "../../../shared/types/remoteHosts.js";
import type {
  HostAdvice,
  HostInstallInfo,
  HostModeObservation,
  HostProbeResult,
} from "../../../shared/types/ipc/remoteHosts.js";
import { HOST_MODE_STATUS_NAME, parseHostModeStatus } from "../host/hostModeStatusFile.js";
import { launchAgentLabel } from "../host/startAtLogin.js";
import {
  HOST_DISCOVERY_NAME,
  HOST_SOCKET_NAME,
  LINUX_RUNTIME_DIR_NAME,
  MAC_APP_DIR_NAME,
} from "../host/hostSocketPath.js";
import type { CommandOptions } from "./commandRunner.js";
import { failureDetail, type HostCommandChannel } from "./remoteShell.js";

/**
 * Check a machine before adding or updating it: one SSH command (BatchMode,
 * so it never prompts) that reports the platform, the installed Daintree
 * build, whether Host mode is listening, and what bears on running unattended.
 * Output lines carry a marker so a chatty shell startup file can't be mistaken
 * for an answer, and nothing secret is printed (the discovery file's token
 * never leaves the host; only its pid is read).
 */

export const MAC_APP_PATH = "/Applications/Daintree.app";
export const DEB_INSTALL_DIR = "/opt/Daintree";
export const LINUX_UNIT_NAME = "daintree-host.service";
/** The deb's executable: what a unit for a deb install runs. */
export const DEB_EXECUTABLE = `${DEB_INSTALL_DIR}/daintree`;
export const MAC_LAUNCH_AGENT_RELATIVE = `Library/LaunchAgents/${launchAgentLabel(true)}.plist`;

const MARK = "@@dt:";

/**
 * An AppImage is compressed, so grep can't read its build out of it. An
 * install from here extracts the marker from the image itself and writes what
 * it read next to it; the probe trusts that file only while it is newer than
 * the image, so an image replaced by hand afterwards reads as unknown.
 */
export const APPIMAGE_BUILD_INFO_SUFFIX = ".build-info.json";

export function formatBuildInfo(version: string, commit: string): string {
  return JSON.stringify({ daintreeBuildInfo: 1, version, commit });
}

/**
 * The marker file the build packs into the app (see scripts/build-main.mjs).
 * Asar stores files uncompressed, so grep finds it in the archive without
 * the app running. The pattern can't match its own source text (the value
 * classes exclude brackets), so the bundled probe code is never mistaken for
 * the marker. No `{m,n}` bounds: see {@link buildInfoRead}.
 */
export const BUILD_INFO_PATTERN =
  '[{]"daintreeBuildInfo":1,"version":"[0-9A-Za-z.+-][0-9A-Za-z.+-]*","commit":"[0-9a-f][0-9a-f]*"[}]';

function sq(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildInfoRead(asar: string): string {
  // Assigned first: bash 3.2 (macOS /bin/sh) brace-expands inside "$(...)".
  return `b=$(grep -a -o -m 1 -E ${sq(BUILD_INFO_PATTERN)} ${asar} 2>/dev/null | head -n 1); echo "${MARK}buildinfo $b"`;
}

/** One line of `sh` (see remoteShell.ts). Only markers are parsed. */
export function buildHostProbeScript(): string {
  const macDir = `"$HOME/Library/Application Support/${MAC_APP_DIR_NAME}"`;
  const linuxDir = `"/run/user/$(id -u)/${LINUX_RUNTIME_DIR_NAME}"`;
  const mac = [
    `d=${macDir}`,
    `if [ -d ${MAC_APP_PATH} ]; then echo "${MARK}install app-bundle ${MAC_APP_PATH}"`,
    `echo "${MARK}version $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' ${MAC_APP_PATH}/Contents/Info.plist 2>/dev/null)"`,
    `${buildInfoRead(`${MAC_APP_PATH}/Contents/Resources/app.asar`)}; fi`,
    // Only this SSH user's Daintree can take a handoff: another user's is someone else's.
    `if pgrep -u "$(id -u)" -x Daintree >/dev/null 2>&1; then echo "${MARK}running yes"; fi`,
    `echo "${MARK}sleep $(pmset -g 2>/dev/null | awk '$1=="sleep"{print $2; exit}')"`,
    `if [ -f "$HOME/${MAC_LAUNCH_AGENT_RELATIVE}" ]; then echo "${MARK}launchagent yes"; else echo "${MARK}launchagent no"; fi`,
  ].join("; ");
  const linux = [
    `d=${linuxDir}`,
    `if [ -d ${DEB_INSTALL_DIR} ]; then echo "${MARK}install deb ${DEB_INSTALL_DIR}"`,
    `echo "${MARK}version $(dpkg-query -W -f='\${Version}' daintree 2>/dev/null)"`,
    `${buildInfoRead(`${DEB_INSTALL_DIR}/resources/app.asar`)}; fi`,
    // Which AppImage is actually in use: the one the Daintree unit starts, and
    // the one the running process was started from (AppImage runtimes export
    // APPIMAGE). File names say nothing reliable about that.
    `u=""; if [ -f "$HOME/.config/systemd/user/${LINUX_UNIT_NAME}" ]; then u=$(sed -n 's/^ExecStart="\\([^"]*\\)".*/\\1/p' "$HOME/.config/systemd/user/${LINUX_UNIT_NAME}" | head -n 1); echo "${MARK}unitexec $u"; fi`,
    `r=""; p=$(pgrep -u "$(id -u)" -o -x daintree 2>/dev/null); if [ -n "$p" ]; then r=$(tr '\\000' '\\n' < "/proc/$p/environ" 2>/dev/null | sed -n 's/^APPIMAGE=//p' | head -n 1); echo "${MARK}runningappimage $r"; fi`,
    `for f in "$HOME"/Applications/Daintree*.AppImage "$HOME"/Applications/daintree*.AppImage "$u" "$r"; do case "$f" in /*.AppImage) if [ -f "$f" ]; then b=""; i="$f${APPIMAGE_BUILD_INFO_SUFFIX}"; if [ -f "$i" ] && [ "$i" -nt "$f" ]; then b=$(head -c 512 "$i"); fi; echo "${MARK}appimage $f"; echo "${MARK}appimageinfo $b"; fi ;; esac; done`,
    `if pgrep -u "$(id -u)" -x daintree >/dev/null 2>&1; then echo "${MARK}running yes"; fi`,
    `echo "${MARK}sleep $(systemctl is-enabled sleep.target 2>/dev/null)"`,
    `if [ -f "$HOME/.config/systemd/user/${LINUX_UNIT_NAME}" ]; then echo "${MARK}unit yes"; echo "${MARK}unitenabled $(systemctl --user is-enabled ${LINUX_UNIT_NAME} 2>/dev/null)"; else echo "${MARK}unit no"; fi`,
    // What an AppImage needs to mount itself: the device, fusermount and libfuse2.
    `f=no; if [ -e /dev/fuse ] && { command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1; } && { { /sbin/ldconfig -p 2>/dev/null || ldconfig -p 2>/dev/null; } | grep -q 'libfuse[.]so[.]2' || ls /lib/*/libfuse.so.2 /usr/lib/*/libfuse.so.2 /lib64/libfuse.so.2 /usr/lib64/libfuse.so.2 /usr/lib/libfuse.so.2 >/dev/null 2>&1; }; then f=yes; fi; echo "${MARK}fuse $f"`,
    `echo "${MARK}linger $(loginctl show-user "$(id -un)" -p Linger 2>/dev/null)"`,
    // Only this SSH user's processes: another user's keyring is no use here.
    `k=none; for n in gnome-keyring-d kwalletd5 kwalletd6; do if pgrep -u "$(id -u)" -x $n >/dev/null 2>&1; then k=$n; break; fi; done; echo "${MARK}keyring $k"`,
  ].join("; ");
  return [
    `echo "${MARK}uname $(uname -sm)"`,
    `case "$(uname -s)" in Darwin) ${mac} ;; Linux) ${linux} ;; *) d=/nonexistent ;; esac`,
    // Only a live process counts: a crash leaves the socket and both files behind.
    `if [ -f "$d/${HOST_DISCOVERY_NAME}" ] && [ -S "$d/${HOST_SOCKET_NAME}" ]; then p=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$d/${HOST_DISCOVERY_NAME}"); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "${MARK}listening yes"; echo "${MARK}hostpid $p"; fi; fi`,
    `if [ -f "$d/${HOST_MODE_STATUS_NAME}" ]; then printf '%s %s\\n' "${MARK}hostmodestate" "$(head -c 4096 "$d/${HOST_MODE_STATUS_NAME}" | tr -d '\\n')"; fi`,
    `if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then echo "${MARK}download yes"; fi`,
    `echo "${MARK}end"`,
  ].join("; ");
}

export interface ParsedProbe {
  platform: HostPlatform | null;
  arch: HostArch | null;
  install: HostInstallInfo | null;
  appImages: string[];
  /**
   * Set when more than one AppImage could be the one in use and nothing on the
   * host says which; an update then refuses rather than guess.
   */
  appImageConflict: string | null;
  /** The keyring process seen running for the SSH user, if any. */
  keyringProcess: string | null;
  appRunning: boolean;
  hostModeListening: boolean;
  hostPid: number | null;
  canDownload: boolean;
  advice: HostAdvice;
  /** What the host's Daintree last recorded about Host mode (host-mode.json). */
  hostModeState: HostModeObservation | null;
  complete: boolean;
}

function archFromMachine(machine: string): HostArch | null {
  const value = machine.toLowerCase();
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "x86_64" || value === "amd64") return "x64";
  return null;
}

function versionFromAppImage(filePath: string): string | null {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const match =
    /^daintree-(\d[0-9A-Za-z.+-]*?)(?:-(?:x86_64|arm64|aarch64|amd64))?\.AppImage$/i.exec(name);
  return match?.[1] ?? null;
}

function versionParts(version: string): { core: number[]; pre: string | null } {
  const [core = "", ...rest] = version.split("-");
  return {
    core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
    pre: rest.length > 0 ? rest.join("-") : null,
  };
}

/** Semver-ish ordering, so 1.10.0 sorts after 1.9.0 and a release after its prereleases. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre.localeCompare(right.pre, "en", { numeric: true });
}

/** A path as the unit file quotes it (see systemdQuote in host/startAtLogin.ts). */
function systemdUnquote(value: string): string {
  return value.replace(/%%|\$\$|\\\\/g, (m) => (m === "%%" ? "%" : m === "$$" ? "$" : "\\"));
}

function isAppImagePath(value: string | null): value is string {
  return !!value && value.startsWith("/") && value.endsWith(".AppImage");
}

function parseBuildInfo(text: string): { version: string; commit: string } | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as { version?: unknown; commit?: unknown };
    if (typeof raw.version === "string" && typeof raw.commit === "string") {
      return { version: raw.version, commit: raw.commit };
    }
  } catch {
    // Not the marker.
  }
  return null;
}

export function parseHostProbe(stdout: string): ParsedProbe {
  const values = new Map<string, string[]>();
  const appImageInfo = new Map<string, string>();
  let lastAppImage: string | null = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const at = line.indexOf(MARK);
    if (at < 0) continue;
    const body = line.slice(at + MARK.length);
    const space = body.indexOf(" ");
    const key = space < 0 ? body : body.slice(0, space);
    const value = space < 0 ? "" : body.slice(space + 1).trim();
    if (key === "appimage") lastAppImage = value;
    if (key === "appimageinfo") {
      if (lastAppImage && value) appImageInfo.set(lastAppImage, value);
      continue;
    }
    const list = values.get(key) ?? [];
    list.push(value);
    values.set(key, list);
  }
  const one = (key: string) => values.get(key)?.[0] ?? null;

  const [os = "", machine = ""] = (one("uname") ?? "").split(/\s+/);
  const platform: HostPlatform | null =
    os === "Darwin" ? "darwin" : os === "Linux" ? "linux" : null;
  const arch = archFromMachine(machine);

  const appImages = [...new Set((values.get("appimage") ?? []).filter((p) => p.startsWith("/")))];
  const unitExec = one("unitexec");
  const unitImage = unitExec ? systemdUnquote(unitExec) : null;
  const runningImage = one("runningappimage");
  let appImageConflict: string | null = null;
  const installLine = one("install");
  const build = parseBuildInfo(one("buildinfo") ?? "");
  let install: HostInstallInfo | null = null;
  if (installLine) {
    const space = installLine.indexOf(" ");
    const kind = installLine.slice(0, space);
    const installPath = installLine.slice(space + 1);
    const plainVersion = one("version") || null;
    // dpkg versions can carry a Debian revision ("1.2.3-1"); the marker is exact.
    install = {
      path: installPath,
      version: build?.version ?? plainVersion,
      commit: build?.commit ?? null,
      packaging: kind === "app-bundle" ? "app-bundle" : kind === "deb" ? "deb" : "unknown",
    };
  } else {
    const fromUnit = isAppImagePath(unitImage) ? unitImage : null;
    const fromProcess = isAppImagePath(runningImage) ? runningImage : null;
    let active: string | null = fromUnit ?? fromProcess;
    if (fromUnit && fromProcess && fromUnit !== fromProcess) {
      appImageConflict = `The Host mode service starts ${fromUnit}, but Daintree is running from ${fromProcess}.`;
      active = null;
    } else if (!active && appImages.length > 1) {
      appImageConflict = `There are ${appImages.length} Daintree AppImages in ~/Applications and nothing shows which one is used. Keep only one there, then check again.`;
    } else if (!active && appImages.length === 1) {
      active = appImages[0]!;
    }
    const describe = (imagePath: string): HostInstallInfo => {
      const marker = parseBuildInfo(appImageInfo.get(imagePath) ?? "");
      return {
        path: imagePath,
        version: marker?.version ?? versionFromAppImage(imagePath),
        commit: marker?.commit ?? null,
        packaging: "appimage",
      };
    };
    if (active) {
      install = describe(active);
    } else if (appImages.length > 0) {
      // Shown only: an update refuses while the conflict stands.
      install = appImages
        .map(describe)
        .reduce((best, next) =>
          compareVersions(next.version ?? "0", best.version ?? "0") > 0 ? next : best
        );
    }
  }

  const sleepObserved = one("sleep") || null;
  let sleepDisabled: boolean | null = null;
  if (sleepObserved !== null) {
    sleepDisabled =
      platform === "darwin"
        ? sleepObserved === "0"
        : platform === "linux"
          ? sleepObserved === "masked"
          : null;
  }
  const lingerText = one("linger");
  const linger =
    platform === "linux" && lingerText
      ? /(^|=)yes$/i.test(lingerText)
        ? true
        : /(^|=)no$/i.test(lingerText)
          ? false
          : null
      : null;
  const keyringText = one("keyring");
  const hostPidText = one("hostpid");
  const unitPresent = platform === "linux" ? one("unit") === "yes" : null;
  const unitEnabled = one("unitenabled");
  let startAtLoginInstalled: boolean | null = null;
  if (platform === "darwin" && values.has("launchagent")) {
    startAtLoginInstalled = one("launchagent") === "yes";
  } else if (platform === "linux" && values.has("unit")) {
    // `is-enabled` printing nothing means systemctl couldn't be asked.
    startAtLoginInstalled = unitPresent ? (unitEnabled ? unitEnabled === "enabled" : null) : false;
  }
  const fuseText = one("fuse");

  return {
    platform,
    arch,
    install,
    appImages,
    appImageConflict,
    keyringProcess: keyringText && keyringText !== "none" ? keyringText : null,
    appRunning: one("running") === "yes",
    hostModeListening: one("listening") === "yes",
    hostPid: hostPidText && /^\d{1,10}$/.test(hostPidText) ? Number(hostPidText) : null,
    canDownload: one("download") === "yes",
    advice: {
      sleepObserved,
      sleepDisabled,
      keyring:
        platform === "linux" && keyringText
          ? keyringText === "none"
            ? "not-running"
            : "running"
          : null,
      linger,
      hostModeUnit: unitPresent,
      startAtLoginInstalled,
      fuse: platform === "linux" && fuseText ? fuseText === "yes" : null,
    },
    hostModeState: parseHostModeStatus(one("hostmodestate") ?? ""),
    complete: values.has("end"),
  };
}

/**
 * The build a listening host runs, as that same process recorded it in
 * `host-mode.json`; null unless the file's writer is the live listener.
 */
export function runningHostBuild(
  probe: Pick<ParsedProbe, "hostModeListening" | "hostPid" | "hostModeState">
): { version: string; commit: string } | null {
  const state = probe.hostModeState;
  if (!probe.hostModeListening || !state?.build || state.pid !== probe.hostPid) return null;
  return state.build;
}

/**
 * Whether the host runs exactly this client's build. A listening host's own
 * record decides, since that build is the one the link's handshake meets;
 * otherwise what is installed there.
 */
export function hostMatchesClient(
  probe: ParsedProbe,
  client: Pick<HostHandshakeInfo, "version" | "commit">
): boolean | null {
  const running = runningHostBuild(probe);
  if (running) return running.version === client.version && running.commit === client.commit;
  // Which AppImage runs is unknown, so whether it matches is too.
  if (probe.appImageConflict) return null;
  return installMatches(probe.install, client);
}

/** Whether what is installed there is exactly this client's build. */
export function installMatches(
  install: HostInstallInfo | null,
  client: Pick<HostHandshakeInfo, "version" | "commit">
): boolean | null {
  if (!install) return false;
  if (!install.version) return null;
  if (install.version !== client.version) return false;
  if (!install.commit) return null;
  return install.commit === client.commit;
}

export function suggestedCommandsFor(probe: ParsedProbe): HostProbeResult["suggestedCommands"] {
  const out: HostProbeResult["suggestedCommands"] = [];
  if (probe.platform === "darwin" && probe.advice.sleepDisabled === false) {
    out.push({ label: "Keep this Mac awake", command: "sudo pmset -a sleep 0 disksleep 0" });
  }
  if (probe.platform === "linux") {
    if (probe.advice.sleepDisabled === false) {
      out.push({
        label: "Keep this machine awake",
        command:
          "sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target",
      });
    }
    if (probe.advice.linger === false) {
      out.push({
        label: "Let Host mode run without a login session",
        command: "loginctl enable-linger $USER",
      });
    }
  }
  return out;
}

export interface ProbeOutcome {
  result: HostProbeResult;
  parsed: ParsedProbe | null;
}

export async function probeHost(params: {
  connection: HostConnection;
  shell: HostCommandChannel;
  client: Pick<HostHandshakeInfo, "version" | "commit">;
  options?: CommandOptions;
}): Promise<ProbeOutcome> {
  const { connection, shell } = params;
  const run = await shell.exec(buildHostProbeScript(), { timeoutMs: 30_000, ...params.options });
  const parsed = run.code === 0 ? parseHostProbe(run.stdout) : null;
  if (!parsed || !parsed.complete || !parsed.platform) {
    return {
      parsed: null,
      result: {
        connection,
        reachable: false,
        sshError: failureDetail(
          run,
          run.code === 0 ? "The host answered, but not as expected" : "ssh failed"
        ),
        platform: null,
        arch: null,
        install: null,
        hostModeListening: false,
        suggestedCommands: [],
        appRunning: false,
        appImages: [],
        canDownload: false,
        matchesClient: null,
        advice: {
          sleepObserved: null,
          sleepDisabled: null,
          keyring: null,
          linger: null,
          hostModeUnit: null,
          startAtLoginInstalled: null,
          fuse: null,
        },
        hostModeState: null,
      },
    };
  }
  return {
    parsed,
    result: {
      connection,
      reachable: true,
      sshError: null,
      platform: parsed.platform,
      arch: parsed.arch,
      install: parsed.install,
      hostModeListening: parsed.hostModeListening,
      suggestedCommands: suggestedCommandsFor(parsed),
      appRunning: parsed.appRunning || parsed.hostModeListening,
      appImages: parsed.appImages,
      canDownload: parsed.canDownload,
      matchesClient: hostMatchesClient(parsed, params.client),
      advice: parsed.advice,
      hostModeState: parsed.hostModeState,
    },
  };
}
