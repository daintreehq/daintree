import fs from "node:fs/promises";
import path from "node:path";
import { HOST_MODE_FLAG } from "../../boot/hostModeLaunch.js";
import type { CommandRunner } from "./hostCommands.js";

/**
 * Start at login for Host mode: a Daintree-owned LaunchAgent on macOS and a
 * Daintree-owned `systemd --user` unit on Linux. Both launch this same binary
 * with `--host-mode`, which starts the backend windowless. They are written
 * only after the user switches start at login on, and removed when it or Host
 * mode goes off. Nothing here touches any other configuration.
 *
 * macOS uses a LaunchAgent rather than `app.setLoginItemSettings`: login item
 * arguments are Windows-only in Electron and `openAsHidden` is ignored from
 * macOS 13, so a login item can't ask for a windowless Host launch. The agent
 * is limited to the Aqua session so the backend only ever runs inside the
 * logged-in GUI session, never from an SSH login.
 *
 * Removal never unloads a running job (`launchctl bootout`,
 * `systemctl --user stop`): the job may be this very process, and switching
 * Host mode off must not quit the app. Deleting the file and disabling the
 * unit is enough for the next login not to start it.
 */

export type StartAtLoginKind = "launch-agent" | "systemd-user";

export interface StartAtLoginObservation {
  kind: StartAtLoginKind;
  /** Where the Daintree-owned file lives. */
  path: string;
  /** The file exists. */
  installed: boolean;
  /** The file on disk is exactly what this launch would write (same binary, same flags). */
  current: boolean;
  /** `systemctl --user is-enabled` output, or null where it doesn't apply or couldn't be read. */
  unitState: string | null;
  /** `loginctl show-user` Linger value; null where it doesn't apply or couldn't be read. */
  linger: "yes" | "no" | null;
  /** The login name linger applies to. */
  userName: string | null;
}

export interface StartAtLoginController {
  readonly kind: StartAtLoginKind;
  readonly path: string;
  install(): Promise<void>;
  remove(): Promise<void>;
  /** The Daintree-owned file exists; reads nothing but the file. */
  isInstalled(): Promise<boolean>;
  observe(): Promise<StartAtLoginObservation>;
}

export interface HostLaunchTarget {
  /** The binary to run: the AppImage when running from one, else the executable. */
  executable: string;
  /** Dev builds run the Electron binary against an app directory. */
  appPath: string | null;
}

export function hostModeLaunchArguments(target: HostLaunchTarget): string[] {
  return [target.executable, ...(target.appPath ? [target.appPath] : []), HOST_MODE_FLAG];
}

export interface StartAtLoginFs {
  readFile(file: string): Promise<string | null>;
  writeFile(file: string, content: string): Promise<void>;
  remove(file: string): Promise<void>;
}

export const nodeStartAtLoginFs: StartAtLoginFs = {
  async readFile(file) {
    try {
      return await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async writeFile(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
    // Write-then-rename, so a crash never leaves a half-written unit behind.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, content, { mode: 0o644 });
    await fs.rename(tmp, file);
  },
  async remove(file) {
    await fs.rm(file, { force: true });
  },
};

// ---- macOS LaunchAgent ----

export function launchAgentLabel(packaged: boolean): string {
  return packaged ? "org.daintree.app.host" : "org.daintree.app.dev.host";
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildLaunchAgentPlist(input: {
  label: string;
  programArguments: readonly string[];
  bundleId: string;
}): string {
  const args = input.programArguments
    .map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t<string>${xmlEscape(input.label)}</string>`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    args,
    `\t</array>`,
    `\t<key>RunAtLoad</key>`,
    `\t<true/>`,
    `\t<key>LimitLoadToSessionType</key>`,
    `\t<string>Aqua</string>`,
    `\t<key>ProcessType</key>`,
    `\t<string>Interactive</string>`,
    `\t<key>AssociatedBundleIdentifiers</key>`,
    `\t<array>`,
    `\t\t<string>${xmlEscape(input.bundleId)}</string>`,
    `\t</array>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export function createLaunchAgentController(deps: {
  homeDir: string;
  packaged: boolean;
  bundleId: string;
  target: HostLaunchTarget;
  fs?: StartAtLoginFs;
}): StartAtLoginController {
  const files = deps.fs ?? nodeStartAtLoginFs;
  const label = launchAgentLabel(deps.packaged);
  const file = path.posix.join(deps.homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const content = (): string =>
    buildLaunchAgentPlist({
      label,
      programArguments: hostModeLaunchArguments(deps.target),
      bundleId: deps.bundleId,
    });
  return {
    kind: "launch-agent",
    path: file,
    async install() {
      await files.writeFile(file, content());
    },
    async remove() {
      await files.remove(file);
    },
    async isInstalled() {
      return (await files.readFile(file).catch(() => null)) !== null;
    },
    async observe() {
      const onDisk = await files.readFile(file).catch(() => null);
      return {
        kind: "launch-agent",
        path: file,
        installed: onDisk !== null,
        current: onDisk === content(),
        unitState: null,
        linger: null,
        userName: null,
      };
    },
  };
}

// ---- Linux systemd --user ----

export function systemdUnitName(packaged: boolean): string {
  return packaged ? "daintree-host.service" : "daintree-dev-host.service";
}

/**
 * Quote one ExecStart word. systemd expands `%` specifiers and `$` variables
 * inside quotes too, so both are doubled; backslashes and quotes are escaped.
 */
export function systemdQuote(arg: string): string {
  const escaped = arg
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}

export function buildSystemdUnit(input: { programArguments: readonly string[] }): string {
  return [
    `[Unit]`,
    `Description=Daintree host (serves Daintree windows on other machines over SSH)`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${input.programArguments.map(systemdQuote).join(" ")}`,
    // Linger starts the unit before any login, when neither is in the environment.
    `Environment=XDG_RUNTIME_DIR=/run/user/%U`,
    `Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%U/bus`,
    `Restart=on-failure`,
    `RestartSec=10`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

export class StartAtLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartAtLoginError";
  }
}

function describeFailure(
  step: string,
  result: Awaited<ReturnType<CommandRunner>>
): StartAtLoginError {
  if (result.failure === "not-found") {
    return new StartAtLoginError(`systemctl isn't installed, so ${step} couldn't run`);
  }
  if (result.failure === "timeout") return new StartAtLoginError(`${step} timed out`);
  const detail = result.stderr.trim().split("\n")[0] ?? "";
  return new StartAtLoginError(
    `${step} failed${result.code !== null ? ` (exit ${result.code})` : ""}${detail ? `: ${detail}` : ""}`
  );
}

export function parseLinger(stdout: string): "yes" | "no" | null {
  const match = /^Linger=(yes|no)\s*$/m.exec(stdout);
  return match ? (match[1] as "yes" | "no") : null;
}

export function createSystemdUserController(deps: {
  homeDir: string;
  packaged: boolean;
  userName: string;
  target: HostLaunchTarget;
  run: CommandRunner;
  fs?: StartAtLoginFs;
}): StartAtLoginController {
  const files = deps.fs ?? nodeStartAtLoginFs;
  const unit = systemdUnitName(deps.packaged);
  const file = path.posix.join(deps.homeDir, ".config", "systemd", "user", unit);
  const content = (): string =>
    buildSystemdUnit({ programArguments: hostModeLaunchArguments(deps.target) });
  const systemctl = (...args: string[]) => deps.run("systemctl", ["--user", ...args]);

  return {
    kind: "systemd-user",
    path: file,
    async install() {
      await files.writeFile(file, content());
      const reload = await systemctl("daemon-reload");
      if (reload.code !== 0) throw describeFailure("systemctl --user daemon-reload", reload);
      // Enabled, not started: this process already is the host, and a second
      // launch would only hand over to it and exit.
      const enable = await systemctl("enable", unit);
      if (enable.code !== 0) throw describeFailure(`systemctl --user enable ${unit}`, enable);
    },
    async remove() {
      await systemctl("disable", unit);
      await files.remove(file);
      await systemctl("daemon-reload");
    },
    async isInstalled() {
      return (await files.readFile(file).catch(() => null)) !== null;
    },
    async observe() {
      const [onDisk, enabled, linger] = await Promise.all([
        files.readFile(file).catch(() => null),
        systemctl("is-enabled", unit),
        deps.run("loginctl", ["show-user", deps.userName, "-p", "Linger"]),
      ]);
      const unitState = enabled.failure ? null : enabled.stdout.trim().split("\n")[0] || null;
      return {
        kind: "systemd-user",
        path: file,
        installed: onDisk !== null,
        current: onDisk === content(),
        unitState,
        linger: linger.code === 0 ? parseLinger(linger.stdout) : null,
        userName: deps.userName,
      };
    },
  };
}
