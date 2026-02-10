import { describe, expect, it } from "vitest";
import { LogBuffer } from "../LogBuffer.js";

describe("LogBuffer", () => {
  it("normalizes invalid max size values", () => {
    const buffer = new LogBuffer(0);

    buffer.push({ timestamp: 1, level: "info", message: "one" });
    buffer.push({ timestamp: 2, level: "info", message: "two" });

    expect(buffer.length).toBe(1);
    expect(buffer.getAll()[0]?.message).toBe("two");
  });

  it("handles NaN max size by falling back to default", () => {
    const buffer = new LogBuffer(Number.NaN);

    for (let i = 0; i < 510; i++) {
      buffer.push({ timestamp: i, level: "info", message: `entry-${i}` });
    }

    expect(buffer.length).toBe(500);
    expect(buffer.getAll()[0]?.message).toBe("entry-10");
  });

  it("getAll returns a defensive copy", () => {
    const buffer = new LogBuffer(3);
    buffer.push({ timestamp: 1, level: "info", message: "a" });

    const all = buffer.getAll();
    all.push({
      id: "fake",
      timestamp: 999,
      level: "error",
      message: "injected",
    });

    expect(buffer.length).toBe(1);
    expect(buffer.getAll()).toHaveLength(1);
  });
});
