import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: {} }));

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("stdio dead-fd guards", () => {
  let stdout: EventEmitter;
  let stderr: EventEmitter;

  beforeEach(() => {
    vi.resetModules();
    // Doubles, so errors go through EventEmitter's own dispatch (a `once`
    // guard would be gone after the first) without touching the real streams.
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as typeof process.stdout);
    vi.spyOn(process, "stderr", "get").mockReturnValue(stderr as typeof process.stderr);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("guards stdout and stderr once, however many callers ask", async () => {
    const early = await import("../earlyEnvironment.js");

    early.installStdioDeadFdGuards();
    early.installStdioDeadFdGuards();

    expect([stdout.listenerCount("error"), stderr.listenerCount("error")]).toEqual([1, 1]);
  });

  it("keeps swallowing dead-fd errors after the first, and rethrows the rest", async () => {
    const early = await import("../earlyEnvironment.js");
    early.installStdioDeadFdGuards();

    for (const stream of [stdout, stderr]) {
      for (const code of ["EPIPE", "EPIPE", "EIO", "EBADF", "ECONNRESET", "EPIPE"]) {
        expect(() => stream.emit("error", errno(code))).not.toThrow();
      }
      expect(() => stream.emit("error", errno("ENOSPC"))).toThrow("ENOSPC");
    }
  });
});
