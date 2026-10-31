/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPendingUploadsForTests,
  getHeldBackAttachments,
  getPendingUploads,
  hasPendingUploads,
  holdBackAttachments,
  holdComposerSend,
  isComposerSendHeld,
  takeHeldBackAttachments,
  trackUpload,
  UPLOAD_PROGRESS_DELAY_MS,
} from "../pendingUploads";
import {
  _resetUploadConfirmForTests,
  askUploadQuestion,
  currentUploadQuestion,
  leadUploadConfirmHost,
  registerUploadConfirmHost,
} from "../uploadConfirm";
import {
  _resetCtrlVImagePasteForTests,
  isClipboardImageCtrlV,
  refreshUploadPreferences,
} from "../ctrlVImagePaste";
import { uploadChipLabel } from "../PendingUploadChips";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("pending uploads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetPendingUploadsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing for an upload that finishes quickly", async () => {
    const done = trackUpload("composer:t1", "a.png", async () => "ok");
    expect(hasPendingUploads("composer:t1")).toBe(true);
    expect(getPendingUploads("composer:t1")[0]!.visible).toBe(false);
    await expect(done).resolves.toBe("ok");
    expect(hasPendingUploads("composer:t1")).toBe(false);
  });

  it("shows a slow upload's progress after the delay, and clears it however it ends", async () => {
    let finish!: () => void;
    let report!: (fraction: number) => void;
    const done = trackUpload(
      "composer:t1",
      "big.mov",
      ({ onProgress }) =>
        new Promise<void>((resolve) => {
          report = onProgress!;
          finish = resolve;
        })
    );
    vi.advanceTimersByTime(UPLOAD_PROGRESS_DELAY_MS - 1);
    expect(getPendingUploads("composer:t1")[0]!.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(getPendingUploads("composer:t1")[0]!.visible).toBe(true);
    report(0.424);
    expect(uploadChipLabel(getPendingUploads("composer:t1")[0]!.fraction)).toBe("uploading 42%");
    finish();
    await done;
    expect(getPendingUploads("composer:t1")).toEqual([]);
  });

  it("cancels through the signal it hands the upload", async () => {
    const done = trackUpload(
      "terminal:t1",
      "a.bin",
      ({ signal }) =>
        new Promise<void>((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(new Error("cancelled")))
        )
    );
    getPendingUploads("terminal:t1")[0]!.cancel();
    await expect(done).rejects.toThrow("cancelled");
    expect(hasPendingUploads("terminal:t1")).toBe(false);
  });

  it("keeps surfaces apart", () => {
    void trackUpload("composer:t1", "a", () => new Promise(() => {}));
    expect(hasPendingUploads("terminal:t1")).toBe(false);
  });
});

describe("a composer's attachments (#15599)", () => {
  beforeEach(() => {
    _resetPendingUploadsForTests();
  });

  it("holds the send through an upload and past it, until every hold is released", async () => {
    let finish!: () => void;
    const releaseFirst = holdComposerSend("composer:t1");
    const releaseSecond = holdComposerSend("composer:t1");
    const upload = trackUpload(
      "composer:t1",
      "shot.png",
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    expect(isComposerSendHeld("composer:t1")).toBe(true);

    finish();
    await upload;
    // The thumbnail is still to come: no chip, but no send either.
    expect(hasPendingUploads("composer:t1")).toBe(false);
    expect(getPendingUploads("composer:t1")).toEqual([]);
    expect(isComposerSendHeld("composer:t1")).toBe(true);

    releaseFirst();
    releaseFirst();
    expect(isComposerSendHeld("composer:t1")).toBe(true);
    releaseSecond();
    expect(isComposerSendHeld("composer:t1")).toBe(false);
  });

  it("holds only its own composer", () => {
    holdComposerSend("composer:t1");
    expect(isComposerSendHeld("composer:t2")).toBe(false);
    expect(isComposerSendHeld("isolated-composer:t1")).toBe(false);
  });

  it("keeps held-back attachments in the order they came until they are taken", () => {
    const shot = { type: "image", filePath: "/tmp/shot.png", thumbnailDataUrl: "data:x" } as const;
    const notes = {
      type: "file",
      filePath: "/tmp/notes.md",
      fileName: "notes.md",
      fileSize: 3,
    } as const;
    holdBackAttachments("composer:t1", [shot]);
    holdBackAttachments("composer:t1", [notes]);
    holdBackAttachments("composer:t1", []);
    expect(getHeldBackAttachments("composer:t2")).toEqual([]);

    expect(takeHeldBackAttachments("composer:t1")).toEqual([shot, notes]);
    expect(getHeldBackAttachments("composer:t1")).toEqual([]);
    expect(takeHeldBackAttachments("composer:t1")).toEqual([]);
  });
});

describe("upload questions", () => {
  beforeEach(() => {
    _resetUploadConfirmForTests();
  });

  it("declines when no host can show the question", async () => {
    await expect(
      askUploadQuestion({ kind: "large", name: "a", bytes: 1, hostLabel: "studio-01" })
    ).resolves.toBe(false);
  });

  it("queues questions for the first mounted host and answers them in order", async () => {
    const first = Symbol("first");
    const second = Symbol("second");
    const releaseFirst = registerUploadConfirmHost(first);
    registerUploadConfirmHost(second);
    expect(leadUploadConfirmHost()).toBe(first);

    const large = askUploadQuestion({ kind: "large", name: "a", bytes: 1, hostLabel: "h" });
    const replace = askUploadQuestion({ kind: "replace", name: "b", folder: "/x", hostLabel: "h" });
    expect(currentUploadQuestion()?.question.kind).toBe("large");
    currentUploadQuestion()!.answer(true);
    await expect(large).resolves.toBe(true);
    expect(currentUploadQuestion()?.question.kind).toBe("replace");

    releaseFirst();
    expect(leadUploadConfirmHost()).toBe(second);
    currentUploadQuestion()!.answer(false);
    await expect(replace).resolves.toBe(false);
  });

  it("declines what is waiting when the last host goes", async () => {
    const release = registerUploadConfirmHost(Symbol("only"));
    const pending = askUploadQuestion({ kind: "large", name: "a", bytes: 1, hostLabel: "h" });
    release();
    await expect(pending).resolves.toBe(false);
  });
});

describe("Ctrl+V image interception", () => {
  const agent = { detectedAgentId: "claude" as const, agentState: "idle" as const };
  const ctrlV = () => keydown({ key: "v", code: "KeyV", ctrlKey: true });

  beforeEach(() => {
    _resetCtrlVImagePasteForTests();
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
  });

  afterEach(() => {
    delete window.__DAINTREE_HOST_ID__;
    vi.unstubAllGlobals();
  });

  it("takes plain Ctrl+V in an agent terminal of a remote window", () => {
    expect(isClipboardImageCtrlV(ctrlV(), agent)).toBe(true);
  });

  it("never takes it in a plain shell", () => {
    expect(isClipboardImageCtrlV(ctrlV(), {})).toBe(false);
  });

  it("never takes it in a window on this machine", () => {
    delete window.__DAINTREE_HOST_ID__;
    expect(isClipboardImageCtrlV(ctrlV(), agent)).toBe(false);
  });

  it("leaves Ctrl+Shift+V and Cmd+V alone", () => {
    expect(isClipboardImageCtrlV(keydown({ key: "V", ctrlKey: true, shiftKey: true }), agent)).toBe(
      false
    );
    expect(isClipboardImageCtrlV(keydown({ key: "v", metaKey: true }), agent)).toBe(false);
  });

  it("stops taking it once the setting is off", async () => {
    const electron = (window as unknown as { electron?: unknown }).electron;
    (window as unknown as { electron: unknown }).electron = {
      fileTransfer: { getUploadPreferences: async () => ({ interceptCtrlVImages: false }) },
    };
    try {
      await refreshUploadPreferences();
      expect(isClipboardImageCtrlV(ctrlV(), agent)).toBe(false);
    } finally {
      (window as unknown as { electron: unknown }).electron = electron;
    }
  });
});
