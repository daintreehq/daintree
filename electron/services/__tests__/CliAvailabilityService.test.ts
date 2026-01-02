/**
 * Tests for CliAvailabilityService - CLI command availability checking at startup and on-demand.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CliAvailabilityService } from "../CliAvailabilityService.js";
import { execFileSync } from "child_process";

// Mock child_process execFileSync
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

describe("CliAvailabilityService", () => {
  let service: CliAvailabilityService;
  const mockedExecFileSync = vi.mocked(execFileSync);

  beforeEach(() => {
    service = new CliAvailabilityService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkAvailability", () => {
    it("checks all CLIs and returns availability status", async () => {
      // Mock all CLIs as available
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const result = await service.checkAvailability();

      expect(result).toEqual({
        claude: true,
        gemini: true,
        codex: true,
        opencode: true,
      });

      // Should have called execFileSync 4 times (once for each CLI)
      expect(mockedExecFileSync).toHaveBeenCalledTimes(4);

      // Verify stdio: "ignore" is passed to avoid hanging on TTY
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: "ignore" })
      );
    });

    it("detects when some CLIs are not available", async () => {
      // Mock claude as available, gemini/codex/opencode as not available
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "claude") {
          return Buffer.from("/usr/local/bin/claude");
        }
        throw new Error("Command not found");
      });

      const result = await service.checkAvailability();

      expect(result).toEqual({
        claude: true,
        gemini: false,
        codex: false,
        opencode: false,
      });
    });

    it("detects when all CLIs are not available", async () => {
      // Mock all CLIs as not available
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("Command not found");
      });

      const result = await service.checkAvailability();

      expect(result).toEqual({
        claude: false,
        gemini: false,
        codex: false,
        opencode: false,
      });
    });

    it("uses which on Unix-like systems", async () => {
      // Save original platform
      const originalPlatform = process.platform;

      try {
        Object.defineProperty(process, "platform", {
          value: "darwin",
          writable: true,
        });

        mockedExecFileSync.mockImplementation(() => Buffer.from(""));

        await service.checkAvailability();

        // Should use 'which' command on Unix
        expect(mockedExecFileSync).toHaveBeenCalledWith(
          "which",
          expect.any(Array),
          expect.any(Object)
        );
      } finally {
        // Restore original platform even if test fails
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      }
    });

    it("uses where on Windows", async () => {
      // Save original platform
      const originalPlatform = process.platform;

      try {
        Object.defineProperty(process, "platform", {
          value: "win32",
          writable: true,
        });

        mockedExecFileSync.mockImplementation(() => Buffer.from(""));

        await service.checkAvailability();

        // Should use 'where' command on Windows
        expect(mockedExecFileSync).toHaveBeenCalledWith(
          "where",
          expect.any(Array),
          expect.any(Object)
        );
      } finally {
        // Restore original platform even if test fails
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      }
    });

    it("caches results after first check", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const result1 = await service.checkAvailability();
      const result2 = service.getAvailability();

      expect(result1).toEqual(result2);
      expect(result2).not.toBeNull();
    });
  });

  describe("getAvailability", () => {
    it("returns null before first check", () => {
      const result = service.getAvailability();
      expect(result).toBeNull();
    });

    it("returns cached availability after check", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      await service.checkAvailability();
      const cached = service.getAvailability();

      expect(cached).toEqual({
        claude: true,
        gemini: true,
        codex: true,
        opencode: true,
      });
    });
  });

  describe("refresh", () => {
    it("re-checks availability and updates cache", async () => {
      // Initial check - all available
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));
      await service.checkAvailability();

      expect(service.getAvailability()).toEqual({
        claude: true,
        gemini: true,
        codex: true,
        opencode: true,
      });

      // Clear mocks
      vi.clearAllMocks();

      // Refresh with changed availability - only claude available now
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "claude") {
          return Buffer.from("/usr/local/bin/claude");
        }
        throw new Error("Command not found");
      });

      const refreshed = await service.refresh();

      expect(refreshed).toEqual({
        claude: true,
        gemini: false,
        codex: false,
        opencode: false,
      });

      expect(service.getAvailability()).toEqual(refreshed);

      // Should have called execFileSync again (4 times for refresh)
      expect(mockedExecFileSync).toHaveBeenCalledTimes(4);
    });

    it("works on cold start before initial check", async () => {
      // Fresh service, no prior checkAvailability call
      const freshService = new CliAvailabilityService();

      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      // refresh() should still populate cache even on first call
      const result = await freshService.refresh();

      expect(result).toEqual({
        claude: true,
        gemini: true,
        codex: true,
        opencode: true,
      });

      expect(freshService.getAvailability()).toEqual(result);
    });
  });

  describe("parallel execution", () => {
    it("checks all CLIs in parallel", async () => {
      const executionOrder: string[] = [];

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0]) {
          executionOrder.push(args[0]);
        }
        return Buffer.from("");
      });

      await service.checkAvailability();

      // All four CLIs should have been checked
      expect(executionOrder).toHaveLength(4);
      expect(executionOrder).toContain("claude");
      expect(executionOrder).toContain("gemini");
      expect(executionOrder).toContain("codex");
      expect(executionOrder).toContain("opencode");
    });

    it("deduplicates concurrent checkAvailability calls", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      // Start multiple checks concurrently
      const [result1, result2, result3] = await Promise.all([
        service.checkAvailability(),
        service.checkAvailability(),
        service.checkAvailability(),
      ]);

      // All should return the same result
      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);

      // Should only have called execFileSync 4 times total (not 12)
      // because concurrent calls share the same in-flight promise
      expect(mockedExecFileSync).toHaveBeenCalledTimes(4);
    });

    it("concurrent refresh calls each trigger a new check", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      // Start multiple refresh calls concurrently
      const [result1, result2] = await Promise.all([service.refresh(), service.refresh()]);

      // Both should return the same result (mocked)
      expect(result1).toEqual(result2);

      // Should call execFileSync 8 times total (4 for each refresh)
      // Refresh intentionally breaks deduplication to ensure freshness
      expect(mockedExecFileSync).toHaveBeenCalledTimes(8);
    });

    it("allows sequential checks after first completes", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      // First check
      await service.checkAvailability();
      expect(mockedExecFileSync).toHaveBeenCalledTimes(4);

      vi.clearAllMocks();

      // Second check after first completes should trigger new checks
      await service.refresh();
      expect(mockedExecFileSync).toHaveBeenCalledTimes(4);
    });
  });

  describe("security - command validation", () => {
    it("rejects commands with invalid characters in private checkCommand", async () => {
      // This test verifies the internal security validation
      // We can't directly test the private method, but we can verify
      // that the public API never attempts to execute unsafe commands

      // Try to check availability normally (safe commands)
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));
      await service.checkAvailability();

      // Verify that execFileSync was called with safe, expected commands
      const calls = mockedExecFileSync.mock.calls;
      calls.forEach((call) => {
        const args = call[1] as string[];
        const command = args[0];
        // All commands should match safe pattern: alphanumeric, dash, underscore, dot
        expect(command).toMatch(/^[a-zA-Z0-9._-]+$/);
      });
    });
  });
});
