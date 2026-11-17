// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLinksLauncher, useLinksLauncherStore } from "../linksLauncherStore";

function addButtonWrapper({ hidden }: { hidden: boolean }): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-toolbar-button-id", "links-launcher");
  if (hidden) wrapper.setAttribute("aria-hidden", "true");
  wrapper.appendChild(document.createElement("button"));
  document.body.appendChild(wrapper);
  return wrapper;
}

beforeEach(() => {
  useLinksLauncherStore.setState({ opening: null, refreshSeq: 0, closeFocus: null });
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
