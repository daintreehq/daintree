import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalIOHandlers } from "../terminalIO.js";
import type { HostContext } from "../types.js";

type WriteOutcome = { ok: true } | { ok: false; error: Error & { code?: string } };

function setup() {
  const live = new Set(["t1", "t2", "t3"]);
  const failing = new Map<string, string>();
  const ptyManager = {
    getTerminal: vi.fn((id: string) =>
      live.has(id) ? { wasKilled: false, isExited: false } : undefined
    ),
    tryWrite: vi.fn((id: string): WriteOutcome => {
      const code = failing.get(id);
      return code ? { ok: false, error: Object.assign(new Error(code), { code }) } : { ok: true };
    }),
  };
  const sendEvent = vi.fn();
  const handler = createTerminalIOHandlers({ ptyManager, sendEvent } as unknown as HostContext)[
    "broadcast-write"
  ]!;
  const write = (reportSuccess?: boolean, ids = ["t1", "t2", "t3"]) =>
    handler({ type: "broadcast-write", ids, data: "a", reportSuccess });
  return { live, failing, ptyManager, sendEvent, write };
}

describe("broadcast-write result reporting", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sends nothing when every target succeeds and successes were not asked for", () => {
    const { sendEvent, ptyManager, write } = setup();
    write();
    write(false);
    expect(ptyManager.tryWrite).toHaveBeenCalledTimes(6);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("reports every success when the renderer asks for them", () => {
    const { sendEvent, write } = setup();
    write(true);
    expect(sendEvent).toHaveBeenCalledWith({
      type: "broadcast-write-result",
      results: [
        { id: "t1", ok: true },
        { id: "t2", ok: true },
        { id: "t3", ok: true },
      ],
    });
  });

  it("reports only the failure when successes were not asked for", () => {
    const { sendEvent, failing, write } = setup();
    failing.set("t2", "EAGAIN");
    write();
    expect(sendEvent).toHaveBeenCalledWith({
      type: "broadcast-write-result",
      results: [{ id: "t2", ok: false, error: { code: "EAGAIN", message: "EAGAIN" } }],
    });
  });

  it("reports a recovered target's next success even when not asked", () => {
    const { sendEvent, failing, write } = setup();
    failing.set("t2", "EAGAIN");
    write();
    failing.clear();
    sendEvent.mockClear();

    // This keystroke left the renderer before the failure landed there.
    write(false);
    expect(sendEvent).toHaveBeenCalledWith({
      type: "broadcast-write-result",
      results: [{ id: "t2", ok: true }],
    });

    sendEvent.mockClear();
    write(false);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("reports transient and permanent failures together without successes", () => {
    const { sendEvent, failing, write } = setup();
    failing.set("t1", "EAGAIN");
    failing.set("t3", "EPIPE");
    write();
    expect(sendEvent).toHaveBeenCalledWith({
      type: "broadcast-write-result",
      results: [
        { id: "t1", ok: false, error: { code: "EAGAIN", message: "EAGAIN" } },
        { id: "t3", ok: false, error: { code: "EPIPE", message: "EPIPE" } },
      ],
    });
  });

  it("forgets a failed target once its terminal is gone", () => {
    const { sendEvent, failing, live, write } = setup();
    failing.set("t2", "EAGAIN");
    write();
    failing.clear();
    live.delete("t2");
    write(false, ["t1", "t3"]);
    // A new terminal reusing the id starts clean: no stale recovery report.
    live.add("t2");
    sendEvent.mockClear();
    write();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("reports an unavailable target as a failure", () => {
    const { sendEvent, live, write } = setup();
    live.delete("t3");
    write();
    expect(sendEvent).toHaveBeenCalledWith({
      type: "broadcast-write-result",
      results: [
        { id: "t3", ok: false, error: { code: "EBADF", message: "terminal not available" } },
      ],
    });
  });
});
