import { describe, it, expect } from "vitest";
import { PatternBuffer } from "../PatternBuffer.js";

describe("PatternBuffer", () => {
  it("stores and retrieves text", () => {
    const buf = new PatternBuffer(100);
    buf.update("hello");
    expect(buf.getText()).toBe("hello");
  });

  it("appends new data", () => {
    const buf = new PatternBuffer(100);
    buf.update("hello ");
    buf.update("world");
    expect(buf.getText()).toBe("hello world");
  });

  it("trims to max size keeping tail", () => {
    const buf = new PatternBuffer(10);
    buf.update("abcdefghij");
    buf.update("klmno");
    expect(buf.getText()).toBe("fghijklmno");
    expect(buf.getText().length).toBe(10);
  });

  it("clears the buffer", () => {
    const buf = new PatternBuffer(100);
    buf.update("data");
    buf.clear();
    expect(buf.getText()).toBe("");
  });

  it("resets the buffer", () => {
    const buf = new PatternBuffer(100);
    buf.update("data");
    buf.reset();
    expect(buf.getText()).toBe("");
  });
});
