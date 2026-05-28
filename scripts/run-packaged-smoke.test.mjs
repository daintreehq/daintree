import { describe, it, expect } from "vitest";
import {
  buildRequiredMarkers,
  parsePositiveInt,
  validateSmokeOutput,
} from "./run-packaged-smoke.mjs";

const SHARED_MARKERS = [
  "[SMOKE] CHECK: node-pty native module",
  "[SMOKE] CHECK: better-sqlite3 native module",
  "[SMOKE] CHECK: Renderer did-finish-load",
  "[SMOKE] CHECK: Renderer + IPC bridge",
  "[SMOKE] CHECK: Terminal stress rounds",
  "[SMOKE] CHECK: Project persistence stress",
  "[SMOKE] Stability soak complete",
];

function fullOutputFor(platform) {
  return buildRequiredMarkers(platform).join("\n") + "\n";
}

describe("buildRequiredMarkers", () => {
  it.each(["win32", "darwin", "linux"])("includes every shared marker on %s", (platform) => {
    const markers = buildRequiredMarkers(platform);
    for (const shared of SHARED_MARKERS) {
      expect(markers).toContain(shared);
    }
  });

  it("adds win-job-object on Windows and omits posix-pty-reaper", () => {
    const markers = buildRequiredMarkers("win32");
    expect(markers).toContain("[SMOKE] CHECK: win-job-object native module");
    expect(markers).not.toContain("[SMOKE] CHECK: posix-pty-reaper native module");
  });

  it.each(["darwin", "linux"])(
    "adds posix-pty-reaper on %s and omits win-job-object",
    (platform) => {
      const markers = buildRequiredMarkers(platform);
      expect(markers).toContain("[SMOKE] CHECK: posix-pty-reaper native module");
      expect(markers).not.toContain("[SMOKE] CHECK: win-job-object native module");
    }
  );

  it("emits no platform-specific reaper marker for unknown platforms", () => {
    const markers = buildRequiredMarkers("aix");
    expect(markers).not.toContain("[SMOKE] CHECK: win-job-object native module");
    expect(markers).not.toContain("[SMOKE] CHECK: posix-pty-reaper native module");
  });
});

describe("parsePositiveInt", () => {
  it("returns parsed value when positive integer", () => {
    expect(parsePositiveInt("5", 1)).toBe(5);
  });

  it("returns fallback for non-numeric strings", () => {
    expect(parsePositiveInt("abc", 7)).toBe(7);
  });

  it("returns fallback for negative numbers", () => {
    expect(parsePositiveInt("-3", 4)).toBe(4);
  });

  it("returns fallback for zero", () => {
    expect(parsePositiveInt("0", 9)).toBe(9);
  });

  it("returns fallback for undefined input", () => {
    expect(parsePositiveInt(undefined, 42)).toBe(42);
  });
});

describe("validateSmokeOutput", () => {
  it("passes when every required marker is present and exit code is 0", () => {
    const markers = buildRequiredMarkers("linux");
    const result = {
      code: 0,
      signal: null,
      output: fullOutputFor("linux"),
      timedOut: false,
    };
    expect(() => validateSmokeOutput(1, 1, result, markers)).not.toThrow();
  });

  it("throws when the run timed out", () => {
    expect(() =>
      validateSmokeOutput(
        2,
        3,
        { code: null, signal: null, output: "", timedOut: true },
        SHARED_MARKERS
      )
    ).toThrow(/timed out/);
  });

  it("throws on non-zero exit code", () => {
    expect(() =>
      validateSmokeOutput(
        1,
        1,
        { code: 1, signal: null, output: fullOutputFor("linux"), timedOut: false },
        buildRequiredMarkers("linux")
      )
    ).toThrow(/failed with code 1/);
  });

  it("throws when output contains [SMOKE] FAILED", () => {
    const output = fullOutputFor("linux") + "[SMOKE] FAILED — something broke\n";
    expect(() =>
      validateSmokeOutput(
        1,
        1,
        { code: 0, signal: null, output, timedOut: false },
        buildRequiredMarkers("linux")
      )
    ).toThrow(/reported a smoke failure/);
  });

  it("throws when a required marker is missing", () => {
    const markers = buildRequiredMarkers("linux");
    const output = markers
      .filter((m) => m !== "[SMOKE] CHECK: posix-pty-reaper native module")
      .join("\n");
    expect(() =>
      validateSmokeOutput(1, 1, { code: 0, signal: null, output, timedOut: false }, markers)
    ).toThrow(/missing expected marker.*posix-pty-reaper/);
  });
});

describe("validateSmokeOutput", () => {
  const markers = buildRequiredMarkers("linux");
  // Emitted lines carry a trailing " — OK" suffix; the validator prefix-matches
  // via includes(), so the fixture appends it to mirror real output.
  const cleanOutput = markers.map((m) => `${m} — OK`).join("\n");

  it("passes when exit code is 0 and every marker is present", () => {
    expect(() =>
      validateSmokeOutput(
        1,
        1,
        { code: 0, signal: null, output: cleanOutput, timedOut: false },
        markers
      )
    ).not.toThrow();
  });

  it("throws on timeout", () => {
    expect(() =>
      validateSmokeOutput(
        1,
        1,
        { code: null, signal: "SIGTERM", output: cleanOutput, timedOut: true },
        markers
      )
    ).toThrow(/timed out/);
  });

  it("throws on a nonzero exit code", () => {
    expect(() =>
      validateSmokeOutput(
        1,
        1,
        { code: 1, signal: null, output: cleanOutput, timedOut: false },
        markers
      )
    ).toThrow(/failed with code 1/);
  });

  it("throws when output contains [SMOKE] FAILED even with exit 0 and all markers", () => {
    const failedOutput = `${cleanOutput}\n[SMOKE] FAILED — renderer process gone`;
    expect(() =>
      validateSmokeOutput(
        1,
        1,
        { code: 0, signal: null, output: failedOutput, timedOut: false },
        markers
      )
    ).toThrow(/reported a smoke failure/);
  });

  it("throws when a required marker is missing", () => {
    const missingOutput = cleanOutput.replace(
      "[SMOKE] CHECK: posix-pty-reaper supervisor — OK",
      ""
    );
    expect(() =>
      validateSmokeOutput(
        1,
        1,
        { code: 0, signal: null, output: missingOutput, timedOut: false },
        markers
      )
    ).toThrow(/missing expected marker/);
  });
});
