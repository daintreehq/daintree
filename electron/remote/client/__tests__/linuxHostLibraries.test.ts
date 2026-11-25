import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../commandRunner.js";
import { DEB_EXECUTABLE } from "../hostProbe.js";
import {
  checkLinuxStart,
  HOST_PACKAGES_COMMAND,
  HOST_PACKAGES_ROOT_SCRIPT,
  LINUX_HOST_PACKAGES,
  libraryCheckScript,
  parseLibraryCheck,
} from "../linuxHostLibraries.js";
import type { HostCommandChannel } from "../remoteShell.js";

const IMAGE = "/home/node/Applications/Daintree.AppImage";

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
  timedOut: false,
});
const fail = (code: number, stderr = ""): CommandResult => ({
  code,
  stdout: "",
  stderr,
  spawnError: null,
  timedOut: false,
});

function channelAnswering(...answers: CommandResult[]) {
  const scripts: string[] = [];
  const channel: HostCommandChannel = {
    exec: async (script) => {
      scripts.push(script);
      return answers.shift() ?? ok();
    },
    execWithInput: async () => ok(),
    sendFile: async () => ok(),
  };
  return { channel, scripts };
}

describe("parseLibraryCheck", () => {
  it("reads every missing name once, in ldd's order", () => {
    expect(
      parseLibraryCheck("noise\n@@dt:libs missing libnspr4.so libnss3.so libnspr4.so\n")
    ).toEqual({ kind: "missing", libraries: ["libnspr4.so", "libnss3.so"] });
  });

  it("reads a clean run", () => {
    expect(parseLibraryCheck("@@dt:libs ok\n")).toEqual({ kind: "ok" });
  });

  it.each([
    ["no marker", "something else\n"],
    ["an unknown verdict", "@@dt:libs unknown\n"],
    ["missing with no names", "@@dt:libs missing\n"],
    ["a name that isn't a library", "@@dt:libs missing libfoo.so $(reboot)\n"],
    ["a verdict it doesn't know", "@@dt:libs maybe\n"],
  ])("takes %s as no verdict", (_label, stdout) => {
    expect(parseLibraryCheck(stdout)).toEqual({ kind: "unknown" });
  });
});

describe("libraryCheckScript", () => {
  it("reads a deb's binary where it is, unpacking nothing", () => {
    const script = libraryCheckScript({ executable: DEB_EXECUTABLE });
    expect(script).toContain(`b='${DEB_EXECUTABLE}'`);
    expect(script).not.toContain("--appimage-extract");
  });

  it("unpacks an AppImage's binary, its sibling libraries and usr/lib, one pattern per call", () => {
    const script = libraryCheckScript({ executable: "/home/a b/Daintree.AppImage" });
    expect(script).toContain(`image='/home/a b/Daintree.AppImage'`);
    expect(script).toContain(
      `for p in daintree '*.so*' usr/lib; do "$image" --appimage-extract "$p"`
    );
    expect(script).toContain(`LD_LIBRARY_PATH="$t/squashfs-root/usr/lib" ldd "$b"`);
    expect(script).not.toContain("resources");
  });

  it.skipIf(process.platform === "win32")("is one line of sh that parses", () => {
    for (const script of [
      libraryCheckScript({ executable: DEB_EXECUTABLE }),
      libraryCheckScript({ executable: IMAGE }),
      HOST_PACKAGES_ROOT_SCRIPT,
    ]) {
      expect(script).not.toContain("\n");
      expect(spawnSync("/bin/sh", ["-n", "-c", script]).status).toBe(0);
    }
  });
});

describe("the package install", () => {
  it("installs every relation the Host needs, as one apt argument", () => {
    const relations = `'${LINUX_HOST_PACKAGES.join(", ")}'`;
    expect(HOST_PACKAGES_COMMAND).toContain(`satisfy -y --no-install-recommends ${relations}`);
    // Quoted once more inside the root script's own `sh -c`.
    expect(HOST_PACKAGES_ROOT_SCRIPT).toContain("satisfy -y --no-install-recommends");
    expect(HOST_PACKAGES_ROOT_SCRIPT).toContain("libasound2t64 | libasound2");
  });
});

describe("checkLinuxStart", () => {
  const target = { executable: IMAGE, appImageExtractAndRun: true };

  it("lets a start with every library go ahead without installing anything", async () => {
    const installPackages = vi.fn(async () => ok());
    const { channel, scripts } = channelAnswering(ok("@@dt:libs ok\n"));
    await checkLinuxStart({ channel, hostLabel: "box", installPackages }, target);
    expect(scripts).toHaveLength(1);
    expect(installPackages).not.toHaveBeenCalled();
  });

  it.each([
    ["no verdict", ok("@@dt:libs unknown\n")],
    ["a check that didn't run", fail(255, "ssh: connection closed")],
  ])("lets the start go ahead on %s", async (_label, answer) => {
    const installPackages = vi.fn(async () => ok());
    const { channel } = channelAnswering(answer);
    await expect(
      checkLinuxStart({ channel, hostLabel: "box", installPackages }, target)
    ).resolves.toBeUndefined();
    expect(installPackages).not.toHaveBeenCalled();
  });

  it("names every missing library and the root command where nothing can install them", async () => {
    const { channel } = channelAnswering(ok("@@dt:libs missing libnspr4.so libnss3.so\n"));
    const error = await checkLinuxStart(
      { channel, hostLabel: "build-box", installPackages: null },
      target
    ).catch((e: unknown) => e as { userMessage?: string });
    expect(error.userMessage).toContain("build-box");
    expect(error.userMessage).toContain("libnspr4.so, libnss3.so");
    expect(error.userMessage!.endsWith(HOST_PACKAGES_COMMAND)).toBe(true);
    // The names come before the command, so a shortened copy still names them.
    expect(error.userMessage!.indexOf("libnss3.so")).toBeLessThan(
      error.userMessage!.indexOf("apt-get")
    );
  });

  it("installs the packages where it may, then checks again before the start goes ahead", async () => {
    const order: string[] = [];
    const installPackages = vi.fn(async () => {
      order.push("install");
      return ok();
    });
    const answers = [ok("@@dt:libs missing libnspr4.so\n"), ok("@@dt:libs ok\n")];
    const channel: HostCommandChannel = {
      exec: async () => {
        order.push("check");
        return answers.shift()!;
      },
      execWithInput: async () => ok(),
      sendFile: async () => ok(),
    };
    await checkLinuxStart({ channel, hostLabel: "box", installPackages }, target);
    expect(order).toEqual(["check", "install", "check"]);
  });

  it("says what is still missing after an install", async () => {
    const { channel } = channelAnswering(
      ok("@@dt:libs missing libnspr4.so libnss3.so\n"),
      ok("@@dt:libs missing libfoo.so.1\n")
    );
    const error = await checkLinuxStart(
      { channel, hostLabel: "box", installPackages: async () => ok() },
      target
    ).catch((e: unknown) => e as { userMessage?: string });
    expect(error.userMessage).toContain("libfoo.so.1");
    expect(error.userMessage).not.toContain("libnspr4.so");
    expect(error.userMessage).toContain("still missing after Daintree installed");
  });

  it.each([
    [fail(40), "the login wasn't root"],
    [fail(42, "E: Unable to locate package libgbm1"), "apt-get couldn't install them"],
    [fail(255, "root@dtc-x: Permission denied (publickey)."), "Permission denied (publickey)."],
  ])("says why an install as root failed, with the libraries", async (result, said) => {
    const { channel, scripts } = channelAnswering(ok("@@dt:libs missing libnspr4.so\n"));
    const error = await checkLinuxStart(
      { channel, hostLabel: "box", installPackages: async () => result },
      target
    ).catch((e: unknown) => e as { userMessage?: string });
    expect(error.userMessage).toContain("libnspr4.so");
    expect(error.userMessage).toContain(said);
    expect(scripts).toHaveLength(1);
  });

  it("stops as cancelled when the caller gives up during the install", async () => {
    const controller = new AbortController();
    const { channel, scripts } = channelAnswering(ok("@@dt:libs missing libnspr4.so\n"));
    const error = await checkLinuxStart(
      {
        channel,
        hostLabel: "box",
        installPackages: async () => {
          controller.abort();
          return fail(130);
        },
      },
      target,
      controller.signal
    ).catch((e: unknown) => e as { code?: string });
    expect(error.code).toBe("CANCELLED");
    expect(scripts).toHaveLength(1);
  });
});
