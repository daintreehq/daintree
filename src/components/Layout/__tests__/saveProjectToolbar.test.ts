import { afterEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() =>
  vi.fn<(options: { type: string; action?: { label: string; onClick: () => void } }) => void>()
);
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import {
  _resetProjectPresentationStoreForTest,
  useProjectPresentationStore,
} from "@/store/projectPresentationStore";
import { saveProjectToolbar } from "../saveProjectToolbar";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function lastRetry(): () => void {
  const onClick = notifyMock.mock.calls.at(-1)?.[0].action?.onClick;
  if (onClick === undefined) throw new Error("no Retry was offered");
  return onClick;
}

afterEach(() => {
  notifyMock.mockReset();
  _resetProjectPresentationStoreForTest();
});

describe("saveProjectToolbar", () => {
  it("says nothing when the write lands", async () => {
    saveProjectToolbar(() => Promise.resolve(true));
    await flush();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises one error toast whose Retry makes the same write again", async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    saveProjectToolbar(save);
    await flush();
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({
      type: "error",
      action: { label: "Retry" },
    });

    lastRetry()();
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledOnce();
  });

  it("drops a Retry that a later recorded write has overtaken", async () => {
    const save = vi.fn().mockResolvedValue(false);
    saveProjectToolbar(save);
    await flush();
    useProjectPresentationStore.setState({ revision: 9 });

    lastRetry()();
    await flush();
    expect(save).toHaveBeenCalledOnce();
  });
});
