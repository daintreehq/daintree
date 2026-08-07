// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionSource } from "@shared/types/actions";

interface CapturedNotify {
  type?: string;
  title?: string;
  message?: string;
  priority?: string;
  urgent?: boolean;
  transient?: boolean;
  duration?: number;
  context?: unknown;
  action?: { label: string; onClick: () => void };
}

const notifyMock = vi.fn<(payload: CapturedNotify) => string>(() => "toast-1");
vi.mock("@/lib/notify", () => ({
  notify: (payload: CapturedNotify) => notifyMock(payload),
}));

const getEffectiveCombo = vi.fn<(actionId: string) => string | undefined>(() => "Cmd+B");
const getDisplayCombo = vi.fn<(actionId: string) => string>(() => "⌘B");
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: (actionId: string) => getEffectiveCombo(actionId),
    getDisplayCombo: (actionId: string) => getDisplayCombo(actionId),
  },
}));

import {
  KEYBOARD_LAYOUT_CONFIRMATION_LIMIT,
  keyboardLayoutBindingKey,
  usePreferencesStore,
} from "@/store/preferencesStore";
import { notifyUndoableKeyboardLayoutChange } from "../keyboardLayoutChangeFeedback";

const ACTION_ID = "nav.toggleSidebar";

function fire(overrides: Partial<Parameters<typeof notifyUndoableKeyboardLayoutChange>[0]> = {}) {
  notifyUndoableKeyboardLayoutChange({
    actionId: ACTION_ID,
    dispatchSource: "keybinding",
    changed: true,
    title: "Sidebar hidden",
    message: (displayCombo) => `${displayCombo} toggles the sidebar`,
    onUndo: () => {},
    ...overrides,
  });
}

function confirmations(): Record<string, number> {
  return usePreferencesStore.getState().keyboardLayoutConfirmationsByBinding;
}

function lastPayload(): CapturedNotify {
  const call = notifyMock.mock.calls.at(-1);
  if (!call) throw new Error("notify was not called");
  return call[0];
}

beforeEach(() => {
  notifyMock.mockClear().mockReturnValue("toast-1");
  getEffectiveCombo.mockReset().mockReturnValue("Cmd+B");
  getDisplayCombo.mockReset().mockReturnValue("⌘B");
  usePreferencesStore.setState({ keyboardLayoutConfirmationsByBinding: {} });
});

describe("notifyUndoableKeyboardLayoutChange", () => {
  it("announces a keyboard-driven change and offers a way back", () => {
    fire();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(lastPayload().action?.label).toBe("Undo");
  });

  it("attributes the change to the live display combo, not a hard-coded one", () => {
    getDisplayCombo.mockReturnValue("⌃⇧S");
    fire();

    expect(lastPayload().message).toContain("⌃⇧S");
  });

  it("routes to a shape that actually surfaces a toast", () => {
    fire();
    const payload = lastPayload();

    // A transient toast skips the inbox, so "low" priority (what any passive
    // eventKind resolves to) or a `context` both collapse it into a silent
    // drop. Asserted as the invariant rather than the literal field values.
    expect(payload.transient).toBe(true);
    expect(payload.priority).not.toBe("low");
    expect(payload.context).toBeUndefined();
  });

  it("stays time-bound, rather than inheriting the sticky default for action toasts", () => {
    // notify() makes action-bearing toasts stick forever (duration 0) unless
    // the caller sets one, which would leave a permanent "Sidebar hidden" bar.
    fire();

    const { duration } = lastPayload();
    expect(duration).toBeGreaterThan(0);
    expect(Number.isFinite(duration)).toBe(true);
  });

  it.each<ActionSource | undefined>(["user", "menu", "context-menu", "agent", "plugin", undefined])(
    "stays silent for %s dispatch, which needs no attribution",
    (dispatchSource) => {
      fire({ dispatchSource });

      expect(notifyMock).not.toHaveBeenCalled();
    }
  );

  it("stays silent when the dispatch changed nothing", () => {
    // Covers the show direction and every downstream guard that turns the
    // toggle into a no-op — the caller reports an observed transition.
    fire({ changed: false });

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("stays silent when the action has no binding to name", () => {
    getEffectiveCombo.mockReturnValue(undefined);
    fire();

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("stops announcing once the binding has been confirmed enough times", () => {
    for (let i = 0; i < KEYBOARD_LAYOUT_CONFIRMATION_LIMIT; i++) {
      fire();
    }
    expect(notifyMock).toHaveBeenCalledTimes(KEYBOARD_LAYOUT_CONFIRMATION_LIMIT);

    notifyMock.mockClear();
    fire();

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("gives a rebound shortcut a fresh allowance", () => {
    for (let i = 0; i < KEYBOARD_LAYOUT_CONFIRMATION_LIMIT; i++) {
      fire();
    }
    notifyMock.mockClear();

    getEffectiveCombo.mockReturnValue("Cmd+Shift+S");
    fire();

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("supersedes the old combo's tally instead of accumulating one key per rebind", () => {
    fire();
    getEffectiveCombo.mockReturnValue("Cmd+Shift+S");
    fire();

    expect(Object.keys(confirmations())).toEqual([
      keyboardLayoutBindingKey(ACTION_ID, "Cmd+Shift+S"),
    ]);
  });

  it("spends no allowance on a toast that never surfaced", () => {
    // Notification settings and rate limiting both drop the toast and return an
    // empty id. Counting those would retire the affordance unseen.
    notifyMock.mockReturnValue("");
    fire();

    expect(confirmations()).toEqual({});
  });

  it("treats Undo as proof the keypress was a slip and restores the allowance", () => {
    fire();
    expect(confirmations()).not.toEqual({});

    lastPayload().action?.onClick();

    expect(confirmations()).toEqual({});
  });

  it("runs the inverse exactly once however often Undo is clicked", () => {
    const onUndo = vi.fn();
    fire({ onUndo });

    const undo = lastPayload().action;
    undo?.onClick();
    undo?.onClick();

    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("clears familiarity before running the inverse, so a re-hide is announced again", () => {
    // Ordering matters: the inverse may itself re-enter this module, so the
    // allowance has to be restored by the time onUndo observes it.
    let seenDuringUndo: Record<string, number> | undefined;
    fire({ onUndo: () => (seenDuringUndo = { ...confirmations() }) });

    lastPayload().action?.onClick();

    expect(seenDuringUndo).toEqual({});
  });

  it("ignores an Undo once a later change has superseded the notice", () => {
    // Hide, show, hide again — all inside the 5s window. The first toast's
    // Undo would now reverse the user's most recent, deliberate press.
    const staleUndo = vi.fn();
    fire({ onUndo: staleUndo });
    const stale = lastPayload().action;
    fire();

    stale?.onClick();

    expect(staleUndo).not.toHaveBeenCalled();
  });

  it("still supersedes when the later change was too familiar to announce", () => {
    const staleUndo = vi.fn();
    fire({ onUndo: staleUndo });
    const stale = lastPayload().action;
    // Exhaust the allowance so the newest hide is silent but still real.
    usePreferencesStore.setState({
      keyboardLayoutConfirmationsByBinding: {
        [keyboardLayoutBindingKey(ACTION_ID, "Cmd+B")]: KEYBOARD_LAYOUT_CONFIRMATION_LIMIT,
      },
    });
    fire();

    stale?.onClick();

    expect(staleUndo).not.toHaveBeenCalled();
  });

  it("never lets a broken notification break the change that already happened", () => {
    notifyMock.mockImplementation(() => {
      throw new Error("toaster exploded");
    });

    expect(() => fire()).not.toThrow();
  });
});
