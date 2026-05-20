import { describe, expect, it, vi } from "vitest";

import { fanoutEventToPorts, type FanoutPort } from "../worktreePortFanout.js";

function makePort(throwOnPost = false): FanoutPort & {
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    postMessage: vi.fn(() => {
      if (throwOnPost) throw new Error("DataCloneError: not serializable");
    }),
    close: vi.fn(),
  };
}

describe("fanoutEventToPorts", () => {
  it("delivers the event to every port when none throw", () => {
    const a = makePort();
    const b = makePort();
    const ports = [a, b];
    const logger = { error: vi.fn() };

    fanoutEventToPorts(ports, { type: "worktree-update", x: 1 }, logger);

    expect(a.postMessage).toHaveBeenCalledWith({
      type: "event",
      event: { type: "worktree-update", x: 1 },
    });
    expect(b.postMessage).toHaveBeenCalledWith({
      type: "event",
      event: { type: "worktree-update", x: 1 },
    });
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(ports).toEqual([a, b]);
  });

  it("removes the failing port AND calls close() so the renderer can recover", () => {
    const good = makePort();
    const bad = makePort(true);
    const ports = [good, bad];
    const logger = { error: vi.fn() };

    fanoutEventToPorts(ports, { type: "worktree-update" }, logger);

    expect(bad.postMessage).toHaveBeenCalledTimes(1);
    expect(bad.close).toHaveBeenCalledTimes(1);
    expect(ports).toEqual([good]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain("postMessage failed, closing port");
  });

  it("still delivers to the remaining ports when one throws (reverse iteration)", () => {
    const earlyBad = makePort(true);
    const middleGood = makePort();
    const lateBad = makePort(true);
    const ports = [earlyBad, middleGood, lateBad];
    const logger = { error: vi.fn() };

    fanoutEventToPorts(ports, { type: "pr-detected" }, logger);

    expect(middleGood.postMessage).toHaveBeenCalledWith({
      type: "event",
      event: { type: "pr-detected" },
    });
    expect(earlyBad.close).toHaveBeenCalledTimes(1);
    expect(lateBad.close).toHaveBeenCalledTimes(1);
    expect(ports).toEqual([middleGood]);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("splices the port before calling close() so a re-entrant close listener finds idx === -1", () => {
    const bad = makePort(true);
    const ports = [bad];
    const observedDuringClose: FanoutPort[][] = [];
    bad.close = vi.fn(() => {
      observedDuringClose.push([...ports]);
    });

    fanoutEventToPorts(ports, { type: "worktree-update" }, { error: vi.fn() });

    expect(observedDuringClose).toEqual([[]]);
    expect(ports).toEqual([]);
  });

  it("swallows errors thrown by close() itself", () => {
    const bad = makePort(true);
    bad.close = vi.fn(() => {
      throw new Error("port already closed");
    });
    const ports = [bad];
    const logger = { error: vi.fn() };

    expect(() => fanoutEventToPorts(ports, { type: "worktree-update" }, logger)).not.toThrow();

    expect(ports).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
