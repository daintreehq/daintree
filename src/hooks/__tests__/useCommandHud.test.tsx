// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  dispatch: vi.fn(),
  get: vi.fn(),
  selfNotifies: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: m.dispatch,
    get: m.get,
    selfNotifiesOnExecutionError: m.selfNotifies,
    list: () => [],
  },
}));

vi.mock("@/services/KeybindingService", () => ({
  combosFieldsEqual: (a: string, b: string) => a === b,
  keybindingService: {
    clearPendingChord: vi.fn(),
    getChordCompletions: () => [],
  },
}));

vi.mock("../useGlobalKeybindings", () => ({
  COMMAND_HUD_PREFIX: "Cmd+K",
  COMMAND_HUD_BLOCKED_EVENT: "daintree:command-hud-blocked",
  usePendingChord: () => null,
}));

vi.mock("@/lib/notify", () => ({ notify: m.notify }));

import { useCommandHud, type CommandHudItem } from "../useCommandHud";

const PUSH_ROW: CommandHudItem = {
  actionId: "git.push",
  combo: "Cmd+P",
  displayKey: "⌘+P",
  description: "Push to remote",
  category: "Git",
  enabled: true,
};

function failWith(code: string, message = "Push rejected") {
  m.dispatch.mockResolvedValue({ ok: false, error: { code, message } });
}

/** Lets the dispatch's `.then` run, then reports what it toasted. */
async function runRow(item: CommandHudItem = PUSH_ROW): Promise<void> {
  const { result } = renderHook(() => useCommandHud());
  result.current.run(item);
  await waitFor(() => expect(m.dispatch).toHaveBeenCalled());
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  m.dispatch.mockReset();
  m.get.mockReset().mockReturnValue(undefined);
  m.selfNotifies.mockReset().mockReturnValue(false);
  m.notify.mockReset();
});

describe("useCommandHud failure toast (#16667)", () => {
  it("stands down for an action that reported its own execution failure", async () => {
    m.selfNotifies.mockReturnValue(true);
    failWith("EXECUTION_ERROR");

    await runRow();

    expect(m.selfNotifies).toHaveBeenCalledWith("git.push");
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("still toasts a failure raised before the action ran", async () => {
    // Its own toast is only promised for a throw out of run(); a NOT_FOUND
    // never reached it.
    m.selfNotifies.mockReturnValue(true);
    failWith("NOT_FOUND", "Action not found");

    await runRow();

    expect(m.notify).toHaveBeenCalledTimes(1);
  });

  it("still toasts for an action that does not own its failure toast", async () => {
    failWith("EXECUTION_ERROR", "Something broke");

    await runRow();

    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify.mock.calls[0]![0]).toMatchObject({
      type: "error",
      message: "Something broke",
    });
  });

  it("asks the redirect target, which is the action that ran", async () => {
    m.get.mockReturnValue({ paletteRedirectTo: "worktree.openReviewHub" });
    m.selfNotifies.mockImplementation((id: string) => id === "worktree.openReviewHub");
    failWith("EXECUTION_ERROR");

    await runRow({ ...PUSH_ROW, actionId: "git.commit" });

    expect(m.dispatch.mock.calls[0]![0]).toBe("worktree.openReviewHub");
    expect(m.notify).not.toHaveBeenCalled();
  });
});
