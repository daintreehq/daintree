import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Terminal, IBufferLine, ILink } from "@xterm/xterm";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/clients", () => ({
  systemClient: {
    openPath: vi.fn(),
    openInEditor: vi.fn(),
    showItemInFolderUnconfined: vi.fn(),
    checkDirectory: vi.fn(),
  },
}));
vi.mock("@/clients/fileBrowserClient", () => ({ fileBrowserClient: { statPaths: vi.fn() } }));
vi.mock("@/store/createWorktreeStore", () => ({ getCurrentViewStoreOrNull: vi.fn() }));

import { FileLinksAddon } from "../FileLinksAddon";
import { fileBrowserClient } from "@/clients/fileBrowserClient";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { actionService } from "@/services/ActionService";
import { systemClient } from "@/clients";

// The validation memo is module-level, so every test uses its own worktree
// root — a cached verdict for one root can't leak into the next test.
let rootCounter = 0;
function nextRoot(): string {
  rootCounter += 1;
  return `/repo${rootCounter}`;
}

function bindWorktrees(worktrees: Map<string, { id: string; path: string }>): void {
  vi.mocked(getCurrentViewStoreOrNull).mockReturnValue({
    getState: () => ({ worktrees }),
  } as unknown as ReturnType<typeof getCurrentViewStoreOrNull>);
}

/**
 * Rows keyed by buffer index, not by call order: the addon reads a row more
 * than once per hover (the row itself, the wrap probe, the rejoin, the
 * post-validation re-read), so a call-counting mock would silently change what
 * a test means the moment that count moved. `rows` is read live, so a test can
 * model a mid-validation rewrite by mutating it. `wrapped[i]` marks row i as
 * the CONTINUATION of row i-1.
 */
function makeTerminal(rows: string[], wrapped?: boolean[]): Terminal {
  return {
    buffer: {
      active: {
        getLine: vi.fn((index: number): IBufferLine | undefined => {
          const text = rows[index];
          if (text === undefined) return undefined;
          return {
            translateToString: (trimRight?: boolean) => (trimRight ? text.trimEnd() : text),
            isWrapped: wrapped ? wrapped[index] === true : index > 0,
          } as IBufferLine;
        }),
      },
    },
  } as unknown as Terminal;
}

/**
 * An agent TUI's own wrapping: rows padded to `cols`, none flagged
 * `isWrapped`. Read live like `makeTerminal`, so a test can rewrite a row.
 */
function makeGrid(rows: string[], cols: number): Terminal {
  return {
    cols,
    buffer: {
      active: {
        getLine: vi.fn((index: number): IBufferLine | undefined => {
          const row = rows[index];
          if (row === undefined) return undefined;
          const text = row.padEnd(cols);
          return {
            translateToString: (trimRight?: boolean) => (trimRight ? text.trimEnd() : text),
            isWrapped: false,
          } as IBufferLine;
        }),
      },
    },
  } as unknown as Terminal;
}

function provide(addon: FileLinksAddon, bufferLineNumber = 1): Promise<ILink[] | undefined> {
  return new Promise((resolve) => {
    addon.provideLinks(bufferLineNumber, resolve);
  });
}

/** A `statPaths` call held open so a test can rewrite the buffer under it. */
function pendingStat(): {
  resolve: (kinds: Array<"directory" | "file" | null>) => void;
  reject: (error: Error) => void;
} {
  let resolve: (kinds: Array<"directory" | "file" | null>) => void = () => {};
  let reject: (error: Error) => void = () => {};
  vi.mocked(fileBrowserClient.statPaths).mockReturnValue(
    new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    })
  );
  return { resolve, reject };
}

describe("FileLinksAddon directory links", () => {
  beforeEach(() => {
    vi.mocked(fileBrowserClient.statPaths).mockReset();
    vi.mocked(actionService.dispatch).mockReset();
  });

  it("links a validated extensionless token and activates into the file browser", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    vi.mocked(fileBrowserClient.statPaths).mockResolvedValue(["directory"]);
    vi.mocked(actionService.dispatch).mockResolvedValue({ ok: true } as never);

    const addon = new FileLinksAddon(
      makeTerminal(["wrote files under src/utils today"]),
      () => root
    );
    const links = await provide(addon);

    expect(links).toHaveLength(1);
    const link = links![0]! as ILink & { kind: string };
    expect(link.kind).toBe("directory");
    expect(link.text).toBe("src/utils");
    expect(fileBrowserClient.statPaths).toHaveBeenCalledWith({
      worktreeId: root,
      paths: ["src/utils"],
    });

    link.activate({ metaKey: false, ctrlKey: false } as MouseEvent, link.text);
    await vi.waitFor(() => expect(actionService.dispatch).toHaveBeenCalled());
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      { worktreeId: root, revealPath: "src/utils", revealKind: "directory" },
      { source: "user" }
    );
  });

  it("drops tokens the filesystem refutes", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    vi.mocked(fileBrowserClient.statPaths).mockResolvedValue([null]);

    const addon = new FileLinksAddon(makeTerminal(["pick one and/or the other"]), () => root);
    expect(await provide(addon)).toBeUndefined();
  });

  it("gives overlapping file matches precedence without any stat", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));

    const addon = new FileLinksAddon(makeTerminal(["see src/App.tsx for details"]), () => root);
    const links = await provide(addon);

    expect(links).toHaveLength(1);
    expect((links![0] as ILink & { kind: string }).kind).toBe("file");
    expect(fileBrowserClient.statPaths).not.toHaveBeenCalled();
  });

  it("ships a file:// link alongside a stat-validated directory on one line", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    vi.mocked(fileBrowserClient.statPaths).mockResolvedValue(["directory"]);

    // The URL resolves synchronously but the directory doesn't, so delivery of
    // both moves behind the deferred validation callback.
    const addon = new FileLinksAddon(
      makeTerminal(["wrote file:///tmp/a.png under src/generated"]),
      () => root
    );
    const links = await provide(addon);

    expect(links).toHaveLength(2);
    expect(links!.map((link) => (link as ILink & { kind: string }).kind)).toEqual([
      "file",
      "directory",
    ]);
    expect((links![0] as ILink & { absolutePath: string }).absolutePath).toBe("/tmp/a.png");
    expect(fileBrowserClient.statPaths).toHaveBeenCalledWith({
      worktreeId: root,
      paths: ["src/generated"],
    });
  });

  it("keeps the file:// link when directory validation fails", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    vi.mocked(fileBrowserClient.statPaths).mockRejectedValue(new Error("view evicted"));

    const addon = new FileLinksAddon(
      makeTerminal(["wrote file:///tmp/a.png under src/generated"]),
      () => root
    );
    const links = await provide(addon);

    expect(links).toHaveLength(1);
    expect((links![0] as ILink & { absolutePath: string }).absolutePath).toBe("/tmp/a.png");
  });

  it("keeps file links when validation fails", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    vi.mocked(fileBrowserClient.statPaths).mockRejectedValue(new Error("view evicted"));

    const addon = new FileLinksAddon(
      makeTerminal(["compare src/App.tsx with src/legacy please"]),
      () => root
    );
    const links = await provide(addon);

    expect(links).toHaveLength(1);
    expect((links![0] as ILink & { kind: string }).kind).toBe("file");
  });

  it("links the worktree root itself without a stat round-trip", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));

    const addon = new FileLinksAddon(makeTerminal([`cd ${root} first`]), () => root);
    const links = await provide(addon);

    expect(links).toHaveLength(1);
    expect((links![0] as ILink & { kind: string }).kind).toBe("directory");
    expect(fileBrowserClient.statPaths).not.toHaveBeenCalled();
  });

  it("drops the whole reply when the line was rewritten mid-validation", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    const stat = pendingStat();

    // The row is rewritten while validation is in flight, so links computed
    // for the old text must not paint on the new.
    const rows = ["output in src/generated now"];
    const addon = new FileLinksAddon(makeTerminal(rows), () => root);
    const callback = vi.fn();
    addon.provideLinks(1, callback);
    await vi.waitFor(() => expect(fileBrowserClient.statPaths).toHaveBeenCalled());
    expect(callback).not.toHaveBeenCalled();
    rows[0] = "completely different text";
    stat.resolve(["directory"]);
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback.mock.calls).toEqual([[undefined]]);
  });

  it("drops the reply when only a wrapped URL's continuation row was rewritten", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    const stat = pendingStat();

    // The hovered row never changes, so the single-row guard sees nothing —
    // only the rejoined window reveals that the URL now names another file.
    const rows = ["src/generated file:///tmp/renders/", "a.png"];
    const addon = new FileLinksAddon(makeTerminal(rows), () => root);
    const callback = vi.fn();
    addon.provideLinks(1, callback);
    await vi.waitFor(() => expect(fileBrowserClient.statPaths).toHaveBeenCalled());
    expect(callback).not.toHaveBeenCalled();
    rows[1] = "b.png";
    stat.resolve(["directory"]);
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback.mock.calls).toEqual([[undefined]]);
  });

  it.each(["resolve", "reject"] as const)(
    "drops the reply on %s when a wrapped bare path's continuation row was rewritten",
    async (outcome) => {
      const root = nextRoot();
      bindWorktrees(new Map([[root, { id: root, path: root }]]));
      const stat = pendingStat();

      // A bare file link can span rows now, so the rejection branch has to run
      // the same staleness checks the success branch does — a reply that only
      // drops its directory links would still paint a file link naming the
      // path the line used to carry.
      // The hovered row carries a token that reads as a whole path on its own,
      // so a reply that skipped the checks would ship a link to `.../a.ts`
      // while the buffer now says something else entirely.
      const rows = ["src/generated holds src/renders/a.ts", "x"];
      const addon = new FileLinksAddon(makeTerminal(rows), () => root);
      const callback = vi.fn();
      addon.provideLinks(1, callback);
      await vi.waitFor(() => expect(fileBrowserClient.statPaths).toHaveBeenCalled());
      expect(callback).not.toHaveBeenCalled();
      rows[1] = "y";
      if (outcome === "resolve") stat.resolve(["directory"]);
      else stat.reject(new Error("view evicted"));
      await vi.waitFor(() => expect(callback).toHaveBeenCalled());
      expect(callback.mock.calls).toEqual([[undefined]]);
    }
  );

  it("drops the reply when a re-wrap moves a row boundary without changing text", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    const stat = pendingStat();

    // Same hovered row, same rejoined string, different split. Every buffer
    // coordinate a multi-row link carries comes from the row offsets, so
    // comparing text alone would ship a range underlining the wrong cells.
    const rows = ["src/generated holds src/", "renders", "/a.png"];
    const addon = new FileLinksAddon(makeTerminal(rows), () => root);
    const callback = vi.fn();
    addon.provideLinks(1, callback);
    await vi.waitFor(() => expect(fileBrowserClient.statPaths).toHaveBeenCalled());
    expect(callback).not.toHaveBeenCalled();
    rows[1] = "render";
    rows[2] = "s/a.png";
    stat.resolve(["directory"]);
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback.mock.calls).toEqual([[undefined]]);
  });

  it("shields a continuation fragment the file pass owns but cannot resolve", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));

    // With no cwd the rejoined relative token resolves to nothing, but its
    // continuation row still reads as an absolute directory on its own. The
    // file pass claims every span it matches, resolved or not, so the looser
    // directory pass can't come back with a link to a path the line never
    // named.
    const addon = new FileLinksAddon(
      makeTerminal(["open relative", `${root}/existing.ts`]),
      () => ""
    );

    expect(await provide(addon, 2)).toBeUndefined();
    expect(fileBrowserClient.statPaths).not.toHaveBeenCalled();
  });

  it("never validates the head of a path an app hard-wrapped as a directory", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    vi.mocked(fileBrowserClient.statPaths).mockResolvedValue(["directory"]);

    // Cut at the margin and resumed under an indent (#12449). On its own the
    // head is a real directory and would validate, but it's only the first
    // half of the file path the line names.
    const head = `open ${root}/src/components`;
    const addon = new FileLinksAddon(
      makeGrid([head, "  /Button.tsx now"], head.length),
      () => root
    );
    const links = await provide(addon);

    expect(links).toHaveLength(1);
    const link = links![0]! as ILink & { kind: string; absolutePath: string };
    expect(link.kind).toBe("file");
    expect(link.absolutePath).toBe(`${root}/src/components/Button.tsx`);
    expect(fileBrowserClient.statPaths).not.toHaveBeenCalled();
  });

  it("drops the reply when a hard-wrapped continuation row was rewritten", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    const stat = pendingStat();

    // The hovered row never changes; only the app's continuation of its
    // path does, so the reply would link a file the buffer no longer names.
    const rows = ["src/generated at /tmp/shots/abcdefghij", "  klmnopqrstuv.png ok"];
    const addon = new FileLinksAddon(makeGrid(rows, rows[0]!.length), () => root);
    const callback = vi.fn();
    addon.provideLinks(1, callback);
    await vi.waitFor(() => expect(fileBrowserClient.statPaths).toHaveBeenCalled());
    expect(callback).not.toHaveBeenCalled();
    rows[1] = "  klmnopqrstuw.png ok";
    stat.resolve(["directory"]);
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback.mock.calls).toEqual([[undefined]]);
  });

  it("stays silent after disposal", async () => {
    const root = nextRoot();
    bindWorktrees(new Map([[root, { id: root, path: root }]]));
    let release: (value: Array<"directory" | "file" | null>) => void = () => {};
    vi.mocked(fileBrowserClient.statPaths).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const addon = new FileLinksAddon(makeTerminal(["look in src/deep here"]), () => root);
    const callback = vi.fn();
    addon.provideLinks(1, callback);
    addon.dispose();
    release(["directory"]);
    // Give the deferred reply a tick to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callback).not.toHaveBeenCalled();
  });
});

// An unquoted space may sit in a directory name or between two tokens, so a
// spaced path is only linked once its parent directory is probed (#13136).
describe("FileLinksAddon paths containing spaces", () => {
  // The probe memo is module-level, so every test uses its own home directory.
  let homeCounter = 0;
  const nextHome = (): string => `/Users/u${++homeCounter}`;
  const existingDirs = (...dirs: string[]): void => {
    vi.mocked(systemClient.checkDirectory).mockImplementation(async (dir) => dirs.includes(dir));
  };
  const texts = (links: ILink[] | undefined): string[] => (links ?? []).map((link) => link.text);
  const absolutePath = (link: ILink | undefined): unknown =>
    link && "absolutePath" in link ? link.absolutePath : undefined;
  const flat = (rows: string[]): Terminal =>
    makeTerminal(
      rows,
      rows.map(() => false)
    );

  beforeEach(() => {
    vi.mocked(systemClient.checkDirectory).mockReset();
    bindWorktrees(new Map());
  });

  it("links the whole unquoted path once its parent directory is confirmed", async () => {
    const home = nextHome();
    const dir = `${home}/Library/Application Support/Daintree/assistant-scratch/a1/b2`;
    const path = `${dir}/issue-body.md`;
    existingDirs(dir);

    const links = await provide(new FileLinksAddon(flat([path]), () => "/repo"));

    expect(texts(links)).toEqual([path]);
    expect(absolutePath(links?.[0])).toBe(path);
    expect(links![0]!.range).toEqual({ start: { x: 1, y: 1 }, end: { x: path.length, y: 1 } });
    expect(systemClient.checkDirectory).toHaveBeenCalledWith(dir);
  });

  it("falls back to the space-free links when no length checks out", async () => {
    const home = nextHome();
    existingDirs();

    const links = await provide(
      new FileLinksAddon(flat([`node ${home}/bin/tool src/a.ts`]), () => "/repo")
    );

    expect(texts(links)).toEqual(["src/a.ts"]);
    expect(absolutePath(links?.[0])).toBe("/repo/src/a.ts");
  });

  it("never links the tail fragment once the full path is confirmed", async () => {
    const home = nextHome();
    existingDirs(`${home}/Application Support`);

    const links = await provide(
      new FileLinksAddon(flat([`see ${home}/Application Support/x.md`]), () => "/repo")
    );

    expect(texts(links)).toEqual([`${home}/Application Support/x.md`]);
  });

  it("keeps the longest confirmed length and the bare links past it", async () => {
    const home = nextHome();
    existingDirs(`${home}/a b`);

    const links = await provide(
      new FileLinksAddon(flat([`${home}/a b/c.md and d/e.md`]), () => "/repo")
    );

    expect(texts(links).sort()).toEqual([`${home}/a b/c.md`, "d/e.md"].sort());
  });

  it("carries a :line:col suffix through to the link", async () => {
    const home = nextHome();
    existingDirs(`${home}/a b`);

    const links = await provide(new FileLinksAddon(flat([`${home}/a b/c.ts:42:7`]), () => "/repo"));

    expect(texts(links)).toEqual([`${home}/a b/c.ts:42:7`]);
    expect(absolutePath(links?.[0])).toBe(`${home}/a b/c.ts`);
  });

  it("falls back when the probe fails", async () => {
    const home = nextHome();
    vi.mocked(systemClient.checkDirectory).mockRejectedValue(new Error("ipc down"));

    const links = await provide(
      new FileLinksAddon(flat([`${home}/Application Support/x.md`]), () => "/repo")
    );

    expect(texts(links)).toEqual(["Support/x.md"]);
  });

  it("links a quoted path without probing", async () => {
    const home = nextHome();
    const path = `${home}/Library/Application Support/x.md`;

    const links = await provide(new FileLinksAddon(flat([`wrote "${path}"`]), () => "/repo"));

    expect(texts(links)).toEqual([path]);
    expect(absolutePath(links?.[0])).toBe(path);
    expect(links![0]!.range.start.x).toBe(8);
    expect(systemClient.checkDirectory).not.toHaveBeenCalled();
  });

  it("links a shell-escaped path without probing and decodes the space", async () => {
    const home = nextHome();
    const raw = `${home}/Application\\ Support/x.md`;

    const links = await provide(new FileLinksAddon(flat([`cat ${raw}`]), () => "/repo"));

    expect(texts(links)).toEqual([raw]);
    expect(absolutePath(links?.[0])).toBe(`${home}/Application Support/x.md`);
    expect(systemClient.checkDirectory).not.toHaveBeenCalled();
  });

  it("links a spaced path that soft-wraps across rows from either row", async () => {
    const home = nextHome();
    const path = `${home}/Library/Application Support/Daintree/notes.md`;
    existingDirs(`${home}/Library/Application Support/Daintree`);
    const split = 20;
    const rows = [path.slice(0, split), path.slice(split)];

    for (const row of [1, 2]) {
      const links = await provide(
        new FileLinksAddon(makeTerminal(rows, [false, true]), () => "/repo"),
        row
      );
      expect(texts(links)).toEqual([path]);
      expect(links![0]!.range).toEqual({
        start: { x: 1, y: 1 },
        end: { x: path.length - split, y: 2 },
      });
    }
  });

  it("answers synchronously when a line holds no spaced candidate", () => {
    const callback = vi.fn();
    new FileLinksAddon(flat(["error in src/a.ts:3"]), () => "/repo").provideLinks(1, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(systemClient.checkDirectory).not.toHaveBeenCalled();
  });
});
