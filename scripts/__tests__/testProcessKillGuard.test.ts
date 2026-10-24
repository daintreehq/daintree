import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptProcessForKill,
  formatProcessKillViolations,
  takeProcessKillViolations,
} from "../lib/testProcessKillGuard.js";

// vitest.setup.ts installs the guard; these tests drive the installed one.

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function exitOf(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.signalCode);
  }
  return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

function refusalOf(fn: () => void): NodeJS.ErrnoException | null {
  try {
    fn();
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
  return null;
}

describe("unit-test process.kill guard (#14418)", () => {
  it("refuses a live process this worker did not spawn, and records it", () => {
    // The parent is the vitest runner: alive, and not ours to signal.
    const err = refusalOf(() => process.kill(process.ppid, "SIGCONT"));

    expect(err?.code).toBe("EPERM");
    const violations = takeProcessKillViolations();
    expect(violations).toEqual([expect.objectContaining({ pid: process.ppid, signal: "SIGCONT" })]);
    expect(formatProcessKillViolations(violations)).toContain(`process.kill(${process.ppid}`);
  });

  it("refuses the whole-group and every-process forms", () => {
    expect(refusalOf(() => process.kill(0, "SIGCONT"))?.code).toBe("EPERM");
    expect(refusalOf(() => process.kill(-1, "SIGCONT"))?.code).toBe("EPERM");
    expect(takeProcessKillViolations().map((v) => v.pid)).toEqual([0, -1]);
  });

  it("lets an existence probe through for any pid", () => {
    expect(process.kill(process.ppid, 0)).toBe(true);
    expect(takeProcessKillViolations()).toEqual([]);
  });

  it("passes a pid that no longer exists through to the real ESRCH", () => {
    const err = refusalOf(() => process.kill(99_999_999, "SIGTERM"));

    expect(err?.code).toBe("ESRCH");
    expect(takeProcessKillViolations()).toEqual([]);
  });

  it("signals a child this worker spawned", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    children.push(child);

    expect(process.kill(child.pid!, "SIGKILL")).toBe(true);
    expect(await exitOf(child)).toBe("SIGKILL");
    expect(takeProcessKillViolations()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "signals a grandchild through the process table",
    async () => {
      const child = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      children.push(child);
      const grandchild = await new Promise<number>((resolve) =>
        child.stdout!.once("data", (chunk: Buffer) => resolve(Number.parseInt(String(chunk), 10)))
      );

      expect(process.kill(grandchild, "SIGKILL")).toBe(true);
      await exitOf(child);
      expect(takeProcessKillViolations()).toEqual([]);
    }
  );

  it.skipIf(process.platform === "win32")("signals a detached child's whole group", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      detached: true,
      stdio: "ignore",
    });
    children.push(child);

    expect(process.kill(-child.pid!, "SIGKILL")).toBe(true);
    expect(await exitOf(child)).toBe("SIGKILL");
    expect(takeProcessKillViolations()).toEqual([]);
  });

  it("never lets an adoption widen to the group or broadcast forms", () => {
    adoptProcessForKill(0);
    adoptProcessForKill(-1);

    expect(refusalOf(() => process.kill(0, "SIGCONT"))?.code).toBe("EPERM");
    expect(refusalOf(() => process.kill(-1, "SIGCONT"))?.code).toBe("EPERM");
    expect(takeProcessKillViolations()).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")(
    "refuses an orphan the test created until it is adopted, and only for that test",
    async () => {
      // The shell exits straight away, leaving its sleep reparented to init.
      const shell = spawn("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      shell.stdout!.on("data", (chunk: Buffer) => (out += String(chunk)));
      await new Promise((resolve) => shell.once("close", resolve));
      const orphan = Number.parseInt(out, 10);

      try {
        expect(refusalOf(() => process.kill(orphan, "SIGKILL"))?.code).toBe("EPERM");
        expect(takeProcessKillViolations()).toEqual([expect.objectContaining({ pid: orphan })]);

        adoptProcessForKill(orphan);
        takeProcessKillViolations();
        expect(refusalOf(() => process.kill(orphan, "SIGKILL"))?.code).toBe("EPERM");
        takeProcessKillViolations();

        adoptProcessForKill(orphan);
        expect(process.kill(orphan, "SIGKILL")).toBe(true);
        expect(takeProcessKillViolations()).toEqual([]);
      } finally {
        adoptProcessForKill(orphan);
        try {
          process.kill(orphan, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  );
});
