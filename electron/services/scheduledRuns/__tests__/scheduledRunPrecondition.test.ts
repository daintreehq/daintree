import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The test machine's own shell would read its rc files; sh reads none here.
vi.mock("../../pty/terminalShell.js", () => ({
  getDefaultShell: () => "/bin/sh",
  waitForWindowsShell: async () => {},
}));

import {
  _resetSchedulePreconditionsForTest,
  disposeSchedulePreconditions,
  preconditionInvocation,
  runSchedulePrecondition,
} from "../scheduledRunPrecondition.js";

const posix = process.platform !== "win32";
let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-precondition-")));
  _resetSchedulePreconditionsForTest();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir });
const check = (command: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
  runSchedulePrecondition({ command, cwd: dir, env, ...extra });

describe.runIf(posix)("runSchedulePrecondition", () => {
  it("passes on exit 0, run in the schedule's folder", async () => {
    fs.writeFileSync(path.join(dir, "ready"), "");
    await expect(check(`test -f ready && [ "$(pwd -P)" = '${dir}' ]`)).resolves.toBeNull();
  });

  it("skips with any other exit code", async () => {
    await expect(check("exit 3")).resolves.toEqual({
      kind: "precondition",
      exitCode: 3,
      signal: null,
      error: null,
    });
  });

  it("skips with the signal that ended it", async () => {
    await expect(check("kill -TERM $$")).resolves.toMatchObject({
      kind: "precondition",
      signal: os.constants.signals.SIGTERM,
      error: null,
    });
  });

  it("skips one that runs past its time limit, ending its process tree", async () => {
    const marker = path.join(dir, "late");
    const started = Date.now();
    await expect(check(`sleep 5; touch '${marker}'`, { timeoutMs: 200 })).resolves.toEqual({
      kind: "precondition",
      exitCode: null,
      signal: null,
      error: "Timed out after 0 seconds.",
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("skips one that couldn't start, without naming the command", async () => {
    const outcome = await runSchedulePrecondition({
      command: "echo secret-token",
      cwd: path.join(dir, "missing"),
      env,
    });
    expect(outcome).toMatchObject({ kind: "precondition", exitCode: null, signal: null });
    expect(outcome?.error).toEqual(expect.any(String));
    expect(outcome?.error).not.toContain("secret-token");
  });

  it("stops when asked to", async () => {
    const controller = new AbortController();
    const pending = check("sleep 5", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).resolves.toMatchObject({ error: "Stopped before it finished." });
  });

  it("kills what's still running at quit, and starts nothing after", async () => {
    const pending = check("sleep 5");
    await new Promise((resolve) => setTimeout(resolve, 100));
    disposeSchedulePreconditions();
    await expect(pending).resolves.toMatchObject({ kind: "precondition", exitCode: null });
    await expect(check("true")).resolves.toMatchObject({ error: "Daintree was quitting." });
  });
});

describe.runIf(posix)("preconditionInvocation", () => {
  it("runs the command in a login shell for zsh and bash, never an interactive one", () => {
    expect(preconditionInvocation("make check", "/bin/zsh")).toEqual({
      file: "/bin/zsh",
      args: ["-l", "-c", "make check"],
    });
    expect(preconditionInvocation("make check", "/usr/local/bin/bash")).toEqual({
      file: "/usr/local/bin/bash",
      args: ["-l", "-c", "make check"],
    });
  });

  it("hands any other shell the command with -c", () => {
    expect(preconditionInvocation("make check", "/usr/local/bin/fish")).toEqual({
      file: "/usr/local/bin/fish",
      args: ["-c", "make check"],
    });
  });
});
