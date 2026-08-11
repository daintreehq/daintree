import { describe, expect, it, vi } from "vitest";
import type { SerializedTerminalSnapshot } from "../../../../shared/types/terminal.js";
import { ConsoleObservationHub } from "../../../services/pty/ConsoleObservationHub.js";
import { createTerminalQueryHandlers } from "../terminalQueries.js";
import type { HostContext } from "../types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("console observation host handler", () => {
  it("installs the sequence watermark before asynchronous terminal serialization", async () => {
    const serialized = deferred<SerializedTerminalSnapshot>();
    const output = vi.fn();
    const hub = new ConsoleObservationHub(output);
    const begin = vi.spyOn(hub, "begin");
    const getSerializedStateAsync = vi.fn(() => serialized.promise);
    const sendEvent = vi.fn();
    const handlers = createTerminalQueryHandlers({
      ptyManager: {
        getTerminal: vi.fn(() => ({ launchGeneration: 4 })),
        getSerializedStateAsync,
      },
      consoleObservationHub: hub,
      sendEvent,
    } as unknown as HostContext);

    handlers["console-observe"]({
      type: "console-observe",
      id: "panel-1",
      observerId: "stream-1",
      launchGeneration: 4,
      requestId: "request-1",
    });

    expect(begin).toHaveBeenCalledWith("panel-1", 4, "stream-1", undefined);
    expect(begin.mock.invocationCallOrder[0]).toBeLessThan(
      getSerializedStateAsync.mock.invocationCallOrder[0]!
    );
    expect(sendEvent).not.toHaveBeenCalled();
    hub.onData("panel-1", 4, "during snapshot");
    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith(
      "panel-1",
      4,
      "stream-1",
      expect.objectContaining({ type: "output", seq: 1 })
    );

    serialized.resolve({ data: "snapshot", cols: 80, rows: 24 });
    await vi.waitFor(() =>
      expect(sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "console-observe-result",
          mode: "snapshot",
          throughSeq: 0,
          state: { data: "snapshot", cols: 80, rows: 24 },
        })
      )
    );
  });
});
