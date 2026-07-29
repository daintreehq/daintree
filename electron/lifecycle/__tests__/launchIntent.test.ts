import { describe, it, expect } from "vitest";
import {
  resolveLaunchIntent,
  shouldRestoreWindowFleet,
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
