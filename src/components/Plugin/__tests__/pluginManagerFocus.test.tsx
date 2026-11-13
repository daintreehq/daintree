// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortal } from "react-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { containTab, handFocusBack, isFocusStranded } from "../pluginManagerFocus";
import { registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";
import { isTooltipSuppressedForElement } from "@/lib/tooltipFocusSuppression";
import { usePanelStore } from "@/store/panelStore";

function View({ children }: { children?: React.ReactNode }) {
  return (
    <div data-testid="view" tabIndex={-1} onKeyDown={containTab}>
      {children}
    </div>
  );
}

describe("containTab", () => {
  it("leaves Tab from a dialog portalled out of the view to the dialog", () => {
    render(
      <View>
        <button type="button">First</button>
        <button type="button">Last</button>
        {createPortal(
          <div role="dialog">
            <button type="button">Confirm</button>
          </div>,
          document.body
        )}
      </View>
    );
    const confirm = screen.getByRole("button", { name: "Confirm" });
    confirm.focus();

    expect(fireEvent.keyDown(confirm, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(confirm);
  });

  it("wraps Shift+Tab from the view itself to its last control", () => {
    render(
      <View>
        <button type="button">First</button>
        <button type="button">Last</button>
      </View>
    );
    const view = screen.getByTestId("view");
    view.focus();

    expect(fireEvent.keyDown(view, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
  });

  it("skips hidden and disabled controls when finding the edges", () => {
    render(
      <View>
        <button type="button">First</button>
        <button type="button">Last</button>
        <button type="button" disabled>
          Disabled
        </button>
        <div hidden>
          <button type="button">Hidden</button>
        </div>
      </View>
    );
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();

    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("keeps focus on the view when nothing in it takes focus", () => {
    render(
      <View>
        <div data-testid="note" tabIndex={-1} />
      </View>
    );
    const note = screen.getByTestId("note");
    note.focus();

    expect(fireEvent.keyDown(note, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByTestId("view"));
  });

  it("leaves modified Tab alone", () => {
    render(
      <View>
        <button type="button">Only</button>
      </View>
    );
    const only = screen.getByRole("button", { name: "Only" });
    only.focus();

    for (const modifier of ["altKey", "ctrlKey", "metaKey"] as const) {
      expect(fireEvent.keyDown(only, { key: "Tab", [modifier]: true })).toBe(true);
    }
  });

  it("treats a radio group as one stop, landing on its checked option", () => {
    render(
      <View>
        <button type="button">First</button>
        <input type="radio" name="mode" aria-label="Fast" defaultChecked />
        <input type="radio" name="mode" aria-label="Slow" />
      </View>
    );
    const checked = screen.getByRole("radio", { name: "Fast" });
    const first = screen.getByRole("button", { name: "First" });
    checked.focus();

    expect(fireEvent.keyDown(checked, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(first);

    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(checked);
  });

  it("wraps onto a usable option when the checked one is hidden or disabled", () => {
    for (const unusable of [{ hidden: true }, { disabled: true }]) {
      const { unmount } = render(
        <View>
          <button type="button">First</button>
          <input type="radio" name="mode" aria-label="Fast" />
          <span hidden={unusable.hidden}>
            <input
              type="radio"
              name="mode"
              aria-label="Slow"
              defaultChecked
              disabled={unusable.disabled}
            />
          </span>
        </View>
      );
      const first = screen.getByRole("button", { name: "First" });
      first.focus();

      expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Fast" }));
      unmount();
    }
  });

  it("doesn't wrap past a control between two options of one group", () => {
    render(
      <View>
        <button type="button">First</button>
        <input type="radio" name="mode" aria-label="Fast" defaultChecked />
        <button type="button">Middle</button>
        <input type="radio" name="mode" aria-label="Slow" />
      </View>
    );
    const checked = screen.getByRole("radio", { name: "Fast" });
    const middle = screen.getByRole("button", { name: "Middle" });
    checked.focus();

    expect(fireEvent.keyDown(checked, { key: "Tab" })).toBe(true);

    middle.focus();
    expect(fireEvent.keyDown(middle, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("wraps from either option of a group with nothing checked", () => {
    render(
      <View>
        <button type="button">First</button>
        <input type="radio" name="mode" aria-label="Fast" />
        <input type="radio" name="mode" aria-label="Slow" />
      </View>
    );
    const entered = screen.getByRole("radio", { name: "Fast" });
    const first = screen.getByRole("button", { name: "First" });
    entered.focus();

    expect(fireEvent.keyDown(entered, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(first);

    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Slow" }));
  });

  it("counts a details summary as a stop", () => {
    render(
      <View>
        <button type="button">First</button>
        <button type="button">View logs</button>
        <details>
          <summary>Technical details</summary>
          <pre>stack</pre>
        </details>
      </View>
    );
    const logs = screen.getByRole("button", { name: "View logs" });
    logs.focus();

    expect(fireEvent.keyDown(logs, { key: "Tab" })).toBe(true);
  });
});

describe("handFocusBack", () => {
  afterEach(() => {
    document.body.replaceChildren();
    usePanelStore.setState({ focusedId: null });
  });

  function shell(): { root: HTMLElement; control: HTMLButtonElement } {
    const root = document.createElement("div");
    root.id = "root";
    const control = document.createElement("button");
    control.textContent = "Toggle sidebar";
    root.appendChild(control);
    document.body.appendChild(root);
    return { root, control };
  }

  it("keeps the fallback's tooltip from opening on the focus it hands over", () => {
    const { control } = shell();

    handFocusBack(null);

    expect(document.activeElement).toBe(control);
    expect(isTooltipSuppressedForElement(control)).toBe(true);
  });

  it("passes over a focused panel that sits behind an inert overlay", () => {
    const { root, control } = shell();
    const panel = document.createElement("div");
    panel.dataset.panelId = "panel-1";
    panel.dataset.panelLocation = "grid";
    const wrapper = document.createElement("div");
    wrapper.setAttribute("inert", "");
    wrapper.appendChild(panel);
    root.appendChild(wrapper);
    const focusPanel = vi.fn(() => true);
    const unregister = registerPanelFocusHandler("panel-1", focusPanel);
    usePanelStore.setState({ focusedId: "panel-1" });
    try {
      handFocusBack(null);

      expect(focusPanel).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(control);
    } finally {
      unregister();
    }
  });

  it("passes over a focused panel parked offscreen in the dock", () => {
    const { root, control } = shell();
    const parking = document.createElement("div");
    parking.setAttribute("aria-hidden", "true");
    const panel = document.createElement("div");
    panel.dataset.panelId = "panel-1";
    panel.dataset.panelLocation = "dock";
    parking.appendChild(panel);
    root.appendChild(parking);
    const focusPanel = vi.fn(() => true);
    const unregister = registerPanelFocusHandler("panel-1", focusPanel);
    usePanelStore.setState({ focusedId: "panel-1" });
    try {
      handFocusBack(null);

      expect(focusPanel).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(control);
    } finally {
      unregister();
    }
  });

  it("lands in the theme browser, not an earlier toast, while it keeps the shell inert", () => {
    const { root } = shell();
    root.setAttribute("inert", "");
    const toast = document.createElement("div");
    toast.appendChild(document.createElement("button"));
    const sheet = document.createElement("div");
    sheet.setAttribute("aria-modal", "true");
    const sheetSearch = document.createElement("input");
    sheet.appendChild(sheetSearch);
    document.body.append(toast, sheet);

    handFocusBack(null);

    expect(document.activeElement).toBe(sheetSearch);
  });

  it("takes the document's first control when nothing else is left", () => {
    const { root } = shell();
    root.setAttribute("inert", "");
    const loose = document.createElement("button");
    document.body.appendChild(loose);

    handFocusBack(null);

    expect(document.activeElement).toBe(loose);
  });
});

describe("isFocusStranded", () => {
  afterEach(() => document.body.replaceChildren());

  it("counts the body, the closing view and an inert control as stranded, and nothing else", () => {
    const view = document.createElement("div");
    const inside = document.createElement("button");
    view.appendChild(inside);
    const workspace = document.createElement("div");
    const behind = document.createElement("button");
    workspace.appendChild(behind);
    const usable = document.createElement("button");
    document.body.append(view, workspace, usable);

    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    expect(isFocusStranded(view)).toBe(true);
    inside.focus();
    expect(isFocusStranded(view)).toBe(true);
    // Focus left on a control as the workspace around it went inert.
    behind.focus();
    workspace.setAttribute("inert", "");
    expect(document.activeElement).toBe(behind);
    expect(isFocusStranded(view)).toBe(true);
    usable.focus();
    expect(isFocusStranded(view)).toBe(false);
  });
});
