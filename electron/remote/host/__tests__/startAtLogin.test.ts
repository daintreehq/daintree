import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../hostCommands.js";
import { makeTempDir, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import {
  buildLaunchAgentPlist,
  buildSystemdUnit,
  createLaunchAgentController,
  createSystemdUserController,
  hostModeLaunchArguments,
  parseLinger,
  systemdQuote,
} from "../startAtLogin.js";

let home: string;

beforeEach(async () => {
  home = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(home);
});

describe("launch arguments", () => {
  it("launches the packaged binary with --host-mode", () => {
    expect(
      hostModeLaunchArguments({
        executable: "/Applications/Daintree.app/Contents/MacOS/Daintree",
        appPath: null,
      })
    ).toEqual(["/Applications/Daintree.app/Contents/MacOS/Daintree", "--host-mode"]);
  });

  it("passes the app directory to a dev Electron binary", () => {
    expect(
      hostModeLaunchArguments({ executable: "/dev/electron", appPath: "/src/daintree" })
    ).toEqual(["/dev/electron", "/src/daintree", "--host-mode"]);
  });
});

describe("macOS LaunchAgent", () => {
  it("builds an Aqua-only agent that runs Daintree with --host-mode at login", () => {
    expect(
      buildLaunchAgentPlist({
        label: "org.daintree.app.host",
        programArguments: ["/Applications/Daintree.app/Contents/MacOS/Daintree", "--host-mode"],
        bundleId: "org.daintree.app",
      })
    ).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>org.daintree.app.host</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/Applications/Daintree.app/Contents/MacOS/Daintree</string>
\t\t<string>--host-mode</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>LimitLoadToSessionType</key>
\t<string>Aqua</string>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>AssociatedBundleIdentifiers</key>
\t<array>
\t\t<string>org.daintree.app</string>
\t</array>
</dict>
</plist>
`);
  });

  it("escapes XML in paths", () => {
    const plist = buildLaunchAgentPlist({
      label: "l",
      programArguments: ["/Users/a&b/<x>/Daintree"],
      bundleId: "b",
    });
    expect(plist).toContain("<string>/Users/a&amp;b/&lt;x&gt;/Daintree</string>");
  });

  it("writes the agent under ~/Library/LaunchAgents and removes it without unloading", async () => {
    const controller = createLaunchAgentController({
      homeDir: home,
      packaged: true,
      bundleId: "org.daintree.app",
      target: { executable: "/Applications/Daintree.app/Contents/MacOS/Daintree", appPath: null },
    });
    const file = path.join(home, "Library", "LaunchAgents", "org.daintree.app.host.plist");
    expect(controller.path).toBe(file);
    expect(await controller.isInstalled()).toBe(false);

    await controller.install();
    const written = await fs.readFile(file, "utf8");
    expect(written).toContain("<string>--host-mode</string>");
    expect(written).toContain("<string>Aqua</string>");
    expect(((await fs.stat(file)).mode & 0o777).toString(8)).toBe("644");
    expect(await controller.observe()).toMatchObject({
      kind: "launch-agent",
      installed: true,
      current: true,
    });

    await controller.remove();
    expect(await controller.isInstalled()).toBe(false);
  });

  it("notices an agent that launches a different binary", async () => {
    const controller = createLaunchAgentController({
      homeDir: home,
      packaged: false,
      bundleId: "org.daintree.app",
      target: { executable: "/new/Daintree", appPath: null },
    });
    const file = path.join(home, "Library", "LaunchAgents", "org.daintree.app.dev.host.plist");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "old");
    expect(await controller.observe()).toMatchObject({ installed: true, current: false });
  });
});

describe("Linux systemd --user unit", () => {
  it("builds the unit with the runtime dir, the session bus and --host-mode", () => {
    expect(buildSystemdUnit({ programArguments: ["/opt/Daintree/daintree", "--host-mode"] }))
      .toBe(`[Unit]
Description=Daintree host (serves Daintree windows on other machines over SSH)

[Service]
Type=simple
ExecStart="/opt/Daintree/daintree" "--host-mode"
Environment=XDG_RUNTIME_DIR=/run/user/%U
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%U/bus
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`);
  });

  it("quotes paths so specifiers and variables are literal", () => {
    expect(systemdQuote('/home/g "x"/100%/$HOME\\a')).toBe('"/home/g \\"x\\"/100%%/$$HOME\\\\a"');
  });

  it("parses loginctl's Linger property", () => {
    expect(parseLinger("Linger=yes\n")).toBe("yes");
    expect(parseLinger("Linger=no")).toBe("no");
    expect(parseLinger("")).toBeNull();
  });

  it("writes, reloads and enables the unit, and observes it with linger", async () => {
    const calls: string[] = [];
    const run: CommandRunner = async (file, args) => {
      const line = [file, ...args].join(" ");
      calls.push(line);
      if (line.endsWith("is-enabled daintree-host.service")) {
        return { code: 0, stdout: "enabled\n", stderr: "" };
      }
      if (line.startsWith("loginctl")) return { code: 0, stdout: "Linger=yes\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const controller = createSystemdUserController({
      homeDir: home,
      packaged: true,
      userName: "greg",
      target: { executable: "/home/greg/Daintree.AppImage", appPath: null },
      run,
    });
    await controller.install();
    const file = path.join(home, ".config", "systemd", "user", "daintree-host.service");
    expect(await fs.readFile(file, "utf8")).toContain(
      'ExecStart="/home/greg/Daintree.AppImage" "--host-mode"'
    );
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable daintree-host.service",
    ]);

    calls.length = 0;
    expect(await controller.observe()).toEqual({
      kind: "systemd-user",
      path: file,
      installed: true,
      current: true,
      unitState: "enabled",
      linger: "yes",
      userName: "greg",
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        "systemctl --user is-enabled daintree-host.service",
        "loginctl show-user greg -p Linger",
      ])
    );

    calls.length = 0;
    await controller.remove();
    expect(await controller.isInstalled()).toBe(false);
    expect(calls).toEqual([
      "systemctl --user disable daintree-host.service",
      "systemctl --user daemon-reload",
    ]);
  });

  it("fails clearly when systemctl isn't there", async () => {
    const controller = createSystemdUserController({
      homeDir: home,
      packaged: true,
      userName: "greg",
      target: { executable: "/opt/Daintree/daintree", appPath: null },
      run: async () => ({ code: null, stdout: "", stderr: "", failure: "not-found" }),
    });
    await expect(controller.install()).rejects.toThrow(
      "systemctl isn't installed, so systemctl --user daemon-reload couldn't run"
    );
  });
});
