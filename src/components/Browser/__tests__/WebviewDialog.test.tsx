// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WebviewDialog, type WebviewDialogRequest } from "../WebviewDialog";

const baseAlert: WebviewDialogRequest = {
  dialogId: "dlg-1",
  panelId: "browser-panel-1",
  type: "alert",
  message: "Something happened",
  defaultValue: "",
};

const basePrompt: WebviewDialogRequest = {
  dialogId: "dlg-2",
  panelId: "browser-panel-1",
  type: "prompt",
  message: "Enter a value",
  defaultValue: "default",
};

describe("WebviewDialog accessibility", () => {
  it("inner panel has dialog role, aria-modal, and is focusable", () => {
    const { container } = render(<WebviewDialog dialog={baseAlert} onRespond={vi.fn()} />);
    const panel = container.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    expect(panel?.getAttribute("tabindex")).toBe("-1");
  });

  it("aria-labelledby points at the message paragraph id", () => {
    const { container } = render(<WebviewDialog dialog={baseAlert} onRespond={vi.fn()} />);
    const panel = container.querySelector('[role="dialog"]');
    const labelledBy = panel?.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const labelEl = container.querySelector(`[id="${labelledBy}"]`);
    expect(labelEl?.textContent).toBe("Something happened");
  });

  it("renders nothing when dialog is null", () => {
    const { container } = render(<WebviewDialog dialog={null} onRespond={vi.fn()} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Tab on the last focusable element cycles to the first", () => {
    const { container } = render(<WebviewDialog dialog={basePrompt} onRespond={vi.fn()} />);
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], input:not([disabled]):not([type="hidden"]), button:not([disabled]), [tabindex]:not([tabindex^="-"])'
    );
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    last.focus();
    expect(document.activeElement).toBe(last);

    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(document.activeElement).toBe(first);
  });

  it("Shift+Tab on the first focusable element cycles to the last", () => {
    const { container } = render(<WebviewDialog dialog={basePrompt} onRespond={vi.fn()} />);
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], input:not([disabled]):not([type="hidden"]), button:not([disabled]), [tabindex]:not([tabindex^="-"])'
    );
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    first.focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(document.activeElement).toBe(last);
  });

  it("Tab pulls focus back into the dialog when active element is outside", () => {
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    try {
      const { container } = render(<WebviewDialog dialog={basePrompt} onRespond={vi.fn()} />);
      const panel = container.querySelector('[role="dialog"]') as HTMLElement;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), button:not([disabled])'
      );
      const first = focusables[0]!;

      outside.focus();
      expect(document.activeElement).toBe(outside);

      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      act(() => {
        window.dispatchEvent(event);
      });
      expect(document.activeElement).toBe(first);
    } finally {
      document.body.removeChild(outside);
    }
  });

  it("prompt input has aria-describedby pointing at the message", () => {
    const { container } = render(<WebviewDialog dialog={basePrompt} onRespond={vi.fn()} />);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const labelEl = container.querySelector(`[id="${describedBy}"]`);
    expect(labelEl?.textContent).toBe("Enter a value");
  });

  // VoiceOver drops live-region updates from outside the focused aria-modal
  // subtree (Chromium 354736464), so a co-located announcer is required here.
  it("co-locates non-focusable live regions inside the aria-modal panel", () => {
    const { container } = render(<WebviewDialog dialog={baseAlert} onRespond={vi.fn()} />);
    const panel = container.querySelector('[aria-modal="true"]');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(panel!.querySelector('[aria-live="assertive"]')).not.toBeNull();

    for (const region of panel!.querySelectorAll("[aria-live]")) {
      const tabindex = region.getAttribute("tabindex");
      expect(tabindex === null || Number(tabindex) < 0).toBe(true);
    }
  });
});
