// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMainProcessToastListener } from "../useMainProcessToastListener";
import { useDistributionStore } from "@/store/distributionStore";
import type { NotifyPayload } from "@/lib/notify";

const notifyMock = vi.fn<(payload: NotifyPayload) => string>().mockReturnValue("toast-id");

vi.mock("@/lib/notify", () => ({
  notify: (...args: [NotifyPayload]) => notifyMock(...args),
}));

type ToastCallback = (payload: {
  type: "success" | "error" | "info" | "warning";
  title?: string;
  message: string;
  duration?: number;
  rateLimitKey?: string;
  priority?: "high" | "low" | "watch";
  action?: { label: string; ipcChannel: string; data?: string };
}) => void;

let capturedCallback: ToastCallback | null = null;
const cleanupFn = vi.fn();
// Typed rather than `vi.fn()` so reading `mock.calls[0][0]` yields a `string`
// without an assertion — casts on mock reads regress the lint ratchet.
const openExternalMock = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());

describe("useMainProcessToastListener", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    useDistributionStore.setState({ isWindowsStore: false });
    capturedCallback = null;
    cleanupFn.mockClear();
    notifyMock.mockClear();
    openExternalMock.mockClear();

    window.electron = {
      notification: {
        onShowToast: vi.fn((cb: ToastCallback) => {
          capturedCallback = cb;
          return cleanupFn;
        }),
      },
      system: { openExternal: openExternalMock },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("subscribes to onShowToast on mount and cleans up on unmount", () => {
    const { unmount } = renderHook(() => useMainProcessToastListener());

    expect(window.electron.notification.onShowToast).toHaveBeenCalledTimes(1);
    expect(capturedCallback).toBeInstanceOf(Function);

    unmount();
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it("calls notify with correct payload for a simple toast", () => {
    renderHook(() => useMainProcessToastListener());

    act(() => {
      capturedCallback!({
        type: "success",
        title: "CLI installed",
        message: "The daintree command is now available",
      });
    });

    expect(notifyMock).toHaveBeenCalledWith({
      type: "success",
      title: "CLI installed",
      message: "The daintree command is now available",
      rateLimitKey: undefined,
      action: undefined,
    });
  });

  it("threads rateLimitKey through to notify when provided", () => {
    renderHook(() => useMainProcessToastListener());

    act(() => {
      capturedCallback!({
        type: "error",
        title: "Cloud resource may still be running",
        message: "Teardown failed",
        rateLimitKey: "cloud-teardown-failure",
      });
    });

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimitKey: "cloud-teardown-failure" })
    );
  });

  it("threads priority through to notify (low → inbox-only)", () => {
    renderHook(() => useMainProcessToastListener());

    act(() => {
      capturedCallback!({
        type: "warning",
        title: "Plugin blocked",
        message: "acme.bad was blocked from loading",
        priority: "low",
      });
    });

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "low" }));
  });

  it("threads duration through to notify when provided", () => {
    renderHook(() => useMainProcessToastListener());

    act(() => {
      capturedCallback!({
        type: "info",
        message: "acme.linear: Synced",
        duration: 3000,
      });
    });

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ duration: 3000 }));
  });

  it("calls notify with an action that triggers checkForUpdates", () => {
    const checkForUpdatesMock = vi.fn(() => Promise.resolve());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.electron as any).update = {
      checkForUpdates: checkForUpdatesMock,
    };

    renderHook(() => useMainProcessToastListener());

    act(() => {
      capturedCallback!({
        type: "error",
        title: "Update failed",
        message: "Network error",
        action: { label: "Retry", ipcChannel: "update:check-for-updates" },
      });
    });

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Update failed",
        action: expect.objectContaining({ label: "Retry" }),
      })
    );

    // Click the action button
    const call = notifyMock.mock.calls[0]![0];
    call.action!.onClick();
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it("ignores update retry toast actions on Windows Store builds", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    useDistributionStore.setState({ isWindowsStore: true });
    const checkForUpdatesMock = vi.fn(() => Promise.resolve());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.electron as any).update = {
      checkForUpdates: checkForUpdatesMock,
    };

    renderHook(() => useMainProcessToastListener());

    act(() => {
      capturedCallback!({
        type: "error",
        title: "Update failed",
        message: "Network error",
        action: { label: "Retry", ipcChannel: "update:check-for-updates" },
      });
    });

    const call = notifyMock.mock.calls[0]![0];
    call.action!.onClick();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  // The manual-download recovery action on the failed-install toast (#11481).
  // This branch is the boundary that turns a main-process toast payload into a
  // browser navigation, so it must stay pinned to our own origin.
  describe("system:open-external action", () => {
    function mountWithOpenExternal() {
      renderHook(() => useMainProcessToastListener());
      return openExternalMock;
    }

    function clickActionWith(data: string | undefined) {
      act(() => {
        capturedCallback!({
          type: "error",
          title: "Update didn't install",
          message: "Daintree is still on 0.28.1",
          action: { label: "Download manually", ipcChannel: "system:open-external", data },
        });
      });
      const call = notifyMock.mock.calls[notifyMock.mock.calls.length - 1]![0];
      void call.action!.onClick();
    }

    it("opens a trusted https daintree.org URL through the system bridge", () => {
      mountWithOpenExternal();

      clickActionWith("https://daintree.org/download");

      expect(openExternalMock).toHaveBeenCalledTimes(1);
      // Asserts the hook forwards the SAME origin+path it was given, without
      // asserting the literal the main process happens to send today.
      const opened = new URL(openExternalMock.mock.calls[0]![0]);
      expect(opened.protocol).toBe("https:");
      expect(opened.hostname).toBe("daintree.org");
      expect(opened.pathname).toBe("/download");
    });

    it("accepts a daintree.org subdomain but not a lookalike suffix", () => {
      mountWithOpenExternal();

      clickActionWith("https://www.daintree.org/download");
      expect(openExternalMock).toHaveBeenCalledTimes(1);

      clickActionWith("https://notdaintree.org/download");
      clickActionWith("https://daintree.org.evil.test/download");
      // Both lookalikes are refused, so the count is unchanged from the one
      // legitimate subdomain call above.
      expect(openExternalMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["the default https port spelled out", "https://daintree.org:443/download"],
      ["an uppercase host", "https://DAINTREE.ORG/download"],
      // Chromium normalizes the backslash to a path separator, so the host is
      // still ours — opening it is correct, not a bypass.
      ["a backslash the parser folds into the path", "https://daintree.org\\@evil.test/download"],
    ])("still opens %s", (_label, data) => {
      mountWithOpenExternal();

      clickActionWith(data);

      expect(openExternalMock).toHaveBeenCalledTimes(1);
      expect(new URL(openExternalMock.mock.calls[0]![0]).hostname).toBe("daintree.org");
    });

    it.each([
      ["missing data", undefined],
      ["a non-URL string", "not a url"],
      ["a protocol-relative URL", "//daintree.org/download"],
      ["plain http", "http://daintree.org/download"],
      ["a javascript: payload", "javascript:alert(1)"],
      ["a file: payload", "file:///etc/passwd"],
      // Host is evil.test — the userinfo only LOOKS like our domain.
      ["a trusted-looking username", "https://daintree.org@evil.test/download"],
      // Host really is ours, so only the credential guard rejects these two.
      ["credentials on a trusted host", "https://evil.test@daintree.org/download"],
      ["a password on a trusted host", "https://u:pw@daintree.org/download"],
      ["a non-default port", "https://daintree.org:8443/download"],
      ["an unrelated host", "https://evil.test/download"],
      ["our domain only in the query", "https://evil.test/?x=daintree.org"],
      ["a punycode homograph", "https://xn--dintree-n1a.org/download"],
      ["a trailing-dot host", "https://daintree.org./download"],
    ])("refuses to open %s", (_label, data) => {
      mountWithOpenExternal();

      clickActionWith(data);

      expect(openExternalMock).not.toHaveBeenCalled();
    });

    it("stays inert when the toast names an unknown ipc channel", () => {
      mountWithOpenExternal();

      act(() => {
        capturedCallback!({
          type: "error",
          message: "Anything",
          action: { label: "Go", ipcChannel: "shell:execute", data: "https://daintree.org" },
        });
      });
      const call = notifyMock.mock.calls[notifyMock.mock.calls.length - 1]![0];
      void call.action!.onClick();

      expect(openExternalMock).not.toHaveBeenCalled();
    });
  });

  it("does not crash when window.electron is undefined", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    expect(() => renderHook(() => useMainProcessToastListener())).not.toThrow();
  });
});
