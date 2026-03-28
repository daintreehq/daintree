import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockImageAddon } = vi.hoisted(() => ({
  mockImageAddon: vi.fn(),
}));

vi.mock("@xterm/addon-image", () => ({ ImageAddon: mockImageAddon }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn() }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: vi.fn() }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: vi.fn() }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: vi.fn() }));
vi.mock("../FileLinksAddon", () => ({
  FileLinksAddon: vi.fn(),
}));

import { setupTerminalAddons, createImageAddon } from "../TerminalAddonManager";
import type { Terminal } from "@xterm/xterm";

function createMockTerminal() {
  return {
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as Terminal;
}

describe("TerminalAddonManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("setupTerminalAddons", () => {
    it("creates ImageAddon with memory-safe options", () => {
      const terminal = createMockTerminal();
      setupTerminalAddons(terminal, () => "/tmp");

      expect(mockImageAddon).toHaveBeenCalledWith({
        pixelLimit: 2_000_000,
        storageLimit: 8,
      });
    });
  });

  describe("createImageAddon", () => {
    it("creates ImageAddon with memory-safe options", () => {
      const terminal = createMockTerminal();
      createImageAddon(terminal);

      expect(mockImageAddon).toHaveBeenCalledWith({
        pixelLimit: 2_000_000,
        storageLimit: 8,
      });
    });

    it("loads the addon onto the terminal", () => {
      const terminal = createMockTerminal();
      createImageAddon(terminal);

      expect(terminal.loadAddon).toHaveBeenCalledWith(expect.any(mockImageAddon));
    });
  });
});
