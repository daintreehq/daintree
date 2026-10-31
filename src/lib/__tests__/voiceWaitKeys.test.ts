// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimVoiceWaitKeys,
  observeVoiceWaitKeysReach,
  routeVoiceWaitKey,
  voiceWaitKeysReach,
  type VoiceWaitKeyClaim,
} from "../voiceWaitKeys";

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

  // A page's dialog blocks only its own pane (#15037), so it doesn't own a key
  // that landed on the page.
  it("still routes a page key to the waiting composer while a page dialog is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-pane-dialog", "");
    document.body.appendChild(dialog);
    const owner = claim();

    expect(press("Escape").defaultPrevented).toBe(true);
    expect(owner.cancel).toHaveBeenCalledTimes(1);
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

  // #15705: a wait names only the keys that reach it from where the keyboard is.
  describe("voiceWaitKeysReach", () => {
    const BOTH = { enter: true, escape: true, page: true };
    const PAGE_ONLY = { enter: false, escape: false, page: true };
    const NONE = { enter: false, escape: false, page: false };

    function composer() {
      const bar = document.createElement("div");
      const editor = document.createElement("div");
      editor.tabIndex = -1;
      const cancel = document.createElement("button");
      cancel.setAttribute("data-voice-wait-cancel", "");
      bar.append(editor, cancel);
      document.body.appendChild(bar);
      return { bar, editor, cancel };
    }

    function otherPane() {
      const pane = document.createElement("textarea");
      const received: string[] = [];
      pane.addEventListener("keydown", (event) => received.push(event.key));
      document.body.appendChild(pane);
      return { pane, received };
    }

    it("says both reach from the composer, and neither from another pane, where they stay", () => {
      const { bar, editor } = composer();
      const { pane, received } = otherPane();
      const owner = claim({ holds: (element) => bar.contains(element) });

      editor.focus();
      expect(voiceWaitKeysReach(owner)).toEqual(BOTH);

      pane.focus();
      expect(voiceWaitKeysReach(owner)).toEqual(PAGE_ONLY);
      expect(press("Enter", pane).defaultPrevented).toBe(false);
      expect(press("Escape", pane).defaultPrevented).toBe(false);
      expect(received).toEqual(["Enter", "Escape"]);
      expect(owner.sendNow).not.toHaveBeenCalled();
      expect(owner.cancel).not.toHaveBeenCalled();
    });

    it("gives the keyboard nowhere to the one waiting composer, or the selected one of several", () => {
      const only = claim();
      expect(voiceWaitKeysReach(only)).toEqual(BOTH);

      const selected = claim({ isSelected: () => true });
      expect(voiceWaitKeysReach(only)).toEqual(PAGE_ONLY);
      expect(voiceWaitKeysReach(selected)).toEqual(BOTH);
    });

    it("says only Escape reaches from Cancel send, where Enter calls the send off", () => {
      const { bar, cancel } = composer();
      const owner = claim({ holds: (element) => bar.contains(element) });

      cancel.focus();

      expect(voiceWaitKeysReach(owner)).toEqual({ enter: false, escape: true, page: true });
    });

    it.each(["iframe", "webview"])(
      "says no key reaches the page from a guest page in an %s",
      (tag) => {
        const guest = document.createElement(tag);
        guest.tabIndex = 0;
        document.body.appendChild(guest);
        const owner = claim();

        guest.focus();

        expect(document.activeElement).toBe(guest);
        expect(voiceWaitKeysReach(owner)).toEqual(NONE);
      }
    );

    it("says no key reaches the page while its window doesn't hold the keyboard", () => {
      const owner = claim();
      const seen: unknown[] = [];
      const stop = observeVoiceWaitKeysReach(() => seen.push(voiceWaitKeysReach(owner)));
      try {
        window.dispatchEvent(new FocusEvent("blur"));
        expect(voiceWaitKeysReach(owner)).toEqual(NONE);

        window.dispatchEvent(new FocusEvent("focus"));
        expect(voiceWaitKeysReach(owner)).toEqual(BOTH);
        expect(seen).toEqual([NONE, BOTH]);
      } finally {
        stop();
        window.dispatchEvent(new FocusEvent("focus"));
      }
    });

    // A spoken "send it" can start a wait with the keyboard in another app.
    it("knows the window lost the keyboard before anyone observed", () => {
      try {
        window.dispatchEvent(new FocusEvent("blur"));
        const owner = claim();
        const stop = observeVoiceWaitKeysReach(() => {});
        expect(voiceWaitKeysReach(owner)).toEqual(NONE);
        stop();
      } finally {
        window.dispatchEvent(new FocusEvent("focus"));
      }
    });

    it("tells observers where the keys go once the keyboard moves or a composer claims or releases them", async () => {
      const { bar, editor } = composer();
      const { pane } = otherPane();
      let owner!: VoiceWaitKeyClaim;
      const seen: unknown[] = [];
      const stop = observeVoiceWaitKeysReach(() => seen.push(owner && voiceWaitKeysReach(owner)));
      try {
        owner = claim({ holds: (element) => bar.contains(element) });
        expect(seen).toHaveLength(1);

        pane.focus();
        expect(seen.at(-1)).toEqual(PAGE_ONLY);

        seen.length = 0;
        pane.blur();
        // Told once focus has settled on nothing, not while it is still leaving.
        expect(seen).toEqual([]);
        await Promise.resolve();
        expect(seen).toEqual([BOTH]);

        editor.focus();
        seen.length = 0;
        releases.shift()!();
        expect(seen).toEqual([PAGE_ONLY]);
      } finally {
        stop();
      }
    });

    it("listens for focus only while someone observes, however many do", () => {
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      try {
        const first = observeVoiceWaitKeysReach(() => {});
        const second = observeVoiceWaitKeysReach(() => {});
        const types = (calls: unknown[][]) => calls.map(([type]) => type).sort();
        expect(types(add.mock.calls)).toEqual(["focusin", "focusout"]);

        first();
        expect(remove).not.toHaveBeenCalled();
        second();
        expect(types(remove.mock.calls)).toEqual(["focusin", "focusout"]);
        for (const call of add.mock.calls) expect(remove).toHaveBeenCalledWith(...call);
      } finally {
        add.mockRestore();
        remove.mockRestore();
      }
    });
  });
});
