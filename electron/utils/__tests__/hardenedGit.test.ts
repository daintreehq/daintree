import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  HARDENED_GIT_CONFIG,
  AUTHENTICATED_GIT_CONFIG,
} from "../hardenedGit.js";
import { simpleGit } from "simple-git";

describe("validateCwd", () => {
  it("throws for empty string", () => {
    expect(() => validateCwd("")).toThrow("Invalid working directory");
  });

  it("throws for whitespace-only string", () => {
    expect(() => validateCwd("   ")).toThrow("Invalid working directory");
  });

  it("throws for non-string input (number)", () => {
    expect(() => validateCwd(123)).toThrow("Invalid working directory");
  });

  it("throws for non-string input (null)", () => {
    expect(() => validateCwd(null)).toThrow("Invalid working directory");
  });

  it("throws for non-string input (undefined)", () => {
    expect(() => validateCwd(undefined)).toThrow("Invalid working directory");
  });

  it("throws for relative path", () => {
    expect(() => validateCwd("relative/path")).toThrow("absolute path");
  });

  it("throws for parent traversal path", () => {
    expect(() => validateCwd("../malicious-repo")).toThrow("absolute path");
  });

  it("throws for dot-relative path", () => {
    expect(() => validateCwd("./something")).toThrow("absolute path");
  });

  it("does not throw for absolute path (unix)", () => {
    expect(() => validateCwd("/absolute/path")).not.toThrow();
  });

  it("does not throw for root path", () => {
    expect(() => validateCwd("/")).not.toThrow();
  });
});

describe("createHardenedGit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls simpleGit with correct baseDir", () => {
    createHardenedGit("/test/repo");

    expect(simpleGit).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDir: "/test/repo",
      })
    );
  });

  it("disables fsmonitor to prevent cross-worktree contamination", () => {
    createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("core.fsmonitor=false");
    expect(options.config).not.toContain("core.fsmonitor=true");
  });

  it("passes config overrides including protocol.ext.allow=never", () => {
    createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("protocol.ext.allow=never");
  });

  it("disables core.sshCommand via config", () => {
    createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("core.sshCommand=");
  });

  it("disables credential.helper via config", () => {
    createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("credential.helper=");
  });

  it("enables allowUnsafe flags for overriding blocked config keys", () => {
    createHardenedGit("/test/repo");

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
    });
  });

  it("includes all security-critical config overrides", () => {
    createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const expectedKeys = [
      "core.fsmonitor=false",
      "core.untrackedCache=false",
      "core.pager=cat",
      "core.askpass=",
      "credential.helper=",
      "protocol.ext.allow=never",
      "core.sshCommand=",
      "core.gitProxy=",
      "core.hooksPath=",
      "core.quotepath=false",
      "core.precomposeunicode=true",
    ];
    for (const key of expectedKeys) {
      expect(options.config).toContain(key);
    }
    expect(options.config).toHaveLength(expectedKeys.length);
  });

  it("passes abort signal when provided", () => {
    const controller = new AbortController();
    createHardenedGit("/test/repo", controller.signal);

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.abort).toBe(controller.signal);
  });

  it("does not include abort option when no signal provided", () => {
    createHardenedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options).not.toHaveProperty("abort");
  });

  it("sets LC_MESSAGES=C, LANGUAGE empty, and GIT_OPTIONAL_LOCKS=0 via .env()", () => {
    createHardenedGit("/test/repo");

    expect(mockGitInstance.env).toHaveBeenCalledWith(
      expect.objectContaining({
        LC_MESSAGES: "C",
        LANGUAGE: "",
        GIT_OPTIONAL_LOCKS: "0",
      })
    );
  });

  it("sets a platform-appropriate LC_CTYPE so non-ASCII paths survive iconv", () => {
    createHardenedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(typeof envArg.LC_CTYPE).toBe("string");
    expect(envArg.LC_CTYPE).toMatch(/UTF-8$/);
  });

  it("clears inherited LC_ALL so the more specific LC_CTYPE / LC_MESSAGES win", () => {
    const orig = process.env.LC_ALL;
    process.env.LC_ALL = "C";
    try {
      createHardenedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.LC_ALL).toBe("");
    } finally {
      if (orig === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = orig;
    }
  });

  it("does not apply hardened SSH command (blocked via config instead)", () => {
    const origSsh = process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_COMMAND;
    try {
      createHardenedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.GIT_SSH_COMMAND).toBeUndefined();
    } finally {
      if (origSsh !== undefined) process.env.GIT_SSH_COMMAND = origSsh;
    }
  });

  it("spreads process.env into hardenedGit .env() call", () => {
    process.env.DAINTREE_TEST_SENTINEL = "sentinel_value";
    try {
      createHardenedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.PATH).toBe(process.env.PATH);
      expect(envArg.DAINTREE_TEST_SENTINEL).toBe("sentinel_value");
    } finally {
      delete process.env.DAINTREE_TEST_SENTINEL;
    }
  });

  it("strips inherited git execution env before applying hardened overrides", () => {
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
      createHardenedGit("/test/repo", undefined, "linux");

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

  it("locale env values override conflicting process.env entries", () => {
    const origMessages = process.env.LC_MESSAGES;
    const origLanguage = process.env.LANGUAGE;
    process.env.LC_MESSAGES = "fr_FR.UTF-8";
    process.env.LANGUAGE = "fr_FR";
    try {
      createHardenedGit("/test/repo");

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

  it("suppresses optional .git/index.lock writes via GIT_OPTIONAL_LOCKS=0", () => {
    createHardenedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("blocks interactive credential prompts via GIT_TERMINAL_PROMPT=0", () => {
    createHardenedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("disables Windows GCM interactive dialogs via GCM_INTERACTIVE=Never", () => {
    createHardenedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GCM_INTERACTIVE).toBe("Never");
  });

  it("sets GIT_ASKPASS=true on POSIX so credential helpers fail fast", () => {
    createHardenedGit("/test/repo", undefined, "darwin");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_ASKPASS).toBe("true");
  });

  it("sets GIT_ASKPASS=true on linux", () => {
    createHardenedGit("/test/repo", undefined, "linux");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_ASKPASS).toBe("true");
  });

  it("does not set GIT_ASKPASS on Windows (no `true` binary on PATH)", () => {
    const origAskpass = process.env.GIT_ASKPASS;
    delete process.env.GIT_ASKPASS;
    try {
      createHardenedGit("/test/repo", undefined, "win32");

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

  it("calls simpleGit with correct baseDir", () => {
    createAuthenticatedGit("/test/repo");

    expect(simpleGit).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDir: "/test/repo",
      })
    );
  });

  it("does not include credential-blocking config entries", () => {
    createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).not.toContain("credential.helper=");
    expect(options.config).not.toContain("core.sshCommand=");
    expect(options.config).not.toContain("core.askpass=");
  });

  it("includes all non-credential security config entries", () => {
    createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("core.fsmonitor=false");
    expect(options.config).toContain("core.untrackedCache=false");
    expect(options.config).toContain("core.pager=cat");
    expect(options.config).toContain("protocol.ext.allow=never");
    expect(options.config).toContain("core.gitProxy=");
    expect(options.config).toContain("core.hooksPath=");
    expect(options.config).toContain("core.quotepath=false");
    expect(options.config).toContain("core.precomposeunicode=true");
  });

  it("sets GIT_TERMINAL_PROMPT, hardened GIT_SSH_COMMAND, and GIT_OPTIONAL_LOCKS=0 via .env()", () => {
    createAuthenticatedGit("/test/repo");

    expect(mockGitInstance.env).toHaveBeenCalledWith(
      expect.objectContaining({
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND:
          "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15",
        GIT_OPTIONAL_LOCKS: "0",
      })
    );
  });

  it("sets GIT_OPTIONAL_LOCKS=0 to suppress incidental lock writes", () => {
    createAuthenticatedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("sets GCM_INTERACTIVE=Never to prevent Windows GCM dialogs", () => {
    createAuthenticatedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.GCM_INTERACTIVE).toBe("Never");
  });

  it("does NOT set GIT_ASKPASS so legitimate credential helpers can resolve", () => {
    const origAskpass = process.env.GIT_ASKPASS;
    delete process.env.GIT_ASKPASS;
    try {
      createAuthenticatedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.GIT_ASKPASS).toBeUndefined();
    } finally {
      if (origAskpass !== undefined) process.env.GIT_ASKPASS = origAskpass;
    }
  });

  it("sets LC_MESSAGES=C, LANGUAGE empty, and GIT_OPTIONAL_LOCKS=0 via .env()", () => {
    createAuthenticatedGit("/test/repo");

    expect(mockGitInstance.env).toHaveBeenCalledWith(
      expect.objectContaining({
        LC_MESSAGES: "C",
        LANGUAGE: "",
        GIT_OPTIONAL_LOCKS: "0",
      })
    );
  });

  it("sets a platform-appropriate LC_CTYPE so non-ASCII paths survive iconv", () => {
    createAuthenticatedGit("/test/repo");

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(typeof envArg.LC_CTYPE).toBe("string");
    expect(envArg.LC_CTYPE).toMatch(/UTF-8$/);
  });

  it("clears inherited LC_ALL so the more specific LC_CTYPE / LC_MESSAGES win", () => {
    const orig = process.env.LC_ALL;
    process.env.LC_ALL = "C";
    try {
      createAuthenticatedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.LC_ALL).toBe("");
    } finally {
      if (orig === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = orig;
    }
  });

  it("spreads process.env into the .env() call", () => {
    process.env.DAINTREE_TEST_SENTINEL = "sentinel_value";
    try {
      createAuthenticatedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.PATH).toBe(process.env.PATH);
      expect(envArg.HOME).toBe(process.env.HOME);
      expect(envArg.DAINTREE_TEST_SENTINEL).toBe("sentinel_value");
    } finally {
      delete process.env.DAINTREE_TEST_SENTINEL;
    }
  });

  it("forced env values override conflicting process.env entries", () => {
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
      createAuthenticatedGit("/test/repo");

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

  it("sets block timeout to 0 for network operations", () => {
    createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.timeout).toEqual({ block: 0 });
  });

  it("enables allowUnsafe flags", () => {
    createAuthenticatedGit("/test/repo");

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
    });
  });

  it("forwards abort signal when provided", () => {
    const controller = new AbortController();
    createAuthenticatedGit("/test/repo", { signal: controller.signal });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.abort).toBe(controller.signal);
  });

  it("does not include abort option when no signal provided", () => {
    createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options).not.toHaveProperty("abort");
  });

  it("forwards progress callback when provided", () => {
    const progressFn = vi.fn();
    createAuthenticatedGit("/test/repo", { progress: progressFn });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.progress).toBe(progressFn);
  });

  it("does not include progress option when not provided", () => {
    createAuthenticatedGit("/test/repo");

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options).not.toHaveProperty("progress");
  });

  it("appends extraConfig items to config", () => {
    createAuthenticatedGit("/test/repo", {
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

  it("layers background-fetch config on top of authenticated config", () => {
    const controller = new AbortController();
    createBackgroundFetchGit("/test/repo", { signal: controller.signal });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("core.packedRefsTimeout=5000");
    expect(options.config).toContain("http.lowSpeedLimit=1000");
    expect(options.config).toContain("http.lowSpeedTime=30");
    expect(options.config).toContain("gc.auto=0");
    // Inherits authenticated base — no credential-blocking entries.
    expect(options.config).not.toContain("credential.helper=");
    expect(options.config).not.toContain("core.askpass=");
  });

  it("forwards the abort signal to simple-git", () => {
    const controller = new AbortController();
    createBackgroundFetchGit("/test/repo", { signal: controller.signal });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.abort).toBe(controller.signal);
  });

  it("sets GIT_ASKPASS=true on POSIX so credential helpers fail fast", () => {
    const controller = new AbortController();
    createBackgroundFetchGit("/test/repo", {
      signal: controller.signal,
      platform: "darwin",
    });

    // Last env() call wins — the POSIX askpass override is applied second.
    const lastEnv = mockGitInstance.env.mock.calls[mockGitInstance.env.mock.calls.length - 1][0];
    expect(lastEnv.GIT_ASKPASS).toBe("true");
    expect(lastEnv.GIT_TERMINAL_PROMPT).toBe("0");
    expect(lastEnv.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("re-states GIT_OPTIONAL_LOCKS and GCM_INTERACTIVE in the POSIX second .env() call", () => {
    const controller = new AbortController();
    createBackgroundFetchGit("/test/repo", {
      signal: controller.signal,
      platform: "darwin",
    });

    // The second .env() replaces (not merges) the first call's env, so the
    // hardening flags from createAuthenticatedGit must be re-asserted here.
    const lastEnv = mockGitInstance.env.mock.calls[mockGitInstance.env.mock.calls.length - 1][0];
    expect(lastEnv.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(lastEnv.GCM_INTERACTIVE).toBe("Never");
  });

  it("does not set GIT_ASKPASS on Windows (no `true` binary on PATH)", () => {
    const controller = new AbortController();
    createBackgroundFetchGit("/test/repo", {
      signal: controller.signal,
      platform: "win32",
    });

    // The base authenticated env() call doesn't set GIT_ASKPASS, and the
    // POSIX-only override is skipped. Only one env() call should happen.
    expect(mockGitInstance.env.mock.calls).toHaveLength(1);
    const env = mockGitInstance.env.mock.calls[0][0];
    expect(env.GIT_ASKPASS).toBeUndefined();
  });

  it("appends caller-supplied extraConfig after background-fetch config", () => {
    const controller = new AbortController();
    createBackgroundFetchGit("/test/repo", {
      signal: controller.signal,
      extraConfig: ["transfer.bundleURI=false"],
    });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.config).toContain("transfer.bundleURI=false");
    expect(options.config).toContain("core.packedRefsTimeout=5000");
  });

  it("inherits block timeout 0 from authenticated profile", () => {
    const controller = new AbortController();
    createBackgroundFetchGit("/test/repo", { signal: controller.signal });

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

  it("throws on non-Windows platforms", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(() =>
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
        posixPath: "/home/user/proj",
      })
    ).toThrow("only available on Windows");
  });

  it("throws when distro is empty", () => {
    expect(() =>
      createWslHardenedGit({
        distro: "",
        uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
        posixPath: "/home/user/proj",
      })
    ).toThrow("WSL distro");
  });

  it("throws when posix path does not start with /", () => {
    expect(() =>
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
        posixPath: "home/user/proj",
      })
    ).toThrow("posix path");
  });

  it("throws when UNC path is not a WSL UNC", () => {
    expect(() =>
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "C:\\repos\\proj",
        posixPath: "/home/user/proj",
      })
    ).toThrow("UNC path");
  });

  it("rejects strings starting with \\\\wsl but missing the WSL UNC shape", () => {
    // Old `startsWith("\\\\wsl")` gate let this through; tightened check
    // (detectWslPath) fails closed on the malformed shape.
    expect(() =>
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wslfoo\\bar",
        posixPath: "/home/user/proj",
      })
    ).toThrow("UNC path");
  });

  it("rejects bare \\\\wsl$\\ with no distro segment", () => {
    expect(() =>
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\",
        posixPath: "/",
      })
    ).toThrow("UNC path");
  });

  it("rejects bare \\\\wsl.localhost\\ with no distro segment", () => {
    expect(() =>
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl.localhost\\",
        posixPath: "/",
      })
    ).toThrow("UNC path");
  });

  it("rejects when supplied distro does not match parsed UNC distro", () => {
    expect(() =>
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\Debian\\home\\user\\proj",
        posixPath: "/home/user/proj",
      })
    ).toThrow("distro does not match");
  });

  it("rejects when supplied posixPath does not match parsed UNC remainder", () => {
    expect(() =>
      createWslHardenedGit({
        distro: "Ubuntu",
        uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
        posixPath: "/some/other/path",
      })
    ).toThrow("posix path does not match");
  });

  it("uses the UNC path as baseDir so simple-git's statSync succeeds on Windows", () => {
    createWslHardenedGit({
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

  it("sets binary to wsl.exe + git two-tuple", () => {
    createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(options.binary).toEqual(["wsl.exe", "git"]);
  });

  it("carries the full HARDENED_GIT_CONFIG", () => {
    createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    const options = (simpleGit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    for (const entry of HARDENED_GIT_CONFIG) {
      expect(options.config).toContain(entry);
    }
    expect(options.config).toHaveLength(HARDENED_GIT_CONFIG.length);
  });

  it("sets WSL_DISTRO_NAME, GIT_OPTIONAL_LOCKS=0, and locale in env for diagnostics", () => {
    createWslHardenedGit({
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

  it("applies the same env hardening as createHardenedGit (Linux git inside WSL)", () => {
    createWslHardenedGit({
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

  it("forwards abort signal when provided", () => {
    const controller = new AbortController();
    createWslHardenedGit(
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

  it("enables allowUnsafe flags matching createHardenedGit", () => {
    createWslHardenedGit({
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
    });
  });
});

describe("getGitLocaleEnv", () => {
  it("returns LC_CTYPE=C.UTF-8, LANG=C.UTF-8, and GIT_OPTIONAL_LOCKS=0 on win32", () => {
    expect(getGitLocaleEnv("win32")).toEqual({
      LC_CTYPE: "C.UTF-8",
      LANG: "C.UTF-8",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("returns LC_CTYPE=en_US.UTF-8 and GIT_OPTIONAL_LOCKS=0 on darwin (macOS lacks C.UTF-8)", () => {
    expect(getGitLocaleEnv("darwin")).toEqual({
      LC_CTYPE: "en_US.UTF-8",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("returns LC_CTYPE=C.UTF-8 and GIT_OPTIONAL_LOCKS=0 on linux", () => {
    expect(getGitLocaleEnv("linux")).toEqual({
      LC_CTYPE: "C.UTF-8",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("does not set LANG on non-win32 platforms", () => {
    expect(getGitLocaleEnv("linux")).not.toHaveProperty("LANG");
    expect(getGitLocaleEnv("darwin")).not.toHaveProperty("LANG");
  });
});

describe("config constants", () => {
  it("HARDENED_GIT_CONFIG includes credential-blocking entries", () => {
    expect(HARDENED_GIT_CONFIG).toContain("credential.helper=");
    expect(HARDENED_GIT_CONFIG).toContain("core.sshCommand=");
    expect(HARDENED_GIT_CONFIG).toContain("core.askpass=");
  });

  it("AUTHENTICATED_GIT_CONFIG excludes credential-blocking entries", () => {
    expect(AUTHENTICATED_GIT_CONFIG).not.toContain("credential.helper=");
    expect(AUTHENTICATED_GIT_CONFIG).not.toContain("core.sshCommand=");
    expect(AUTHENTICATED_GIT_CONFIG).not.toContain("core.askpass=");
  });

  it("both configs share the same security base entries", () => {
    const securityEntries = [
      "core.fsmonitor=false",
      "core.untrackedCache=false",
      "core.pager=cat",
      "protocol.ext.allow=never",
      "core.gitProxy=",
      "core.hooksPath=",
      "core.quotepath=false",
      "core.precomposeunicode=true",
    ];
    for (const entry of securityEntries) {
      expect(HARDENED_GIT_CONFIG).toContain(entry);
      expect(AUTHENTICATED_GIT_CONFIG).toContain(entry);
    }
  });
});

describe("buildHardenedGitEnv", () => {
  it("returns the same env shape that createHardenedGit applies via .env()", () => {
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

  it("does not set GIT_ASKPASS on win32", () => {
    const env = buildHardenedGitEnv("win32");
    expect(env.GIT_ASKPASS).toBeUndefined();
  });

  it("sets GIT_ASKPASS=true on darwin", () => {
    const env = buildHardenedGitEnv("darwin");
    expect(env.GIT_ASKPASS).toBe("true");
  });

  it("uses the platform arg instead of process.platform when supplied", () => {
    const env = buildHardenedGitEnv("darwin");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
  });
});
