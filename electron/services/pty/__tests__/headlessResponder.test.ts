import { describe, expect, it, vi } from "vitest";
import { installHeadlessResponder, type DataEmitterLike } from "../headlessResponder.js";

describe("installHeadlessResponder", () => {
  it("forwards terminal data to PTY write", () => {
    const terminal: DataEmitterLike = {
      onData: (cb) => {
        cb("\u001b[6n");
        return { dispose: () => {} };
      },
    };

    const writeToPty = vi.fn();
    installHeadlessResponder(terminal, writeToPty);

    expect(writeToPty).toHaveBeenCalledWith("\u001b[6n");
  });

  it("swallows PTY write errors", () => {
    const terminal: DataEmitterLike = {
      onData: (cb) => {
        expect(() => cb("x")).not.toThrow();
        return { dispose: () => {} };
      },
    };

    const writeToPty = vi.fn(() => {
      throw new Error("boom");
    });
    installHeadlessResponder(terminal, writeToPty);
  });
});
