import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Terminal, IBufferLine, ILink } from "@xterm/xterm";
import { FileLinksAddon } from "../FileLinksAddon";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { systemClient } from "@/clients";

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/clients", () => ({
  systemClient: { openPath: vi.fn(), openInEditor: vi.fn() },
}));

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
          expect(links.length).toBe(1);
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

    it("reports the buffer column where the WSL path begins", () =>
      new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const addon = new FileLinksAddon(terminal, () => "/home/user/project");
        const line = createMockLine("Error at \\\\wsl$\\Ubuntu\\home\\user\\App.tsx:45:12");
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          expect(links).toHaveLength(1);
          // "Error at " is 9 chars; the leading backslash sits at 0-based index 9,
          // so the 1-based buffer column is 10.
          expect(links![0]!.range.start.x).toBe(10);
          expect(links![0]!.range.end.x).toBe(
            9 + "\\\\wsl$\\Ubuntu\\home\\user\\App.tsx:45:12".length
          );
          resolve();
        });
      }));

    it("matches two WSL paths on the same line independently", () =>
      new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const addon = new FileLinksAddon(terminal, () => "/home/user/project");
        const line = createMockLine(
          "Compare \\\\wsl$\\Ubuntu\\home\\user\\App.tsx:45:12 and \\\\wsl.localhost\\Debian\\srv\\util.ts:9"
        );
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);

        addon.provideLinks(1, (links) => {
          expect(links).toBeDefined();
          expect(links).toHaveLength(2);
          const resolved = links! as unknown as Array<{ text: string; _absolutePath: string }>;
          expect(resolved[0]!.text).toBe("\\\\wsl$\\Ubuntu\\home\\user\\App.tsx:45:12");
          expect(resolved[0]!._absolutePath).toBe("\\\\wsl$\\Ubuntu\\home\\user\\App.tsx");
          expect(resolved[1]!.text).toBe("\\\\wsl.localhost\\Debian\\srv\\util.ts:9");
          expect(resolved[1]!._absolutePath).toBe("\\\\wsl.localhost\\Debian\\srv\\util.ts");
          resolve();
        });
      }));
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

  describe("activation failures (#9925)", () => {
    beforeEach(() => {
      vi.mocked(notify).mockClear();
      vi.mocked(actionService.dispatch).mockReset();
      vi.mocked(systemClient.openPath).mockReset();
      vi.mocked(systemClient.openInEditor).mockReset();
      Object.defineProperty(global.navigator, "clipboard", {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
      });
    });

    const buildLink = (
      terminal: Terminal,
      getCwd: () => string,
      text = "/home/user/project/src/App.tsx:10"
    ): Promise<ILink | undefined> =>
      new Promise((resolve) => {
        const line = createMockLine(`Error at ${text}`);
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(line);
        const addon = new FileLinksAddon(terminal, getCwd);
        addon.provideLinks(1, (links) => resolve(links?.[0]));
      });

    const makeClick = (modifiers: MouseEventInit = {}): MouseEvent =>
      ({ metaKey: false, ctrlKey: false, ...modifiers }) as unknown as MouseEvent;

    it("surfaces OUTSIDE_ROOT from the systemClient fallback as a user-visible toast", async () => {
      const terminal = createMockTerminal();
      const link = await buildLink(terminal, () => "/home/user/project");
      expect(link).toBeDefined();

      vi.mocked(actionService.dispatch).mockResolvedValue({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "view failed" },
      });
      const outsideRootError = new Error(
        "[AppError|OUTSIDE_ROOT|Path is not in a project root] Path is not in a project root"
      );
      vi.mocked(systemClient.openPath).mockRejectedValue(outsideRootError);

      link!.activate(makeClick(), link!.text);
      // Microtask flush so the .then/.catch chain settles.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(notify).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(notify).mock.calls[0]?.[0] as {
        type: string;
        title: string;
        message: string;
        action?: { label: string; onClick?: () => void };
        coalesce?: { key: string };
        priority?: string;
      };
      expect(payload.type).toBe("error");
      expect(payload.title).toBe("Couldn't open file link");
      expect(payload.priority).toBe("high");
      expect(payload.coalesce?.key).toBe("filelink-activate-fail");
      expect(payload.message).toContain("Path is outside your project roots");
      expect(payload.message).toContain("App.tsx");
      expect(payload.action?.label).toBe("Copy path");
    });

    it("surfaces INVALID_PATH (e.g. WSL UNC) using the code-aware message", async () => {
      const terminal = createMockTerminal();
      const link = await buildLink(
        terminal,
        () => "/home/user/project",
        "/home/user/project/missing.app:1"
      );
      expect(link).toBeDefined();

      vi.mocked(actionService.dispatch).mockResolvedValue({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "view failed" },
      });
      const invalidPathError = new Error(
        "[AppError|INVALID_PATH|Path is not a valid file] Path is not a valid file"
      );
      vi.mocked(systemClient.openPath).mockRejectedValue(invalidPathError);

      link!.activate(makeClick(), link!.text);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(notify).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(notify).mock.calls[0]?.[0] as { message: string };
      expect(payload.message).toContain("Path is not a valid file");
    });

    it("falls back to the error's own message when no AppError code is present", async () => {
      const terminal = createMockTerminal();
      const link = await buildLink(terminal, () => "/home/user/project");
      expect(link).toBeDefined();

      vi.mocked(actionService.dispatch).mockResolvedValue({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "view failed" },
      });
      vi.mocked(systemClient.openPath).mockRejectedValue(new Error("disk gone"));

      link!.activate(makeClick(), link!.text);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(notify).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(notify).mock.calls[0]?.[0] as { message: string };
      expect(payload.message).toContain("disk gone");
    });

    it("does NOT toast when actionService dispatch succeeds (no false-positive)", async () => {
      const terminal = createMockTerminal();
      const link = await buildLink(terminal, () => "/home/user/project");
      expect(link).toBeDefined();

      vi.mocked(actionService.dispatch).mockResolvedValue({ ok: true, result: undefined });
      vi.mocked(systemClient.openPath).mockResolvedValue(undefined);

      link!.activate(makeClick(), link!.text);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(notify).not.toHaveBeenCalled();
      // systemClient fallback should NOT have been called when the action succeeded.
      expect(systemClient.openPath).not.toHaveBeenCalled();
    });

    it("routes the modified-click (openInEditor) path and surfaces editor failures", async () => {
      const terminal = createMockTerminal();
      const link = await buildLink(terminal, () => "/home/user/project");
      expect(link).toBeDefined();

      vi.mocked(actionService.dispatch).mockResolvedValue({
        ok: false,
        error: { code: "NOT_FOUND", message: "action not registered" },
      });
      vi.mocked(systemClient.openInEditor).mockRejectedValue(new Error("no editor configured"));

      link!.activate(makeClick({ metaKey: true }), link!.text);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(systemClient.openInEditor).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(notify).mock.calls[0]?.[0] as { message: string };
      expect(payload.message).toContain("no editor configured");
    });

    it("copy-path action button writes the absolute path to the clipboard", async () => {
      const terminal = createMockTerminal();
      const link = await buildLink(
        terminal,
        () => "/home/user/project",
        "/home/user/project/src/App.tsx"
      );
      expect(link).toBeDefined();

      vi.mocked(actionService.dispatch).mockResolvedValue({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "boom" },
      });
      vi.mocked(systemClient.openPath).mockRejectedValue(new Error("boom"));

      link!.activate(makeClick(), link!.text);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const writeText = vi.mocked(navigator.clipboard.writeText);
      const payload = vi.mocked(notify).mock.calls[0]?.[0] as {
        action?: { onClick?: () => void };
      };
      payload.action?.onClick?.();

      expect(writeText).toHaveBeenCalledWith("/home/user/project/src/App.tsx");
    });
  });
});
