import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));

import { shell } from "electron";
import { buildAllowedProtocols, canOpenExternalUrl, openExternalUrl } from "../openExternal.js";

const openExternalMock = shell.openExternal as ReturnType<typeof vi.fn>;

describe("buildAllowedProtocols", () => {
  it("always allows http, https, and mailto on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as NodeJS.Platform[]) {
      const set = buildAllowedProtocols(platform);
      expect(set.has("http:")).toBe(true);
      expect(set.has("https:")).toBe(true);
      expect(set.has("mailto:")).toBe(true);
    }
  });

  it("gates x-apple.systempreferences: to macOS only", () => {
    expect(buildAllowedProtocols("darwin").has("x-apple.systempreferences:")).toBe(true);
    expect(buildAllowedProtocols("win32").has("x-apple.systempreferences:")).toBe(false);
    expect(buildAllowedProtocols("linux").has("x-apple.systempreferences:")).toBe(false);
  });

  it("gates ms-settings: and ms-windows-store: to Windows only", () => {
    for (const scheme of ["ms-settings:", "ms-windows-store:"]) {
      expect(buildAllowedProtocols("win32").has(scheme)).toBe(true);
      expect(buildAllowedProtocols("darwin").has(scheme)).toBe(false);
      expect(buildAllowedProtocols("linux").has(scheme)).toBe(false);
    }
  });
});

describe("canOpenExternalUrl", () => {
  it("allows http and https URLs", () => {
    expect(canOpenExternalUrl("https://github.com/daintreehq/daintree")).toBe(true);
    expect(canOpenExternalUrl("http://example.com")).toBe(true);
    expect(canOpenExternalUrl("  https://example.com  ")).toBe(true);
  });

  it("rejects dangerous and unknown schemes", () => {
    expect(canOpenExternalUrl("file:///etc/passwd")).toBe(false);
    expect(canOpenExternalUrl("javascript:alert(1)")).toBe(false);
    expect(canOpenExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(canOpenExternalUrl("custom-scheme://do-something")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(canOpenExternalUrl("not a url")).toBe(false);
    expect(canOpenExternalUrl("")).toBe(false);
  });
});

describe("openExternalUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands allowed URLs to shell.openExternal", async () => {
    await openExternalUrl("https://github.com/daintreehq/daintree");
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    expect(openExternalMock).toHaveBeenCalledWith("https://github.com/daintreehq/daintree", {
      activate: true,
    });
  });

  it("throws on a disallowed protocol without calling shell.openExternal", async () => {
    await expect(openExternalUrl("file:///etc/passwd")).rejects.toThrow(/not allowed/);
    await expect(openExternalUrl("javascript:alert(1)")).rejects.toThrow(/not allowed/);
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it("throws on a malformed URL without calling shell.openExternal", async () => {
    await expect(openExternalUrl("not a url")).rejects.toThrow(/Invalid URL/);
    expect(openExternalMock).not.toHaveBeenCalled();
  });
});
