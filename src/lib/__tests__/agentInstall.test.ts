import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectOS, getInstallBlocksForCurrentOS } from "../agentInstall";
import type { AgentConfig } from "../../../shared/config/agentRegistry";

describe("agentInstall", () => {
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  const setNavigator = (value: Navigator | undefined) => {
    Object.defineProperty(globalThis, "navigator", {
      value,
      configurable: true,
      writable: true,
    });
  };

  beforeEach(() => {
    setNavigator({ platform: "Linux x86_64" } as Navigator);
  });

  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    } else {
      delete (globalThis as { navigator?: Navigator }).navigator;
    }
  });

  describe("detectOS", () => {
    it("should detect macOS", () => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
      expect(detectOS()).toBe("macos");
    });

    it("should detect macOS case-insensitively", () => {
      Object.defineProperty(navigator, "platform", { value: "macIntel", configurable: true });
      expect(detectOS()).toBe("macos");
    });

    it("should detect Windows", () => {
      Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
      expect(detectOS()).toBe("windows");
    });

    it("should detect Windows case-insensitively", () => {
      Object.defineProperty(navigator, "platform", { value: "win32", configurable: true });
      expect(detectOS()).toBe("windows");
    });

    it("should detect Linux explicitly", () => {
      Object.defineProperty(navigator, "platform", { value: "Linux x86_64", configurable: true });
      expect(detectOS()).toBe("linux");
    });

    it("should return generic for unknown platforms", () => {
      Object.defineProperty(navigator, "platform", { value: "FreeBSD", configurable: true });
      expect(detectOS()).toBe("generic");
    });

    it("should return generic when navigator is undefined", () => {
      setNavigator(undefined);
      expect(detectOS()).toBe("generic");
    });

    it("should return generic when platform is empty", () => {
      Object.defineProperty(navigator, "platform", { value: "", configurable: true });
      expect(detectOS()).toBe("generic");
    });
  });

  describe("getInstallBlocksForCurrentOS", () => {
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

    it("should return macOS blocks on macOS", () => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
      const blocks = getInstallBlocksForCurrentOS(mockAgent);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0].label).toBe("Homebrew");
      expect(blocks?.[0].commands).toEqual(["brew install test"]);
    });

    it("should return Windows blocks on Windows", () => {
      Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
      const blocks = getInstallBlocksForCurrentOS(mockAgent);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0].label).toBe("npm");
      expect(blocks?.[0].commands).toEqual(["npm install -g test"]);
    });

    it("should return Linux blocks on Linux", () => {
      Object.defineProperty(navigator, "platform", { value: "Linux x86_64", configurable: true });
      const blocks = getInstallBlocksForCurrentOS(mockAgent);
      expect(blocks).toHaveLength(1);
      expect(blocks?.[0].label).toBe("apt");
      expect(blocks?.[0].commands).toEqual(["apt install test"]);
    });

    it("should fallback to generic blocks if OS-specific blocks not available", () => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
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
      expect(blocks?.[0].label).toBe("Generic");
    });

    it("should return null if no install config", () => {
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

    it("should return null if no byOs config", () => {
      const agentWithoutByOs: AgentConfig = {
        ...mockAgent,
        install: {
          docsUrl: "https://example.com/docs",
        },
      };
      const blocks = getInstallBlocksForCurrentOS(agentWithoutByOs);
      expect(blocks).toBeNull();
    });

    it("should return null if no blocks for current OS and no generic fallback", () => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
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

    it("should handle multiple blocks for a single OS", () => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
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
      expect(blocks?.[0].label).toBe("Homebrew");
      expect(blocks?.[1].label).toBe("npm");
    });

    it("should prioritize OS-specific blocks over generic", () => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
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
      expect(blocks?.[0].label).toBe("Homebrew");
    });

    it("should fallback to generic when OS-specific array is empty", () => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
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
      expect(blocks?.[0].label).toBe("Generic");
    });
  });
});
