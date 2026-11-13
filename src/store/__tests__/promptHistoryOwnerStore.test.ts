// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimPromptHistory,
  followPromptHistoryHost,
  usePromptHistoryOwnerStore,
} from "../promptHistoryOwnerStore";

const owner = () => usePromptHistoryOwnerStore.getState().owner;

/** An element that takes focus, appended to `parent`. */
function focusable(parent: HTMLElement, tag = "button"): HTMLElement {
  const el = document.createElement(tag);
  if (tag !== "button") el.tabIndex = 0;
  parent.appendChild(el);
  return el;
}

function host(parent: HTMLElement = document.body): HTMLElement {
  const el = document.createElement("section");
  el.setAttribute("data-prompt-history-host", "");
  parent.appendChild(el);
  return el;
}

function gridPane(): HTMLElement {
  const pane = document.createElement("div");
  pane.setAttribute("data-panel-id", "term-1");
  document.body.appendChild(pane);
  return pane;
}

const stops: (() => void)[] = [];
function follow(token: string, composer: HTMLElement) {
  const stop = followPromptHistoryHost(token, composer);
  stops.push(stop);
  return stop;
}

beforeEach(() => {
  usePromptHistoryOwnerStore.setState({ owner: null });
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.replaceChildren();
});

describe("promptHistoryOwnerStore", () => {
  it("follows focus into the composer's host, and back to the grid on a pane's focus", () => {
    const aside = host();
    const composer = focusable(aside, "div");
    const terminal = focusable(aside);
    const pane = focusable(gridPane());
    follow("assistant", composer);
    expect(owner()).toBeNull();

    // Anywhere in the host, not only the composer: the Assistant's terminal too.
    terminal.focus();
    expect(owner()).toBe("assistant");

    pane.focus();
    expect(owner()).toBeNull();
  });

  it("keeps history where the user was while a palette or dialog takes focus", () => {
    const aside = host();
    const composer = focusable(aside, "div");
    const paletteSearch = focusable(document.body, "input");
    follow("assistant", composer);

    composer.focus();
    paletteSearch.focus();

    expect(owner()).toBe("assistant");
  });

  it("gives a nested host's focus to its own composer, not the one around it", () => {
    const canopy = host();
    const reply = focusable(canopy, "div");
    const list = focusable(canopy);
    const dock = host(canopy);
    const globalComposer = focusable(dock, "div");
    follow("reply", reply);
    follow("global", globalComposer);

    globalComposer.focus();
    expect(owner()).toBe("global");

    list.focus();
    expect(owner()).toBe("reply");
  });

  it("claims from the start when its host already holds focus", () => {
    const aside = host();
    const terminal = focusable(aside);
    terminal.focus();
    const composer = focusable(aside, "div");

    follow("assistant", composer);

    expect(owner()).toBe("assistant");
  });

  it("claims on the composer's own focus when it sits in no host", () => {
    const composer = focusable(document.body, "div");
    const beside = focusable(document.body);
    follow("reply", composer);

    beside.focus();
    expect(owner()).toBeNull();

    composer.focus();
    expect(owner()).toBe("reply");
  });

  it("lends a host's focus to the composer nested in it while it has none of its own", () => {
    const canopy = host();
    const list = focusable(canopy);
    const dock = host(canopy);
    const globalComposer = focusable(dock, "div");
    follow("global", globalComposer);

    list.focus();
    expect(owner()).toBe("global");
  });

  it("passes history to the composer nested beside it when the run's reply goes", () => {
    const canopy = host();
    const list = focusable(canopy);
    const reply = focusable(canopy, "div");
    const globalComposer = focusable(host(canopy), "div");
    follow("global", globalComposer);
    const stopReply = follow("reply", reply);
    list.focus();
    expect(owner()).toBe("reply");

    // The global assistant is selected: the reply unmounts, focus stays on the list.
    stopReply();

    expect(owner()).toBe("global");
  });

  it("hands history to the composer replacing one that held it, focus gone with the old editor", () => {
    const aside = host();
    const first = focusable(aside, "div");
    const stopFirst = follow("first", first);
    first.focus();
    expect(owner()).toBe("first");

    // Remounted for a new input owner: the old editor leaves, and focus with it.
    first.remove();
    stopFirst();
    expect(owner()).toBeNull();
    follow("second", focusable(aside, "div"));

    expect(owner()).toBe("second");
  });

  it("leaves a composer that comes later alone, once the commit that lost one is over", async () => {
    const aside = host();
    const first = focusable(aside, "div");
    const stopFirst = follow("first", first);
    first.focus();
    first.remove();
    stopFirst();

    await Promise.resolve();
    follow("second", focusable(aside, "div"));

    expect(owner()).toBeNull();
  });

  it("stops listening once it stops following", () => {
    const aside = host();
    const composer = focusable(aside, "div");
    const pane = focusable(gridPane());
    const stop = follow("assistant", composer);
    pane.focus();
    stop();

    composer.focus();

    expect(owner()).toBeNull();
  });

  it("hands history back when it stops following, but never another composer's", () => {
    const composer = focusable(host(), "div");
    const stopA = follow("a", composer);
    composer.focus();
    expect(owner()).toBe("a");

    claimPromptHistory("b");
    stopA();
    expect(owner()).toBe("b");

    const stopB = followPromptHistoryHost("b", focusable(host(), "div"));
    stopB();
    expect(owner()).toBeNull();
  });
});
