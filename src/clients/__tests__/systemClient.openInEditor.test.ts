import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { systemClient } from "../systemClient";

const typedGlobal = globalThis as unknown as Record<string, unknown>;

describe("systemClient.openInEditor", () => {
  const openInEditor = vi.fn();

  beforeEach(() => {
    notifyMock.mockReset();
    openInEditor.mockReset();
    typedGlobal.window = { electron: { system: { openInEditor } } };
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("says nothing when the editor was asked to open the file", async () => {
    openInEditor.mockResolvedValue(undefined);
    await systemClient.openInEditor({ path: "/repo/a.ts", line: 3 });
    expect(openInEditor).toHaveBeenCalledWith({ path: "/repo/a.ts", line: 3 });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("names the host when main copied the host path instead", async () => {
    openInEditor.mockResolvedValue({
      outcome: "copied-host-path",
      path: "/home/greg/a.ts",
      hostName: "studio-01",
    });
    await systemClient.openInEditor({ path: "/home/greg/a.ts" });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const notice = notifyMock.mock.calls[0]![0] as { title: string; message: string; type: string };
    expect(notice.type).toBe("info");
    expect(notice.title).toBe("Host path copied");
    expect(notice.message).toContain("studio-01");
  });
});
