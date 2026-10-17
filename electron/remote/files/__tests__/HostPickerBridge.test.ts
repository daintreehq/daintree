import { describe, expect, it, vi } from "vitest";
import type { FileTransferEvent } from "../../../../shared/types/ipc/fileTransfer.js";
import { HostPickerBridge } from "../HostPickerBridge.js";

function setup(sendOk = true) {
  const gone = new Map<number, () => void>();
  const send = vi.fn((_webContentsId: number, _event: FileTransferEvent) => sendOk);
  const bridge = new HostPickerBridge({
    send,
    watch: (webContentsId, onGone) => {
      gone.set(webContentsId, onGone);
      return () => gone.delete(webContentsId);
    },
  });
  return { bridge, send, gone };
}

const request = { mode: "directory" as const, title: "Open folder" };

describe("HostPickerBridge", () => {
  it("asks the view and resolves with the paths it answers", async () => {
    const { bridge, send } = setup();
    const picked = bridge.pick(7, request);
    const event = send.mock.calls[0]![1] as Extract<
      FileTransferEvent,
      { type: "host-pick-request" }
    >;
    expect(send.mock.calls[0]![0]).toBe(7);
    expect(event).toMatchObject({ type: "host-pick-request", request });
    bridge.answer(7, { requestId: event.requestId, paths: ["/srv/app"] });
    await expect(picked).resolves.toEqual(["/srv/app"]);
    expect(bridge.pendingCount).toBe(0);
  });

  it("only takes the answer from the view that was asked", async () => {
    const { bridge, send } = setup();
    const picked = bridge.pick(7, request);
    const { requestId } = send.mock.calls[0]![1] as Extract<
      FileTransferEvent,
      { type: "host-pick-request" }
    >;
    expect(() => bridge.answer(8, { requestId, paths: ["/etc"] })).toThrow();
    bridge.answer(7, { requestId, paths: null });
    await expect(picked).resolves.toBeNull();
  });

  it("refuses answers that aren't absolute host paths", async () => {
    const { bridge, send } = setup();
    void bridge.pick(7, request);
    const { requestId } = send.mock.calls[0]![1] as Extract<
      FileTransferEvent,
      { type: "host-pick-request" }
    >;
    expect(() => bridge.answer(7, { requestId, paths: ["relative"] })).toThrow();
    expect(() => bridge.answer(7, { requestId, paths: ["/a\0b"] })).toThrow();
    expect(bridge.pendingCount).toBe(1);
  });

  it("resolves as dismissed when the view goes away or can't be reached", async () => {
    const { bridge, gone } = setup();
    const picked = bridge.pick(7, request);
    gone.get(7)!();
    await expect(picked).resolves.toBeNull();
    const unreachable = setup(false);
    await expect(unreachable.bridge.pick(9, request)).resolves.toBeNull();
  });

  it("dismisses everything on dispose", async () => {
    const { bridge } = setup();
    const picks = [bridge.pick(1, request), bridge.pick(2, request)];
    bridge.dispose();
    await expect(Promise.all(picks)).resolves.toEqual([null, null]);
  });
});
