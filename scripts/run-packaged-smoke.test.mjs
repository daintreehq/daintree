import { describe, it, expect } from "vitest";
import {
  buildPackagedSmokeEnv,
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
  const markers = buildRequiredMarkers(platform);
  const successMarker = "[SMOKE] Stability soak complete";
  return markers.filter((marker) => marker !== successMarker).join("\n") + `\n${successMarker}\n`;
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
    expect(markers).not.toContain("[SMOKE] CHECK: posix-pty-reaper supervisor");
  });

  it.each(["darwin", "linux"])(
    "adds posix-pty-reaper on %s and omits win-job-object",
    (platform) => {
      const markers = buildRequiredMarkers(platform);
      expect(markers).toContain("[SMOKE] CHECK: posix-pty-reaper supervisor");
      expect(markers).not.toContain("[SMOKE] CHECK: win-job-object native module");
    }
  );

  it("emits no platform-specific reaper marker for unknown platforms", () => {
    const markers = buildRequiredMarkers("aix");
    expect(markers).not.toContain("[SMOKE] CHECK: win-job-object native module");
    expect(markers).not.toContain("[SMOKE] CHECK: posix-pty-reaper supervisor");
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

describe("buildPackagedSmokeEnv", () => {
  it("sets APPDIR when launching an extracted Linux AppRun", () => {
    const env = buildPackagedSmokeEnv(
      "/tmp/appimage-work/squashfs-root/AppRun",
      {
        ELECTRON_RUN_AS_NODE: "1",
        ATOM_SHELL_INTERNAL_RUN_AS_NODE: "1",
        NODE_ENV: "development",
      },
      "linux"
    );

    expect(env.APPDIR).toBe("/tmp/appimage-work/squashfs-root");
    expect(env.NODE_ENV).toBe("production");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ATOM_SHELL_INTERNAL_RUN_AS_NODE).toBeUndefined();
  });

  it("preserves an explicit APPDIR", () => {
    const env = buildPackagedSmokeEnv(
      "/tmp/appimage-work/squashfs-root/AppRun",
      { APPDIR: "/custom/appdir" },
      "linux"
    );

    expect(env.APPDIR).toBe("/custom/appdir");
  });

  it("does not set APPDIR for non-AppRun binaries", () => {
    const env = buildPackagedSmokeEnv(
      "/Applications/Daintree.app/Contents/MacOS/Daintree",
      {},
      "darwin"
    );

    expect(env.APPDIR).toBeUndefined();
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

  it("accepts a terminated process once the success marker completed the run", () => {
    const markers = buildRequiredMarkers("win32");
    const result = {
      code: 1,
      signal: null,
      output: fullOutputFor("win32"),
      timedOut: false,
      completedBySuccessMarker: true,
    };
    expect(() => validateSmokeOutput(1, 1, result, markers)).not.toThrow();
  });

  it("ignores shutdown failure noise emitted after the success marker", () => {
    const markers = buildRequiredMarkers("darwin");
    const result = {
      code: 1,
      signal: null,
      output:
        fullOutputFor("darwin") +
        "[SMOKE] FAILED — child process gone: type=GPU, reason=killed, exitCode=15\n",
      timedOut: false,
      completedBySuccessMarker: true,
    };
    expect(() => validateSmokeOutput(1, 1, result, markers)).not.toThrow();
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
      .filter((m) => m !== "[SMOKE] CHECK: posix-pty-reaper supervisor")
      .join("\n");
    expect(() =>
      validateSmokeOutput(1, 1, { code: 0, signal: null, output, timedOut: false }, markers)
    ).toThrow(/missing expected marker.*posix-pty-reaper/);
  });
});
