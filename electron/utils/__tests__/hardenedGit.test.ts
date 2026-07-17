import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The hooks-path resolver reads DAINTREE_USER_DATA first (the workspace-host
// route), so pointing it at a temp dir keeps the suite off the real userData
// path. Set before any factory call — the resolved directory is memoized on
// first use.
const TEST_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-hardened-git-"));
process.env.DAINTREE_USER_DATA = TEST_USER_DATA;

afterAll(() => {
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
});

const mockGitInstance: Record<string, ReturnType<typeof vi.fn>> = {
  raw: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
  env: vi.fn(),
};
mockGitInstance.env.mockReturnValue(mockGitInstance);

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockGitInstance),
}));

import {
  validateCwd,
  createHardenedGit,
  createAuthenticatedGit,
  createBackgroundFetchGit,
  createWslHardenedGit,
  getGitLocaleEnv,
  buildHardenedGitEnv,
  buildContinueEnv,
  getHardenedGitConfig,
  selectUserDataDir,
  toGitConfigPath,
} from "../hardenedGit.js";
import { simpleGit } from "simple-git";

/**
 * Pull the generated `core.hooksPath` value out of a captured config array.
 * Tests assert invariants on this (absolute, non-empty, app-owned) rather than
 * pinning the literal, which would just restate the implementation.
 */
function hooksPathValues(config: readonly string[]): string[] {
  return config
    .filter((entry) => entry.startsWith("core.hooksPath="))
    .map((entry) => entry.slice("core.hooksPath=".length));
}

function soleHooksPath(config: readonly string[]): string {
  const values = hooksPathValues(config);
  expect(values).toHaveLength(1);
  return values[0];
}

function capturedConfig(callIndex = 0): string[] {
  return (simpleGit as ReturnType<typeof vi.fn>).mock.calls[callIndex][0].config;
}

describe("validateCwd", () => {
  it("throws for empty string", async () => {
    expect(() => validateCwd("")).toThrow("Invalid working directory");
  });

  it("throws for whitespace-only string", async () => {
    expect(() => validateCwd("   ")).toThrow("Invalid working directory");
  });

  it("throws for non-string input (number)", async () => {
    expect(() => validateCwd(123)).toThrow("Invalid working directory");
  });

  it("throws for non-string input (null)", async () => {
    expect(() => validateCwd(null)).toThrow("Invalid working directory");
  });

  it("throws for non-string input (undefined)", async () => {
    expect(() => validateCwd(undefined)).toThrow("Invalid working directory");
  });

  it("throws for relative path", async () => {
    expect(() => validateCwd("relative/path")).toThrow("absolute path");
  });

  it("throws for parent traversal path", async () => {
    expect(() => validateCwd("../malicious-repo")).toThrow("absolute path");
  });

  it("throws for dot-relative path", async () => {
    expect(() => validateCwd("./something")).toThrow("absolute path");
  });

  it("does not throw for absolute path (unix)", async () => {
    expect(() => validateCwd("/absolute/path")).not.toThrow();
  });

  it("does not throw for root path", async () => {
    expect(() => validateCwd("/")).not.toThrow();
  });
});

describe("createHardenedGit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls simpleGit with correct baseDir", async () => {
    await createHardenedGit("/test/repo");

    expect(simpleGit).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDir: "/test/repo",
      })
    );
  });

  it("disables fsmonitor to prevent cross-worktree contamination", async () => {
    await createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("core.fsmonitor=false");
    expect(options.config).not.toContain("core.fsmonitor=true");
  });

  it("passes config overrides including protocol.ext.allow=never", async () => {
    await createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("protocol.ext.allow=never");
  });

  it("disables core.sshCommand via config", async () => {
    await createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("core.sshCommand=");
  });

  it("disables credential.helper via config", async () => {
    await createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("credential.helper=");
  });

  it("enables allowUnsafe flags for overriding blocked config keys", async () => {
    await createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.unsafe).toEqual({
      allowUnsafeAskPass: true,
      allowUnsafeCredentialHelper: true,
      allowUnsafeProtocolOverride: true,
      allowUnsafeFsMonitor: true,
      allowUnsafePager: true,
      allowUnsafeSshCommand: true,
      allowUnsafeGitProxy: true,
      allowUnsafeHooksPath: true,
      allowUnsafeEditor: true,
    });
  });

  it("includes all security-critical config overrides", async () => {
    await createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const expectedKeys = [
      "core.fsmonitor=false",
      "core.untrackedCache=keep",
      "core.pager=cat",
      "core.askpass=",
      "credential.helper=",
      "protocol.ext.allow=never",
      "core.sshCommand=",
      "core.gitProxy=",
      "core.quotepath=false",
      "core.precomposeunicode=true",
    ];
    for (const key of expectedKeys) {
      expect(options.config).toContain(key);
    }
    // Count the static entries on their own; the generated hooks entry has its
    // own coverage below, and folding it into this total would hide a change to
    // either half behind one number.
    const staticEntries = options.config.filter(
      (entry: string) => !entry.startsWith("core.hooksPath=")
    );
    expect(staticEntries).toHaveLength(expectedKeys.length);
  });

  it("passes abort signal when provided", async () => {
    const controller = new AbortController();
    await createHardenedGit("/test/repo", controller.signal);

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.abort).toBe(controller.signal);
  });

  it("does not include abort option when no signal provided", async () => {
    await createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options).not.toHaveProperty("abort");
  });

  it("sets LC_MESSAGES=C, LANGUAGE empty, and GIT_OPTIONAL_LOCKS=0 via .env()", async () => {
    await createHardenedGit("/test/repo");

    expect(mockGitInstance.env).toHaveBeenCalledWith(
      expect.objectContaining({
        LC_MESSAGES: "C",
        LANGUAGE: "",
        GIT_OPTIONAL_LOCKS: "0",
      })
    );
  });

  it("sets a platform-appropriate LC_CTYPE so non-ASCII paths survive iconv", async () => {
    await createHardenedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(typeof envArg.LC_CTYPE).toBe("string");
    expect(envArg.LC_CTYPE).toMatch(/UTF-8$/);
  });

  it("clears inherited LC_ALL so the more specific LC_CTYPE / LC_MESSAGES win", async () => {
    const orig = process.env.LC_ALL;
    process.env.LC_ALL = "C";
    try {
      await createHardenedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.LC_ALL).toBe("");
    } finally {
      if (orig === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = orig;
    }
  });

  it("does not apply hardened SSH command (blocked via config instead)", async () => {
    const origSsh = process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_COMMAND;
    try {
      await createHardenedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.GIT_SSH_COMMAND).toBeUndefined();
    } finally {
      if (origSsh !== undefined) process.env.GIT_SSH_COMMAND = origSsh;
    }
  });

  it("spreads process.env into hardenedGit .env() call", async () => {
    process.env.DAINTREE_TEST_SENTINEL = "sentinel_value";
    try {
      await createHardenedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.PATH).toBe(process.env.PATH);
      expect(envArg.DAINTREE_TEST_SENTINEL).toBe("sentinel_value");
    } finally {
      delete process.env.DAINTREE_TEST_SENTINEL;
    }
  });

  it("strips inherited git execution env before applying hardened overrides", async () => {
    const envKeys = [
      "EDITOR",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_PAGER",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "PAGER",
      "PREFIX",
      "SSH_ASKPASS",
    ];
    const originals = new Map(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) {
      process.env[key] = "inherited-unsafe-value";
    }
    try {
      await createHardenedGit("/test/repo", undefined, "linux");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      for (const key of envKeys) {
        expect(envArg[key]).toBeUndefined();
      }
      expect(envArg.GIT_ASKPASS).toBe("true");
      expect(envArg.GIT_TERMINAL_PROMPT).toBe("0");
    } finally {
      for (const [key, value] of originals) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("locale env values override conflicting process.env entries", async () => {
    const origMessages = process.env.LC_MESSAGES;
    const origLanguage = process.env.LANGUAGE;
    process.env.LC_MESSAGES = "fr_FR.UTF-8";
    process.env.LANGUAGE = "fr_FR";
    try {
      await createHardenedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.LC_MESSAGES).toBe("C");
      expect(envArg.LANGUAGE).toBe("");
    } finally {
      if (origMessages === undefined) delete process.env.LC_MESSAGES;
      else process.env.LC_MESSAGES = origMessages;
      if (origLanguage === undefined) delete process.env.LANGUAGE;
      else process.env.LANGUAGE = origLanguage;
    }
  });

  it("suppresses optional .git/index.lock writes via GIT_OPTIONAL_LOCKS=0", async () => {
    await createHardenedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("blocks interactive credential prompts via GIT_TERMINAL_PROMPT=0", async () => {
    await createHardenedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("disables Windows GCM interactive dialogs via GCM_INTERACTIVE=Never", async () => {
    await createHardenedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GCM_INTERACTIVE).toBe("Never");
  });

  it("sets GIT_ASKPASS=true on POSIX so credential helpers fail fast", async () => {
    await createHardenedGit("/test/repo", undefined, "darwin");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_ASKPASS).toBe("true");
  });

  it("sets GIT_ASKPASS=true on linux", async () => {
    await createHardenedGit("/test/repo", undefined, "linux");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_ASKPASS).toBe("true");
  });

  it("does not set GIT_ASKPASS on Windows (no `true` binary on PATH)", async () => {
    const origAskpass = process.env.GIT_ASKPASS;
    delete process.env.GIT_ASKPASS;
    try {
      await createHardenedGit("/test/repo", undefined, "win32");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.GIT_ASKPASS).toBeUndefined();
    } finally {
      if (origAskpass !== undefined) process.env.GIT_ASKPASS = origAskpass;
    }
  });
});

describe("createAuthenticatedGit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls simpleGit with correct baseDir", async () => {
    await createAuthenticatedGit("/test/repo");

    expect(simpleGit).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDir: "/test/repo",
      })
    );
  });

  it("does not include credential-blocking config entries", async () => {
    await createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).not.toContain("credential.helper=");
    expect(options.config).not.toContain("core.sshCommand=");
    expect(options.config).not.toContain("core.askpass=");
  });

  it("includes all non-credential security config entries", async () => {
    await createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("core.fsmonitor=false");
    expect(options.config).toContain("core.untrackedCache=keep");
    expect(options.config).toContain("core.pager=cat");
    expect(options.config).toContain("protocol.ext.allow=never");
    expect(options.config).toContain("core.gitProxy=");
    expect(options.config).toContain("core.quotepath=false");
    expect(options.config).toContain("core.precomposeunicode=true");
    expect(path.isAbsolute(soleHooksPath(options.config))).toBe(true);
  });

  it("sets GIT_TERMINAL_PROMPT, hardened GIT_SSH_COMMAND, and GIT_OPTIONAL_LOCKS=0 via .env()", async () => {
    await createAuthenticatedGit("/test/repo");

    expect(mockGitInstance.env).toHaveBeenCalledWith(
      expect.objectContaining({
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND:
          "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15",
        GIT_OPTIONAL_LOCKS: "0",
      })
    );
  });

  it("sets GIT_OPTIONAL_LOCKS=0 to suppress incidental lock writes", async () => {
    await createAuthenticatedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("sets GCM_INTERACTIVE=Never to prevent Windows GCM dialogs", async () => {
    await createAuthenticatedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GCM_INTERACTIVE).toBe("Never");
  });

  it("does NOT set GIT_ASKPASS so legitimate credential helpers can resolve", async () => {
    const origAskpass = process.env.GIT_ASKPASS;
    delete process.env.GIT_ASKPASS;
    try {
      await createAuthenticatedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.GIT_ASKPASS).toBeUndefined();
    } finally {
      if (origAskpass !== undefined) process.env.GIT_ASKPASS = origAskpass;
    }
  });

  it("sets LC_MESSAGES=C, LANGUAGE empty, and GIT_OPTIONAL_LOCKS=0 via .env()", async () => {
    await createAuthenticatedGit("/test/repo");

    expect(mockGitInstance.env).toHaveBeenCalledWith(
      expect.objectContaining({
        LC_MESSAGES: "C",
        LANGUAGE: "",
        GIT_OPTIONAL_LOCKS: "0",
      })
    );
  });

  it("sets a platform-appropriate LC_CTYPE so non-ASCII paths survive iconv", async () => {
    await createAuthenticatedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(typeof envArg.LC_CTYPE).toBe("string");
    expect(envArg.LC_CTYPE).toMatch(/UTF-8$/);
  });

  it("clears inherited LC_ALL so the more specific LC_CTYPE / LC_MESSAGES win", async () => {
    const orig = process.env.LC_ALL;
    process.env.LC_ALL = "C";
    try {
      await createAuthenticatedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.LC_ALL).toBe("");
    } finally {
      if (orig === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = orig;
    }
  });

  it("spreads process.env into the .env() call", async () => {
    process.env.DAINTREE_TEST_SENTINEL = "sentinel_value";
    try {
      await createAuthenticatedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.PATH).toBe(process.env.PATH);
      expect(envArg.HOME).toBe(process.env.HOME);
      expect(envArg.DAINTREE_TEST_SENTINEL).toBe("sentinel_value");
    } finally {
      delete process.env.DAINTREE_TEST_SENTINEL;
    }
  });

  it("forced env values override conflicting process.env entries", async () => {
    const origPrompt = process.env.GIT_TERMINAL_PROMPT;
    const origSsh = process.env.GIT_SSH_COMMAND;
    const origPager = process.env.GIT_PAGER;
    const origMessages = process.env.LC_MESSAGES;
    const origLanguage = process.env.LANGUAGE;
    process.env.GIT_TERMINAL_PROMPT = "1";
    process.env.GIT_SSH_COMMAND = "ssh -i /custom/key";
    process.env.GIT_PAGER = "dangerous-pager";
    process.env.LC_MESSAGES = "fr_FR.UTF-8";
    process.env.LANGUAGE = "fr_FR";
    try {
      await createAuthenticatedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.GIT_TERMINAL_PROMPT).toBe("0");
      expect(envArg.GIT_SSH_COMMAND).toBe(
        "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15"
      );
      expect(envArg.GIT_PAGER).toBeUndefined();
      expect(envArg.LC_MESSAGES).toBe("C");
      expect(envArg.LANGUAGE).toBe("");
    } finally {
      if (origPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = origPrompt;
      if (origSsh === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origSsh;
      if (origPager === undefined) delete process.env.GIT_PAGER;
      else process.env.GIT_PAGER = origPager;
      if (origMessages === undefined) delete process.env.LC_MESSAGES;
      else process.env.LC_MESSAGES = origMessages;
      if (origLanguage === undefined) delete process.env.LANGUAGE;
      else process.env.LANGUAGE = origLanguage;
    }
  });

  it("sets block timeout to 0 for network operations", async () => {
    await createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.timeout).toEqual({ block: 0 });
  });

  it("enables allowUnsafe flags", async () => {
    await createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.unsafe).toEqual({
      allowUnsafeAskPass: true,
      allowUnsafeCredentialHelper: true,
      allowUnsafeProtocolOverride: true,
      allowUnsafeFsMonitor: true,
      allowUnsafePager: true,
      allowUnsafeSshCommand: true,
      allowUnsafeGitProxy: true,
      allowUnsafeHooksPath: true,
      allowUnsafeEditor: true,
    });
  });

  it("forwards abort signal when provided", async () => {
    const controller = new AbortController();
    await createAuthenticatedGit("/test/repo", { signal: controller.signal });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.abort).toBe(controller.signal);
  });

  it("does not include abort option when no signal provided", async () => {
    await createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options).not.toHaveProperty("abort");
  });

  it("forwards progress callback when provided", async () => {
    const progressFn = vi.fn();
    await createAuthenticatedGit("/test/repo", { progress: progressFn });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.progress).toBe(progressFn);
  });

  it("does not include progress option when not provided", async () => {
    await createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options).not.toHaveProperty("progress");
  });

  it("appends extraConfig items to config", async () => {
    await createAuthenticatedGit("/test/repo", {
      extraConfig: ["transfer.bundleURI=false"],
    });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("transfer.bundleURI=false");
  });
});

describe("createBackgroundFetchGit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("layers background-fetch config on top of authenticated config", async () => {
    const controller = new AbortController();
    await createBackgroundFetchGit("/test/repo", { signal: controller.signal });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("core.packedRefsTimeout=5000");
    expect(options.config).toContain("http.lowSpeedLimit=1000");
    expect(options.config).toContain("http.lowSpeedTime=30");
    expect(options.config).toContain("gc.auto=0");
    // Inherits authenticated base — no credential-blocking entries.
    expect(options.config).not.toContain("credential.helper=");
    expect(options.config).not.toContain("core.askpass=");
  });

  it("forwards the abort signal to simple-git", async () => {
    const controller = new AbortController();
    await createBackgroundFetchGit("/test/repo", { signal: controller.signal });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.abort).toBe(controller.signal);
  });

  it("sets GIT_ASKPASS=true on POSIX so credential helpers fail fast", async () => {
    const controller = new AbortController();
    await createBackgroundFetchGit("/test/repo", {
      signal: controller.signal,
      platform: "darwin",
    });

    // Last env() call wins — the POSIX askpass override is applied second.
    const lastEnv = mockGitInstance.env.mock.calls[mockGitInstance.env.mock.calls.length - 1][0];
    expect(lastEnv.GIT_ASKPASS).toBe("true");
    expect(lastEnv.GIT_TERMINAL_PROMPT).toBe("0");
    expect(lastEnv.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("re-states GIT_OPTIONAL_LOCKS and GCM_INTERACTIVE in the POSIX second .env() call", async () => {
    const controller = new AbortController();
    await createBackgroundFetchGit("/test/repo", {
      signal: controller.signal,
      platform: "darwin",
    });

    // The second .env() replaces (not merges) the first call's env, so the
    // hardening flags from createAuthenticatedGit must be re-asserted here.
    const lastEnv = mockGitInstance.env.mock.calls[mockGitInstance.env.mock.calls.length - 1][0];
    expect(lastEnv.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(lastEnv.GCM_INTERACTIVE).toBe("Never");
  });

  it("does not set GIT_ASKPASS on Windows (no `true` binary on PATH)", async () => {
    const controller = new AbortController();
    await createBackgroundFetchGit("/test/repo", {
      signal: controller.signal,
      platform: "win32",
    });

    // The base authenticated env() call doesn't set GIT_ASKPASS, and the
    // POSIX-only override is skipped. Only one env() call should happen.
    expect(mockGitInstance.env.mock.calls).toHaveLength(1);
    const env = mockGitInstance.env.mock.calls[0][0];
    expect(env.GIT_ASKPASS).toBeUndefined();
  });

  it("appends caller-supplied extraConfig after background-fetch config", async () => {
    const controller = new AbortController();
    await createBackgroundFetchGit("/test/repo", {
      signal: controller.signal,
      extraConfig: ["transfer.bundleURI=false"],
    });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("transfer.bundleURI=false");
    expect(options.config).toContain("core.packedRefsTimeout=5000");
  });

  it("inherits block timeout 0 from authenticated profile", async () => {
    const controller = new AbortController();
    await createBackgroundFetchGit("/test/repo", { signal: controller.signal });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.timeout).toEqual({ block: 0 });
  });
});

describe("createWslHardenedGit", () => {
  const ORIGINAL_PLATFORM = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: ORIGINAL_PLATFORM,
      configurable: true,
    });
  });

  it("throws on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    await expect(
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
        posixPath: "/home/user/proj",
      })
    ).rejects.toThrow("only available on Windows");
  });

  it("throws when distro is empty", async () => {
    await expect(
      createWslHardenedGit({
        distro: "",
        uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
        posixPath: "/home/user/proj",
      })
    ).rejects.toThrow("WSL distro");
  });

  it("throws when posix path does not start with /", async () => {
    await expect(
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
        posixPath: "home/user/proj",
      })
    ).rejects.toThrow("posix path");
  });

  it("throws when UNC path is not a WSL UNC", async () => {
    await expect(
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "C:\\repos\\proj",
        posixPath: "/home/user/proj",
      })
    ).rejects.toThrow("UNC path");
  });

  it("rejects strings starting with \\\\wsl but missing the WSL UNC shape", async () => {
    // Old `startsWith("\\\\wsl")` gate let this through; tightened check
    // (detectWslPath) fails closed on the malformed shape.
    await expect(
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wslfoo\\bar",
        posixPath: "/home/user/proj",
      })
    ).rejects.toThrow("UNC path");
  });

  it("rejects bare \\\\wsl$\\ with no distro segment", async () => {
    await expect(
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\",
        posixPath: "/",
      })
    ).rejects.toThrow("UNC path");
  });

  it("rejects bare \\\\wsl.localhost\\ with no distro segment", async () => {
    await expect(
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl.localhost\\",
        posixPath: "/",
      })
    ).rejects.toThrow("UNC path");
  });

  it("rejects when supplied distro does not match parsed UNC distro", async () => {
    await expect(
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\Debian\\home\\user\\proj",
        posixPath: "/home/user/proj",
      })
    ).rejects.toThrow("distro does not match");
  });

  it("rejects when supplied posixPath does not match parsed UNC remainder", async () => {
    await expect(
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
        posixPath: "/some/other/path",
      })
    ).rejects.toThrow("posix path does not match");
  });

  it("uses the UNC path as baseDir so simple-git's statSync succeeds on Windows", async () => {
    await createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    expect(simpleGit).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDir: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      })
    );
  });

  it("sets binary to wsl.exe + git two-tuple", async () => {
    await createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.binary).toEqual(["wsl.exe", "git"]);
  });

  it("carries the same non-path hardening as the native hardened profile", async () => {
    await createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    // Compare with the hooks entry stripped: WSL intentionally diverges there
    // (its git runs inside the distro), but every other override must match.
    const withoutHooks = (config: readonly string[]) =>
      config.filter((entry) => !entry.startsWith("core.hooksPath="));

    expect(withoutHooks(capturedConfig())).toEqual(withoutHooks(getHardenedGitConfig()));
  });

  it("points core.hooksPath at a POSIX path inside the distro, not the Windows host", async () => {
    await createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    const hooksPath = soleHooksPath(capturedConfig());
    // Linux git resolves anything without a leading `/` (or an expandable `~`)
    // against the CWD — which during a checkout is the worktree root. That is
    // the #11226 defect, so the WSL value must be neither.
    expect(hooksPath.startsWith("/") || hooksPath.startsWith("~/")).toBe(true);
    expect(hooksPath).not.toMatch(/^[A-Za-z]:/);
    expect(hooksPath).not.toContain("\\");
  });

  it("sets WSL_DISTRO_NAME, GIT_OPTIONAL_LOCKS=0, and locale in env for diagnostics", async () => {
    await createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.WSL_DISTRO_NAME).toBe("Ubuntu");
    expect(envArg.LC_CTYPE).toBe("C.UTF-8");
    expect(envArg.LC_ALL).toBe("");
    expect(envArg.LC_MESSAGES).toBe("C");
    expect(envArg.LANGUAGE).toBe("");
    expect(envArg.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("applies the same env hardening as createHardenedGit (Linux git inside WSL)", async () => {
    await createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(envArg.GIT_TERMINAL_PROMPT).toBe("0");
    expect(envArg.GIT_ASKPASS).toBe("true");
    expect(envArg.GCM_INTERACTIVE).toBe("Never");
  });

  it("forwards abort signal when provided", async () => {
    const controller = new AbortController();
    await createWslHardenedGit(
      {
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
        posixPath: "/home/user/proj",
      },
      controller.signal
    );

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.abort).toBe(controller.signal);
  });

  it("enables allowUnsafe flags matching createHardenedGit", async () => {
    await createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.unsafe).toEqual({
      allowUnsafeAskPass: true,
      allowUnsafeCredentialHelper: true,
      allowUnsafeProtocolOverride: true,
      allowUnsafeFsMonitor: true,
      allowUnsafePager: true,
      allowUnsafeSshCommand: true,
      allowUnsafeGitProxy: true,
      allowUnsafeHooksPath: true,
      allowUnsafeEditor: true,
    });
  });
});

describe("getGitLocaleEnv", () => {
  it("returns LC_CTYPE=C.UTF-8, LANG=C.UTF-8, and GIT_OPTIONAL_LOCKS=0 on win32", async () => {
    expect(getGitLocaleEnv("win32")).toEqual({
      LC_CTYPE: "C.UTF-8",
      LANG: "C.UTF-8",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("returns LC_CTYPE=en_US.UTF-8 and GIT_OPTIONAL_LOCKS=0 on darwin (macOS lacks C.UTF-8)", async () => {
    expect(getGitLocaleEnv("darwin")).toEqual({
      LC_CTYPE: "en_US.UTF-8",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("returns LC_CTYPE=C.UTF-8 and GIT_OPTIONAL_LOCKS=0 on linux", async () => {
    expect(getGitLocaleEnv("linux")).toEqual({
      LC_CTYPE: "C.UTF-8",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("does not set LANG on non-win32 platforms", async () => {
    expect(getGitLocaleEnv("linux")).not.toHaveProperty("LANG");
    expect(getGitLocaleEnv("darwin")).not.toHaveProperty("LANG");
  });
});

describe("config profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hardened profile includes credential-blocking entries", async () => {
    expect(getHardenedGitConfig()).toContain("credential.helper=");
    expect(getHardenedGitConfig()).toContain("core.sshCommand=");
    expect(getHardenedGitConfig()).toContain("core.askpass=");
  });

  it("authenticated profile excludes credential-blocking entries", async () => {
    await createAuthenticatedGit("/test/repo");

    const config = capturedConfig();
    expect(config).not.toContain("credential.helper=");
    expect(config).not.toContain("core.sshCommand=");
    expect(config).not.toContain("core.askpass=");
  });

  it("both profiles share the same security base entries", async () => {
    const securityEntries = [
      "core.fsmonitor=false",
      "core.untrackedCache=keep",
      "core.pager=cat",
      "protocol.ext.allow=never",
      "core.gitProxy=",
      "core.quotepath=false",
      "core.precomposeunicode=true",
    ];
    await createAuthenticatedGit("/test/repo");
    const authenticated = capturedConfig();

    for (const entry of securityEntries) {
      expect(getHardenedGitConfig()).toContain(entry);
      expect(authenticated).toContain(entry);
    }
  });

  it("both profiles resolve the same app-owned hooks directory", async () => {
    await createAuthenticatedGit("/test/repo");

    const shared = soleHooksPath(capturedConfig());
    expect(shared).toBe(soleHooksPath(getHardenedGitConfig()));
    // Without this the assertion would hold for two empty strings, which is
    // precisely the state being fixed.
    expect(path.isAbsolute(shared)).toBe(true);
  });
});

describe("core.hooksPath enforcement (issue #11226)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // An empty or otherwise relative value is resolved against the process CWD,
  // which during `git worktree add` is the new worktree root — that is how
  // git-lfs came to self-install four hook files there.
  it("is absolute and non-empty, so it can never resolve against the CWD", async () => {
    await createHardenedGit("/test/repo");

    const hooksPath = soleHooksPath(capturedConfig());
    expect(hooksPath).not.toBe("");
    expect(path.isAbsolute(hooksPath)).toBe(true);
  });

  it("points inside the resolved userData directory", async () => {
    await createHardenedGit("/test/repo");

    const hooksPath = soleHooksPath(capturedConfig());
    const relative = path.relative(process.env.DAINTREE_USER_DATA as string, hooksPath);
    expect(relative).not.toBe("");
    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
  });

  it("creates the hooks directory so git-lfs has somewhere to install", async () => {
    await createHardenedGit("/test/repo");

    expect(fs.existsSync(soleHooksPath(capturedConfig()))).toBe(true);
  });

  // Guards against double-emission. The WSL profile is covered by its own suite,
  // whose soleHooksPath call enforces the same cardinality.
  it("appears exactly once in every profile", async () => {
    await createHardenedGit("/test/repo");
    expect(hooksPathValues(capturedConfig())).toHaveLength(1);

    await createAuthenticatedGit("/test/repo");
    expect(hooksPathValues(capturedConfig(1))).toHaveLength(1);

    expect(hooksPathValues(getHardenedGitConfig())).toHaveLength(1);
  });

  // git takes the last -c for a single-valued key, so a caller-supplied
  // override must not be able to displace the enforcement value.
  it("wins over a conflicting core.hooksPath passed via extraConfig", async () => {
    await createAuthenticatedGit("/test/repo", {
      extraConfig: ["core.hooksPath=/tmp/attacker-controlled"],
    });

    const effective = hooksPathValues(capturedConfig()).at(-1);
    expect(effective).not.toBe("/tmp/attacker-controlled");
    expect(effective).toBe(soleHooksPath(getHardenedGitConfig()));
  });

  it("background fetch inherits the enforced hooks path", async () => {
    const controller = new AbortController();
    await createBackgroundFetchGit("/test/repo", { signal: controller.signal });

    expect(path.isAbsolute(soleHooksPath(capturedConfig()))).toBe(true);
  });
});

// The hooks directory is resolved and memoized on first use, so these need a
// fresh module registry per case rather than the file-wide instance.
describe("hooks directory resolution", () => {
  const originalUserData = process.env.DAINTREE_USER_DATA;

  afterEach(() => {
    process.env.DAINTREE_USER_DATA = originalUserData;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function importFresh(userData: string | undefined) {
    vi.resetModules();
    if (userData === undefined) delete process.env.DAINTREE_USER_DATA;
    else process.env.DAINTREE_USER_DATA = userData;
    return import("../hardenedGit.js");
  }

  it("does not touch the filesystem at import time", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-lazy-"));
    const mod = await importFresh(userData);

    // Importing hardenedGit.ts must stay inert: it is pulled in very early and
    // very broadly, before dev overrides userData.
    expect(fs.existsSync(path.join(userData, "git-hooks"))).toBe(false);

    mod.getHardenedGitConfig();
    expect(fs.existsSync(path.join(userData, "git-hooks"))).toBe(true);

    fs.rmSync(userData, { recursive: true, force: true });
  });

  it("resolves once and reuses the result", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-memo-"));
    const mod = await importFresh(userData);

    const first = mod.getHardenedGitConfig().find((e) => e.startsWith("core.hooksPath="));
    process.env.DAINTREE_USER_DATA = path.join(os.tmpdir(), "daintree-moved-elsewhere");
    const second = mod.getHardenedGitConfig().find((e) => e.startsWith("core.hooksPath="));

    expect(second).toBe(first);

    fs.rmSync(userData, { recursive: true, force: true });
  });

  it("keeps a directory-creation failure non-fatal, still emitting an absolute path", async () => {
    // A path *under a regular file* makes the real mkdir fail with ENOTDIR — no
    // fs mocking needed to reach the failure branch.
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-enotdir-")), "afile");
    fs.writeFileSync(blocker, "not a directory");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mod = await importFresh(blocker);
    const hooksPath = mod
      .getHardenedGitConfig()
      .find((e) => e.startsWith("core.hooksPath="))
      ?.slice("core.hooksPath=".length);

    // git blocks repo-supplied hooks against a path that does not exist, so the
    // security invariant survives a creation failure — only git-lfs's install
    // target is lost, which must not take git down with it.
    expect(hooksPath).toBeDefined();
    expect(path.isAbsolute(hooksPath as string)).toBe(true);
    expect(fs.existsSync(hooksPath as string)).toBe(false);

    mod.getHardenedGitConfig();
    mod.getHardenedGitConfig();
    // Warned once, not once per git invocation — this rides the status-polling path.
    expect(errorSpy).toHaveBeenCalledTimes(1);

    fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
  });
});

/**
 * The `require("electron")` read cannot be reached under vitest — the bundled
 * main gets `require` from an esbuild banner that vitest has no equivalent for,
 * and stubbing the global does not rebind the module's identifier. Its
 * precedence logic is therefore tested through `selectUserDataDir`, which takes
 * the candidates as arguments.
 */
describe("selectUserDataDir", () => {
  const HOME = "/home/alice";
  const home = () => HOME;

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DAINTREE_UTILITY_PROCESS_KIND;
  });

  // Every workspace host would otherwise attempt a require("electron") it can
  // never satisfy, on its first git call.
  it("prefers an absolute env value, without consulting electron", () => {
    const electron = vi.fn(() => "/electron/userdata");

    expect(selectUserDataDir("/env/userdata", electron, home)).toBe("/env/userdata");
    expect(electron).not.toHaveBeenCalled();
  });

  it("uses electron's userData when no env value is set — the main-process path", () => {
    expect(selectUserDataDir(undefined, () => "/electron/userdata", home)).toBe(
      "/electron/userdata"
    );
  });

  // A relative value would be resolved against the cwd, which is the defect
  // this override exists to prevent.
  it("skips a relative env value and reports it", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(selectUserDataDir("relative/userdata", () => "/electron/userdata", home)).toBe(
      "/electron/userdata"
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it("skips a relative electron value too", () => {
    expect(selectUserDataDir(undefined, () => "relative/userdata", home)).toBe(
      path.join(HOME, ".daintree")
    );
  });

  it("falls back to the home directory when neither source is usable", () => {
    expect(selectUserDataDir(undefined, () => undefined, home)).toBe(path.join(HOME, ".daintree"));
  });

  // In a utility process the env var is supplied by the fork; missing it means
  // main and the host have split onto different hook roots.
  it("reports a fallback inside a utility process, where it is never expected", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.DAINTREE_UTILITY_PROCESS_KIND = "workspace-host";

    selectUserDataDir(undefined, () => undefined, home);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("workspace-host"));
  });

  it("stays quiet on the ordinary main-process path", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    selectUserDataDir(undefined, () => "/electron/userdata", home);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("throws rather than ever resolving against the cwd", () => {
    expect(() =>
      selectUserDataDir(
        undefined,
        () => undefined,
        () => ""
      )
    ).toThrow(/absolute userData/);
  });
});

describe("toGitConfigPath", () => {
  // git parses -c values with backslash escapes; forward slashes are accepted
  // on every platform and sidestep the question entirely.
  it("converts Windows separators to forward slashes, preserving every segment", () => {
    const segments = ["C:", "Users", "Alice", "AppData", "Daintree", "git-hooks"];
    const converted = toGitConfigPath(segments.join("\\"), "win32");

    expect(converted).not.toContain("\\");
    expect(path.win32.isAbsolute(converted)).toBe(true);
    // Absoluteness alone would accept a value truncated to "C:/".
    expect(converted.split("/")).toEqual(segments);
  });

  it("preserves a UNC root, which stays absolute for git-for-windows", () => {
    const converted = toGitConfigPath("\\\\server\\share\\Daintree\\git-hooks", "win32");

    expect(converted).toBe("//server/share/Daintree/git-hooks");
    expect(path.win32.isAbsolute(converted)).toBe(true);
  });

  it("leaves POSIX paths untouched, where a backslash is a legal filename char", () => {
    expect(toGitConfigPath("/home/alice/odd\\name/git-hooks", "linux")).toBe(
      "/home/alice/odd\\name/git-hooks"
    );
  });
});

describe("buildHardenedGitEnv", () => {
  it("returns the same env shape that createHardenedGit applies via .env()", async () => {
    const env = buildHardenedGitEnv("linux");
    expect(env).toEqual(
      expect.objectContaining({
        LC_ALL: "",
        LC_MESSAGES: "C",
        LANGUAGE: "",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
        GCM_INTERACTIVE: "Never",
        LC_CTYPE: expect.stringMatching(/UTF-8$/),
      })
    );
  });

  it("does not set GIT_ASKPASS on win32", async () => {
    const env = buildHardenedGitEnv("win32");
    expect(env.GIT_ASKPASS).toBeUndefined();
  });

  it("sets GIT_ASKPASS=true on darwin", async () => {
    const env = buildHardenedGitEnv("darwin");
    expect(env.GIT_ASKPASS).toBe("true");
  });

  it("uses the platform arg instead of process.platform when supplied", async () => {
    const env = buildHardenedGitEnv("darwin");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
  });
});

describe("buildContinueEnv", () => {
  const saved = {
    EDITOR: process.env.EDITOR,
    GIT_EDITOR: process.env.GIT_EDITOR,
    GIT_MERGE_AUTOEDIT: process.env.GIT_MERGE_AUTOEDIT,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("suppresses the editor so continue operations run non-interactively", async () => {
    const env = buildContinueEnv("linux");
    expect(env.GIT_EDITOR).toBe("true");
    expect(env.GIT_MERGE_AUTOEDIT).toBe("no");
  });

  it("preserves the hardening vars from buildHardenedGitEnv", async () => {
    const env = buildContinueEnv("linux");
    expect(env).toEqual(
      expect.objectContaining({
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GCM_INTERACTIVE: "Never",
        GIT_ASKPASS: "true",
        LC_ALL: "",
        LC_MESSAGES: "C",
      })
    );
  });

  it("strips an inherited EDITOR instead of leaking it into the spawn env", async () => {
    process.env.EDITOR = "vim";
    const env = buildContinueEnv("linux");
    expect(env.EDITOR).toBeUndefined();
    // The intentional non-interactive value still wins.
    expect(env.GIT_EDITOR).toBe("true");
  });

  it("overrides an inherited GIT_EDITOR with the non-interactive value", async () => {
    process.env.GIT_EDITOR = "code --wait";
    const env = buildContinueEnv("linux");
    expect(env.GIT_EDITOR).toBe("true");
  });

  it("overrides an inherited GIT_MERGE_AUTOEDIT with 'no'", async () => {
    process.env.GIT_MERGE_AUTOEDIT = "yes";
    const env = buildContinueEnv("linux");
    expect(env.GIT_MERGE_AUTOEDIT).toBe("no");
  });

  it("strips every blocked inherited key the editor path could ride in on", async () => {
    const blocked = {
      GIT_SEQUENCE_EDITOR: "code --wait",
      GIT_CONFIG_GLOBAL: "/tmp/evil/.gitconfig",
      GIT_EXTERNAL_DIFF: "/tmp/evil/diff",
      PAGER: "less",
      SSH_ASKPASS: "/tmp/evil/askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.editor",
      GIT_CONFIG_VALUE_0: "/tmp/evil/editor",
    };
    Object.assign(process.env, blocked);
    const env = buildContinueEnv("linux");
    for (const key of Object.keys(blocked)) {
      expect(env[key]).toBeUndefined();
    }
    // Cleanup beyond the describe-level saved keys.
    for (const key of Object.keys(blocked)) delete process.env[key];
  });

  it("does not set GIT_ASKPASS on win32 but still suppresses the editor", async () => {
    const env = buildContinueEnv("win32");
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_EDITOR).toBe("true");
    expect(env.GIT_MERGE_AUTOEDIT).toBe("no");
  });
});
