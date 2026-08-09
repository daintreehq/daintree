import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const copyMock = vi.hoisted(() => vi.fn());
const copyStreamMock = vi.hoisted(() => vi.fn());
const configCreateMock = vi.hoisted(() => vi.fn());

vi.mock("copytree", () => ({
  copy: copyMock,
  copyStream: copyStreamMock,
  ConfigManager: {
    create: configCreateMock,
  },
}));

import { copyTreeService, _resetConfigCacheForTests } from "../CopyTreeService.js";

const STATS = {
  totalFiles: 3,
  totalSize: 4096,
  duration: 12,
  estimatedOutputChars: 400,
  estimatedTokens: 100,
  noFilesMatched: false,
  excluded: { total: 0, byReason: {} },
};

type StreamOptions = {
  signal?: AbortSignal;
  onComplete?: (result: {
    outputFormatVersion: string | null;
    manifest: unknown[];
    stats: typeof STATS;
  }) => void;
};

/**
 * Stand in for the SDK generator: yield the given chunks, then report
 * completion exactly as `copyStream` does — only on a run that finished.
 */
function streamYielding(
  chunks: string[],
  options: { complete?: boolean; stats?: typeof STATS } = {}
) {
  return (_rootPath: string, streamOptions: StreamOptions) =>
    (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
      if (options.complete !== false) {
        streamOptions.onComplete?.({
          outputFormatVersion: "copytree-xml@1",
          manifest: [],
          stats: options.stats ?? STATS,
        });
      }
    })();
}

describe("CopyTreeService streaming to a file", () => {
  let tempDir: string;
  let outputPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-copytree-stream-"));
    outputPath = path.join(tempDir, "bundle.xml");
    vi.clearAllMocks();
    _resetConfigCacheForTests();
    configCreateMock.mockResolvedValue({ isDefaultsLoaded: true });
  });

  afterEach(async () => {
    copyTreeService.cancelAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Files this run left in the output directory, so leftovers are visible. */
  async function residue(): Promise<string[]> {
    return (await fs.readdir(tempDir)).sort();
  }

  it("streams the whole document to the file and keeps it out of the result", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files>", "<file/>", "</files>"]));

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.error).toBeUndefined();
    expect(result.filePath).toBe(outputPath);
    // The point of the change: the bundle went to disk, not into the result.
    expect(result.content).toBe("");
    expect(await fs.readFile(outputPath, "utf8")).toBe("<files><file/></files>");
    expect(copyMock).not.toHaveBeenCalled();
  });

  it("reports the byte size the file actually has", async () => {
    // Multi-byte on purpose: a character count would disagree with the file.
    copyStreamMock.mockImplementation(streamYielding(["héllo ", "☃", "😀"]));

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.outputBytes).toBe((await fs.stat(outputPath)).size);
    expect(await fs.readFile(outputPath, "utf8")).toBe("héllo ☃😀");
  });

  it("carries the completion stats through unchanged", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.fileCount).toBe(STATS.totalFiles);
    expect(result.outputFormatVersion).toBe("copytree-xml@1");
    expect(result.stats).toMatchObject({
      totalSize: STATS.totalSize,
      duration: STATS.duration,
      estimatedTokens: STATS.estimatedTokens,
    });
  });

  // This is the branch production actually takes: the IPC handler passes an
  // output path, so `copyTree.generate` and `copyTree.generateAndCopyFile` both
  // land here rather than in the buffered `copy()` path. A selector captured in
  // `generate()` and not threaded this far would leave two of the three
  // advertised MCP actions without the hint (#11731).
  it("attributes an empty streamed bundle to the selector that emptied it", async () => {
    copyStreamMock.mockImplementation(
      streamYielding(["<files/>"], {
        stats: {
          ...STATS,
          totalFiles: 0,
          noFilesMatched: true,
          excluded: { total: 4, byReason: { filterPattern: 4 } },
        },
      })
    );

    const result = await copyTreeService.generate(
      tempDir,
      { includePaths: ["src/panels"], filter: "docs" },
      undefined,
      "op-1",
      outputPath
    );

    // Both spellings were supplied and neither can be singled out once they are
    // unioned, so the pair is what the caller gets.
    expect(result.stats?.unmatchedSelector).toBe("filterAndIncludePaths");
  });

  it("leaves a streamed bundle that found files unattributed", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    const result = await copyTreeService.generate(
      tempDir,
      { includePaths: ["src/**"] },
      undefined,
      "op-1",
      outputPath
    );

    expect(result.stats?.unmatchedSelector).toBeUndefined();
  });

  it("publishes atomically, leaving no partial behind", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(await residue()).toEqual(["bundle.xml"]);
  });

  it("writes the bundle owner-only", async () => {
    if (process.platform === "win32") return;
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it("leaves nothing on disk when the source fails midway", async () => {
    copyStreamMock.mockImplementation(() =>
      (async function* () {
        yield "<files>";
        throw new Error("scan blew up");
      })()
    );

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.error).toBe("Failed to generate context");
    // Neither the destination nor the partial survives — a caller that finds
    // the final path must never find a prefix of a bundle.
    expect(await residue()).toEqual([]);
  });

  it("refuses to publish a run that never reported completion", async () => {
    // `onComplete` fires only on normal completion, so its absence means the
    // source stopped early and the bytes on disk are a prefix.
    copyStreamMock.mockImplementation(
      streamYielding(["<files>", "truncated"], { complete: false })
    );

    const result = await copyTreeService.generate(tempDir, {}, undefined, "op-1", outputPath);

    expect(result.error).toBe("Context generation ended before it finished");
    expect(await residue()).toEqual([]);
  });

  it("cleans up both files when the run is cancelled mid-stream", async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let markStarted: () => void = () => {};
    // Resolved from inside the generator: by then the operation is registered
    // and the first chunk is on its way to the writer, which is the only point
    // at which a cancel is actually testing mid-stream teardown.
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    copyStreamMock.mockImplementation((_rootPath: string, streamOptions: StreamOptions) =>
      (async function* () {
        yield "<files>";
        markStarted();
        await gate;
        if (streamOptions.signal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        yield "</files>";
      })()
    );

    const pending = copyTreeService.generate(tempDir, {}, undefined, "op-cancel", outputPath);
    await started;
    expect(copyTreeService.cancel("op-cancel")).toBe(true);
    releaseGate();

    const result = await pending;

    expect(result.error).toBe("Context generation cancelled");
    expect(await residue()).toEqual([]);
  });

  it("does not touch the file when no output path is given", async () => {
    copyMock.mockResolvedValue({
      output: "<context />",
      outputFormatVersion: "copytree-xml@1",
      manifest: [],
      stats: STATS,
    });

    const result = await copyTreeService.generate(tempDir);

    expect(result.content).toBe("<context />");
    expect(result.filePath).toBeUndefined();
    expect(result.outputBytes).toBeUndefined();
    expect(copyStreamMock).not.toHaveBeenCalled();
  });

  it("hands the streamed run the same options the copy() run would get", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    await copyTreeService.generate(
      tempDir,
      { format: "markdown", charLimit: 1000, maxFileCount: 5 },
      undefined,
      "op-1",
      outputPath
    );

    const streamOptions = copyStreamMock.mock.calls[0][1];
    expect(streamOptions).toMatchObject({
      format: "markdown",
      charLimit: 1000,
      maxFileCount: 5,
      respectGitignore: true,
      secretsGuard: false,
    });
    // Cancellation still has to reach the SDK, not just the pipeline.
    expect(streamOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("names the output file as the problem when the destination can't be created", async () => {
    copyStreamMock.mockImplementation(streamYielding(["<files/>"]));

    const result = await copyTreeService.generate(
      tempDir,
      {},
      undefined,
      "op-1",
      path.join(tempDir, "missing-dir", "bundle.xml")
    );

    // The raw ENOENT would map to "Project path is unavailable", which points
    // at the project being read rather than the file being written.
    expect(result.error).toBe("Can't write the context file");
    expect(result.filePath).toBeUndefined();
    // Nothing was generated, so the SDK should never have been started.
    expect(copyStreamMock).not.toHaveBeenCalled();
  });
});
