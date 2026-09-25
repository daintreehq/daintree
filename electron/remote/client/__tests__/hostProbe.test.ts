import { describe, expect, it } from "vitest";
import type { CommandResult } from "../commandRunner.js";
import {
  BUILD_INFO_PATTERN,
  buildHostProbeScript,
  installMatches,
  parseHostProbe,
  probeHost,
} from "../hostProbe.js";
import type { RemoteShell } from "../remoteShell.js";

const CLIENT = { version: "1.4.0", commit: "abcdef0123456789" };

const MAC_OUTPUT = [
  "Last login: Fri Sep 25 on ttys001", // a chatty shell startup file
  "@@dt:uname Darwin arm64",
  "@@dt:install app-bundle /Applications/Daintree.app",
  "@@dt:version 1.4.0",
  '@@dt:buildinfo {"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123456789"}',
  "@@dt:running yes",
  "@@dt:sleep 1",
  "@@dt:listening yes",
  "@@dt:hostpid 4242",
  "@@dt:download yes",
  "@@dt:end",
].join("\n");

const LINUX_OUTPUT = [
  "@@dt:uname Linux x86_64",
  "@@dt:install deb /opt/Daintree",
  "@@dt:version 1.3.0",
  "@@dt:buildinfo ",
  "@@dt:sleep enabled",
  "@@dt:unit no",
  "@@dt:linger Linger=no",
  "@@dt:keyring none",
  "@@dt:end",
].join("\n");

function shellReturning(result: Partial<CommandResult>): RemoteShell & { scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    exec: async (script) => {
      scripts.push(script);
      return { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false, ...result };
    },
    upload: async () => ({ code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false }),
  };
}

describe("buildHostProbeScript", () => {
  it("is one line of sh that never prints the discovery token", () => {
    const script = buildHostProbeScript();
    expect(script).not.toContain("\n");
    expect(script).not.toMatch(/cat [^|;]*host\.json/);
    expect(script).toContain('"pid"');
    // bash 3.2 (macOS /bin/sh) brace-expands {m,n} inside "$(...)".
    expect(script).not.toMatch(/\{\d+,\d+\}/);
  });

  it("uses a marker pattern that can't match its own source text", () => {
    const re = new RegExp(BUILD_INFO_PATTERN.replace(/\\/g, ""));
    expect(re.test(BUILD_INFO_PATTERN)).toBe(false);
    expect(re.test(buildHostProbeScript())).toBe(false);
    expect(re.test('{"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0"}')).toBe(true);
  });
});

describe("parseHostProbe", () => {
  it("reads a macOS host's platform, build, Host mode and sleep setting", () => {
    const probe = parseHostProbe(MAC_OUTPUT);
    expect(probe).toMatchObject({
      platform: "darwin",
      arch: "arm64",
      install: {
        path: "/Applications/Daintree.app",
        version: "1.4.0",
        commit: "abcdef0123456789",
        packaging: "app-bundle",
      },
      appRunning: true,
      hostModeListening: true,
      hostPid: 4242,
      canDownload: true,
      complete: true,
      advice: { sleepObserved: "1", sleepDisabled: false, keyring: null, linger: null },
    });
  });

  it("reads a Linux deb install without a build marker, linger and keyring", () => {
    const probe = parseHostProbe(LINUX_OUTPUT);
    expect(probe.platform).toBe("linux");
    expect(probe.arch).toBe("x64");
    expect(probe.install).toEqual({
      path: "/opt/Daintree",
      version: "1.3.0",
      commit: null,
      packaging: "deb",
    });
    expect(probe.hostModeListening).toBe(false);
    expect(probe.advice).toEqual({
      sleepObserved: "enabled",
      sleepDisabled: false,
      keyring: "not-running",
      linger: false,
      hostModeUnit: false,
    });
  });

  it("falls back to the newest AppImage, reading the version from its name", () => {
    const probe = parseHostProbe(
      [
        "@@dt:uname Linux aarch64",
        "@@dt:appimage /home/greg/Applications/Daintree-1.2.0-arm64.AppImage",
        "@@dt:appimage /home/greg/Applications/Daintree-1.4.0-arm64.AppImage",
        "@@dt:end",
      ].join("\n")
    );
    expect(probe.arch).toBe("arm64");
    expect(probe.install).toEqual({
      path: "/home/greg/Applications/Daintree-1.4.0-arm64.AppImage",
      version: "1.4.0",
      commit: null,
      packaging: "appimage",
    });
  });

  it("reads an AppImage's build from the marker an install left beside it", () => {
    const probe = parseHostProbe(
      [
        "@@dt:uname Linux x86_64",
        "@@dt:appimage /home/g/Applications/Daintree-1.3.0-x86_64.AppImage",
        '@@dt:appimageinfo {"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123456789"}',
        "@@dt:end",
      ].join("\n")
    );
    expect(probe.install).toMatchObject({ version: "1.4.0", commit: "abcdef0123456789" });
    expect(installMatches(probe.install, CLIENT)).toBe(true);
  });

  it("reports no install when nothing is there", () => {
    const probe = parseHostProbe("@@dt:uname Linux x86_64\n@@dt:end");
    expect(probe.install).toBeNull();
    expect(probe.appRunning).toBe(false);
  });
});

describe("installMatches", () => {
  it("needs the same version and commit, and says when it can't tell", () => {
    const base = { path: "/x", packaging: "deb" as const };
    expect(installMatches(null, CLIENT)).toBe(false);
    expect(installMatches({ ...base, version: "1.4.0", commit: CLIENT.commit }, CLIENT)).toBe(true);
    expect(installMatches({ ...base, version: "1.4.0", commit: "0000000" }, CLIENT)).toBe(false);
    expect(installMatches({ ...base, version: "1.3.0", commit: null }, CLIENT)).toBe(false);
    expect(installMatches({ ...base, version: "1.4.0", commit: null }, CLIENT)).toBeNull();
    expect(installMatches({ ...base, version: null, commit: null }, CLIENT)).toBeNull();
  });
});

describe("probeHost", () => {
  it("reports ssh's own error when the host can't be reached", async () => {
    const shell = shellReturning({
      code: 255,
      stderr: "greg@studio-03: Permission denied (publickey).",
    });
    const { result, parsed } = await probeHost({
      sshTarget: "greg@studio-03",
      shell,
      client: CLIENT,
    });
    expect(parsed).toBeNull();
    expect(result.reachable).toBe(false);
    expect(result.sshError).toContain("Permission denied");
  });

  it("treats output cut short as unreachable rather than a missing install", async () => {
    const shell = shellReturning({ stdout: "@@dt:uname Darwin arm64\n" });
    const { result } = await probeHost({ sshTarget: "studio", shell, client: CLIENT });
    expect(result.reachable).toBe(false);
  });

  it("compares the install with this client and suggests the commands the user runs", async () => {
    const shell = shellReturning({ stdout: LINUX_OUTPUT });
    const { result } = await probeHost({ sshTarget: "bigbox", shell, client: CLIENT });
    expect(result.reachable).toBe(true);
    expect(result.matchesClient).toBe(false);
    expect(result.suggestedCommands.map((c) => c.command)).toEqual([
      "sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target",
      "loginctl enable-linger $USER",
    ]);
  });

  it("counts a host in Host mode as running and matches an identical build", async () => {
    const shell = shellReturning({ stdout: MAC_OUTPUT });
    const { result } = await probeHost({ sshTarget: "studio", shell, client: CLIENT });
    expect(result.matchesClient).toBe(true);
    expect(result.appRunning).toBe(true);
    expect(result.suggestedCommands[0]?.command).toBe("sudo pmset -a sleep 0 disksleep 0");
  });
});
