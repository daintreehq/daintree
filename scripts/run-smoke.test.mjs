import { describe, expect, it } from "vitest";
import { validateSmokeOutput } from "./run-smoke.mjs";
import { validateSmokeOutput as validatePackagedSmokeOutput } from "./run-packaged-smoke.mjs";

const markers = [
  "[SMOKE] CHECK: node-pty native module",
  "[SMOKE] CHECK: better-sqlite3 native module",
  "[SMOKE] CHECK: Renderer did-finish-load",
  "[SMOKE] CHECK: Renderer + IPC bridge",
  "[SMOKE] CHECK: Terminal stress rounds",
  "[SMOKE] CHECK: Project persistence stress",
  "[SMOKE] Stability soak complete",
];

describe.each([
  ["development", (result) => validateSmokeOutput(1, 1, result)],
  ["packaged", (result) => validatePackagedSmokeOutput(1, 1, result, markers)],
])("%s smoke bootstrap validation", (_name, validate) => {
  it("accepts a completed smoke run", () => {
    expect(() =>
      validate({ code: 0, signal: null, timedOut: false, output: markers.join("\n") })
    ).not.toThrow();
  });

  it("rejects a renderer bootstrap failure even when all smoke checks pass", () => {
    expect(() =>
      validate({
        code: 0,
        signal: null,
        timedOut: false,
        output: `Bootstrap failed: TypeError: n is not a function\n${markers.join("\n")}`,
      })
    ).toThrow("renderer bootstrap failure");
  });
});
