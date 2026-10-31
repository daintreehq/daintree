// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendHistory,
  loadHistory,
  recordHistory,
  resetQuickRunHistoryForTests,
  type HistoryItem,
} from "../quickRunHistory";

// A structural failure writes to a memory map shared by the whole module, so each test gets its own key.
let KEY = "";
let keyCount = 0;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(overrides: Partial<Record<"getItem" | "setItem" | "removeItem", unknown>>) {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
      ...overrides,
    },
  });
  return backing;
}

const item = (command: string, timestamp = 1): HistoryItem => ({ command, timestamp });

beforeEach(() => {
  KEY = `daintree_cmd_history_p${++keyCount}`;
  resetQuickRunHistoryForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  vi.restoreAllMocks();
});

describe("appendHistory", () => {
  it("puts the command first", () => {
    expect(appendHistory([item("a"), item("b")], "c", 9)).toEqual([
      { command: "c", timestamp: 9 },
      item("a"),
      item("b"),
    ]);
  });

  it("keeps the spelling it was run with, replacing the earlier spelling", () => {
    const next = appendHistory([item("ls"), item("npm run test")], 'npm  run "test"', 9);

    expect(next).toEqual([{ command: 'npm  run "test"', timestamp: 9 }, item("ls")]);
  });

  it("replaces an earlier entry that differs only by whitespace or quoting", () => {
    const next = appendHistory(
      [item("ls"), item('npm run "test"'), item("npm  run   test")],
      "npm run test",
      9
    );

    expect(next.map((h) => h.command)).toEqual(["npm run test", "ls"]);
  });

  it("keeps quotes that protect a space", () => {
    const next = appendHistory([item('echo "a b"')], "echo a b", 9);

    expect(next.map((h) => h.command)).toEqual(["echo a b", 'echo "a b"']);
  });

  it("drops the oldest entries past ten", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => item(`cmd ${i}`));

    const next = appendHistory(eleven, "new", 9);

    expect(next).toHaveLength(10);
    expect(next[0]!.command).toBe("new");
    expect(next.at(-1)!.command).toBe("cmd 8");
  });

  it("does not mutate the list it was given", () => {
    const previous = [item("a")];
    appendHistory(previous, "b", 9);
    expect(previous).toEqual([item("a")]);
  });
});

describe("loadHistory", () => {
  it("reads a stored list", () => {
    const backing = installStorage({});
    backing.set(KEY, JSON.stringify([item("npm test")]));

    expect(loadHistory(KEY)).toEqual([item("npm test")]);
  });

  it("is empty when nothing is stored", () => {
    installStorage({});
    expect(loadHistory(KEY)).toEqual([]);
  });

  it.each([
    ["unparseable text", "{nope"],
    ["a non-list", JSON.stringify({ command: "x", timestamp: 1 })],
    ["a null entry", JSON.stringify([null])],
    ["a non-string command", JSON.stringify([{ command: 7, timestamp: 1 }])],
    ["a missing timestamp", JSON.stringify([{ command: "x" }])],
  ])("resets %s to an empty list and clears it", (_label, stored) => {
    const backing = installStorage({});
    backing.set(KEY, stored);

    expect(loadHistory(KEY)).toEqual([]);
    expect(backing.has(KEY)).toBe(false);
  });

  it("is empty rather than throwing when the read fails", () => {
    installStorage({
      getItem: () => {
        throw new DOMException("Access is denied.", "SecurityError");
      },
    });

    expect(loadHistory(KEY)).toEqual([]);
  });

  it("is empty rather than throwing when clearing a malformed list fails", () => {
    const backing = installStorage({
      removeItem: () => {
        throw new DOMException("Access is denied.", "SecurityError");
      },
    });
    backing.set(KEY, "{nope");

    expect(loadHistory(KEY)).toEqual([]);
  });
});

describe("recordHistory", () => {
  it("adds to the list it is given and persists the result", () => {
    const backing = installStorage({});

    const next = recordHistory(KEY, "b", [item("a")]);

    expect(next.map((h) => h.command)).toEqual(["b", "a"]);
    expect(JSON.parse(backing.get(KEY)!)).toEqual(next);
  });

  it("returns the new list and keeps it for the session when the quota refuses the write", () => {
    const backing = installStorage({
      setItem: () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      },
    });

    const next = recordHistory(KEY, "npm test", []);

    expect(next.map((h) => h.command)).toEqual(["npm test"]);
    expect(backing.has(KEY)).toBe(false);
    expect(loadHistory(KEY)).toEqual(next);
  });

  it("goes back to what is stored once a write lands", () => {
    let full = true;
    const backing = installStorage({
      setItem: (key: string, value: string) => {
        if (full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        backing.set(key, value);
      },
    });
    const first = recordHistory(KEY, "unsaved", []);
    full = false;

    const next = recordHistory(KEY, "saved", first);
    backing.set(KEY, JSON.stringify([item("elsewhere")]));

    expect(next.map((h) => h.command)).toEqual(["saved", "unsaved"]);
    expect(loadHistory(KEY)).toEqual([item("elsewhere")]);
  });

  it("returns the new list and serves it back when storage fails for good", () => {
    installStorage({
      setItem: () => {
        throw new DOMException("Access is denied.", "SecurityError");
      },
    });

    const first = recordHistory(KEY, "a", []);
    const next = recordHistory(KEY, "b", first);

    expect(next.map((h) => h.command)).toEqual(["b", "a"]);
    expect(loadHistory(KEY)).toEqual(next);
  });

  it("keeps the list it was given when storage can no longer be read", () => {
    installStorage({
      getItem: () => {
        throw new DOMException("Access is denied.", "SecurityError");
      },
    });

    const next = recordHistory(KEY, "c", [item("b"), item("a")]);

    expect(next.map((h) => h.command)).toEqual(["c", "b", "a"]);
  });
});
