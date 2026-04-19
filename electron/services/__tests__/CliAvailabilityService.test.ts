/**
 * Tests for CliAvailabilityService - CLI command availability checking at startup and on-demand.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { homedir } from "os";
import { join } from "path";
import { CliAvailabilityService } from "../CliAvailabilityService.js";
import { execFile, execFileSync } from "child_process";
import { refreshPath } from "../../setup/environment.js";

// Mock child_process. Both `execFileSync` (sync shell probe) and `execFile`
// (async npx / WSL probes) are used by the service — mock both or the async
// probes will call `undefined(...)` and throw TypeErrors at runtime.
//
// `execFile` has an overloaded signature: (file, args, callback) or
// (file, args, options, callback). The default mock invokes whichever
// callback was passed with an ENOENT error so unmocked tests see the probe
// as "binary not found" rather than hanging on an un-invoked callback.
// `vi.hoisted` guarantees this runs before `vi.mock` factories despite the
// auto-hoisting that normally blocks reference to local bindings.
const { defaultExecFileImpl } = vi.hoisted(() => ({
  defaultExecFileImpl: (...args: unknown[]) => {
    const callback = args.find((a): a is (err: unknown) => void => typeof a === "function");
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    queueMicrotask(() => callback?.(err));
    return {} as never;
  },
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(defaultExecFileImpl),
}));

vi.mock("../../setup/environment.js", () => ({
  refreshPath: vi.fn().mockResolvedValue(undefined),
  expandWindowsEnvVars: vi.fn((s: string) =>
    s.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match)
  ),
}));

// Mock fs/promises for auth checks
vi.mock("fs/promises", () => ({
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  constants: { R_OK: 4, X_OK: 1 },
}));

describe("CliAvailabilityService", () => {
  let service: CliAvailabilityService;
  const mockedExecFileSync = vi.mocked(execFileSync);
  const mockedExecFile = vi.mocked(execFile);
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
    // Default async execFile (npx / WSL probes) to "not found" — clearAllMocks
    // wipes mock impls, so we reapply the factory default after each clear.
    mockedExecFile.mockImplementation(defaultExecFileImpl as never);
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

      // Should have called execFileSync 7 times (once for each CLI).
      // Fallback probes (native paths, npx, WSL) run via async execFile and
      // only fire when the which/where probe returns missing — in this test
      // every agent succeeds on the first probe, so execFileSync count
      // matches the registry size exactly.
      expect(mockedExecFileSync).toHaveBeenCalledTimes(7);

      // stdio is now [ignore, pipe, ignore] so we can capture the resolved
      // path from stdout while still suppressing any TTY output on stderr.
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] })
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

  describe("OpenCode auth check", () => {
    it("returns ready when OpenCode config file exists at XDG path", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Only opencode binary found
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "opencode") return Buffer.from("");
        throw new Error("not found");
      });

      // XDG-compliant config file exists
      const opencodeConfig = join(homedir(), ".config/opencode/opencode.json");
      mockedAccess.mockImplementation(async (path) => {
        if (String(path) === opencodeConfig) return;
        throw new Error("ENOENT");
      });

      const result = await service.checkAvailability();
      expect(result.opencode).toBe("ready");
    });

    it("returns ready when ANTHROPIC_API_KEY is set for OpenCode", async () => {
      const origKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

      try {
        // Only opencode binary found, no config file
        mockedExecFileSync.mockImplementation((_file, args) => {
          if (args?.[0] === "opencode") return Buffer.from("");
          throw new Error("not found");
        });

        const result = await service.checkAvailability();
        expect(result.opencode).toBe("ready");
      } finally {
        if (origKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = origKey;
        }
      }
    });

    it("returns ready when OPENAI_API_KEY is set for OpenCode", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-openai-test-key";

      try {
        // Only opencode binary found, no config file
        mockedExecFileSync.mockImplementation((_file, args) => {
          if (args?.[0] === "opencode") return Buffer.from("");
          throw new Error("not found");
        });

        const result = await service.checkAvailability();
        expect(result.opencode).toBe("ready");
      } finally {
        if (origKey === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = origKey;
        }
      }
    });

    it("returns ready when GOOGLE_API_KEY is set for OpenCode", async () => {
      const origKey = process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_API_KEY = "google-test-key";

      try {
        // Only opencode binary found, no config file
        mockedExecFileSync.mockImplementation((_file, args) => {
          if (args?.[0] === "opencode") return Buffer.from("");
          throw new Error("not found");
        });

        const result = await service.checkAvailability();
        expect(result.opencode).toBe("ready");
      } finally {
        if (origKey === undefined) {
          delete process.env.GOOGLE_API_KEY;
        } else {
          process.env.GOOGLE_API_KEY = origKey;
        }
      }
    });

    it("returns installed when OpenCode binary found but no auth (no config, no env vars)", async () => {
      // Only opencode binary found, no config file, no env vars
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "opencode") return Buffer.from("");
        throw new Error("not found");
      });

      const result = await service.checkAvailability();
      expect(result.opencode).toBe("installed");
    });

    it("env vars take precedence over config file for OpenCode", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-precedence-test";

      try {
        // Only opencode binary found
        mockedExecFileSync.mockImplementation((_file, args) => {
          if (args?.[0] === "opencode") return Buffer.from("");
          throw new Error("not found");
        });

        const result = await service.checkAvailability();
        expect(result.opencode).toBe("ready");

        // Verify config file was never checked (env var short-circuited)
        const configChecked = mockedAccess.mock.calls.some((call) =>
          String(call[0]).includes("opencode")
        );
        expect(configChecked).toBe(false);
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
        // Make fs.access hang forever ONLY for copilot's auth config path so
        // the Copilot auth check race is decided by the timeout branch. Other
        // agents' fs.access probes (e.g. Claude's native-path probe) must
        // resolve quickly with ENOENT; otherwise they'd hang forever too and
        // the outer check timeout would never be reached under fake timers.
        const copilotConfig = join(homedir(), ".copilot/config.json");
        mockedAccess.mockImplementation(async (p) => {
          if (String(p) === copilotConfig) {
            return new Promise(() => {});
          }
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });

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

  describe("blocked state (security software / permissions)", () => {
    it("reports 'blocked' when which throws EPERM (Santa / CrowdStrike / Defender)", async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      });

      const result = await service.checkAvailability();

      // Every agent surfaces as blocked — the shell probe couldn't tell
      // them apart, but "blocked" is the common, actionable verdict.
      for (const state of Object.values(result)) {
        expect(state).toBe("blocked");
      }

      const details = service.getDetails();
      expect(details).not.toBeNull();
      expect(details!.claude?.state).toBe("blocked");
      expect(details!.claude?.blockReason).toBe("security");
      expect(details!.claude?.message).toMatch(/EPERM/);
    });

    it("reports 'blocked' when which throws EACCES", async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      });

      const result = await service.checkAvailability();

      for (const state of Object.values(result)) {
        expect(state).toBe("blocked");
      }

      const details = service.getDetails();
      expect(details!.claude?.blockReason).toBe("security");
    });

    it("reports 'blocked' when a native-path binary exists but fs.access returns EACCES", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Force the shell probe to miss Claude so the native path fallback runs.
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "claude") {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        }
        return Buffer.from("");
      });

      // The home-relative claude path is probed — return EACCES for it.
      const claudeNative = join(homedir(), ".local/bin/claude");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === claudeNative) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result.claude).toBe("blocked");

      const details = service.getDetails();
      expect(details!.claude?.state).toBe("blocked");
      expect(details!.claude?.resolvedPath).toBe(claudeNative);
      expect(details!.claude?.blockReason).toBe("permissions");
      expect(details!.claude?.via).toBe("native");
    });
  });

  describe("native path fallback", () => {
    it("detects Claude via ~/.local/bin/claude when PATH lookup fails", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Shell probe fails for claude.
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "claude") {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        }
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      // Native Claude path exists and is executable.
      const claudeNative = join(homedir(), ".local/bin/claude");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === claudeNative) return;
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      // No auth file found, but binary discovered via native path → "installed".
      expect(result.claude).toBe("installed");

      const details = service.getDetails();
      expect(details!.claude?.resolvedPath).toBe(claudeNative);
      expect(details!.claude?.via).toBe("native");
    });

    it("captures the resolved path from `which` stdout", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (args?.[0] === "claude") {
          return Buffer.from("/opt/homebrew/bin/claude\n");
        }
        return Buffer.from("");
      });

      await service.checkAvailability();

      const details = service.getDetails();
      expect(details!.claude?.resolvedPath).toBe("/opt/homebrew/bin/claude");
      expect(details!.claude?.via).toBe("which");
    });

    it("only probes native paths after which/where returns ENOENT", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => Buffer.from("/usr/local/bin/claude"));

      await service.checkAvailability();

      // No agent ever needs the native fallback because `which` succeeded
      // for every agent — fs.access must not be called for the Claude
      // native path probe. (Auth-file probes still run via fs.access, so
      // filter to Claude-specific executable probes.)
      const nativeProbes = mockedAccess.mock.calls.filter(
        (call) =>
          String(call[0]).includes(".local/bin/claude") ||
          String(call[0]).includes("claude-code\\bin\\claude.exe")
      );
      expect(nativeProbes).toHaveLength(0);
    });
  });

  describe("getDetails()", () => {
    it("returns null before any check runs", () => {
      expect(service.getDetails()).toBeNull();
    });

    it("returns populated details after checkAvailability()", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from("/usr/local/bin/example"));

      await service.checkAvailability();
      const details = service.getDetails();

      expect(details).not.toBeNull();
      expect(Object.keys(details!)).toContain("claude");
      expect(details!.claude?.resolvedPath).toBe("/usr/local/bin/example");
      expect(details!.claude?.via).toBe("which");
    });

    it("refreshes details when checkAvailability() reruns with different results", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from("/usr/local/bin/claude"));
      await service.checkAvailability();
      expect(service.getDetails()!.claude?.state).not.toBe("missing");

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      await service.refresh();

      // With shell + native + npx all missing, state is "missing".
      expect(service.getDetails()!.claude?.state).toBe("missing");
      expect(service.getDetails()!.claude?.resolvedPath).toBeNull();
    });
  });

  describe("npx fallback probe", () => {
    it("detects agent via npx --prefer-offline --no <pkg> --version on cache hit", async () => {
      // Shell probe misses for Gemini (no native paths either, so npx is the
      // only remaining layer). Mock execFile to succeed only for Gemini's pkg.
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      mockedExecFile.mockImplementation(((...args: unknown[]) => {
        const argv = args[1] as string[];
        const callback = args.find(
          (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
        );
        // Only @google/gemini-cli succeeds; everything else ENOENTs.
        if (argv?.includes("@google/gemini-cli")) {
          queueMicrotask(() => callback?.(null, "1.2.3"));
        } else {
          const err = Object.assign(new Error("not found"), { code: "ENOENT" });
          queueMicrotask(() => callback?.(err));
        }
        return {} as never;
      }) as never);

      const result = await service.checkAvailability();
      expect(result.gemini).toBe("installed");

      const details = service.getDetails();
      expect(details!.gemini?.via).toBe("npx");
      expect(details!.gemini?.resolvedPath).toBe("npx:@google/gemini-cli");

      // Verify the exact probe args used — guards against regressions in the
      // deprecation-safe `--prefer-offline --no` invocation form.
      const geminiCall = mockedExecFile.mock.calls.find((c) =>
        (c[1] as string[])?.includes("@google/gemini-cli")
      );
      expect(geminiCall?.[1]).toEqual([
        "--prefer-offline",
        "--no",
        "@google/gemini-cli",
        "--version",
      ]);
    });

    it("classifies npx EPERM as 'blocked' (endpoint security blocks npx itself)", async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      mockedExecFile.mockImplementation(((...args: unknown[]) => {
        const callback = args.find((a): a is (err: unknown) => void => typeof a === "function");
        const err = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        queueMicrotask(() => callback?.(err));
        return {} as never;
      }) as never);

      const result = await service.checkAvailability();
      // Every agent with an npxPackage hits EPERM at the npx layer → blocked.
      // Agents without npxPackage (cursor, kiro, opencode, copilot) still
      // report missing since they have no fallback.
      expect(result.claude).toBe("blocked");
      expect(result.gemini).toBe("blocked");
      expect(result.codex).toBe("blocked");

      const details = service.getDetails();
      expect(details!.claude?.blockReason).toBe("security");
      expect(details!.claude?.via).toBe("npx");
    });

    it("skips npx probe for agents without npxPackage in the registry", async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      await service.checkAvailability();

      // Agents with npxPackage: claude, gemini, codex → 3 npx probes.
      // Cursor/Kiro/Opencode/Copilot must NOT appear in execFile calls.
      const npxPackages = mockedExecFile.mock.calls
        .map((c) => c[1] as string[])
        .map((args) => args?.find((a) => a.startsWith("@") || a === "opencode-ai"))
        .filter(Boolean);
      expect(npxPackages).toEqual(
        expect.arrayContaining(["@anthropic-ai/claude-code", "@google/gemini-cli", "@openai/codex"])
      );
      expect(npxPackages).toHaveLength(3);
    });
  });

  describe("WSL fallback probe (Windows)", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    });

    it("detects Codex via WSL when shell, native, and npx all miss", async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      mockedExecFile.mockImplementation(((...args: unknown[]) => {
        const argv = args[1] as string[];
        const callback = args.find(
          (a): a is (err: unknown, stdout?: unknown) => void => typeof a === "function"
        );

        // wsl.exe --list --quiet: return a UTF-16LE-encoded distro list
        // with a BOM, simulating older Windows builds that don't honor
        // WSL_UTF8=1.
        if (argv?.[0] === "--list") {
          const utf16 = Buffer.concat([
            Buffer.from([0xff, 0xfe]), // BOM
            Buffer.from("Ubuntu\r\nDebian\r\n", "utf16le"),
          ]);
          queueMicrotask(() => callback?.(null, utf16));
          return {} as never;
        }

        // wsl.exe -d Ubuntu -e codex --version: succeed for codex.
        if (argv?.[0] === "-d" && argv?.[3] === "codex") {
          queueMicrotask(() => callback?.(null, "codex 1.0.0"));
          return {} as never;
        }

        const err = Object.assign(new Error("not found"), { code: "ENOENT" });
        queueMicrotask(() => callback?.(err));
        return {} as never;
      }) as never);

      const result = await service.checkAvailability();
      // WSL-detected agents are capped at "installed" — launching through
      // wsl.exe from the PTY host isn't wired up yet, so surfacing them as
      // "ready" would lead to silent-ENOENT clicks.
      expect(result.codex).toBe("installed");

      const details = service.getDetails();
      expect(details!.codex?.via).toBe("wsl");
      expect(details!.codex?.wslDistro).toBe("Ubuntu");
      expect(details!.codex?.resolvedPath).toBe("wsl:Ubuntu");
      expect(details!.codex?.message).toMatch(/WSL/);
    });

    it("skips WSL probe for agents without supportsWsl flag", async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      await service.checkAvailability();

      // wsl.exe should never appear in execFile calls — only Codex has
      // supportsWsl: true, and Codex's npx probe fails first under the
      // default mock, but WSL probing requires reaching the WSL layer.
      // Even for Codex, the WSL probe fires only if npx misses — default
      // execFile returns ENOENT, so WSL *is* reached for Codex. Verify
      // via the file arg that no NON-Codex agent triggered wsl.exe.
      const wslCalls = mockedExecFile.mock.calls.filter((c) => c[0] === "wsl.exe");
      // Two expected calls: --list (to enumerate distros) + one -d probe.
      // Those fire because Codex has supportsWsl. No agent besides Codex
      // should produce wsl.exe invocations.
      for (const call of wslCalls) {
        const argv = call[1] as string[];
        if (argv?.includes("-e")) {
          // Command arg sits after `-e`.
          const cmdIdx = argv.indexOf("-e");
          expect(argv[cmdIdx + 1]).toBe("codex");
        }
      }
    });
  });
});
