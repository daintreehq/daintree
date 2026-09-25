import type {
  HostArch,
  HostHandshakeInfo,
  HostPlatform,
} from "../../../shared/types/remoteHosts.js";
import type {
  HostAdvice,
  HostInstallInfo,
  HostProbeResult,
} from "../../../shared/types/ipc/remoteHosts.js";
import {
  HOST_DISCOVERY_NAME,
  HOST_SOCKET_NAME,
  LINUX_RUNTIME_DIR_NAME,
  MAC_APP_DIR_NAME,
} from "../host/hostSocketPath.js";
import type { CommandOptions } from "./commandRunner.js";
import { failureDetail, type RemoteShell } from "./remoteShell.js";

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

const MARK = "@@dt:";

/**
 * An AppImage is compressed, so its build can't be read out of it. An install
 * from here writes the build marker next to it instead.
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
    `if pgrep -x Daintree >/dev/null 2>&1; then echo "${MARK}running yes"; fi`,
    `echo "${MARK}sleep $(pmset -g 2>/dev/null | awk '$1=="sleep"{print $2; exit}')"`,
  ].join("; ");
  const linux = [
    `d=${linuxDir}`,
    `if [ -d ${DEB_INSTALL_DIR} ]; then echo "${MARK}install deb ${DEB_INSTALL_DIR}"`,
    `echo "${MARK}version $(dpkg-query -W -f='\${Version}' daintree 2>/dev/null)"`,
    `${buildInfoRead(`${DEB_INSTALL_DIR}/resources/app.asar`)}; fi`,
    `for f in "$HOME"/Applications/Daintree*.AppImage "$HOME"/Applications/daintree*.AppImage; do if [ -f "$f" ]; then b=""; if [ -f "$f${APPIMAGE_BUILD_INFO_SUFFIX}" ]; then b=$(head -c 512 "$f${APPIMAGE_BUILD_INFO_SUFFIX}"); fi; echo "${MARK}appimage $f"; echo "${MARK}appimageinfo $b"; fi; done`,
    `if pgrep -x daintree >/dev/null 2>&1; then echo "${MARK}running yes"; fi`,
    `echo "${MARK}sleep $(systemctl is-enabled sleep.target 2>/dev/null)"`,
    `if [ -f "$HOME/.config/systemd/user/${LINUX_UNIT_NAME}" ]; then echo "${MARK}unit yes"; else echo "${MARK}unit no"; fi`,
    `echo "${MARK}linger $(loginctl show-user "$(id -un)" -p Linger 2>/dev/null)"`,
    `if pgrep -x gnome-keyring-d >/dev/null 2>&1 || pgrep -x kwalletd5 >/dev/null 2>&1 || pgrep -x kwalletd6 >/dev/null 2>&1; then echo "${MARK}keyring running"; else echo "${MARK}keyring none"; fi`,
  ].join("; ");
  return [
    `echo "${MARK}uname $(uname -sm)"`,
    `case "$(uname -s)" in Darwin) ${mac} ;; Linux) ${linux} ;; *) d=/nonexistent ;; esac`,
    `if [ -f "$d/${HOST_DISCOVERY_NAME}" ] && [ -S "$d/${HOST_SOCKET_NAME}" ]; then echo "${MARK}listening yes"; echo "${MARK}hostpid $(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$d/${HOST_DISCOVERY_NAME}")"; fi`,
    `if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then echo "${MARK}download yes"; fi`,
    `echo "${MARK}end"`,
  ].join("; ");
}

export interface ParsedProbe {
  platform: HostPlatform | null;
  arch: HostArch | null;
  install: HostInstallInfo | null;
  appImages: string[];
  appRunning: boolean;
  hostModeListening: boolean;
  hostPid: number | null;
  canDownload: boolean;
  advice: HostAdvice;
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

  const appImages = (values.get("appimage") ?? []).filter((p) => p.startsWith("/"));
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
  } else if (appImages.length > 0) {
    const newest = [...appImages].sort().at(-1)!;
    const marker = parseBuildInfo(appImageInfo.get(newest) ?? "");
    install = {
      path: newest,
      version: marker?.version ?? versionFromAppImage(newest),
      commit: marker?.commit ?? null,
      packaging: "appimage",
    };
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

  return {
    platform,
    arch,
    install,
    appImages,
    appRunning: one("running") === "yes",
    hostModeListening: one("listening") === "yes",
    hostPid: hostPidText && /^\d{1,10}$/.test(hostPidText) ? Number(hostPidText) : null,
    canDownload: one("download") === "yes",
    advice: {
      sleepObserved,
      sleepDisabled,
      keyring:
        platform === "linux" && keyringText
          ? keyringText === "running"
            ? "running"
            : "not-running"
          : null,
      linger,
      hostModeUnit: platform === "linux" ? one("unit") === "yes" : null,
    },
    complete: values.has("end"),
  };
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
  sshTarget: string;
  shell: RemoteShell;
  client: Pick<HostHandshakeInfo, "version" | "commit">;
  options?: CommandOptions;
}): Promise<ProbeOutcome> {
  const { sshTarget, shell } = params;
  const run = await shell.exec(buildHostProbeScript(), { timeoutMs: 30_000, ...params.options });
  const parsed = run.code === 0 ? parseHostProbe(run.stdout) : null;
  if (!parsed || !parsed.complete || !parsed.platform) {
    return {
      parsed: null,
      result: {
        sshTarget,
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
        },
      },
    };
  }
  return {
    parsed,
    result: {
      sshTarget,
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
      matchesClient: installMatches(parsed.install, params.client),
      advice: parsed.advice,
    },
  };
}
