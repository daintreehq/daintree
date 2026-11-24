// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { APP_PALETTE_SURFACE_ATTR, recordPaletteOpener, resolveFocusOpener } from "../focusOpener";

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

  function palette(open: boolean, opener: HTMLElement | null): HTMLInputElement {
    const surface = document.createElement("div");
    surface.setAttribute("role", "dialog");
    surface.setAttribute(APP_PALETTE_SURFACE_ATTR, "");
    surface.setAttribute("aria-modal", open ? "true" : "false");
    const field = document.createElement("input");
    surface.appendChild(field);
    document.body.appendChild(surface);
    recordPaletteOpener(surface, opener);
    return field;
  }

  it("records a closing palette's field as whatever opened the palette", () => {
    const terminal = document.createElement("textarea");
    document.body.appendChild(terminal);

    expect(resolveFocusOpener(palette(false, terminal))).toBe(terminal);
  });

  it("keeps the field of a palette that stays open", () => {
    const terminal = document.createElement("textarea");
    document.body.appendChild(terminal);
    const field = palette(true, terminal);

    expect(resolveFocusOpener(field)).toBe(field);
  });

  it("keeps the field when the palette recorded no opener", () => {
    const field = palette(false, null);

    expect(resolveFocusOpener(field)).toBe(field);
  });

  it("walks a palette opened from a menu item out to the menu's trigger", () => {
    const trigger = document.createElement("button");
    trigger.id = "trigger";
    document.body.appendChild(trigger);
    const selected = item();
    menu("trigger", selected);

    expect(resolveFocusOpener(palette(false, selected))).toBe(trigger);
  });
});
