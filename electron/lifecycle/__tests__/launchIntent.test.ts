import { describe, it, expect } from "vitest";
import {
  resolveLaunchIntent,
  shouldRestoreWindowFleet,
  stripLaunchTargets,
  type LaunchIntentSignals,
} from "../launchIntent.js";

function signals(overrides: Partial<LaunchIntentSignals> = {}): LaunchIntentSignals {
  return {
    argv: ["/Applications/Daintree.app/Contents/MacOS/Daintree"],
    hasCliPathFlag: () => false,
    extractDirectoryPaths: () => [],
    pendingOpenDirPaths: [],
    pendingOpenFilePaths: [],
    isSafeMode: false,
    hasPendingCrash: false,
    ...overrides,
  };
}

describe("resolveLaunchIntent", () => {
  it("treats a bare double-click launch as cold", () => {
    expect(resolveLaunchIntent(signals())).toBe("cold");
  });

  it("treats a --cli-path launch as targeted", () => {
    expect(resolveLaunchIntent(signals({ hasCliPathFlag: () => true }))).toBe("targeted");
  });

  it("treats a --cli-path that failed to resolve as targeted too", () => {
    // The user still named something; the flag is the intent, not its outcome.
    const intent = resolveLaunchIntent(
      signals({ hasCliPathFlag: () => true, extractDirectoryPaths: () => [] })
    );
    expect(intent).toBe("targeted");
  });

  it("treats a Linux folder URI as targeted", () => {
    expect(resolveLaunchIntent(signals({ extractDirectoryPaths: () => ["/repos/app"] }))).toBe(
      "targeted"
    );
  });

  it("treats a queued Finder folder drop as targeted", () => {
    expect(resolveLaunchIntent(signals({ pendingOpenDirPaths: ["/repos/app"] }))).toBe("targeted");
  });

  it("treats a queued .dntr archive as targeted", () => {
    expect(resolveLaunchIntent(signals({ pendingOpenFilePaths: ["/tmp/x.dntr"] }))).toBe(
      "targeted"
    );
  });

  it("classifies safe mode as recovery", () => {
    expect(resolveLaunchIntent(signals({ isSafeMode: true }))).toBe("recovery");
  });

  it("classifies a pending crash as recovery", () => {
    expect(resolveLaunchIntent(signals({ hasPendingCrash: true }))).toBe("recovery");
  });

  it("lets recovery outrank a targeted launch", () => {
    // Reopening a fleet is how one bad launch becomes a crash loop, so the
    // recovery classification has to win even when argv names something.
    const intent = resolveLaunchIntent(signals({ isSafeMode: true, hasCliPathFlag: () => true }));
    expect(intent).toBe("recovery");
  });

  it("passes argv through to the injected parsers rather than re-reading process.argv", () => {
    const argv = ["daintree", "--cli-path=/repos/app"];
    let sawCli: string[] | null = null;
    let sawDirs: string[] | null = null;
    resolveLaunchIntent(
      signals({
        argv,
        hasCliPathFlag: (a) => {
          sawCli = a;
          return false;
        },
        extractDirectoryPaths: (a) => {
          sawDirs = a;
          return [];
        },
      })
    );
    expect(sawCli).toBe(argv);
    expect(sawDirs).toBe(argv);
  });
});

describe("shouldRestoreWindowFleet", () => {
  it("restores the fleet only on a plain cold launch", () => {
    expect(shouldRestoreWindowFleet("cold")).toBe(true);
    expect(shouldRestoreWindowFleet("targeted")).toBe(false);
    expect(shouldRestoreWindowFleet("recovery")).toBe(false);
  });
});

/**
 * `stripLaunchTargets` is the inverse of the argv half of the classifier above
 * (#12320). `app.relaunch()` hands the child process the parent's argv
 * verbatim, so a session that began with `--cli-path` still carries it hours
 * later — and an app-requested restart would read as targeted and abandon the
 * user's fleet.
 *
 * The round-trip assertions below are what keep the two in step: each one
 * classifies the raw argv as targeted, then classifies the stripped argv, using
 * the same detector shapes production injects.
 */
describe("stripLaunchTargets", () => {
  /** Detector stubs shaped like the real appLifecycle ones. */
  const argvSignals = (argv: string[]) =>
    signals({
      argv,
      hasCliPathFlag: (a) => a.some((t) => t === "--cli-path" || t.startsWith("--cli-path=")),
      extractDirectoryPaths: (a) => a.filter((t) => t.startsWith("file://")),
    });

  it("removes the two-token --cli-path form together with its operand", () => {
    // Leaving the operand behind would turn a directory path into a bare
    // positional argument, which is how a `.dntr` archive is recognised.
    expect(stripLaunchTargets(["--cli-path", "/repos/app", "--disable-gpu"])).toEqual([
      "--disable-gpu",
    ]);
  });

  it("removes the joined --cli-path= form", () => {
    expect(stripLaunchTargets(["--cli-path=/repos/app", "--e2e"])).toEqual(["--e2e"]);
  });

  it("removes file:// directory arguments", () => {
    expect(stripLaunchTargets(["file:///repos/app", "--disable-gpu"])).toEqual(["--disable-gpu"]);
  });

  it("keeps every switch that is not a launch target", () => {
    const argv = ["--disable-gpu", "--reset-data", "--e2e", "--inspect=9229"];
    expect(stripLaunchTargets(argv)).toEqual(argv);
  });

  it("removes every target when several are present", () => {
    expect(stripLaunchTargets(["--cli-path", "/a", "file:///b", "--cli-path=/c", "--keep"])).toEqual(
      ["--keep"]
    );
  });

  it("is a no-op on an empty argv", () => {
    expect(stripLaunchTargets([])).toEqual([]);
  });

  it.each([
    ["a --cli-path launch", ["--cli-path", "/repos/app"]],
    ["a joined --cli-path launch", ["--cli-path=/repos/app"]],
    ["a Linux folder open", ["file:///repos/app"]],
  ])("turns %s from targeted into cold", (_label, argv) => {
    expect(resolveLaunchIntent(argvSignals(argv))).toBe("targeted");
    expect(resolveLaunchIntent(argvSignals(stripLaunchTargets(argv)))).toBe("cold");
    expect(shouldRestoreWindowFleet(resolveLaunchIntent(argvSignals(stripLaunchTargets(argv))))).toBe(
      true
    );
  });

  it("leaves an already-cold launch cold", () => {
    expect(resolveLaunchIntent(argvSignals(stripLaunchTargets(["--disable-gpu"])))).toBe("cold");
  });

  it("cannot rescue a recovery launch — recovery still outranks everything", () => {
    // Safe mode restores one window on purpose; a relaunch marker must never
    // override that.
    expect(
      resolveLaunchIntent({ ...argvSignals(stripLaunchTargets(["--cli-path", "/a"])), isSafeMode: true })
    ).toBe("recovery");
  });
});
