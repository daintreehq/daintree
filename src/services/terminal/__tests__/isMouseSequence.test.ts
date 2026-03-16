import { describe, it, expect } from "vitest";
import { isMouseSequence } from "../TerminalInstanceService";

describe("isMouseSequence", () => {
  it("detects X10/Normal mouse sequences (\\x1b[M + 3 bytes)", () => {
    expect(isMouseSequence("\x1b[M #!")).toBe(true);
    expect(isMouseSequence("\x1b[M\x00\x20\x21")).toBe(true);
  });

  it("detects SGR mouse sequences (\\x1b[< ... M or m)", () => {
    expect(isMouseSequence("\x1b[<0;12;8M")).toBe(true);
    expect(isMouseSequence("\x1b[<0;12;8m")).toBe(true);
    expect(isMouseSequence("\x1b[<35;120;45M")).toBe(true);
  });

  it("detects URXVT mouse sequences (\\x1b[ digits;digits;digits M)", () => {
    expect(isMouseSequence("\x1b[64;12;8M")).toBe(true);
    expect(isMouseSequence("\x1b[32;1;1M")).toBe(true);
  });

  it("does NOT match arrow keys", () => {
    expect(isMouseSequence("\x1b[A")).toBe(false);
    expect(isMouseSequence("\x1b[B")).toBe(false);
    expect(isMouseSequence("\x1b[C")).toBe(false);
    expect(isMouseSequence("\x1b[D")).toBe(false);
  });

  it("does NOT match function keys", () => {
    expect(isMouseSequence("\x1b[15~")).toBe(false); // F5
    expect(isMouseSequence("\x1b[17~")).toBe(false); // F6
  });

  it("does NOT match Home/End/PgUp/PgDn", () => {
    expect(isMouseSequence("\x1b[H")).toBe(false);
    expect(isMouseSequence("\x1b[F")).toBe(false);
    expect(isMouseSequence("\x1b[5~")).toBe(false);
    expect(isMouseSequence("\x1b[6~")).toBe(false);
  });

  it("does NOT match printable characters", () => {
    expect(isMouseSequence("a")).toBe(false);
    expect(isMouseSequence("hello")).toBe(false);
    expect(isMouseSequence("\r")).toBe(false);
    expect(isMouseSequence(" ")).toBe(false);
  });

  it("does NOT match control characters", () => {
    expect(isMouseSequence("\x03")).toBe(false); // Ctrl+C
    expect(isMouseSequence("\x04")).toBe(false); // Ctrl+D
    expect(isMouseSequence("\x1a")).toBe(false); // Ctrl+Z
  });
});
