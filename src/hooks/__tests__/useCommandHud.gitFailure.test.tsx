// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

vi.mock("@/services/KeybindingService", () => ({
  combosFieldsEqual: (a: string, b: string) => a === b,
  keybindingService: {
    clearPendingChord: vi.fn(),
    getChordCompletions: () => [],
    getEffectiveCombo: () => null,
    getDisplayCombo: () => "",
  },
}));

vi.mock("../useGlobalKeybindings", () => ({
  COMMAND_HUD_PREFIX: "Cmd+K",
  COMMAND_HUD_BLOCKED_EVENT: "daintree:command-hud-blocked",
  usePendingChord: () => null,
}));

import { actionService } from "@/services/ActionService";
import type { ActionCallbacks, ActionRegistry } from "@/services/actions/actionTypes";
import { registerGitActions } from "@/services/actions/definitions/gitActions";
import "@/services/actions/definitions/gitActions.impl";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import {
  setWorktreePathIndexAccessor,
  resetStoreAccessorsForTesting,
} from "@/store/storeAccessors";
import { useCommandHud, type CommandHudItem } from "../useCommandHud";

const PUSH_ROW: CommandHudItem = {
  actionId: "git.push",
  combo: "Cmd+P",
  displayKey: "⌘+P",
  description: "Push to remote",
  category: "Git",
  enabled: true,
};

const push = vi.fn();

beforeEach(() => {
  const actions: ActionRegistry = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- git actions read no callbacks
  registerGitActions(actions, {} as unknown as ActionCallbacks);
  for (const factory of actions.values()) {
    const def = factory();
    if (!actionService.has(def.id)) actionService.register(def);
  }
  actionService.setContextProvider(() => ({
    activeWorktreeId: "wt-1",
    activeWorktreePath: "/repo/one",
  }));
  setWorktreePathIndexAccessor(() => new Map([["wt-1", "/repo/one"]]));
  push.mockReset();
  notifyMock.mockReset().mockReturnValue("toast-1");
  Object.assign(window, { electron: { git: { push } } });
});

afterEach(() => {
  actionService.setContextProvider(null);
  resetStoreAccessorsForTesting();
  if (useGitPushConfirmStore.getState().pendingConfirm) {
    useGitPushConfirmStore.getState().resolveConfirmation(null);
  }
});

describe("a push rejected after the command HUD's Push row (#16667)", () => {
  it("raises the action's own toast and no generic 'Couldn't run' beside it", async () => {
    push.mockRejectedValueOnce(new Error("[GitError|auth-failed||] Permission denied (publickey)"));
    const dispatched = vi.spyOn(actionService, "dispatch");

    const { result } = renderHook(() => useCommandHud());
    result.current.run(PUSH_ROW);

    await waitFor(() => {
      expect(useGitPushConfirmStore.getState().pendingConfirm).not.toBeNull();
    });
    useGitPushConfirmStore.getState().resolveConfirmation({
      branch: "feature/x",
      headOid: "e".repeat(40),
      destination: { remote: "origin", branch: "feature/x" },
    });

    // The HUD's `.then` runs on the dispatch it started; wait for that
    // dispatch to settle before counting, so a late generic toast is caught.
    await waitFor(() => expect(push).toHaveBeenCalled());
    const outcome = await dispatched.mock.results[0]!.value;
    expect(outcome.ok).toBe(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const toast = notifyMock.mock.calls[0]![0] as { title: string };
    expect(toast.title).not.toMatch(/^Couldn't run/);
    dispatched.mockRestore();
  });
});
