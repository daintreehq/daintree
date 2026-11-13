// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { resolveFocusOpener } from "../focusOpener";

function menu(labelledBy: string, ...children: HTMLElement[]): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "menu");
  el.setAttribute("aria-labelledby", labelledBy);
  el.append(...children);
  document.body.appendChild(el);
  return el;
}

function item(id?: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "menuitem");
  if (id) el.id = id;
  return el;
}

describe("resolveFocusOpener", () => {
  afterEach(() => document.body.replaceChildren());

  it("records a menu item as the trigger its menu is labelled by", () => {
    const trigger = document.createElement("button");
    trigger.id = "trigger";
    document.body.appendChild(trigger);
    const selected = item();
    menu("trigger", selected);

    expect(resolveFocusOpener(selected)).toBe(trigger);
  });

  it("walks a submenu out through its sub-trigger to the root trigger", () => {
    const trigger = document.createElement("button");
    trigger.id = "trigger";
    document.body.appendChild(trigger);
    const subTrigger = item("sub-trigger");
    menu("trigger", subTrigger);
    const selected = item();
    menu("sub-trigger", selected);

    expect(resolveFocusOpener(selected)).toBe(trigger);
  });

  it("keeps an element outside any menu, and a menu whose label isn't in the document", () => {
    const panel = document.createElement("textarea");
    document.body.appendChild(panel);
    const orphan = item();
    menu("missing", orphan);

    expect(resolveFocusOpener(panel)).toBe(panel);
    expect(resolveFocusOpener(orphan)).toBe(orphan);
    expect(resolveFocusOpener(null)).toBeNull();
  });
});
