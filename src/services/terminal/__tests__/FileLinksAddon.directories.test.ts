import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Terminal, IBufferLine, ILink } from "@xterm/xterm";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/clients", () => ({
  systemClient: { openPath: vi.fn(), openInEditor: vi.fn(), showItemInFolderUnconfined: vi.fn() },
}));
vi.mock("@/clients/fileBrowserClient", () => ({ fileBrowserClient: { statPaths: vi.fn() } }));
vi.mock("@/store/createWorktreeStore", () => ({ getCurrentViewStoreOrNull: vi.fn() }));

import { FileLinksAddon } from "../FileLinksAddon";
import { fileBrowserClient } from "@/clients/fileBrowserClient";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { actionService } from "@/services/ActionService";

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

function makeTerminal(lines: string[]): Terminal {
  let call = 0;
  return {
    buffer: {
      active: {
        getLine: vi.fn((): IBufferLine => {
          const text = lines[Math.min(call, lines.length - 1)]!;
          call += 1;
          return { translateToString: () => text } as IBufferLine;
        }),
      },
    },
  } as unknown as Terminal;
}

function provide(addon: FileLinksAddon): Promise<ILink[] | undefined> {
  return new Promise((resolve) => {
    addon.provideLinks(1, resolve);
  });
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
    vi.mocked(fileBrowserClient.statPaths).mockResolvedValue(["directory"]);

    // First read (provideLinks) sees the token; the post-validation re-read
    // sees different text, so the stale reply must be discarded.
    const addon = new FileLinksAddon(
      makeTerminal(["output in src/generated now", "completely different text"]),
      () => root
    );
    expect(await provide(addon)).toBeUndefined();
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
