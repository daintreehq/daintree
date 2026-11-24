import { describe, expect, it } from "vitest";
import {
  AGENT_MAX_MESSAGE_BYTES,
  AgentFramingError,
  AgentMessageReader,
  frameAgentMessage,
  isForwardableRequest,
} from "../protocol.js";

const sshString = (text: string) => [0, 0, 0, text.length, ...Buffer.from(text, "latin1")];

describe("AgentMessageReader", () => {
  it("frames a body behind its big-endian length", () => {
    expect([...frameAgentMessage(Uint8Array.of(13, 1, 2))]).toEqual([0, 0, 0, 3, 13, 1, 2]);
  });

  it("rebuilds messages split across reads and splits ones that share a read", () => {
    const reader = new AgentMessageReader();
    const wire = Buffer.from([0, 0, 0, 1, 11, 0, 0, 0, 4, 13, 1, 2, 3]);

    const out: number[][] = [];
    for (const byte of wire) out.push(...reader.push(Uint8Array.of(byte)).map((m) => [...m]));
    out.push(...reader.push(wire).map((m) => [...m]));

    expect(out).toEqual([[11], [13, 1, 2, 3], [11], [13, 1, 2, 3]]);
    expect(reader.pendingBytes).toBe(0);
  });

  it("holds a partial message until the rest arrives", () => {
    const reader = new AgentMessageReader();
    const wire = frameAgentMessage(Uint8Array.of(13, 9, 9));

    expect(reader.push(wire.subarray(0, 5))).toEqual([]);
    expect(reader.pendingBytes).toBe(5);
    expect(reader.push(wire.subarray(5)).map((m) => [...m])).toEqual([[13, 9, 9]]);
  });

  it("refuses a zero length and one past OpenSSH's ceiling before buffering it", () => {
    const header = (length: number) => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(length, 0);
      return bytes;
    };

    expect(() => new AgentMessageReader().push(header(0))).toThrow(AgentFramingError);
    expect(() => new AgentMessageReader().push(header(AGENT_MAX_MESSAGE_BYTES + 1))).toThrow(
      AgentFramingError
    );
    expect(new AgentMessageReader().push(header(AGENT_MAX_MESSAGE_BYTES))).toEqual([]);
  });
});

describe("isForwardableRequest", () => {
  it("forwards listing keys, signing and session-bind", () => {
    expect(isForwardableRequest(Uint8Array.of(11))).toBe(true);
    expect(isForwardableRequest(Uint8Array.of(13, 0, 0, 0, 0))).toBe(true);
    expect(
      isForwardableRequest(Uint8Array.from([27, ...sshString("session-bind@openssh.com"), 1]))
    ).toBe(true);
  });

  it.each([
    ["add identity", 17],
    ["remove identity", 18],
    ["remove all identities", 19],
    ["add smartcard key", 20],
    ["remove smartcard key", 21],
    ["lock", 22],
    ["unlock", 23],
    ["add constrained identity", 25],
    ["add constrained smartcard key", 26],
    ["a protocol 1 request", 1],
    ["an unknown type", 200],
  ])("refuses %s", (_name, type) => {
    expect(isForwardableRequest(Uint8Array.of(type, 0, 0, 0, 0))).toBe(false);
  });

  it("refuses other extensions, near-misses and a name that runs past the body", () => {
    expect(isForwardableRequest(Uint8Array.from([27, ...sshString("query")]))).toBe(false);
    expect(
      isForwardableRequest(Uint8Array.from([27, ...sshString("session-bind@openssh.co")]))
    ).toBe(false);
    expect(isForwardableRequest(Uint8Array.from([27, 0, 0, 0, 40, 115, 101]))).toBe(false);
    // The whole name is there, but its declared length runs one byte past the body.
    const name = [...Buffer.from("session-bind@openssh.com")];
    expect(isForwardableRequest(Uint8Array.from([27, 0, 0, 0, name.length + 1, ...name]))).toBe(
      false
    );
    expect(isForwardableRequest(Uint8Array.of(27, 0, 0))).toBe(false);
  });
});
