import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real processes: each "shell" is a stand-in script, so nothing here runs the
// developer's own login profile.

const DELIMITER = "_SHELL_ENV_DELIMITER_";
const TIMEOUT_MS = 1_500;
const KILL_GRACE_MS = 300;

let dir: string;

function standInShell(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "$$" >> "${dir}/${name}.starts"\n${body}\n`, {
    mode: 0o755,
  });
  return file;
}

function starts(shell: string): number[] {
  try {
    return fs.readFileSync(`${shell}.starts`, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const options = { timeoutMs: TIMEOUT_MS, killGraceMs: KILL_GRACE_MS };

describe.skipIf(process.platform === "win32")("readLoginShellEnvironment (real processes)", () => {
  beforeEach(() => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-login-shell-"));
  });

  afterEach(() => {
    for (const shell of fs.readdirSync(dir).filter((f) => f.endsWith(".starts"))) {
      for (const pid of starts(path.join(dir, shell.replace(/\.starts$/, "")))) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs the shell's own -ilc command and parses what env prints", async () => {
    // Hand the -ilc command to bash so the stand-in prints exactly what a
    // login shell would, plus profile noise around the delimiters.
    const shell = standInShell(
      "answers",
      `printf 'motd banner\\n'\n[ "$1" = "-ilc" ] || exit 9\nexec /bin/bash -c "$2"`
    );
    const { readLoginShellEnvironment } = await import("../loginShellEnvironment.js");

    const read = await readLoginShellEnvironment(shell, options);

    expect(read?.namedShell).toBe(shell);
    expect(read?.env.PATH).toBe(process.env.PATH);
    expect(read?.env.DISABLE_AUTO_UPDATE).toBe("true");
    expect(read?.env.ZSH_TMUX_AUTOSTART).toBe("false");
    expect(read?.env).not.toHaveProperty("motd banner");
  });

  it("strips ANSI codes and keeps '=' inside values", async () => {
    const shell = standInShell(
      "colourful",
      `printf '%s' "${DELIMITER}"\nprintf '\\033[1;32mGREETING=a=b\\033[0m\\nPATH=/x/bin\\n'\nprintf '%s' "${DELIMITER}"`
    );
    const { readLoginShellEnvironment } = await import("../loginShellEnvironment.js");

    const read = await readLoginShellEnvironment(shell, options);

    expect(read?.env).toEqual({ GREETING: "a=b", PATH: "/x/bin" });
  });

  it("kills a shell that never exits, and what its profile was blocked on, at the deadline", async () => {
    const shell = standInShell(
      "hangs",
      `/bin/sh -c 'echo "$$" > "${dir}/grandchild"; exec sleep 600'`
    );
    const { readLoginShellEnvironment } = await import("../loginShellEnvironment.js");

    const startedAt = Date.now();
    const read = await readLoginShellEnvironment(shell, options);
    const elapsed = Date.now() - startedAt;

    expect(read).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    const [shellPid] = starts(shell);
    const grandchildPid = readPid(`${dir}/grandchild`);
    expect(shellPid).toBeDefined();
    expect(grandchildPid).toBeDefined();
    expect(await waitFor(() => !isAlive(shellPid!) && !isAlive(grandchildPid!))).toBe(true);
  });

  it("escalates to SIGKILL for a shell that ignores SIGTERM", async () => {
    const shell = standInShell("stubborn", `trap '' TERM\nwhile :; do sleep 0.05; done`);
    const { readLoginShellEnvironment } = await import("../loginShellEnvironment.js");

    expect(await readLoginShellEnvironment(shell, options)).toBeNull();

    const [shellPid] = starts(shell);
    expect(isAlive(shellPid!)).toBe(true);
    expect(await waitFor(() => !isAlive(shellPid!))).toBe(true);
  });

  it("starts no second shell while a timed-out one is still exiting, and one after it has gone", async () => {
    const shell = standInShell("stubborn", `trap '' TERM\nwhile :; do sleep 0.05; done`);
    const { readLoginShellEnvironment } = await import("../loginShellEnvironment.js");

    expect(await readLoginShellEnvironment(shell, options)).toBeNull();
    const [firstPid] = starts(shell);
    expect(isAlive(firstPid!)).toBe(true);

    // Back-to-back refreshes inside the kill grace share the dead read.
    expect(await readLoginShellEnvironment(shell, options)).toBeNull();
    expect(await readLoginShellEnvironment(shell, options)).toBeNull();
    expect(starts(shell)).toHaveLength(1);

    expect(await waitFor(() => !isAlive(firstPid!))).toBe(true);
    // Let the group's SIGKILL land before the read is released.
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    const next = readLoginShellEnvironment(shell, options);
    expect(await waitFor(() => starts(shell).length === 2)).toBe(true);
    expect(await next).toBeNull();
  });

  it("ignores an answer a shell gives once the deadline has passed", async () => {
    const shell = standInShell(
      "late",
      `trap 'printf "%s" "${DELIMITER}"; echo PATH=/late/clobber; printf "%s" "${DELIMITER}"; exit 0' TERM\nwhile :; do sleep 0.05; done`
    );
    const { readLoginShellEnvironment } = await import("../loginShellEnvironment.js");

    expect(await readLoginShellEnvironment(shell, options)).toBeNull();

    const [shellPid] = starts(shell);
    expect(await waitFor(() => !isAlive(shellPid!))).toBe(true);
  });

  it("still answers from a slow profile that finishes inside the budget", async () => {
    const shell = standInShell(
      "slow",
      `sleep 0.25\nprintf '%s' "${DELIMITER}"\necho PATH=/slow/bin\nprintf '%s' "${DELIMITER}"`
    );
    const { readLoginShellEnvironment } = await import("../loginShellEnvironment.js");

    const read = await readLoginShellEnvironment(shell, options);

    expect(read).toEqual({ env: { PATH: "/slow/bin" }, namedShell: shell });
  });
});
