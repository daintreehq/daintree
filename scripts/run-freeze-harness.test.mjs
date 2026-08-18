import { describe, it, expect } from "vitest";
import {
  REQUIRED_MARKERS,
  describeTreeKill,
  extractResultLine,
  parsePositiveInt,
  shouldDetach,
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

describe("describeTreeKill", () => {
  it("targets the process group on POSIX, which only detached spawning creates", () => {
    // The negative pid is a process-group id. It is valid only because the child
    // leads its own group — so the two decisions have to agree.
    const action = describeTreeKill("darwin", 4321);
    expect(shouldDetach("darwin")).toBe(true);
    expect(action).toMatchObject({ kind: "group-signal", pid: -4321 });
  });

  it("escalates the signal without changing the target", () => {
    const graceful = describeTreeKill("linux", 4321);
    const forced = describeTreeKill("linux", 4321, { force: true });
    expect(forced.pid).toBe(graceful.pid);
    expect(forced.signal).not.toBe(graceful.signal);
    expect([graceful.signal, forced.signal]).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("uses a pid-scoped tree kill on Windows, which has no process groups", () => {
    const action = describeTreeKill("win32", 4321);
    expect(shouldDetach("win32")).toBe(false);
    expect(action.kind).toBe("taskkill");
    expect(action.args).toContain("4321");
    // /t is the whole point — killing the root alone leaves Electron's children
    // holding the inherited stdio pipes open.
    expect(action.args).toContain("/t");
  });

  it("never falls back to an image-name kill", () => {
    // This runner launches the unpackaged electron binary, so `taskkill /im`
    // would take out every other Electron app on the developer's machine.
    const action = describeTreeKill("win32", 4321, { force: true });
    expect(action.args).not.toContain("/im");
    expect(action.args.join(" ")).not.toMatch(/\.exe/i);
  });

  it.each([undefined, null, 0, -1, 1.5, NaN])("issues no kill for the pid %s", (pid) => {
    expect(describeTreeKill("darwin", pid).kind).toBe("none");
    expect(describeTreeKill("win32", pid).kind).toBe("none");
  });
});
