import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Terminal, IBufferLine, ILink } from "@xterm/xterm";
import { FileLinksAddon, reportFileLinkFailure } from "../FileLinksAddon";
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
  systemClient: { openPath: vi.fn(), openInEditor: vi.fn(), showItemInFolderUnconfined: vi.fn() },
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
    it("should not match non-file protocol URLs", () => {
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

  describe("file:// URLs (#11419)", () => {
    const CODEX_URL =
      "file:///Users/gpriday/.codex/generated_images/019f92d9-d4b8-7de3-b1c3-56ce778ef00b/call_H5WWfuc4aUo8pAYO4a5eYRZ5.png";

    const linksFor = (lineText: string, cwd = "/home/user/project"): Promise<ILink[] | undefined> =>
      new Promise((resolve) => {
        const terminal = createMockTerminal();
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(createMockLine(lineText));
        new FileLinksAddon(terminal, () => cwd).provideLinks(1, resolve);
      });

    /**
     * Rows as xterm stores them: row 0 plus soft-wrapped continuations. Rows
     * are given with their real trailing spaces, and `translateToString`
     * honours `trimRight` the way xterm does — that difference is what decides
     * whether a rejoin fuses two tokens together.
     */
    const linksForWrapped = (rows: string[], hoveredRow: number): Promise<ILink[] | undefined> =>
      new Promise((resolve) => {
        const terminal = createMockTerminal();
        vi.mocked(terminal.buffer.active.getLine).mockImplementation((index: number) => {
          const text = rows[index];
          if (text === undefined) return undefined;
          return {
            translateToString: (trimRight?: boolean) => (trimRight ? text.trimEnd() : text),
            isWrapped: index > 0,
          } as IBufferLine;
        });
        new FileLinksAddon(terminal, () => "/home/user/project").provideLinks(
          hoveredRow + 1,
          resolve
        );
      });

    const readLink = (link: ILink) =>
      link as unknown as { kind: string; text: string; absolutePath: string };

    it("turns an agent's generated-image URL into a single file link", async () => {
      const links = await linksFor(`Saved image to ${CODEX_URL}`);
      expect(links).toHaveLength(1);
      const link = readLink(links![0]!);
      expect(link.kind).toBe("file");
      expect(link.text).toBe(CODEX_URL);
      expect(link.absolutePath).toBe(
        "/Users/gpriday/.codex/generated_images/019f92d9-d4b8-7de3-b1c3-56ce778ef00b/call_H5WWfuc4aUo8pAYO4a5eYRZ5.png"
      );
    });

    it("spans exactly the URL's columns", async () => {
      const prefix = "Saved to ";
      const url = "file:///tmp/a.png";
      const links = await linksFor(`${prefix}${url}.`);
      expect(links).toHaveLength(1);
      // xterm columns are 1-based and the end is inclusive, so the range covers
      // the URL alone — not the leading space, not the sentence period.
      expect(links![0]!.range).toEqual({
        start: { x: prefix.length + 1, y: 1 },
        end: { x: prefix.length + url.length, y: 1 },
      });
      expect(readLink(links![0]!).absolutePath).toBe("/tmp/a.png");
    });

    it("links a URL that fills the whole line", async () => {
      const links = await linksFor("file:///tmp/a.png");
      expect(links).toHaveLength(1);
      expect(readLink(links![0]!).absolutePath).toBe("/tmp/a.png");
    });

    it("links a URL delimited by backticks or angle brackets", async () => {
      for (const line of ["saved to `file:///tmp/a.png`", "saved to <file:///tmp/a.png>"]) {
        const links = await linksFor(line);
        expect(links).toHaveLength(1);
        expect(readLink(links![0]!).text).toBe("file:///tmp/a.png");
      }
    });

    it("accepts a mixed-case scheme and a localhost authority", async () => {
      for (const url of ["FILE:///tmp/a.png", "file://localhost/tmp/a.png"]) {
        const links = await linksFor(`saved to ${url}`);
        expect(links).toHaveLength(1);
        expect(readLink(links![0]!).absolutePath).toBe("/tmp/a.png");
      }
    });

    it("rejoins a soft-wrapped URL instead of linking the truncated prefix", async () => {
      // The motivating URL is 116 chars, so it wraps in any tiled terminal. The
      // prefix ending at the margin still parses as a valid URL — linking it
      // would silently open a real-but-wrong path.
      const rows = ["Saved image to file:///Users/gpriday/.codex/generated_", "images/shot.png"];
      for (const hoveredRow of [0, 1]) {
        const links = await linksForWrapped(rows, hoveredRow);
        expect(links).toHaveLength(1);
        const link = links![0]!;
        expect(readLink(link).absolutePath).toBe("/Users/gpriday/.codex/generated_images/shot.png");
        // One link spanning both rows — 1-based rows, inclusive end column.
        expect(link.range.start).toEqual({ x: "Saved image to ".length + 1, y: 1 });
        expect(link.range.end).toEqual({ x: "images/shot.png".length, y: 2 });
      }
    });

    it("links a continuation row that carries no separator of its own", async () => {
      // `shot.png` alone would hit the '/'-or-'\' fast path and never be
      // scanned, leaving the tail of a wrapped URL dead to the pointer.
      const links = await linksForWrapped(["file:///tmp/long/", "shot.png"], 1);
      expect(links).toHaveLength(1);
      expect(readLink(links![0]!).absolutePath).toBe("/tmp/long/shot.png");
    });

    it("keeps the spaces that separate a wrapped URL from the next token", async () => {
      // Row one is full to the margin with real spaces. Trimming them on
      // rejoin would fuse the two tokens into `/tmp/a.pngsrc/foo.ts`.
      const links = await linksForWrapped(["file:///tmp/a.png   ", "src/foo.ts"], 0);
      expect(links).toHaveLength(1);
      expect(readLink(links![0]!).absolutePath).toBe("/tmp/a.png");
    });

    it("ignores a URL that lies entirely on a sibling row", async () => {
      // xterm evicts lower-priority links intersecting a returned range, so a
      // link the pointer can't reach on this row must not be reported at all.
      expect(await linksForWrapped(["no separator here", "file:///tmp/a.png"], 0)).toBeUndefined();
    });

    it("refuses to link a URL clipped by the rejoin budget", async () => {
      // Past the budget the window's edge is not a token boundary, and a
      // truncated file URL still parses — the original wrapping bug.
      const rows: string[] = [];
      const huge = `file:///tmp/${"a".repeat(2500)}.png`;
      for (let i = 0; i < huge.length; i += 80) rows.push(huge.slice(i, i + 80));
      expect(await linksForWrapped(rows, 0)).toBeUndefined();
      expect(await linksForWrapped(rows, rows.length - 1)).toBeUndefined();
    });

    it("does not let a literal ( in a URL leak a bare-path link", async () => {
      // `(` is legal in a file URL and is also FILE_PATH_REGEX's boundary
      // character, so the tail would otherwise resolve against the cwd.
      const links = await linksFor("open file:///tmp/(src/foo.ts");
      expect(links).toHaveLength(1);
      expect(readLink(links![0]!).absolutePath).toBe("/tmp/(src/foo.ts");
    });

    it("does not let a rejected remote URL leak a bare-path link", async () => {
      expect(await linksFor("open file://someserver/(share/x.png")).toBeUndefined();
    });

    it("keeps query and fragment in the link text but out of the resolved path", async () => {
      const links = await linksFor("open file:///tmp/a.png?download=1#preview");
      expect(links).toHaveLength(1);
      const link = readLink(links![0]!);
      expect(link.text).toBe("file:///tmp/a.png?download=1#preview");
      expect(link.absolutePath).toBe("/tmp/a.png");
    });

    it("decodes the Windows drive spellings a URL can carry", async () => {
      for (const url of ["file:///C:/Users/me/x.png", "file:///C|/Users/me/x.png"]) {
        const links = await linksFor(`open ${url}`);
        expect(links).toHaveLength(1);
        expect(readLink(links![0]!).absolutePath).toBe("C:/Users/me/x.png");
      }
    });

    it("produces no link for a URL that isn't a viewable local file", async () => {
      const rejected = [
        "file://someserver/share/x.png",
        "file:////someserver/share/x.png",
        "file:///tmp/a%2Fb.png",
        "file:///tmp/a%zz.png",
        "file:///",
        "file:///tmp/renders/",
      ];
      for (const url of rejected) {
        expect(await linksFor(`open ${url}`)).toBeUndefined();
      }
    });

    it("links a URL and a bare path on the same line without overlapping", async () => {
      const links = await linksFor("wrote file:///tmp/a.png from src/App.tsx:10");
      expect(links).toHaveLength(2);
      expect(links!.map((link) => readLink(link).absolutePath)).toEqual([
        "/tmp/a.png",
        "/home/user/project/src/App.tsx",
      ]);
      const [first, second] = links!;
      expect(first!.range.end.x).toBeLessThan(second!.range.start.x);
    });

    it("reports hover and leave like any other file link", async () => {
      const terminal = createMockTerminal();
      vi.mocked(terminal.buffer.active.getLine).mockReturnValue(
        createMockLine(`Saved image to ${CODEX_URL}`)
      );
      const seen: Array<unknown> = [];
      const addon = new FileLinksAddon(
        terminal,
        () => "/p",
        (link) => seen.push(link)
      );

      const link = await new Promise<ILink>((resolve) =>
        addon.provideLinks(1, (links) => resolve(links![0]!))
      );
      const event = new Event("mousemove") as unknown as MouseEvent;
      link.hover?.(event, link.text);
      link.leave?.(event, link.text);
      expect(seen).toEqual([link, null]);
    });

    describe("activation", () => {
      const DECODED =
        "/Users/gpriday/.codex/generated_images/019f92d9-d4b8-7de3-b1c3-56ce778ef00b/call_H5WWfuc4aUo8pAYO4a5eYRZ5.png";

      beforeEach(() => {
        vi.mocked(actionService.dispatch).mockReset();
        vi.mocked(systemClient.openPath).mockReset();
        vi.mocked(systemClient.openInEditor).mockReset();
        vi.mocked(actionService.dispatch).mockResolvedValue({
          ok: true,
          result: { panelId: "p1" },
        });
      });

      const activateUrlLink = async (modifiers: MouseEventInit) => {
        const links = await linksFor(`Saved image to ${CODEX_URL}`);
        const link = links![0]!;
        link.activate({ metaKey: false, ctrlKey: false, ...modifiers } as MouseEvent, link.text);
        await vi.waitFor(() => expect(actionService.dispatch).toHaveBeenCalledTimes(1));
      };

      it("opens in the in-app viewer rather than the OS default app", async () => {
        await activateUrlLink({});
        expect(actionService.dispatch).toHaveBeenCalledWith(
          "file.view",
          expect.objectContaining({ path: DECODED, line: undefined, col: undefined }),
          { source: "user" }
        );
        expect(systemClient.openPath).not.toHaveBeenCalled();
      });

      it("falls back to the OS opener only after the in-app viewer refuses", async () => {
        // Deliberate: a file:// URL and its bare-path spelling must behave the
        // same way once file.view has failed. The issue's constraint is about
        // which linkifier owns the token, not about the recovery path.
        vi.mocked(actionService.dispatch).mockResolvedValue({
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "no panel" },
        });
        await activateUrlLink({});
        await vi.waitFor(() => expect(systemClient.openPath).toHaveBeenCalledWith(DECODED));
      });

      it("sends the decoded path to the external editor on a modified click", async () => {
        await activateUrlLink({ metaKey: true });
        expect(actionService.dispatch).toHaveBeenCalledWith(
          "file.openInEditor",
          expect.objectContaining({ path: DECODED, line: undefined, col: undefined }),
          { source: "user" }
        );
        expect(systemClient.openInEditor).not.toHaveBeenCalled();
      });
    });
  });

  describe("soft-wrapped bare paths (#11865)", () => {
    const CWD = "/home/user/project";

    /**
     * Rows as xterm stores them, with `translateToString` honouring `trimRight`
     * the way xterm does. `wrapped[i]` marks row i as the CONTINUATION of row
     * i-1 — the flag the rejoin walks — so a hard newline is modelled by
     * clearing that flag, never by anything about the text.
     */
    const makeWrappedTerminal = (rows: string[], wrapped?: boolean[]): Terminal => {
      const terminal = createMockTerminal();
      vi.mocked(terminal.buffer.active.getLine).mockImplementation((index: number) => {
        const text = rows[index];
        if (text === undefined) return undefined;
        return {
          translateToString: (trimRight?: boolean) => (trimRight ? text.trimEnd() : text),
          isWrapped: wrapped ? wrapped[index] === true : index > 0,
        } as IBufferLine;
      });
      return terminal;
    };

    const linksForRows = (
      rows: string[],
      hoveredRow: number,
      options: { wrapped?: boolean[]; cwd?: string } = {}
    ): Promise<ILink[] | undefined> =>
      new Promise((resolve) => {
        new FileLinksAddon(
          makeWrappedTerminal(rows, options.wrapped),
          () => options.cwd ?? CWD
        ).provideLinks(hoveredRow + 1, resolve);
      });

    const readLink = (link: ILink) =>
      link as unknown as {
        kind: string;
        text: string;
        absolutePath: string;
        _line?: number;
        _col?: number;
      };

    it("rejoins a soft-wrapped bare path instead of linking the truncated tail", async () => {
      // The fragment left on the continuation row resolves against the cwd
      // just as happily as the whole path, so the old row-local scan produced
      // a link to a real-but-wrong file with nothing to signal it.
      const rows = ["compiled src/services/terminal/FileLinks", "Addon.ts in 2s"];
      for (const hoveredRow of [0, 1]) {
        const links = await linksForRows(rows, hoveredRow);
        expect(links).toHaveLength(1);
        const link = links![0]!;
        expect(readLink(link).text).toBe("src/services/terminal/FileLinksAddon.ts");
        expect(readLink(link).absolutePath).toBe(
          "/home/user/project/src/services/terminal/FileLinksAddon.ts"
        );
        // One link spanning both rows — 1-based rows, inclusive end column.
        expect(link.range.start).toEqual({ x: "compiled ".length + 1, y: 1 });
        expect(link.range.end).toEqual({ x: "Addon.ts".length, y: 2 });
      }
    });

    it("links a path split immediately before its extension", async () => {
      const links = await linksForRows(["see src/components/Terminal", ".tsx now"], 1);
      expect(links).toHaveLength(1);
      expect(readLink(links![0]!).absolutePath).toBe(
        "/home/user/project/src/components/Terminal.tsx"
      );
    });

    it("keeps a :line:column suffix that wrapped onto the next row", async () => {
      const links = await linksForRows(["error at src/App.tsx:4", "2:13 in build"], 0);
      expect(links).toHaveLength(1);
      const link = readLink(links![0]!);
      expect(link.text).toBe("src/App.tsx:42:13");
      expect(link.absolutePath).toBe("/home/user/project/src/App.tsx");
      expect(link._line).toBe(42);
      expect(link._col).toBe(13);
    });

    it("links from a continuation row that carries no separator of its own", async () => {
      // `sprite.png` alone would hit the '/'-or-'\' fast path and never be
      // scanned, leaving the tail of a wrapped path dead to the pointer.
      const links = await linksForRows(["writing src/generated/", "sprite.png done"], 1);
      expect(links).toHaveLength(1);
      expect(readLink(links![0]!).absolutePath).toBe("/home/user/project/src/generated/sprite.png");
    });

    it("never fuses two paths separated by a hard newline", async () => {
      // Structural: the rejoin only walks rows flagged as continuations, so a
      // real line break leaves each path alone on its own row.
      const rows = ["first src/alpha.ts", "second src/beta.ts"];
      for (const hoveredRow of [0, 1]) {
        const links = await linksForRows(rows, hoveredRow, { wrapped: [false, false] });
        expect(links).toHaveLength(1);
        const link = links![0]!;
        expect(readLink(link).absolutePath).toBe(
          hoveredRow === 0 ? "/home/user/project/src/alpha.ts" : "/home/user/project/src/beta.ts"
        );
        expect(link.range.start.y).toBe(hoveredRow + 1);
        expect(link.range.end.y).toBe(hoveredRow + 1);
      }
    });

    it("treats a wrap with no delimiter as the single token the user sees", async () => {
      // Row one ran to the margin, so the terminal really did print one
      // unbroken token — the rejoin has to read it the way an unwrapped line
      // would, rather than inventing a boundary at the row edge.
      const links = await linksForRows(["see src/foo.ts", "x/bar.md"], 0);
      expect(links).toHaveLength(1);
      const link = readLink(links![0]!);
      expect(link.text).toBe("src/foo.tsx/bar.md");
      expect(link.absolutePath).toBe("/home/user/project/src/foo.tsx/bar.md");
    });

    it("keeps the spaces that separate a wrapped path from the next token", async () => {
      // Row one is full to the margin with real spaces. Trimming them on
      // rejoin would fuse the two tokens into `src/a.tsdocs/b.md`.
      const links = await linksForRows(["see src/a.ts   ", "docs/b.md"], 0);
      expect(links).toHaveLength(1);
      expect(readLink(links![0]!).absolutePath).toBe("/home/user/project/src/a.ts");
    });

    it("ignores a bare path that lies entirely on a sibling row", async () => {
      // xterm evicts lower-priority links intersecting a returned range, so a
      // link the pointer can't reach on this row must not be reported at all.
      expect(
        await linksForRows(["plain prose with no token", "see src/foo.ts"], 0)
      ).toBeUndefined();
    });

    it("refuses to link a bare path clipped by the rejoin budget", async () => {
      // The window is anchored on the hovered row and grows outward on a fixed
      // budget, so a token longer than that gets an edge the regex reads as a
      // real token boundary — the same lie a row edge tells.
      const toRows = (token: string): string[] => {
        const rows: string[] = [];
        for (let index = 0; index < token.length; index += 80) {
          rows.push(token.slice(index, index + 80));
        }
        return rows;
      };

      // Clipped at the end: the window stops at 2000 columns, exactly where
      // this token's only extension sits, so the match ends on the cut.
      const endClipped = `src/${"a".repeat(1994)}.ts${"/b".repeat(400)}`;
      expect(await linksForRows(toRows(endClipped), 0)).toBeUndefined();

      // Clipped at the start: hovering the last row walks upward instead, and
      // the window opens mid-token where `^` is a lie.
      const startClipped = `${"s".repeat(880)}/dir/${"c".repeat(1992)}.ts`;
      const startRows = toRows(startClipped);
      expect(await linksForRows(startRows, startRows.length - 1)).toBeUndefined();
    });

    it("keeps a wrapped file:// URL from leaking a bare-path link on either row", async () => {
      // `(` is legal in a file URL and is also FILE_PATH_REGEX's boundary
      // character. The URL's claim is recorded in ROW-LOCAL coordinates, so a
      // logical-line match has to be projected back before it is tested
      // against the ledger — skip that and the shielding silently stops firing
      // while everything still typechecks.
      const rows = ["open file:///tmp/(src/", "foo.ts"];
      for (const hoveredRow of [0, 1]) {
        const links = await linksForRows(rows, hoveredRow);
        expect(links).toHaveLength(1);
        expect(readLink(links![0]!).absolutePath).toBe("/tmp/(src/foo.ts");
      }
    });

    it("hands the hover callback the full path, not the fragment", async () => {
      // `hoveredLink` is what right-click "Reveal in File Manager" reads, so a
      // fragment here opens a real-but-wrong file and reports no failure.
      const seen: Array<{ absolutePath?: string } | null> = [];
      const addon = new FileLinksAddon(
        makeWrappedTerminal(["wrote src/generated/", "sprite.png"]),
        () => CWD,
        (link) => seen.push(link)
      );

      const link = await new Promise<ILink>((resolve) =>
        addon.provideLinks(2, (links) => resolve(links![0]!))
      );
      link.hover?.(new Event("mousemove") as unknown as MouseEvent, link.text);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.absolutePath).toBe("/home/user/project/src/generated/sprite.png");
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
      vi.mocked(systemClient.showItemInFolderUnconfined).mockReset();
      // The real client returns Promise<void>; give the mock a resolved default
      // so the Reveal action's fire-and-forget .catch() has a promise to chain.
      vi.mocked(systemClient.showItemInFolderUnconfined).mockResolvedValue(undefined);
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
      expect(payload.coalesce?.key).toBe("filelink-activate-fail:outside-root");
      expect(payload.message).toContain("Path is outside your project roots");
      expect(payload.message).toContain("App.tsx");
      // OUTSIDE_ROOT offers Reveal (the file is real, just outside roots) — not
      // Copy path. The coalesce key is split so this action can't bleed into a
      // coalesced INVALID_PATH / generic "Copy path" toast.
      expect(payload.action?.label).toBe("Reveal in File Manager");

      // Clicking Reveal routes the resolved absolute path (line/col stripped)
      // through the unconfined IPC op — never auto, always user-initiated.
      payload.action?.onClick?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(systemClient.showItemInFolderUnconfined).toHaveBeenCalledWith(
        "/home/user/project/src/App.tsx"
      );
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

    it("copy-path action button writes the resolved absolute path (line/col stripped) to the clipboard", async () => {
      const terminal = createMockTerminal();
      const link = await buildLink(
        terminal,
        () => "/home/user/project",
        "/home/user/project/src/App.tsx:10:2"
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

      // Must be the resolved absolute path, NOT link.text (which includes
      // :10:2). The user's clipboard should never have line/col noise.
      expect(writeText).toHaveBeenCalledWith("/home/user/project/src/App.tsx");
      expect(writeText).not.toHaveBeenCalledWith("/home/user/project/src/App.tsx:10:2");
    });

    it("surfaces rejections from actionService.dispatch itself (distinct from ok:false path)", async () => {
      const terminal = createMockTerminal();
      const link = await buildLink(terminal, () => "/home/user/project");
      expect(link).toBeDefined();

      vi.mocked(actionService.dispatch).mockRejectedValue(new Error("dispatch threw"));
      vi.mocked(systemClient.openPath).mockResolvedValue(undefined);

      link!.activate(makeClick(), link!.text);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(notify).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(notify).mock.calls[0]?.[0] as { message: string };
      expect(payload.message).toContain("dispatch threw");
      // dispatch rejected, so the systemClient fallback should never run.
      expect(systemClient.openPath).not.toHaveBeenCalled();
    });

    it("modified-click path (openInEditor) routes AppError(INVALID_PATH) into the code-aware body", async () => {
      const terminal = createMockTerminal();
      const link = await buildLink(terminal, () => "/home/user/project");
      expect(link).toBeDefined();

      vi.mocked(actionService.dispatch).mockResolvedValue({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "openInEditor failed" },
      });
      vi.mocked(systemClient.openInEditor).mockRejectedValue(
        new Error("[AppError|INVALID_PATH|Path is not a valid file] Path is not a valid file")
      );

      link!.activate(makeClick({ metaKey: true }), link!.text);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(systemClient.openInEditor).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(notify).mock.calls[0]?.[0] as { message: string };
      expect(payload.message).toContain("Path is not a valid file");
    });

    it("OUTSIDE_ROOT and INVALID_PATH produce distinct coalesce keys and actions (no bleed)", () => {
      // notify() overwrites the singular action with the latest call's on each
      // coalesce tick — a shared key would flip a coalesced toast's button
      // between Reveal and Copy path across a mixed-code burst. Splitting the
      // key by affordance keeps each toast honest.
      reportFileLinkFailure(
        "test",
        new Error(
          "[AppError|OUTSIDE_ROOT|Path is not in a project root] Path is not in a project root"
        ),
        "/etc/outside.txt"
      );
      reportFileLinkFailure(
        "test",
        new Error("[AppError|INVALID_PATH|Path is not a valid file] Path is not a valid file"),
        "/bad/path.txt"
      );

      const outsidePayload = vi.mocked(notify).mock.calls[0]?.[0] as {
        coalesce?: { key: string };
        action?: { label: string };
      };
      const invalidPayload = vi.mocked(notify).mock.calls[1]?.[0] as {
        coalesce?: { key: string };
        action?: { label: string };
      };
      expect(outsidePayload.coalesce?.key).toBe("filelink-activate-fail:outside-root");
      expect(outsidePayload.action?.label).toBe("Reveal in File Manager");
      expect(invalidPayload.coalesce?.key).toBe("filelink-activate-fail");
      expect(invalidPayload.action?.label).toBe("Copy path");
      expect(outsidePayload.coalesce?.key).not.toBe(invalidPayload.coalesce?.key);
    });

    it("Reveal action catches a rejection and surfaces a recovery toast", async () => {
      reportFileLinkFailure(
        "test",
        new Error(
          "[AppError|OUTSIDE_ROOT|Path is not in a project root] Path is not in a project root"
        ),
        "/etc/outside.txt"
      );
      const payload = vi.mocked(notify).mock.calls[0]?.[0] as {
        action?: { onClick?: () => void };
      };
      vi.mocked(systemClient.showItemInFolderUnconfined).mockRejectedValueOnce(new Error("gone"));

      // onClick is synchronous; the reveal is fire-and-forget with a .catch().
      expect(() => payload.action?.onClick?.()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(systemClient.showItemInFolderUnconfined).toHaveBeenCalledWith("/etc/outside.txt");
      // The catch surfaced a recovery toast (Copy path) — proving the rejection
      // was handled, not swallowed into a silent no-op.
      expect(notify).toHaveBeenCalledTimes(2);
      const recovery = vi.mocked(notify).mock.calls[1]?.[0] as {
        title?: string;
        action?: { label?: string };
      };
      expect(recovery.title).toBe("Couldn't reveal file");
      expect(recovery.action?.label).toBe("Copy path");
    });
  });
});
