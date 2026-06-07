// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  respondToDialog = vi.fn();
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
