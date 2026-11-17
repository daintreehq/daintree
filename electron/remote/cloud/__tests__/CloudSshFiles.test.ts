import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../../client/commandRunner.js";
import { CloudSshFiles } from "../CloudSshFiles.js";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const OTHER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyClientKeyClientKeyClientKeyAAAA";
const BINDING = "cb_abcdef12";
const ACCOUNT = "ca_abcdef12";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree cloud-ssh-"));
  vi.stubEnv("DAINTREE_SSH", "/usr/bin/ssh");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function files(): CloudSshFiles {
  const run = vi.fn(async () => ({
    code: 0,
    stdout: "",
    stderr: "",
    spawnError: null,
    timedOut: false,
  }));
  return new CloudSshFiles(root, run as unknown as CommandRunner);
}

describe("CloudSshFiles", () => {
  it("writes a direct machine's config exactly as before, pinned to the provider's key", async () => {
    const route = await files().write(BINDING, ACCOUNT, {
      user: "user",
      endpoint: { host: "203.0.113.10", port: 22001 },
      hostKey: HOST_KEY,
      tunnel: null,
    });
    const dir = path.join(root, "machines", BINDING);
    expect(route).toEqual({
      target: `dtc-${BINDING}`,
      sshPath: path.join(dir, "ssh"),
      configPath: path.join(dir, "config"),
    });
    expect(await fs.readFile(route.configPath, "utf8")).toBe(
      [
        "# Written by Daintree for one cloud machine; rewritten on every start.",
        `Host dtc-${BINDING}`,
        "  HostName 203.0.113.10",
        "  Port 22001",
        "  User user",
        `  HostKeyAlias dtc-${BINDING}`,
        `  UserKnownHostsFile "${path.join(dir, "known_hosts")}"`,
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking yes",
        "  UpdateHostKeys no",
        "  CheckHostIP no",
        `  IdentityFile "${path.join(root, "keys", `${ACCOUNT}_ed25519`)}"`,
        "  IdentitiesOnly yes",
        "  IdentityAgent none",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  ForwardAgent no",
        "  ForwardX11 no",
        "  BatchMode yes",
        "",
      ].join("\n")
    );
    expect(await fs.readFile(path.join(dir, "known_hosts"), "utf8")).toBe(
      `dtc-${BINDING} ${HOST_KEY}\n`
    );
    expect(await fs.readFile(route.sshPath, "utf8")).toBe(
      `#!/bin/sh\nexec '/usr/bin/ssh' -F '${route.configPath}' "$@"\n`
    );
  });

  it("reaches a machine its provider vouches for through the tunnel, pinning nothing", async () => {
    const sshFiles = files();
    const dir = path.join(root, "machines", BINDING);
    // A machine that was pinned before keeps no stale key that could turn forwarding off.
    await sshFiles.write(BINDING, ACCOUNT, {
      user: "user",
      endpoint: { host: "203.0.113.10", port: 22001 },
      hostKey: HOST_KEY,
      tunnel: null,
    });
    const route = await sshFiles.write(BINDING, ACCOUNT, {
      user: "root",
      endpoint: { host: "ab12cd34ef.agent37.app", port: 22 },
      hostKey: null,
      tunnel: { commandPath: "/Users/Jo Smith/.npm-global/bin/agent37", args: ["tunnel", "%h"] },
    });
    expect(await fs.readFile(route.configPath, "utf8")).toBe(
      [
        "# Written by Daintree for one cloud machine; rewritten on every start.",
        `Host dtc-${BINDING}`,
        "  HostName ab12cd34ef.agent37.app",
        "  Port 22",
        "  User root",
        '  ProxyCommand "/Users/Jo Smith/.npm-global/bin/agent37" "tunnel" "%h"',
        "  UserKnownHostsFile /dev/null",
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking no",
        "  UpdateHostKeys no",
        "  CheckHostIP no",
        "  LogLevel ERROR",
        `  IdentityFile "${path.join(root, "keys", `${ACCOUNT}_ed25519`)}"`,
        "  IdentitiesOnly yes",
        "  IdentityAgent none",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  ForwardAgent no",
        "  ForwardX11 no",
        "  BatchMode yes",
        "",
      ].join("\n")
    );
    await expect(fs.access(path.join(dir, "known_hosts"))).rejects.toThrow();
  });

  it("keeps the pin when a tunnel only carries the connection", async () => {
    const direct = {
      user: "user",
      endpoint: { host: "203.0.113.10", port: 22001 },
      hostKey: HOST_KEY,
      tunnel: null,
    };
    const sshFiles = files();
    const directRoute = await sshFiles.write(BINDING, ACCOUNT, direct);
    const directConfig = await fs.readFile(directRoute.configPath, "utf8");
    const route = await sshFiles.write(BINDING, ACCOUNT, {
      ...direct,
      hostKey: OTHER_KEY,
      tunnel: { commandPath: "/opt/bin/acme", args: ["proxy", "%h", "%p"] },
    });
    const lines = (await fs.readFile(route.configPath, "utf8")).split("\n");
    const proxy = '  ProxyCommand "/opt/bin/acme" "proxy" "%h" "%p"';
    expect(lines.filter((line) => line === proxy)).toHaveLength(1);
    expect(lines.filter((line) => line !== proxy)).toEqual(directConfig.split("\n"));
    expect(lines.indexOf(proxy)).toBe(lines.indexOf("  User user") + 1);
    expect(await fs.readFile(path.join(root, "machines", BINDING, "known_hosts"), "utf8")).toBe(
      `dtc-${BINDING} ${OTHER_KEY}\n`
    );
  });

  it("refuses to write anything a provider returned that ssh or a shell could misread", async () => {
    const tunnel = { commandPath: "/opt/bin/acme", args: ["tunnel", "%h"] };
    const unusable = [
      { user: "root", endpoint: { host: "x.example;id", port: 22 }, hostKey: null, tunnel },
      {
        user: "root",
        endpoint: { host: "x.example\nProxyCommand id", port: 22 },
        hostKey: null,
        tunnel,
      },
      {
        user: "root -oProxyCommand=id",
        endpoint: { host: "x.example", port: 22 },
        hostKey: null,
        tunnel,
      },
      { user: "root", endpoint: { host: "x.example", port: 70000 }, hostKey: null, tunnel },
      { user: "root", endpoint: { host: "fe80::1%en0", port: 22 }, hostKey: null, tunnel },
      { user: "root", endpoint: { host: "x.example", port: 22 }, hostKey: "not a key", tunnel },
      { user: "root", endpoint: { host: "x.example", port: 22 }, hostKey: null, tunnel: null },
      {
        user: "root",
        endpoint: { host: "x.example", port: 22 },
        hostKey: null,
        tunnel: { commandPath: "/opt/$(id)/acme", args: ["tunnel"] },
      },
    ];
    for (const access of unusable) {
      await expect(files().write(BINDING, ACCOUNT, access)).rejects.toThrow(
        /Refusing|Tunnel argument/
      );
    }
    await expect(fs.access(path.join(root, "machines", BINDING))).rejects.toThrow();
  });

  it("knows whether the files on disk are what an access would write now", async () => {
    const sshFiles = files();
    const access = {
      user: "root",
      endpoint: { host: "ab12cd34ef.agent37.app", port: 22 },
      hostKey: null,
      tunnel: { commandPath: "/opt/bin/agent37", args: ["tunnel", "%h"] },
    };
    expect(await sshFiles.isCurrent(BINDING, ACCOUNT, access)).toBe(false);
    await sshFiles.write(BINDING, ACCOUNT, access);
    expect(await sshFiles.isCurrent(BINDING, ACCOUNT, access)).toBe(true);
    for (const changed of [
      { ...access, tunnel: { ...access.tunnel, commandPath: "/usr/local/bin/agent37" } },
      { ...access, tunnel: null, hostKey: HOST_KEY },
      { ...access, hostKey: HOST_KEY },
    ]) {
      expect(await sshFiles.isCurrent(BINDING, ACCOUNT, changed)).toBe(false);
    }
    // A key left behind by a pinned write that a cut-short rewrite never removed.
    const knownHosts = path.join(root, "machines", BINDING, "known_hosts");
    await fs.writeFile(knownHosts, "stale\n");
    expect(await sshFiles.isCurrent(BINDING, ACCOUNT, access)).toBe(false);
    // One that can't be read isn't taken for absent.
    await fs.rm(knownHosts);
    await fs.mkdir(knownHosts);
    expect(await sshFiles.isCurrent(BINDING, ACCOUNT, access)).toBe(false);
    await fs.rmdir(knownHosts);
    expect(await sshFiles.isCurrent(BINDING, ACCOUNT, access)).toBe(true);

    const pinned = { ...access, tunnel: null, hostKey: HOST_KEY };
    const route = await sshFiles.write(BINDING, ACCOUNT, pinned);
    expect(await sshFiles.isCurrent(BINDING, ACCOUNT, pinned)).toBe(true);
    await fs.writeFile(knownHosts, `dtc-${BINDING} ${OTHER_KEY}\n`);
    expect(await sshFiles.isCurrent(BINDING, ACCOUNT, pinned)).toBe(false);
    await sshFiles.write(BINDING, ACCOUNT, pinned);
    await fs.writeFile(route.sshPath, '#!/bin/sh\nexec ssh "$@"\n');
    expect(await sshFiles.isCurrent(BINDING, ACCOUNT, pinned)).toBe(false);
  });
});
