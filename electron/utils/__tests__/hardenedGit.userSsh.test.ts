import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _setUserSshCommandForTesting,
  resolveAuthenticatedSshCommand,
  withNonInteractiveSshOptions,
} from "../hardenedGit.js";

const OPTIONS = "-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15";
const DEFAULT = `ssh ${OPTIONS}`;

describe("withNonInteractiveSshOptions", () => {
  it("puts the options straight after the ssh program, ahead of the user's own", () => {
    expect(withNonInteractiveSshOptions("C:/Windows/System32/OpenSSH/ssh.exe")).toBe(
      `C:/Windows/System32/OpenSSH/ssh.exe ${OPTIONS}`
    );
    expect(withNonInteractiveSshOptions("ssh -o BatchMode=no -i ~/.ssh/work")).toBe(
      `ssh ${OPTIONS} -o BatchMode=no -i ~/.ssh/work`
    );
    expect(withNonInteractiveSshOptions('"C:\\Program Files\\OpenSSH\\ssh.exe" -v')).toBe(
      `"C:\\Program Files\\OpenSSH\\ssh.exe" ${OPTIONS} -v`
    );
  });

  it("takes nothing but a direct ssh", () => {
    for (const other of ["plink -batch", "C:/tools/ssh-wrapper.cmd", "", "  "]) {
      expect(withNonInteractiveSshOptions(other)).toBeNull();
    }
  });
});

describe("resolveAuthenticatedSshCommand (real git config)", () => {
  const envKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM"] as const;
  const saved = new Map<string, string | undefined>();
  let home: string;

  beforeAll(() => {
    for (const key of envKeys) saved.set(key, process.env[key]);
  });

  afterEach(() => {
    _setUserSshCommandForTesting(undefined);
    for (const key of envKeys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(() => {
    _setUserSshCommandForTesting(null);
  });

  function useGlobalConfig(contents: string | null): void {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-user-ssh-"));
    if (contents !== null) fs.writeFileSync(path.join(home, ".gitconfig"), contents);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    _setUserSshCommandForTesting(undefined);
  }

  function git(...args: string[]): void {
    execFileSync("git", args, { env: process.env, stdio: "ignore", timeout: 10_000 });
  }

  it("uses the user's global ssh program with the non-interactive options", async () => {
    useGlobalConfig(null);
    git("config", "--global", "core.sshCommand", "C:/Windows/System32/OpenSSH/ssh.exe");
    expect(await resolveAuthenticatedSshCommand()).toBe(
      `C:/Windows/System32/OpenSSH/ssh.exe ${OPTIONS}`
    );
  });

  it("keeps the pinned default when nothing usable is set", async () => {
    useGlobalConfig(null);
    expect(await resolveAuthenticatedSshCommand()).toBe(DEFAULT);

    useGlobalConfig("[core]\n\tsshCommand = plink -batch\n");
    expect(await resolveAuthenticatedSshCommand()).toBe(DEFAULT);
  });

  it("does not follow includes, which can name a file a repository controls", async () => {
    useGlobalConfig(null);
    const included = path.join(home, "included.gitconfig");
    fs.writeFileSync(included, "[core]\n\tsshCommand = ssh -i /from/include\n");
    git("config", "--global", "include.path", included);
    expect(await resolveAuthenticatedSshCommand()).toBe(DEFAULT);
  });
});
