// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import type {
  FileTransferEvent,
  FolderUploadSummary,
  LocalFolderSummaryResult,
  UploadLocalFolderResult,
} from "@shared/types/ipc/fileTransfer";

// `fileAttachments` reaches `useTerminalFileTransfer` for one regex, and that
// module builds the terminal instance singleton at import time.
vi.mock("../../useTerminalFileTransfer", () => ({
  IMAGE_EXTENSIONS: /\.(png|jpe?g|bmp|tiff?|avif|heic)$/i,
}));
vi.mock("../../paneFocusRequest", () => ({ requestPaneFocus: vi.fn(() => true) }));
vi.mock("@/services/agentHandoff/agentDraft", () => ({
  draftAgentContext: vi.fn(),
  getDraftRefusal: vi.fn(() => null),
}));

const { useDragDrop } = await import("../../hooks/useDragDrop");
const { setRemoteMaterializer } = await import("@/services/materialize");
const { createRemoteMaterializer } = await import("@/services/remoteMaterializer");
const { _resetPendingUploadsForTests, getPendingUploads, isComposerSendHeld } =
  await import("../pendingUploads");
const {
  _resetUploadConfirmForTests,
  askUploadQuestion,
  currentUploadQuestion,
  registerUploadConfirmHost,
} = await import("../uploadConfirm");

const SURFACE = "composer:t1";
const CWD = "/srv/proj";
const FOLDER_HOST_PATH = "/tmp/daintree-inbox/files/20261105-a1/designs";
const HANDLE = "fedcba9876543210fedcba9876543210";

function summary(rootName: string): FolderUploadSummary {
  return {
    rootName,
    totals: { fileCount: 2, folderCount: 1, totalBytes: 30 },
    lowerBound: false,
    hidden: { fileCount: 0, folderCount: 0, totalBytes: 0, paths: [] },
    largest: [],
    notCopied: { count: 0, items: [] },
  };
}

function fakeView() {
  const dispatch = vi.fn();
  const view = {
    state: {
      selection: { main: { head: 0 } },
      doc: { sliceString: () => "" },
    },
    dispatch,
    focus: vi.fn(),
  } as unknown as EditorView;
  return { view, dispatch, ref: { current: view } as React.RefObject<EditorView | null> };
}

/** A drop of files from this machine, each `File` resolving to `/Users/me/<name>`. */
function dropOf(names: string[], altKey = false): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    altKey,
    dataTransfer: {
      types: ["Files"],
      files: names.map((name) => ({ name, size: 96 }) as unknown as File),
      getData: () => "",
    },
  } as unknown as React.DragEvent;
}

function insertedText(dispatch: ReturnType<typeof vi.fn>): string {
  return (dispatch.mock.calls[0]?.[0]?.changes?.insert as string).trimEnd();
}

/** The remote materializer a view installs, over a fake bridge where a name without a dot is a folder. */
function installRemote() {
  const listeners = new Set<(event: FileTransferEvent) => void>();
  let opIds = 0;
  let sendHeld: { resolve(result: UploadLocalFolderResult): void } | null = null;
  const fileTransfer = {
    statLocalFile: vi.fn(async ({ localPath }: { localPath: string }) => ({
      size: 96,
      isDirectory: !localPath.includes("."),
    })),
    uploadLocalFile: vi.fn(async ({ localPath }: { localPath: string }) => ({
      hostPath: `/tmp/daintree-inbox/files/20261105-b2/${localPath.split("/").pop()}`,
      bytes: 10,
      deduplicated: false,
    })),
    uploadBytes: vi.fn(),
    summarizeLocalFolder: vi.fn(
      async ({ localPath }: { localPath: string }): Promise<LocalFolderSummaryResult> => ({
        status: "ready",
        summary: summary(localPath.split("/").pop()!),
        handle: HANDLE,
      })
    ),
    uploadLocalFolder: vi.fn(async (): Promise<UploadLocalFolderResult> => ({
      status: "sent",
      hostPath: FOLDER_HOST_PATH,
      totals: { fileCount: 2, folderCount: 1, totalBytes: 30 },
    })),
    cancel: vi.fn(async () => {}),
    onEvent: (callback: (event: FileTransferEvent) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  const reportFailure = vi.fn();
  setRemoteMaterializer(
    createRemoteMaterializer({
      hostId: "studio-01",
      hostLabel: () => "studio-01",
      localLabel: "This Mac",
      fileTransfer,
      saveClipboardImage: vi.fn(),
      confirmLargeUpload: vi.fn(async () => true),
      confirmReplace: vi.fn(async () => true),
      confirmFolder: (request, signal) =>
        askUploadQuestion({ kind: "folder", ...request }, signal ? { signal } : {}),
      addToProjectKey: "Option",
      reportFailure,
      mintOperationId: () => `op-${++opIds}`,
    })
  );
  /** Holds the next folder send until the test lets it finish. */
  const holdSend = () => {
    fileTransfer.uploadLocalFolder.mockImplementationOnce(
      () =>
        new Promise<UploadLocalFolderResult>((resolve) => {
          sendHeld = { resolve };
        })
    );
    return {
      finish: () =>
        sendHeld!.resolve({
          status: "sent",
          hostPath: FOLDER_HOST_PATH,
          totals: { fileCount: 2, folderCount: 1, totalBytes: 30 },
        }),
    };
  };
  return { fileTransfer, reportFailure, holdSend };
}

function renderBar() {
  const view = fakeView();
  const { result } = renderHook(() =>
    useDragDrop(view.ref, CWD, undefined, undefined, {
      uploadSurface: SURFACE,
      addToProjectDirectory: () => CWD,
    })
  );
  return { ...view, result };
}

/**
 * Starts a drop and waits for its folder question to be the one showing. The
 * landing comes back wrapped: an async function returning it bare would wait
 * for it.
 */
async function dropAndAwaitQuestion(
  result: { current: ReturnType<typeof useDragDrop> },
  names: string[]
): Promise<{ landing: Promise<void> }> {
  let landing!: Promise<void>;
  act(() => {
    landing = result.current.handleDrop(dropOf(names));
  });
  await vi.waitFor(() => expect(currentUploadQuestion()?.question.kind).toBe("folder"));
  return { landing };
}

beforeEach(() => {
  _resetUploadConfirmForTests();
  _resetPendingUploadsForTests();
  registerUploadConfirmHost(Symbol("host"));
  (window as unknown as { electron: unknown }).electron = {
    files: {
      getDroppedFilePaths: (files: readonly File[]) =>
        files.map((file) => `/Users/me/${file.name}`),
    },
    clipboard: { thumbnailFromPath: vi.fn(async () => ({ thumbnailDataUrl: "data:," })) },
  };
});

afterEach(() => {
  setRemoteMaterializer(null);
  delete window.__DAINTREE_HOST_ID__;
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("a folder dropped on a remote window's composer", () => {
  beforeEach(() => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
  });

  it("lands as an @ token for its host path once the person sends it", async () => {
    const { fileTransfer, reportFailure } = installRemote();
    const { result, dispatch } = renderBar();
    const { landing } = await dropAndAwaitQuestion(result, ["designs"]);

    expect(currentUploadQuestion()?.question).toMatchObject({
      kind: "folder",
      hostLabel: "studio-01",
      check: { status: "ready", summary: { rootName: "designs" } },
    });
    expect(isComposerSendHeld(SURFACE)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();

    await act(async () => {
      currentUploadQuestion()!.answer(true);
      await landing;
    });
    expect(fileTransfer.uploadLocalFolder).toHaveBeenCalledWith(
      expect.objectContaining({ handle: HANDLE, destination: { kind: "inbox", bucket: "files" } })
    );
    expect(insertedText(dispatch)).toBe(`@${FOLDER_HOST_PATH}`);
    expect(dispatch.mock.calls[0]![0].effects[0].value).toMatchObject({
      filePath: FOLDER_HOST_PATH,
      fileName: "designs",
    });
    expect(isComposerSendHeld(SURFACE)).toBe(false);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("holds the composer's send until the folder is in the draft", async () => {
    const { fileTransfer, holdSend } = installRemote();
    const send = holdSend();
    const { result, dispatch } = renderBar();
    const { landing } = await dropAndAwaitQuestion(result, ["designs"]);
    act(() => currentUploadQuestion()!.answer(true));
    await vi.waitFor(() => expect(fileTransfer.uploadLocalFolder).toHaveBeenCalled());
    expect(getPendingUploads(SURFACE)[0]?.folder).toEqual({ phase: "waiting" });
    expect(isComposerSendHeld(SURFACE)).toBe(true);

    await act(async () => {
      send.finish();
      await landing;
    });
    expect(insertedText(dispatch)).toBe(`@${FOLDER_HOST_PATH}`);
    expect(isComposerSendHeld(SURFACE)).toBe(false);
  });

  it("inserts nothing when the question is closed", async () => {
    const { fileTransfer, reportFailure } = installRemote();
    const { result, dispatch } = renderBar();
    const { landing } = await dropAndAwaitQuestion(result, ["designs"]);
    await act(async () => {
      currentUploadQuestion()!.answer(false);
      await landing;
    });
    expect(fileTransfer.uploadLocalFolder).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(isComposerSendHeld(SURFACE)).toBe(false);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("withdraws the question and inserts nothing when its chip is cancelled", async () => {
    const { fileTransfer } = installRemote();
    const { result, dispatch } = renderBar();
    const { landing } = await dropAndAwaitQuestion(result, ["designs"]);
    await act(async () => {
      getPendingUploads(SURFACE)[0]!.cancel();
      await landing;
    });
    expect(currentUploadQuestion()).toBeNull();
    expect(fileTransfer.uploadLocalFolder).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(isComposerSendHeld(SURFACE)).toBe(false);
  });

  it("inserts nothing when its chip is cancelled mid-send", async () => {
    const { fileTransfer, holdSend } = installRemote();
    const send = holdSend();
    const { result, dispatch } = renderBar();
    const { landing } = await dropAndAwaitQuestion(result, ["designs"]);
    act(() => currentUploadQuestion()!.answer(true));
    await vi.waitFor(() => expect(fileTransfer.uploadLocalFolder).toHaveBeenCalled());
    await act(async () => {
      getPendingUploads(SURFACE)[0]!.cancel();
      // The host had already published it: the cancel still wins.
      send.finish();
      await landing;
    });
    expect(fileTransfer.cancel).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("sends the files of a mixed drop as before and asks once for each folder", async () => {
    const { fileTransfer } = installRemote();
    const { result, dispatch } = renderBar();
    const { landing } = await dropAndAwaitQuestion(result, ["notes.md", "designs", "assets"]);
    expect(fileTransfer.uploadLocalFile).toHaveBeenCalledTimes(1);

    act(() => currentUploadQuestion()!.answer(true));
    await vi.waitFor(() => expect(fileTransfer.summarizeLocalFolder).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(currentUploadQuestion()?.question).toMatchObject({
        check: { summary: { rootName: "assets" } },
      })
    );
    await act(async () => {
      currentUploadQuestion()!.answer(false);
      await landing;
    });

    expect(fileTransfer.uploadLocalFolder).toHaveBeenCalledTimes(1);
    expect(insertedText(dispatch)).toBe(
      `@/tmp/daintree-inbox/files/20261105-b2/notes.md @${FOLDER_HOST_PATH}`
    );
  });

  it("refuses a folder for Add to project, still adding the files beside it", async () => {
    const { fileTransfer, reportFailure } = installRemote();
    const { result } = renderBar();
    await act(async () => {
      await result.current.handleDrop(dropOf(["spec.md", "designs"], true));
    });
    expect(fileTransfer.uploadLocalFile).toHaveBeenCalledWith(
      expect.objectContaining({
        localPath: "/Users/me/spec.md",
        destination: { kind: "worktree", directory: CWD },
      })
    );
    expect(fileTransfer.summarizeLocalFolder).not.toHaveBeenCalled();
    expect(currentUploadQuestion()).toBeNull();
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure.mock.calls[0]![0].message).toBe(
      "Add to project takes files only. Drop designs without holding Option to send the folder to the inbox on studio-01."
    );
  });
});

describe("a folder dropped on a local window's composer", () => {
  it("inserts the local folder as it always has, without asking", async () => {
    const { result, dispatch } = renderBar();
    await act(async () => {
      await result.current.handleDrop(dropOf(["designs"]));
    });
    expect(insertedText(dispatch)).toBe("@/Users/me/designs");
    expect(currentUploadQuestion()).toBeNull();
    expect(getPendingUploads(SURFACE)).toEqual([]);
  });
});
