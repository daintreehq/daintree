// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { APP_DIALOG_SURFACE_ATTR } from "../appDialogSurface";
import { ESCAPE_BACKSTOP_DIALOG_ATTR } from "../dialogEscapeBackstop";
import {
  DIALOG_CLOSE_ATTR,
  focusAfterOverlayCloses,
  focusHeldByOtherModal,
  topmostOpenModal,
} from "../openModalFocus";

function layer({
  z,
  appDialog = false,
  open = true,
  label,
}: {
  z?: number;
  appDialog?: boolean;
  open?: boolean;
  label: string;
}): HTMLElement {
  const surface = document.createElement("div");
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-modal", "true");
  surface.setAttribute("aria-label", label);
  if (z !== undefined) surface.style.zIndex = String(z);
  if (appDialog) {
    surface.setAttribute(APP_DIALOG_SURFACE_ATTR, "");
    if (open) surface.setAttribute(ESCAPE_BACKSTOP_DIALOG_ATTR, "");
  }
  document.body.appendChild(surface);
  return surface;
}

function button(parent: HTMLElement, text: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

describe("topmostOpenModal", () => {
  afterEach(() => document.body.replaceChildren());

  it("prefers the higher layer over one opened after it", () => {
    const high = layer({ z: 60, label: "high" });
    layer({ z: 50, label: "low" });

    expect(topmostOpenModal(null)).toBe(high);
  });

  it("takes the last opened among equal layers", () => {
    layer({ label: "first" });
    const second = layer({ label: "second" });

    expect(topmostOpenModal(null)).toBe(second);
  });

  it("passes over the closing surface, an AppDialog on its way out, and a closed Radix layer", () => {
    const parent = layer({ appDialog: true, label: "parent" });
    layer({ appDialog: true, open: false, label: "exiting" });
    layer({ label: "radix" }).setAttribute("data-state", "closed");
    const closing = layer({ appDialog: true, open: false, label: "closing" });
    const panel = document.createElement("div");
    closing.appendChild(panel);

    expect(topmostOpenModal(panel)).toBe(parent);
  });

  it("is null when no other modal is open", () => {
    const closing = layer({ label: "closing" });

    expect(topmostOpenModal(closing)).toBeNull();
  });
});

describe("focusAfterOverlayCloses", () => {
  afterEach(() => document.body.replaceChildren());

  it("lands on the open modal's first control, past its close button", () => {
    const root = document.createElement("div");
    root.id = "root";
    button(root, "Toolbar");
    document.body.appendChild(root);
    const parent = layer({ appDialog: true, label: "parent" });
    button(parent, "Close").setAttribute(DIALOG_CLOSE_ATTR, "");
    const add = button(parent, "Add");

    focusAfterOverlayCloses(null);

    expect(document.activeElement).toBe(add);
  });

  it("leaves focus that is already inside the open modal", () => {
    const parent = layer({ label: "parent" });
    button(parent, "First");
    const second = button(parent, "Second");
    second.focus();

    focusAfterOverlayCloses(null);

    expect(document.activeElement).toBe(second);
  });

  it("falls back to the app shell with no modal open", () => {
    const root = document.createElement("div");
    root.id = "root";
    const toolbar = button(root, "Toolbar");
    document.body.appendChild(root);

    focusAfterOverlayCloses(null);

    expect(document.activeElement).toBe(toolbar);
  });
});

describe("focusHeldByOtherModal", () => {
  afterEach(() => document.body.replaceChildren());

  it("is true only while focus sits in an open modal other than the closing one", () => {
    const closing = layer({ label: "closing" });
    const field = button(closing, "Field");
    const dialog = layer({ appDialog: true, label: "dialog" });
    const save = button(dialog, "Save");

    field.focus();
    expect(focusHeldByOtherModal(closing)).toBe(false);

    save.focus();
    expect(focusHeldByOtherModal(closing)).toBe(true);

    dialog.removeAttribute(ESCAPE_BACKSTOP_DIALOG_ATTR);
    expect(focusHeldByOtherModal(closing)).toBe(false);
  });
});
