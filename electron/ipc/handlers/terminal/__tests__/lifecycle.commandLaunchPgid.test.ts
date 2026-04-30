import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as pty from "node-pty";

type PgidSnapshot = {
  shellPgid: number;
  foregroundPgid: number;
};

const describePosix = process.platform === "win32" ? describe.skip : describe;
const spawnedPtys: pty.IPty[] = [];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function findTestShell(): string | null {
  for (const candidate of [process.env.SHELL, "/bin/zsh", "/bin/bash", "/usr/bin/bash"]) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readPgidSnapshot(pid: number): PgidSnapshot | null {
  const result = spawnSync("ps", ["-o", "pgid=,tpgid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 750,
  });
  if (result.status !== 0 || result.error) {
    return null;
  }
  const [pgidText, tpgidText] = result.stdout.trim().split(/\s+/);
  const shellPgid = Number.parseInt(pgidText ?? "", 10);
  const foregroundPgid = Number.parseInt(tpgidText ?? "", 10);
  if (!Number.isFinite(shellPgid) || !Number.isFinite(foregroundPgid)) {
    return null;
  }
  return { shellPgid, foregroundPgid };
}

async function waitForForegroundChild(pid: number): Promise<PgidSnapshot | null> {
  const deadline = Date.now() + 4_000;
  let last: PgidSnapshot | null = null;
  while (Date.now() < deadline) {
    last = readPgidSnapshot(pid);
    if (last && last.shellPgid > 0 && last.foregroundPgid > 0) {
      if (last.shellPgid !== last.foregroundPgid) {
        return last;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

describePosix("POSIX command launch foreground process group", () => {
  afterEach(() => {
    while (spawnedPtys.length > 0) {
      const proc = spawnedPtys.pop();
      try {
        proc?.kill();
      } catch {
        // Best-effort cleanup; process groups are also terminated below.
      }
    }
  });

  it("starts command-launch wrappers as interactive shells so the command owns the PTY foreground", async () => {
    const shell = findTestShell();
    if (!shell) {
      throw new Error("No POSIX shell found for command launch foreground-pgid test");
    }

    const shellName = path.basename(shell).toLowerCase();
    const script = `trap : INT\nsleep 5\ntrap - INT\nexec ${shellQuote(shell)} -l`;
    const args =
      shellName.includes("zsh") || shellName.includes("bash")
        ? ["-lic", script]
        : ["-i", "-c", script];
    const proc = pty.spawn(shell, args, {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" },
    });
    spawnedPtys.push(proc);

    const snapshot = await waitForForegroundChild(proc.pid);

    try {
      if (snapshot && snapshot.foregroundPgid > 0) {
        process.kill(-snapshot.foregroundPgid, "SIGTERM");
      }
    } catch {
      // The command may have already exited; the assertion below carries the signal.
    }

    expect(snapshot).toBeTruthy();
    expect(snapshot?.foregroundPgid).not.toBe(snapshot?.shellPgid);
  }, 10_000);
});
