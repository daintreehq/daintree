import { describe, it, expect } from "vitest";
import {
  REQUIRED_MARKERS,
  boundedTail,
  describeTreeKill,
  extractResultLine,
  parsePositiveInt,
  shouldDetach,
  validateHarnessOutput,
} from "./run-freeze-harness.mjs";

// Built from the exported markers rather than restating them: a renamed marker
// should break the runner's contract test, not force a matching edit to a
// fixture that never exercised the producer in the first place. The first
// marker keeps a trailing suffix so the `startsWith` filter below stays honest.
const PASSING_OUTPUT = [
  `${REQUIRED_MARKERS[0]} — projectId=7f39de12 visible=false`,
  ...REQUIRED_MARKERS.slice(1),
  "[FREEZE-HARNESS] window=3000ms control=54224 frozen=0 recovered=52533",
  '[FREEZE-HARNESS] RESULT {"control":54224,"frozen":0,"recovered":52533,"freezeRatio":54224,"recoveryRatio":52533,"visibilityState":"hidden"}',
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

  it("escalates on Windows by forcing, not by changing the target", () => {
    const graceful = describeTreeKill("win32", 4321);
    const forced = describeTreeKill("win32", 4321, { force: true });
    // Graceful asks the tree to close; only the escalation forces it. Both
    // forcing would make the second call a duplicate rather than a step up.
    expect(graceful.args).not.toContain("/f");
    expect(forced.args).toContain("/f");
    expect(forced.args.filter((a) => a !== "/f")).toEqual(graceful.args);
  });

  it("addresses the tree only by pid, never by image name", () => {
    // This runner launches the unpackaged electron binary, so `taskkill /im`
    // would take out every other Electron app on the developer's machine.
    const action = describeTreeKill("win32", 4321, { force: true });
    expect(action.args).toEqual(["/pid", "4321", "/t", "/f"]);
  });

  it.each([undefined, null, 0, -1, 1.5, NaN])("issues no kill for the pid %s", (pid) => {
    expect(describeTreeKill("darwin", pid).kind).toBe("none");
    expect(describeTreeKill("win32", pid).kind).toBe("none");
  });
});

describe("parsePositiveInt ceiling", () => {
  it("rejects a delay Node would clamp to a near-instant timer", () => {
    // Node clamps an out-of-range setTimeout to ~1ms, so accepting this would
    // turn "wait a very long time" into "time out immediately".
    const tooLarge = 2_147_483_648;
    expect(parsePositiveInt(String(tooLarge), 180_000)).toBe(180_000);
    expect(parsePositiveInt(String(tooLarge - 1), 180_000)).toBe(tooLarge - 1);
  });

  it("refuses to reinterpret a value the caller did not write", () => {
    // parseInt would read these as 5 and 1 respectively.
    expect(parsePositiveInt("5junk", 7)).toBe(7);
    expect(parsePositiveInt("1.5", 7)).toBe(7);
    expect(parsePositiveInt(" 5 ", 7)).toBe(5);
  });

  it("honours a caller-supplied ceiling independently of the timer ceiling", () => {
    expect(parsePositiveInt("11", 1, 10)).toBe(1);
    expect(parsePositiveInt("10", 1, 10)).toBe(10);
  });
});

describe("boundedTail", () => {
  it("passes short text through untouched", () => {
    expect(boundedTail("all of it", 100)).toBe("all of it");
  });

  it("keeps the end, which is where the failure is, and says what it dropped", () => {
    const text = "abcdefghij";
    const tail = boundedTail(text, 4);
    expect(tail.endsWith("ghij")).toBe(true);
    expect(tail).toContain(String(text.length - 4));
  });

  it("bounds the payload so one write cannot outrun the flush", () => {
    const huge = "x".repeat(500_000);
    // The prefix adds a little, but the result must stay the same order of
    // magnitude as the cap rather than the input.
    expect(boundedTail(huge, 1_000).length).toBeLessThan(1_100);
  });
});
