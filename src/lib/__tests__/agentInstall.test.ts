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
});
