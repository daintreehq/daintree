import { describe, it, expect, afterEach, vi } from "vitest";
import type { AgentConfig } from "../../../shared/config/agentRegistry";

const originalNavigator = globalThis.navigator;

function stubNavigator(userAgent: string, platform: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent, platform },
    writable: true,
    configurable: true,
  });
}

function restoreNavigator() {
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  restoreNavigator();
  vi.resetModules();
});

describe("agentInstall", () => {
  describe("detectOS", () => {
    it("should detect macOS", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "MacIntel"
      );
      const { detectOS } = await import("../agentInstall");
      expect(detectOS()).toBe("macos");
    });

    it("should detect macOS case-insensitively", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "macIntel"
      );
      const { detectOS } = await import("../agentInstall");
      expect(detectOS()).toBe("macos");
    });

    it("should detect Windows", async () => {
      stubNavigator("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Win32");
      const { detectOS } = await import("../agentInstall");
      expect(detectOS()).toBe("windows");
    });

    it("should detect Windows case-insensitively", async () => {
      stubNavigator("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "win32");
      const { detectOS } = await import("../agentInstall");
      expect(detectOS()).toBe("windows");
    });

    it("should detect Linux explicitly", async () => {
      stubNavigator(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Electron/40.0.0",
        "Linux x86_64"
      );
      const { detectOS } = await import("../agentInstall");
      expect(detectOS()).toBe("linux");
    });

    it("should return generic for unknown platforms", async () => {
      stubNavigator("Mozilla/5.0", "FreeBSD");
      const { detectOS } = await import("../agentInstall");
      expect(detectOS()).toBe("generic");
    });

    it("should return generic when navigator is undefined", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const { detectOS } = await import("../agentInstall");
      expect(detectOS()).toBe("generic");
    });

    it("should return generic when platform is empty", async () => {
      stubNavigator("", "");
      const { detectOS } = await import("../agentInstall");
      expect(detectOS()).toBe("generic");
    });
  });

  const mockAgent: AgentConfig = {
    id: "test",
    name: "Test",
    command: "test",
    color: "#000000",
    iconId: "test",
    supportsContextInjection: false,
    install: {
      docsUrl: "https://example.com/docs",
      byOs: {
        macos: [
          {
            label: "Homebrew",
            commands: ["brew install test"],
          },
        ],
        windows: [
          {
            label: "npm",
            commands: ["npm install -g test"],
          },
        ],
        linux: [
          {
            label: "apt",
            commands: ["apt install test"],
          },
        ],
        generic: [
          {
            label: "Generic",
            commands: ["curl https://example.com/install.sh | sh"],
          },
        ],
      },
    },
  };

  describe("getInstallBlocksForCurrentOS", () => {
    it("should return macOS blocks on macOS", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "MacIntel"
      );
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const blocks = getInstallBlocksForCurrentOS(mockAgent);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0]!.label).toBe("Homebrew");
      expect(blocks?.[0]!.commands).toEqual(["brew install test"]);
    });

    it("should return Windows blocks on Windows", async () => {
      stubNavigator("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Win32");
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const blocks = getInstallBlocksForCurrentOS(mockAgent);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0]!.label).toBe("npm");
      expect(blocks?.[0]!.commands).toEqual(["npm install -g test"]);
    });

    it("should return Linux blocks on Linux", async () => {
      stubNavigator(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Electron/40.0.0",
        "Linux x86_64"
      );
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const blocks = getInstallBlocksForCurrentOS(mockAgent);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0]!.label).toBe("apt");
      expect(blocks?.[0]!.commands).toEqual(["apt install test"]);
    });

    it("should fallback to generic blocks if OS-specific blocks not available", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "MacIntel"
      );
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const agentWithoutMacOS: AgentConfig = {
        ...mockAgent,
        install: {
          docsUrl: "https://example.com/docs",
          byOs: {
            generic: [
              {
                label: "Generic",
                commands: ["curl https://example.com/install.sh | sh"],
              },
            ],
          },
        },
      };
      const blocks = getInstallBlocksForCurrentOS(agentWithoutMacOS);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0]!.label).toBe("Generic");
    });

    it("should return null if no install config", async () => {
      stubNavigator("", "");
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const agentWithoutInstall: AgentConfig = {
        id: "test",
        name: "Test",
        command: "test",
        color: "#000000",
        iconId: "test",
        supportsContextInjection: false,
      };
      const blocks = getInstallBlocksForCurrentOS(agentWithoutInstall);
      expect(blocks).toBeNull();
    });

    it("should return null if no byOs config", async () => {
      stubNavigator("", "");
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const agentWithoutByOs: AgentConfig = {
        ...mockAgent,
        install: {
          docsUrl: "https://example.com/docs",
        },
      };
      const blocks = getInstallBlocksForCurrentOS(agentWithoutByOs);
      expect(blocks).toBeNull();
    });

    it("should return null if no blocks for current OS and no generic fallback", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "MacIntel"
      );
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const agentWithoutMacOSOrGeneric: AgentConfig = {
        ...mockAgent,
        install: {
          docsUrl: "https://example.com/docs",
          byOs: {
            windows: [
              {
                label: "npm",
                commands: ["npm install -g test"],
              },
            ],
          },
        },
      };
      const blocks = getInstallBlocksForCurrentOS(agentWithoutMacOSOrGeneric);
      expect(blocks).toBeNull();
    });

    it("should handle multiple blocks for a single OS", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "MacIntel"
      );
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const agentWithMultipleBlocks: AgentConfig = {
        ...mockAgent,
        install: {
          docsUrl: "https://example.com/docs",
          byOs: {
            macos: [
              {
                label: "Homebrew",
                commands: ["brew install test"],
              },
              {
                label: "npm",
                commands: ["npm install -g test"],
              },
            ],
          },
        },
      };
      const blocks = getInstallBlocksForCurrentOS(agentWithMultipleBlocks);
      expect(blocks).toHaveLength(2);
      expect(blocks?.[0]!.label).toBe("Homebrew");
      expect(blocks?.[1]!.label).toBe("npm");
    });

    it("should prioritize OS-specific blocks over generic", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "MacIntel"
      );
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const agentWithBoth: AgentConfig = {
        ...mockAgent,
        install: {
          docsUrl: "https://example.com/docs",
          byOs: {
            macos: [
              {
                label: "Homebrew",
                commands: ["brew install test"],
              },
            ],
            generic: [
              {
                label: "Generic",
                commands: ["curl https://example.com/install.sh | sh"],
              },
            ],
          },
        },
      };
      const blocks = getInstallBlocksForCurrentOS(agentWithBoth);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0]!.label).toBe("Homebrew");
    });

    it("should fallback to generic when OS-specific array is empty", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "MacIntel"
      );
      const { getInstallBlocksForCurrentOS } = await import("../agentInstall");
      const agentWithEmptyMacOS: AgentConfig = {
        ...mockAgent,
        install: {
          docsUrl: "https://example.com/docs",
          byOs: {
            macos: [],
            generic: [
              {
                label: "Generic",
                commands: ["curl https://example.com/install.sh | sh"],
              },
            ],
          },
        },
      };
      const blocks = getInstallBlocksForCurrentOS(agentWithEmptyMacOS);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0]!.label).toBe("Generic");
    });
  });

  describe("getDefaultInstallBlock", () => {
    it("should return the first block for current OS", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "MacIntel"
      );
      const { getDefaultInstallBlock } = await import("../agentInstall");
      const agentWithMultiple: AgentConfig = {
        ...mockAgent,
        install: {
          byOs: {
            macos: [
              { label: "curl", commands: ["curl https://example.com/install | bash"] },
              { label: "npm", commands: ["npm install -g test"] },
              { label: "Homebrew", commands: ["brew install test"] },
            ],
          },
        },
      };
      const block = getDefaultInstallBlock(agentWithMultiple);
      expect(block).not.toBeNull();
      expect(block?.label).toBe("curl");
    });

    it("should return null for agent with no install config", async () => {
      stubNavigator("", "");
      const { getDefaultInstallBlock } = await import("../agentInstall");
      const agentNoInstall: AgentConfig = {
        id: "test",
        name: "Test",
        command: "test",
        color: "#000",
        iconId: "test",
        supportsContextInjection: false,
      };
      expect(getDefaultInstallBlock(agentNoInstall)).toBeNull();
    });

    it("should return null when blocks array is empty", async () => {
      stubNavigator(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "MacIntel"
      );
      const { getDefaultInstallBlock } = await import("../agentInstall");
      const agentEmpty: AgentConfig = {
        ...mockAgent,
        install: { byOs: { macos: [] } },
      };
      expect(getDefaultInstallBlock(agentEmpty)).toBeNull();
    });
  });

  describe("getInstallCommand", () => {
    it("should return single command as-is", async () => {
      const { getInstallCommand } = await import("../agentInstall");
      expect(getInstallCommand({ commands: ["npm install -g test"] })).toBe("npm install -g test");
    });

    it("should join multiple commands with newline", async () => {
      const { getInstallCommand } = await import("../agentInstall");
      expect(
        getInstallCommand({
          commands: ["scoop bucket add extras", "scoop install extras/opencode"],
        })
      ).toBe("scoop bucket add extras\nscoop install extras/opencode");
    });

    it("should return null for empty commands array", async () => {
      const { getInstallCommand } = await import("../agentInstall");
      expect(getInstallCommand({ commands: [] })).toBeNull();
    });

    it("should return null for undefined commands", async () => {
      const { getInstallCommand } = await import("../agentInstall");
      expect(getInstallCommand({ label: "steps-only", steps: ["Do something"] })).toBeNull();
    });
  });

  describe("isManualOnlyCommand", () => {
    it("should detect curl | bash as manual", async () => {
      const { isManualOnlyCommand } = await import("../agentInstall");
      expect(isManualOnlyCommand("curl -fsSL https://example.com/install | bash")).toBe(true);
    });

    it("should detect curl | sh as manual", async () => {
      const { isManualOnlyCommand } = await import("../agentInstall");
      expect(isManualOnlyCommand("curl https://example.com/install.sh | sh")).toBe(true);
    });

    it("should detect iex pipe as manual", async () => {
      const { isManualOnlyCommand } = await import("../agentInstall");
      expect(isManualOnlyCommand("irm 'https://example.com/install?win32=true' | iex")).toBe(true);
    });

    it("should NOT flag npm install as manual", async () => {
      const { isManualOnlyCommand } = await import("../agentInstall");
      expect(isManualOnlyCommand("npm install -g @anthropic-ai/claude-code")).toBe(false);
    });

    it("should NOT flag brew install as manual", async () => {
      const { isManualOnlyCommand } = await import("../agentInstall");
      expect(isManualOnlyCommand("brew install opencode")).toBe(false);
    });

    it("should NOT flag scoop install as manual", async () => {
      const { isManualOnlyCommand } = await import("../agentInstall");
      expect(isManualOnlyCommand("scoop install extras/opencode")).toBe(false);
    });
  });

  describe("extractInspectUrl", () => {
    it("returns the URL for a curl | bash command", async () => {
      const { extractInspectUrl } = await import("../agentInstall");
      expect(extractInspectUrl("curl -fsSL https://kiro.dev/install.sh | bash")).toBe(
        "https://kiro.dev/install.sh"
      );
    });

    it("returns the URL for a curl | sh command", async () => {
      const { extractInspectUrl } = await import("../agentInstall");
      expect(extractInspectUrl("curl https://example.com/install.sh | sh")).toBe(
        "https://example.com/install.sh"
      );
    });

    it("returns the URL for an irm | iex Windows command", async () => {
      const { extractInspectUrl } = await import("../agentInstall");
      expect(extractInspectUrl("irm 'https://example.com/install.ps1' | iex")).toBe(
        "https://example.com/install.ps1"
      );
    });

    it("trims trailing punctuation from process-substitution forms", async () => {
      const { extractInspectUrl } = await import("../agentInstall");
      expect(extractInspectUrl("bash <(curl https://example.com/install.sh) | bash")).toBe(
        "https://example.com/install.sh"
      );
    });

    it("returns undefined for non-pipe-to-shell commands", async () => {
      const { extractInspectUrl } = await import("../agentInstall");
      expect(extractInspectUrl("npm install -g @anthropic-ai/claude-code")).toBeUndefined();
      expect(extractInspectUrl("brew install opencode")).toBeUndefined();
      expect(extractInspectUrl("scoop install extras/opencode")).toBeUndefined();
    });

    it("returns undefined for pipe-to-shell commands without a URL", async () => {
      const { extractInspectUrl } = await import("../agentInstall");
      expect(extractInspectUrl("echo hello | bash")).toBeUndefined();
    });

    it("returns the first URL when multiple are present", async () => {
      const { extractInspectUrl } = await import("../agentInstall");
      expect(
        extractInspectUrl("curl https://primary.example.com/install.sh https://other.com | bash")
      ).toBe("https://primary.example.com/install.sh");
    });
  });

  describe("isBlockExecutable", () => {
    it("should return true for npm-only blocks", async () => {
      const { isBlockExecutable } = await import("../agentInstall");
      expect(isBlockExecutable({ commands: ["npm install -g test"] })).toBe(true);
    });

    it("should return true for multi-command non-pipe blocks", async () => {
      const { isBlockExecutable } = await import("../agentInstall");
      expect(
        isBlockExecutable({
          commands: ["scoop bucket add extras", "scoop install extras/opencode"],
        })
      ).toBe(true);
    });

    it("should return false for curl pipe blocks", async () => {
      const { isBlockExecutable } = await import("../agentInstall");
      expect(
        isBlockExecutable({
          commands: ["curl -fsSL https://opencode.ai/install | bash"],
        })
      ).toBe(false);
    });

    it("should return false if any command in block is manual", async () => {
      const { isBlockExecutable } = await import("../agentInstall");
      expect(
        isBlockExecutable({
          commands: ["npm install -g test", "curl https://example.com | bash"],
        })
      ).toBe(false);
    });

    it("should return false for empty commands", async () => {
      const { isBlockExecutable } = await import("../agentInstall");
      expect(isBlockExecutable({ commands: [] })).toBe(false);
    });

    it("should return false for undefined commands", async () => {
      const { isBlockExecutable } = await import("../agentInstall");
      expect(isBlockExecutable({ label: "no-commands" })).toBe(false);
    });
  });

  describe("npm global permission failures", () => {
    // npm 10.9 at --loglevel=error, captured against unwritable folders; only
    // the paths are changed.
    const PREFIX_REPORT = [
      "npm error code EACCES",
      "npm error syscall mkdir",
      "npm error path /usr/lib/node_modules/@anthropic-ai",
      "npm error errno -13",
      "npm error Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/@anthropic-ai'",
      "npm error     at async mkdir (node:internal/fs/promises:858:10)",
    ].join("\n");
    const BIN_LINK_REPORT = [
      "npm error code EACCES",
      "npm error syscall symlink",
      "npm error path ../lib/node_modules/@anthropic-ai/claude-code/cli.js",
      "npm error dest /usr/local/bin/claude",
      "npm error errno -13",
      "npm error Error: EACCES: permission denied, symlink '../lib/node_modules/@anthropic-ai/claude-code/cli.js' -> '/usr/local/bin/claude'",
    ].join("\n");
    const CACHE_REPORT = [
      "npm error code EACCES",
      "npm error syscall mkdir",
      "npm error path /Users/me/.npm/_cacache",
      "npm error errno EACCES",
      "npm error",
      "npm error Your cache folder contains root-owned files, due to a bug in",
      "npm error previous versions of npm which has since been addressed.",
      "npm error",
      "npm error To permanently fix this problem, please run:",
      'npm error   sudo chown -R 501:20 "/Users/me/.npm"',
    ].join("\n");
    const CLAUDE = "npm install -g @anthropic-ai/claude-code";

    it("recognises the global install spellings", async () => {
      const { isNpmGlobalInstall } = await import("../agentInstall");
      expect(isNpmGlobalInstall("npm install -g @anthropic-ai/claude-code")).toBe(true);
      expect(isNpmGlobalInstall("npm i --global @openai/codex")).toBe(true);
      expect(isNpmGlobalInstall("npm install @openai/codex -g")).toBe(true);
      expect(isNpmGlobalInstall("npm.cmd install -g @openai/codex")).toBe(true);
    });

    it("ignores local npm installs and other installers", async () => {
      const { isNpmGlobalInstall } = await import("../agentInstall");
      expect(isNpmGlobalInstall("npm install @openai/codex")).toBe(false);
      expect(isNpmGlobalInstall("npm install -g-not-a-flag")).toBe(false);
      expect(isNpmGlobalInstall("pnpm add -g @openai/codex")).toBe(false);
      expect(isNpmGlobalInstall("curl -fsSL https://claude.ai/install.sh | bash")).toBe(false);
    });

    it("places a refused write into the global packages folder", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      for (const os of ["linux", "macos"] as const) {
        expect(classifyNpmPermissionFailure(CLAUDE, PREFIX_REPORT, os)).toEqual({
          kind: "global-folder",
          folder: "/usr/lib/node_modules",
        });
      }
    });

    it("places a refused command link in the prefix's bin folder", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      expect(classifyNpmPermissionFailure(CLAUDE, BIN_LINK_REPORT, "linux")).toEqual({
        kind: "global-folder",
        folder: "/usr/local/bin",
      });
    });

    it("reads Node's own error line when npm's path lines are missing", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      const report =
        "npm ERR! Error: EPERM: operation not permitted, mkdir '/usr/local/lib/node_modules/x'";
      expect(classifyNpmPermissionFailure(CLAUDE, report, "macos")).toEqual({
        kind: "global-folder",
        folder: "/usr/local/lib/node_modules",
      });
    });

    it("reads npm 6's ERR! report lines", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      const report = PREFIX_REPORT.replace(/^npm error/gm, "npm ERR!");
      expect(classifyNpmPermissionFailure(CLAUDE, report, "linux")?.kind).toBe("global-folder");
    });

    it("tells a cache failure from a prefix one and takes the folder from npm's chown", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      expect(classifyNpmPermissionFailure(CLAUDE, CACHE_REPORT, "macos")).toEqual({
        kind: "cache",
        folder: "/Users/me/.npm",
        fixCommand: "sudo chown -R $(id -u):$(id -g) '/Users/me/.npm'",
      });
    });

    // npm double-quotes the folder in its own chown, so pasting it would expand
    // a `$NAME` or run a `$(…)` in the folder's name.
    it("never hands on npm's printed chown for a folder that would expand", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      const report = CACHE_REPORT.replaceAll("/Users/me/.npm", "/Users/me/$HOME`x`/.npm");
      expect(classifyNpmPermissionFailure(CLAUDE, report, "macos")).toMatchObject({
        kind: "cache",
        fixCommand: "sudo chown -R $(id -u):$(id -g) '/Users/me/$HOME`x`/.npm'",
      });
    });

    it("builds the chown for a cache path npm didn't explain", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      const report = "npm error code EACCES\nnpm error path /home/me/.npm/_cacache/index-v5/ab";
      expect(classifyNpmPermissionFailure(CLAUDE, report, "linux")).toEqual({
        kind: "cache",
        folder: "/home/me/.npm",
        fixCommand: "sudo chown -R $(id -u):$(id -g) '/home/me/.npm'",
      });
    });

    it("single-quotes a cache path holding shell syntax", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      const report = "npm error code EACCES\nnpm error path /home/me/$(x)'.npm/_cacache";
      expect(classifyNpmPermissionFailure(CLAUDE, report, "linux")).toMatchObject({
        kind: "cache",
        fixCommand: "sudo chown -R $(id -u):$(id -g) '/home/me/$(x)'\\''.npm'",
      });
    });

    it("gives Windows no Unix advice", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      const windowsReport = [
        "npm error code EPERM",
        "npm error syscall rename",
        "npm error path C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code",
      ].join("\n");
      expect(classifyNpmPermissionFailure(CLAUDE, windowsReport, "windows")).toBeNull();
      expect(classifyNpmPermissionFailure(CLAUDE, PREFIX_REPORT, "windows")).toBeNull();
      expect(classifyNpmPermissionFailure(CLAUDE, CACHE_REPORT, "generic")).toBeNull();
    });

    it("keeps the plain error for a prefix already inside a home folder", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      const report = PREFIX_REPORT.replaceAll("/usr/lib/", "/home/me/.npm-global/lib/");
      expect(classifyNpmPermissionFailure(CLAUDE, report, "linux")).toBeNull();
    });

    it("keeps the plain error for a refusal it can't place", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      const elsewhere = "npm error code EACCES\nnpm error path /etc/npmrc";
      expect(classifyNpmPermissionFailure(CLAUDE, elsewhere, "linux")).toBeNull();
      expect(classifyNpmPermissionFailure(CLAUDE, "npm error code EACCES", "linux")).toBeNull();
    });

    it("leaves other failures, and other installers' permission errors, alone", async () => {
      const { classifyNpmPermissionFailure } = await import("../agentInstall");
      expect(classifyNpmPermissionFailure(CLAUDE, "npm error code E404", "linux")).toBeNull();
      expect(
        classifyNpmPermissionFailure("pipx install aider-chat", PREFIX_REPORT, "linux")
      ).toBeNull();
      expect(
        classifyNpmPermissionFailure("npm install @anthropic-ai/sdk", PREFIX_REPORT, "linux")
      ).toBeNull();
    });

    it("finds the first method that avoids npm's global prefix", async () => {
      const { findNonNpmInstallBlock } = await import("../agentInstall");
      const curl = { label: "curl", commands: ["curl -fsSL https://claude.ai/install.sh | bash"] };
      expect(
        findNonNpmInstallBlock([
          { label: "npm", commands: ["npm install -g @anthropic-ai/claude-code"] },
          { label: "steps only", steps: ["Download the binary"] },
          curl,
        ])
      ).toBe(curl);
      expect(findNonNpmInstallBlock([{ label: "npm", commands: ["npm i -g x"] }])).toBeNull();
      expect(findNonNpmInstallBlock(null)).toBeNull();
    });
  });
});
