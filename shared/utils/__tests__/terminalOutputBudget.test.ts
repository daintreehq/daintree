import { describe, expect, it } from "vitest";
import {
  boundTerminalStatusOutput,
  fitTailToJsonBytes,
  fitTerminalOutputResult,
  jsonStringBytes,
  type CapturedTail,
} from "../terminalOutputBudget.js";
import type { TerminalStatusEntry, TerminalStatusResult } from "../../types/terminalStatus.js";

const ESC = String.fromCharCode(0x1b);
const CAP = 50 * 1024;

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function tailOf(lines: string[], truncated = false): CapturedTail {
  return { content: lines.join("\n"), lineCount: lines.length, truncated };
}

function numberedLines(count: number, width: number, prefix = "line"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i} `.padEnd(width, "="));
}

function hasOrphanSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("jsonStringBytes", () => {
  it("counts the escaped UTF-8 form, not the raw length", () => {
    expect(jsonStringBytes("ab")).toBe(2);
    expect(jsonStringBytes(ESC)).toBe(6);
    expect(jsonStringBytes('"')).toBe(2);
    expect(jsonStringBytes("\n")).toBe(2);
    expect(jsonStringBytes("é")).toBe(2);
    expect(jsonStringBytes("🌳")).toBe(4);
  });
});

describe("fitTailToJsonBytes", () => {
  it("returns a tail that already fits unchanged", () => {
    const tail = tailOf(["one", "two"]);
    expect(fitTailToJsonBytes(tail, 100)).toBe(tail);
  });

  it("keeps the newest whole lines and reports the cut", () => {
    const tail = tailOf(["one", "two", "three"]);
    const budget = jsonStringBytes("two\nthree");

    expect(fitTailToJsonBytes(tail, budget)).toEqual({
      content: "two\nthree",
      lineCount: 2,
      truncated: true,
    });
    expect(fitTailToJsonBytes(tail, budget - 1)).toEqual({
      content: "three",
      lineCount: 1,
      truncated: true,
    });
  });

  it("stops at the first line that does not fit rather than skipping to an older one", () => {
    const tail = tailOf(["a", "x".repeat(50), "b"]);
    expect(fitTailToJsonBytes(tail, 10).content).toBe("b");
  });

  it("keeps the end of a newest line that alone exceeds the budget", () => {
    const tail = tailOf(["older", `${"a".repeat(100)}END`]);
    expect(fitTailToJsonBytes(tail, 10)).toEqual({
      content: "aaaaaaaEND",
      lineCount: 1,
      truncated: true,
    });
  });

  it("never opens a partial line on half of a surrogate pair", () => {
    for (const budget of [4, 5, 6, 7]) {
      const fitted = fitTailToJsonBytes(tailOf(["🌳🌳"]), budget);
      expect(fitted.content).toBe("🌳");
      expect(hasOrphanSurrogate(fitted.content)).toBe(false);
    }
    expect(fitTailToJsonBytes(tailOf(["🌳🌳"]), 3).content).toBe("");
  });

  it("budgets escape-heavy output by its serialized size", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `${ESC}[31mred ${i}${ESC}[0m`);
    const fitted = fitTailToJsonBytes(tailOf(lines), 5000);

    expect(jsonStringBytes(fitted.content)).toBeLessThanOrEqual(5000);
    const kept = fitted.content.split("\n");
    expect(kept.at(-1)).toBe(lines.at(-1));
    expect(kept).toEqual(lines.slice(-kept.length));
    expect(fitted.lineCount).toBe(kept.length);
  });

  it("keeps an earlier truncation flag and never clears it", () => {
    const tail = tailOf(["one", "two"], true);
    expect(fitTailToJsonBytes(tail, 100).truncated).toBe(true);
    expect(fitTailToJsonBytes(tail, 3).truncated).toBe(true);
  });

  it("returns nothing, flagged, when no byte is available", () => {
    expect(fitTailToJsonBytes(tailOf(["one"]), 0)).toEqual({
      content: "",
      lineCount: 0,
      truncated: true,
    });
  });
});

describe("fitTerminalOutputResult", () => {
  it("fits a wide 1000-line tail under the cap with the newest line kept whole", () => {
    const lines = numberedLines(1000, 200);
    const result = { terminalId: "term-1", ...tailOf(lines) };

    const fitted = fitTerminalOutputResult(result, CAP);

    expect(bytesOf(fitted)).toBeLessThanOrEqual(CAP);
    expect(bytesOf(fitted)).toBeGreaterThan(CAP - 250);
    const kept = fitted.content.split("\n");
    expect(kept).toEqual(lines.slice(-kept.length));
    expect(fitted.lineCount).toBe(kept.length);
    expect(fitted.lineCount).toBeLessThan(1000);
    expect(fitted.truncated).toBe(true);
    expect(fitted.terminalId).toBe("term-1");
  });

  it("returns a result that fits unchanged", () => {
    const result = { terminalId: "term-1", ...tailOf(["one", "two"]) };
    expect(fitTerminalOutputResult(result, CAP)).toBe(result);
  });

  it("treats the cap as inclusive", () => {
    const base = { terminalId: "t", content: "", lineCount: 1, truncated: false };
    const filler = "x".repeat(CAP - bytesOf(base));
    const exact = { ...base, content: filler };
    expect(bytesOf(exact)).toBe(CAP);
    expect(fitTerminalOutputResult(exact, CAP)).toBe(exact);

    const over = { ...base, content: `${filler}x` };
    const fitted = fitTerminalOutputResult(over, CAP);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(CAP);
    expect(fitted.truncated).toBe(true);
  });

  it("fits multi-byte and escape-heavy content by what the transport sends", () => {
    const lines = Array.from({ length: 1000 }, (_, i) =>
      `${ESC}[1m🌳 é "quoted" \\ ${i}${ESC}[0m`.padEnd(120, "界")
    );
    const fitted = fitTerminalOutputResult({ terminalId: "t", ...tailOf(lines) }, CAP);

    expect(bytesOf(fitted)).toBeLessThanOrEqual(CAP);
    expect(fitted.content.split("\n").at(-1)).toBe(lines.at(-1));
    expect(hasOrphanSurrogate(fitted.content)).toBe(false);
  });
});

function entry(id: string, recentOutput?: string | null, extra: Partial<TerminalStatusEntry> = {}) {
  const base: TerminalStatusEntry = { terminalId: id, agentId: null, agentState: null, ...extra };
  if (recentOutput === undefined) return base;
  if (recentOutput === null) return { ...base, recentOutput };
  return { ...base, recentOutput, recentOutputTruncated: false };
}

function statusOf(terminals: TerminalStatusEntry[]): TerminalStatusResult {
  return { terminals, source: "renderer", unavailableFields: ["hasPty"] };
}

describe("boundTerminalStatusOutput", () => {
  it("returns a snapshot that fits unchanged", () => {
    const status = statusOf([entry("a", "hello"), entry("b")]);
    expect(boundTerminalStatusOutput(status, CAP)).toBe(status);
  });

  it("keeps quiet tails whole and fits busy ones to their newest lines", () => {
    const busyA = numberedLines(50, 900, "a");
    const busyB = numberedLines(50, 900, "b");
    const status = statusOf([
      entry("quiet", "$ ls\nREADME.md"),
      entry("busy-a", busyA.join("\n")),
      entry("none", null),
      entry("busy-b", busyB.join("\n")),
      entry("unrequested"),
    ]);

    const bounded = boundTerminalStatusOutput(status, CAP);

    expect(bytesOf(bounded)).toBeLessThanOrEqual(CAP);
    const [quiet, a, none, b, unrequested] = bounded.terminals;
    expect(quiet).toBe(status.terminals[0]);
    expect(none).toBe(status.terminals[2]);
    expect(unrequested).toBe(status.terminals[4]);
    for (const [fitted, lines] of [
      [a, busyA],
      [b, busyB],
    ] as const) {
      const kept = fitted!.recentOutput!.split("\n");
      expect(kept.length).toBeGreaterThan(0);
      expect(kept).toEqual(lines.slice(-kept.length));
      expect(fitted!.recentOutputTruncated).toBe(true);
    }
    // Equal demand gets an equal share, to within one line.
    const lengthA = a!.recentOutput!.length;
    const lengthB = b!.recentOutput!.length;
    expect(Math.abs(lengthA - lengthB)).toBeLessThanOrEqual(901);
  });

  it("gives what short tails leave unused to the longer ones", () => {
    const busy = numberedLines(60, 1000);
    const quietTails = Array.from({ length: 20 }, (_, i) => entry(`q${i}`, `ok ${i}`));
    const status = statusOf([...quietTails, entry("busy", busy.join("\n"))]);

    const bounded = boundTerminalStatusOutput(status, CAP);

    expect(bytesOf(bounded)).toBeLessThanOrEqual(CAP);
    const fitted = bounded.terminals.at(-1)!.recentOutput!;
    // A flat 1/21 split would leave this tail ~2.4 KB; reclaiming the quiet
    // terminals' unused share gives it nearly the whole budget.
    expect(fitted.length).toBeGreaterThan(40 * 1024);
    expect(bounded.terminals.slice(0, 20)).toEqual(quietTails);
  });

  it("empties and flags every tail when the status fields alone overrun the cap", () => {
    const status = statusOf([
      entry("a", "some output", { error: "e".repeat(CAP) }),
      entry("b", "more output"),
    ]);

    const bounded = boundTerminalStatusOutput(status, CAP);

    for (const fitted of bounded.terminals) {
      expect(fitted.recentOutput).toBe("");
      expect(fitted.recentOutputTruncated).toBe(true);
    }
    expect(bounded.terminals[0]!.error).toBe(status.terminals[0]!.error);
  });

  it("stays within the cap when an entry carries no truncation flag yet", () => {
    const lines = numberedLines(100, 1000);
    const bare: TerminalStatusEntry = {
      terminalId: "t",
      agentId: null,
      agentState: null,
      recentOutput: lines.join("\n"),
    };

    const bounded = boundTerminalStatusOutput(statusOf([bare]), CAP);

    expect(bytesOf(bounded)).toBeLessThanOrEqual(CAP);
    expect(bounded.terminals[0]!.recentOutputTruncated).toBe(true);
  });
});
