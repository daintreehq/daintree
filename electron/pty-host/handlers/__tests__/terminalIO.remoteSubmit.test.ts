import { describe, expect, it, vi } from "vitest";
import { createTerminalIOHandlers } from "../terminalIO.js";
import type { HostContext } from "../types.js";

function run(options: {
  terminal?: { launchGeneration: number; wasKilled: boolean; isExited: boolean };
  trashed?: boolean;
}) {
  const submit = vi.fn();
  const sendEvent = vi.fn();
  const handlers = createTerminalIOHandlers({
    ptyManager: {
      getTerminal: vi.fn(() => options.terminal),
      isInTrash: vi.fn(() => options.trashed ?? false),
      submit,
    },
    sendEvent,
  } as unknown as HostContext);
  handlers["submit-acknowledged"]({
    type: "submit-acknowledged",
    id: "panel-1",
    text: "line one\nline two",
    launchGeneration: 4,
    requestId: "request-1",
  });
  return { submit, sendEvent };
}

describe("acknowledged remote PTY submission", () => {
  it("acknowledges exactly one full-text submit only after the live generation accepts it", () => {
    const result = run({ terminal: { launchGeneration: 4, wasKilled: false, isExited: false } });

    expect(result.submit).toHaveBeenCalledOnce();
    expect(result.submit).toHaveBeenCalledWith("panel-1", "line one\nline two");
    expect(result.submit.mock.invocationCallOrder[0]).toBeLessThan(
      result.sendEvent.mock.invocationCallOrder[0]!
    );
    expect(result.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "submit-result", accepted: true, launchGeneration: 4 })
    );
  });

  it.each([
    ["not-found", undefined, false],
    ["generation-changed", { launchGeneration: 3, wasKilled: false, isExited: false }, false],
    ["not-live", { launchGeneration: 4, wasKilled: false, isExited: true }, false],
    ["trashed", { launchGeneration: 4, wasKilled: false, isExited: false }, true],
  ] as const)("rejects %s without terminal input", (reason, terminal, trashed) => {
    const result = run({ terminal, trashed });

    expect(result.submit).not.toHaveBeenCalled();
    expect(result.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "submit-result", accepted: false, reason })
    );
  });
});
