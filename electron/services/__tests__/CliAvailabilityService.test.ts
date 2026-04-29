/**
 * Tests for CliAvailabilityService - CLI command availability checking at startup and on-demand.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { homedir } from "os";
import { join } from "path";
import { CliAvailabilityService } from "../CliAvailabilityService.js";
import { execFile, execFileSync } from "child_process";
import { refreshPath } from "../../setup/environment.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { CHANNELS } from "../../ipc/channels.js";

// Mock child_process. Both `execFileSync` (sync shell probe) and `execFile`
// (async npm-global / WSL probes) are used by the service — mock both or
// the async probes will call `undefined(...)` and throw TypeErrors at runtime.
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

// Mock the electron-store singleton so duplicate-detection persistence
// stays in-memory across the test run. Each test re-seeds via beforeEach.
const { storeBackingMap } = vi.hoisted(() => ({
  storeBackingMap: new Map<string, unknown>(),
}));
vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => storeBackingMap.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      storeBackingMap.set(key, value);
    }),
    delete: vi.fn((key: string) => {
      storeBackingMap.delete(key);
    }),
    has: vi.fn((key: string) => storeBackingMap.has(key)),
  },
}));

// Mock the IPC broadcast so duplicate-detection emits can be asserted
// without spinning up real BrowserWindows. The CHANNELS module is real
// (no mock) — the duplicate-emit code uses CHANNELS.NOTIFICATION_SHOW_TOAST.
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));

/**
 * Extract the command name from a `which`/`where` args array. On Unix the
 * service now invokes `which -a <cmd>` (#6054), so the command is the last
 * element; on Windows it remains `where <cmd>`. The command always sits at
 * the tail of the args array, so this works on both platforms.
 */
const cmdOf = (args: unknown): string | undefined => {
  if (!Array.isArray(args) || args.length === 0) return undefined;
  return args[args.length - 1] as string;
};

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
    "DAINTREE_CLI_PATH_PREPEND",
  ];

  beforeEach(async () => {
    // Isolate from any local env vars that would turn auth checks into "ready".
    for (const key of envKeysToClear) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    service = new CliAvailabilityService();
    // Reset the in-memory store between tests so duplicate-cli milestone
    // flags don't leak across cases.
    storeBackingMap.clear();
    vi.clearAllMocks();
    // Re-establish default "file not found" behavior for fs access. A prior
    // test may have set mockResolvedValue on the same vi.fn(), and
    // clearAllMocks() clears call history but NOT implementations.
    const fs = await import("fs/promises");
    vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT"));
    // Default async execFile (npm-global / WSL probes) to "not found" —
    // clearAllMocks wipes mock impls, so we reapply the factory default after each clear.
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
    it("returns 'unauthenticated' when binary found but no auth file exists (decoupled from auth)", async () => {
      // Mock all CLIs as available (binary found)
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const result = await service.checkAvailability();

      // Binary-on-PATH without auth is now `unauthenticated`, not `ready`.
      // The CLI is still launchable — auth discovery populates
      // `detail.authConfirmed` but the state signalled is distinct so
      // the UI can show a "Login required" nudge.
      for (const state of Object.values(result)) {
        expect(state).toBe("unauthenticated");
      }

      const details = service.getDetails();
      expect(details).not.toBeNull();
      for (const detail of Object.values(details!)) {
        expect(detail?.state).toBe("unauthenticated");
        expect(detail?.authConfirmed).toBe(false);
      }

      // Should have called execFileSync 10 times (once for each CLI).
      // Fallback probes (native paths, npm-global, WSL) run via async execFile and
      // only fire when the which/where probe returns missing — in this test
      // every agent succeeds on the first probe, so execFileSync count
      // matches the registry size exactly.
      expect(mockedExecFileSync).toHaveBeenCalledTimes(10);

      // stdio is now [ignore, pipe, ignore] so we can capture the resolved
      // path from stdout while still suppressing any TTY output on stderr.
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] })
      );
    });

    it("returns 'ready' with authConfirmed=true when binary found and auth file exists", async () => {
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

      const details = service.getDetails();
      for (const detail of Object.values(details!)) {
        expect(detail?.authConfirmed).toBe(true);
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
        goose: "missing",
        crush: "missing",
        qwen: "missing",
      });
    });

    it("returns mixed states for different agents", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Only claude binary found
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "claude") {
          return Buffer.from("/usr/local/bin/claude");
        }
        throw new Error("Command not found");
      });

      // Auth config files succeed; native-install bin probes (cursor-agent,
      // opencode) must fail — otherwise the native-path fallback would flip
      // them to "ready" and defeat the "only claude is available" premise.
      mockedAccess.mockImplementation(async (p) => {
        const pathStr = String(p);
        if (pathStr.includes("/bin/") || pathStr.includes("cursor-agent.app")) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return undefined;
      });

      const result = await service.checkAvailability();

      expect(result.claude).toBe("ready");
      expect(result.gemini).toBe("missing");
      expect(result.codex).toBe("missing");
      expect(result.opencode).toBe("missing");
      expect(result.cursor).toBe("missing");
      expect(result.kiro).toBe("missing");
      expect(result.goose).toBe("missing");
      expect(result.qwen).toBe("missing");
    });

    it("prefers DAINTREE_CLI_PATH_PREPEND over shell resolution", async () => {
      const { access, constants } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      process.env.DAINTREE_CLI_PATH_PREPEND = "/tmp/daintree-fake-bin";

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "claude") {
          return Buffer.from("/usr/local/bin/claude");
        }
        throw new Error("Command not found");
      });
      mockedAccess.mockImplementation(async (p, mode) => {
        if (String(p) === "/tmp/daintree-fake-bin/claude" && mode === constants.X_OK) {
          return;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();

      expect(result.claude).toBe("unauthenticated");
      expect(service.getDetails()?.claude?.resolvedPath).toBe("/tmp/daintree-fake-bin/claude");
      expect(mockedExecFileSync).not.toHaveBeenCalledWith(
        "which",
        ["-a", "claude"],
        expect.any(Object)
      );
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
          if (cmdOf(args) === "codex") return Buffer.from("");
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
        if (cmdOf(args) === "opencode") return Buffer.from("");
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
          if (cmdOf(args) === "opencode") return Buffer.from("");
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
          if (cmdOf(args) === "opencode") return Buffer.from("");
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
          if (cmdOf(args) === "opencode") return Buffer.from("");
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

    it("returns ready with authConfirmed=false when OpenCode binary found but no auth", async () => {
      // Only opencode binary found, no config file, no env vars
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "opencode") return Buffer.from("");
        throw new Error("not found");
      });

      const result = await service.checkAvailability();
      // Binary on PATH is sufficient for `ready`; the missing credential
      // surfaces as `authConfirmed: false` for onboarding UI.
      expect(result.opencode).toBe("unauthenticated");
      expect(service.getDetails()!.opencode?.authConfirmed).toBe(false);
    });

    it("env vars take precedence over config file for OpenCode", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      const origKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-precedence-test";

      try {
        // Only opencode binary found
        mockedExecFileSync.mockImplementation((_file, args) => {
          if (cmdOf(args) === "opencode") return Buffer.from("");
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
        expect(["missing", "installed", "ready", "blocked", "unauthenticated"]).toContain(state);
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
        if (cmdOf(args) === "claude") {
          return Buffer.from("/usr/local/bin/claude");
        }
        throw new Error("Command not found");
      });

      const refreshed = await service.refresh();

      expect(refreshed.claude).not.toBe("missing");
      expect(refreshed.gemini).toBe("missing");
      expect(refreshed.codex).toBe("missing");

      expect(service.getAvailability()).toEqual(refreshed);
      // 10 successful primary calls + 9 BusyBox-style bare-`which` retries
      // (the 9 agents whose mock throws a generic `Error` with no errno
      // code — which `probeViaShell` retries without `-a` to recover
      // BusyBox/minimal `which` builds that reject the flag).
      expect(mockedExecFileSync).toHaveBeenCalledTimes(19);
    });

    it("works on cold start before initial check", async () => {
      const freshService = new CliAvailabilityService();
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const result = await freshService.refresh();

      for (const state of Object.values(result)) {
        expect(["missing", "installed", "ready", "blocked", "unauthenticated"]).toContain(state);
      }
      expect(freshService.getAvailability()).toEqual(result);
    });
  });

  describe("parallel execution", () => {
    it("checks all CLIs in parallel", async () => {
      const executionOrder: string[] = [];

      mockedExecFileSync.mockImplementation((_file, args) => {
        const cmd = cmdOf(args);
        if (cmd) executionOrder.push(cmd);
        return Buffer.from("");
      });

      await service.checkAvailability();

      expect(executionOrder).toHaveLength(10);
      expect(executionOrder).toContain("claude");
      expect(executionOrder).toContain("gemini");
      expect(executionOrder).toContain("codex");
      expect(executionOrder).toContain("opencode");
      expect(executionOrder).toContain("cursor-agent");
      expect(executionOrder).toContain("kiro-cli");
      expect(executionOrder).toContain("copilot");
      expect(executionOrder).toContain("goose");
      expect(executionOrder).toContain("crush");
      expect(executionOrder).toContain("qwen");
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
      expect(mockedExecFileSync).toHaveBeenCalledTimes(10);
    });

    it("concurrent refresh calls each trigger a new check", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const [result1, result2] = await Promise.all([service.refresh(), service.refresh()]);

      expect(result1).toEqual(result2);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(20);
    });

    it("allows sequential checks after first completes", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      await service.checkAvailability();
      expect(mockedExecFileSync).toHaveBeenCalledTimes(10);

      vi.clearAllMocks();

      await service.refresh();
      expect(mockedExecFileSync).toHaveBeenCalledTimes(10);
    });
  });

  describe("auth check paths (regression guards)", () => {
    it("does NOT probe the bogus Kiro paths (.kiro/credentials, .kiro/config.json)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Only kiro-cli binary found; no auth files exist
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "kiro-cli") return Buffer.from("");
        throw new Error("not found");
      });
      mockedAccess.mockRejectedValue(new Error("ENOENT"));

      const result = await service.checkAvailability();

      // Binary on PATH + no credential detected → `unauthenticated`.
      expect(result.kiro).toBe("unauthenticated");
      expect(service.getDetails()!.kiro?.authConfirmed).toBe(false);

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
        if (cmdOf(args) === "kiro-cli") return Buffer.from("");
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
        if (cmdOf(args) === "copilot") return Buffer.from("");
        throw new Error("not found");
      });

      const result = await service.checkAvailability();
      // Binary on PATH is launchable regardless of auth; keychain-auth users
      // still reach `ready` and see `authConfirmed: false` until the CLI
      // prompts them to sign in.
      expect(result.copilot).toBe("unauthenticated");
      expect(service.getDetails()!.copilot?.authConfirmed).toBe(false);

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
        if (cmdOf(args) === "copilot") return Buffer.from("");
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

  describe("diagnostic logging for auth discovery", () => {
    it("logs exactly once when auth discovery finds no credential", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "copilot") return Buffer.from("");
        throw new Error("not found");
      });

      const result = await service.checkAvailability();
      // Binary on PATH, no auth detected → `unauthenticated`.
      expect(result.copilot).toBe("unauthenticated");
      expect(service.getDetails()!.copilot?.authConfirmed).toBe(false);

      const copilotLogs = consoleLogSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes(
          "GitHub Copilot: binary found, auth discovery: no credential found"
        )
      );
      // Must fire exactly once — guards against the Promise.race leak where
      // a slow fs.access would log after the timeout branch already resolved.
      expect(copilotLogs).toHaveLength(1);
      const message = String(copilotLogs[0][0]);
      expect(message).toContain("[CliAvailabilityService]");
      expect(message).toContain(join(".copilot", "config.json"));
    });

    it("logs Kiro auth discovery miss listing the AWS SSO token path that was checked", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "kiro-cli") return Buffer.from("");
        throw new Error("not found");
      });
      mockedAccess.mockRejectedValue(new Error("ENOENT"));

      await service.checkAvailability();

      const kiroLog = consoleLogSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("Kiro")
      );
      expect(kiroLog).toBeDefined();
      expect(String(kiroLog![0])).toContain(join(".aws", "sso", "cache", "kiro-auth-token.json"));
      expect(String(kiroLog![0])).toContain("no credential found");
    });

    it("does NOT log when auth check is short-circuited by envVar (OPENAI_API_KEY)", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "codex") return Buffer.from("");
        throw new Error("not found");
      });

      const result = await service.checkAvailability();
      expect(result.codex).toBe("ready");
      expect(service.getDetails()!.codex?.authConfirmed).toBe(true);

      const codexLog = consoleLogSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("Codex")
      );
      expect(codexLog).toBeUndefined();
    });

    it("does NOT emit a discovery-miss log when the auth check timed out", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      vi.useFakeTimers();
      try {
        mockedExecFileSync.mockImplementation((_file, args) => {
          if (cmdOf(args) === "copilot") return Buffer.from("");
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

        // Binary found, auth inconclusive due to timeout → unauthenticated.
        expect(result.copilot).toBe("unauthenticated");
        expect(service.getDetails()!.copilot?.authConfirmed).toBe(false);

        const copilotLogs = consoleLogSpy.mock.calls.filter((call: unknown[]) =>
          String(call[0]).includes(
            "GitHub Copilot: binary found, auth discovery: no credential found"
          )
        );
        // No discovery-miss log should fire — the timeout decided the state.
        expect(copilotLogs).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT log when auth file is found (success path)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "copilot") return Buffer.from("");
        throw new Error("not found");
      });
      mockedAccess.mockResolvedValue(undefined);

      await service.checkAvailability();

      const copilotLog = consoleLogSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("GitHub Copilot: binary found, auth discovery")
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
        const command = cmdOf(args);
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
        if (cmdOf(args) === "claude") {
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
        if (cmdOf(args) === "claude") {
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
      // Binary discovered via native path → "ready" (auth not a launch gate).
      // The missing auth file surfaces as `authConfirmed: false` in the detail.
      expect(result.claude).toBe("unauthenticated");

      const details = service.getDetails();
      expect(details!.claude?.state).toBe("unauthenticated");
      expect(details!.claude?.resolvedPath).toBe(claudeNative);
      expect(details!.claude?.via).toBe("native");
      expect(details!.claude?.authConfirmed).toBe(false);
    });

    it("captures the resolved path from `which` stdout", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "claude") {
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

      // With shell + native + npm-global all missing, state is "missing".
      expect(service.getDetails()!.claude?.state).toBe("missing");
      expect(service.getDetails()!.claude?.resolvedPath).toBeNull();
    });
  });

  describe("npm-global fallback probe", () => {
    it("detects agent via `<npm prefix>/bin/<cmd>` shim when PATH + native paths miss", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Shell probe misses for every agent.
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      // Any `npm config get prefix` call returns a fake prefix; all other
      // async execFile calls (WSL probes) ENOENT.
      mockedExecFile.mockImplementation(((...args: unknown[]) => {
        const file = args[0] as string;
        const callback = args.find(
          (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
        );
        if (file === "npm") {
          queueMicrotask(() => callback?.(null, "/Users/test/.npm-global\n"));
        } else {
          const err = Object.assign(new Error("not found"), { code: "ENOENT" });
          queueMicrotask(() => callback?.(err));
        }
        return {} as never;
      }) as never);

      // Only the Gemini shim exists on disk.
      const geminiShim = join("/Users/test/.npm-global", "bin", "gemini");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === geminiShim) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result.gemini).toBe("unauthenticated");

      const details = service.getDetails();
      expect(details!.gemini?.state).toBe("unauthenticated");
      expect(details!.gemini?.via).toBe("npm-global");
      expect(details!.gemini?.resolvedPath).toBe(geminiShim);

      // Exact probe form — guards against regressions in `npm config get prefix`.
      const npmCall = mockedExecFile.mock.calls.find((c) => c[0] === "npm");
      expect(npmCall?.[1]).toEqual(["config", "get", "prefix"]);
    });

    it("returns 'missing' on npx-cache-only hits (regression guard for #5641)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Shell probe misses; simulate a system where `npx gemini` has been run
      // (so ~/.npm/_npx is populated) but `npm install -g @google/gemini-cli`
      // was never executed — the global bin shim does not exist.
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      mockedExecFile.mockImplementation(((...args: unknown[]) => {
        const file = args[0] as string;
        const callback = args.find(
          (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
        );
        if (file === "npm") {
          queueMicrotask(() => callback?.(null, "/Users/test/.npm-global\n"));
        } else {
          const err = Object.assign(new Error("not found"), { code: "ENOENT" });
          queueMicrotask(() => callback?.(err));
        }
        return {} as never;
      }) as never);

      // No shim files exist.
      mockedAccess.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      const result = await service.checkAvailability();
      expect(result.gemini).toBe("missing");
      expect(result.claude).toBe("missing");
      expect(result.codex).toBe("missing");

      const details = service.getDetails();
      expect(details!.gemini?.state).toBe("missing");
      expect(details!.gemini?.resolvedPath).toBeNull();

      // Explicit non-invocation guard — the old probe shelled out to `npx`
      // and reported `ready` off `~/.npm/_npx` cache hits. Ensure no
      // execFile call targets `npx` under the new implementation.
      const npxCalls = mockedExecFile.mock.calls.filter((c) => c[0] === "npx");
      expect(npxCalls).toHaveLength(0);
    });

    it("probes `<prefix>\\<cmd>.cmd` on Windows (no bin subdirectory)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      try {
        mockedExecFileSync.mockImplementation(() => {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        });

        mockedExecFile.mockImplementation(((...args: unknown[]) => {
          const file = args[0] as string;
          const callback = args.find(
            (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
          );
          if (file === "npm") {
            queueMicrotask(() => callback?.(null, "C\\:\\Users\\test\\AppData\\Roaming\\npm\n"));
          } else {
            const err = Object.assign(new Error("not found"), { code: "ENOENT" });
            queueMicrotask(() => callback?.(err));
          }
          return {} as never;
        }) as never);

        // Windows shim convention: <prefix>\<cmd>.cmd (no bin/ segment).
        const geminiShim = join("C\\:\\Users\\test\\AppData\\Roaming\\npm", "gemini.cmd");
        mockedAccess.mockImplementation(async (p) => {
          if (String(p) === geminiShim) return;
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });

        const result = await service.checkAvailability();
        expect(result.gemini).toBe("unauthenticated");

        const details = service.getDetails();
        expect(details!.gemini?.via).toBe("npm-global");
        expect(details!.gemini?.resolvedPath).toBe(geminiShim);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
      }
    });

    it("classifies shim EACCES as 'blocked'", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      mockedExecFile.mockImplementation(((...args: unknown[]) => {
        const file = args[0] as string;
        const callback = args.find(
          (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
        );
        if (file === "npm") {
          queueMicrotask(() => callback?.(null, "/Users/test/.npm-global\n"));
        } else {
          const err = Object.assign(new Error("not found"), { code: "ENOENT" });
          queueMicrotask(() => callback?.(err));
        }
        return {} as never;
      }) as never);

      const geminiShim = join("/Users/test/.npm-global", "bin", "gemini");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === geminiShim) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result.gemini).toBe("blocked");

      const details = service.getDetails();
      expect(details!.gemini?.state).toBe("blocked");
      expect(details!.gemini?.blockReason).toBe("permissions");
      expect(details!.gemini?.via).toBe("npm-global");
      expect(details!.gemini?.resolvedPath).toBe(geminiShim);
    });

    it("returns 'missing' when `npm config get prefix` itself fails (npm not installed)", async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      // Every async exec (including npm) fails with ENOENT — npm is not on PATH.
      // The default mockedExecFile already behaves this way.

      const result = await service.checkAvailability();
      // No blocked state — a missing npm binary is not an endpoint-security
      // scenario. All npm-backed agents fall through to "missing".
      expect(result.gemini).toBe("missing");
      expect(result.claude).toBe("missing");
      expect(result.codex).toBe("missing");

      const details = service.getDetails();
      expect(details!.gemini?.state).toBe("missing");
    });

    it("fires exactly one npm-global probe per agent with npmGlobalPackage", async () => {
      // Shell probe misses for all agents, so every agent walks the full
      // fallback chain. Only the 4 agents declaring npmGlobalPackage
      // (claude, gemini, codex, qwen) should reach the npm-global layer — the
      // other 4 (opencode, cursor, kiro, copilot) must not trigger npm.
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      mockedExecFile.mockImplementation(((...args: unknown[]) => {
        const callback = args.find(
          (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
        );
        const err = Object.assign(new Error("not found"), { code: "ENOENT" });
        queueMicrotask(() => callback?.(err));
        return {} as never;
      }) as never);

      await service.checkAvailability();

      const npmCalls = mockedExecFile.mock.calls.filter((c) => c[0] === "npm");
      expect(npmCalls).toHaveLength(4);
      // Deterministic probe form — guards against arg-drift regressions.
      for (const call of npmCalls) {
        expect(call[1]).toEqual(["config", "get", "prefix"]);
      }
    });
  });

  describe("extended native path coverage", () => {
    it("detects cursor-agent via ~/.local/bin/cursor-agent when PATH misses", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const cursorNative = join(homedir(), ".local/bin/cursor-agent");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === cursorNative) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result.cursor).toBe("unauthenticated");

      const details = service.getDetails();
      expect(details!.cursor?.via).toBe("native");
      expect(details!.cursor?.resolvedPath).toBe(cursorNative);
    });

    it("detects cursor-agent via the macOS app-bundle sidecar when only Cursor.app is installed", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const appBundleNative = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor-agent";
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === appBundleNative) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result.cursor).toBe("unauthenticated");

      const details = service.getDetails();
      expect(details!.cursor?.resolvedPath).toBe(appBundleNative);
      expect(details!.cursor?.via).toBe("native");
    });

    it("detects opencode via ~/.opencode/bin/opencode (curl-installer fallback path)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const opencodeNative = join(homedir(), ".opencode/bin/opencode");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === opencodeNative) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result.opencode).toBe("unauthenticated");

      const details = service.getDetails();
      expect(details!.opencode?.via).toBe("native");
      expect(details!.opencode?.resolvedPath).toBe(opencodeNative);
    });
  });

  describe("packages.npm alias (replaces deprecated npmGlobalPackage)", () => {
    afterEach(async () => {
      const { setUserRegistry } = await import("../../../shared/config/agentRegistry.js");
      setUserRegistry({});
    });

    it("activates the npm-global probe via packages.npm when npmGlobalPackage is unset", async () => {
      const { setUserRegistry } = await import("../../../shared/config/agentRegistry.js");
      setUserRegistry({
        "npm-pkg-test": {
          id: "npm-pkg-test",
          name: "Npm Pkg Test",
          command: "npm-pkg-test",
          color: "#abcdef",
          iconId: "npm-pkg-test",
          supportsContextInjection: false,
          packages: { npm: "@scope/npm-pkg-test" },
        },
      });
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      mockedExecFile.mockImplementation(((...args: unknown[]) => {
        const file = args[0] as string;
        const callback = args.find(
          (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
        );
        if (file === "npm") {
          queueMicrotask(() => callback?.(null, "/Users/test/.npm-global\n"));
        } else {
          const err = Object.assign(new Error("not found"), { code: "ENOENT" });
          queueMicrotask(() => callback?.(err));
        }
        return {} as never;
      }) as never);

      const shim = join("/Users/test/.npm-global", "bin", "npm-pkg-test");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === shim) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result["npm-pkg-test"]).toBe("ready");
      expect(service.getDetails()!["npm-pkg-test"]?.via).toBe("npm-global");
    });
  });

  describe("PyPI probe synthesis (packages.pypi)", () => {
    // Stand-up a user-defined agent with `packages.pypi`. CliAvailabilityService
    // walks the effective registry, so userRegistry entries get the same probe
    // pipeline as built-ins.
    const setupPypiAgent = async () => {
      const { setUserRegistry } = await import("../../../shared/config/agentRegistry.js");
      setUserRegistry({
        "py-test": {
          id: "py-test",
          name: "Py Test",
          command: "py-test",
          color: "#abcdef",
          iconId: "py-test",
          supportsContextInjection: false,
          packages: { pypi: "py-test-pkg" },
        },
      });
    };

    afterEach(async () => {
      const { setUserRegistry } = await import("../../../shared/config/agentRegistry.js");
      setUserRegistry({});
    });

    it("detects a PyPI-distributed agent via uv tool symlink at ~/.local/bin/<cmd>", async () => {
      await setupPypiAgent();
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const uvSymlink = join(homedir(), ".local/bin/py-test");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === uvSymlink) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result["py-test"]).toBe("ready");
      expect(service.getDetails()!["py-test"]?.resolvedPath).toBe(uvSymlink);
      expect(service.getDetails()!["py-test"]?.via).toBe("native");
    });

    it("falls through to ~/.local/share/uv/tools/<pkg>/bin/<cmd> when ~/.local/bin misses", async () => {
      await setupPypiAgent();
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const uvVenvBin = join(homedir(), ".local/share/uv/tools/py-test-pkg/bin/py-test");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === uvVenvBin) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result["py-test"]).toBe("ready");
      expect(service.getDetails()!["py-test"]?.resolvedPath).toBe(uvVenvBin);
    });

    it("detects pipx-installed agent at ~/.local/share/pipx/venvs/<pkg>/bin/<cmd>", async () => {
      await setupPypiAgent();
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const pipxBin = join(homedir(), ".local/share/pipx/venvs/py-test-pkg/bin/py-test");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === pipxBin) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result["py-test"]).toBe("ready");
      expect(service.getDetails()!["py-test"]?.resolvedPath).toBe(pipxBin);
    });

    it("surfaces 'blocked' when a PyPI path exists but execution is denied (EACCES)", async () => {
      await setupPypiAgent();
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const uvSymlink = join(homedir(), ".local/bin/py-test");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === uvSymlink) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result["py-test"]).toBe("blocked");
      expect(service.getDetails()!["py-test"]?.via).toBe("native");
      expect(service.getDetails()!["py-test"]?.resolvedPath).toBe(uvSymlink);
    });

    it("returns missing when no PyPI install path resolves", async () => {
      await setupPypiAgent();
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result["py-test"]).toBe("missing");
    });

    it("does not synthesise PyPI paths when packages.pypi is unset", async () => {
      // Built-in claude has no `packages.pypi`; verify our probe pipeline
      // never dispatches PyPI-shaped fs.access calls for it.
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      mockedAccess.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      await service.checkAvailability();

      const probedPaths = mockedAccess.mock.calls.map((c) => String(c[0]));
      // None of the built-ins use uv/pipx layouts; this guards against
      // accidental probing when an agent has `npmGlobalPackage` only.
      expect(probedPaths.some((p) => p.includes(".local/share/uv/tools"))).toBe(false);
      expect(probedPaths.some((p) => p.includes(".local/share/pipx/venvs"))).toBe(false);
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

    it("detects Codex via WSL when shell, native, and npm-global all miss", async () => {
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

      // wsl.exe should never appear in execFile calls for agents without
      // supportsWsl: true. Codex has the flag, and its npm-global probe
      // (via `npm config get prefix`) fails under the default mock, so WSL
      // *is* reached for Codex. Verify via the file arg that no NON-Codex
      // agent triggered wsl.exe.
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

  describe("duplicate CLI detection (#6054)", () => {
    const mockedBroadcast = vi.mocked(broadcastToRenderer);

    it("requests all PATH matches via `which -a` on Unix", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      await service.checkAvailability();

      const claudeCall = mockedExecFileSync.mock.calls.find(
        (call) => Array.isArray(call[1]) && (call[1] as string[])[1] === "claude"
      );
      expect(claudeCall).toBeDefined();
      expect(claudeCall![0]).toBe("which");
      expect(claudeCall![1]).toEqual(["-a", "claude"]);
    });

    it("captures every line of `which -a` stdout into allResolvedPaths", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[] | undefined;
        if (argv?.[1] === "claude") {
          return Buffer.from("/opt/homebrew/bin/claude\n/Users/x/.local/bin/claude\n");
        }
        return Buffer.from("");
      });

      await service.checkAvailability();

      const detail = service.getDetails()!.claude!;
      expect(detail.resolvedPath).toBe("/opt/homebrew/bin/claude");
      expect(detail.allResolvedPaths).toEqual([
        "/opt/homebrew/bin/claude",
        "/Users/x/.local/bin/claude",
      ]);
    });

    it("emits a one-time warning toast per agent when duplicates exist", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[] | undefined;
        if (argv?.[1] === "claude") {
          return Buffer.from("/opt/homebrew/bin/claude\n/Users/x/.local/bin/claude\n");
        }
        return Buffer.from("");
      });

      await service.checkAvailability();

      const toastCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
      );
      expect(toastCalls).toHaveLength(1);
      const payload = toastCalls[0][1] as {
        type: string;
        title: string;
        message: string;
      };
      expect(payload.type).toBe("warning");
      expect(payload.title).toBe("Multiple Claude installations found");
      expect(payload.message).toContain("/opt/homebrew/bin/claude");
      expect(payload.message).toContain("/Users/x/.local/bin/claude");
    });

    it("does not re-fire the toast on subsequent refresh() calls (milestone guard)", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[] | undefined;
        if (argv?.[1] === "claude") {
          return Buffer.from("/opt/homebrew/bin/claude\n/Users/x/.local/bin/claude\n");
        }
        return Buffer.from("");
      });

      await service.checkAvailability();
      mockedBroadcast.mockClear();

      await service.refresh();

      const toastCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
      );
      expect(toastCalls).toHaveLength(0);
    });

    it("does not emit a toast when only one PATH match is found", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from("/opt/homebrew/bin/claude\n"));

      await service.checkAvailability();

      const toastCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
      );
      expect(toastCalls).toHaveLength(0);

      const detail = service.getDetails()!.claude!;
      expect(detail.allResolvedPaths).toBeUndefined();
    });

    it("dedupes Windows where.exe results that share a directory (.cmd + .exe)", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      try {
        mockedExecFileSync.mockImplementation((_file, args) => {
          const argv = args as string[] | undefined;
          if (argv?.[0] === "claude") {
            // Same npm-global directory, two extensions — counts as one install.
            return Buffer.from(
              "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd\r\n" +
                "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.exe\r\n"
            );
          }
          return Buffer.from("");
        });

        await service.checkAvailability();

        const detail = service.getDetails()!.claude!;
        // Only one unique install after dedup, so `allResolvedPaths` is
        // intentionally omitted — the field signals duplicates only.
        expect(detail.allResolvedPaths).toBeUndefined();
        expect(detail.resolvedPath).toBe("C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd");

        const toastCalls = mockedBroadcast.mock.calls.filter(
          (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
        );
        expect(toastCalls).toHaveLength(0);
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      }
    });

    it("emits separate toasts per agent when multiple agents have duplicates", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[] | undefined;
        const cmd = argv?.[1];
        if (cmd === "claude") {
          return Buffer.from("/opt/homebrew/bin/claude\n/Users/x/.local/bin/claude\n");
        }
        if (cmd === "gemini") {
          return Buffer.from("/opt/homebrew/bin/gemini\n/Users/x/.npm-global/bin/gemini\n");
        }
        return Buffer.from("");
      });

      await service.checkAvailability();

      const toastCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
      );
      expect(toastCalls).toHaveLength(2);
      const titles = toastCalls.map((c) => (c[1] as { title: string }).title);
      expect(titles).toContain("Multiple Claude installations found");
      expect(titles).toContain("Multiple Gemini installations found");
    });

    it("truncates the 'Also found' list and notes how many additional copies remain", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[] | undefined;
        if (argv?.[1] === "claude") {
          return Buffer.from(
            "/a/bin/claude\n/b/bin/claude\n/c/bin/claude\n/d/bin/claude\n/e/bin/claude\n"
          );
        }
        return Buffer.from("");
      });

      await service.checkAvailability();

      const toastCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
      );
      expect(toastCalls).toHaveLength(1);
      const message = (toastCalls[0][1] as { message: string }).message;
      expect(message).toContain("Active: /a/bin/claude");
      expect(message).toContain("/b/bin/claude");
      expect(message).toContain("/c/bin/claude");
      // Tail entries should be summarized, not enumerated, to keep the toast short.
      expect(message).not.toContain("/d/bin/claude");
      expect(message).not.toContain("/e/bin/claude");
      expect(message).toContain("and 2 more");
    });

    it("falls back to bare `which` when BusyBox-style `which -a` exits non-zero", async () => {
      // BusyBox/minimal `which` builds reject `-a` with a non-zero exit
      // (no errno code). Without a fallback, every agent on Alpine would
      // silently surface as "missing".
      const { access } = await import("fs/promises");
      // Resolve kiro's AWS SSO token probe so the agent reaches "ready" —
      // this test is about path resolution, not auth discovery.
      vi.mocked(access).mockImplementation(async (path) => {
        if (typeof path === "string" && path.endsWith("kiro-auth-token.json")) {
          return undefined;
        }
        throw new Error("ENOENT");
      });
      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[] | undefined;
        if (argv?.[0] === "-a") {
          const e = new Error("which: invalid option -- a");
          throw Object.assign(e, { status: 1 });
        }
        // Plain `which kiro-cli` succeeds.
        if (cmdOf(args) === "kiro-cli") {
          return Buffer.from("/usr/local/bin/kiro-cli\n");
        }
        const enoent = new Error("not found");
        throw Object.assign(enoent, { status: 1 });
      });

      const result = await service.checkAvailability();
      expect(result.kiro).toBe("ready");
      const detail = service.getDetails()!.kiro!;
      expect(detail.resolvedPath).toBe("/usr/local/bin/kiro-cli");
      // Single-result fallback never surfaces duplicates.
      expect(detail.allResolvedPaths).toBeUndefined();

      const toastCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
      );
      expect(toastCalls).toHaveLength(0);
    });

    it("survives a milestone load with falsy/undefined value (legacy stores)", async () => {
      // Simulate a store that has never persisted orchestrationMilestones.
      storeBackingMap.delete("orchestrationMilestones");

      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[] | undefined;
        if (argv?.[1] === "claude") {
          return Buffer.from("/opt/homebrew/bin/claude\n/Users/x/.local/bin/claude\n");
        }
        return Buffer.from("");
      });

      await service.checkAvailability();

      const toastCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
      );
      expect(toastCalls).toHaveLength(1);
      // Milestone now persisted for follow-up checks.
      const stored = storeBackingMap.get("orchestrationMilestones") as Record<string, boolean>;
      expect(stored["duplicate-cli-warning:claude"]).toBe(true);
    });
  });
});
