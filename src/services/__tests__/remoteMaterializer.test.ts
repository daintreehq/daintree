import { describe, expect, it, vi } from "vitest";
import type {
  FileTransferEvent,
  LocalFileStat,
  TransferDestination,
  UploadResult,
} from "@shared/types/ipc/fileTransfer";
import { UPLOAD_CONFIRM_BYTES, UPLOAD_REFUSE_BYTES } from "@shared/types/remoteHosts";
import { createRemoteMaterializer, type RemoteMaterializerDeps } from "../remoteMaterializer";

const MB = 1024 * 1024;
const REPLACE_TOKEN = "0123456789abcdef0123456789abcdef";

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

  it("sends a large file once confirmed, and never asks below the threshold", async () => {
    const { materialize, fileTransfer, deps } = setup();
    fileTransfer.statLocalFile.mockResolvedValueOnce({ size: 60 * MB, isDirectory: false });
    await materialize({ kind: "local-file", path: "/Users/me/big.mov" });
    expect(fileTransfer.uploadLocalFile).toHaveBeenCalledTimes(1);
    await materialize({ kind: "local-file", path: "/Users/me/small.txt" });
    expect(deps.confirmLargeUpload).toHaveBeenCalledTimes(1);
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
    });
  });

  it("reports the host's own message for a failed upload", async () => {
    const { materialize, fileTransfer, deps } = setup();
    fileTransfer.uploadLocalFile.mockRejectedValueOnce(
      Object.assign(new Error("x"), {
        code: "PAYLOAD_TOO_LARGE",
        userMessage: "studio-01 is out of disk space.",
      })
    );
    await expect(materialize({ kind: "local-file", path: "/Users/me/a.txt" })).rejects.toThrow();
    expect(deps.reportFailure).toHaveBeenCalledWith({
      title: "Couldn't send a.txt",
      message: "studio-01 is out of disk space.",
    });
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

  it("never asks to replace, or replaces, without a token from the host", async () => {
    const confirmReplace = vi.fn(async () => true);
    const { materialize, fileTransfer } = setup({ confirmReplace });
    fileTransfer.uploadLocalFile.mockResolvedValueOnce({
      hostPath: "/srv/proj/spec.md",
      bytes: 0,
      deduplicated: false,
      conflict: true,
    });
    await expect(
      materialize(
        { kind: "local-file", path: "/Users/me/spec.md" },
        { destination: { kind: "worktree", directory: "/srv/proj" } }
      )
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(fileTransfer.uploadLocalFile).toHaveBeenCalledTimes(1);
  });

  // Fixed values, not the constants: a change to either limit must fail here.
  describe("size limits", () => {
    const FIFTY_MB = 50 * 1024 * 1024;
    const FIVE_HUNDRED_MB = 500 * 1024 * 1024;

    it("holds the confirm threshold at 50 MB and the hard cap at 500 MB", () => {
      expect(UPLOAD_CONFIRM_BYTES).toBe(FIFTY_MB);
      expect(UPLOAD_REFUSE_BYTES).toBe(FIVE_HUNDRED_MB);
    });

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

  it("refuses folders", async () => {
    const { materialize, fileTransfer } = setup();
    fileTransfer.statLocalFile.mockResolvedValueOnce({ size: 0, isDirectory: true });
    await expect(
      materialize({ kind: "local-file", path: "/Users/me/designs" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
