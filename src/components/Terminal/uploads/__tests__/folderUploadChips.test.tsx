// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetPendingUploadsForTests,
  getPendingUploads,
  hasPendingUploads,
  trackFolderUpload,
  UPLOAD_PROGRESS_DELAY_MS,
  type FolderUploadProgress,
} from "../pendingUploads";
import { folderUploadSpokenLabel, PendingUploadChips } from "../PendingUploadChips";

const SURFACE = "composer:t1";

const packing: FolderUploadProgress = {
  phase: "packing",
  filesDone: 120,
  filesTotal: 3_000,
  transferredBytes: 4_000,
  totalBytes: 90_000,
};
const sending = (transferredBytes: number | null): FolderUploadProgress => ({
  phase: "sending",
  filesDone: null,
  filesTotal: 3_000,
  transferredBytes,
  totalBytes: 1_000,
});
const unpacking = (filesDone: number | null): FolderUploadProgress => ({
  phase: "unpacking",
  filesDone,
  filesTotal: 3_000,
  transferredBytes: null,
  totalBytes: 90_000,
});

/** A folder send that runs until cancelled, with its progress callback handed out. */
function startSend() {
  let report!: (progress: FolderUploadProgress) => void;
  let aborted = false;
  const done = trackFolderUpload(
    SURFACE,
    "Daintree-Audit-2026-11-05",
    ({ onFolderProgress, signal }) =>
      new Promise<string>((_resolve, reject) => {
        report = onFolderProgress;
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        });
      })
  );
  // Teardown cancels a send a test leaves running; that rejection is expected.
  done.catch(() => {});
  return {
    done,
    report: (progress: FolderUploadProgress) => act(() => report(progress)),
    aborted: () => aborted,
  };
}

/** The label the chip draws. */
function shownLabel(): string {
  return screen.getByRole("status").querySelector('[aria-hidden="true"]')?.textContent ?? "";
}

/** What the status region speaks for it. */
function spokenLabel(): string {
  return screen.getByRole("status").querySelector(".sr-only")?.textContent ?? "";
}

function cancelButton(): HTMLElement {
  return screen.getByRole("button", { name: "Cancel sending Daintree-Audit-2026-11-05" });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("folder send chips", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetPendingUploadsForTests();
  });

  afterEach(() => {
    cleanup();
    for (const upload of getPendingUploads(SURFACE)) upload.cancel();
    vi.useRealTimers();
  });

  it("follows the send through packing, sending and unpacking", async () => {
    render(<PendingUploadChips surface={SURFACE} />);
    const send = startSend();
    advance(UPLOAD_PROGRESS_DELAY_MS - 1);
    expect(screen.queryByRole("status")).toBeNull();
    advance(1);
    expect(shownLabel()).toBe("packing");

    send.report(packing);
    expect(shownLabel()).toBe("packing");
    send.report(sending(null));
    expect(shownLabel()).toBe("sending");
    send.report(sending(374));
    expect(shownLabel()).toBe("sending 37%");
    send.report(unpacking(null));
    expect(shownLabel()).toBe("unpacking");
    send.report(unpacking(1_204));
    expect(shownLabel()).toBe("unpacking 1,204 of 3,000");

    cancelButton().click();
    await expect(send.done).rejects.toThrow("cancelled");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("speaks unpacking in tenths while the chip counts every file", () => {
    render(<PendingUploadChips surface={SURFACE} />);
    const send = startSend();
    advance(UPLOAD_PROGRESS_DELAY_MS);
    send.report(unpacking(1_204));
    expect(spokenLabel()).toBe("unpacking 40%");
    send.report(unpacking(1_499));
    expect(shownLabel()).toBe("unpacking 1,499 of 3,000");
    expect(spokenLabel()).toBe("unpacking 40%");
    send.report(sending(374));
    expect(spokenLabel()).toBe("sending 37%");
    // An empty folder has no tenths to speak in, so it says what the chip says.
    expect(folderUploadSpokenLabel({ phase: "unpacking", filesDone: 0, filesTotal: 0 })).toBe(
      "unpacking 0 of 0"
    );
  });

  it("changes the chip only when its words change", () => {
    const send = startSend();
    send.report(sending(370));
    const sendingAt37 = getPendingUploads(SURFACE);
    send.report(sending(379));
    expect(getPendingUploads(SURFACE)).toBe(sendingAt37);
    send.report(sending(380));
    expect(getPendingUploads(SURFACE)).not.toBe(sendingAt37);

    send.report(unpacking(10));
    const unpackingTen = getPendingUploads(SURFACE);
    send.report(unpacking(10));
    expect(getPendingUploads(SURFACE)).toBe(unpackingTen);
    send.report(unpacking(11));
    expect(getPendingUploads(SURFACE)).not.toBe(unpackingTen);
    const unpackingEleven = getPendingUploads(SURFACE);
    send.report({ ...unpacking(11), filesTotal: 3_001 });
    expect(getPendingUploads(SURFACE)).not.toBe(unpackingEleven);
  });

  it("keeps every figure between nothing done and the host's own total", () => {
    const send = startSend();
    const stage = () => getPendingUploads(SURFACE)[0]!.folder;
    send.report(unpacking(3_400));
    expect(stage()).toEqual({ phase: "unpacking", filesDone: 3_000, filesTotal: 3_000 });
    send.report(unpacking(-5));
    expect(stage()).toEqual({ phase: "unpacking", filesDone: 0, filesTotal: 3_000 });
    send.report(sending(2_000));
    expect(stage()).toEqual({ phase: "sending", percent: 100 });
    send.report(sending(-20));
    expect(stage()).toEqual({ phase: "sending", percent: 0 });
    send.report({ ...sending(10), totalBytes: 0 });
    expect(stage()).toEqual({ phase: "sending", percent: null });
  });

  it.each([
    ["packing", packing, "packing"],
    ["sending", sending(500), "sending 50%"],
    ["unpacking", unpacking(10), "unpacking 10 of 3,000"],
  ])("cancels from %s with the chip's button", async (_phase, progress, label) => {
    render(<PendingUploadChips surface={SURFACE} />);
    const send = startSend();
    advance(UPLOAD_PROGRESS_DELAY_MS);
    send.report(progress);
    expect(shownLabel()).toBe(label);

    fireEvent.click(cancelButton());
    await expect(send.done).rejects.toThrow("cancelled");
    expect(send.aborted()).toBe(true);
    expect(hasPendingUploads(SURFACE)).toBe(false);
  });

  it("ignores a report that arrives after the send settled", async () => {
    const other = startSend();
    let report!: (progress: FolderUploadProgress) => void;
    await trackFolderUpload(SURFACE, "f", async ({ onFolderProgress }) => {
      report = onFolderProgress;
    });
    const before = getPendingUploads(SURFACE);
    report(sending(10));
    // A stale report would rebuild the surface's list and redraw the other chip.
    expect(getPendingUploads(SURFACE)).toBe(before);
    other.report(sending(10));
    expect(getPendingUploads(SURFACE)).not.toBe(before);
  });

  it.each([
    [
      "throws before it starts",
      () => {
        throw new Error("no handle");
      },
    ],
    ["rejects", () => Promise.reject(new Error("no handle"))],
  ])("clears the chip and its timer when the send %s", async (_how, run) => {
    const timersBefore = vi.getTimerCount();
    await expect(trackFolderUpload(SURFACE, "f", run)).rejects.toThrow("no handle");
    expect(hasPendingUploads(SURFACE)).toBe(false);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("clears the chip and its timer when the send finishes", async () => {
    const timersBefore = vi.getTimerCount();
    await expect(trackFolderUpload(SURFACE, "f", async () => "/inbox/f")).resolves.toBe("/inbox/f");
    expect(hasPendingUploads(SURFACE)).toBe(false);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("keeps a send from before a reset away from the ones after it", async () => {
    let finishOld!: () => void;
    let reportOld!: (progress: FolderUploadProgress) => void;
    const old = trackFolderUpload(SURFACE, "old", ({ onFolderProgress }) => {
      reportOld = onFolderProgress;
      return new Promise<void>((resolve) => (finishOld = resolve));
    });
    // Started later, so the old upload's reveal falls due first: ids restart at
    // 1 after a reset, and a timer that survived it would reveal this one.
    advance(100);
    _resetPendingUploadsForTests();
    const fresh = startSend();
    advance(UPLOAD_PROGRESS_DELAY_MS - 100);
    expect(getPendingUploads(SURFACE)[0]!.visible).toBe(false);

    const before = getPendingUploads(SURFACE);
    act(() => reportOld(sending(900)));
    expect(getPendingUploads(SURFACE)).toBe(before);

    finishOld();
    await old;
    expect(getPendingUploads(SURFACE).map((upload) => upload.name)).toEqual([
      "Daintree-Audit-2026-11-05",
    ]);
    advance(100);
    expect(getPendingUploads(SURFACE)[0]!.visible).toBe(true);
    fresh.report(sending(10));
    expect(getPendingUploads(SURFACE)[0]!.folder).toEqual({ phase: "sending", percent: 1 });
  });
});
