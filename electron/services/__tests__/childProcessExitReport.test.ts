import { describe, expect, it } from "vitest";
import {
  FatalErrorNotes,
  buildChildProcessExitEvent,
  buildRendererExitEvent,
  describeFatalError,
  isGpuContextLossExit,
  normalizeExitCode,
  processKind,
} from "../childProcessExitReport.js";

const workspaceHost = (name = "daintree-workspace-host:acme-billing-1a2b3c4d") => ({
  type: "Utility",
  reason: "abnormal-exit",
  exitCode: 1,
  name,
  serviceName: name,
});

describe("processKind", () => {
  it("drops the project-bearing instance from Daintree service names", () => {
    expect(processKind(workspaceHost())).toBe("workspace-host");
    expect(processKind(workspaceHost("daintree-pty-host:acme-9f8e7d6c"))).toBe("pty-host");
    expect(processKind(workspaceHost("daintree-plugin-dev:my-plugin-0011aabb"))).toBe("plugin-dev");
    expect(processKind(workspaceHost("daintree-watchdog"))).toBe("watchdog");
  });

  it("reads serviceName when name is missing", () => {
    expect(
      processKind({
        type: "Utility",
        reason: "abnormal-exit",
        exitCode: 1,
        serviceName: "daintree-workspace-host:acme-1a2b3c4d",
      })
    ).toBe("workspace-host");
  });

  it("keeps Chromium service names and falls back to the process type", () => {
    expect(processKind({ ...workspaceHost(), name: "Network Service" })).toBe("Network Service");
    expect(processKind({ type: "GPU", reason: "abnormal-exit", exitCode: 1 })).toBe("GPU");
    expect(
      processKind({ type: "Utility", reason: "crashed", exitCode: 1, name: "/home/me/acme" })
    ).toBe("Utility");
  });
});

describe("normalizeExitCode", () => {
  it("decodes a POSIX wait status into its exit code", () => {
    expect(normalizeExitCode("abnormal-exit", 8704, "linux")).toBe(34);
    expect(normalizeExitCode("abnormal-exit", 34, "linux")).toBe(34);
  });

  it("leaves codes that are not wait statuses alone", () => {
    expect(normalizeExitCode("abnormal-exit", 8704, "win32")).toBe(8704);
    expect(normalizeExitCode("launch-failed", 8704, "linux")).toBe(8704);
    expect(normalizeExitCode("abnormal-exit", 8705, "linux")).toBe(8705);
    expect(normalizeExitCode("abnormal-exit", -1, "linux")).toBe(-1);
    expect(normalizeExitCode("killed", 15, "linux")).toBe(15);
  });
});

describe("isGpuContextLossExit", () => {
  it("matches GPU exit 34 in either encoding", () => {
    expect(
      isGpuContextLossExit({ type: "GPU", reason: "abnormal-exit", exitCode: 8704 }, "darwin")
    ).toBe(true);
    expect(
      isGpuContextLossExit({ type: "GPU", reason: "abnormal-exit", exitCode: 34 }, "win32")
    ).toBe(true);
    expect(isGpuContextLossExit({ type: "GPU", reason: "crashed", exitCode: 34 }, "linux")).toBe(
      false
    );
    expect(
      isGpuContextLossExit({ type: "Utility", reason: "abnormal-exit", exitCode: 34 }, "linux")
    ).toBe(false);
  });
});

describe("buildChildProcessExitEvent", () => {
  it("separates exits that only differ by their reported cause", () => {
    const timeout = buildChildProcessExitEvent(workspaceHost(), {
      fatalError: "block timeout reached",
      platform: "linux",
    });
    const missing = buildChildProcessExitEvent(workspaceHost(), {
      fatalError: "Cannot use simple-git on a directory that does not exist",
      platform: "linux",
    });
    expect(timeout.fingerprint).not.toEqual(missing.fingerprint);
    expect(timeout.message).toBe(
      "'workspace-host' process exited with 'abnormal-exit' (exit code 1): block timeout reached"
    );
    expect(timeout.tags).toMatchObject({
      "event.process": "Utility",
      "process.kind": "workspace-host",
      "exit.code": "1",
    });
    expect(timeout.extra.fatalError).toBe("block timeout reached");
  });

  it("groups the same cause across projects, paths and ids", () => {
    const a = buildChildProcessExitEvent(workspaceHost(), {
      fatalError:
        "ENOENT: no such file, scandir '/Users/me/acme/.git/worktrees/feature-7f3a9b2c11'",
      platform: "linux",
    });
    const b = buildChildProcessExitEvent(workspaceHost("daintree-workspace-host:zeta-99887766"), {
      fatalError: "ENOENT: no such file, scandir '/home/you/zeta/.git/worktrees/main'",
      platform: "linux",
    });
    expect(a.fingerprint).toEqual(b.fingerprint);
    const serialized = JSON.stringify(a);
    expect(serialized).not.toContain("acme");
    expect(serialized).not.toContain("/Users/me");
  });

  it("groups the same cause across volatile ids outside paths", () => {
    const fingerprint = (id: string) =>
      buildChildProcessExitEvent(workspaceHost(), {
        fatalError: `Terminal ${id} not found`,
        platform: "linux",
      }).fingerprint;
    expect(fingerprint("3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f")).toEqual(
      fingerprint("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d")
    );
  });

  it("puts the decoded exit code in the grouping and keeps the raw one", () => {
    const event = buildChildProcessExitEvent(
      { type: "GPU", reason: "abnormal-exit", exitCode: 8704 },
      { platform: "linux", extra: { crashCount: 2 } }
    );
    expect(event.message).toBe("'GPU' process exited with 'abnormal-exit' (exit code 34)");
    expect(event.fingerprint).toEqual([
      "child-process-gone",
      "GPU",
      "abnormal-exit",
      "34",
      "no-reported-cause",
    ]);
    expect(event.extra).toEqual({ crashCount: 2, rawExitCode: 8704 });
    expect(event.level).toBe("warning");
  });

  it("reports launch failures as fatal", () => {
    expect(buildChildProcessExitEvent({ ...workspaceHost(), reason: "launch-failed" }).level).toBe(
      "fatal"
    );
  });
});

describe("buildRendererExitEvent", () => {
  it("groups by webContents type, reason and code", () => {
    const event = buildRendererExitEvent("abnormal-exit", 1, "window", "darwin");
    expect(event.fingerprint).toEqual(["render-process-gone", "window", "abnormal-exit", "1"]);
    expect(event.tags["process.kind"]).toBe("renderer:window");
  });
});

describe("describeFatalError", () => {
  it("flattens and bounds the text", () => {
    expect(describeFatalError("Error:\n  boom")).toBe("Error: boom");
    expect(describeFatalError("x".repeat(1000)).length).toBeLessThanOrEqual(301);
  });

  it("removes quoted paths with spaces and Windows paths in either slash style", () => {
    expect(describeFatalError("ENOENT: open '/work/Acme Secret/config.json'")).toBe(
      "ENOENT: open '<path>'"
    );
    expect(describeFatalError('spawn "C:\\Users\\Jane Doe\\repo\\git.exe" failed')).toBe(
      'spawn "<path>" failed'
    );
    expect(describeFatalError("cannot read C:/acme/file.txt")).toBe("cannot read <path>");
  });

  it("keeps relative paths and words with slashes", () => {
    expect(describeFatalError("read and/or write src/main.ts failed")).toBe(
      "read and/or write src/main.ts failed"
    );
  });
});

describe("FatalErrorNotes", () => {
  it("hands a note to the first matching exit only", () => {
    const notes = new FatalErrorNotes(() => 0);
    notes.note("daintree-workspace-host:a-1", "boom");
    expect(notes.consume("daintree-workspace-host:b-2")).toBeUndefined();
    expect(notes.consume("daintree-workspace-host:a-1")).toBe("boom");
    expect(notes.consume("daintree-workspace-host:a-1")).toBeUndefined();
  });

  it("ignores a note older than the exit it might explain", () => {
    let now = 0;
    const notes = new FatalErrorNotes(() => now);
    notes.note("host", "stale");
    now = 60_000;
    expect(notes.consume("host")).toBeUndefined();
  });

  it("stays bounded", () => {
    const notes = new FatalErrorNotes(() => 0);
    for (let i = 0; i < 100; i++) notes.note(`host-${i}`, "boom");
    expect(notes.consume("host-0")).toBeUndefined();
    expect(notes.consume("host-99")).toBe("boom");
  });
});
