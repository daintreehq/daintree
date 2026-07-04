import { describe, expect, it } from "vitest";
import { FORENSIC_BUFFER_SIZE, TerminalForensicsBuffer } from "../TerminalForensicsBuffer.js";

describe("TerminalForensicsBuffer retention cap", () => {
  it("holds the rolling tail at the default cap", () => {
    const buffer = new TerminalForensicsBuffer();
    buffer.capture("a".repeat(FORENSIC_BUFFER_SIZE + 500));
    expect(buffer.getRecentOutput()).toHaveLength(FORENSIC_BUFFER_SIZE);
  });

  it("lowering the cap trims the held tail immediately and bounds future captures", () => {
    const buffer = new TerminalForensicsBuffer();
    buffer.capture("x".repeat(3000) + "TAIL");

    buffer.setMaxChars(1000);
    expect(buffer.getRecentOutput()).toHaveLength(1000);
    expect(buffer.getRecentOutput().endsWith("TAIL")).toBe(true);

    buffer.capture("y".repeat(5000));
    expect(buffer.getRecentOutput()).toHaveLength(1000);
    expect(buffer.getRecentOutput().endsWith("y")).toBe(true);
  });

  it("a zero cap disables the ring instead of keeping everything (slice(-0) hazard)", () => {
    const buffer = new TerminalForensicsBuffer();
    buffer.capture("some prior output");

    buffer.setMaxChars(0);
    expect(buffer.getRecentOutput()).toBe("");

    buffer.capture("post-disable output");
    expect(buffer.getRecentOutput()).toBe("");
  });

  it("ignores negative and non-finite caps", () => {
    const buffer = new TerminalForensicsBuffer();
    buffer.capture("keep");

    buffer.setMaxChars(-1);
    buffer.setMaxChars(Number.POSITIVE_INFINITY);

    expect(buffer.getRecentOutput()).toBe("keep");
  });
});
