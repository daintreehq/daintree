import { describe, expect, it } from "vitest";
import { FrameProtocolError, Lane, type LinkFrame } from "../frames.js";
import {
  FRAGMENT_MORE,
  MESSAGE_FRAGMENT_BYTES,
  MessageAssembler,
  MessageIds,
  continuesMessage,
  fragmentFrame,
  isMessageFragment,
} from "../messageFragments.js";
import { BulkKind, InteractiveKind, RpcKind } from "../messages.js";

function patterned(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

const whole = (lane: Lane, kind: number, size: number): LinkFrame => ({
  lane,
  kind,
  streamId: 0,
  payload: patterned(size),
});

/** What the peer's frame decoder would hand over: its own copy of each payload. */
const copied = (frame: LinkFrame): LinkFrame => ({ ...frame, payload: frame.payload.slice() });

describe("fragmentFrame", () => {
  it("leaves a message that fits one fragment whole", () => {
    const frame = whole(Lane.RPC, RpcKind.INVOKE_RESULT, MESSAGE_FRAGMENT_BYTES);
    expect(fragmentFrame(frame, 9)).toEqual([frame]);
  });

  it("cuts a larger message into full fragments and a remainder under one id, flagging all but the last", () => {
    const frame = whole(
      Lane.INTERACTIVE,
      InteractiveKind.TERMINAL_RESET,
      2 * MESSAGE_FRAGMENT_BYTES + 5
    );
    const fragments = fragmentFrame(frame, 42);
    expect(fragments.map((f) => f.payload.byteLength)).toEqual([
      MESSAGE_FRAGMENT_BYTES,
      MESSAGE_FRAGMENT_BYTES,
      5,
    ]);
    expect(fragments.map((f) => f.kind)).toEqual([
      InteractiveKind.TERMINAL_RESET | FRAGMENT_MORE,
      InteractiveKind.TERMINAL_RESET | FRAGMENT_MORE,
      InteractiveKind.TERMINAL_RESET,
    ]);
    expect(fragments.every((f) => f.streamId === 42 && f.lane === Lane.INTERACTIVE)).toBe(true);
    expect(fragments.map(isMessageFragment)).toEqual([true, true, true]);
    expect(fragments.map(continuesMessage)).toEqual([true, true, false]);
    const joined = new Uint8Array(frame.payload.byteLength);
    let at = 0;
    for (const f of fragments) {
      joined.set(f.payload, at);
      at += f.payload.byteLength;
    }
    expect(joined).toEqual(frame.payload);
  });

  it("never cuts a raw transfer chunk, whose stream id is its transfer", () => {
    const chunk: LinkFrame = {
      lane: Lane.BULK,
      kind: BulkKind.TRANSFER_CHUNK,
      streamId: 3,
      payload: patterned(MESSAGE_FRAGMENT_BYTES + 1),
    };
    expect(fragmentFrame(chunk, 1)).toEqual([chunk]);
    expect(isMessageFragment(chunk)).toBe(false);
  });

  it("refuses an id the wire can't carry", () => {
    const frame = whole(Lane.RPC, RpcKind.CALL_RESULT, MESSAGE_FRAGMENT_BYTES + 1);
    expect(() => fragmentFrame(frame, 0)).toThrow(FrameProtocolError);
    expect(() => fragmentFrame(frame, 2 ** 32)).toThrow(FrameProtocolError);
  });
});

describe("MessageIds", () => {
  it("hands out nonzero ids and skips zero when it wraps", () => {
    const ids = new MessageIds();
    expect([ids.take(), ids.take()]).toEqual([1, 2]);
    (ids as unknown as { next: number }).next = 0xffffffff;
    expect([ids.take(), ids.take()]).toEqual([0xffffffff, 1]);
  });
});

describe("MessageAssembler", () => {
  const MAX_FRAME = 16 * 1024 * 1024;

  it("hands whole messages straight back", () => {
    const assembler = new MessageAssembler(MAX_FRAME);
    const frame = whole(Lane.EVENTS, 1, 10);
    expect(assembler.push(frame)).toBe(frame);
  });

  it("rebuilds messages byte for byte while whole messages and other lanes interleave", () => {
    const assembler = new MessageAssembler(MAX_FRAME);
    const reset = whole(
      Lane.INTERACTIVE,
      InteractiveKind.TERMINAL_RESET,
      3 * MESSAGE_FRAGMENT_BYTES + 17
    );
    const answer = whole(Lane.RPC, RpcKind.INVOKE_RESULT, 2 * MESSAGE_FRAGMENT_BYTES);
    const echo = whole(Lane.INTERACTIVE, InteractiveKind.TERMINAL_OUT, 12);
    const resetParts = fragmentFrame(reset, 1).map(copied);
    const answerParts = fragmentFrame(answer, 2).map(copied);
    const wire = [
      resetParts[0]!,
      answerParts[0]!,
      echo,
      resetParts[1]!,
      resetParts[2]!,
      answerParts[1]!,
      resetParts[3]!,
    ];
    const out = wire.map((frame) => assembler.push(frame)).filter((f) => f !== null);
    expect(out).toEqual([echo, { ...answer, streamId: 0 }, { ...reset, streamId: 0 }]);
    expect(assembler.partialBytes).toBe(0);
  });

  it("holds only what has arrived of an unfinished message, and lets it go on clear", () => {
    const assembler = new MessageAssembler(MAX_FRAME);
    const parts = fragmentFrame(
      whole(Lane.RPC, RpcKind.CALL_RESULT, 3 * MESSAGE_FRAGMENT_BYTES),
      5
    );
    expect(assembler.push(copied(parts[0]!))).toBeNull();
    expect(assembler.push(copied(parts[1]!))).toBeNull();
    expect(assembler.partialBytes).toBe(2 * MESSAGE_FRAGMENT_BYTES);
    assembler.clear();
    expect(assembler.partialBytes).toBe(0);
    expect(() => assembler.push(copied(parts[2]!))).toThrow(/never begun/);
  });

  describe("ends the session on a fragment that breaks the rules", () => {
    const more = (lane: Lane, kind: number, id: number, size = 4): LinkFrame => ({
      lane,
      kind: kind | FRAGMENT_MORE,
      streamId: id,
      payload: patterned(size),
    });
    const last = (lane: Lane, kind: number, id: number, size = 4): LinkFrame => ({
      lane,
      kind,
      streamId: id,
      payload: patterned(size),
    });

    it.each<[string, LinkFrame[], RegExp]>([
      ["a last fragment with nothing before it", [last(Lane.RPC, 2, 1)], /never begun/],
      [
        "a second message begun in a lane before the first ended",
        [more(Lane.RPC, 2, 1), more(Lane.RPC, 2, 2)],
        /began inside message 1/,
      ],
      ["a kind that changes partway", [more(Lane.RPC, 2, 1), last(Lane.RPC, 7, 1)], /changed kind/],
      ["an empty fragment", [more(Lane.RPC, 2, 1, 0)], /empty/],
      ["a flagged fragment without an id", [more(Lane.RPC, 2, 0)], /without an id/],
      [
        "a fragmented transfer chunk",
        [more(Lane.BULK, BulkKind.TRANSFER_CHUNK, 1)],
        /transfer chunk/,
      ],
    ])("%s", (_name, frames, error) => {
      const assembler = new MessageAssembler(MAX_FRAME);
      expect(() => {
        for (const frame of frames) assembler.push(frame);
      }).toThrow(error);
    });

    it("a message past the frame ceiling, before it is held", () => {
      const assembler = new MessageAssembler(2 * MESSAGE_FRAGMENT_BYTES);
      const parts = fragmentFrame(whole(Lane.EVENTS, 1, 2 * MESSAGE_FRAGMENT_BYTES), 1).map(copied);
      expect(assembler.push(parts[0]!)).toBeNull();
      expect(() => assembler.push(parts[1]!)).toThrow(/more than/);
    });
  });
});
