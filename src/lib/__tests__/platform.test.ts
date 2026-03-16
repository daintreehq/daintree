import { describe, it, expect, vi, afterEach } from "vitest";

const originalNavigator = globalThis.navigator;

function stubNavigator(userAgent: string, platform: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent, platform },
    writable: true,
    configurable: true,
  });
}

function restoreNavigator() {
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  restoreNavigator();
  vi.resetModules();
});

describe("isLinux", () => {
  it("returns true for a Linux user agent", async () => {
    stubNavigator(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Electron/40.0.0",
      "Linux x86_64"
    );
    const { isLinux } = await import("../platform");
    expect(isLinux()).toBe(true);
  });

  it("returns false for a macOS user agent", async () => {
    stubNavigator(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Electron/40.0.0",
      "MacIntel"
    );
    const { isLinux } = await import("../platform");
    expect(isLinux()).toBe(false);
  });

  it("returns false for a Windows user agent", async () => {
    stubNavigator(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Electron/40.0.0",
      "Win32"
    );
    const { isLinux } = await import("../platform");
    expect(isLinux()).toBe(false);
  });
});

describe("isMac", () => {
  it("returns true for a macOS platform", async () => {
    stubNavigator("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", "MacIntel");
    const { isMac } = await import("../platform");
    expect(isMac()).toBe(true);
  });

  it("returns false for a Linux platform", async () => {
    stubNavigator("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36", "Linux x86_64");
    const { isMac } = await import("../platform");
    expect(isMac()).toBe(false);
  });
});
