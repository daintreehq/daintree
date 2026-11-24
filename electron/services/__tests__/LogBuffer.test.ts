import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("overflow wrapping preserves chronological order of the retained tail", () => {
    const buffer = new LogBuffer(3);
    push(buffer, 10);

    const all = buffer.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.message)).toEqual(["msg-7", "msg-8", "msg-9"]);
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

  describe("circular storage", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("keeps only the latest entry at capacity one", () => {
      const buffer = new LogBuffer(1);

      const first = buffer.push({ timestamp: 1, level: "info", message: "one" });
      expect(buffer.getAll()).toEqual([first]);

      const second = buffer.push({ timestamp: 2, level: "warn", message: "two" });
      const third = buffer.push({ timestamp: 3, level: "error", message: "three" });

      expect(buffer.length).toBe(1);
      expect(buffer.getAll()).toEqual([third]);
      expect(buffer.getAll()[0]).not.toBe(second);
      expect(buffer.getSources()).toEqual([]);
    });

    it("stays chronological across many full wraps", () => {
      const buffer = new LogBuffer(7);
      push(buffer, 7 * 5 + 3);

      expect(buffer.length).toBe(7);
      expect(buffer.getAll().map((e) => e.timestamp)).toEqual([31, 32, 33, 34, 35, 36, 37]);
    });

    it("returns the same entry objects that push handed back", () => {
      const buffer = new LogBuffer(4);
      const pushed = push(buffer, 6);

      const all = buffer.getAll();
      expect(all).toHaveLength(4);
      all.forEach((entry, i) => expect(entry).toBe(pushed[i + 2]));
    });

    it("reports length growing up to capacity and never past it", () => {
      const buffer = new LogBuffer(3);
      const lengths: number[] = [];
      for (let i = 0; i < 6; i++) {
        buffer.push({ timestamp: i, level: "info", message: `m${i}` });
        lengths.push(buffer.length);
      }

      expect(lengths).toEqual([1, 2, 3, 3, 3, 3]);
    });

    it("filters in chronological order when the ring has wrapped", () => {
      const buffer = new LogBuffer(5);
      for (let i = 0; i < 12; i++) {
        buffer.push({
          timestamp: i,
          level: i % 2 === 0 ? "error" : "info",
          message: `m${i}`,
          source: i % 3 === 0 ? "a" : "b",
        });
      }

      expect(buffer.getFiltered({ levels: ["error"] }).map((e) => e.timestamp)).toEqual([8, 10]);
      expect(buffer.getFiltered({ sources: ["b"] }).map((e) => e.timestamp)).toEqual([
        7, 8, 10, 11,
      ]);
      expect(buffer.getFiltered({ startTime: 8, endTime: 10 }).map((e) => e.timestamp)).toEqual([
        8, 9, 10,
      ]);
      expect(buffer.getFiltered({ search: "m1" }).map((e) => e.timestamp)).toEqual([10, 11]);
      expect(buffer.getSources()).toEqual(["a", "b"]);
    });

    it.each([
      { pushed: 3, expected: [0, 1, 2] },
      { pushed: 5, expected: [0, 1, 2, 3, 4] },
      { pushed: 8, expected: [3, 4, 5, 6, 7] },
    ])(
      "getFiltered without active filters returns a fresh array after $pushed pushes",
      ({ pushed, expected }) => {
        const buffer = new LogBuffer(5);
        push(buffer, pushed);

        const unfiltered = buffer.getFiltered({});
        const emptyLists = buffer.getFiltered({ levels: [], sources: [] });
        expect(unfiltered).not.toBe(emptyLists);
        expect(unfiltered.map((e) => e.timestamp)).toEqual(expected);
        expect(emptyLists.map((e) => e.timestamp)).toEqual(expected);

        unfiltered.length = 0;
        emptyLists.push({ id: "fake", timestamp: 999, level: "error", message: "fake" });

        expect(buffer.getAll().map((e) => e.timestamp)).toEqual(expected);
        expect(buffer.getFiltered({}).map((e) => e.timestamp)).toEqual(expected);
      }
    );

    it("an array returned before later pushes does not change when the ring wraps", () => {
      const buffer = new LogBuffer(3);
      push(buffer, 3);
      const before = buffer.getAll();

      buffer.push({ timestamp: 100, level: "info", message: "later" });

      expect(before.map((e) => e.timestamp)).toEqual([0, 1, 2]);
      expect(buffer.getAll().map((e) => e.timestamp)).toEqual([1, 2, 100]);
    });

    it("a search whose context serializer appends mid-filter sees the original snapshot", () => {
      const buffer = new LogBuffer(3);
      const reentrant = {
        toJSON() {
          buffer.push({ timestamp: 100, level: "info", message: "E" });
          buffer.push({ timestamp: 101, level: "info", message: "F" });
          return { hit: "needle" };
        },
      };
      buffer.push({ timestamp: 1, level: "info", message: "A" });
      buffer.push({ timestamp: 2, level: "info", message: "B", context: reentrant });
      buffer.push({ timestamp: 3, level: "info", message: "C needle" });
      buffer.push({ timestamp: 4, level: "info", message: "D" });

      const results = buffer.getFiltered({ search: "needle" });

      expect(results.map((e) => e.message)).toEqual(["B", "C needle"]);
      expect(buffer.getAll().map((e) => e.message)).toEqual(["D", "E", "F"]);
    });

    it("clear empties a wrapped ring and later pushes start a fresh chronological run", () => {
      const buffer = new LogBuffer(3);
      push(buffer, 8);

      buffer.clear();
      expect(buffer.length).toBe(0);
      expect(buffer.getAll()).toEqual([]);
      expect(buffer.getFiltered({ levels: ["info"] })).toEqual([]);
      expect(buffer.getSources()).toEqual([]);

      buffer.push({ timestamp: 50, level: "info", message: "a" });
      buffer.push({ timestamp: 51, level: "info", message: "b" });
      expect(buffer.getAll().map((e) => e.message)).toEqual(["a", "b"]);

      buffer.push({ timestamp: 52, level: "info", message: "c" });
      buffer.push({ timestamp: 53, level: "info", message: "d" });
      expect(buffer.getAll().map((e) => e.message)).toEqual(["b", "c", "d"]);
    });

    it("onProjectSwitch clears the buffer", () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const buffer = new LogBuffer(3);
      push(buffer, 5);

      buffer.onProjectSwitch();

      expect(buffer.length).toBe(0);
      expect(buffer.getAll()).toEqual([]);
    });
  });
});
