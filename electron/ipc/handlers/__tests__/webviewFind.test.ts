import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcContext } from "../../types.js";

const dialogService = vi.hoisted(() => ({
  setFindOpen: vi.fn<(embedderId: number, panelId: string, open: boolean) => void>(),
}));

vi.mock("../../../services/WebviewDialogService.js", () => ({
  getWebviewDialogService: () => dialogService,
}));

async function setFindOpen() {
  const { webviewFindNamespace } = await import("../webviewFind.js");
  return webviewFindNamespace.ops.setFindOpen.handler as (
    ctx: IpcContext,
    panelId: unknown,
    open: unknown
  ) => Promise<void>;
}

const fromView = (webContentsId: number) => ({ webContentsId }) as IpcContext;

describe("webview:set-find-open", () => {
  beforeEach(() => {
    dialogService.setFindOpen.mockClear();
  });

  it("records the bar under the view that sent it", async () => {
    const handler = await setFindOpen();

    await handler(fromView(42), "panel-a", true);
    await handler(fromView(7), "panel-b", true);
    await handler(fromView(42), "panel-a", false);

    expect(dialogService.setFindOpen.mock.calls).toEqual([
      [42, "panel-a", true],
      [7, "panel-b", true],
      [42, "panel-a", false],
    ]);
  });

  it.each([
    ["no panel", "", true],
    ["a panel that isn't a string", 7, true],
    ["a state that isn't a boolean", "panel-a", "yes"],
  ])("refuses %s", async (_case, panelId, open) => {
    const handler = await setFindOpen();

    await expect(handler(fromView(42), panelId, open)).rejects.toThrow(/Invalid arguments/);
    expect(dialogService.setFindOpen).not.toHaveBeenCalled();
  });
});
