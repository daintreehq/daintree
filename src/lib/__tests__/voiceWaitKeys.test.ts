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

  it("leaves a key typed somewhere no waiting composer holds", () => {
    const field = document.createElement("input");
    document.body.appendChild(field);
    const owner = claim({ isSelected: () => true });

    const event = press("Enter", field);

    expect(event.defaultPrevented).toBe(false);
    expect(owner.sendNow).not.toHaveBeenCalled();
  });

  it("yields a page key to a modal that holds no waiting composer", () => {
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    const owner = claim();

    expect(press("Escape").defaultPrevented).toBe(false);
    expect(owner.cancel).not.toHaveBeenCalled();
  });

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

  it("stops listening once the last claim is released", () => {
    const owner = claim();
    releases.splice(0).forEach((release) => release());

    expect(press("Enter").defaultPrevented).toBe(false);
    expect(owner.sendNow).not.toHaveBeenCalled();
  });
});
