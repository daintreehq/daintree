// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimVoiceWaitKeys, routeVoiceWaitKey, type VoiceWaitKeyClaim } from "../voiceWaitKeys";

const releases: Array<() => void> = [];
const listeners: Array<(event: KeyboardEvent) => void> = [];

afterEach(() => {
  releases.splice(0).forEach((release) => release());
  listeners.splice(0).forEach((listener) => window.removeEventListener("keydown", listener, true));
  document.body.replaceChildren();
});

function claim(overrides: Partial<VoiceWaitKeyClaim> = {}) {
  const entry: VoiceWaitKeyClaim = {
    holds: () => false,
    editor: () => null,
    isSelected: () => false,
    sendNow: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  };
  releases.push(claimVoiceWaitKeys(entry));
  return entry;
}

function onWindowCapture(listener: (event: KeyboardEvent) => void) {
  listeners.push(listener);
  window.addEventListener("keydown", listener, true);
}

function press(key: string, target: Element = document.body, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("voiceWaitKeys", () => {
  it("routes nothing without a claim", () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    expect(routeVoiceWaitKey(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("acts once when a page listener registered earlier routes the key first", () => {
    // Like the fleet's and the keybindings' listeners, which predate any claim.
    const results: boolean[] = [];
    onWindowCapture((event) => {
      results.push(routeVoiceWaitKey(event));
    });
    const owner = claim();

    const event = press("Enter");

    expect(results).toEqual([true]);
    expect(owner.sendNow).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("tells a listener that asks again for a routed key that it was taken", () => {
    const owner = claim();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    Object.defineProperty(event, "target", { value: document.body });

    expect(routeVoiceWaitKey(event)).toBe(true);
    expect(routeVoiceWaitKey(event)).toBe(true);
    expect(owner.cancel).toHaveBeenCalledTimes(1);
  });

  it("stops page listeners registered after the claim from seeing a routed key", () => {
    claim();
    const later = vi.fn();
    onWindowCapture(later);

    press("Enter");

    expect(later).not.toHaveBeenCalled();
  });

  it("gives a key in a composer to that composer, whichever pane is selected", () => {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    const theirs = claim({ isSelected: () => true });
    const mine = claim({ holds: (element) => bar.contains(element) });

    press("Enter", bar);

    expect(mine.sendNow).toHaveBeenCalledTimes(1);
    expect(theirs.sendNow).not.toHaveBeenCalled();
  });

  it("calls the send off at Enter on the composer's Cancel send, and sends from the rest of its bar", () => {
    const bar = document.createElement("div");
    const other = document.createElement("button");
    const cancel = document.createElement("button");
    cancel.setAttribute("data-voice-wait-cancel", "");
    const icon = document.createElement("span");
    cancel.appendChild(icon);
    bar.append(other, cancel);
    document.body.appendChild(bar);
    const owner = claim({ holds: (element) => bar.contains(element) });
    const later = vi.fn();
    onWindowCapture(later);

    const onCancel = press("Enter", icon);

    expect(onCancel.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(owner.cancel).toHaveBeenCalledTimes(1);
    expect(owner.sendNow).not.toHaveBeenCalled();

    press("Enter", other);

    expect(owner.sendNow).toHaveBeenCalledTimes(1);
    expect(owner.cancel).toHaveBeenCalledTimes(1);
  });

  it("leaves a key typed somewhere no waiting composer holds", () => {
    const field = document.createElement("input");
    document.body.appendChild(field);
    const owner = claim({ isSelected: () => true });

    const event = press("Enter", field);

    expect(event.defaultPrevented).toBe(false);
    expect(owner.sendNow).not.toHaveBeenCalled();
  });

  it.each(["dialog", "alertdialog"])(
    "yields a page key to a modal %s that holds no waiting composer",
    (role) => {
      const modal = document.createElement("div");
      modal.setAttribute("role", role);
      modal.setAttribute("aria-modal", "true");
      document.body.appendChild(modal);
      const owner = claim();

      expect(press("Escape").defaultPrevented).toBe(false);
      expect(owner.cancel).not.toHaveBeenCalled();
    }
  );

  it("takes a page key for the composer a modal holds", () => {
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const editor = document.createElement("div");
    modal.appendChild(editor);
    document.body.appendChild(modal);
    const outside = claim({ isSelected: () => true });
    const inside = claim({ editor: () => editor });

    press("Enter");

    expect(inside.sendNow).toHaveBeenCalledTimes(1);
    expect(outside.sendNow).not.toHaveBeenCalled();
  });

  it("listens on the window only while a claim is held", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      claim();
      claim();
      const keydowns = add.mock.calls.filter(([type]) => type === "keydown");
      expect(keydowns).toHaveLength(1);
      const [, listener, capture] = keydowns[0]!;
      expect(capture).toBe(true);

      releases.shift()!();
      expect(remove).not.toHaveBeenCalled();
      releases.shift()!();
      expect(remove).toHaveBeenCalledWith("keydown", listener, true);

      claim();
      expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(2);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("stops routing once the last claim is released", () => {
    const owner = claim();
    releases.splice(0).forEach((release) => release());

    expect(press("Enter").defaultPrevented).toBe(false);
    expect(owner.sendNow).not.toHaveBeenCalled();
  });

  it.each<[string, string, KeyboardEventInit]>([
    ["Shift+Enter", "Enter", { shiftKey: true }],
    ["Alt+Enter", "Enter", { altKey: true }],
    ["Ctrl+Enter", "Enter", { ctrlKey: true }],
    ["Cmd+Enter", "Enter", { metaKey: true }],
    ["Cmd+Escape", "Escape", { metaKey: true }],
    ["an Enter mid-composition", "Enter", { isComposing: true }],
    ["Chromium's composition keydown", "Enter", { keyCode: 229 }],
    ["any other key", "a", {}],
  ])("leaves %s alone", (_name, key, init) => {
    const owner = claim();

    expect(press(key, document.body, init).defaultPrevented).toBe(false);
    expect(owner.sendNow).not.toHaveBeenCalled();
    expect(owner.cancel).not.toHaveBeenCalled();
  });

  it("swallows a held key's repeats without acting on them", () => {
    const owner = claim();

    const repeats = [
      press("Enter", document.body, { repeat: true }),
      press("Escape", document.body, { repeat: true }),
    ];

    expect(repeats.map((event) => event.defaultPrevented)).toEqual([true, true]);
    expect(owner.sendNow).not.toHaveBeenCalled();
    expect(owner.cancel).not.toHaveBeenCalled();
  });
});
