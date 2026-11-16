// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredOverlayOpener } from "../deferredOverlayOpen";

function overlay(loaded: boolean) {
  let land!: () => void;
  let fail!: (error: unknown) => void;
  const loading = new Promise<void>((resolve, reject) => {
    land = resolve;
    fail = reject;
  });
  return { isLoaded: () => loaded, preload: () => loading, land, fail };
}

const closeEvent = () => new Event("closeAutoFocus", { cancelable: true });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createDeferredOverlayOpener", () => {
  const extras: HTMLElement[] = [];
  const focusable = () => {
    const el = document.createElement("button");
    document.body.appendChild(el);
    extras.push(el);
    return el;
  };
  afterEach(() => {
    extras.splice(0).forEach((el) => el.remove());
  });

  it("claims the close and opens at once when the chunk has loaded", () => {
    const opener = createDeferredOverlayOpener();
    const event = closeEvent();
    const onOpen = vi.fn();
    opener.open(overlay(true), event, onOpen);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("leaves the close alone and opens once the chunk lands", async () => {
    const opener = createDeferredOverlayOpener();
    const target = overlay(false);
    const event = closeEvent();
    const onOpen = vi.fn();
    const trigger = focusable();
    opener.open(target, event, onOpen);
    // The menu's own focus return, in the same close.
    trigger.focus();
    expect(event.defaultPrevented).toBe(false);
    await tick();
    expect(onOpen).not.toHaveBeenCalled();
    target.land();
    await tick();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("drops the pick when focus moves on before the chunk lands", async () => {
    const opener = createDeferredOverlayOpener();
    const target = overlay(false);
    const onOpen = vi.fn();
    focusable().focus();
    opener.open(target, closeEvent(), onOpen);
    await tick();
    focusable().focus();
    target.land();
    await tick();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([
    ["Escape", () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))],
    ["a pointer press", () => document.dispatchEvent(new Event("pointerdown"))],
  ])("drops the pick on %s", async (_name, act) => {
    const opener = createDeferredOverlayOpener();
    const target = overlay(false);
    const onOpen = vi.fn();
    opener.open(target, closeEvent(), onOpen);
    await tick();
    act();
    target.land();
    await tick();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("hears Escape before a control that stops it", async () => {
    const opener = createDeferredOverlayOpener();
    const target = overlay(false);
    const onOpen = vi.fn();
    const control = focusable();
    control.addEventListener("keydown", (event) => event.stopPropagation());
    opener.open(target, closeEvent(), onOpen);
    await tick();
    control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    target.land();
    await tick();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps the pick through other keys", async () => {
    const opener = createDeferredOverlayOpener();
    const target = overlay(false);
    const onOpen = vi.fn();
    opener.open(target, closeEvent(), onOpen);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    target.land();
    await tick();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("drops the pick on cancel, and a later pick replaces an earlier one", async () => {
    const opener = createDeferredOverlayOpener();
    const first = overlay(false);
    const second = overlay(false);
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    opener.open(first, closeEvent(), onFirst);
    opener.open(second, closeEvent(), onSecond);
    first.land();
    second.land();
    await tick();
    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledTimes(1);

    const third = overlay(false);
    const onThird = vi.fn();
    opener.open(third, closeEvent(), onThird);
    opener.cancel();
    third.land();
    await tick();
    expect(onThird).not.toHaveBeenCalled();
  });

  it("opens nothing when the chunk fails to load, and stops listening", async () => {
    const opener = createDeferredOverlayOpener();
    const target = overlay(false);
    const onOpen = vi.fn();
    const remove = vi.spyOn(document, "removeEventListener");
    opener.open(target, closeEvent(), onOpen);
    target.fail(new Error("chunk failed"));
    await tick();
    await tick();
    expect(onOpen).not.toHaveBeenCalled();
    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual(["keydown", "pointerdown"]);
    remove.mockRestore();
  });
});
