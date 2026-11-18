import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchMock, notifyMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { openQuickSwitcherFile } from "./openQuickSwitcherFile";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  dispatchMock.mockReset();
  notifyMock.mockReset();
});

describe("openQuickSwitcherFile", () => {
  it("opens the viewer panel for a plain pick and the external editor for a modified one", async () => {
    dispatchMock.mockResolvedValue({ ok: true, result: undefined });
    openQuickSwitcherFile("/repo/src/a.ts", false);
    openQuickSwitcherFile("/repo/src/a.ts", true);
    await flush();

    expect(dispatchMock.mock.calls).toEqual([
      ["file.openPanel", { path: "/repo/src/a.ts" }, { source: "user" }],
      ["file.openInEditor", { path: "/repo/src/a.ts" }, { source: "user" }],
    ]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("leaves a refused viewer open to the panel ceiling's own warning", async () => {
    dispatchMock.mockResolvedValue({ ok: false, error: { message: "Panel limit reached" } });
    openQuickSwitcherFile("/repo/src/a.ts", false);
    await flush();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("says when the editor didn't open, with a retry for the same file", async () => {
    dispatchMock.mockResolvedValue({ ok: false, error: { message: "No editor configured" } });
    openQuickSwitcherFile("/repo/src/a.ts", true);
    await flush();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const toast = notifyMock.mock.calls[0]![0] as {
      type: string;
      message: string;
      action: { onClick: () => void };
    };
    expect(toast.type).toBe("error");
    expect(toast.message).toContain("a.ts");
    toast.action.onClick();
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "file.openInEditor",
      { path: "/repo/src/a.ts" },
      { source: "user" }
    );
  });
});
