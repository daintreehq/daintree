// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { useWebviewDialog } from "../useWebviewDialog";

interface DialogRequestPayload {
  panelId: string;
  dialogId: string;
}

let dialogListener: ((payload: DialogRequestPayload) => void) | null = null;
let dismissListener: ((payload: { panelId: string }) => void) | null = null;
let dismissCleanup: ReturnType<typeof vi.fn>;
let respondToDialog: ReturnType<typeof vi.fn>;
let registerPanel: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  dialogListener = null;
  dismissListener = null;
  dismissCleanup = vi.fn(() => {
    dismissListener = null;
  });
  // The hook chains .catch() onto every respond, so the default must be a
  // Promise. Tests that need a specific outcome still override it with a
  // *Once mock, which takes precedence.
  respondToDialog = vi.fn().mockResolvedValue(undefined);
  registerPanel = vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(window, "electron", {
    value: {
      webview: {
        registerPanel,
        respondToDialog,
        onDialogRequest: (cb: (payload: DialogRequestPayload) => void) => {
          dialogListener = cb;
          return () => {
            dialogListener = null;
          };
        },
        onDialogDismiss: (cb: (payload: { panelId: string }) => void) => {
          dismissListener = cb;
          return dismissCleanup;
        },
      },
    },
    writable: true,
    configurable: true,
  });
});

function emitDialog(panelId: string, dialogId: string): void {
  if (!dialogListener) throw new Error("dialog listener not registered");
  dialogListener({ panelId, dialogId });
}

function emitDismiss(panelId: string): void {
  if (!dismissListener) throw new Error("dismiss listener not registered");
  dismissListener({ panelId });
}

describe("useWebviewDialog", () => {
  it("notifies the user and advances the queue when respondToDialog rejects", async () => {
    respondToDialog.mockRejectedValueOnce(new Error("IPC channel closed"));

    const { result } = renderHook(() => useWebviewDialog("panel-1", null, false));

    act(() => {
      emitDialog("panel-1", "dialog-1");
    });

    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
    });

    act(() => {
      result.current.handleDialogRespond(true, "user-input");
    });

    expect(respondToDialog).toHaveBeenCalledWith("dialog-1", true, "user-input");

    await waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        "Webview dialog response failed",
        expect.any(Error),
        expect.objectContaining({ panelId: "panel-1", dialogId: "dialog-1" })
      );
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Dialog response failed",
        priority: "high",
        duration: 0,
        context: { panelId: "panel-1" },
      })
    );

    // Notify must NOT carry an action button — no panel-reload action exists
    // in the registry, so users get the message without a misleading CTA.
    const notifyCall = vi.mocked(notify).mock.calls[0]?.[0];
    expect(notifyCall && "action" in notifyCall ? notifyCall.action : undefined).toBeUndefined();

    // Queue must advance past the failed item so the next dialog can render.
    await waitFor(() => {
      expect(result.current.currentDialog).toBeNull();
    });
  });

  it("does not notify or log on a successful respondToDialog", async () => {
    respondToDialog.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useWebviewDialog("panel-2", null, false));

    act(() => {
      emitDialog("panel-2", "dialog-2");
    });

    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-2");
    });

    act(() => {
      result.current.handleDialogRespond(false);
    });

    // Let the resolved promise flush.
    await waitFor(() => {
      expect(result.current.currentDialog).toBeNull();
    });

    expect(notify).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("clears the dialog queue on dismiss for the matching panel", async () => {
    const { result } = renderHook(() => useWebviewDialog("panel-1", null, false));

    act(() => {
      emitDialog("panel-1", "dialog-1");
      emitDialog("panel-1", "dialog-2");
    });

    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
    });

    // Guest navigated away / crashed — main sends a dismiss for this panel.
    act(() => {
      emitDismiss("panel-1");
    });

    await waitFor(() => {
      expect(result.current.currentDialog).toBeNull();
    });

    // No response was sent for the stale dialogs.
    expect(respondToDialog).not.toHaveBeenCalled();
  });

  it("ignores a dismiss for a different panel", async () => {
    const { result } = renderHook(() => useWebviewDialog("panel-1", null, false));

    act(() => {
      emitDialog("panel-1", "dialog-1");
    });

    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
    });

    act(() => {
      emitDismiss("panel-other");
    });

    // This panel's dialog is untouched.
    expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
  });

  it("unsubscribes from dismiss events on unmount", () => {
    const { unmount } = renderHook(() => useWebviewDialog("panel-1", null, false));

    expect(dismissListener).not.toBeNull();
    unmount();
    expect(dismissCleanup).toHaveBeenCalled();
    expect(dismissListener).toBeNull();
  });
});

// A queue of dialogs is one modal session: focus is captured once on the way in
// and restored once on the way out, never between queued dialogs.
describe("useWebviewDialog focus lifecycle", () => {
  let root: HTMLElement;
  let spawned: HTMLElement[] = [];

  function addButton(label: string, parent: HTMLElement = document.body): HTMLButtonElement {
    const button = document.createElement("button");
    button.textContent = label;
    parent.appendChild(button);
    spawned.push(button);
    return button;
  }

  // Stands in for the control WebviewDialog autofocuses. Closing the overlay
  // detaches it, which is what leaves document.activeElement on <body> and tells
  // the hook the dialog still owned focus — so the tests must detach it too.
  function focusOverlayControl(label: string): HTMLButtonElement {
    const control = addButton(label);
    control.focus();
    return control;
  }

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  // Removed one by one rather than wiping <body>, which would race Testing
  // Library's own container cleanup.
  afterEach(() => {
    for (const element of spawned) element.remove();
    spawned = [];
    root.remove();
  });

  it("returns focus to the element that was focused before the dialog opened", async () => {
    const opener = addButton("opener");
    opener.focus();

    const { result } = renderHook(() => useWebviewDialog("panel-1", null, false));

    act(() => {
      emitDialog("panel-1", "dialog-1");
    });
    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
    });

    const ok = focusOverlayControl("OK");

    act(() => {
      ok.remove();
      result.current.handleDialogRespond(true);
    });
    await waitFor(() => {
      expect(result.current.currentDialog).toBeNull();
    });

    expect(document.activeElement).toBe(opener);
  });

  it("does not restore or recapture focus while advancing through a queue", async () => {
    const opener = addButton("opener");
    opener.focus();

    const { result } = renderHook(() => useWebviewDialog("panel-1", null, false));

    act(() => {
      emitDialog("panel-1", "dialog-1");
      emitDialog("panel-1", "dialog-2");
    });
    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
    });

    const firstOk = focusOverlayControl("OK (dialog-1)");

    act(() => {
      result.current.handleDialogRespond(true);
    });
    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-2");
    });

    // Mid-queue the overlay is still open, so focus stays in it. Restoring here
    // would yank the user out of a dialog they still have to answer.
    expect(document.activeElement).toBe(firstOk);

    firstOk.remove();
    const secondOk = focusOverlayControl("OK (dialog-2)");

    act(() => {
      secondOk.remove();
      result.current.handleDialogRespond(false);
    });
    await waitFor(() => {
      expect(result.current.currentDialog).toBeNull();
    });

    // The opener — not either dialog's own OK button, which is what a naive
    // per-dialog recapture would have recorded.
    expect(document.activeElement).toBe(opener);
  });

  it("restores focus when the queue is dismissed rather than answered", async () => {
    const opener = addButton("opener");
    opener.focus();

    const { result } = renderHook(() => useWebviewDialog("panel-1", null, false));

    act(() => {
      emitDialog("panel-1", "dialog-1");
      emitDialog("panel-1", "dialog-2");
    });
    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
    });

    const ok = focusOverlayControl("OK");

    act(() => {
      ok.remove();
      emitDismiss("panel-1");
    });
    await waitFor(() => {
      expect(result.current.currentDialog).toBeNull();
    });

    expect(document.activeElement).toBe(opener);
    expect(respondToDialog).not.toHaveBeenCalled();
  });

  // Guest pages fire dialogs on their own schedule, so the user may well have
  // clicked into another pane before this one's queue drains.
  it("leaves focus alone when something else took it while the dialog was open", async () => {
    const opener = addButton("opener");
    opener.focus();

    const { result } = renderHook(() => useWebviewDialog("panel-1", null, false));

    act(() => {
      emitDialog("panel-1", "dialog-1");
    });
    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
    });

    const ok = focusOverlayControl("OK");
    // The user clicks into a different panel, which takes focus out of the overlay.
    const otherPane = addButton("other pane");
    otherPane.focus();

    act(() => {
      ok.remove();
      emitDismiss("panel-1");
    });
    await waitFor(() => {
      expect(result.current.currentDialog).toBeNull();
    });

    expect(document.activeElement).toBe(otherPane);
  });

  it("falls back to the app shell when the opener is gone by the time the dialog closes", async () => {
    const shellButton = addButton("shell", root);
    const opener = addButton("opener");
    opener.focus();

    const { result } = renderHook(() => useWebviewDialog("panel-1", null, false));

    act(() => {
      emitDialog("panel-1", "dialog-1");
    });
    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
    });

    const ok = focusOverlayControl("OK");
    // The page behind the dialog navigated away and took the opener with it.
    opener.remove();

    act(() => {
      ok.remove();
      result.current.handleDialogRespond(true);
    });
    await waitFor(() => {
      expect(result.current.currentDialog).toBeNull();
    });

    expect(document.activeElement).toBe(shellButton);
  });

  it("restores focus when the panel unmounts with a dialog still open", async () => {
    const opener = addButton("opener");
    opener.focus();

    const { result, unmount } = renderHook(() => useWebviewDialog("panel-1", null, false));

    act(() => {
      emitDialog("panel-1", "dialog-1");
    });
    await waitFor(() => {
      expect(result.current.currentDialog?.dialogId).toBe("dialog-1");
    });

    const ok = focusOverlayControl("OK");

    // Unmounting skips the non-empty -> empty edge entirely, so without the
    // cleanup restore, focus would be stranded on the removed OK button.
    ok.remove();
    unmount();

    expect(document.activeElement).toBe(opener);
  });

  it("does not move focus when a panel with no open dialog unmounts", () => {
    const elsewhere = addButton("elsewhere");
    elsewhere.focus();

    const { unmount } = renderHook(() => useWebviewDialog("panel-1", null, false));
    unmount();

    expect(document.activeElement).toBe(elsewhere);
  });
});
