import { beforeEach, describe, expect, it, vi } from "vitest";

const { notifyMock, dispatchMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
  dispatchMock: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

import { announceOpenInEditorFallback } from "../openInEditorFallback";

type NotifyArg = {
  type: string;
  title: string;
  message: string;
  action?: {
    label: string;
    actionId?: string;
    actionArgs?: Record<string, unknown>;
    onClick: () => void;
  };
};

function lastNotice(): NotifyArg {
  expect(notifyMock).toHaveBeenCalledTimes(1);
  return notifyMock.mock.calls[0]![0] as NotifyArg;
}

describe("announceOpenInEditorFallback", () => {
  beforeEach(() => {
    notifyMock.mockReset();
    dispatchMock.mockReset();
  });

  it("says nothing when the editor was asked to open the file", () => {
    announceOpenInEditorFallback(undefined);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("names the host whose path was copied", () => {
    announceOpenInEditorFallback({
      outcome: "copied-host-path",
      path: "/srv/app/main.ts",
      hostName: "build-box",
    });

    expect(lastNotice().message).toContain("build-box");
  });

  it("explains how to run a terminal-only editor and links to its settings", async () => {
    announceOpenInEditorFallback({
      outcome: "needs-terminal",
      editorName: "Neovim",
      command: "nvim",
    });

    const notice = lastNotice();
    expect(notice.title).toContain("Neovim");
    expect(notice.message).toContain("Neovim runs in a terminal");
    expect(notice.message).toContain('"nvim {file}"');
    expect(notice.message).toContain("Custom…");

    const target = { tab: "integrations", sectionId: "editor-external" };
    // The inbox replays the action by id, so the id and args must name the same target.
    expect(notice.action?.actionId).toBe("app.settings.openTab");
    expect(notice.action?.actionArgs).toEqual(target);

    notice.action!.onClick();
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(dispatchMock).toHaveBeenCalledWith("app.settings.openTab", target, {
      source: "user",
    });
  });
});
