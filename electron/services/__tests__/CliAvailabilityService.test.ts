/**
 * Tests for CliAvailabilityService - CLI command availability checking at startup and on-demand.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { homedir } from "os";
import { join } from "path";
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
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  const savedEnv: Record<string, string | undefined> = {};
  // Auth env vars consulted by AgentAuthCheck.envVar across the built-in
  // registry. Clear them so local dev shells (which commonly have these set)
  // don't cause the "no auth file" assertions to flip to "ready".
  const envKeysToClear = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "COPILOT_GITHUB_TOKEN",
  ];

  beforeEach(async () => {
    // Isolate from any local env vars that would turn auth checks into "ready".
    for (const key of envKeysToClear) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    service = new CliAvailabilityService();
    vi.clearAllMocks();
    // Re-establish default "file not found" behavior for fs access. A prior
    // test may have set mockResolvedValue on the same vi.fn(), and
    // clearAllMocks() clears call history but NOT implementations.
    const fs = await import("fs/promises");
    vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
    // Silence the diagnostic fallback log emitted by checkAuth() so
    // the test runner output stays clean. Individual tests re-access
    // the spy via `consoleLogSpy` to assert on log calls.
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of envKeysToClear) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
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

  describe("auth check paths (regression guards)", () => {
    it("does NOT probe the bogus Kiro paths (.kiro/credentials, .kiro/config.json)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Only kiro-cli binary found; no auth files exist
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "kiro-cli") return Buffer.from("");
        throw new Error("not found");
      });
      mockedAccess.mockRejectedValue(new Error("ENOENT"));

      const result = await service.checkAvailability();

      // Without an SSO token cache, Kiro falls back to "installed" — non-SSO
      // auth is keychain-based and not probed.
      expect(result.kiro).toBe("installed");

      const probedPaths = mockedAccess.mock.calls.map((call) => String(call[0]));
      // .kiro/credentials and .kiro/config.json are not real Kiro auth files
      // and must never be probed (regression guard for prior bogus paths).
      expect(probedPaths).not.toContain(join(homedir(), ".kiro/credentials"));
      expect(probedPaths).not.toContain(join(homedir(), ".kiro/config.json"));
    });

    it("reaches 'ready' for Kiro when AWS SSO token cache exists", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "kiro-cli") return Buffer.from("");
        throw new Error("not found");
      });

      const ssoTokenPath = join(homedir(), ".aws/sso/cache/kiro-auth-token.json");
      mockedAccess.mockImplementation(async (path) => {
        if (String(path) === ssoTokenPath) return;
        throw new Error("ENOENT");
      });

      const result = await service.checkAvailability();
      expect(result.kiro).toBe("ready");

      // Upper-bound guard: the only Kiro auth file probed must be the SSO
      // token cache. Catches any future reintroduction of extra Kiro paths.
      const kiroProbedPaths = mockedAccess.mock.calls
        .map((call) => String(call[0]))
        .filter((p) => p.includes(".kiro") || p.includes("kiro-auth-token"));
      expect(kiroProbedPaths).toEqual([ssoTokenPath]);
    });

    it("probes only .copilot/config.json for Copilot (NOT .config/gh/hosts.yml)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Only copilot binary found
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "copilot") return Buffer.from("");
        throw new Error("not found");
      });

      const result = await service.checkAvailability();
      expect(result.copilot).toBe("installed");

      const probedPaths = mockedAccess.mock.calls.map((call) => String(call[0]));
      expect(probedPaths).toContain(join(homedir(), ".copilot/config.json"));
      // gh/hosts.yml is populated by any `gh auth login`, not Copilot-specific,
      // so probing it produces false positives. Must not be in the probe list.
      expect(probedPaths).not.toContain(join(homedir(), ".config/gh/hosts.yml"));
    });

    it("reaches 'ready' for Copilot when .copilot/config.json exists", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "copilot") return Buffer.from("");
        throw new Error("not found");
      });

      const copilotConfig = join(homedir(), ".copilot/config.json");
      mockedAccess.mockImplementation(async (path) => {
        if (String(path) === copilotConfig) return;
        throw new Error("ENOENT");
      });

      const result = await service.checkAvailability();
      expect(result.copilot).toBe("ready");
    });
  });

  describe("diagnostic logging for auth fallback", () => {
    it("logs exactly once when auth check falls through to fallback", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "copilot") return Buffer.from("");
        throw new Error("not found");
      });

      const result = await service.checkAvailability();
      expect(result.copilot).toBe("installed");

      const copilotLogs = consoleLogSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes("GitHub Copilot: binary found, auth check fell through")
      );
      // Must fire exactly once — guards against the Promise.race leak where
      // a slow fs.access would log after the timeout branch already resolved.
      expect(copilotLogs).toHaveLength(1);
      const message = String(copilotLogs[0][0]);
      expect(message).toContain("[CliAvailabilityService]");
      expect(message).toContain(join(".copilot", "config.json"));
      expect(message).toContain('-> "installed"');
    });

    it("logs Kiro fallback listing the AWS SSO token path that was checked", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "kiro-cli") return Buffer.from("");
        throw new Error("not found");
      });
      mockedAccess.mockRejectedValue(new Error("ENOENT"));

      await service.checkAvailability();

      const kiroLog = consoleLogSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("Kiro")
      );
      expect(kiroLog).toBeDefined();
      expect(String(kiroLog![0])).toContain(join(".aws", "sso", "cache", "kiro-auth-token.json"));
      expect(String(kiroLog![0])).toContain('-> "installed"');
    });

    it("does NOT log when auth check is short-circuited by envVar (OPENAI_API_KEY)", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "codex") return Buffer.from("");
        throw new Error("not found");
      });

      const result = await service.checkAvailability();
      expect(result.codex).toBe("ready");

      const codexLog = consoleLogSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("Codex")
      );
      expect(codexLog).toBeUndefined();
    });

    it("does NOT emit a fallback log when the auth check timed out", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      vi.useFakeTimers();
      try {
        mockedExecFileSync.mockImplementation((_file, args) => {
          if (args?.[0] === "copilot") return Buffer.from("");
          throw new Error("not found");
        });
        // Make fs.access hang forever so only the timeout can resolve the race.
        mockedAccess.mockImplementation(() => new Promise(() => {}));

        const checkPromise = service.checkAvailability();
        // Advance past AUTH_CHECK_TIMEOUT_MS (3s) to resolve the timeout branch.
        await vi.advanceTimersByTimeAsync(4_000);
        const result = await checkPromise;

        expect(result.copilot).toBe("installed");

        const copilotLogs = consoleLogSpy.mock.calls.filter((call: unknown[]) =>
          String(call[0]).includes("GitHub Copilot: binary found, auth check fell through")
        );
        // No fallback log should fire — the timeout decided the state.
        expect(copilotLogs).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT log when auth file is found (success path)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "copilot") return Buffer.from("");
        throw new Error("not found");
      });
      mockedAccess.mockResolvedValue(undefined);

      await service.checkAvailability();

      const copilotLog = consoleLogSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("GitHub Copilot: binary found, auth check fell through")
      );
      expect(copilotLog).toBeUndefined();
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
