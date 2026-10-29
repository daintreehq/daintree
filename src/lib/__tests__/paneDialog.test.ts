// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { focusPaneDialog, isInPaneDialog } from "../paneDialog";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("isInPaneDialog", () => {
  it("is true only inside a live pane dialog", () => {
    document.body.innerHTML = `
      <div data-panel-id="p1">
        <div role="dialog" data-pane-dialog><button id="ok">OK</button></div>
        <button id="toolbar">Reload</button>
      </div>
      <div role="dialog"><button id="other">Other</button></div>`;

    expect(isInPaneDialog(document.getElementById("ok"))).toBe(true);
    expect(isInPaneDialog(document.getElementById("toolbar"))).toBe(false);
    expect(isInPaneDialog(document.getElementById("other"))).toBe(false);
  });

  it("is false for targets that are not elements", () => {
    expect(isInPaneDialog(null)).toBe(false);
    expect(isInPaneDialog(undefined)).toBe(false);
    expect(isInPaneDialog(window)).toBe(false);
  });
});

describe("focusPaneDialog", () => {
  it("is false when the container holds no pane dialog", () => {
    document.body.innerHTML = `<div id="pane"><button>Reload</button></div>`;

    expect(focusPaneDialog(document.getElementById("pane")!)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses OK for an alert or confirm", () => {
    document.body.innerHTML = `
      <div id="pane">
        <div role="dialog" data-pane-dialog tabindex="-1">
          <button data-confirm-role="cancel">Cancel</button>
          <button data-confirm-role="confirm" id="ok">OK</button>
        </div>
      </div>`;

    expect(focusPaneDialog(document.getElementById("pane")!)).toBe(true);
    expect(document.activeElement?.id).toBe("ok");
  });

  it("focuses a prompt's field ahead of OK", () => {
    document.body.innerHTML = `
      <div id="pane">
        <div role="dialog" data-pane-dialog tabindex="-1">
          <input type="text" id="field" />
          <button data-confirm-role="confirm">OK</button>
        </div>
      </div>`;

    expect(focusPaneDialog(document.getElementById("pane")!)).toBe(true);
    expect(document.activeElement?.id).toBe("field");
  });

  it("leaves focus already inside the dialog where it is", () => {
    document.body.innerHTML = `
      <div id="pane">
        <div role="dialog" data-pane-dialog tabindex="-1">
          <button data-confirm-role="cancel" id="cancel">Cancel</button>
          <button data-confirm-role="confirm">OK</button>
        </div>
      </div>`;
    document.getElementById("cancel")!.focus();

    expect(focusPaneDialog(document.getElementById("pane")!)).toBe(true);
    expect(document.activeElement?.id).toBe("cancel");
  });
});
