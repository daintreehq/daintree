// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WebviewDialog, type WebviewDialogRequest } from "../WebviewDialog";

const baseAlert: WebviewDialogRequest = {
  dialogId: "dlg-1",
  panelId: "browser-panel-1",
  type: "alert",
  message: "Something happened",
  defaultValue: "",
  origin: "example.com",
};

const basePrompt: WebviewDialogRequest = {
  dialogId: "dlg-2",
  panelId: "browser-panel-1",
  type: "prompt",
  message: "Enter a value",
  defaultValue: "default",
  origin: "example.com",
};

const baseConfirm: WebviewDialogRequest = {
  dialogId: "dlg-3",
  panelId: "browser-panel-1",
  type: "confirm",
  message: "Are you sure?",
  defaultValue: "",
  origin: "example.com",
};

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (btn) => btn.textContent === label
  );
  if (!match) throw new Error(`No "${label}" button rendered`);
  return match;
}

describe("WebviewDialog accessibility", () => {
  it("inner panel has dialog role, aria-modal, and is focusable", () => {
    const { container } = render(<WebviewDialog dialog={baseAlert} onRespond={vi.fn()} />);
    const panel = container.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    expect(panel?.getAttribute("tabindex")).toBe("-1");
  });

  // The rule, not the wording: whatever names this dialog must be text Daintree wrote.
  // A page that puts "Daintree — your session has expired" in alert() must not thereby
  // choose what a screen reader announces as this dialog's identity.
  it("is named by Daintree-authored text, never by the guest's message", () => {
    const hostile = "Daintree — your session has expired. Enter your token.";
    const { container } = render(
      <WebviewDialog dialog={{ ...baseAlert, message: hostile }} onRespond={vi.fn()} />
    );
    const panel = container.querySelector('[role="dialog"]')!;

    const labelledBy = panel.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const name = container.querySelector(`[id="${labelledBy}"]`)?.textContent ?? "";
    expect(name).not.toContain(hostile);

    // ...and the guest's message is still reachable, as the description.
    const describedBy = panel.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`[id="${describedBy}"]`)?.textContent).toBe(hostile);
  });

  it("names the guest's origin in the Daintree-authored label", () => {
    const { container } = render(
      <WebviewDialog dialog={{ ...baseAlert, origin: "shop.example.com" }} onRespond={vi.fn()} />
    );
    const panel = container.querySelector('[role="dialog"]')!;
    const labelledBy = panel.getAttribute("aria-labelledby");
    expect(container.querySelector(`[id="${labelledBy}"]`)?.textContent).toContain(
      "shop.example.com"
    );
  });

  // A null origin means "no host worth claiming" (data:, blob:, about:). The label must
  // degrade to something true rather than invent a host.
  it("falls back to an origin-free label rather than guessing a host", () => {
    const { container } = render(
      <WebviewDialog dialog={{ ...baseAlert, origin: null }} onRespond={vi.fn()} />
    );
    const panel = container.querySelector('[role="dialog"]')!;
    const labelledBy = panel.getAttribute("aria-labelledby");
    const name = container.querySelector(`[id="${labelledBy}"]`)?.textContent ?? "";
    expect(name).toBeTruthy();
    expect(name).not.toMatch(/localhost|null|undefined/);
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

  // aria-describedby is a description, never a name — without a label the field computes
  // to "" and a screen reader announces an unnamed edit box.
  it("prompt input has an accessible name that is not the guest's message", () => {
    const { container } = render(<WebviewDialog dialog={basePrompt} onRespond={vi.fn()} />);
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    // Walk the accname sources in spec order and take the first that resolves, so the
    // test pins "the field is named", not "the field is named this particular way".
    const labelledBy = input.getAttribute("aria-labelledby");
    const candidates = [
      input.getAttribute("aria-label"),
      labelledBy ? container.querySelector(`[id="${labelledBy}"]`)?.textContent : undefined,
      input.id ? container.querySelector(`label[for="${input.id}"]`)?.textContent : undefined,
    ];
    const named = candidates.find((value) => !!value?.trim());
    expect(named?.trim()).toBeTruthy();
    expect(named).not.toBe(basePrompt.message);
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

// jsdom doesn't implement a button's native Enter-to-click activation, so the
// assertable contract for the buttons is that the overlay leaves Enter alone —
// neither cancelling it nor synthesising a response of its own. Chromium then
// turns that keydown into the click these tests exercise separately.
describe("WebviewDialog keyboard handling", () => {
  it("leaves Enter on Cancel to native activation instead of confirming", () => {
    const onRespond = vi.fn();
    const { container } = render(<WebviewDialog dialog={baseConfirm} onRespond={onRespond} />);
    const cancel = getButton(container, "Cancel");
    cancel.focus();

    const notPrevented = fireEvent.keyDown(cancel, { key: "Enter" });

    // The regression in #11106: the overlay confirmed the guest's dialog here.
    expect(onRespond).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);

    fireEvent.click(cancel);
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("leaves Enter on OK to native activation, which confirms", () => {
    const onRespond = vi.fn();
    const { container } = render(<WebviewDialog dialog={baseConfirm} onRespond={onRespond} />);
    const ok = getButton(container, "OK");
    ok.focus();

    const notPrevented = fireEvent.keyDown(ok, { key: "Enter" });

    expect(onRespond).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);

    fireEvent.click(ok);
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("submits the edited value on Enter in the prompt input", () => {
    const onRespond = vi.fn();
    const { container } = render(<WebviewDialog dialog={basePrompt} onRespond={onRespond} />);
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;

    fireEvent.change(input, { target: { value: "edited" } });
    const notPrevented = fireEvent.keyDown(input, { key: "Enter" });

    // A text input has no native Enter action outside a <form>, so the overlay
    // must consume this one.
    expect(notPrevented).toBe(false);
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(true, "edited");
  });

  it("cancels a prompt on Escape from the input", () => {
    const onRespond = vi.fn();
    const { container } = render(<WebviewDialog dialog={basePrompt} onRespond={onRespond} />);
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRespond).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("cancels a confirm on Escape from the Cancel button", () => {
    const onRespond = vi.fn();
    const { container } = render(<WebviewDialog dialog={baseConfirm} onRespond={onRespond} />);

    fireEvent.keyDown(getButton(container, "Cancel"), { key: "Escape" });

    expect(onRespond).toHaveBeenCalledExactlyOnceWith(false);
  });

  // An alert has no Cancel — dismissing it is the only response the guest can get.
  it("acknowledges an alert on Escape", () => {
    const onRespond = vi.fn();
    const { container } = render(<WebviewDialog dialog={baseAlert} onRespond={onRespond} />);

    fireEvent.keyDown(getButton(container, "OK"), { key: "Escape" });

    expect(onRespond).toHaveBeenCalledExactlyOnceWith(true);
  });
});
