import { describe, it, expect } from "vitest";

import { assistantPlatformSupport } from "../assistantPlatform.js";

/**
 * Where Daintree runs its own assistant engine.
 *
 * Not a policy invented here: the engine takes an exclusive per-project lease before it
 * opens its database, through a lock whose non-unix implementation returns an error
 * rather than pretending to exclude — so on Windows it does not degrade, it fails to
 * boot. Daintree bundles the binary there regardless, so without this gate the feature
 * was presented as working and failed at first use.
 */

describe("assistantPlatformSupport", () => {
  it("runs where Daintree supports the engine", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(assistantPlatformSupport(platform).supported, platform).toBe(true);
    }
  });

  it("refuses Windows, and anything it has not been shipped on", () => {
    // Windows is the case that ships. The rest are here for the DIRECTION of the
    // fallback: an unrecognised platform is refused rather than assumed to work, because
    // being wrong that way costs an explained limitation, and being wrong the other way
    // costs a child process that dies at boot.
    for (const platform of ["win32", "plan9", "", "unknown"]) {
      expect(assistantPlatformSupport(platform).supported, platform).toBe(false);
    }
  });

  it("names Windows when it is Windows, and stays general when it is not", () => {
    const windows = assistantPlatformSupport("win32");
    const other = assistantPlatformSupport("plan9");
    expect(windows.supported).toBe(false);
    expect(other.supported).toBe(false);
    if (windows.supported || other.supported) return;
    // Copy that says "Windows" to a plan9 user is worse than copy that says nothing.
    expect(windows.reason).toMatch(/windows/i);
    expect(other.reason).not.toMatch(/windows/i);
  });

  it("says what to do instead", () => {
    const support = assistantPlatformSupport("win32");
    expect(support.supported).toBe(false);
    if (support.supported) return;
    // An unsupported state with no route out is a support ticket by construction, so the
    // detail has to name something the user can actually do.
    expect(support.detail).toMatch(/settings/i);
    // Microcopy rule: the headline is a title, so no trailing period.
    expect(support.reason.endsWith(".")).toBe(false);
  });

  it("describes the engine, not the panel", () => {
    // The panel still works — it hosts Claude, Codex and the rest. Copy that says "the
    // Daintree Assistant isn't available" and then explains other agents work inside it
    // contradicts itself.
    const support = assistantPlatformSupport("win32");
    if (support.supported) return;
    expect(support.reason).not.toMatch(/daintree assistant isn't available/i);
  });
});
