import { describe, it, expect, vi } from "vitest";
import type { Terminal, IBufferLine } from "@xterm/xterm";
import { FileLinksAddon } from "../FileLinksAddon";

describe("FileLinksAddon", () => {
  const createMockTerminal = () => {
    return {
      buffer: {
        active: {
          getLine: vi.fn(),
        },
      },
    } as unknown as Terminal;
  };

  const createMockLine = (text: string): IBufferLine => {
    return {
      translateToString: () => text,
    } as IBufferLine;
  };

  describe("path matching", () => {
    it("should match absolute POSIX paths with line numbers", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "/home/user/project";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("Error at /home/user/project/src/App.tsx:45:12");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          expect(links).toHaveLength(1);
          expect(links![0]!.text).toBe("/home/user/project/src/App.tsx:45:12");
          expect(links![0]!.range.start.y).toBe(1);
          resolve();
        });
      });
    });

    it("should match relative paths with line numbers", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "/home/user/project";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("Error at src/App.tsx:45:12");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          expect(links).toHaveLength(1);
          expect(links![0]!.text).toBe("src/App.tsx:45:12");
          resolve();
        });
      });
    });

    it("should match Windows paths with line numbers", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "C:\\Users\\user\\project";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("Error at C:\\Users\\user\\project\\src\\App.tsx:45:12");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          expect(links).toHaveLength(1);
          expect(links![0]!.text).toBe("C:\\Users\\user\\project\\src\\App.tsx:45:12");
          resolve();
        });
      });
    });

    it("should match paths without line numbers", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "/home/user/project";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("Check file src/App.tsx");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          expect(links).toHaveLength(1);
          expect(links![0]!.text).toBe("src/App.tsx");
          resolve();
        });
      });
    });

    it("should match multiple paths on the same line", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "/home/user/project";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("Error at src/App.tsx:10 and src/utils.ts:20");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          expect(links!.length).toBeGreaterThanOrEqual(1);
          resolve();
        });
      });
    });
  });

  describe("exclusions", () => {
    it("should not match URLs with protocols", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "/home/user/project";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("Visit https://example.com/file.js:10");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it("should not match text without file extensions", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "/home/user/project";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("Error code: 404 at line 10");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });
  });

  describe("path resolution", () => {
    it("should resolve relative paths against cwd", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "/home/user/project";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("src/App.tsx:10");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          resolve();
        });
      });
    });

    it("should handle missing cwd gracefully", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("src/App.tsx:10");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });
  });

  describe("hover tracking", () => {
    it("invokes onHover with the link on hover() and null on leave()", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "/home/user/project";
        const calls: Array<unknown> = [];
        const addon = new FileLinksAddon(terminal, getCwd, (link) => calls.push(link));

        const line = createMockLine("Error at src/App.tsx:10");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          const link = links![0]!;
          const mouseEvent = new Event("mousemove") as unknown as MouseEvent;

          link.hover?.(mouseEvent, link.text);
          expect(calls.length).toBe(1);
          expect(calls[0]).toBe(link);

          link.leave?.(mouseEvent, link.text);
          expect(calls.length).toBe(2);
          expect(calls[1]).toBeNull();

          resolve();
        });
      });
    });

    it("works without an onHover callback (backwards compatible)", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const getCwd = () => "/home/user/project";
        const addon = new FileLinksAddon(terminal, getCwd);

        const line = createMockLine("src/App.tsx:10");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          const link = links![0]!;
          const mouseEvent = new Event("mousemove") as unknown as MouseEvent;
          expect(() => link.hover?.(mouseEvent, link.text)).not.toThrow();
          expect(() => link.leave?.(mouseEvent, link.text)).not.toThrow();
          resolve();
        });
      });
    });
  });
});
