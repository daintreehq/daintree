import { describe, expect, it } from "vitest";
import { FrameDecoder, Lane, encodeFrame } from "../frames.js";
import {
  BulkKind,
  ControlKind,
  InteractiveKind,
  RpcKind,
  frameToMessage,
  messageToFrame,
} from "../messages.js";
import { parseInboundFrame } from "../schemas.js";

describe("link messages", () => {
  it("round-trips a structured message through frame bytes", () => {
    const frame = messageToFrame({
      lane: Lane.RPC,
      kind: RpcKind.INVOKE,
      body: {
        requestId: 3,
        endpointId: "e1",
        channel: "worktree:get-all",
        args: [{ x: new Uint8Array([1]) }],
      },
    });
    const [decoded] = new FrameDecoder().push(encodeFrame(frame));
    const msg = frameToMessage(decoded!);
    expect(msg.lane).toBe(Lane.RPC);
    expect(msg.kind).toBe(RpcKind.INVOKE);
    expect((msg.body as { channel: string }).channel).toBe("worktree:get-all");
  });

  it("carries bulk chunks as raw payload bytes with their stream id", () => {
    const bytes = new Uint8Array([5, 6, 7]);
    const frame = messageToFrame({
      lane: Lane.BULK,
      kind: BulkKind.TRANSFER_CHUNK,
      body: bytes,
      streamId: 42,
    });
    expect(frame.payload).toBe(bytes);
    const msg = frameToMessage(frame);
    expect(msg).toMatchObject({ kind: BulkKind.TRANSFER_CHUNK, streamId: 42 });
  });

  it("carries an open's openId, and takes an open from a Shell that names none", () => {
    const open = (body: object) =>
      parseInboundFrame(
        messageToFrame({ lane: Lane.CONTROL, kind: ControlKind.ENDPOINT_OPEN, body } as never)
      ).body;
    expect(open({ endpointId: "view-1", projectId: "p", openId: "o1" })).toEqual({
      endpointId: "view-1",
      projectId: "p",
      openId: "o1",
    });
    expect(open({ endpointId: "view-1", projectId: null })).toEqual({
      endpointId: "view-1",
      projectId: null,
    });
  });

  it("lets a host that reads opens without openId take one that names it", () => {
    // Such a host reads OPEN with the shape REBIND still has.
    const frame = messageToFrame({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_REBIND,
      body: { endpointId: "view-1", projectId: "p", openId: "o1" },
    } as never);
    expect(parseInboundFrame(frame).body).toEqual({ endpointId: "view-1", projectId: "p" });
  });

  it("keeps a terminal reset's continuation, and the reset when its continuation is unreadable", () => {
    const reset = (continuation: unknown): unknown =>
      Reflect.get(
        parseInboundFrame(
          messageToFrame({
            lane: Lane.INTERACTIVE,
            kind: InteractiveKind.TERMINAL_RESET,
            body: {
              endpointId: "e1",
              terminalId: "t1",
              incarnation: 1,
              seq: 4,
              snapshot: { data: "S", cols: 80, rows: 24, continuation },
            },
          } as never)
        ).body,
        "snapshot"
      );

    const continuation = { pendingEscapeTail: "\x1b[3", streamOffset: 42 };
    expect(reset(continuation)).toEqual({ data: "S", cols: 80, rows: 24, continuation });
    // A host build that shapes it differently must not end the session over it.
    expect(reset({ pendingEscapeTail: 7, streamOffset: "42" })).toEqual({
      data: "S",
      cols: 80,
      rows: 24,
    });
  });

  it("uses distinct kind codes within each lane", () => {
    for (const kinds of [ControlKind, RpcKind]) {
      const values = Object.values(kinds);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});
