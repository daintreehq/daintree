// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  US_KEY_LABELS,
  deriveKeyLabels,
  getKeyLabels,
  resetKeyboardLayoutForTests,
  subscribeKeyLabels,
} from "../keyboardLayout";

const US_PUNCTUATION: Record<string, string> = {
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  IntlBackslash: "\\",
};

function letters(chars: string): Record<string, string> {
  return Object.fromEntries(
    [...chars].map((char, i) => [`Key${String.fromCharCode(65 + i)}`, char])
  );
}

const US_LETTERS = letters("abcdefghijklmnopqrstuvwxyz");

function layout(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

const US = layout({ ...US_LETTERS, ...US_PUNCTUATION });

// French AZERTY: the US Q/A, W/Z and M positions move, and the bottom-row
// punctuation shifts one key right.
const AZERTY = layout({
  ...US_LETTERS,
  KeyA: "q",
  KeyQ: "a",
  KeyW: "z",
  KeyZ: "w",
  KeyM: ",",
  Slash: "!",
  Backslash: "*",
  Comma: ";",
  Period: ":",
  Semicolon: "m",
  Quote: "ù",
  BracketLeft: "^",
  BracketRight: "$",
  Backquote: "²",
  Minus: ")",
  Equal: "=",
  IntlBackslash: "<",
});

const RUSSIAN = layout({
  ...letters("фисвуапршолдьтщзйкыегмцчня"),
  Slash: ".",
  Period: "ю",
  Comma: "б",
});

type GetLayoutMap = () => Promise<Map<string, string>>;

function installKeyboard(getLayoutMap: GetLayoutMap): void {
  Object.defineProperty(navigator, "keyboard", {
    value: { getLayoutMap },
    configurable: true,
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function press(code: string, key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { code, key, ...init }));
}

describe("deriveKeyLabels", () => {
  it("labels each physically matched key with what it types on the layout", () => {
    const labels = deriveKeyLabels(AZERTY);
    expect(labels.get("/")).toBe("!");
    expect(labels.get(";")).toBe("m");
    expect(labels.get(",")).toBe(";");
    expect(labels.get("[")).toBe("^");
    expect(labels.get("`")).toBe("²");
    expect(labels.get("\\")).toBe("*");
    // Equal types "=" on AZERTY too, so it keeps the label it already has.
    expect(labels.has("=")).toBe(false);
  });

  it("is the US labels for the US layout", () => {
    expect(deriveKeyLabels(US)).toBe(US_KEY_LABELS);
  });

  it("takes a non-Latin layout's characters as the OS reports them", () => {
    const labels = deriveKeyLabels(RUSSIAN);
    expect(labels.get("/")).toBe(".");
    expect(labels.get(".")).toBe("ю");
    expect(labels.get(",")).toBe("б");
  });

  it("labels backslash from the second key only when the first can't be read", () => {
    const iso = layout({ ...US_LETTERS, Backslash: "", IntlBackslash: "<" });
    expect(deriveKeyLabels(iso).get("\\")).toBe("<");
    const german = layout({ ...US_LETTERS, Backslash: "#", IntlBackslash: "<" });
    expect(deriveKeyLabels(german).get("\\")).toBe("#");
  });

  it("composes a decomposed character into the one it prints", () => {
    const decomposed = layout({ ...US_LETTERS, Quote: "ù" });
    expect(deriveKeyLabels(decomposed).get("'")).toBe("ù");
  });

  it('keeps "\\" when the second backslash key types it', () => {
    const uk = layout({ ...US_LETTERS, ...US_PUNCTUATION, Backslash: "#", IntlBackslash: "\\" });
    expect(deriveKeyLabels(uk).has("\\")).toBe(false);
  });

  it("skips keys the layout doesn't report or can't print as one character", () => {
    const partial = layout({ ...US_LETTERS, Slash: "", Comma: " ", Period: "̂", Quote: "ab" });
    expect(deriveKeyLabels(partial)).toBe(US_KEY_LABELS);
    expect(deriveKeyLabels(new Map())).toBe(US_KEY_LABELS);
  });
});

describe("keyboard layout store", () => {
  beforeEach(() => {
    resetKeyboardLayoutForTests();
  });

  afterEach(() => {
    resetKeyboardLayoutForTests();
    Reflect.deleteProperty(navigator, "keyboard");
    vi.restoreAllMocks();
  });

  it("stays on the US labels when the layout can't be read", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKeyLabels(listener);
    window.dispatchEvent(new Event("focus"));
    press("Slash", "!");
    await flush();
    expect(getKeyLabels()).toBe(US_KEY_LABELS);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("reads the layout on the first subscriber and publishes its labels", async () => {
    const getLayoutMap = vi.fn(async () => AZERTY);
    installKeyboard(getLayoutMap);
    const listener = vi.fn();
    const unsubscribe = subscribeKeyLabels(listener);
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(1);
    expect(getKeyLabels().get("/")).toBe("!");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("re-reads on focus and notifies only when the labels change", async () => {
    let current = US;
    installKeyboard(async () => current);
    const listener = vi.fn();
    const unsubscribe = subscribeKeyLabels(listener);
    await flush();
    expect(listener).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(listener).not.toHaveBeenCalled();

    current = AZERTY;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getKeyLabels().get("/")).toBe("!");

    current = US;
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getKeyLabels()).toBe(US_KEY_LABELS);
    unsubscribe();
  });

  it("re-reads when a keystroke types something the last read didn't predict", async () => {
    let current = US;
    const getLayoutMap = vi.fn(async () => current);
    installKeyboard(getLayoutMap);
    const unsubscribe = subscribeKeyLabels(() => {});
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(1);

    // Agrees with the read: no new read.
    press("KeyQ", "q");
    press("KeyQ", "Q");
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(1);

    // Modified or composed keystrokes say nothing about the base layer.
    press("KeyQ", "@", { altKey: true });
    press("KeyQ", "Q", { shiftKey: true });
    press("KeyQ", "œ", { metaKey: true });
    press("KeyQ", "x", { isComposing: true });
    press("KeyQ", "x", { repeat: true });
    press("BracketLeft", "Dead");
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(1);

    current = AZERTY;
    press("KeyQ", "a");
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(2);
    expect(getKeyLabels().get("/")).toBe("!");
    unsubscribe();
  });

  it("asks about a disagreeing key once a minute when the read doesn't follow the typing", async () => {
    // A non-Latin input source can be typed while the read reports the
    // ASCII-capable layout behind it.
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const getLayoutMap = vi.fn(async () => US);
    installKeyboard(getLayoutMap);
    const unsubscribe = subscribeKeyLabels(() => {});
    await flush();

    press("KeyA", "ф");
    await flush();
    press("KeyA", "ф");
    press("KeyA", "ф");
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(2);

    press("KeyB", "и");
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(3);

    now += 60_000;
    press("KeyA", "ф");
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("re-reads every key once the layout it disagreed with has changed", async () => {
    let current = US;
    const getLayoutMap = vi.fn(async () => current);
    installKeyboard(getLayoutMap);
    const unsubscribe = subscribeKeyLabels(() => {});
    await flush();

    press("KeyA", "ф");
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(2);

    current = AZERTY;
    window.dispatchEvent(new Event("focus"));
    await flush();
    press("KeyA", "ф");
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("falls back to the US labels when a read fails", async () => {
    let fail = false;
    installKeyboard(async () => {
      if (fail) throw new Error("detached");
      return AZERTY;
    });
    const unsubscribe = subscribeKeyLabels(() => {});
    await flush();
    expect(getKeyLabels().get("/")).toBe("!");

    fail = true;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(getKeyLabels()).toBe(US_KEY_LABELS);
    unsubscribe();
  });

  it("keeps the newest read when an older one lands after it", async () => {
    const reads = [deferred<Map<string, string>>(), deferred<Map<string, string>>()];
    let call = 0;
    installKeyboard(() => reads[call++]!.promise);
    const unsubscribe = subscribeKeyLabels(() => {});
    window.dispatchEvent(new Event("focus"));

    reads[1]!.resolve(US);
    await flush();
    reads[0]!.resolve(AZERTY);
    await flush();
    expect(getKeyLabels()).toBe(US_KEY_LABELS);
    unsubscribe();
  });

  it("stops watching with the last subscriber and drops a read in flight", async () => {
    const read = deferred<Map<string, string>>();
    const getLayoutMap = vi.fn(() => read.promise);
    installKeyboard(getLayoutMap);
    const first = subscribeKeyLabels(() => {});
    const second = subscribeKeyLabels(() => {});
    expect(getLayoutMap).toHaveBeenCalledTimes(1);

    first();
    window.dispatchEvent(new Event("focus"));
    expect(getLayoutMap).toHaveBeenCalledTimes(2);

    second();
    read.resolve(AZERTY);
    await flush();
    expect(getKeyLabels()).toBe(US_KEY_LABELS);

    window.dispatchEvent(new Event("focus"));
    press("KeyQ", "a");
    expect(getLayoutMap).toHaveBeenCalledTimes(2);
  });
});
