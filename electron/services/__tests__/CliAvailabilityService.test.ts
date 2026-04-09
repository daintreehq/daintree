/**
 * Tests for CliAvailabilityService - CLI command availability checking at startup and on-demand.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CliAvailabilityService } from "../CliAvailabilityService.js";
import { execFileSync } from "child_process";
import { refreshPath } from "../../setup/environment.js";

// Mock child_process execFileSync
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../../setup/environment.js", () => ({
  refreshPath: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs/promises for auth checks
vi.mock("fs/promises", () => ({
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  constants: { R_OK: 4 },
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
    it("returns 'installed' when binary found but no auth file (default)", async () => {
      // Mock all CLIs as available (binary found)
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const result = await service.checkAvailability();

      // All agents have authCheck config, so without auth files they return "installed"
      // (cursor has fallback: "installed" explicitly)
      for (const state of Object.values(result)) {
        expect(state).toBe("installed");
      }

      // Should have called execFileSync 7 times (once for each CLI)
      expect(mockedExecFileSync).toHaveBeenCalledTimes(7);

      // Verify stdio: "ignore" is passed to avoid hanging on TTY
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: "ignore" })
      );
    });

    it("returns 'ready' when binary found and auth file exists", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Binary found
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));
      // Auth file found
      mockedAccess.mockResolvedValue(undefined);

      const result = await service.checkAvailability();

      for (const state of Object.values(result)) {
        expect(state).toBe("ready");
      }
    });

    it("returns 'missing' when binary not found", async () => {
      // Mock all CLIs as not available
      mockedExecFileSync.mockImplementation(() => {
        throw new Error("Command not found");
      });

      const result = await service.checkAvailability();

      expect(result).toEqual({
        claude: "missing",
        gemini: "missing",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
        kiro: "missing",
        copilot: "missing",
      });
    });

    it("returns mixed states for different agents", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Only claude binary found
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "claude") {
          return Buffer.from("/usr/local/bin/claude");
        }
        throw new Error("Command not found");
      });

      // Auth file found (for claude)
      mockedAccess.mockResolvedValue(undefined);

      const result = await service.checkAvailability();

      expect(result.claude).toBe("ready");
      expect(result.gemini).toBe("missing");
      expect(result.codex).toBe("missing");
      expect(result.opencode).toBe("missing");
      expect(result.cursor).toBe("missing");
      expect(result.kiro).toBe("missing");
    });

    it("uses which on Unix-like systems", async () => {
      const originalPlatform = process.platform;

      try {
        Object.defineProperty(process, "platform", {
          value: "darwin",
          writable: true,
        });

        mockedExecFileSync.mockImplementation(() => Buffer.from(""));

        await service.checkAvailability();

        expect(mockedExecFileSync).toHaveBeenCalledWith(
          "which",
          expect.any(Array),
          expect.any(Object)
        );
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      }
    });

    it("uses where on Windows", async () => {
      const originalPlatform = process.platform;

      try {
        Object.defineProperty(process, "platform", {
          value: "win32",
          writable: true,
        });

        mockedExecFileSync.mockImplementation(() => Buffer.from(""));

        await service.checkAvailability();

        expect(mockedExecFileSync).toHaveBeenCalledWith(
          "where",
          expect.any(Array),
          expect.any(Object)
        );
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      }
    });

    it("calls refreshPath on first check (cold start)", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      await service.checkAvailability();

      expect(refreshPath).toHaveBeenCalledOnce();
    });

    it("does not call refreshPath on subsequent checks (warm cache)", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      await service.checkAvailability();
      vi.mocked(refreshPath).mockClear();

      await service.refresh();
      vi.mocked(refreshPath).mockClear();

      await service.checkAvailability();
      expect(refreshPath).not.toHaveBeenCalled();
    });

    it("deduplicates refreshPath across concurrent cold-start calls", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      await Promise.all([
        service.checkAvailability(),
        service.checkAvailability(),
        service.checkAvailability(),
      ]);

      expect(refreshPath).toHaveBeenCalledOnce();
    });

    it("caches results after first check", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const result1 = await service.checkAvailability();
      const result2 = service.getAvailability();

      expect(result1).toEqual(result2);
      expect(result2).not.toBeNull();
    });
  });

  describe("auth check with env var", () => {
    it("returns ready when OPENAI_API_KEY is set for codex", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-test-key";

      try {
        // Only codex binary found
        mockedExecFileSync.mockImplementation((_file, args) => {
          if (args?.[0] === "codex") return Buffer.from("");
          throw new Error("not found");
        });

        const result = await service.checkAvailability();
        expect(result.codex).toBe("ready");
      } finally {
        if (origKey === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = origKey;
        }
      }
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

      expect(cached).not.toBeNull();
      // All agents should have some state (not null)
      for (const state of Object.values(cached!)) {
        expect(["missing", "installed", "ready"]).toContain(state);
      }
    });
  });

  describe("refresh", () => {
    it("calls refreshPath before re-checking", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      await service.refresh();

      expect(refreshPath).toHaveBeenCalled();
    });

    it("re-checks availability and updates cache", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));
      await service.checkAvailability();

      vi.clearAllMocks();

      // Only claude available now
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "claude") {
          return Buffer.from("/usr/local/bin/claude");
        }
        throw new Error("Command not found");
      });

      const refreshed = await service.refresh();

      expect(refreshed.claude).not.toBe("missing");
      expect(refreshed.gemini).toBe("missing");
      expect(refreshed.codex).toBe("missing");

      expect(service.getAvailability()).toEqual(refreshed);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(7);
    });

    it("works on cold start before initial check", async () => {
      const freshService = new CliAvailabilityService();
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const result = await freshService.refresh();

      for (const state of Object.values(result)) {
        expect(["missing", "installed", "ready"]).toContain(state);
      }
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

      expect(executionOrder).toHaveLength(7);
      expect(executionOrder).toContain("claude");
      expect(executionOrder).toContain("gemini");
      expect(executionOrder).toContain("codex");
      expect(executionOrder).toContain("opencode");
      expect(executionOrder).toContain("cursor-agent");
      expect(executionOrder).toContain("kiro-cli");
      expect(executionOrder).toContain("copilot");
    });

    it("deduplicates concurrent checkAvailability calls", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const [result1, result2, result3] = await Promise.all([
        service.checkAvailability(),
        service.checkAvailability(),
        service.checkAvailability(),
      ]);

      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(7);
    });

    it("concurrent refresh calls each trigger a new check", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const [result1, result2] = await Promise.all([service.refresh(), service.refresh()]);

      expect(result1).toEqual(result2);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(14);
    });

    it("allows sequential checks after first completes", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      await service.checkAvailability();
      expect(mockedExecFileSync).toHaveBeenCalledTimes(7);

      vi.clearAllMocks();

      await service.refresh();
      expect(mockedExecFileSync).toHaveBeenCalledTimes(7);
    });
  });

  describe("security - command validation", () => {
    it("rejects commands with invalid characters in private checkCommand", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));
      await service.checkAvailability();

      const calls = mockedExecFileSync.mock.calls;
      calls.forEach((call) => {
        const args = call[1] as string[];
        const command = args[0];
        expect(command).toMatch(/^[a-zA-Z0-9._-]+$/);
      });
    });
  });
});
