// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openLinksLauncher,
  openLinksLauncherFromOverflow,
  useLinksLauncherStore,
} from "../linksLauncherStore";
import {
  consumeDeferredPaletteFocusRestore,
  deferPaletteFocusRestore,
  notePaletteOpening,
} from "@/components/ui/paletteFocusRestore";

function addButtonWrapper({ hidden }: { hidden: boolean }): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-toolbar-button-id", "links-launcher");
  if (hidden) wrapper.setAttribute("aria-hidden", "true");
  wrapper.appendChild(document.createElement("button"));
  document.body.appendChild(wrapper);
  return wrapper;
}

beforeEach(() => {
  useLinksLauncherStore.setState({
    opening: null,
    refreshSeq: 0,
    closeFocus: null,
    detachedRestore: null,
    deferredFromOverflow: null,
  });
  notePaletteOpening();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("linksLauncherStore", () => {
  it("ends only the opening a close names", () => {
    const store = useLinksLauncherStore.getState();
    store.open("button");
    const first = useLinksLauncherStore.getState().opening!;
    store.open("detached");
    const second = useLinksLauncherStore.getState().opening!;
    expect(second.seq).not.toBe(first.seq);

    store.close(first.seq);
    expect(useLinksLauncherStore.getState().opening).toBe(second);
    store.close(second.seq);
    expect(useLinksLauncherStore.getState().opening).toBeNull();
  });

  it("asks for a refresh on every opening and on request", () => {
    const store = useLinksLauncherStore.getState();
    store.open("button");
    store.open("button");
    store.requestRefresh();
    expect(useLinksLauncherStore.getState().refreshSeq).toBe(3);
  });

  it("spends the close's focus finder once", () => {
    const target = document.createElement("button");
    const store = useLinksLauncherStore.getState();
    store.open("button");
    store.close(undefined, () => target);
    expect(store.takeCloseFocus()?.()).toBe(target);
    expect(store.takeCloseFocus()).toBeNull();
  });
});

describe("openLinksLauncher", () => {
  it("opens beside the button when the button is on screen", () => {
    addButtonWrapper({ hidden: false });
    openLinksLauncher();
    expect(useLinksLauncherStore.getState().opening?.origin).toBe("button");
  });

  it("opens detached while the button sits hidden in `…`", () => {
    addButtonWrapper({ hidden: true });
    openLinksLauncher();
    expect(useLinksLauncherStore.getState().opening?.origin).toBe("detached");
  });

  it("opens detached when the toolbar has no button for it", () => {
    openLinksLauncher();
    expect(useLinksLauncherStore.getState().opening?.origin).toBe("detached");
  });
});

describe("openLinksLauncher from the action palette", () => {
  it("takes over the palette's focus return for a detached opening", () => {
    const restore = vi.fn();
    deferPaletteFocusRestore((give) => give());
    openLinksLauncher();

    // The palette's exit hands its restore to the launcher instead of running it.
    consumeDeferredPaletteFocusRestore()?.(restore);
    expect(restore).not.toHaveBeenCalled();
    const held = useLinksLauncherStore.getState().takeDetachedRestore();
    expect(held).toBe(restore);
    expect(useLinksLauncherStore.getState().takeDetachedRestore()).toBeNull();
  });

  it("gives the palette's return back at once when the launcher closed first", () => {
    const restore = vi.fn();
    deferPaletteFocusRestore((give) => give());
    openLinksLauncher();
    useLinksLauncherStore.getState().close();

    consumeDeferredPaletteFocusRestore()?.(restore);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(useLinksLauncherStore.getState().detachedRestore).toBeNull();
  });

  it("leaves the palette's return alone when the launcher opens at its button", () => {
    addButtonWrapper({ hidden: false });
    const restore = vi.fn();
    deferPaletteFocusRestore((give) => give());
    openLinksLauncher();

    consumeDeferredPaletteFocusRestore()?.(restore);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(useLinksLauncherStore.getState().detachedRestore).toBeNull();
  });

  it("keeps the held return when it is opened again while open", () => {
    const restore = vi.fn();
    deferPaletteFocusRestore((give) => give());
    openLinksLauncher();
    consumeDeferredPaletteFocusRestore()?.(restore);
    const opening = useLinksLauncherStore.getState().opening;

    // A keybinding opening it again: no palette is closing this time.
    openLinksLauncher();

    expect(useLinksLauncherStore.getState().opening).toBe(opening);
    expect(useLinksLauncherStore.getState().refreshSeq).toBe(2);
    expect(useLinksLauncherStore.getState().takeDetachedRestore()).toBe(restore);
  });

  it("arms nothing when no palette is closing", () => {
    openLinksLauncher();
    expect(consumeDeferredPaletteFocusRestore()).toBeNull();
  });
});

describe("opening from a `…` menu row", () => {
  function overflowTrigger(side: "left" | "right", visible: boolean): HTMLButtonElement {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-toolbar-overflow-trigger", "");
    trigger.setAttribute("data-toolbar-overflow-side", side);
    trigger.setAttribute("data-visible", String(visible));
    document.body.appendChild(trigger);
    return trigger;
  }

  it.each([
    ["left", "right"],
    ["right", "left"],
  ] as const)("is spent only by the %s menu that asked for it", (side, other) => {
    const store = useLinksLauncherStore.getState();
    store.deferFromOverflow(side);
    expect(store.takeDeferredFromOverflow(other)).toBe(false);
    expect(store.takeDeferredFromOverflow(side)).toBe(true);
    expect(store.takeDeferredFromOverflow(side)).toBe(false);
  });

  it.each(["left", "right"] as const)(
    "opens detached and gives focus back to the %s `…` button",
    (side) => {
      const left = overflowTrigger("left", true);
      const right = overflowTrigger("right", true);
      openLinksLauncherFromOverflow(side);

      expect(useLinksLauncherStore.getState().opening?.origin).toBe("detached");
      useLinksLauncherStore.getState().takeDetachedRestore()?.();
      expect(document.activeElement).toBe(side === "left" ? left : right);
    }
  );

  it("gives focus to nothing when that `…` button has gone", () => {
    overflowTrigger("right", false);
    openLinksLauncherFromOverflow("right");
    useLinksLauncherStore.getState().takeDetachedRestore()?.();
    expect(document.activeElement).toBe(document.body);
  });
});
