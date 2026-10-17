/**
 * Tests for CliAvailabilityService - CLI command availability checking at startup and on-demand.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { homedir } from "os";
import { join } from "path";
import { CliAvailabilityService } from "../CliAvailabilityService.js";
import { getAgentConfig, getAgentIds } from "../../../shared/config/agentRegistry.js";
import { execFile, execFileSync } from "child_process";
import { refreshPath } from "../../setup/environment.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { CHANNELS } from "../../ipc/channels.js";
import { logBuffer } from "../LogBuffer.js";
import { getLogLevelOverrides, setLogLevelOverrides } from "../../utils/logger.js";
import { findAllOnPath } from "../../utils/findOnPath.js";
import { virtualWindowsFiles } from "../../utils/__tests__/helpers/virtualWindowsFs.js";
import { resetWindowsExecutableCache } from "../../utils/windowsExecutable.js";

// Mock child_process. The service's subprocess probes (npm-global, WSL) run
// through async `execFile` — mock it or the probes will call `undefined(...)`
// and throw TypeErrors at runtime.
//
// `execFileSync` is the suite's PATH fixture: tests state what is on PATH
// through `mockedExecFileSync` implementations, keyed on the command at the
// tail of the args (`cmdOf`). On POSIX the service walks PATH in-process
// through `findAllOnPath` (no `which` subprocess), and `pathFixtureLookup`
// answers that from the fixture: a throw is "not on PATH", stdout lines are the
// matches, and empty stdout is a match at a synthetic location. Windows spawns
// no lookup either: it reads PATH's directories (the virtual Windows disk
// below). Every spawn (npm, wsl.exe, npx) gets an ENOENT callback by default,
// so unmocked tests see the probe as "binary not found" rather than hanging on
// an un-invoked callback.
//
// `execFile` has an overloaded signature: (file, args, callback) or
// (file, args, options, callback). `vi.hoisted` guarantees this runs before
// `vi.mock` factories despite the auto-hoisting that normally blocks
// reference to local bindings.
const { defaultExecFileImpl, pathFixtureLookup } = vi.hoisted(() => ({
  pathFixtureLookup: async (command: string): Promise<string[]> => {
    let out: string | Buffer;
    try {
      out = execFileSync("which", ["-a", command], {}) as string | Buffer;
    } catch {
      return [];
    }
    const lines = (typeof out === "string" ? out : out.toString("utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length > 0 ? lines : [`/usr/local/bin/${command}`];
  },
  defaultExecFileImpl: (...args: unknown[]) => {
    const callback = args.find(
      (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
    );
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    queueMicrotask(() => callback?.(err));
    return {} as never;
  },
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(defaultExecFileImpl),
}));

vi.mock("../../utils/findOnPath.js", () => ({
  findAllOnPath: vi.fn(pathFixtureLookup),
}));

// Windows-path files for the PATH search and the npm shim lookup, which read the disk.
vi.mock("node:fs", async (importOriginal) =>
  (await import("../../utils/__tests__/helpers/virtualWindowsFs.js")).withVirtualWindowsFiles(
    await importOriginal()
  )
);

// Mock os.homedir() to return a stable Unix-style path. On Windows runners
// the real homedir is `C:\Users\<user>`, which (after join with `~/...`
// candidates from synthesisePypiProbePaths) yields backslashed strings that
// `expandPath()` rejects via its Windows-paths-on-Unix guard. Forcing a
// Unix-shaped homedir keeps the synthesised candidates probeable when
// `process.platform` is mocked to "darwin" for the bulk of the suite.
vi.mock("os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, homedir: vi.fn(() => "/Users/test") };
});

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
 * Extract the command name from the PATH fixture's `["-a", cmd]` args; the
 * command always sits at the tail.
 */
const cmdOf = (args: unknown): string | undefined => {
  if (!Array.isArray(args) || args.length === 0) return undefined;
  return args[args.length - 1] as string;
};

describe("CliAvailabilityService", () => {
  let service: CliAvailabilityService;
  const mockedExecFileSync = vi.mocked(execFileSync);
  const mockedExecFile = vi.mocked(execFile);
  const mockedFindAllOnPath = vi.mocked(findAllOnPath);
  const savedEnv: Record<string, string | undefined> = {};
  // Default platform to darwin so Unix-style path/probe expectations don't
  // diverge on Windows CI. Individual tests that exercise Windows-specific
  // branches (the PATH search, `<prefix>\<cmd>.cmd` shims, WSL fallback, etc.)
  // override `process.platform` explicitly via `Object.defineProperty`.
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  // Auth env vars consulted by AgentAuthCheck.envVar across the built-in
  // registry. Clear them so local dev shells (which commonly have these set)
  // don't cause the "no auth file" assertions to flip to "ready". Derived from
  // the registry rather than hardcoded so the list can't drift as agents are
  // added — a missing key silently re-introduces the env leak on an
  // authenticated dev machine while CI (no keys set) stays green.
  const envKeysToClear = [
    ...new Set(
      getAgentIds().flatMap((id) => {
        const envVar = getAgentConfig(id)?.authCheck?.envVar;
        if (!envVar) return [];
        return Array.isArray(envVar) ? envVar : [envVar];
      })
    ),
    // Not an auth env var: alters the probe PATH; cleared for the same isolation.
    "DAINTREE_CLI_PATH_PREPEND",
  ];

  beforeEach(async () => {
    // Isolate from any local env vars that would turn auth checks into "ready".
    for (const key of envKeysToClear) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    // Default to darwin — most assertions in this file expect Unix path/probe
    // semantics. Tests covering Windows behavior re-define platform explicitly.
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });

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
    mockedFindAllOnPath.mockImplementation(pathFixtureLookup);
    // The Windows PATH search keeps directory listings for a few seconds. A
    // Windows case that leaves PATH alone searches the host's own PATH, which
    // on a Windows host names real directories (`C:\Program Files\nodejs`);
    // read against an empty virtual disk, they would answer the next case's
    // lookups as empty.
    resetWindowsExecutableCache();
  });

  // Windows cases point PATH at directories on the virtual disk.
  const originalPath = process.env.PATH;

  afterEach(() => {
    vi.restoreAllMocks();
    virtualWindowsFiles.clear();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    for (const key of envKeysToClear) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
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
      // Agents Daintree probes auth for surface `unauthenticated` when no
      // credentials are found. Agents that own their auth (no `authCheck`,
      // e.g. daintree-assistant) stay `ready` — the CLI handles login itself.
      for (const [id, state] of Object.entries(result)) {
        if (!getAgentConfig(id)?.authCheck) continue;
        expect(state).toBe("unauthenticated");
      }

      const details = service.getDetails();
      expect(details).not.toBeNull();
      for (const [id, detail] of Object.entries(details!)) {
        if (!getAgentConfig(id)?.authCheck) continue;
        expect(detail?.state).toBe("unauthenticated");
        expect(detail?.authConfirmed).toBe(false);
      }

      // One PATH lookup per CLI. Fallback probes (native paths, npm-global,
      // WSL) only fire when the PATH probe returns missing — in this test every
      // agent succeeds on the first probe, so the count matches the registry
      // size exactly.
      expect(mockedExecFileSync).toHaveBeenCalledTimes(18);

      // The PATH probe is bounded, and on POSIX it never spawns a subprocess.
      expect(mockedFindAllOnPath).toHaveBeenCalledWith(
        "claude",
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
      expect(mockedExecFile).not.toHaveBeenCalled();
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
      // `authConfirmed` is only populated for agents with an `authCheck`;
      // agents that own their auth (daintree-assistant) leave it undefined.
      for (const [id, detail] of Object.entries(details!)) {
        if (!getAgentConfig(id)?.authCheck) continue;
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
        aider: "missing",
        claude: "missing",
        gemini: "missing",
        antigravity: "missing",
        codex: "missing",
        grok: "missing",
        opencode: "missing",
        cursor: "missing",
        kiro: "missing",
        copilot: "missing",
        goose: "missing",
        crush: "missing",
        qwen: "missing",
        interpreter: "missing",
        mistral: "missing",
        kimi: "missing",
        amp: "missing",
        "daintree-assistant": "missing",
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
        // Match `/bin/` (posix) and `\bin\` (Windows, when path.join runs on a
        // Windows runner with `process.platform` mocked to darwin and produces
        // backslashed candidates from `~/...` inputs).
        if (
          pathStr.includes("/bin/") ||
          pathStr.includes("\\bin\\") ||
          pathStr.includes("cursor-agent.app")
        ) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return undefined;
      });

      const result = await service.checkAvailability();

      expect(result.aider).toBe("missing");
      expect(result.claude).toBe("ready");
      expect(result.gemini).toBe("missing");
      expect(result.codex).toBe("missing");
      expect(result.opencode).toBe("missing");
      expect(result.cursor).toBe("missing");
      expect(result.kiro).toBe("missing");
      expect(result.goose).toBe("missing");
      expect(result.qwen).toBe("missing");
      expect(result.kimi).toBe("missing");
    });

    it("prefers DAINTREE_CLI_PATH_PREPEND over shell resolution", async () => {
      const { access, constants } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      process.env.DAINTREE_CLI_PATH_PREPEND = "/tmp/daintree-fake-bin";
      const expectedClaudePath = join("/tmp/daintree-fake-bin", "claude");

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "claude") {
          return Buffer.from("/usr/local/bin/claude");
        }
        throw new Error("Command not found");
      });
      mockedAccess.mockImplementation(async (p, mode) => {
        if (String(p) === expectedClaudePath && mode === constants.X_OK) {
          return;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();

      expect(result.claude).toBe("unauthenticated");
      expect(service.getDetails()?.claude?.resolvedPath).toBe(expectedClaudePath);
      expect(mockedExecFileSync).not.toHaveBeenCalledWith(
        "which",
        ["-a", "claude"],
        expect.any(Object)
      );
    });

    it("prefers Windows .cmd shims from DAINTREE_CLI_PATH_PREPEND over extensionless npm shims", async () => {
      const originalPlatform = process.platform;
      const { access, constants } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      process.env.DAINTREE_CLI_PATH_PREPEND = "/tmp/daintree-fake-bin";
      const expectedClaudePath = join("/tmp/daintree-fake-bin", "claude.cmd");
      // A competing install PATH would otherwise answer for claude.
      process.env.PATH = "C:\\npm\\prefix";
      virtualWindowsFiles.set({
        "C:\\npm\\prefix\\claude": "",
        "C:\\npm\\prefix\\claude.cmd": "",
      });

      mockedAccess.mockImplementation(async (p, mode) => {
        const pathStr = String(p);
        if (
          mode === constants.X_OK &&
          (pathStr === expectedClaudePath || pathStr === join("/tmp/daintree-fake-bin", "claude"))
        ) {
          return;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      try {
        const result = await service.checkAvailability();

        expect(result.claude).toBe("unauthenticated");
        expect(service.getDetails()?.claude?.resolvedPath).toBe(expectedClaudePath);

        // Without the prepend, the PATH install is what answers.
        delete process.env.DAINTREE_CLI_PATH_PREPEND;
        await service.refresh();
        expect(service.getDetails()?.claude?.resolvedPath).toBe("C:\\npm\\prefix\\claude.cmd");
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      }
    });

    it("walks PATH in-process on Linux, never spawning which", async () => {
      // Fedora containers and Arch's base set have no `which`; spawning it
      // reported every installed agent missing.
      const originalPlatform = process.platform;

      try {
        Object.defineProperty(process, "platform", {
          value: "linux",
          writable: true,
        });

        mockedExecFileSync.mockImplementation(() => Buffer.from(""));

        const result = await service.checkAvailability();

        expect(Object.values(result).every((state) => state !== "missing")).toBe(true);
        expect(mockedFindAllOnPath.mock.calls.map((call) => call[0]).sort()).toEqual(
          getAgentIds()
            .map((id) => getAgentConfig(id)?.command)
            .sort()
        );
        expect(mockedExecFile).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      }
    });

    it("reads PATH directories on Windows instead of spawning where", async () => {
      // `where` writes in the console code page, so a shim under a non-ASCII
      // profile directory came back mangled and failed the PATH check.
      const originalPlatform = process.platform;
      const shims = "C:\\Users\\山田\\scoop\\shims";
      process.env.PATH = shims;
      virtualWindowsFiles.set({ [`${shims}\\claude.cmd`]: "" });

      try {
        Object.defineProperty(process, "platform", {
          value: "win32",
          writable: true,
        });

        mockedExecFileSync.mockImplementation(() => Buffer.from(""));

        await service.checkAvailability();

        expect(service.getDetails()?.claude?.resolvedPath).toBe(`${shims}\\claude.cmd`);
        expect(mockedExecFileSync).not.toHaveBeenCalled();
        expect(mockedExecFile.mock.calls.some((c) => /where(\.exe)?$/i.test(String(c[0])))).toBe(
          false
        );
        expect(mockedFindAllOnPath).not.toHaveBeenCalled();
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
      // One PATH lookup per registry entry, hit or miss: the in-process walk
      // has no flag a minimal `which` could reject, so a miss is never retried.
      expect(mockedExecFileSync).toHaveBeenCalledTimes(18);
    });
  });

  describe("parallel execution", () => {
    it("deduplicates concurrent checkAvailability calls", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const [result1, result2, result3] = await Promise.all([
        service.checkAvailability(),
        service.checkAvailability(),
        service.checkAvailability(),
      ]);

      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(18);
    });

    it("concurrent refresh calls each trigger a new check", async () => {
      mockedExecFileSync.mockImplementation(() => Buffer.from(""));

      const [result1, result2] = await Promise.all([service.refresh(), service.refresh()]);

      expect(result1).toEqual(result2);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(36);
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

    it("does NOT probe the bogus Antigravity path (.antigravity/oauth_creds.json)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      // Only agy binary found; no auth files exist
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "agy") return Buffer.from("");
        throw new Error("not found");
      });
      mockedAccess.mockRejectedValue(new Error("ENOENT"));

      const result = await service.checkAvailability();

      // Binary on PATH + no credential detected → `unauthenticated`.
      expect(result.antigravity).toBe("unauthenticated");
      expect(service.getDetails()!.antigravity?.authConfirmed).toBe(false);

      const probedPaths = mockedAccess.mock.calls.map((call) => String(call[0]));
      // The old .antigravity/oauth_creds.json path never existed on disk and
      // must never be probed (regression guard for #8918).
      expect(probedPaths).not.toContain(join(homedir(), ".antigravity/oauth_creds.json"));
      // Upper-bound guard: the inherited Gemini OAuth file IS probed — proves
      // the fix wired the real path, not just that the bogus one is gone.
      expect(probedPaths).toContain(join(homedir(), ".gemini/oauth_creds.json"));
    });

    it("reaches 'ready' for Antigravity when ~/.gemini/oauth_creds.json exists", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "agy") return Buffer.from("");
        throw new Error("not found");
      });

      // agy inherits Gemini's OAuth creds; either inherited file is a match.
      const oauthCreds = join(homedir(), ".gemini/oauth_creds.json");
      mockedAccess.mockImplementation(async (path) => {
        if (String(path) === oauthCreds) return;
        throw new Error("ENOENT");
      });

      const result = await service.checkAvailability();
      expect(result.antigravity).toBe("ready");
      expect(service.getDetails()!.antigravity?.authConfirmed).toBe(true);
    });

    it("reaches 'ready' for Antigravity via GOOGLE_API_KEY env var alone", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "agy") return Buffer.from("");
        throw new Error("not found");
      });
      // No credential files on disk; only the env var signals auth.
      mockedAccess.mockRejectedValue(new Error("ENOENT"));

      const prev = process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_API_KEY = "test-key";
      try {
        const result = await service.checkAvailability();
        expect(result.antigravity).toBe("ready");
        expect(service.getDetails()!.antigravity?.authConfirmed).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = prev;
      }
    });
  });

  describe("diagnostic logging for auth discovery", () => {
    let savedLogOverrides: Record<string, string>;

    beforeEach(() => {
      savedLogOverrides = getLogLevelOverrides();
      // The miss logs at debug on purpose (see checkAuth); pin that floor so
      // these assertions don't lean on the ambient default.
      setLogLevelOverrides({ "*": "debug" });
      logBuffer.clear();
    });

    afterEach(() => {
      setLogLevelOverrides(savedLogOverrides);
      logBuffer.clear();
    });

    const authMissPaths = (agentId: string): string[][] =>
      logBuffer
        .getFiltered({ sources: ["main:CliAvailabilityService"] })
        .map((entry) => entry.context as { agentId?: unknown; checkedPaths?: unknown } | undefined)
        .filter((context) => context?.agentId === agentId && Array.isArray(context.checkedPaths))
        .map((context) => context!.checkedPaths as string[]);

    it("logs exactly once when auth discovery finds no credential", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "copilot") return Buffer.from("");
        throw new Error("not found");
      });

      const result = await service.checkAvailability();
      // Binary on PATH, no auth detected → `unauthenticated`.
      expect(result.copilot).toBe("unauthenticated");
      expect(service.getDetails()!.copilot?.authConfirmed).toBe(false);

      const copilotLogs = authMissPaths("copilot");
      // One check, one miss — no duplicate log per agent.
      expect(copilotLogs).toHaveLength(1);
      expect(copilotLogs[0].some((p) => p.includes(join(".copilot", "config.json")))).toBe(true);
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

      const kiroLogs = authMissPaths("kiro");
      expect(kiroLogs).toHaveLength(1);
      expect(
        kiroLogs[0].some((p) => p.includes(join(".aws", "sso", "cache", "kiro-auth-token.json")))
      ).toBe(true);
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

      expect(authMissPaths("codex")).toHaveLength(0);
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
        // Copilot's auth config probe misses only after the auth budget has
        // decided the race, so the miss path still runs to completion — late,
        // which is exactly when an unguarded log would fire. Other agents'
        // fs.access probes must reject straight away or they'd stall the
        // batch under fake timers.
        const copilotConfig = join(homedir(), ".copilot/config.json");
        mockedAccess.mockImplementation(async (p) => {
          if (String(p) === copilotConfig) {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
          }
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });

        const checkPromise = service.checkAvailability();
        // Past both the 3s auth budget and the late 5s miss.
        await vi.advanceTimersByTimeAsync(6_000);
        const result = await checkPromise;

        // Binary found, auth inconclusive due to timeout → unauthenticated.
        expect(result.copilot).toBe("unauthenticated");
        expect(service.getDetails()!.copilot?.authConfirmed).toBe(false);

        // No discovery-miss log should fire — the timeout decided the state.
        expect(authMissPaths("copilot")).toHaveLength(0);
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

      expect(authMissPaths("copilot")).toHaveLength(0);
    });
  });

  describe("blocked state (security software / permissions)", () => {
    // Neither platform spawns a PATH probe (POSIX walks PATH in-process,
    // Windows reads its directories), so "blocked" comes from the native-path
    // and spawn checks below, which touch the binary itself.
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
    it("reports 'blocked' for security when fs.access on a native-path binary returns EPERM (Santa / CrowdStrike / Defender)", async () => {
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "claude") {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        }
        return Buffer.from("");
      });

      const claudeNative = join(homedir(), ".local/bin/claude");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === claudeNative) {
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        }
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });

      const result = await service.checkAvailability();
      expect(result.claude).toBe("blocked");

      const details = service.getDetails();
      expect(details!.claude?.state).toBe("blocked");
      expect(details!.claude?.resolvedPath).toBe(claudeNative);
      expect(details!.claude?.blockReason).toBe("security");
      expect(details!.claude?.via).toBe("native");
      expect(details!.claude?.message).toMatch(/EPERM/);
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
          String(call[0]).includes("WinGet\\Links\\claude.exe")
      );
      expect(nativeProbes).toHaveLength(0);
    });
  });

  describe("getDetails()", () => {
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
      // npm is a `.cmd` on Windows, found in PATH and run through cmd.exe by
      // absolute path; Node's own npm.cmd is not a shim that can be unwrapped.
      const npmCmd = "C:\\Program Files\\nodejs\\npm.cmd";
      process.env.PATH = "C:\\Program Files\\nodejs";
      virtualWindowsFiles.set({
        [npmCmd]:
          '@ECHO OFF\r\nSETLOCAL\r\n"%~dp0\\node.exe" "%~dp0\\npm-cli.js" %*\r\nCALL :x\r\n',
      });
      try {
        mockedExecFileSync.mockImplementation(() => {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        });

        mockedExecFile.mockImplementation(((...args: unknown[]) => {
          const [file, fileArgs] = args as [string, string[]];
          const callback = args.find(
            (a): a is (err: unknown, stdout?: string) => void => typeof a === "function"
          );
          if (
            /\\System32\\cmd\.exe$/i.test(file) &&
            fileArgs.at(-1)?.toLowerCase().includes(npmCmd.toLowerCase())
          ) {
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
        const npmCall = mockedExecFile.mock.calls.find((c) => String(c[0]).endsWith("cmd.exe"));
        // PATHEXT spells the extension the resolver appended (`.CMD` by default).
        expect((npmCall?.[1] as string[]).map((arg) => arg.toLowerCase())).toEqual([
          "/d",
          "/s",
          "/v:off",
          "/c",
          `""${npmCmd.toLowerCase()}" config get prefix"`,
        ]);
        expect(npmCall?.[2]).toEqual(expect.objectContaining({ windowsVerbatimArguments: true }));
        expect(mockedExecFile.mock.calls.some((c) => c[0] === "npm")).toBe(false);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
      }
    });

    it("never runs a bare npm on Windows when PATH has none", async () => {
      // A bare name would be looked up in the working directory first.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      process.env.PATH = ".;C:\\tools";
      try {
        mockedExecFileSync.mockImplementation(() => {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        });

        const result = await service.checkAvailability();

        expect(result.gemini).toBe("missing");
        const spawned = mockedExecFile.mock.calls.map((c) => String(c[0]));
        expect(spawned.every((file) => /^[A-Za-z]:\\/.test(file))).toBe(true);
        expect(spawned.some((file) => /npm/i.test(file))).toBe(false);
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

    it("fires exactly one npm-global probe per agent with npmGlobalPackage", async () => {
      // Shell probe misses for all agents, so every agent walks the full
      // fallback chain. Only the 5 agents declaring an npm package
      // (claude, gemini, codex, qwen via npmGlobalPackage; amp via packages.npm)
      // should reach the npm-global layer — the others must not trigger npm.
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
      // With the per-checkId cache, all npm-backed agents share a single
      // `npm config get prefix` call instead of issuing one per agent.
      expect(npmCalls).toHaveLength(1);
      // Deterministic probe form — guards against arg-drift regressions.
      for (const call of npmCalls) {
        expect(call[1]).toEqual(["config", "get", "prefix"]);
      }
    });

    it("re-issues `npm config get prefix` after refresh() invalidates the cache", async () => {
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
      expect(mockedExecFile.mock.calls.filter((c) => c[0] === "npm")).toHaveLength(1);

      await service.refresh();
      expect(mockedExecFile.mock.calls.filter((c) => c[0] === "npm")).toHaveLength(2);
    });

    it("caches a successful npm prefix and reuses it across all npm-backed agents", async () => {
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

      const claudeShim = join("/Users/test/.npm-global", "bin", "claude");
      const geminiShim = join("/Users/test/.npm-global", "bin", "gemini");
      mockedAccess.mockImplementation(async (p) => {
        if (String(p) === claudeShim || String(p) === geminiShim) return;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      await service.checkAvailability();

      const npmCalls = mockedExecFile.mock.calls.filter((c) => c[0] === "npm");
      expect(npmCalls).toHaveLength(1);
      expect(service.getDetails()!.claude?.via).toBe("npm-global");
      expect(service.getDetails()!.gemini?.via).toBe("npm-global");
    });
  });

  describe("extended native path coverage", () => {
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

    it("does not synthesise PyPI paths when packages.pypi is unset", async () => {
      // Agents that legitimately declare `packages.pypi` (interpreter, mistral, kimi, aider)
      // SHOULD probe uv/pipx layouts; every other built-in does not, and must not
      // produce PyPI-shaped fs.access calls. This guards against accidental
      // probing when an agent has e.g. `npmGlobalPackage` only.
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      mockedAccess.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      await service.checkAvailability();

      // Filter out paths synthesised for agents whose `packages.pypi`
      // legitimately triggers uv/pipx probing (interpreter, mistral, kimi, aider).
      // Remaining probed paths must not include any uv/pipx layouts.
      // Normalize separators so substring checks work regardless of host OS
      // (Windows runners produce backslashed paths post-`path.join`).
      const norm = (s: string) => s.replace(/\\/g, "/");
      const allProbedPaths = mockedAccess.mock.calls.map((c) => norm(String(c[0])));
      const probedPaths = allProbedPaths.filter(
        (p) =>
          !p.includes("open-interpreter") &&
          !p.includes("/interpreter") &&
          !p.includes("mistral") &&
          !p.includes("/vibe") &&
          !p.includes("kimi-cli") &&
          !p.includes("/kimi") &&
          !p.includes("aider")
      );
      expect(probedPaths.some((p) => p.includes(".local/share/uv/tools"))).toBe(false);
      expect(probedPaths.some((p) => p.includes(".local/share/pipx/venvs"))).toBe(false);

      // Aider declares packages.pypi so its uv/pipx paths SHOULD be probed.
      const aiderUvPaths = allProbedPaths.filter(
        (p) => p.includes(".local/share/uv/tools") && p.includes("aider")
      );
      const aiderPipxPaths = allProbedPaths.filter(
        (p) => p.includes(".local/share/pipx/venvs") && p.includes("aider")
      );
      expect(aiderUvPaths.length > 0 || aiderPipxPaths.length > 0).toBe(true);
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

        // wsl.exe --list --verbose: return a UTF-16LE-encoded distro list
        // with a BOM, simulating older Windows builds that don't honor
        // WSL_UTF8=1. The `*` marker on Ubuntu identifies it as the default;
        // Debian is registered first but is not the default (issue #7944).
        if (argv?.[0] === "--list") {
          const text =
            "  NAME            STATE           VERSION\r\n" +
            "  Debian          Stopped         2\r\n" +
            "* Ubuntu          Running         2\r\n";
          const utf16 = Buffer.concat([
            Buffer.from([0xff, 0xfe]), // BOM
            Buffer.from(text, "utf16le"),
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
      const wslCalls = mockedExecFile.mock.calls.filter((c) => /wsl\.exe$/i.test(String(c[0])));
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

    it("captures every PATH match into allResolvedPaths", async () => {
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

    it("stays silent for an agent already warned in a previous session", async () => {
      // The flags live under the legacy `orchestrationMilestones` key beside
      // retired celebratory-toast ids; both must survive the next write.
      storeBackingMap.set("orchestrationMilestones", {
        "duplicate-cli-warning:claude": true,
        "first-task-complete": true,
      });
      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[] | undefined;
        if (argv?.[1] === "claude" || argv?.[1] === "gemini") {
          return Buffer.from(`/opt/homebrew/bin/${argv[1]}\n/Users/x/.local/bin/${argv[1]}\n`);
        }
        return Buffer.from("");
      });

      await service.checkAvailability();

      const toastCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
      );
      expect(toastCalls).toHaveLength(1);
      expect((toastCalls[0][1] as { title: string }).title).toBe(
        "Multiple Gemini installations found"
      );
      expect(storeBackingMap.get("orchestrationMilestones")).toEqual({
        "duplicate-cli-warning:claude": true,
        "duplicate-cli-warning:gemini": true,
        "first-task-complete": true,
      });
    });

    it("warns once per agent even when the milestone never persists", async () => {
      // The persisted milestone is read fresh at the top of every pass, so it
      // only dedupes passes that are far enough apart for `store.set` to have
      // landed. When it has not — an overlapping re-check, or a store write
      // that fails — every pass saw an empty map and broadcast again, and the
      // same warning appeared in the notification centre more than once.
      //
      // The invariant is "one warning per agent per process", not "the store
      // was written", so this pins it with persistence removed entirely.
      mockedExecFileSync.mockImplementation((_file, args) => {
        const argv = args as string[] | undefined;
        if (argv?.[1] === "claude") {
          return Buffer.from("/opt/homebrew/bin/claude\n/Users/x/.local/bin/claude\n");
        }
        return Buffer.from("");
      });

      // Wiping the key after each pass is what a write that never landed looks
      // like from the next pass's point of view.
      storeBackingMap.delete("orchestrationMilestones");
      await service.checkAvailability();
      storeBackingMap.delete("orchestrationMilestones");
      await service.refresh();
      storeBackingMap.delete("orchestrationMilestones");
      await service.refresh();

      const toastCalls = mockedBroadcast.mock.calls.filter(
        (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
      );
      expect(toastCalls).toHaveLength(1);
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

    it("dedupes Windows PATH matches that share a directory (.cmd + .exe)", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      process.env.PATH = "C:\\Users\\x\\AppData\\Roaming\\npm";
      // Same npm-global directory, two extensions — counts as one install.
      virtualWindowsFiles.set({
        "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd": "",
        "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.exe": "",
      });
      try {
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

    it("takes the Windows .cmd shim beside npm's extensionless sh script", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      process.env.PATH = "C:\\npm\\prefix\\";
      virtualWindowsFiles.set({
        "C:\\npm\\prefix\\claude": "",
        "C:\\npm\\prefix\\claude.cmd": "",
        "C:\\npm\\prefix\\claude.ps1": "",
      });
      try {
        await service.checkAvailability();

        const detail = service.getDetails()!.claude!;
        expect(detail.allResolvedPaths).toBeUndefined();
        expect(detail.resolvedPath).toBe("C:\\npm\\prefix\\claude.cmd");

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

    it("counts only matches in absolute PATH entries, in PATH order", async () => {
      // The working directory and relative PATH entries are never searched, so
      // a same-named file there is not an install.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      process.env.PATH = ".;tools;C:\\Users\\x\\scoop\\shims;C:\\Users\\x\\AppData\\Roaming\\npm";
      virtualWindowsFiles.set({
        "C:\\Windows\\System32\\claude.exe": "",
        "C:\\Windows\\System32\\tools\\claude.exe": "",
        "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd": "",
        "C:\\Users\\x\\scoop\\shims\\claude.exe": "",
      });
      try {
        await service.checkAvailability();

        const detail = service.getDetails()!.claude!;
        expect(detail.resolvedPath).toBe("C:\\Users\\x\\scoop\\shims\\claude.exe");
        expect(detail.allResolvedPaths).toEqual([
          "C:\\Users\\x\\scoop\\shims\\claude.exe",
          "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd",
        ]);
        const toastCalls = mockedBroadcast.mock.calls.filter(
          (call) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
        );
        expect(toastCalls).toHaveLength(1);
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      }
    });

    it("reports an agent missing when it sits only outside PATH", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      process.env.PATH = ".;C:\\tools";
      virtualWindowsFiles.set({ "C:\\Windows\\System32\\claude.exe": "" });
      try {
        const result = await service.checkAvailability();

        expect(result.claude).toBe("missing");
        expect(service.getDetails()!.claude!.resolvedPath).toBeNull();
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
  });

  describe("plugin-contributed agent commands (issue #10560)", () => {
    it("probes an absolute plugin command path via the filesystem instead of rejecting it", async () => {
      const { registerPluginAgents, clearPluginAgentRegistryForTests } =
        await import("../../../shared/config/pluginAgentRegistry.js");
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);
      const absoluteCommand = "/tmp/daintree-plugins/acme/bin/agent";

      try {
        registerPluginAgents("acme.plugin", [
          {
            id: "acme-agent",
            name: "Acme Agent",
            command: absoluteCommand,
            color: "#3366ff",
            iconId: "terminal",
          },
        ]);

        // Built-in PATH binaries stay missing; only the plugin's absolute file resolves.
        mockedExecFileSync.mockImplementation(() => {
          throw new Error("Command not found");
        });
        mockedAccess.mockImplementation(async (p) => {
          if (String(p) === absoluteCommand) return undefined;
          throw new Error("ENOENT");
        });

        const result = await service.checkAvailability();

        // The absolute path is not rejected by VALID_COMMAND_RE — it is probed and found.
        expect(result["acme-agent"]).toBe("ready");
        expect(service.getDetails()?.["acme-agent"]?.resolvedPath).toBe(absoluteCommand);
      } finally {
        clearPluginAgentRegistryForTests();
      }
    });

    it("reports an absolute plugin command as missing when the file does not exist", async () => {
      const { registerPluginAgents, clearPluginAgentRegistryForTests } =
        await import("../../../shared/config/pluginAgentRegistry.js");
      const { access } = await import("fs/promises");
      const mockedAccess = vi.mocked(access);

      try {
        registerPluginAgents("acme.plugin", [
          {
            id: "acme-agent",
            name: "Acme Agent",
            command: join(homedir(), "plugins", "acme", "bin", "agent"),
            color: "#3366ff",
            iconId: "terminal",
          },
        ]);

        mockedExecFileSync.mockImplementation(() => {
          throw new Error("Command not found");
        });
        mockedAccess.mockRejectedValue(new Error("ENOENT"));

        const result = await service.checkAvailability();

        expect(result["acme-agent"]).toBe("missing");
      } finally {
        clearPluginAgentRegistryForTests();
      }
    });
  });

  describe("Windows native path probing (#12352)", () => {
    const savedWindowsEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32", writable: true });
      for (const name of ["USERPROFILE", "LOCALAPPDATA"]) {
        savedWindowsEnv[name] = process.env[name];
        delete process.env[name];
      }
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
    });

    afterEach(() => {
      for (const [name, value] of Object.entries(savedWindowsEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const onlyExisting = async (existingPath: string) => {
      const { access } = await import("fs/promises");
      vi.mocked(access).mockImplementation(async (p) => {
        if (String(p) === existingPath) return undefined;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
    };

    const checkPluginCommand = async (command: string) => {
      const { registerPluginAgents, clearPluginAgentRegistryForTests } =
        await import("../../../shared/config/pluginAgentRegistry.js");
      registerPluginAgents("acme.plugin", [
        { id: "acme-agent", name: "Acme Agent", command, color: "#3366ff", iconId: "terminal" },
      ]);
      try {
        await service.checkAvailability();
        return service.getDetails()?.["acme-agent"];
      } finally {
        clearPluginAgentRegistryForTests();
      }
    };

    it("finds an extensionless native entry through its .exe sibling", async () => {
      const claudeExe = `${join(homedir(), ".local/bin/claude")}.exe`;
      await onlyExisting(claudeExe);

      const result = await service.checkAvailability();

      expect(result.claude).toBe("unauthenticated");
      expect(service.getDetails()!.claude?.via).toBe("native");
      expect(service.getDetails()!.claude?.resolvedPath).toBe(claudeExe);
    });

    it("does not accept an extensionless file as a Windows install", async () => {
      await onlyExisting(join(homedir(), ".local/bin/claude"));

      const result = await service.checkAvailability();

      expect(result.claude).toBe("missing");
    });

    it("probes an entry that already carries .exe as written", async () => {
      process.env.USERPROFILE = "C:\\Users\\test";
      const gooseExe = "C:\\Users\\test\\.local\\bin\\goose.exe";
      await onlyExisting(gooseExe);

      await service.checkAvailability();

      expect(service.getDetails()!.goose?.via).toBe("native");
      expect(service.getDetails()!.goose?.resolvedPath).toBe(gooseExe);
    });

    it("never appends a second extension to an entry that already carries one", async () => {
      process.env.USERPROFILE = "C:\\Users\\test";
      await onlyExisting("C:\\Users\\test\\.local\\bin\\goose.exe.cmd");

      const result = await service.checkAvailability();

      expect(result.goose).toBe("missing");
    });

    it.each(["agent.EXE", "agent.ps1"])(
      "probes a plugin command already named %s as written",
      async (fileName) => {
        const command = `/tmp/daintree-plugins/acme/bin/${fileName}`;
        await onlyExisting(command);

        const detail = await checkPluginCommand(command);

        expect(detail?.state).toBe("ready");
        expect(detail?.resolvedPath).toBe(command);
      }
    );

    it.each(["agent", "agent-2.1"])(
      "resolves a plugin command named %s to its launchable sibling",
      async (fileName) => {
        const command = `/tmp/daintree-plugins/acme/bin/${fileName}`;
        await onlyExisting(`${command}.cmd`);

        const detail = await checkPluginCommand(command);

        expect(detail?.state).toBe("ready");
        expect(detail?.resolvedPath).toBe(`${command}.cmd`);
      }
    );

    it("reports the launch candidate that was denied, not the extensionless entry", async () => {
      const { access } = await import("fs/promises");
      const claudeExe = `${join(homedir(), ".local/bin/claude")}.exe`;
      vi.mocked(access).mockImplementation(async (p) => {
        const code = String(p) === claudeExe ? "EACCES" : "ENOENT";
        throw Object.assign(new Error(code), { code });
      });

      await service.checkAvailability();

      expect(service.getDetails()!.claude).toMatchObject({
        state: "blocked",
        via: "native",
        resolvedPath: claudeExe,
      });
    });
  });

  describe("check timeout (#12352)", () => {
    let savedLogOverrides: Record<string, string>;

    beforeEach(() => {
      savedLogOverrides = getLogLevelOverrides();
      setLogLevelOverrides({ "*": "info" });
      logBuffer.clear();
    });

    afterEach(() => {
      vi.useRealTimers();
      setLogLevelOverrides(savedLogOverrides);
      logBuffer.clear();
    });

    // The hung agent's PATH lookup never settles, so its check outlives the
    // batch budget while every other agent settles through microtasks.
    const hangPathLookupFor = (hungCommand: string) => {
      mockedFindAllOnPath.mockImplementation((command) =>
        command === hungCommand ? new Promise<string[]>(() => {}) : pathFixtureLookup(command)
      );
    };

    const timedOutAgentIds = () =>
      logBuffer
        .getFiltered({ sources: ["main:CliAvailabilityService"] })
        .filter((entry) => entry.level === "warn")
        .map(
          (entry) => (entry.context as { pendingAgentIds?: unknown } | undefined)?.pendingAgentIds
        )
        .filter((ids) => ids !== undefined);

    it("keeps agents that finished and logs the ones that did not", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "claude") return Buffer.from("/usr/local/bin/claude\n");
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      hangPathLookupFor("goose");

      vi.useFakeTimers();
      const checkPromise = service.checkAvailability();
      // Comfortably past the batch budget without pinning its exact value.
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await checkPromise;

      const details = service.getDetails()!;
      expect(result.claude).toBe("unauthenticated");
      expect(details.claude?.resolvedPath).toBe("/usr/local/bin/claude");
      expect(result.goose).toBe("missing");
      expect(details.goose?.message).toBeDefined();
      // A real miss carries no timeout message, so the two stay distinguishable.
      expect(details.gemini?.state).toBe("missing");
      expect(details.gemini?.message).toBeUndefined();
      expect(timedOutAgentIds()).toEqual([["goose"]]);
    });

    it("carries an agent's previous result forward when its re-check times out", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        const cmd = cmdOf(args);
        if (cmd === "claude") return Buffer.from("/usr/local/bin/claude\n");
        if (cmd === "goose") return Buffer.from("/usr/local/bin/goose\n");
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      await service.checkAvailability();
      const previousGoose = service.getDetails()!.goose;
      expect(previousGoose?.resolvedPath).toBe("/usr/local/bin/goose");
      expect(previousGoose?.message).toBeUndefined();

      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "claude") return Buffer.from("/opt/homebrew/bin/claude\n");
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      hangPathLookupFor("goose");

      vi.useFakeTimers();
      const refreshPromise = service.refresh();
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await refreshPromise;

      // Same observation as last time, flagged as not re-confirmed.
      expect(service.getDetails()!.goose).toEqual({
        ...previousGoose,
        message: expect.any(String),
      });
      expect(result.goose).toBe(previousGoose?.state);
      expect(service.getDetails()!.claude?.resolvedPath).toBe("/opt/homebrew/bin/claude");
      expect(timedOutAgentIds()).toEqual([["goose"]]);
    });

    it("keeps a carried agent's own diagnostic instead of the timeout note", async () => {
      // A native install the process may not execute is what gives claude a
      // diagnostic of its own here.
      const { access } = await import("fs/promises");
      const claudeNative = join(homedir(), ".local/bin/claude");
      vi.mocked(access).mockImplementation(async (p) => {
        if (String(p) === claudeNative) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      mockedExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      await service.checkAvailability();
      const blockedClaude = service.getDetails()!.claude;
      expect(blockedClaude?.state).toBe("blocked");
      expect(blockedClaude?.message).toBeDefined();

      hangPathLookupFor("claude");
      vi.useFakeTimers();
      const refreshPromise = service.refresh();
      await vi.advanceTimersByTimeAsync(60_000);
      await refreshPromise;

      // A fresh re-check would rebuild the same blocked detail, so pin that
      // claude really was carried rather than re-probed.
      expect(timedOutAgentIds()).toEqual([["claude"]]);
      expect(service.getDetails()!.claude).toEqual(blockedClaude);
    });

    it("never offers a timed-out check for reuse", async () => {
      hangPathLookupFor("goose");
      vi.useFakeTimers();
      const checkPromise = service.checkAvailability();
      await vi.advanceTimersByTimeAsync(60_000);
      await checkPromise;

      expect(service.getAvailability()).not.toBeNull();
      expect(service.getFreshAvailability(60 * 60_000)).toBeNull();
    });

    it("isolates an agent whose check throws from the rest of the batch", async () => {
      mockedExecFileSync.mockImplementation((_file, args) => {
        if (cmdOf(args) === "claude") return Buffer.from("/usr/local/bin/claude\n");
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      });
      // Any throw inside one agent's probe ladder stands in here.
      mockedFindAllOnPath.mockImplementation((command) =>
        command === "goose" ? Promise.reject(new Error("EBADF")) : pathFixtureLookup(command)
      );

      const result = await service.checkAvailability();

      expect(result.goose).toBe("missing");
      expect(service.getDetails()!.claude?.resolvedPath).toBe("/usr/local/bin/claude");
      const failedAgentIds = logBuffer
        .getFiltered({ sources: ["main:CliAvailabilityService"] })
        .filter((entry) => entry.level === "error")
        .map((entry) => (entry.context as { agentId?: unknown } | undefined)?.agentId);
      expect(failedAgentIds).toEqual(["goose"]);
    });
  });

  describe("getFreshAvailability", () => {
    it("offers a complete check only while it is younger than the reuse window", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const result = await service.checkAvailability();

      expect(service.getFreshAvailability(1_000)).toBe(result);
      vi.setSystemTime(Date.now() + 1_000);
      expect(service.getFreshAvailability(1_000)).toBeNull();
    });

    it("withdraws reuse once the effective agent registry changes", async () => {
      const { setUserRegistry } = await import("../../../shared/config/agentRegistry.js");
      await service.checkAvailability();
      expect(service.getFreshAvailability(60_000)).not.toBeNull();

      try {
        setUserRegistry({
          "fresh-test": {
            id: "fresh-test",
            name: "Fresh Test",
            command: "fresh-test",
            color: "#abcdef",
            iconId: "fresh-test",
            supportsContextInjection: false,
          },
        });
        expect(service.getFreshAvailability(60_000)).toBeNull();
      } finally {
        setUserRegistry({});
      }
    });

    it("offers nothing before the first check or while a refresh is replacing it", async () => {
      expect(service.getFreshAvailability(60_000)).toBeNull();
      await service.checkAvailability();

      const refreshPromise = service.refresh();
      expect(service.getFreshAvailability(60_000)).toBeNull();
      const refreshed = await refreshPromise;
      expect(service.getFreshAvailability(60_000)).toBe(refreshed);
    });
  });
});
