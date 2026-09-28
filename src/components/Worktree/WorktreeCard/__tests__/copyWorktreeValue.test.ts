/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyPayload } from "@/lib/notify";

const notifyMock = vi.hoisted(() => vi.fn<(payload: NotifyPayload) => string>());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { copyWorktreeValue } from "../copyWorktreeValue";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const writeText = vi.fn<(text: string) => Promise<void>>();

describe("copyWorktreeValue", () => {
  let announce: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    notifyMock.mockReset();
    writeText.mockReset();
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
  ] as const)(
    "confirms a %s copy with a toast naming what was copied, and nothing else speaks",
    async (label, value) => {
      writeText.mockResolvedValue();
      notifyMock.mockReturnValue("toast-1");
      copyWorktreeValue(label, value);
      await flush();

      expect(writeText).toHaveBeenCalledWith(value);
      expect(notifyMock).toHaveBeenCalledTimes(1);
      const toast = notifyMock.mock.calls[0]![0];
      expect(toast.type).toBe("info");
      expect(String(toast.title)).toContain(label);
      expect(toast.message).toBe(value);
      expect(announce).not.toHaveBeenCalled();
    }
  );

  it("announces the specific copy itself when the toast was held back", async () => {
    writeText.mockResolvedValue();
    notifyMock.mockReturnValue("");
    copyWorktreeValue("Branch name", "feature/copy");
    await flush();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]![0]).toContain("Branch name");
    expect(announce.mock.calls[0]![1]).toBe("polite");
  });

  it("surfaces a rejected write as an error toast whose Retry confirms a later success", async () => {
    writeText.mockRejectedValueOnce(new Error("denied")).mockResolvedValue();
    notifyMock.mockReturnValue("toast-1");
    copyWorktreeValue("Path", "/repo/wt");
    await flush();

    const failure = notifyMock.mock.calls[0]![0];
    expect(failure.type).toBe("error");
    expect(announce).not.toHaveBeenCalled();
    // Coalesced toasts skip the shared per-type rate limit, so the Retry
    // can't be lost to an inbox-only row.
    expect(Boolean(failure.coalesce?.key) || failure.urgent === true).toBe(true);

    failure.action!.onClick();
    await flush();

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(notifyMock.mock.calls[1]![0].type).toBe("info");
  });

  it("announces a failure itself when its toast was held back", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    notifyMock.mockReturnValue("");
    copyWorktreeValue("Path", "/repo/wt");
    await flush();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]![0]).toContain("copy path");
  });

  it("never merges failures of two different values into one Retry", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    notifyMock.mockReturnValue("toast-1");
    copyWorktreeValue("Path", "/repo/one");
    copyWorktreeValue("Path", "/repo/two");
    await flush();

    const [first, second] = notifyMock.mock.calls.map(([payload]) => payload.coalesce?.key);
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });
});
