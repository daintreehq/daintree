import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue({ uiFeedbackSoundEnabled: false }) },
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

vi.mock("../../../services/PreAgentSnapshotService.js", () => ({
  preAgentSnapshotService: {
    getSnapshot: vi.fn(),
    listSnapshots: vi.fn(),
    revertToSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
  },
}));

const createHardenedGitMock = vi.hoisted(() => vi.fn());

vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: createHardenedGitMock,
  createAuthenticatedGit: vi.fn(),
}));

import { registerGitWriteHandlers, scanStagedFilesForConflictMarkers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";

type FakeStatusFile = { path: string; index: string; working_dir: string };
type FakeGit = {
  status: ReturnType<typeof vi.fn>;
  diff: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
};

function makeFakeGit(overrides: Partial<FakeGit> = {}): FakeGit {
  return {
    status: vi.fn().mockResolvedValue({ files: [] as FakeStatusFile[] }),
    diff: vi.fn().mockResolvedValue(""),
    show: vi.fn().mockResolvedValue(""),
    commit: vi.fn().mockResolvedValue({
      commit: "abc123",
      summary: { changes: 1, insertions: 1, deletions: 0 },
    }),
    ...overrides,
  };
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => unknown;
}

function stagedFile(path: string, index = "M"): FakeStatusFile {
  return { path, index, working_dir: " " };
}

describe("scanStagedFilesForConflictMarkers", () => {
  it("passes through a clean staged file", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("src/foo.ts")] }),
      show: vi.fn().mockResolvedValue("export const foo = 1;\n"),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).resolves.toBeUndefined();
    expect(git.show).toHaveBeenCalledWith([":src/foo.ts"]);
  });

  it("throws when a staged file contains <<<<<<< markers", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("src/foo.ts")] }),
      show: vi
        .fn()
        .mockResolvedValue("line1\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n"),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).rejects.toThrow(
      /Unresolved conflict markers found in src\/foo\.ts/
    );
  });

  it.each([
    ["<<<<<<< HEAD", "start"],
    ["||||||| merged common ancestors", "ancestor"],
    ["=======", "middle"],
    [">>>>>>> branch", "end"],
  ])("throws for the %s marker line", async (markerLine) => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("f.txt")] }),
      show: vi.fn().mockResolvedValue(`head\n${markerLine}\ntail\n`),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).rejects.toThrow(
      /Unresolved conflict markers/
    );
  });

  it("does not block when markers are mid-line (line-anchored regex)", async () => {
    // An indented `=======` should not trip the scan; ensures the `^` anchor
    // in CONFLICT_MARKER_RE is doing its job.
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("doc.md")] }),
      show: vi.fn().mockResolvedValue("  =======\ninline <<<<<<< text\n"),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).resolves.toBeUndefined();
  });

  it("skips deleted staged entries without calling git.show", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("gone.ts", "D")] }),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).resolves.toBeUndefined();
    expect(git.show).not.toHaveBeenCalled();
    expect(git.diff).not.toHaveBeenCalled();
  });

  it("skips binary files reported by numstat", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("image.png")] }),
      diff: vi.fn().mockResolvedValue("-\t-\timage.png\n"),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).resolves.toBeUndefined();
    expect(git.show).not.toHaveBeenCalled();
  });

  it("skips files over the 1 MB cap", async () => {
    const huge = "a".repeat(1_000_001);
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("big.txt")] }),
      show: vi.fn().mockResolvedValue(huge),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).resolves.toBeUndefined();
  });

  it("short-circuits when there are no staged files", async () => {
    const git = makeFakeGit();
    await expect(scanStagedFilesForConflictMarkers(git as never)).resolves.toBeUndefined();
    expect(git.diff).not.toHaveBeenCalled();
    expect(git.show).not.toHaveBeenCalled();
  });

  it("uses --no-ext-diff for the numstat probe", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("a.ts")] }),
      show: vi.fn().mockResolvedValue("ok\n"),
    });
    await scanStagedFilesForConflictMarkers(git as never);
    expect(git.diff).toHaveBeenCalledWith(["--no-ext-diff", "--cached", "--numstat"]);
  });

  it("stops on the first offending file and identifies it", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({
        files: [stagedFile("clean.ts"), stagedFile("bad.ts"), stagedFile("other.ts")],
      }),
      show: vi.fn(async (args: string[]) => {
        if (args[0] === ":bad.ts") return "<<<<<<< HEAD\n";
        return "clean content\n";
      }),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).rejects.toThrow(
      /Unresolved conflict markers found in bad\.ts/
    );
    expect(git.show).not.toHaveBeenCalledWith([":other.ts"]);
  });

  it("blocks a first-line marker that follows a UTF-8 BOM", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("bom.txt")] }),
      show: vi.fn().mockResolvedValue("\uFEFF<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n"),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).rejects.toThrow(
      /Unresolved conflict markers found in bom\.txt/
    );
  });

  it("blocks when content is exactly at the 1 MB byte cap", async () => {
    // Exactly STAGED_FILE_SIZE_CAP bytes (cap boundary) with the marker on
    // its own line. `>` not `>=` means this must still be scanned.
    const markerLine = "<<<<<<< HEAD\n";
    const content = markerLine + "a".repeat(1_000_000 - markerLine.length);
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("edge.txt")] }),
      show: vi.fn().mockResolvedValue(content),
    });
    expect(Buffer.byteLength(content, "utf8")).toBe(1_000_000);
    await expect(scanStagedFilesForConflictMarkers(git as never)).rejects.toThrow(
      /Unresolved conflict markers/
    );
  });

  it("skips content 1 byte over the cap", async () => {
    // `>` not `>=` check: 1_000_001 bytes → skip silently, commit proceeds.
    const content = "<<<<<<< HEAD\n" + "a".repeat(1_000_001 - "<<<<<<< HEAD\n".length);
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("huge.txt")] }),
      show: vi.fn().mockResolvedValue(content),
    });
    expect(Buffer.byteLength(content, "utf8")).toBe(1_000_001);
    await expect(scanStagedFilesForConflictMarkers(git as never)).resolves.toBeUndefined();
  });

  it("propagates git.show rejections (does not silently permit)", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("src/foo.ts")] }),
      show: vi.fn().mockRejectedValue(new Error("fatal: bad revision")),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).rejects.toThrow(/bad revision/);
  });

  it("handles paths with spaces", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("dir/merge notes.ts")] }),
      show: vi.fn().mockResolvedValue("<<<<<<< HEAD\n"),
    });
    await expect(scanStagedFilesForConflictMarkers(git as never)).rejects.toThrow(
      /Unresolved conflict markers found in dir\/merge notes\.ts/
    );
    expect(git.show).toHaveBeenCalledWith([":dir/merge notes.ts"]);
  });
});

describe("git:commit handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
  });

  it("invokes git.commit when staged content is clean", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("src/foo.ts")] }),
      show: vi.fn().mockResolvedValue("clean\n"),
    });
    createHardenedGitMock.mockReturnValue(git);
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:commit");

    const result = await handler(null, { cwd: "/tmp/repo", message: "feat: add foo" });
    expect(git.commit).toHaveBeenCalledWith("feat: add foo");
    expect(result).toEqual({
      hash: "abc123",
      summary: "1 changed, 1 insertions(+), 0 deletions(-)",
    });
  });

  it("blocks the commit when a staged file carries conflict markers", async () => {
    const git = makeFakeGit({
      status: vi.fn().mockResolvedValue({ files: [stagedFile("src/foo.ts")] }),
      show: vi.fn().mockResolvedValue("<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n"),
    });
    createHardenedGitMock.mockReturnValue(git);
    registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
    const handler = getHandler("git:commit");

    await expect(handler(null, { cwd: "/tmp/repo", message: "feat: add foo" })).rejects.toThrow(
      /Unresolved conflict markers found in src\/foo\.ts/
    );
    expect(git.commit).not.toHaveBeenCalled();
  });
});
