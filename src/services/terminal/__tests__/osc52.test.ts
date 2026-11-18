import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OSC52_GESTURE_WINDOW_MS,
  OSC52_MAX_ENVELOPE_BYTES,
  OSC52_MAX_TEXT_BYTES,
  judgeOsc52Write,
  noteOsc52Gesture,
  parseOsc52,
  sanitizeForNotice,
  summarizeOsc52Text,
} from "../osc52";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("parseOsc52", () => {
  it("decodes a clipboard write", () => {
    expect(parseOsc52(`c;${b64("hello")}`)).toEqual({ kind: "write", text: "hello" });
  });

  it("treats an empty selection list and `s` as the clipboard", () => {
    expect(parseOsc52(`;${b64("a")}`)).toEqual({ kind: "write", text: "a" });
    expect(parseOsc52(`s;${b64("a")}`)).toEqual({ kind: "write", text: "a" });
    expect(parseOsc52(`pc;${b64("a")}`)).toEqual({ kind: "write", text: "a" });
  });

  it("ignores selections with no clipboard in them", () => {
    expect(parseOsc52(`p;${b64("a")}`)).toEqual({ kind: "ignore" });
    expect(parseOsc52(`q07;${b64("a")}`)).toEqual({ kind: "ignore" });
    expect(parseOsc52(`x;${b64("a")}`)).toEqual({ kind: "ignore" });
  });

  it("never answers a read and never clears", () => {
    expect(parseOsc52("c;?")).toEqual({ kind: "ignore" });
    expect(parseOsc52("c;")).toEqual({ kind: "ignore" });
    expect(parseOsc52("c")).toEqual({ kind: "ignore" });
  });

  it("keeps text exactly as sent, multi-byte and BOM included", () => {
    const text = "\uFEFFcafé 🌲\r\nnext";
    expect(parseOsc52(`c;${b64(text)}`)).toEqual({ kind: "write", text });
  });

  it("accepts unpadded base64 and payloads wrapped across lines", () => {
    expect(parseOsc52("c;aGVsbG8")).toEqual({ kind: "write", text: "hello" });
    expect(parseOsc52("c;aGVs\nbG8=")).toEqual({ kind: "write", text: "hello" });
  });

  it("refuses malformed base64 and bytes that aren't UTF-8", () => {
    for (const payload of ["aGVsbG8*", "a", "aG=Vs", "aGVsbG8==="]) {
      expect(parseOsc52(`c;${payload}`)).toEqual({ kind: "invalid", reason: "malformed" });
    }
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64");
    expect(parseOsc52(`c;${latin1}`)).toEqual({ kind: "invalid", reason: "malformed" });
  });

  it("accepts the largest copy the IPC envelope carries and refuses one byte more", () => {
    // Main measures `JSON.stringify(args)`: `["` and `"]` wrap the text.
    const fits = "a".repeat(OSC52_MAX_ENVELOPE_BYTES - 4);
    expect(parseOsc52(`c;${b64(fits)}`)).toEqual({ kind: "write", text: fits });
    expect(parseOsc52(`c;${b64(`${fits}a`)}`)).toEqual({ kind: "invalid", reason: "too-large" });
  });

  it("counts escaping toward the envelope, not just the text's bytes", () => {
    const newlines = "\n".repeat(600 * 1024);
    expect(parseOsc52(`c;${b64(newlines)}`)).toEqual({ kind: "invalid", reason: "too-large" });
  });

  it("refuses a payload past the decode cap before decoding it", () => {
    const decode = vi.spyOn(globalThis, "atob");
    const payload = "A".repeat(Math.ceil(((OSC52_MAX_TEXT_BYTES + 3) * 4) / 3) + 8);
    expect(parseOsc52(`c;${payload}`)).toEqual({ kind: "invalid", reason: "too-large" });
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
  });
});

describe("judgeOsc52Write", () => {
  const now = 50_000;

  it("allows the focused pane inside the window, boundary included", () => {
    expect(judgeOsc52Write({ focused: true, lastGestureAt: now - 10, now })).toBe("allow");
    expect(
      judgeOsc52Write({ focused: true, lastGestureAt: now - OSC52_GESTURE_WINDOW_MS, now })
    ).toBe("allow");
  });

  it("blocks a pane with no recent gesture", () => {
    expect(judgeOsc52Write({ focused: true, lastGestureAt: undefined, now })).toBe(
      "no-recent-input"
    );
    expect(
      judgeOsc52Write({ focused: true, lastGestureAt: now - OSC52_GESTURE_WINDOW_MS - 1, now })
    ).toBe("no-recent-input");
    expect(judgeOsc52Write({ focused: true, lastGestureAt: now + 1, now })).toBe("no-recent-input");
  });

  it("blocks an unfocused pane even right after a gesture", () => {
    expect(judgeOsc52Write({ focused: false, lastGestureAt: now, now })).toBe("not-focused");
  });
});

describe("noteOsc52Gesture", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stamps a trusted event and ignores a synthetic one", () => {
    vi.spyOn(performance, "now").mockReturnValue(1234);
    const managed: { lastUserGestureAt?: number } = {};
    noteOsc52Gesture(managed, { isTrusted: false });
    expect(managed.lastUserGestureAt).toBeUndefined();
    noteOsc52Gesture(managed, { isTrusted: true });
    expect(managed.lastUserGestureAt).toBe(1234);
  });
});

describe("summarizeOsc52Text", () => {
  it("counts code points and lines, a trailing break not starting a line", () => {
    expect(summarizeOsc52Text("🌲🌲")).toMatchObject({ characters: 2, lines: 1 });
    expect(summarizeOsc52Text("one\n")).toMatchObject({ characters: 4, lines: 1 });
    expect(summarizeOsc52Text("a\r\nb\rc\nd")).toMatchObject({ lines: 4 });
  });

  it("shows the start only, with breaks and hidden characters made visible", () => {
    const { preview } = summarizeOsc52Text(`ls\n\u202Eevil\u0007${"x".repeat(100)}`);
    expect(preview.startsWith("ls ↵ \uFFFDevil\uFFFD")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    expect([...preview].length).toBeLessThan(80);
  });
});

describe("sanitizeForNotice", () => {
  it("leaves short plain text alone and truncates long text", () => {
    expect(sanitizeForNotice("zsh", 40)).toBe("zsh");
    expect(sanitizeForNotice("abcdef", 3)).toBe("abc…");
  });
});
