import { describe, it, expect } from "vitest";
import {
  REQUIRED_MARKERS,
  extractResultLine,
  parsePositiveInt,
  validateHarnessOutput,
} from "./run-freeze-harness.mjs";

const PASSING_OUTPUT = [
  "[FREEZE-HARNESS] CHECK: cached view ready — projectId=7f39de12 visible=false",
  "[FREEZE-HARNESS] CHECK: probe running — OK",
  "[FREEZE-HARNESS] window=3000ms control=54224 frozen=0 recovered=52533",
  '[FREEZE-HARNESS] RESULT {"control":54224,"frozen":0,"recovered":52533,"freezeRatio":54224,"recoveryRatio":52533,"visibilityState":"hidden"}',
  "[FREEZE-HARNESS] CHECK: freeze ratio — OK",
  "[FREEZE-HARNESS] CHECK: recovery — OK",
  "[FREEZE-HARNESS] PASS",
].join("\n");

function okResult(overrides = {}) {
  return { code: 0, signal: null, output: PASSING_OUTPUT, timedOut: false, ...overrides };
}

describe("parsePositiveInt", () => {
  it("parses a positive integer", () => {
    expect(parsePositiveInt("5", 1)).toBe(5);
  });

  it.each([undefined, "", "0", "-3", "abc"])("falls back for %s", (value) => {
    expect(parsePositiveInt(value, 7)).toBe(7);
  });
});

describe("extractResultLine", () => {
  it("pulls the machine-readable numbers out of a run", () => {
    expect(extractResultLine(PASSING_OUTPUT)).toMatchObject({
      control: 54224,
      frozen: 0,
      recovered: 52533,
      visibilityState: "hidden",
    });
  });

  it("still reports numbers from a failing run", () => {
    const failing =
      '[FREEZE-HARNESS] RESULT {"control":54026,"frozen":53875,"freezeRatio":1}\n' +
      "[FREEZE-HARNESS] FAILED — freeze did not stop the renderer";
    expect(extractResultLine(failing)).toMatchObject({ frozen: 53875, freezeRatio: 1 });
  });

  it("returns null when absent or unparseable", () => {
    expect(extractResultLine("nothing here")).toBeNull();
    expect(extractResultLine("[FREEZE-HARNESS] RESULT {broken")).toBeNull();
    expect(extractResultLine(undefined)).toBeNull();
  });
});

describe("validateHarnessOutput", () => {
  it("accepts a clean passing run", () => {
    expect(() => validateHarnessOutput(1, 1, okResult())).not.toThrow();
  });

  it("rejects a run that reported a failure even if it somehow exited zero", () => {
    const output = `${PASSING_OUTPUT}\n[FREEZE-HARNESS] FAILED — freeze did not stop the renderer`;
    expect(() => validateHarnessOutput(1, 1, okResult({ output }))).toThrow(/reported a failure/);
  });

  it("rejects a non-zero exit", () => {
    expect(() => validateHarnessOutput(1, 1, okResult({ code: 1 }))).toThrow(/failed with code 1/);
  });

  it("rejects a timeout", () => {
    expect(() => validateHarnessOutput(1, 1, okResult({ timedOut: true }))).toThrow(/timed out/);
  });

  it.each(REQUIRED_MARKERS)("rejects output missing the %s marker", (marker) => {
    const output = PASSING_OUTPUT.split("\n")
      .filter((line) => !line.startsWith(marker))
      .join("\n");
    expect(() => validateHarnessOutput(1, 1, okResult({ output }))).toThrow(/missing expected/);
  });

  it("rejects a silent run that produced no output at all", () => {
    expect(() => validateHarnessOutput(1, 1, okResult({ output: "" }))).toThrow(/missing expected/);
  });
});
