import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockImageAddon, mockSearchAddon } = vi.hoisted(() => ({
  mockImageAddon: vi.fn(),
  mockSearchAddon: vi.fn(),
}));

vi.mock("@xterm/addon-image", () => ({ ImageAddon: mockImageAddon }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn() }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: vi.fn() }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: mockSearchAddon }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: vi.fn() }));
vi.mock("../FileLinksAddon", () => ({
  FileLinksAddon: vi.fn(),
}));

import {
  setupTerminalAddons,
  createImageAddon,
  createWebLinksAddon,
  createFileLinksAddon,
  SEARCH_HIGHLIGHT_LIMIT,
} from "../TerminalAddonManager";
import type { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FileLinksAddon } from "../FileLinksAddon";

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

    it("creates SearchAddon with highlightLimit for bounded match counts", () => {
      const terminal = createMockTerminal();
      setupTerminalAddons(terminal, () => "/tmp");

      expect(mockSearchAddon).toHaveBeenCalledWith({
        highlightLimit: SEARCH_HIGHLIGHT_LIMIT,
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

  describe("createWebLinksAddon hover wiring", () => {
    it("passes hover/leave callbacks through to WebLinksAddon options", () => {
      const terminal = createMockTerminal();
      const onActivate = vi.fn();
      const hover = vi.fn();
      const leave = vi.fn();

      createWebLinksAddon(terminal, onActivate, { hover, leave });

      const opts = vi.mocked(WebLinksAddon).mock.calls[0]?.[1];
      expect(opts).toBeDefined();
      opts!.hover?.(new Event("mousemove") as unknown as MouseEvent, "https://example.com", {
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
      });
      expect(hover).toHaveBeenCalledWith(expect.any(Event), "https://example.com");
      opts!.leave?.(new Event("mouseleave") as unknown as MouseEvent, "https://example.com");
      expect(leave).toHaveBeenCalled();
    });

    it("constructs WebLinksAddon with undefined hover/leave when no handlers provided", () => {
      const terminal = createMockTerminal();
      const onActivate = vi.fn();

      createWebLinksAddon(terminal, onActivate);

      const opts = vi.mocked(WebLinksAddon).mock.calls[0]?.[1];
      expect(opts?.hover).toBeUndefined();
      expect(opts?.leave).toBeUndefined();
    });
  });

  describe("createFileLinksAddon hover wiring", () => {
    it("forwards onHover callback to FileLinksAddon constructor", () => {
      const terminal = createMockTerminal();
      const getCwd = () => "/tmp";
      const onHover = vi.fn();

      createFileLinksAddon(terminal, getCwd, onHover);

      expect(FileLinksAddon).toHaveBeenCalledWith(terminal, getCwd, onHover);
    });
  });
});
