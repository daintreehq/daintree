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
          const link = links![0]! as unknown as {
            text: string;
            range: { start: { y: number } };
            _absolutePath: string;
            _line?: number;
            _col?: number;
          };
          expect(link.text).toBe("/home/user/project/src/App.tsx:45:12");
          expect(link.range.start.y).toBe(1);
          expect(link._absolutePath).toBe("/home/user/project/src/App.tsx");
          expect(link._line).toBe(45);
          expect(link._col).toBe(12);
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
          const link = links![0]! as unknown as {
            text: string;
            _absolutePath: string;
            _line?: number;
            _col?: number;
          };
          expect(link.text).toBe("C:\\Users\\user\\project\\src\\App.tsx:45:12");
          expect(link._absolutePath).toBe("C:\\Users\\user\\project\\src\\App.tsx");
          expect(link._line).toBe(45);
          expect(link._col).toBe(12);
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

  describe("WSL UNC paths", () => {
    type ResolvedLink = {
      text: string;
      _absolutePath: string;
      _line?: number;
      _col?: number;
    };

    const matchSingle = (lineText: string) =>
      new Promise<ResolvedLink | null>((resolve) => {
        const terminal = createMockTerminal();
        const addon = new FileLinksAddon(terminal, () => "/home/user/project");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(createMockLine(lineText));
        addon.provideLinks(1, (links) => {
          if (!links || links.length === 0) {
            resolve(null);
            return;
          }
          resolve(links[0]! as unknown as ResolvedLink);
        });
      });

    it("matches \\\\wsl$ paths with line and column", async () => {
      const link = await matchSingle(
        "Error at \\\\wsl$\\Ubuntu\\home\\user\\project\\src\\App.tsx:45:12"
      );
      expect(link).not.toBeNull();
      expect(link!.text).toBe("\\\\wsl$\\Ubuntu\\home\\user\\project\\src\\App.tsx:45:12");
      expect(link!._absolutePath).toBe("\\\\wsl$\\Ubuntu\\home\\user\\project\\src\\App.tsx");
      expect(link!._line).toBe(45);
      expect(link!._col).toBe(12);
    });

    it("matches \\\\wsl$ paths without line numbers", async () => {
      const link = await matchSingle("\\\\wsl$\\Ubuntu\\home\\user\\project\\src\\App.tsx");
      expect(link).not.toBeNull();
      expect(link!.text).toBe("\\\\wsl$\\Ubuntu\\home\\user\\project\\src\\App.tsx");
      expect(link!._absolutePath).toBe("\\\\wsl$\\Ubuntu\\home\\user\\project\\src\\App.tsx");
      expect(link!._line).toBeUndefined();
      expect(link!._col).toBeUndefined();
    });

    it("matches \\\\wsl.localhost paths with a dotted distro name", async () => {
      const link = await matchSingle("\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\App.tsx:10");
      expect(link).not.toBeNull();
      expect(link!.text).toBe("\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\App.tsx:10");
      expect(link!._absolutePath).toBe("\\\\wsl.localhost\\Ubuntu-22.04\\home\\user\\App.tsx");
      expect(link!._line).toBe(10);
      expect(link!._col).toBeUndefined();
    });

    it("matches WSL paths containing a hidden directory segment", async () => {
      const link = await matchSingle("\\\\wsl$\\Ubuntu\\home\\user\\.config\\settings.json:3");
      expect(link).not.toBeNull();
      expect(link!._absolutePath).toBe("\\\\wsl$\\Ubuntu\\home\\user\\.config\\settings.json");
      expect(link!._line).toBe(3);
    });

    it("does not match WSL paths missing the leading double backslash", async () => {
      const link = await matchSingle("wsl$\\Ubuntu\\home\\user\\App.tsx");
      expect(link).toBeNull();
    });

    it("does not match a UNC root with no file segment", async () => {
      const link = await matchSingle("\\\\wsl$\\Ubuntu");
      expect(link).toBeNull();
    });

    it("does not match non-WSL UNC hosts", async () => {
      const link = await matchSingle("\\\\notwsl\\Ubuntu\\home\\user\\App.tsx");
      expect(link).toBeNull();
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
