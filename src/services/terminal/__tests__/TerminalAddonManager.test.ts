import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockImageAddon, mockSearchAddon, mockUnicode11Addon } = vi.hoisted(() => ({
  mockImageAddon: vi.fn(),
  mockSearchAddon: vi.fn(),
  mockUnicode11Addon: vi.fn(),
}));

vi.mock("@xterm/addon-image", () => ({ ImageAddon: mockImageAddon }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn() }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: vi.fn() }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: mockSearchAddon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: mockUnicode11Addon }));
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
  __testing,
} from "../TerminalAddonManager";
import type { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FileLinksAddon } from "../FileLinksAddon";

function createMockTerminal() {
  return {
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    unicode: { activeVersion: "6" as string },
  } as unknown as Terminal;
}

describe("TerminalAddonManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ImageAddon and Unicode11Addon are lazy-loaded and cached at module scope
    // (#10840); reset that cache so each test re-imports against a clean mock.
    __testing.resetLoaderState();
  });

  describe("setupTerminalAddons", () => {
    it("defers ImageAddon off the eager core set (#9809)", async () => {
      const terminal = createMockTerminal();
      const addons = await setupTerminalAddons(terminal);

      // ImageAddon is built lazily via createImageAddon once a terminal is
      // actually opened, not on the bulk-create cold path.
      expect(mockImageAddon).not.toHaveBeenCalled();
      expect(addons.imageAddon).toBeNull();
    });

    it("defers file-link and web-link providers off the eager core set (#9809)", async () => {
      const terminal = createMockTerminal();
      const addons = await setupTerminalAddons(terminal);

      expect(FileLinksAddon).not.toHaveBeenCalled();
      expect(WebLinksAddon).not.toHaveBeenCalled();
      expect(addons.fileLinksDisposable).toBeNull();
      expect(addons.webLinksAddon).toBeNull();
    });

    it("creates SearchAddon eagerly with highlightLimit for bounded match counts", async () => {
      const terminal = createMockTerminal();
      await setupTerminalAddons(terminal);

      expect(mockSearchAddon).toHaveBeenCalledWith({
        highlightLimit: SEARCH_HIGHLIGHT_LIMIT,
      });
    });

    it("activates Unicode 11 widths so modern emoji and CJK glyphs render at 2 cells (issue #7205)", async () => {
      const terminal = createMockTerminal();
      await setupTerminalAddons(terminal);

      expect(mockUnicode11Addon).toHaveBeenCalledTimes(1);
      expect(terminal.loadAddon).toHaveBeenCalledWith(expect.any(mockUnicode11Addon));
      expect(terminal.unicode.activeVersion).toBe("11");
    });

    it("degrades to Unicode 6 widths when the Unicode11 addon fails rather than failing setup", async () => {
      mockUnicode11Addon.mockImplementationOnce(() => {
        throw new Error("addon load failed");
      });
      const terminal = createMockTerminal();

      // Setup still resolves with the rest of the eager core intact — a terminal
      // with mis-measured emoji beats no terminal at all.
      const addons = await setupTerminalAddons(terminal);

      expect(terminal.unicode.activeVersion).toBe("6");
      expect(mockSearchAddon).toHaveBeenCalledTimes(1);
      expect(addons.searchAddon).toBeDefined();
    });
  });

  describe("createImageAddon", () => {
    it("creates ImageAddon with memory-safe options", async () => {
      const terminal = createMockTerminal();
      await createImageAddon(terminal);

      expect(mockImageAddon).toHaveBeenCalledWith({
        pixelLimit: 2_000_000,
        storageLimit: 8,
      });
    });

    it("loads the addon onto the terminal", async () => {
      const terminal = createMockTerminal();
      await createImageAddon(terminal);

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
