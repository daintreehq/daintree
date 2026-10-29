// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { focusWebviewPage } from "../browserUtils";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("focusWebviewPage", () => {
  it("focuses the page", () => {
    document.body.innerHTML = `<div data-panel-id="p1"><div id="page" tabindex="0"></div></div>`;
    const page = document.getElementById("page")!;

    expect(focusWebviewPage(page)).toBe(true);
    expect(document.activeElement).toBe(page);
  });

  // A page waiting on its own alert() can't take a key; its dialog stands in.
  it("hands the keyboard to the page's dialog while one is up", () => {
    document.body.innerHTML = `
      <div data-panel-id="p1">
        <div id="page" tabindex="0"></div>
        <div role="dialog" data-pane-dialog tabindex="-1">
          <button data-confirm-role="confirm" id="ok">OK</button>
        </div>
      </div>`;

    expect(focusWebviewPage(document.getElementById("page"))).toBe(true);
    expect(document.activeElement?.id).toBe("ok");
  });

  it("focuses the page when its dialog can't take focus", () => {
    document.body.innerHTML = `
      <div data-panel-id="p1">
        <div id="page" tabindex="0"></div>
        <div role="dialog" data-pane-dialog>
          <button data-confirm-role="confirm" disabled>OK</button>
        </div>
      </div>`;
    const page = document.getElementById("page")!;

    expect(focusWebviewPage(page)).toBe(true);
    expect(document.activeElement).toBe(page);
  });

  it("is false with no page to focus", () => {
    expect(focusWebviewPage(null)).toBe(false);
    expect(focusWebviewPage(document.createElement("div"))).toBe(false);
  });

  it("ignores a dialog over another pane", () => {
    document.body.innerHTML = `
      <div data-panel-id="p1"><div id="page" tabindex="0"></div></div>
      <div data-panel-id="p2">
        <div role="dialog" data-pane-dialog tabindex="-1">
          <button data-confirm-role="confirm">OK</button>
        </div>
      </div>`;
    const page = document.getElementById("page")!;

    expect(focusWebviewPage(page)).toBe(true);
    expect(document.activeElement).toBe(page);
  });
});
