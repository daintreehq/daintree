import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: {} }));

type ErrorListener = (err: NodeJS.ErrnoException) => void;

const streams = [process.stdout, process.stderr];
let before: ErrorListener[][];

function added(): ErrorListener[][] {
  return streams.map((stream, i) =>
    (stream.listeners("error") as ErrorListener[]).filter((l) => !before[i].includes(l))
  );
}

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("stdio dead-fd guards", () => {
  beforeEach(() => {
    vi.resetModules();
    before = streams.map((stream) => [...(stream.listeners("error") as ErrorListener[])]);
  });

  afterEach(() => {
    added().forEach((listeners, i) => listeners.forEach((l) => streams[i].off("error", l)));
  });

  it("guards stdout and stderr once, however many callers ask", async () => {
    const early = await import("../earlyEnvironment.js");

    early.installStdioDeadFdGuards();
    early.installStdioDeadFdGuards();

    expect(added().map((listeners) => listeners.length)).toEqual([1, 1]);
  });

  it("swallows every dead-fd error, a second EPIPE included, and rethrows the rest", async () => {
    const early = await import("../earlyEnvironment.js");
    early.installStdioDeadFdGuards();

    for (const [guard] of added()) {
      for (const code of ["EPIPE", "EPIPE", "EIO", "EBADF", "ECONNRESET"]) {
        expect(() => guard(errno(code))).not.toThrow();
      }
      expect(() => guard(errno("ENOSPC"))).toThrow("ENOSPC");
    }
  });
});
