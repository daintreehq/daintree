import { describe, expect, it, vi } from "vitest";
import type {
  FileTransferEvent,
  FolderUploadSummary,
  LocalFileStat,
  LocalFolderSummaryResult,
  TransferDestination,
  UploadLocalFolderResult,
  UploadResult,
} from "@shared/types/ipc/fileTransfer";
import { UPLOAD_CONFIRM_BYTES, UPLOAD_REFUSE_BYTES } from "@shared/types/remoteHosts";
import { createRemoteMaterializer, type RemoteMaterializerDeps } from "../remoteMaterializer";

const REPLACE_TOKEN = "0123456789abcdef0123456789abcdef";
const HANDLE = "fedcba9876543210fedcba9876543210";

function folderSummary(rootName: string): FolderUploadSummary {
  return {
    rootName,
    totals: { fileCount: 2, folderCount: 1, totalBytes: 30 },
    lowerBound: false,
    hidden: { fileCount: 0, folderCount: 0, totalBytes: 0, paths: [] },
    largest: [],
    notCopied: { count: 0, items: [] },
  };
}

function setup(overrides: Partial<RemoteMaterializerDeps> = {}) {
  const listeners = new Set<(event: FileTransferEvent) => void>();
  const emit = (event: FileTransferEvent) => {
    for (const listener of listeners) listener(event);
  };
  const fileTransfer = {
    statLocalFile: vi.fn(async (): Promise<LocalFileStat | null> => ({
      size: 10,
      isDirectory: false,
    })),
    uploadLocalFile: vi.fn(
      async (payload: {
        opId: string;
        localPath: string;
        destination: TransferDestination;
      }): Promise<UploadResult> => {
        emit({ type: "progress", opId: payload.opId, transferredBytes: 5, totalBytes: 10 });
        return {
          hostPath: `/tmp/daintree-inbox/files/x/${payload.localPath.split("/").pop()}`,
          bytes: 10,
          deduplicated: false,
        };
      }
    ),
    uploadBytes: vi.fn(async (): Promise<UploadResult> => ({
      hostPath: "/tmp/daintree-inbox/files/x/shot.png",
      bytes: 3,
      deduplicated: false,
    })),
    summarizeLocalFolder: vi.fn(
      async (payload: { localPath: string; opId: string }): Promise<LocalFolderSummaryResult> => ({
        status: "ready",
        summary: folderSummary(payload.localPath.split("/").pop()!),
        handle: HANDLE,
      })
    ),
    uploadLocalFolder: vi.fn(
      async (payload: { opId: string; handle: string }): Promise<UploadLocalFolderResult> => {
        emit({
          type: "folder-progress",
          opId: payload.opId,
          phase: "packing",
          filesDone: 1,
          filesTotal: 2,
          transferredBytes: 10,
          totalBytes: 30,
        });
        return {
          status: "sent",
          hostPath: "/tmp/daintree-inbox/files/x/designs",
          totals: { fileCount: 2, folderCount: 1, totalBytes: 30 },
        };
      }
    ),
    cancel: vi.fn(async () => {}),
    onEvent: (callback: (event: FileTransferEvent) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  const deps: RemoteMaterializerDeps = {
    hostId: "studio-01",
    hostLabel: () => "studio-01",
    localLabel: "This Mac",
    fileTransfer,
    saveClipboardImage: vi.fn(async () => ({
      filePath: "/tmp/daintree-inbox/clipboard/clipboard-1.png",
      thumbnailDataUrl: "data:image/png;base64,AA",
    })),
    confirmLargeUpload: vi.fn(async () => true),
    confirmReplace: vi.fn(async () => true),
    confirmFolder: vi.fn(async () => true),
    addToProjectKey: "Option",
    reportFailure: vi.fn(),
    mintOperationId: () => "op-1",
    ...overrides,
  };
  return { materialize: createRemoteMaterializer(deps), deps, fileTransfer, emit };
}

describe("remote materialize", () => {
  it("uploads a local file into the host inbox and reports progress", async () => {
    const { materialize, fileTransfer } = setup();
    const onProgress = vi.fn();
    const result = await materialize(
      { kind: "local-file", path: "/Users/me/invoice.pdf" },
      { onProgress }
    );
    expect(result).toEqual({
      hostPath: "/tmp/daintree-inbox/files/x/invoice.pdf",
      displayName: "invoice.pdf",
      bytes: 10,
    });
    expect(fileTransfer.uploadLocalFile).toHaveBeenCalledWith({
      hostId: "studio-01",
      localPath: "/Users/me/invoice.pdf",
      destination: { kind: "inbox", bucket: "files" },
      opId: "op-1",
    });
    expect(onProgress).toHaveBeenCalledWith(0.5);
  });

  it("passes a path from this window's own host straight through", async () => {
    const { materialize, fileTransfer } = setup();
    const result = await materialize({
      kind: "host-file",
      path: "/srv/proj/src/a.ts",
      hostId: "studio-01",
    });
    expect(result.hostPath).toBe("/srv/proj/src/a.ts");
    expect(fileTransfer.uploadLocalFile).not.toHaveBeenCalled();
  });

  it("refuses a file from another host, naming both", async () => {
    const { materialize, deps } = setup();
    await expect(
      materialize({ kind: "host-file", path: "/srv/a.ts", hostId: "studio-02" })
    ).rejects.toThrow("That file is on studio-02; this window is studio-01.");
    expect(deps.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "That file is on studio-02; this window is studio-01." })
    );
  });

  it("asks before sending a file over the confirm size, and sends nothing on no", async () => {
    const confirmLargeUpload = vi.fn(async () => false);
    const { materialize, fileTransfer, deps } = setup({ confirmLargeUpload });
    fileTransfer.statLocalFile.mockResolvedValueOnce({
      size: UPLOAD_CONFIRM_BYTES + 1,
      isDirectory: false,
    });
    await expect(
      materialize({ kind: "local-file", path: "/Users/me/big.mov" })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(confirmLargeUpload).toHaveBeenCalledWith({
      name: "big.mov",
      bytes: UPLOAD_CONFIRM_BYTES + 1,
      hostLabel: "studio-01",
    });
    expect(fileTransfer.uploadLocalFile).not.toHaveBeenCalled();
    expect(deps.reportFailure).not.toHaveBeenCalled();
  });

  it("refuses a file over the hard cap without asking", async () => {
    const { materialize, fileTransfer, deps } = setup();
    fileTransfer.statLocalFile.mockResolvedValueOnce({
      size: UPLOAD_REFUSE_BYTES + 1,
      isDirectory: false,
    });
    await expect(
      materialize({ kind: "local-file", path: "/Users/me/huge.iso" })
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(deps.confirmLargeUpload).not.toHaveBeenCalled();
    expect(fileTransfer.uploadLocalFile).not.toHaveBeenCalled();
    expect(deps.reportFailure).toHaveBeenCalled();
  });

  it("names this machine when the local file can't be read", async () => {
    const { materialize, fileTransfer, deps } = setup();
    fileTransfer.statLocalFile.mockResolvedValueOnce(null);
    await expect(
      materialize({ kind: "local-file", path: "/Users/me/invoice.pdf" })
    ).rejects.toThrow("Couldn't read invoice.pdf on This Mac.");
    expect(deps.reportFailure).toHaveBeenCalledWith({
      title: "Couldn't send invoice.pdf",
      message: "Couldn't read invoice.pdf on This Mac.",
      code: "INVALID_PATH",
    });
  });

  it("reports the host's own message for a failed upload", async () => {
    const { materialize, fileTransfer, deps } = setup();
    fileTransfer.uploadLocalFile.mockRejectedValueOnce(
      // The shape the bridge leaves: no properties, the code in the message.
      new Error(
        `[AppError|PAYLOAD_TOO_LARGE|${encodeURIComponent("studio-01 is out of disk space.")}] upload failed`
      )
    );
    await expect(materialize({ kind: "local-file", path: "/Users/me/a.txt" })).rejects.toThrow();
    expect(deps.reportFailure).toHaveBeenCalledWith({
      title: "Couldn't send a.txt",
      message: "studio-01 is out of disk space.",
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("stays silent for a wire-encoded cancellation", async () => {
    const { materialize, fileTransfer, deps } = setup();
    fileTransfer.uploadLocalFile.mockRejectedValueOnce(new Error("[AppError|CANCELLED] cancelled"));
    await expect(materialize({ kind: "local-file", path: "/Users/me/a.txt" })).rejects.toThrow();
    expect(deps.reportFailure).not.toHaveBeenCalled();
  });

  it("cancels the upload by its operation id when the signal aborts", async () => {
    const { materialize, fileTransfer, deps } = setup();
    let reject!: (error: Error) => void;
    fileTransfer.uploadLocalFile.mockImplementationOnce(
      () => new Promise<UploadResult>((_resolve, fail) => (reject = fail))
    );
    const controller = new AbortController();
    const pending = materialize(
      { kind: "local-file", path: "/Users/me/a.txt" },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(fileTransfer.uploadLocalFile).toHaveBeenCalled());
    controller.abort();
    expect(fileTransfer.cancel).toHaveBeenCalledWith({ opId: "op-1" });
    reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(deps.reportFailure).not.toHaveBeenCalled();
  });

  it("uploads into a worktree folder for Add to project, asking before replacing", async () => {
    const confirmReplace = vi.fn(async () => true);
    const { materialize, fileTransfer } = setup({ confirmReplace });
    fileTransfer.uploadLocalFile
      .mockResolvedValueOnce({
        hostPath: "/srv/proj/docs/spec.md",
        bytes: 0,
        deduplicated: false,
        conflict: true,
        replaceToken: REPLACE_TOKEN,
      })
      .mockResolvedValueOnce({
        hostPath: "/srv/proj/docs/spec.md",
        bytes: 10,
        deduplicated: false,
      });
    const result = await materialize(
      { kind: "local-file", path: "/Users/me/spec.md" },
      { destination: { kind: "worktree", directory: "/srv/proj/docs" } }
    );
    expect(confirmReplace).toHaveBeenCalledWith({
      name: "spec.md",
      folder: "/srv/proj/docs",
      hostLabel: "studio-01",
    });
    expect(fileTransfer.uploadLocalFile.mock.calls.map(([payload]) => payload.destination)).toEqual(
      [
        { kind: "worktree", directory: "/srv/proj/docs" },
        { kind: "worktree", directory: "/srv/proj/docs", replaceToken: REPLACE_TOKEN },
      ]
    );
    expect(result.hostPath).toBe("/srv/proj/docs/spec.md");
  });

  it("keeps the existing file when the user declines to replace it", async () => {
    const { materialize, fileTransfer } = setup({ confirmReplace: vi.fn(async () => false) });
    fileTransfer.uploadLocalFile.mockResolvedValueOnce({
      hostPath: "/srv/proj/spec.md",
      bytes: 0,
      deduplicated: false,
      conflict: true,
      replaceToken: REPLACE_TOKEN,
    });
    await expect(
      materialize(
        { kind: "local-file", path: "/Users/me/spec.md" },
        { destination: { kind: "worktree", directory: "/srv/proj" } }
      )
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fileTransfer.uploadLocalFile).toHaveBeenCalledTimes(1);
  });

  it("uploads a pasted image through the clipboard split, with its local thumbnail", async () => {
    const { materialize } = setup();
    await expect(materialize({ kind: "clipboard-image" })).resolves.toEqual({
      hostPath: "/tmp/daintree-inbox/clipboard/clipboard-1.png",
      displayName: "clipboard-1.png",
      bytes: null,
      thumbnail: "data:image/png;base64,AA",
    });
  });

  it("follows a pasted image's upload by its operation id and cancels it there", async () => {
    let finish!: () => void;
    const saveClipboardImage = vi.fn(
      (options: { opId: string }) =>
        new Promise<{ filePath: string; thumbnailDataUrl: string }>((resolve) => {
          void options;
          finish = () =>
            resolve({
              filePath: "/tmp/daintree-inbox/clipboard/clipboard-1.png",
              thumbnailDataUrl: "data:image/png;base64,AA",
            });
        })
    );
    const { materialize, deps, fileTransfer, emit } = setup({ saveClipboardImage });
    const controller = new AbortController();
    const onProgress = vi.fn();
    const pending = materialize(
      { kind: "clipboard-image" },
      { onProgress, signal: controller.signal }
    );
    await vi.waitFor(() => expect(saveClipboardImage).toHaveBeenCalledWith({ opId: "op-1" }));
    emit({ type: "progress", opId: "op-1", transferredBytes: 42, totalBytes: 100 });
    emit({ type: "progress", opId: "op-other", transferredBytes: 99, totalBytes: 100 });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(0.42);

    controller.abort();
    expect(fileTransfer.cancel).toHaveBeenCalledWith({ opId: "op-1" });
    // Even when the host finished first, a cancelled paste answers with no path.
    finish();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(deps.reportFailure).not.toHaveBeenCalled();
  });

  it("stays quiet when the clipboard has no image", async () => {
    const saveClipboardImage = vi.fn(async () => {
      throw Object.assign(new Error("empty"), { code: "CLIPBOARD_EMPTY" });
    });
    const { materialize, deps } = setup({ saveClipboardImage });
    await expect(materialize({ kind: "clipboard-image" })).rejects.toMatchObject({
      code: "CLIPBOARD_EMPTY",
    });
    expect(deps.reportFailure).not.toHaveBeenCalled();
  });

  it("uploads raw bytes", async () => {
    const { materialize, fileTransfer } = setup();
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await materialize({
      kind: "local-bytes",
      bytes,
      name: "shot.png",
      mimeType: "image/png",
    });
    expect(result.hostPath).toBe("/tmp/daintree-inbox/files/x/shot.png");
    expect(fileTransfer.uploadBytes).toHaveBeenCalledWith(
      expect.objectContaining({ bytes, name: "shot.png", hostId: "studio-01" })
    );
  });

  // Not a cancellation: the user never backed out, so the clash is reported
  // rather than swallowed with the silence CANCELLED gets.
  it("never asks to replace, or replaces, without a token from the host, and says so", async () => {
    const confirmReplace = vi.fn(async () => true);
    const reportFailure = vi.fn();
    const { materialize, fileTransfer } = setup({ confirmReplace, reportFailure });
    fileTransfer.uploadLocalFile.mockResolvedValueOnce({
      hostPath: "/srv/proj/spec.md",
      bytes: 0,
      deduplicated: false,
      conflict: true,
    });
    const failure = materialize(
      { kind: "local-file", path: "/Users/me/spec.md" },
      { destination: { kind: "worktree", directory: "/srv/proj" } }
    );
    await expect(failure).rejects.toMatchObject({ name: "MaterializeError", code: "CONFLICT" });
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(fileTransfer.uploadLocalFile).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    const [{ title, message, code }] = reportFailure.mock.calls[0]!;
    expect(code).toBe("CONFLICT");
    expect(title).toBe("Couldn't send spec.md");
    expect(message).toContain("spec.md");
    expect(message).toContain("studio-01");
  });

  it("reports a file that changed on the host after the user chose to replace it", async () => {
    const confirmReplace = vi.fn(async () => true);
    const reportFailure = vi.fn();
    const { materialize, fileTransfer } = setup({ confirmReplace, reportFailure });
    const clash = {
      hostPath: "/srv/proj/docs/spec.md",
      bytes: 0,
      deduplicated: false,
      conflict: true,
      replaceToken: REPLACE_TOKEN,
    };
    fileTransfer.uploadLocalFile
      .mockResolvedValueOnce(clash)
      .mockResolvedValueOnce({ ...clash, replaceToken: "f".repeat(32) });

    const failure = materialize(
      { kind: "local-file", path: "/Users/me/spec.md" },
      { destination: { kind: "worktree", directory: "/srv/proj/docs" } }
    );
    await expect(failure).rejects.toMatchObject({ name: "MaterializeError", code: "CONFLICT" });
    expect(confirmReplace).toHaveBeenCalledTimes(1);
    expect(fileTransfer.uploadLocalFile).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    const [{ title, message, code }] = reportFailure.mock.calls[0]!;
    expect(code).toBe("CONFLICT");
    expect(title).toBe("Couldn't send spec.md");
    expect(message).toContain("spec.md");
    expect(message).toContain("studio-01");
  });

  it("reports a clash that comes back after Replace for raw bytes too", async () => {
    const reportFailure = vi.fn();
    const { materialize, fileTransfer } = setup({ reportFailure });
    const clash = {
      hostPath: "/srv/proj/shot.png",
      bytes: 0,
      deduplicated: false,
      conflict: true,
      replaceToken: REPLACE_TOKEN,
    };
    fileTransfer.uploadBytes.mockResolvedValueOnce(clash).mockResolvedValueOnce(clash);
    await expect(
      materialize(
        { kind: "local-bytes", bytes: new Uint8Array([1, 2, 3]), name: "shot.png", mimeType: null },
        { destination: { kind: "worktree", directory: "/srv/proj" } }
      )
    ).rejects.toMatchObject({ name: "MaterializeError", code: "CONFLICT" });
    expect(fileTransfer.uploadBytes).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure.mock.calls[0]![0]).toMatchObject({
      title: "Couldn't send shot.png",
      code: "CONFLICT",
    });
  });

  it("says nothing when the user declines to replace", async () => {
    const reportFailure = vi.fn();
    const { materialize, fileTransfer } = setup({
      confirmReplace: vi.fn(async () => false),
      reportFailure,
    });
    fileTransfer.uploadLocalFile.mockResolvedValueOnce({
      hostPath: "/srv/proj/spec.md",
      bytes: 0,
      deduplicated: false,
      conflict: true,
      replaceToken: REPLACE_TOKEN,
    });
    await expect(
      materialize(
        { kind: "local-file", path: "/Users/me/spec.md" },
        { destination: { kind: "worktree", directory: "/srv/proj" } }
      )
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(reportFailure).not.toHaveBeenCalled();
  });

  // Fixed values, not the constants: a change to either limit must fail here.
  describe("size limits", () => {
    const FIFTY_MB = 50 * 1024 * 1024;
    const FIVE_HUNDRED_MB = 500 * 1024 * 1024;

    it.each([
      [FIFTY_MB, false],
      [FIFTY_MB + 1, true],
    ])("a %i-byte file asks first: %s", async (size, asks) => {
      const { materialize, fileTransfer, deps } = setup();
      fileTransfer.statLocalFile.mockResolvedValueOnce({ size, isDirectory: false });
      await materialize({ kind: "local-file", path: "/Users/me/file.bin" });
      expect(deps.confirmLargeUpload).toHaveBeenCalledTimes(asks ? 1 : 0);
      expect(fileTransfer.uploadLocalFile).toHaveBeenCalledTimes(1);
    });

    it.each([
      [FIVE_HUNDRED_MB, false],
      [FIVE_HUNDRED_MB + 1, true],
    ])("a %i-byte file is refused: %s", async (size, refused) => {
      const { materialize, fileTransfer } = setup();
      fileTransfer.statLocalFile.mockResolvedValueOnce({ size, isDirectory: false });
      const pending = materialize({ kind: "local-file", path: "/Users/me/file.bin" });
      if (refused) {
        await expect(pending).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
        expect(fileTransfer.uploadLocalFile).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({ displayName: "file.bin" });
        expect(fileTransfer.uploadLocalFile).toHaveBeenCalledTimes(1);
      }
    });

    it.each([
      [FIFTY_MB, false, false],
      [FIFTY_MB + 1, true, false],
      [FIVE_HUNDRED_MB, true, false],
      [FIVE_HUNDRED_MB + 1, false, true],
    ])("pasted bytes of %i: asks %s, refused %s", async (size, asks, refused) => {
      const { materialize, fileTransfer, deps } = setup();
      // A view over a large buffer, without allocating one.
      const bytes = Object.defineProperty(new Uint8Array(0), "byteLength", { value: size });
      const pending = materialize({ kind: "local-bytes", bytes, name: "blob.bin", mimeType: null });
      if (refused) {
        await expect(pending).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
        expect(fileTransfer.uploadBytes).not.toHaveBeenCalled();
      } else {
        await pending;
        expect(fileTransfer.uploadBytes).toHaveBeenCalledTimes(1);
      }
      expect(deps.confirmLargeUpload).toHaveBeenCalledTimes(asks ? 1 : 0);
    });
  });

  describe("folders", () => {
    const FOLDER = { kind: "local-file", path: "/Users/me/designs" } as const;

    /** A view's materializer where every path is a folder and each step gets its own id. */
    function folderSetup(overrides: Partial<RemoteMaterializerDeps> = {}) {
      let next = 0;
      const harness = setup({ mintOperationId: () => `op-${++next}`, ...overrides });
      harness.fileTransfer.statLocalFile.mockResolvedValue({ size: 96, isDirectory: true });
      return harness;
    }

    /** A step that runs until the test settles it, rejecting CANCELLED once its id is cancelled. */
    function held<T>() {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      return { promise, resolve, reject };
    }

    const cancelledOnHost = () => Object.assign(new Error("cancelled"), { code: "CANCELLED" });

    it("reads the folder, asks, sends it into the inbox and answers with its host path", async () => {
      const { materialize, fileTransfer, deps } = folderSetup();
      const onFolderProgress = vi.fn();
      const result = await materialize(FOLDER, { onFolderProgress });

      expect(result).toEqual({
        hostPath: "/tmp/daintree-inbox/files/x/designs",
        displayName: "designs",
        bytes: 30,
      });
      expect(fileTransfer.summarizeLocalFolder).toHaveBeenCalledWith({
        localPath: "/Users/me/designs",
        opId: "op-1",
      });
      // The question sees what was read, never the handle the send names it by.
      expect(deps.confirmFolder).toHaveBeenCalledWith(
        { check: { status: "ready", summary: folderSummary("designs") }, hostLabel: "studio-01" },
        undefined
      );
      expect(fileTransfer.uploadLocalFolder).toHaveBeenCalledWith({
        hostId: "studio-01",
        handle: HANDLE,
        destination: { kind: "inbox", bucket: "files" },
        opId: "op-2",
      });
      expect(fileTransfer.uploadLocalFile).not.toHaveBeenCalled();
      expect(onFolderProgress.mock.calls.map(([progress]) => progress.phase)).toEqual([
        "waiting",
        "reading",
        "waiting",
        "packing",
      ]);
      expect(deps.reportFailure).not.toHaveBeenCalled();
    });

    it("asks however large the folder, never with the file size questions", async () => {
      const { materialize, fileTransfer, deps } = folderSetup();
      fileTransfer.statLocalFile.mockResolvedValue({
        size: UPLOAD_REFUSE_BYTES + 1,
        isDirectory: true,
      });
      await materialize(FOLDER);
      expect(deps.confirmLargeUpload).not.toHaveBeenCalled();
      expect(deps.confirmFolder).toHaveBeenCalledTimes(1);
    });

    it("follows only its own send's progress", async () => {
      const { materialize, fileTransfer, emit } = folderSetup();
      const step = held<UploadLocalFolderResult>();
      fileTransfer.uploadLocalFolder.mockImplementationOnce(() => step.promise);
      const onFolderProgress = vi.fn();
      const onProgress = vi.fn();
      const pending = materialize(FOLDER, { onFolderProgress, onProgress });
      await vi.waitFor(() => expect(fileTransfer.uploadLocalFolder).toHaveBeenCalled());
      onFolderProgress.mockClear();

      const report = {
        phase: "sending",
        filesDone: null,
        filesTotal: 2,
        transferredBytes: 5,
        totalBytes: 40,
      } as const;
      emit({ type: "folder-progress", opId: "op-2", ...report });
      emit({ type: "folder-progress", opId: "op-other", ...report });
      expect(onFolderProgress).toHaveBeenCalledTimes(1);
      expect(onFolderProgress).toHaveBeenCalledWith(report);
      expect(onProgress).not.toHaveBeenCalled();

      step.resolve({
        status: "sent",
        hostPath: "/tmp/daintree-inbox/files/x/designs",
        totals: { fileCount: 2, folderCount: 1, totalBytes: 30 },
      });
      await pending;
      // Its subscription goes with it.
      emit({ type: "folder-progress", opId: "op-2", ...report });
      expect(onFolderProgress).toHaveBeenCalledTimes(1);
    });

    it("sends nothing, and says nothing, when the person declines", async () => {
      const { materialize, fileTransfer, deps } = folderSetup({
        confirmFolder: vi.fn(async () => false),
      });
      await expect(materialize(FOLDER)).rejects.toMatchObject({ code: "CANCELLED" });
      expect(fileTransfer.uploadLocalFolder).not.toHaveBeenCalled();
      expect(deps.reportFailure).not.toHaveBeenCalled();
    });

    // The question in its refusal form names the limit and the paths, and is
    // the folder's only report: a toast after it would say it twice.
    it("shows a folder over the limits in the question alone, and sends nothing", async () => {
      const confirmFolder = vi.fn(async () => false);
      const { materialize, fileTransfer, deps } = folderSetup({ confirmFolder });
      const refused: LocalFolderSummaryResult = {
        status: "refused",
        summary: { ...folderSummary("designs"), lowerBound: true },
        problem: {
          kind: "limit",
          limit: "files",
          maximum: 5_000,
          actual: 5_001,
          paths: ["designs/node_modules/"],
        },
      };
      fileTransfer.summarizeLocalFolder.mockResolvedValueOnce(refused);

      await expect(materialize(FOLDER)).rejects.toMatchObject({ code: "CANCELLED" });
      expect(confirmFolder).toHaveBeenCalledWith(
        { check: refused, hostLabel: "studio-01" },
        undefined
      );
      expect(fileTransfer.uploadLocalFolder).not.toHaveBeenCalled();
      expect(deps.reportFailure).not.toHaveBeenCalled();
    });

    it("never sends a refused folder, even when the question is answered yes", async () => {
      const { materialize, fileTransfer } = folderSetup();
      fileTransfer.summarizeLocalFolder.mockResolvedValueOnce({
        status: "refused",
        summary: folderSummary("designs"),
        problem: { kind: "clash", paths: ["designs/A.txt", "designs/a.txt"] },
      });
      await expect(materialize(FOLDER)).rejects.toMatchObject({ code: "CANCELLED" });
      expect(fileTransfer.uploadLocalFolder).not.toHaveBeenCalled();
    });

    describe("a cancel from the chip", () => {
      it("stops the read by its operation id, and asks nothing", async () => {
        const { materialize, fileTransfer, deps } = folderSetup();
        const step = held<LocalFolderSummaryResult>();
        fileTransfer.summarizeLocalFolder.mockImplementationOnce(() => step.promise);
        const controller = new AbortController();
        const pending = materialize(FOLDER, { signal: controller.signal });
        await vi.waitFor(() => expect(fileTransfer.summarizeLocalFolder).toHaveBeenCalled());

        controller.abort();
        expect(fileTransfer.cancel).toHaveBeenCalledWith({ opId: "op-1" });
        step.reject(cancelledOnHost());
        await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
        expect(deps.confirmFolder).not.toHaveBeenCalled();
        expect(fileTransfer.uploadLocalFolder).not.toHaveBeenCalled();
        expect(deps.reportFailure).not.toHaveBeenCalled();
      });

      it("withdraws the question, and sends nothing", async () => {
        const confirmFolder = vi.fn(
          (_request: unknown, signal: AbortSignal | undefined) =>
            new Promise<boolean>((resolve) => {
              signal?.addEventListener("abort", () => resolve(false));
            })
        );
        const { materialize, fileTransfer, deps } = folderSetup({ confirmFolder });
        const controller = new AbortController();
        const pending = materialize(FOLDER, { signal: controller.signal });
        await vi.waitFor(() => expect(confirmFolder).toHaveBeenCalled());
        expect(confirmFolder.mock.calls[0]![1]).toBe(controller.signal);

        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
        expect(fileTransfer.uploadLocalFolder).not.toHaveBeenCalled();
        expect(deps.reportFailure).not.toHaveBeenCalled();
      });

      it("sends nothing when it lands as the question is answered yes", async () => {
        const controller = new AbortController();
        const confirmFolder = vi.fn(async () => {
          controller.abort();
          return true;
        });
        const { materialize, fileTransfer } = folderSetup({ confirmFolder });
        await expect(materialize(FOLDER, { signal: controller.signal })).rejects.toMatchObject({
          code: "CANCELLED",
        });
        expect(fileTransfer.uploadLocalFolder).not.toHaveBeenCalled();
      });

      it.each(["packing", "sending", "unpacking"] as const)(
        "stops the send while %s",
        async (phase) => {
          const { materialize, fileTransfer, deps, emit } = folderSetup();
          const step = held<UploadLocalFolderResult>();
          fileTransfer.uploadLocalFolder.mockImplementationOnce(() => step.promise);
          const controller = new AbortController();
          const onFolderProgress = vi.fn();
          const pending = materialize(FOLDER, { signal: controller.signal, onFolderProgress });
          await vi.waitFor(() => expect(fileTransfer.uploadLocalFolder).toHaveBeenCalled());
          emit({
            type: "folder-progress",
            opId: "op-2",
            phase,
            filesDone: null,
            filesTotal: 2,
            transferredBytes: null,
            totalBytes: 30,
          });
          expect(onFolderProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase }));

          controller.abort();
          expect(fileTransfer.cancel).toHaveBeenCalledWith({ opId: "op-2" });
          step.reject(cancelledOnHost());
          await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
          expect(deps.reportFailure).not.toHaveBeenCalled();
        }
      );

      it("inserts nothing even when the host had already published the folder", async () => {
        const { materialize, fileTransfer } = folderSetup();
        const step = held<UploadLocalFolderResult>();
        fileTransfer.uploadLocalFolder.mockImplementationOnce(() => step.promise);
        const controller = new AbortController();
        const pending = materialize(FOLDER, { signal: controller.signal });
        await vi.waitFor(() => expect(fileTransfer.uploadLocalFolder).toHaveBeenCalled());
        controller.abort();
        step.resolve({
          status: "sent",
          hostPath: "/tmp/daintree-inbox/files/x/designs",
          totals: { fileCount: 2, folderCount: 1, totalBytes: 30 },
        });
        await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      });
    });

    describe("each refusal, reported once", () => {
      it("names what changed on this machine since the folder was read", async () => {
        const { materialize, fileTransfer, deps } = folderSetup();
        fileTransfer.uploadLocalFolder.mockResolvedValueOnce({
          status: "changed",
          path: "designs/logo.svg",
          change: "modified",
        });
        await expect(materialize(FOLDER)).rejects.toMatchObject({ code: "FOLDER_CHANGED" });
        expect(deps.reportFailure).toHaveBeenCalledTimes(1);
        expect(deps.reportFailure).toHaveBeenCalledWith({
          title: "Couldn't send designs",
          message:
            "designs/logo.svg was changed on This Mac after the folder was checked, so nothing was sent. Drop the folder again to send it as it is now.",
          code: "FOLDER_CHANGED",
        });
      });

      it("gives the host's refusal of what arrived, with the names responsible", async () => {
        const { materialize, fileTransfer, deps } = folderSetup();
        fileTransfer.uploadLocalFolder.mockResolvedValueOnce({
          status: "refused",
          problem: { kind: "clash", paths: ["designs/A.txt", "designs/a.txt"] },
        });
        await expect(materialize(FOLDER)).rejects.toMatchObject({ code: "FOLDER_REFUSED" });
        expect(deps.reportFailure).toHaveBeenCalledTimes(1);
        const [{ title, message }] = vi.mocked(deps.reportFailure).mock.calls[0]!;
        expect(title).toBe("Couldn't send designs");
        expect(message).toMatch(
          /^studio-01 refused the folder: two names clash \(designs\/A\.txt, designs\/a\.txt\)\. /
        );
      });

      it("counts the rest of a long list of names rather than naming them all", async () => {
        const { materialize, fileTransfer, deps } = folderSetup();
        fileTransfer.uploadLocalFolder.mockResolvedValueOnce({
          status: "refused",
          problem: {
            kind: "limit",
            limit: "files",
            maximum: 5_000,
            actual: 5_004,
            paths: ["designs/a/", "designs/b/", "designs/c/", "designs/d/", "designs/e/"],
          },
        });
        await expect(materialize(FOLDER)).rejects.toThrow();
        const [{ message }] = vi.mocked(deps.reportFailure).mock.calls[0]!;
        expect(message).toContain("(designs/a/, designs/b/, designs/c/ and 2 more)");
        expect(message).not.toContain("designs/d/");
      });

      it("passes on the send's own message, such as an older host's", async () => {
        const { materialize, fileTransfer, deps } = folderSetup();
        fileTransfer.uploadLocalFolder.mockRejectedValueOnce(
          new Error(
            `[AppError|UNSUPPORTED|${encodeURIComponent("Update Daintree on studio-01 to send folders.")}] folder send failed`
          )
        );
        await expect(materialize(FOLDER)).rejects.toThrow();
        expect(deps.reportFailure).toHaveBeenCalledTimes(1);
        expect(deps.reportFailure).toHaveBeenCalledWith({
          title: "Couldn't send designs",
          message: "Update Daintree on studio-01 to send folders.",
          code: "UNSUPPORTED",
        });
      });

      it("passes on the read's own message, naming this machine", async () => {
        const { materialize, fileTransfer, deps } = folderSetup();
        fileTransfer.summarizeLocalFolder.mockRejectedValueOnce(
          new Error(
            `[AppError|PERMISSION|${encodeURIComponent("Couldn't read the folder on This Mac.")}] walk failed`
          )
        );
        await expect(materialize(FOLDER)).rejects.toThrow();
        expect(deps.confirmFolder).not.toHaveBeenCalled();
        expect(deps.reportFailure).toHaveBeenCalledTimes(1);
        expect(deps.reportFailure).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Couldn't read the folder on This Mac." })
        );
      });
    });

    it("refuses a folder for Add to project before reading it, pointing at a plain drop", async () => {
      const { materialize, fileTransfer, deps } = folderSetup();
      await expect(
        materialize(FOLDER, { destination: { kind: "worktree", directory: "/srv/proj" } })
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect(fileTransfer.summarizeLocalFolder).not.toHaveBeenCalled();
      expect(deps.confirmFolder).not.toHaveBeenCalled();
      expect(fileTransfer.uploadLocalFile).not.toHaveBeenCalled();
      expect(deps.reportFailure).toHaveBeenCalledTimes(1);
      expect(deps.reportFailure).toHaveBeenCalledWith({
        title: "Couldn't send designs",
        message:
          "Add to project takes files only. Drop designs without holding Option to send the folder to the inbox on studio-01.",
        code: "UNSUPPORTED",
      });
    });

    describe("several folders at once", () => {
      const folders = ["a", "b", "c"].map((name) => ({
        kind: "local-file" as const,
        path: `/Users/me/${name}`,
      }));

      // Main refuses a view's third walk or pack outright; here it waits its turn.
      it("reads two at a time while files go on as usual", async () => {
        const { materialize, fileTransfer } = folderSetup();
        fileTransfer.statLocalFile.mockImplementation(async ({ localPath }) => ({
          size: 10,
          isDirectory: !localPath.endsWith(".txt"),
        }));
        const reads = [held<LocalFolderSummaryResult>(), held<LocalFolderSummaryResult>()];
        fileTransfer.summarizeLocalFolder
          .mockImplementationOnce(() => reads[0]!.promise)
          .mockImplementationOnce(() => reads[1]!.promise);
        const onFolderProgress = vi.fn();

        const pending = [
          materialize(folders[0]!),
          materialize(folders[1]!),
          materialize(folders[2]!, { onFolderProgress }),
          materialize({ kind: "local-file", path: "/Users/me/notes.txt" }),
        ];
        await vi.waitFor(() => expect(fileTransfer.uploadLocalFile).toHaveBeenCalledTimes(1));
        expect(fileTransfer.summarizeLocalFolder).toHaveBeenCalledTimes(2);
        expect(onFolderProgress.mock.calls.map(([progress]) => progress.phase)).toEqual([
          "waiting",
        ]);

        reads[0]!.resolve({ status: "ready", summary: folderSummary("a"), handle: HANDLE });
        await vi.waitFor(() => expect(fileTransfer.summarizeLocalFolder).toHaveBeenCalledTimes(3));
        expect(fileTransfer.summarizeLocalFolder.mock.calls[2]![0].localPath).toBe("/Users/me/c");
        reads[1]!.resolve({ status: "ready", summary: folderSummary("b"), handle: HANDLE });
        await Promise.all(pending);
      });

      it("lets a folder waiting its turn leave the line", async () => {
        const { materialize, fileTransfer } = folderSetup();
        const reads = [held<LocalFolderSummaryResult>(), held<LocalFolderSummaryResult>()];
        fileTransfer.summarizeLocalFolder
          .mockImplementationOnce(() => reads[0]!.promise)
          .mockImplementationOnce(() => reads[1]!.promise);
        const controller = new AbortController();
        const first = materialize(folders[0]!);
        const second = materialize(folders[1]!);
        const third = materialize(folders[2]!, { signal: controller.signal });
        await vi.waitFor(() => expect(fileTransfer.summarizeLocalFolder).toHaveBeenCalledTimes(2));

        controller.abort();
        await expect(third).rejects.toMatchObject({ code: "CANCELLED" });
        reads[0]!.resolve({ status: "ready", summary: folderSummary("a"), handle: HANDLE });
        reads[1]!.resolve({ status: "ready", summary: folderSummary("b"), handle: HANDLE });
        await Promise.all([first, second]);
        expect(fileTransfer.summarizeLocalFolder).toHaveBeenCalledTimes(2);
      });

      it("sends two at a time, the next starting as one finishes", async () => {
        const { materialize, fileTransfer } = folderSetup();
        const sends = [held<UploadLocalFolderResult>(), held<UploadLocalFolderResult>()];
        fileTransfer.uploadLocalFolder
          .mockImplementationOnce(() => sends[0]!.promise)
          .mockImplementationOnce(() => sends[1]!.promise);
        const settled = Promise.allSettled(folders.map((folder) => materialize(folder)));
        await vi.waitFor(() => expect(fileTransfer.uploadLocalFolder).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(fileTransfer.summarizeLocalFolder).toHaveBeenCalledTimes(3));
        expect(fileTransfer.uploadLocalFolder).toHaveBeenCalledTimes(2);

        // A send that fails gives up its turn as one that succeeds does.
        sends[0]!.reject(new Error("link dropped"));
        await vi.waitFor(() => expect(fileTransfer.uploadLocalFolder).toHaveBeenCalledTimes(3));
        sends[1]!.resolve({
          status: "sent",
          hostPath: "/tmp/daintree-inbox/files/x/b",
          totals: { fileCount: 1, folderCount: 0, totalBytes: 1 },
        });
        expect((await settled).map((outcome) => outcome.status)).toEqual([
          "rejected",
          "fulfilled",
          "fulfilled",
        ]);
      });
    });
  });
});
