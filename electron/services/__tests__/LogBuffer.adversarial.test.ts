import { describe, expect, it } from "vitest";
import { LogBuffer, type LogEntry } from "../LogBuffer.js";

function push(buffer: LogBuffer, n: number, opts: Partial<LogEntry> = {}): LogEntry[] {
  const out: LogEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      buffer.push({
        timestamp: i,
        level: "info",
        message: `msg-${i}`,
        ...opts,
      })
    );
  }
  return out;
}

describe("LogBuffer adversarial", () => {
  it("overflow wrapping preserves chronological order of the retained tail", () => {
    const buffer = new LogBuffer(3);
    push(buffer, 10);

    const all = buffer.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.message)).toEqual(["msg-7", "msg-8", "msg-9"]);
  });

  it("maxSize of 0 clamps to 1 rather than being unbounded or zero-capacity", () => {
    const buffer = new LogBuffer(0);
    push(buffer, 5);

    expect(buffer.length).toBe(1);
    expect(buffer.getAll()[0].message).toBe("msg-4");
  });

  it("non-finite maxSize falls back to default 500", () => {
    const buffer = new LogBuffer(Number.NaN);
    push(buffer, 600);

    expect(buffer.length).toBe(500);
  });

  it("getAll returns a snapshot array — mutating it does not affect the buffer", () => {
    const buffer = new LogBuffer(5);
    push(buffer, 3);

    const snap = buffer.getAll();
    snap.splice(0, snap.length);
    snap.push({
      id: "fake",
      timestamp: 999,
      level: "error",
      message: "fake",
    });

    expect(buffer.length).toBe(3);
    expect(buffer.getAll()[0].message).toBe("msg-0");
  });

  it("getAll returns shallow-copied entries — mutating an entry leaks into the buffer", () => {
    const buffer = new LogBuffer(5);
    push(buffer, 1, { context: { token: "secret" } });

    const [entry] = buffer.getAll();
    (entry.context as Record<string, unknown>).token = "REDACTED";

    expect((buffer.getAll()[0].context as Record<string, unknown>).token).toBe("REDACTED");
  });

  it("getFiltered with search on circular context does not throw and excludes the circular entry", () => {
    const buffer = new LogBuffer(10);
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    buffer.push({ timestamp: 1, level: "info", message: "normal hit", context: circular });
    buffer.push({ timestamp: 2, level: "info", message: "other" });

    const results = buffer.getFiltered({ search: "1" });

    expect(results.map((e) => e.message)).not.toContain("normal hit");
  });

  it("getFiltered with search matching message still returns entry even if its context is circular", () => {
    const buffer = new LogBuffer(10);
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    buffer.push({ timestamp: 1, level: "info", message: "findme", context: circular });

    const results = buffer.getFiltered({ search: "findme" });

    expect(results).toHaveLength(1);
  });

  it("getFiltered with BigInt in context survives JSON.stringify failure", () => {
    const buffer = new LogBuffer(10);
    buffer.push({
      timestamp: 1,
      level: "info",
      message: "has big",
      context: { big: 1n as unknown as number },
    });

    expect(() => buffer.getFiltered({ search: "big" })).not.toThrow();
  });

  it("getSources only reflects sources of currently-retained entries after overflow", () => {
    const buffer = new LogBuffer(2);
    buffer.push({ timestamp: 1, level: "info", message: "a", source: "src-old" });
    buffer.push({ timestamp: 2, level: "info", message: "b", source: "src-mid" });
    buffer.push({ timestamp: 3, level: "info", message: "c", source: "src-new" });

    const sources = buffer.getSources();
    expect(sources).toEqual(["src-mid", "src-new"]);
  });

  it("time-range filter includes entries at exact bounds (inclusive)", () => {
    const buffer = new LogBuffer(10);
    for (const t of [1, 2, 3, 4, 5]) {
      buffer.push({ timestamp: t, level: "info", message: `t${t}` });
    }

    const results = buffer.getFiltered({ startTime: 2, endTime: 4 });
    expect(results.map((e) => e.timestamp)).toEqual([2, 3, 4]);
  });

  it("level filter with empty array is a no-op (does not filter to zero)", () => {
    const buffer = new LogBuffer(10);
    push(buffer, 3);

    expect(buffer.getFiltered({ levels: [] })).toHaveLength(3);
  });

  it("clear() empties the buffer and getSources", () => {
    const buffer = new LogBuffer(10);
    push(buffer, 3, { source: "s1" });
    buffer.clear();

    expect(buffer.length).toBe(0);
    expect(buffer.getAll()).toEqual([]);
    expect(buffer.getSources()).toEqual([]);
  });
});
