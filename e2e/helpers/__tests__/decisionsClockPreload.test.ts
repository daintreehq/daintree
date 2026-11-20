import { createRequire } from "module";
import vm from "vm";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { installShiftedClock } = require("../decisionsClockPreload.cjs") as {
  installShiftedClock: (g: object, offsetMs: number) => { offsetMs: number };
};

const MINUTE = 60_000;

/** A fresh realm with its own Date, the clock installed in it at `offsetMs`. */
function shifted(offsetMs: number) {
  const context = vm.createContext({});
  const clock = installShiftedClock(vm.runInContext("globalThis", context), offsetMs);
  const run = <T>(code: string): T => vm.runInContext(code, context) as T;
  return { clock, run };
}

describe("decisionsClockPreload", () => {
  it("moves Date.now and new Date() together, and follows the offset as it moves", () => {
    const { clock, run } = shifted(10 * MINUTE);
    const lead = () => run<number>("Date.now()") - Date.now();
    expect(Math.abs(lead() - 10 * MINUTE)).toBeLessThan(1_000);
    expect(Math.abs(run<number>("new Date().getTime()") - Date.now() - 10 * MINUTE)).toBeLessThan(
      1_000
    );

    clock.offsetMs = 25 * MINUTE;
    expect(Math.abs(lead() - 25 * MINUTE)).toBeLessThan(1_000);
    expect(Math.abs(run<number>("new Date().getTime()") - Date.now() - 25 * MINUTE)).toBeLessThan(
      1_000
    );
    // Date() called bare reads the moved clock too.
    expect(Math.abs(run<number>("Date.parse(Date())") - Date.now() - 25 * MINUTE)).toBeLessThan(
      2_000
    );
  });

  it("leaves dates built from a value, parsing and the Date type itself unchanged", () => {
    const { run } = shifted(10 * MINUTE);
    expect(run<number>("new Date(0).getTime()")).toBe(0);
    expect(run<number>('new Date("2020-01-01T00:00:00Z").getTime()')).toBe(1577836800000);
    expect(run<number>("Date.UTC(2020, 0, 1)")).toBe(1577836800000);
    expect(run<boolean>("new Date() instanceof Date")).toBe(true);
    expect(run<string>("Object.prototype.toString.call(new Date())")).toBe("[object Date]");
    // A subclass declared after the install is on the moved clock as well.
    expect(
      Math.abs(run<number>("class D extends Date {}; new D().getTime() - Date.now()"))
    ).toBeLessThan(1_000);
  });

  it("installs once per realm, so a second install keeps the first clock", () => {
    const context = vm.createContext({});
    const g = vm.runInContext("globalThis", context);
    const first = installShiftedClock(g, MINUTE);
    const second = installShiftedClock(g, 5 * MINUTE);
    expect(second).toBe(first);
    expect(Math.abs(vm.runInContext("Date.now()", context) - Date.now() - MINUTE)).toBeLessThan(
      1_000
    );
  });
});
