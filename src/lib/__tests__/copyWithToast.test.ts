/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyPayload } from "@/lib/notify";

const notifyMock = vi.hoisted(() => vi.fn<(payload: NotifyPayload) => string>());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

const flashMock = vi.hoisted(() => ({
  captureCopyFlash: vi.fn(),
  showCopyFlash: vi.fn(),
}));
vi.mock("@/lib/copyFlash", () => flashMock);

import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { copyWithToast } from "../copyWithToast";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const writeText = vi.fn<(text: string) => Promise<void>>();

describe("copyWithToast", () => {
  let announce: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    notifyMock.mockReset();
    writeText.mockReset();
    flashMock.captureCopyFlash.mockReset();
    flashMock.showCopyFlash.mockReset();
    flashMock.captureCopyFlash.mockImplementation(() => ({ origin: null, generation: 0 }));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    announce = vi.spyOn(useAnnouncerStore.getState(), "announce").mockImplementation(() => {});
  });

  afterEach(() => {
    announce.mockRestore();
  });

  it.each([
    ["Path", "/repo/wt"],
    ["Branch name", "feature/copy"],
    ["URL", "http://localhost:5173/"],
  ] as const)(
    "confirms a %s copy with a flash and one polite announcement, never a toast",
    async (label, value) => {
      writeText.mockResolvedValue();
      copyWithToast(label, value);
      await flush();

      expect(writeText).toHaveBeenCalledWith(value);
      expect(notifyMock).not.toHaveBeenCalled();
      expect(announce).toHaveBeenCalledTimes(1);
      expect(announce).toHaveBeenCalledWith(`${label} copied`, "polite");
      expect(flashMock.showCopyFlash).toHaveBeenCalledTimes(1);
    }
  );

  it("anchors the flash to where the gesture started, not where the write settled", async () => {
    let resolve!: () => void;
    writeText.mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const ticket = { origin: { kind: "point" as const, x: 10, y: 20 }, generation: 3 };
    flashMock.captureCopyFlash.mockReturnValueOnce(ticket);
    copyWithToast("Path", "/repo/wt");
    expect(flashMock.captureCopyFlash).toHaveBeenCalledTimes(1);

    resolve();
    await flush();

    expect(flashMock.showCopyFlash).toHaveBeenCalledWith(ticket);
  });

  it("announces every success, even an identical repeat", async () => {
    writeText.mockResolvedValue();
    copyWithToast("Path", "/repo/wt");
    copyWithToast("Path", "/repo/wt");
    await flush();

    expect(announce).toHaveBeenCalledTimes(2);
    expect(flashMock.showCopyFlash).toHaveBeenCalledTimes(2);
  });

  it("surfaces a rejected write as an error toast whose Retry confirms a later success", async () => {
    writeText.mockRejectedValueOnce(new Error("denied")).mockResolvedValue();
    notifyMock.mockReturnValue("toast-1");
    copyWithToast("Path", "/repo/wt");
    await flush();

    const failure = notifyMock.mock.calls[0]![0];
    expect(failure.type).toBe("error");
    expect(announce).not.toHaveBeenCalled();
    expect(flashMock.showCopyFlash).not.toHaveBeenCalled();
    // Coalesced toasts skip the shared per-type rate limit, so the Retry
    // can't be lost to an inbox-only row.
    expect(Boolean(failure.coalesce?.key) || failure.urgent === true).toBe(true);

    failure.action!.onClick();
    await flush();

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("Path copied", "polite");
    // Retry is its own gesture, so the flash anchors to it afresh.
    expect(flashMock.captureCopyFlash).toHaveBeenCalledTimes(2);
    expect(flashMock.showCopyFlash).toHaveBeenCalledTimes(1);
  });

  it("announces a failure itself when its toast was held back", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    notifyMock.mockReturnValue("");
    copyWithToast("Path", "/repo/wt");
    await flush();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]![0]).toContain("copy path");
  });

  it("never merges failures of two different values into one Retry", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    notifyMock.mockReturnValue("toast-1");
    copyWithToast("Path", "/repo/one");
    copyWithToast("Path", "/repo/two");
    await flush();

    const [first, second] = notifyMock.mock.calls.map(([payload]) => payload.coalesce?.key);
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });

  it("names the noun in the failure title, keeping an acronym's case", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    notifyMock.mockReturnValue("toast-1");
    copyWithToast("File name", "a.ts");
    copyWithToast("URL", "http://x/");
    await flush();

    expect(notifyMock.mock.calls.map(([payload]) => payload.title)).toEqual([
      "Couldn't copy file name",
      "Couldn't copy URL",
    ]);
  });

  it("routes through a caller's write and confirms only what it reports", async () => {
    notifyMock.mockReturnValue("toast-1");
    const write = vi.fn(async () => false);
    copyWithToast("Path", "/repo/wt", { write });
    await flush();

    expect(write).toHaveBeenCalledWith("/repo/wt");
    expect(writeText).not.toHaveBeenCalled();
    expect(notifyMock.mock.calls[0]![0].type).toBe("error");
  });

  it("keeps two same-named payloads' failures apart", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    notifyMock.mockReturnValue("toast-1");
    copyWithToast("File contents", "one");
    copyWithToast("File contents", "two");
    await flush();

    const [first, second] = notifyMock.mock.calls.map(([payload]) => payload.coalesce?.key);
    expect(first).not.toBe(second);
  });

  it("treats a caller's write that rejects as a refusal, with Retry", async () => {
    notifyMock.mockReturnValue("toast-1");
    copyWithToast("URL", "http://x/", { write: () => Promise.reject(new Error("gone")) });
    await flush();

    const failure = notifyMock.mock.calls[0]![0];
    expect(failure.type).toBe("error");
    expect(failure.action?.label).toBe("Retry");
  });
});
