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
import { PendingUploadChips } from "../PendingUploadChips";

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
  return {
    done,
    report: (progress: FolderUploadProgress) => act(() => report(progress)),
    aborted: () => aborted,
  };
}

function chipText(): string {
  return screen.getByRole("status").textContent ?? "";
}

function cancelButton(): HTMLElement {
  return screen.getByRole("button", { name: "Cancel sending Daintree-Audit-2026-11-05" });
}

describe("folder send chips", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetPendingUploadsForTests();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("follows the send through packing, sending and unpacking", async () => {
    render(<PendingUploadChips surface={SURFACE} />);
    const send = startSend();
    expect(screen.queryByRole("status")).toBeNull();
    act(() => vi.advanceTimersByTime(UPLOAD_PROGRESS_DELAY_MS));
    expect(chipText()).toContain("packing");

    send.report(packing);
    expect(chipText()).toContain("packing");
    send.report(sending(null));
    expect(chipText()).toContain("sending");
    expect(chipText()).not.toMatch(/sending \d/);
    send.report(sending(374));
    expect(chipText()).toContain("sending 37%");
    send.report(unpacking(1_204));
    expect(chipText()).toContain("unpacking 1,204 of 3,000");

    cancelButton().click();
    await expect(send.done).rejects.toThrow("cancelled");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("changes the chip only when its words change", () => {
    const send = startSend();
    send.report(sending(370));
    const before = getPendingUploads(SURFACE);
    send.report(sending(379));
    expect(getPendingUploads(SURFACE)).toBe(before);
    send.report(sending(380));
    expect(getPendingUploads(SURFACE)).not.toBe(before);
  });

  it("never reads past the host's own total", () => {
    const send = startSend();
    send.report({ ...unpacking(3_400) });
    expect(getPendingUploads(SURFACE)[0]!.folder).toEqual({
      phase: "unpacking",
      filesDone: 3_000,
      filesTotal: 3_000,
    });
    send.report(sending(2_000));
    expect(getPendingUploads(SURFACE)[0]!.folder).toEqual({ phase: "sending", percent: 100 });
  });

  it.each([
    ["packing", packing, "packing"],
    ["sending", sending(500), "sending 50%"],
    ["unpacking", unpacking(10), "unpacking 10 of 3,000"],
  ])("cancels from %s with the chip's button", async (_phase, progress, label) => {
    render(<PendingUploadChips surface={SURFACE} />);
    const send = startSend();
    act(() => vi.advanceTimersByTime(UPLOAD_PROGRESS_DELAY_MS));
    send.report(progress);
    expect(chipText()).toContain(label);

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

  it("clears the chip when the send throws before it starts", async () => {
    await expect(
      trackFolderUpload(SURFACE, "f", () => {
        throw new Error("no handle");
      })
    ).rejects.toThrow("no handle");
    expect(hasPendingUploads(SURFACE)).toBe(false);
    act(() => vi.advanceTimersByTime(UPLOAD_PROGRESS_DELAY_MS));
    expect(getPendingUploads(SURFACE)).toEqual([]);
  });
});
