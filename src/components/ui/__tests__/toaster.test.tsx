// @vitest-environment jsdom
import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { useNotificationStore } from "@/store/notificationStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { Toaster } from "../toaster";

vi.stubGlobal(
  "requestAnimationFrame",
  (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
);
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

function addToast(overrides: Record<string, unknown> = {}) {
  return useNotificationStore.getState().addNotification({
    type: "info",
    priority: "low",
    message: "Test message",
    duration: 5000,
    ...overrides,
  });
}

let fixtureElements: HTMLElement[] = [];

function createFixtureButton(text: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = text;
  document.body.appendChild(btn);
  fixtureElements.push(btn);
  return btn;
}

describe("Toast accessibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    for (const el of fixtureElements) {
      el.remove();
    }
    fixtureElements = [];
  });

  it("announces non-error toast via polite channel", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ type: "success", message: "Saved" });
      vi.advanceTimersByTime(16);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Saved");
    expect(useAnnouncerStore.getState().assertive).toBeNull();
  });

  it("announces error toast via assertive channel", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ type: "error", message: "Failed" });
      vi.advanceTimersByTime(16);
    });

    expect(useAnnouncerStore.getState().assertive?.msg).toBe("Failed");
  });

  it("includes title in announcement when present", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ title: "Update", message: "Ready" });
      vi.advanceTimersByTime(16);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Update: Ready");
  });

  it("uses inboxMessage fallback for ReactNode messages", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        message: (<span>Rich content</span>) as unknown as string,
        inboxMessage: "Plain text fallback",
      });
      vi.advanceTimersByTime(16);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("Plain text fallback");
  });

  it("pauses auto-dismiss timer on keyboard focus", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ duration: 1000 });
      vi.advanceTimersByTime(16);
    });

    const dismissButton = screen.getByLabelText("Dismiss notification");
    await act(async () => {
      dismissButton.focus();
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByText("Test message")).toBeTruthy();
  });

  it("resumes timer when focus leaves the toast", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ duration: 1000 });
      vi.advanceTimersByTime(16);
    });

    const dismissButton = screen.getByLabelText("Dismiss notification");

    await act(async () => {
      dismissButton.focus();
    });

    await act(async () => {
      dismissButton.blur();
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(screen.queryByText("Test message")).toBeNull();
  });

  it("stays paused when focus moves between toast children", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        duration: 1000,
        action: { label: "Undo", onClick: () => {} },
      });
      vi.advanceTimersByTime(16);
    });

    const actionButton = screen.getByText("Undo");
    const dismissButton = screen.getByLabelText("Dismiss notification");

    await act(async () => {
      actionButton.focus();
    });

    await act(async () => {
      fireEvent.blur(actionButton, { relatedTarget: dismissButton });
      fireEvent.focus(dismissButton);
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByText("Test message")).toBeTruthy();
  });

  it("restores focus to previously focused element on dismiss", async () => {
    const target = createFixtureButton("Target");
    target.focus();

    render(<Toaster />);
    await act(async () => {
      addToast();
      vi.advanceTimersByTime(16);
    });

    const dismissButton = screen.getByLabelText("Dismiss notification");
    await act(async () => {
      dismissButton.focus();
    });
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(document.activeElement).toBe(target);
  });

  it("does not steal focus on auto-dismiss", async () => {
    const target = createFixtureButton("External");
    target.focus();

    render(<Toaster />);
    await act(async () => {
      addToast({ duration: 1000 });
      vi.advanceTimersByTime(16);
    });

    expect(document.activeElement).toBe(target);

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(document.activeElement).toBe(target);
  });

  it("uses role=status for non-error toasts", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ type: "info" });
      vi.advanceTimersByTime(16);
    });

    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("uses role=alert for error toasts", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ type: "error", message: "Error occurred" });
      vi.advanceTimersByTime(16);
    });

    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("includes motion-reduce classes on toast container", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast();
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("status");
    expect(toast.className).toContain("motion-reduce:transition-none");
    expect(toast.className).toContain("motion-reduce:duration-0");
  });

  it("resets auto-dismiss timer when updatedAt changes", async () => {
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ duration: 3000, message: "Initial" });
      vi.advanceTimersByTime(16);
    });

    // Advance 2s into the 3s timer
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Initial")).toBeTruthy();

    // Update the notification — timer should reset
    await act(async () => {
      useNotificationStore.getState().updateNotification(toastId!, {
        message: "Updated",
      });
    });

    // Advance another 2s — original timer would have expired but reset timer hasn't
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Updated")).toBeTruthy();

    // Advance past the full reset duration
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText("Updated")).toBeNull();
  });

  it("fires onDismiss when the user clicks the close button", async () => {
    const onDismiss = vi.fn();
    render(<Toaster />);
    await act(async () => {
      addToast({ onDismiss });
      vi.advanceTimersByTime(16);
    });

    const dismissButton = screen.getByLabelText("Dismiss notification");
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onDismiss when the toast was programmatically dismissed (e.g. eviction)", async () => {
    const onDismiss = vi.fn();
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ onDismiss });
      vi.advanceTimersByTime(16);
    });

    // Simulate MAX_VISIBLE_TOASTS eviction: dismissed flag gets set externally,
    // without the user ever clicking the X button.
    await act(async () => {
      useNotificationStore.getState().dismissNotification(toastId!);
    });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does NOT double-fire onDismiss during the eviction fade window if the user then clicks X", async () => {
    const onDismiss = vi.fn();
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ onDismiss });
      vi.advanceTimersByTime(16);
    });

    // Eviction-style dismissal already flipped `dismissed: true`.
    await act(async () => {
      useNotificationStore.getState().dismissNotification(toastId!);
    });

    // User clicks X during the 300ms fade window before removeNotification.
    const dismissButton = screen.getByLabelText("Dismiss notification");
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("still dismisses the toast when the onDismiss handler throws synchronously", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Toaster />);
    await act(async () => {
      addToast({
        onDismiss: () => {
          throw new Error("boom");
        },
      });
      vi.advanceTimersByTime(16);
    });

    const dismissButton = screen.getByLabelText("Dismiss notification");
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    // Toast still enters the fade-out path; after the 300ms cleanup runs it
    // is removed from the store entirely.
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText("Test message")).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("re-announces via screen reader when updatedAt changes", async () => {
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ message: "1 agent done" });
      vi.advanceTimersByTime(16);
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("1 agent done");

    await act(async () => {
      useNotificationStore.getState().updateNotification(toastId!, {
        message: "2 agents done",
      });
    });

    expect(useAnnouncerStore.getState().polite?.msg).toBe("2 agents done");
  });
});
