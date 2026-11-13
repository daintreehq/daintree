// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createPortal } from "react-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { containTab, isFocusStranded } from "../pluginManagerFocus";

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
    render(<View />);
    const view = screen.getByTestId("view");
    view.focus();

    expect(fireEvent.keyDown(view, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(view);
  });

  it("leaves modified Tab alone", () => {
    render(
      <View>
        <button type="button">Only</button>
      </View>
    );
    const only = screen.getByRole("button", { name: "Only" });
    only.focus();

    expect(fireEvent.keyDown(only, { key: "Tab", ctrlKey: true })).toBe(true);
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

    (document.activeElement as HTMLElement | null)?.blur();
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
