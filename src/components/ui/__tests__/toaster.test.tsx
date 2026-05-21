// @vitest-environment jsdom
import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useUIStore } from "@/store/uiStore";
import { notify } from "@/lib/notify";
import { dispatchEscape, _resetForTests as resetEscapeStack } from "@/lib/escapeStack";
import { primeRadix } from "../radix-loader";
import { Toaster } from "../toaster";

beforeAll(async () => {
  await primeRadix();
});

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

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

  it("announces non-error toast via role=status (polite live region)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ type: "success", message: "Saved" });
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Saved");
    expect(screen.queryByRole("alert")).toBeNull();
    // The shared announcer must NOT also fire — role=status is the sole
    // live-region path so screen readers only announce once (issue #6331).
    expect(useAnnouncerStore.getState().polite).toBeNull();
    expect(useAnnouncerStore.getState().assertive).toBeNull();
  });

  it("announces error toast via role=alert (assertive live region)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ type: "error", message: "Failed" });
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("alert");
    expect(toast.textContent).toContain("Failed");
    // No redundant announcer call — role=alert is sufficient (issue #6331).
    expect(useAnnouncerStore.getState().assertive).toBeNull();
    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("renders title and message inside the live region when present", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ title: "Update", message: "Ready" });
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Update");
    expect(toast.textContent).toContain("Ready");
    expect(useAnnouncerStore.getState().polite).toBeNull();
  });

  it("uses inboxMessage as the live-region announcement for ReactNode messages", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        message: (<span>45% complete</span>) as unknown as string,
        inboxMessage: "Downloading update: 45%",
      });
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("status");
    // sr-only span carries the controlled inboxMessage for assistive tech.
    const srOnlyNode = toast.querySelector(".sr-only");
    expect(srOnlyNode?.textContent).toBe("Downloading update: 45%");
    // The visual ReactNode is aria-hidden so screen readers only hear the
    // controlled inboxMessage — not both (issue #6331).
    const visualNode = screen.getByText("45% complete").closest('[aria-hidden="true"]');
    expect(visualNode).not.toBeNull();
    // Sighted users still see the rendered JSX content.
    expect(screen.getByText("45% complete")).toBeTruthy();
    // The shared announcer must stay silent — the role node is the sole
    // live-region path (issue #6331).
    expect(useAnnouncerStore.getState().polite).toBeNull();
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

  it("applies Tier 2 enter duration and spring easing once visible (issue #6331)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast();
    });
    // rAF (mocked as setTimeout 0) flips isVisible to true; advance after the
    // first commit so the visible-state re-render lands in its own tick.
    await act(async () => {
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("status");
    expect(toast.style.transitionDuration).toBe("200ms");
    // EASE_SPRING_CRITICAL is a multi-stop linear() spring.
    expect(toast.style.transitionTimingFunction).toContain("linear(");
  });

  it("applies Tier 2 exit duration and accelerate-out easing on dismiss (issue #6331)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast();
    });
    await act(async () => {
      vi.advanceTimersByTime(16);
    });

    const dismissButton = screen.getByLabelText("Dismiss notification");
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    const toast = screen.getByRole("status");
    expect(toast.style.transitionDuration).toBe("120ms");
    expect(toast.style.transitionTimingFunction).toBe("cubic-bezier(0.2, 0, 0.7, 0)");
  });

  it("removes the toast from the DOM exactly after UI_EXIT_DURATION (issue #6331)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ message: "Boundary check" });
    });
    await act(async () => {
      vi.advanceTimersByTime(16);
    });

    const dismissButton = screen.getByLabelText("Dismiss notification");
    await act(async () => {
      fireEvent.click(dismissButton);
    });

    // Just before the 120ms exit window — toast is still mounted.
    await act(async () => {
      vi.advanceTimersByTime(119);
    });
    expect(screen.queryByText("Boundary check")).toBeTruthy();

    // Cross the exit boundary — toast is unmounted.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Boundary check")).toBeNull();
  });

  it("resets auto-dismiss timer when the message changes", async () => {
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

    // Update with a NEW message — contentKey bumps, timer resets
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

  it("does NOT reset auto-dismiss timer on count-only coalesce (issue #5863)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        duration: 3000,
        message: "Same message",
        correlationId: "entity-a",
      });
      vi.advanceTimersByTime(16);
    });

    // Advance 2s into the 3s timer
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Same message")).toBeTruthy();

    // Coalesce with the SAME message — count bumps but contentKey does not,
    // so the auto-dismiss timer must NOT restart.
    await act(async () => {
      addToast({
        duration: 3000,
        message: "Same message",
        correlationId: "entity-a",
      });
    });

    // Advance past the original deadline. If the timer had reset, the toast
    // would still be visible. With the fix it dismisses on schedule.
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText("Same message")).toBeNull();
  });

  it("persistent (duration:0) toast stays for full new duration when promoted to auto-dismiss", async () => {
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ duration: 0, message: "Copying context…" });
      vi.advanceTimersByTime(16);
    });

    // Simulate a long async operation while the toast is persistent.
    await act(async () => {
      vi.advanceTimersByTime(20000);
    });
    expect(screen.getByText("Copying context…")).toBeTruthy();

    // Operation completes; promote to auto-dismiss with a fresh duration.
    await act(async () => {
      useNotificationStore.getState().updateNotification(toastId!, {
        message: "Copied 12 files",
        duration: 3000,
      });
    });

    // The toast must remain visible for the new duration, not dismiss
    // immediately because firstShownAt was set 20s ago.
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByText("Copied 12 files")).toBeTruthy();

    // It does dismiss after the new duration elapses.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText("Copied 12 files")).toBeNull();
  });

  it("hard cap eventually dismisses toasts updated faster than their duration", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        duration: 3000,
        message: "msg-0",
        correlationId: "entity-a",
      });
      vi.advanceTimersByTime(16);
    });

    // Hard cap = min(3000 * 3, 15000) = 9000ms after firstShownAt. Drive four
    // message-changing coalesces 2000ms apart; each resets the per-update
    // timer (without the cap, the toast would live forever).
    for (let i = 1; i <= 4; i++) {
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        addToast({
          duration: 3000,
          message: `msg-${i}`,
          correlationId: "entity-a",
        });
      });
    }

    // After the 4th coalesce (~8016ms in), the capped delay collapses to
    // ~984ms instead of resetting to a fresh 3000ms.
    expect(screen.getByText("msg-4")).toBeTruthy();

    // Cross the cap; timer fires, then exit fade removes the toast.
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.queryByText(/msg-/)).toBeNull();
  });

  it("cap does NOT apply when toast has `action` with explicit non-zero duration", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        duration: 20000,
        message: "action-toast",
        action: { label: "Retry", onClick: vi.fn() },
      });
      vi.advanceTimersByTime(16);
    });

    // 16s in: a capped toast would have dismissed at 15s.
    await act(async () => {
      vi.advanceTimersByTime(16000);
    });
    expect(screen.getByText("action-toast")).toBeTruthy();

    // Cross the uncapped deadline (20s * 3 = 60s is far out; but the per-update
    // timer fires at 20s from firstShownAt).
    await act(async () => {
      vi.advanceTimersByTime(4500);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("action-toast")).toBeNull();
  });

  it("cap does NOT apply when toast has `actions: [...]` with explicit non-zero duration", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        duration: 20000,
        message: "actions-toast",
        actions: [{ label: "Undo", onClick: vi.fn() }],
      });
      vi.advanceTimersByTime(16);
    });

    await act(async () => {
      vi.advanceTimersByTime(16000);
    });
    expect(screen.getByText("actions-toast")).toBeTruthy();

    // Past the 20s explicit duration + exit fade — dismisses on schedule.
    await act(async () => {
      vi.advanceTimersByTime(4200);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("actions-toast")).toBeNull();
  });

  it("cap does NOT apply to action-bearing toast under coalesce pressure", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        duration: 3000,
        message: "action-msg-0",
        correlationId: "entity-b",
        action: { label: "Retry", onClick: vi.fn() },
      });
      vi.advanceTimersByTime(16);
    });

    // Drive four coalesces 2000ms apart. Without the cap exemption the toast
    // would be capped at 15s from firstShownAt (~9000ms of coalesce window).
    for (let i = 1; i <= 4; i++) {
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        addToast({
          duration: 3000,
          message: `action-msg-${i}`,
          correlationId: "entity-b",
          action: { label: "Retry", onClick: vi.fn() },
        });
      });
    }

    // After ~8016ms: a capped toast would collapse delay to ~984ms and dismiss
    // soon after. With the exemption the per-update timer resets each time.
    expect(screen.getByText("action-msg-4")).toBeTruthy();

    // Advance past the full uncapped duration from the last coalesce.
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText(/action-msg-/)).toBeNull();
  });

  it("empty actions array counts as no action, cap still applies", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        duration: 20000,
        message: "empty-actions",
        actions: [],
      });
      vi.advanceTimersByTime(16);
    });

    // The cap should still apply since [] has no visible buttons.
    await act(async () => {
      vi.advanceTimersByTime(15100);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("empty-actions")).toBeNull();
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

    // User clicks X during the exit fade window before removeNotification.
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

    // Toast still enters the fade-out path; after the exit cleanup runs it
    // is removed from the store entirely.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Test message")).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each([
    ["success", "lucide-circle-check", "text-status-success", "status"],
    ["error", "lucide-circle-x", "text-status-error", "alert"],
    ["info", "lucide-info", "text-status-info", "status"],
    ["warning", "lucide-triangle-alert", "text-status-warning", "status"],
  ] as const)(
    "renders a %s severity icon with the matching status colour",
    async (type, iconClass, colourClass, role) => {
      render(<Toaster />);
      await act(async () => {
        addToast({ type, message: `${type} message` });
        vi.advanceTimersByTime(16);
      });

      const toast = screen.getByRole(role);
      const icon = toast.querySelector(`.${iconClass}`);
      expect(icon).not.toBeNull();
      expect(icon?.parentElement?.className).toContain(colourClass);
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
    }
  );

  it("falls back to the info icon for unknown severity types", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ type: "fatal" as unknown as "info", message: "Unknown severity" });
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("status");
    const icon = toast.querySelector(".lucide-info");
    expect(icon).not.toBeNull();
    expect(icon?.parentElement?.className).toContain("text-status-info");
  });

  it("swaps icon, colour, and role when a toast's severity changes", async () => {
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ type: "info", message: "In progress" });
      vi.advanceTimersByTime(16);
    });

    const initialToast = screen.getByRole("status");
    expect(initialToast.textContent).toContain("In progress");
    expect(initialToast.querySelector(".lucide-info")).not.toBeNull();

    await act(async () => {
      useNotificationStore.getState().updateNotification(toastId!, {
        type: "error",
        message: "Failed",
      });
    });

    const updatedToast = screen.getByRole("alert");
    expect(updatedToast.querySelector(".lucide-circle-x")).not.toBeNull();
    expect(updatedToast.querySelector(".lucide-info")).toBeNull();
    const iconWrapper = updatedToast.querySelector(".lucide-circle-x")?.parentElement;
    expect(iconWrapper?.className).toContain("text-status-error");
  });

  it("re-announces via the live region when message content updates", async () => {
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ message: "1 agent done" });
      vi.advanceTimersByTime(16);
    });

    const initial = screen.getByRole("status");
    expect(initial.textContent).toContain("1 agent done");

    await act(async () => {
      useNotificationStore.getState().updateNotification(toastId!, {
        message: "2 agents done",
      });
    });

    // role=status mutates in place; screen readers pick up the live-region
    // change without a separate announcer call (issue #6331).
    const updated = screen.getByRole("status");
    expect(updated.textContent).toContain("2 agents done");
    expect(updated.textContent).not.toContain("1 agent done");
    expect(useAnnouncerStore.getState().polite).toBeNull();
  });
});

describe("Toast count chip overflow & live-region throttling (issue #6427)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("shows the bare ×N glyph for counts at or below 99", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ title: "Build", message: "x", count: 5 });
      vi.advanceTimersByTime(16);
    });

    const chip = screen.getByLabelText("5 events");
    expect(chip.textContent).toBe("×5");
  });

  it("caps the visible glyph at ×99+ but keeps the exact count in aria-label", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ title: "Build", message: "x", count: 150 });
      vi.advanceTimersByTime(16);
    });

    const chip = screen.getByLabelText("150 events");
    expect(chip.textContent).toBe("×99+");
  });

  it("caps the visible glyph on the no-title path", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ message: "x", count: 200 });
      vi.advanceTimersByTime(16);
    });

    const chip = screen.getByLabelText("200 events");
    expect(chip.textContent).toBe("×99+");
  });

  it("reserves a stable minimum width so the chip does not jump at the cap boundary", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ title: "Build", message: "x", count: 5 });
      vi.advanceTimersByTime(16);
    });

    const chip = screen.getByLabelText("5 events");
    expect(chip.className).toMatch(/min-w-\[3\.5ch\]/);
    expect(chip.className).toMatch(/text-center/);
  });

  it("sets aria-busy on the live region while count updates are in flight", async () => {
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ title: "Build", message: "x", count: 2 });
      vi.advanceTimersByTime(16);
    });

    await act(async () => {
      useNotificationStore.getState().updateNotification(toastId!, { count: 3 });
    });
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
  });

  it("clears aria-busy after the trailing 300ms inactivity window", async () => {
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ title: "Build", message: "x", count: 2 });
      vi.advanceTimersByTime(16);
    });

    await act(async () => {
      useNotificationStore.getState().updateNotification(toastId!, { count: 3 });
    });
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBeNull();
  });

  it("extends the aria-busy window when count updates arrive in rapid succession", async () => {
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ title: "Build", message: "x", count: 2 });
      vi.advanceTimersByTime(16);
    });

    await act(async () => {
      useNotificationStore.getState().updateNotification(toastId!, { count: 3 });
    });
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");

    // Almost-but-not-quite past the trailing window — another update lands.
    await act(async () => {
      vi.advanceTimersByTime(200);
      useNotificationStore.getState().updateNotification(toastId!, { count: 4 });
    });
    // Original 300ms timer would have fired at this point if not reset.
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");

    // Past the new trailing window.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBeNull();
  });

  it("does not set aria-busy when the toast first mounts (no churn yet)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ title: "Build", message: "x", count: 2 });
      vi.advanceTimersByTime(16);
    });

    expect(screen.getByRole("status").getAttribute("aria-busy")).toBeNull();
  });

  it("does not crash if the toast unmounts before the trailing busy timer fires", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Toaster />);
    let toastId: string;
    await act(async () => {
      toastId = addToast({ title: "Build", message: "x", count: 2 });
      vi.advanceTimersByTime(16);
    });

    await act(async () => {
      useNotificationStore.getState().updateNotification(toastId!, { count: 3 });
    });
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");

    // Dismiss within the 300ms trailing window; the busy timer must not
    // fire setState on the unmounted component.
    const dismissButton = screen.getByLabelText("Dismiss notification");
    await act(async () => {
      fireEvent.click(dismissButton);
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const stateUpdateOnUnmounted = consoleError.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("Can't perform a React state update")
    );
    expect(stateUpdateOnUnmounted).toBeUndefined();
    consoleError.mockRestore();
  });

  it("renders no chip when notification.count is non-finite", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        title: "Build",
        message: "x",
        count: Number.POSITIVE_INFINITY as unknown as number,
      });
      vi.advanceTimersByTime(16);
    });

    expect(screen.queryByLabelText(/events$/)).toBeNull();
  });
});

describe("Toast overflow menu", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
    useAnnouncerStore.setState({ polite: null, assertive: null });
    dispatchMock.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not render the options trigger when context is absent", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast();
      vi.advanceTimersByTime(16);
    });

    expect(screen.queryByLabelText("Notification options")).toBeNull();
  });

  it("does not render the options trigger when context has no projectId", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ context: { worktreeId: "wt-1" } });
      vi.advanceTimersByTime(16);
    });

    expect(screen.queryByLabelText("Notification options")).toBeNull();
  });

  it("renders the options trigger when context.projectId is set", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ context: { projectId: "p1" } });
      vi.advanceTimersByTime(16);
    });

    expect(screen.getByLabelText("Notification options")).toBeTruthy();
  });

  it("dispatches project.muteNotifications and dismisses when Mute is selected", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ context: { projectId: "p1" }, duration: 0 });
      vi.advanceTimersByTime(16);
    });

    const trigger = screen.getByLabelText("Notification options");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.pointerUp(trigger, { button: 0 });
      fireEvent.click(trigger);
      vi.advanceTimersByTime(16);
    });

    const muteItem = screen.getByText("Mute project notifications");
    await act(async () => {
      fireEvent.click(muteItem);
      vi.advanceTimersByTime(16);
    });

    expect(dispatchMock).toHaveBeenCalledWith("project.muteNotifications", {
      projectId: "p1",
    });
  });
});

// Regression coverage for issue #5859 — toasts must dismiss based on severity,
// not the old 3s render-layer fallback. Routes through notify() so the
// severity-based defaults are exercised end-to-end.
describe("Toast severity-based dismissal (issue #5859)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    useNotificationSettingsStore.setState({
      enabled: true,
      hydrated: true,
      quietHoursEnabled: false,
      quietHoursStartMin: 22 * 60,
      quietHoursEndMin: 8 * 60,
      quietHoursWeekdays: [],
    });
    useAnnouncerStore.setState({ polite: null, assertive: null });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("error toast survives past the old 3s fallback", async () => {
    render(<Toaster />);
    await act(async () => {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Something failed" });
      vi.advanceTimersByTime(16);
    });

    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.getByText("Something failed")).toBeTruthy();
  });

  it("error toast dismisses around the 12s severity default", async () => {
    render(<Toaster />);
    await act(async () => {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({ type: "error", message: "Failed once" });
      vi.advanceTimersByTime(16);
    });

    // Just before 12s — still visible.
    await act(async () => {
      vi.advanceTimersByTime(11500);
    });
    expect(screen.getByText("Failed once")).toBeTruthy();

    // Past 12s + the exit fade — gone.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Failed once")).toBeNull();
  });

  it("success toast dismisses around the 5s severity default", async () => {
    render(<Toaster />);
    await act(async () => {
      notify({ type: "success", message: "Saved!" });
      vi.advanceTimersByTime(16);
    });

    // Just before 5s — still visible.
    await act(async () => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.getByText("Saved!")).toBeTruthy();

    // Past 5s + the exit fade — gone.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Saved!")).toBeNull();
  });

  it("direct addNotification without duration stays sticky (no instant-dismiss)", async () => {
    // Documents the renderer's guard for callers that bypass notify().
    render(<Toaster />);
    await act(async () => {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      useNotificationStore.getState().addNotification({
        type: "error",
        priority: "high",
        message: "Stuck",
      });
      vi.advanceTimersByTime(16);
    });

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Stuck")).toBeTruthy();
  });

  describe("dev guard — inboxMessage invariant", () => {
    it("logs dev guard when non-string message has no inboxMessage", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      render(<Toaster />);
      const jsxElement = React.createElement("span", null, "rich");
      await act(async () => {
        addToast({ message: jsxElement as unknown as React.ReactNode });
        vi.advanceTimersByTime(16);
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[Toaster] non-string message without inboxMessage"),
        expect.anything()
      );
      consoleSpy.mockRestore();
    });

    it("does NOT log toaster guard when non-string message has inboxMessage", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      render(<Toaster />);
      const jsxElement = React.createElement("span", null, "rich");
      await act(async () => {
        addToast({
          message: jsxElement as unknown as React.ReactNode,
          inboxMessage: "Fallback text",
        });
        vi.advanceTimersByTime(16);
      });

      const toasterGuardCall = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("[Toaster]")
      );
      expect(toasterGuardCall).toBeUndefined();
      consoleSpy.mockRestore();
    });

    it("does NOT log toaster guard for string message without inboxMessage", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      render(<Toaster />);
      await act(async () => {
        addToast({ message: "Plain string" });
        vi.advanceTimersByTime(16);
      });

      const toasterGuardCall = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("[Toaster]")
      );
      expect(toasterGuardCall).toBeUndefined();
      consoleSpy.mockRestore();
    });
  });
});

// Issue #6424 — when MAX_VISIBLE_TOASTS evicts a toast into the inbox, surface
// a "+N more" pill below the visible stack so users can discover that
// notifications were silently moved instead of disappearing.
describe("Toast overflow pill (issue #6424)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
    useNotificationHistoryStore.setState({
      entries: [],
      unreadCount: 0,
      evictedToInboxCount: 0,
    });
    useUIStore.setState({ notificationCenterOpen: false });
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not render the pill when nothing has been evicted", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast();
      vi.advanceTimersByTime(16);
    });
    expect(screen.queryByTestId("toast-overflow-pill")).toBeNull();
  });

  it("renders +1 more after a single eviction", async () => {
    render(<Toaster />);
    await act(async () => {
      useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
    });
    const pill = screen.getByTestId("toast-overflow-pill");
    expect(pill.textContent).toBe("+1 more");
    expect(pill.getAttribute("aria-live")).toBeNull();
    expect(pill.getAttribute("aria-label")).toBe("1 more in notification center");
  });

  it("renders the cumulative count for multiple evictions", async () => {
    render(<Toaster />);
    await act(async () => {
      useNotificationHistoryStore.setState({ evictedToInboxCount: 4 });
    });
    expect(screen.getByTestId("toast-overflow-pill").textContent).toBe("+4 more");
  });

  it("opens the notification center and clears the count when clicked", async () => {
    render(<Toaster />);
    await act(async () => {
      useNotificationHistoryStore.setState({ evictedToInboxCount: 2 });
    });

    const pill = screen.getByTestId("toast-overflow-pill");
    await act(async () => {
      fireEvent.click(pill);
    });

    expect(useUIStore.getState().notificationCenterOpen).toBe(true);
    expect(useNotificationHistoryStore.getState().evictedToInboxCount).toBe(0);
    expect(screen.queryByTestId("toast-overflow-pill")).toBeNull();
  });

  it("uses neutral surface tokens and does not paint the accent colour", async () => {
    render(<Toaster />);
    await act(async () => {
      useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
    });
    const pill = screen.getByTestId("toast-overflow-pill");
    expect(pill.className).toContain("bg-surface-panel");
    expect(pill.className).not.toContain("bg-daintree-accent");
    expect(pill.className).not.toContain("text-accent-primary");
  });

  it("renders the pill end-to-end when MAX_VISIBLE_TOASTS evicts a real toast", async () => {
    render(<Toaster />);
    // Seed a history entry that's currently 'seenAsToast' (i.e., visible as a
    // toast) and link a toast to it via historyEntryId. When the cap is hit
    // and this toast is evicted, markUnseenAsToast fires and the eviction
    // counter increments — the pill should appear without any direct
    // setState fakery.
    const evictableHistoryId = useNotificationHistoryStore.getState().addEntry({
      type: "info",
      message: "first",
      seenAsToast: true,
    });

    await act(async () => {
      addToast({ message: "first", historyEntryId: evictableHistoryId });
      addToast({ message: "second" });
      addToast({ message: "third" });
      vi.advanceTimersByTime(16);
    });
    expect(screen.queryByTestId("toast-overflow-pill")).toBeNull();

    // The fourth toast pushes the cap and evicts 'first' (oldest non-error).
    await act(async () => {
      addToast({ message: "fourth" });
      vi.advanceTimersByTime(16);
    });

    // History counter incremented through the real eviction path.
    expect(useNotificationHistoryStore.getState().evictedToInboxCount).toBe(1);
    const pill = screen.getByTestId("toast-overflow-pill");
    expect(pill.textContent).toBe("+1 more");
  });

  it("does NOT increment the counter when the notification center is open during eviction", async () => {
    render(<Toaster />);
    // Open the notification center BEFORE evicting — the user is already
    // looking at the inbox, so signaling the arrival twice is contradictory.
    useUIStore.setState({ notificationCenterOpen: true });

    const evictableHistoryId = useNotificationHistoryStore.getState().addEntry({
      type: "info",
      message: "first",
      seenAsToast: true,
    });

    await act(async () => {
      addToast({ message: "first", historyEntryId: evictableHistoryId });
      addToast({ message: "second" });
      addToast({ message: "third" });
      addToast({ message: "fourth" });
      vi.advanceTimersByTime(16);
    });

    // Eviction fired (the entry is now unseen) but the cue counter did not.
    expect(useNotificationHistoryStore.getState().entries[0]!.seenAsToast).toBe(false);
    expect(useNotificationHistoryStore.getState().evictedToInboxCount).toBe(0);
    expect(screen.queryByTestId("toast-overflow-pill")).toBeNull();
  });

  it("renders the pill even when no toasts are currently visible", async () => {
    // Models the steady state after every visible toast has auto-dismissed
    // but the eviction counter is still > 0 — the cue must persist until the
    // user opens the notification center, otherwise the affordance vanishes
    // before they can act on it.
    render(<Toaster />);
    await act(async () => {
      useNotificationHistoryStore.setState({ evictedToInboxCount: 1 });
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("toast-overflow-pill")).toBeTruthy();
  });
});

describe("Toast success dwell — 2000ms (issue #6844)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("success label dwells for ~2000ms before auto-dismissing (synchronous onClick)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        message: "Settings saved",
        action: {
          label: "Undo",
          onClick: () => {},
          successLabel: "Undone",
        },
      });
      vi.advanceTimersByTime(16);
    });

    const actionButton = screen.getByText("Undo");
    await act(async () => {
      fireEvent.click(actionButton);
    });

    await act(async () => {
      vi.advanceTimersByTime(1900);
    });
    expect(screen.getByText("Undone")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Undone")).toBeNull();
  });

  it("does NOT dismiss before the 2000ms dwell elapses (synchronous)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        message: "File copied",
        action: {
          label: "Open",
          onClick: () => {},
          successLabel: "Opened",
        },
      });
      vi.advanceTimersByTime(16);
    });

    const actionButton = screen.getByText("Open");
    await act(async () => {
      fireEvent.click(actionButton);
    });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Opened")).toBeTruthy();
  });

  it("success label dwells for ~2000ms before auto-dismissing (async onClick)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        message: "Processing…",
        action: {
          label: "Retry",
          onClick: () => Promise.resolve(),
          successLabel: "Retried",
        },
      });
      vi.advanceTimersByTime(16);
    });

    const actionButton = screen.getByText("Retry");
    await act(async () => {
      fireEvent.click(actionButton);
      await Promise.resolve();
      vi.advanceTimersByTime(16);
    });

    await act(async () => {
      vi.advanceTimersByTime(1900);
    });
    expect(screen.getByText("Retried")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Retried")).toBeNull();
  });

  it("action without successLabel dismisses immediately on click (no dwell)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        duration: 0,
        message: "Quick action",
        action: { label: "Dismiss", onClick: () => {} },
      });
      vi.advanceTimersByTime(16);
    });

    const actionButton = screen.getByText("Dismiss");
    await act(async () => {
      fireEvent.click(actionButton);
      vi.advanceTimersByTime(16);
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Quick action")).toBeNull();
  });
});

describe("Toast a11y, focus, and ergonomics polish (issue #7238)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0, evictedToInboxCount: 0 });
    useAnnouncerStore.setState({ polite: null, assertive: null });
    resetEscapeStack();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    resetEscapeStack();
    for (const el of fixtureElements) {
      el.remove();
    }
    fixtureElements = [];
  });

  it("renders the portal container as a labeled landmark region", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ message: "Hello" });
      vi.advanceTimersByTime(16);
    });
    const region = screen.getByRole("region", { name: /notifications/i });
    expect(region).toBeTruthy();
  });

  it("Escape dismisses the topmost toast first (LIFO)", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ message: "first" });
      vi.advanceTimersByTime(16);
    });
    await act(async () => {
      addToast({ message: "second" });
      vi.advanceTimersByTime(16);
    });
    await act(async () => {
      addToast({ message: "third" });
      vi.advanceTimersByTime(16);
    });

    expect(screen.getByText("third")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.getByText("first")).toBeTruthy();

    // First Escape dismisses the newest (third).
    await act(async () => {
      dispatchEscape();
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("third")).toBeNull();
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.getByText("first")).toBeTruthy();

    // Second Escape dismisses second.
    await act(async () => {
      dispatchEscape();
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("second")).toBeNull();
    expect(screen.getByText("first")).toBeTruthy();

    // Third Escape dismisses first.
    await act(async () => {
      dispatchEscape();
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("first")).toBeNull();
  });

  it("mouseLeave grace does not unpause while focus stays inside the toast", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ duration: 1000, message: "stay" });
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("status");
    // Hover, then keyboard-focus the dismiss button while still hovered.
    fireEvent.mouseEnter(toast);
    const closeBtn = screen.getByLabelText("Dismiss notification");
    fireEvent.focus(closeBtn);
    // Pointer leaves; grace timer starts.
    fireEvent.mouseLeave(toast);
    // Past the 500ms grace window, hover-pause clears but focus-pause holds.
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    // Past the toast's 1000ms duration; without focus-pause it would dismiss.
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText("stay")).toBeTruthy();
  });

  it("mouseLeave grace cancels when the cursor re-enters", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ duration: 600, message: "linger" });
      vi.advanceTimersByTime(16);
    });

    const toast = screen.getByRole("status");
    fireEvent.mouseEnter(toast);
    fireEvent.mouseLeave(toast);
    // Re-enter before the 500ms grace fires.
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.mouseEnter(toast);
    // Now wait well past the original grace + dismiss; toast must persist.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("linger")).toBeTruthy();
  });

  it("restoreFocus skips focus when the previous element has been disconnected", async () => {
    const external = createFixtureButton("external");
    external.focus();
    expect(document.activeElement).toBe(external);

    render(<Toaster />);
    await act(async () => {
      addToast({ message: "with-focus" });
      vi.advanceTimersByTime(16);
    });

    // Focus the toast's dismiss button so restoreFocus has somewhere to send focus from.
    const closeBtn = screen.getByLabelText("Dismiss notification");
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);

    // Detach the external button before dismissing.
    external.remove();

    // Trigger dismiss; restoreFocus must short-circuit on the disconnected node.
    expect(() => {
      fireEvent.click(closeBtn);
    }).not.toThrow();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    // Focus should not have landed back on the detached element.
    expect(document.activeElement).not.toBe(external);
  });

  it("count-bump class clears via the 200ms timeout fallback when animationend never fires", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({ title: "Updates", message: "ready", count: 1 });
      vi.advanceTimersByTime(16);
    });

    // Advance the count — sets isCountBumping=true.
    await act(async () => {
      const id = useNotificationStore.getState().notifications[0]!.id;
      useNotificationStore.getState().updateNotification(id, { count: 2 });
      vi.advanceTimersByTime(16);
    });
    const chip = screen.getByLabelText(/2 events/i) as HTMLElement;
    expect(chip.className).toContain("animate-badge-bump");

    // Without firing onAnimationEnd, the 200ms safety fallback must clear it.
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    const chipAfter = screen.getByLabelText(/2 events/i) as HTMLElement;
    expect(chipAfter.className).not.toContain("animate-badge-bump");
  });
});

describe("Toast action variant rendering (issue #7595)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().reset();
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0, evictedToInboxCount: 0 });
    useAnnouncerStore.setState({ polite: null, assertive: null });
    resetEscapeStack();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    resetEscapeStack();
    for (const el of fixtureElements) {
      el.remove();
    }
    fixtureElements = [];
  });

  it("renders primary action with the tonal info fill", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        actions: [{ label: "Primary", variant: "primary", onClick: vi.fn() }],
      });
      vi.advanceTimersByTime(16);
    });

    const button = screen.getByRole("button", { name: "Primary" });
    expect(button.className).toContain("bg-status-info/10");
    expect(button.className).toContain("text-status-info");
  });

  it("renders secondary action as text-only — no fill, no border", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        actions: [{ label: "Secondary", variant: "secondary", onClick: vi.fn() }],
      });
      vi.advanceTimersByTime(16);
    });

    const button = screen.getByRole("button", { name: "Secondary" });
    expect(button.className).not.toContain("bg-status-info/10");
    expect(button.className).not.toContain("text-status-info");
    expect(button.className).not.toMatch(/\bborder\b/);
    expect(button.className).toContain("text-daintree-text/70");
    expect(button.className).toContain("hover:bg-tint/10");
  });

  it("defaults to primary when variant is omitted", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        actions: [{ label: "Default", onClick: vi.fn() }],
      });
      vi.advanceTimersByTime(16);
    });

    const button = screen.getByRole("button", { name: "Default" });
    expect(button.className).toContain("bg-status-info/10");
    expect(button.className).toContain("text-status-info");
  });

  it("renders mixed primary+secondary actions distinctly in the same toast", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        actions: [
          { label: "Confirm", variant: "primary", onClick: vi.fn() },
          { label: "Cancel", variant: "secondary", onClick: vi.fn() },
        ],
      });
      vi.advanceTimersByTime(16);
    });

    const confirm = screen.getByRole("button", { name: "Confirm" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(confirm.className).toContain("bg-status-info/10");
    expect(cancel.className).not.toContain("bg-status-info/10");
    expect(cancel.className).toContain("text-daintree-text/70");
  });

  it("dimmed secondary action retains opacity-50, stays disabled, and ignores clicks", async () => {
    let resolvePrimary: () => void = () => {};
    const primaryClick = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolvePrimary = res;
        })
    );
    const cancelClick = vi.fn();

    render(<Toaster />);
    await act(async () => {
      addToast({
        actions: [
          {
            label: "Confirm",
            variant: "primary",
            successLabel: "Confirmed",
            onClick: primaryClick,
          },
          { label: "Cancel", variant: "secondary", onClick: cancelClick },
        ],
      });
      vi.advanceTimersByTime(16);
    });

    const confirm = screen.getByRole("button", { name: "Confirm" });
    fireEvent.click(confirm);

    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.className).toContain("opacity-50");
    expect(cancel.className).toContain("pointer-events-none");
    // Still carries the secondary text-only styling under the dim.
    expect(cancel.className).toContain("text-daintree-text/70");
    expect(cancel.className).not.toContain("bg-status-info/10");
    // Behavioral inertness: HTML `disabled` is the real guard (CSS
    // pointer-events doesn't block fireEvent in JSDOM). Confirm both.
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(cancelClick).not.toHaveBeenCalled();

    // Cleanup the in-flight promise so afterEach timers settle.
    resolvePrimary();
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
  });

  it("legacy singular `action` honors variant: secondary", async () => {
    render(<Toaster />);
    await act(async () => {
      addToast({
        action: { label: "Mute", variant: "secondary", onClick: vi.fn() },
      });
      vi.advanceTimersByTime(16);
    });

    const button = screen.getByRole("button", { name: "Mute" });
    expect(button.className).toContain("text-daintree-text/70");
    expect(button.className).not.toContain("bg-status-info/10");
  });
});
