// @vitest-environment jsdom
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("Toast accessibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("restores focus to previously focused element on dismiss", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const target = document.createElement("button");
    target.textContent = "Target";
    document.body.appendChild(target);
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
    await user.click(dismissButton);

    expect(document.activeElement).toBe(target);
    document.body.removeChild(target);
  });

  it("does not steal focus on auto-dismiss", async () => {
    const target = document.createElement("button");
    target.textContent = "External";
    document.body.appendChild(target);
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
    document.body.removeChild(target);
  });

  it("includes motion-reduce classes on toast container", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast();
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("alert");
    expect(toast.className).toContain("motion-reduce:transition-none");
    expect(toast.className).toContain("motion-reduce:duration-0");
  });
});
