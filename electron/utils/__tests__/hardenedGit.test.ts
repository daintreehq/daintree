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
  createWslHardenedGit,
  getGitLocaleEnv,
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
      allowUnsafeProtocolOverride: true,
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

  it("sets LC_MESSAGES=C and LANGUAGE empty via .env()", () => {
    createHardenedGit("/test/repo");

    expect(mockGitInstance.env).toHaveBeenCalledWith(
      expect.objectContaining({
        LC_MESSAGES: "C",
        LANGUAGE: "",
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

  it("sets GIT_TERMINAL_PROMPT and hardened GIT_SSH_COMMAND via .env()", () => {
    createAuthenticatedGit("/test/repo");

    expect(mockGitInstance.env).toHaveBeenCalledWith(
      expect.objectContaining({
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND:
          "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15",
      })
    );
  });

  it("sets LC_MESSAGES=C and LANGUAGE empty via .env()", () => {
    createAuthenticatedGit("/test/repo");

    expect(mockGitInstance.env).toHaveBeenCalledWith(
      expect.objectContaining({
        LC_MESSAGES: "C",
        LANGUAGE: "",
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
    const origMessages = process.env.LC_MESSAGES;
    const origLanguage = process.env.LANGUAGE;
    process.env.GIT_TERMINAL_PROMPT = "1";
    process.env.GIT_SSH_COMMAND = "ssh -i /custom/key";
    process.env.LC_MESSAGES = "fr_FR.UTF-8";
    process.env.LANGUAGE = "fr_FR";
    try {
      createAuthenticatedGit("/test/repo");

      const envArg = mockGitInstance.env.mock.calls[0][0];
      expect(envArg.GIT_TERMINAL_PROMPT).toBe("0");
      expect(envArg.GIT_SSH_COMMAND).toBe(
        "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15"
      );
      expect(envArg.LC_MESSAGES).toBe("C");
      expect(envArg.LANGUAGE).toBe("");
    } finally {
      if (origPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = origPrompt;
      if (origSsh === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = origSsh;
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
      allowUnsafeProtocolOverride: true,
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

  it("sets WSL_DISTRO_NAME in env for diagnostics", () => {
    createWslHardenedGit({
      distro: "Ubuntu",
      uncPath: "\\\\wsl$\\Ubuntu\\home\\user\\proj",
      posixPath: "/home/user/proj",
    });

    const envArg = mockGitInstance.env.mock.calls[0][0];
    expect(envArg.WSL_DISTRO_NAME).toBe("Ubuntu");
    expect(envArg.LC_MESSAGES).toBe("C");
    expect(envArg.LANGUAGE).toBe("");
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
      allowUnsafeProtocolOverride: true,
      allowUnsafeSshCommand: true,
      allowUnsafeGitProxy: true,
      allowUnsafeHooksPath: true,
    });
  });
});

describe("getGitLocaleEnv", () => {
  it("returns LC_CTYPE=C.UTF-8 and LANG=C.UTF-8 on win32", () => {
    expect(getGitLocaleEnv("win32")).toEqual({
      LC_CTYPE: "C.UTF-8",
      LANG: "C.UTF-8",
    });
  });

  it("returns LC_CTYPE=en_US.UTF-8 on darwin (macOS lacks C.UTF-8)", () => {
    expect(getGitLocaleEnv("darwin")).toEqual({
      LC_CTYPE: "en_US.UTF-8",
    });
  });

  it("returns LC_CTYPE=C.UTF-8 on linux", () => {
    expect(getGitLocaleEnv("linux")).toEqual({
      LC_CTYPE: "C.UTF-8",
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
