// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  CARD_CONTROL_SELECTOR,
  hasTextSelectionWithin,
  isCardContentEvent,
} from "../cardClickTarget";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("isCardContentEvent", () => {
  it("is content for text, marks and padding, and the select button", () => {
    const host = mount(`
      <div id="card">
        <button data-card-select-overlay id="overlay"></button>
        <span id="text">3 files</span>
        <span role="img" id="mark"></span>
        <div role="group" tabindex="0" id="age">2h</div>
      </div>`);
    const card = host.querySelector("#card")!;
    for (const id of ["card", "overlay", "text", "mark", "age"]) {
      const target = host.querySelector(`#${id}`)!;
      expect(isCardContentEvent({ target, currentTarget: card }), id).toBe(true);
    }
  });

  it("is not content for anything inside a control or a control region", () => {
    const host = mount(`
      <div id="card">
        <button id="b"><svg><path id="glyph"></path></svg></button>
        <a href="#" id="link">x</a>
        <div data-card-control><span id="banner-text">Couldn't delete</span></div>
        <div data-worktree-row-drag-handle id="grip"></div>
      </div>`);
    const card = host.querySelector("#card")!;
    for (const id of ["b", "glyph", "link", "banner-text", "grip"]) {
      const target = host.querySelector(`#${id}`)!;
      expect(isCardContentEvent({ target, currentTarget: card }), id).toBe(false);
    }
  });

  it("is not content for a node outside the card, which is where portals render", () => {
    const host = mount(`<div id="card"></div>`);
    const portalled = mount(`<span id="menu-text">Copy path</span>`);
    expect(
      isCardContentEvent({
        target: portalled.querySelector("#menu-text"),
        currentTarget: host.querySelector("#card"),
      })
    ).toBe(false);
  });

  it("ignores a control above the card, which is not the card's", () => {
    const host = mount(`<div role="button"><div id="card"><span id="text">x</span></div></div>`);
    expect(
      isCardContentEvent({
        target: host.querySelector("#text"),
        currentTarget: host.querySelector("#card"),
      })
    ).toBe(true);
  });
});

describe("hasTextSelectionWithin", () => {
  it("sees a selection that starts or ends in the card, and nothing else", () => {
    const host = mount(`<div id="card"><span id="a">alpha</span></div><p id="out">beta</p>`);
    const card = host.querySelector("#card")!;
    expect(hasTextSelectionWithin(card)).toBe(false);

    const range = document.createRange();
    range.selectNodeContents(host.querySelector("#out")!);
    window.getSelection()!.addRange(range);
    expect(hasTextSelectionWithin(card)).toBe(false);

    window.getSelection()!.removeAllRanges();
    range.selectNodeContents(host.querySelector("#a")!);
    window.getSelection()!.addRange(range);
    expect(hasTextSelectionWithin(card)).toBe(true);
  });
});

describe("the card's hover rule names the same controls as its click routing", () => {
  it("suppresses the card tint over exactly CARD_CONTROL_SELECTOR", () => {
    // Two lists, one in CSS and one in TS, have to agree or the surface that
    // lights up stops being the one that answers the click.
    const css = readFileSync(
      resolve(__dirname, "../../../../styles/components/sidebar.css"),
      "utf-8"
    );
    const rule = css.match(
      /\.sidebar-worktree-card\[data-hoverable="true"\]:hover:where\(\s*:not\(\s*:has\(\s*:is\(([^)]*(?:\([^)]*\)[^)]*)*)\):hover/
    );
    expect(rule, "hover rule with a :has(:is(...):hover) control list").not.toBeNull();
    const normalise = (list: string) =>
      list
        .split(",")
        .map((part) => part.replace(/\s+/g, ""))
        .filter(Boolean)
        .sort();
    expect(normalise(rule![1]!)).toEqual(normalise(CARD_CONTROL_SELECTOR));
  });
});
