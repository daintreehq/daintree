import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyPayload } from "@/lib/notify";

const notifyMock = vi.hoisted(() => vi.fn<(payload: NotifyPayload) => string>());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { copyPathWithFeedback } from "../copyPathFeedback";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("copyPathWithFeedback", () => {
  let announce: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    notifyMock.mockReset();
    announce = vi.spyOn(useAnnouncerStore.getState(), "announce").mockImplementation(() => {});
  });

  it("lets the toast speak for a delivered copy, with no second announcement", async () => {
    notifyMock.mockReturnValue("toast-1");
    copyPathWithFeedback(async () => true, "/repo/one");
    await flush();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
  });

  it("announces the copy itself when the toast was held back", async () => {
    notifyMock.mockReturnValue("");
    copyPathWithFeedback(async () => true, "/repo/one");
    await flush();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]![1]).toBe("polite");
  });

  it("keeps the failure toast out of the shared error rate limit", async () => {
    notifyMock.mockReturnValue("toast-1");
    copyPathWithFeedback(async () => false, "/repo/one");
    await flush();

    const failure = notifyMock.mock.calls[0]![0];
    expect(failure.type).toBe("error");
    expect(failure.action).toBeDefined();
    // notify() applies the per-source token bucket only to uncoalesced,
    // non-urgent toasts; without one of these, unrelated errors can drain it
    // and the next failure lands in the inbox with no Retry.
    expect(Boolean(failure.coalesce?.key) || failure.urgent === true).toBe(true);
  });
});
